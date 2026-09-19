// Executes an authorized pull: SyncNative (SOL path only, permissionless)
// then TransferChecked, signed by the pooled wallet as delegate — never the
// client. No client signature is required or possible here; the client's
// only signature was the earlier Approve.
//
// Crash-safety (fixes a real gap found in code review): the transaction's
// signature is computed LOCALLY, before broadcast, and a PENDING deposits
// row is written under that signature BEFORE the transaction is sent. If
// the process crashes between broadcast and confirmation, the next sweep
// attempt finds that PENDING row first and RECONCILES it against actual
// on-chain state before ever considering a new transfer — it never blindly
// retries, and never leaves an on-chain transfer with no database record.
// This is the same "reconcile first, retry second, never the reverse"
// principle already established for this project's (currently shelved)
// on-chain deposit design.
//
// Concurrency (fixes a real gap found in the follow-up concurrency review):
// two sweep workers/processes racing on the SAME authorization both pass
// the "is anything pending?" check before either has written anything —
// that race is closed not by this application code, but by a DB-level
// constraint (see schema.sql's idx_one_pending_deposit_per_authorization):
// only one worker's INSERT can ever succeed. The loser catches the real
// SQLite constraint violation and backs off cleanly — see
// insertPendingDepositOrDetectRace below. This is also what keeps
// concurrent sweeps from collectively exceeding a per-asset cap: at most
// one sweep can ever be in flight for a given authorization at a time, so
// there is never a moment where two amounts are computed against the same
// stale headroom and both committed.
//
// Restart recovery (also from the concurrency review): a PENDING row can
// be left behind by a crash at any of three points -- (a) reserved but
// never broadcast, (b) broadcast but confirmation never observed, (c)
// confirmed but the cap credit never applied. (b) and (c) are handled by
// reconcilePendingDeposit's live on-chain check. (a) is handled by the
// blockhash-expiry check: a signature that is neither confirmed nor erred,
// AND whose recorded last_valid_block_height has since passed, can now
// PROVABLY never land (Solana transactions become permanently invalid once
// their reference blockhash expires) -- so it is safe to mark it FAILED and
// free the authorization for a fresh attempt. Anything short of that stays
// PENDING rather than being guessed at. (c) is handled by wrapping the
// "mark deposit CONFIRMED" + "credit the authorization" pair in one SQL
// transaction (withTransaction) so a mid-pair crash can never leave one
// applied without the other -- restart finds the deposit still PENDING and
// reconciles both together, exactly once.
//
// The pooled SOL destination is the pooled wallet's OWN wSOL ATA (wSOL in,
// wSOL out) — deliberately not unwrapped to native SOL, to avoid an
// unwrap/close-account step this prototype doesn't need. No swapping, no
// consolidation across mints — each asset's pulled funds land in that
// asset's own pooled destination account.

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAccount, getMint } from "@solana/spl-token";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import type { OraclePrice } from "@platform/accounting";
import { computeSweepAmountNative, computeCreditedUsdMicros, computeAssetHeadroomUsdMicros } from "../cap/capCheck.ts";
import { updateCumulativeCredited, type ClientAssetAuthorizationRow } from "../authorization/authorizationStore.ts";
import { buildSyncNativeIx } from "../authorization/solAuthorization.ts";
import { SOL_ASSET_KEY } from "../allowlist/loadAllowlist.ts";
import { withTransaction, getConfig } from "../db/client.ts";
import type { PooledSigner } from "../solana/pooledSigner.ts";
import { isSweepDelayElapsed } from "./sweepTiming.ts";

export interface SweepResult {
  readonly swept: boolean;
  readonly reason?: string;
  readonly txSignature?: string;
  readonly nativeAmount?: bigint;
  readonly usdValueMicros?: bigint;
}

export interface SweepDeps {
  readonly connection: Connection;
  readonly db: DatabaseSync;
  // The narrow signing interface, not a raw Keypair -- sweep business logic
  // never touches secret-key material directly, only ever asks the signer
  // to produce a signature. See src/solana/pooledSigner.ts.
  readonly pooledWallet: PooledSigner;
  readonly pooledDestinationAccount: PublicKey; // this asset's pooled token account
  readonly programId: PublicKey; // TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
  readonly decimals: number;
  readonly price: OraclePrice;
}

/**
 * Re-derives price freshness from price_cache itself (the single source of
 * truth every price consumer in this codebase is supposed to go through),
 * rather than trusting a timestamp the caller might supply alongside
 * deps.price. A missing row, a non-positive price, or a fetched_at older
 * than oracle_max_staleness_secs are all treated identically: not fresh.
 */
function isPriceFreshForSweep(db: DatabaseSync, assetKey: string, price: OraclePrice): boolean {
  if (price.priceScaled <= 0n) return false;
  const row = db.prepare("SELECT fetched_at FROM price_cache WHERE asset_key = ?").get(assetKey) as { fetched_at: string } | undefined;
  if (!row) return false;
  const maxStalenessSecs = Number(getConfig(db, "oracle_max_staleness_secs"));
  const nowSecs = Math.floor(Date.now() / 1000);
  const fetchedAtUnixSecs = Math.floor(new Date(row.fetched_at + "Z").getTime() / 1000);
  return nowSecs - fetchedAtUnixSecs <= maxStalenessSecs;
}

function isUniqueConstraintViolation(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    e.message.includes("UNIQUE constraint failed")
  );
}

/** Atomically marks a deposit CONFIRMED and credits its authorization together, or neither. */
function markConfirmedAndCredit(
  db: DatabaseSync,
  depositId: string,
  authorizationId: string,
  usdValueMicros: bigint,
): void {
  withTransaction(db, () => {
    db.prepare("UPDATE deposits SET status = 'CONFIRMED', confirmed_at = datetime('now') WHERE id = ?").run(depositId);
    updateCumulativeCredited(db, authorizationId, usdValueMicros);
  });
}

/**
 * Reconciles one PENDING deposit row against real on-chain state. Never
 * guesses: a signature that isn't found and isn't reported as an error, AND
 * whose blockhash has not yet expired, is left PENDING for the next pass
 * (it may still be in flight) rather than being assumed failed. Only once
 * its blockhash has genuinely expired — meaning Solana itself can never
 * include it now — is an unresolved signature treated as failed.
 */
async function reconcilePendingDeposit(
  connection: Connection,
  db: DatabaseSync,
  pending: {
    id: string;
    tx_signature: string;
    client_asset_authorization_id: string;
    usd_value_micros: string;
    last_valid_block_height: number | null;
  },
): Promise<"CONFIRMED" | "FAILED" | "STILL_PENDING"> {
  const status = await connection.getSignatureStatus(pending.tx_signature, { searchTransactionHistory: true });

  if (status.value?.err) {
    db.prepare("UPDATE deposits SET status = 'FAILED' WHERE id = ?").run(pending.id);
    return "FAILED";
  }

  const confirmationStatus = status.value?.confirmationStatus;
  if (confirmationStatus === "confirmed" || confirmationStatus === "finalized") {
    markConfirmedAndCredit(db, pending.id, pending.client_asset_authorization_id, BigInt(pending.usd_value_micros));
    return "CONFIRMED";
  }

  // Not found and not erred: could genuinely still be in flight, OR it may
  // never have actually been broadcast at all (crash between reservation
  // and send). Only conclude the latter once it is provably impossible for
  // this signature to ever land — i.e. its blockhash's validity window has
  // passed — never merely because it hasn't shown up yet.
  if (pending.last_valid_block_height != null) {
    const currentBlockHeight = await connection.getBlockHeight();
    if (currentBlockHeight > pending.last_valid_block_height) {
      db.prepare("UPDATE deposits SET status = 'FAILED' WHERE id = ?").run(pending.id);
      return "FAILED";
    }
  }

  return "STILL_PENDING";
}

/**
 * Reserves the right to attempt a new sweep for this authorization by
 * inserting its PENDING row. Returns false (inserting nothing) if another
 * worker/process has already reserved this authorization — detected via a
 * real UNIQUE constraint violation (idx_one_pending_deposit_per_authorization),
 * not an application-level check, so it holds even across two separate
 * database connections/processes racing on the same authorization.
 */
function insertPendingDepositOrDetectRace(
  db: DatabaseSync,
  fields: {
    id: string;
    clientId: string;
    authorizationId: string;
    assetKey: string;
    txSignature: string;
    sourceAccount: string;
    destinationAccount: string;
    amount: bigint;
    usdValueMicros: bigint;
    priceScaled: bigint;
    priceExponentAbs: number;
    lastValidBlockHeight: number;
  },
): boolean {
  try {
    db.prepare(
      `INSERT INTO deposits
       (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account,
        native_amount, usd_value_micros, price_scaled, price_exponent, last_valid_block_height, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    ).run(
      fields.id,
      fields.clientId,
      fields.authorizationId,
      fields.assetKey,
      fields.txSignature,
      fields.sourceAccount,
      fields.destinationAccount,
      fields.amount.toString(),
      fields.usdValueMicros.toString(),
      fields.priceScaled.toString(),
      fields.priceExponentAbs,
      fields.lastValidBlockHeight,
    );
    return true;
  } catch (e) {
    if (isUniqueConstraintViolation(e)) return false;
    throw e;
  }
}

export async function sweepAsset(authorization: ClientAssetAuthorizationRow, deps: SweepDeps): Promise<SweepResult> {
  if (authorization.status !== "ACTIVE") {
    return { swept: false, reason: "AUTHORIZATION_NOT_ACTIVE" };
  }

  // --- Reconcile any in-flight sweep from a prior (possibly crashed) run
  // before ever considering a new one. This is what makes a restart safe:
  // a stuck PENDING row blocks new sweeps for this asset until resolved,
  // rather than risking a second real transfer stacked on top of an
  // unconfirmed first one. ---
  const existingPending = deps.db
    .prepare(
      "SELECT id, tx_signature, client_asset_authorization_id, usd_value_micros, last_valid_block_height FROM deposits WHERE client_asset_authorization_id = ? AND status = 'PENDING'",
    )
    .get(authorization.id) as
    | { id: string; tx_signature: string; client_asset_authorization_id: string; usd_value_micros: string; last_valid_block_height: number | null }
    | undefined;

  if (existingPending) {
    const outcome = await reconcilePendingDeposit(deps.connection, deps.db, existingPending);
    if (outcome === "STILL_PENDING") {
      return { swept: false, reason: "PRIOR_SWEEP_STILL_PENDING" };
    }
    if (outcome === "CONFIRMED") {
      // Re-read the authorization's now-updated cumulative credited before
      // deciding whether to attempt a further sweep this pass.
      const refreshed = deps.db
        .prepare("SELECT cumulative_credited_usd_micros FROM client_asset_authorizations WHERE id = ?")
        .get(authorization.id) as { cumulative_credited_usd_micros: string };
      authorization = { ...authorization, cumulativeCreditedUsdMicros: BigInt(refreshed.cumulative_credited_usd_micros) };
    }
    // FAILED: fall through and attempt a fresh sweep this pass -- either it
    // genuinely erred on-chain (no effect happened) or it's now provably
    // expired and unbroadcastable, so no on-chain effect can ever appear.
  }

  // Authorization and sweep are two separate events, deliberately. A NEW
  // sweep attempt (as opposed to reconciling one already in flight, handled
  // above) may only begin once sweep_delay_secs has genuinely elapsed since
  // the backend recorded this authorization -- re-verified here
  // independently, not trusted from the caller, the same "never trust the
  // caller already checked it" philosophy as the price-freshness check
  // below. This is a pure function of the persisted authorized_at column
  // and the current time (see sweepTiming.ts) -- restart-safe by
  // construction, since there is no separate timer to lose: a process that
  // dies and restarts mid-window simply recomputes the same comparison
  // against the same persisted timestamp next pass.
  const sweepDelaySecs = Number(getConfig(deps.db, "sweep_delay_secs"));
  if (!isSweepDelayElapsed(authorization.authorizedAt, sweepDelaySecs)) {
    return { swept: false, reason: "SWEEP_DELAY_NOT_ELAPSED" };
  }

  const sourceAccount = new PublicKey(authorization.authorizedTokenAccount);

  // Permissionless refresh for the SOL/wSOL path — no-op cost for SPL
  // tokens, so only issued for the SOL asset key. Always targets the
  // client's OWN authorized wSOL account, never any other address: this is
  // the account named on the authorization row, never derived from or
  // substitutable by a client-supplied value at sweep time.
  if (authorization.assetKey === SOL_ASSET_KEY) {
    const syncTx = new Transaction().add(buildSyncNativeIx(sourceAccount));
    syncTx.feePayer = deps.pooledWallet.publicKey;
    const { blockhash: syncBlockhash, lastValidBlockHeight: syncLastValidBlockHeight } =
      await deps.connection.getLatestBlockhash();
    syncTx.recentBlockhash = syncBlockhash;
    await deps.pooledWallet.signTransaction(syncTx);
    const syncSig = await deps.connection.sendRawTransaction(syncTx.serialize());
    try {
      // Modern blockhash-strategy overload (matches the main transfer's
      // confirmTransaction call below) -- the deprecated single-signature
      // overload this replaced polls confirmation status with its own
      // internal timeout logic that is opaque to the caller, is not
      // reconciled on failure, and was the direct source of real observed
      // "TransactionExpiredTimeoutError: not confirmed in 30.00 seconds"
      // errors against mainnet.
      await deps.connection.confirmTransaction(
        { signature: syncSig, blockhash: syncBlockhash, lastValidBlockHeight: syncLastValidBlockHeight },
        "confirmed",
      );
    } catch {
      // SyncNative is a permissionless, idempotent balance refresh, not a
      // fund movement -- it has no PENDING deposit row and nothing to
      // reconcile through markConfirmedAndCredit. An ambiguous or
      // timed-out confirmation is not fatal to this sweep pass: the
      // getAccount() call immediately below simply reads whatever amount
      // is on-chain right now (synced or not), which can only make this
      // pass sweep the SAME amount or LESS than what's truly available --
      // never more -- and any shortfall self-corrects the next time
      // SyncNative runs on a later indexer pass. A single best-effort
      // status check still guards against silently ignoring a genuine
      // on-chain error (as opposed to a mere confirmation timeout).
      const status = await deps.connection.getSignatureStatus(syncSig, { searchTransactionHistory: true });
      if (status.value?.err) {
        return { swept: false, reason: "SYNC_NATIVE_FAILED" };
      }
    }
  }

  const account = await getAccount(deps.connection, sourceAccount, undefined, deps.programId);
  const delegate = account.delegate?.toBase58();
  if (delegate !== deps.pooledWallet.publicKey.toBase58()) {
    return { swept: false, reason: "NOT_DELEGATED_TO_POOLED_WALLET" };
  }

  const headroom = computeAssetHeadroomUsdMicros({
    cumulativeCreditedUsdMicros: authorization.cumulativeCreditedUsdMicros,
    assetCapUsdMicros: authorization.assetCapUsdMicros,
  });
  if (headroom === 0n) {
    return { swept: false, reason: "CAP_EXHAUSTED" };
  }

  // Independently re-verify price freshness here, rather than trusting that
  // whatever called sweepAsset already checked it (previously only the
  // indexer's own sweepPass did, via isPriceFreshEnough -- a single point of
  // enforcement any other caller could forget). This reads the SAME
  // price_cache row the caller should have sourced deps.price from, so it
  // can't be fooled by a caller passing a stale OraclePrice value alongside
  // a fresh-looking timestamp of its own choosing.
  if (!isPriceFreshForSweep(deps.db, authorization.assetKey, deps.price)) {
    return { swept: false, reason: "STALE_OR_INVALID_PRICE" };
  }

  const amount = computeSweepAmountNative({
    onChainDelegatedRemainingNative: account.delegatedAmount,
    liveAccountBalanceNative: account.amount,
    headroomUsdMicros: headroom,
    price: deps.price,
    decimals: deps.decimals,
  });
  if (amount <= 0n) {
    return { swept: false, reason: "NOTHING_TO_SWEEP" };
  }

  const mint = await getMint(deps.connection, account.mint, undefined, deps.programId);
  const transferIx = createTransferCheckedInstruction(
    sourceAccount,
    mint.address,
    deps.pooledDestinationAccount, // always the caller-provided pooled custody account for this asset -- never derived from client input
    deps.pooledWallet.publicKey,
    amount,
    deps.decimals,
    [],
    deps.programId,
  );
  const tx = new Transaction().add(transferIx);
  tx.feePayer = deps.pooledWallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await deps.connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  // Sign locally first, purely to obtain the deterministic signature — this
  // does NOT broadcast anything yet.
  await deps.pooledWallet.signTransaction(tx);
  const rawSignature = tx.signature;
  if (!rawSignature) throw new Error("sweepAsset: transaction signing did not produce a signature");
  const txSignature = bs58.encode(rawSignature);

  const usdValueMicros = computeCreditedUsdMicros(amount, deps.price, deps.decimals);

  // Reserve BEFORE broadcasting: the on-chain transfer can never happen
  // without a corresponding PENDING row already existing to reconcile
  // against on a crash. This is also the concurrency gate: if another
  // worker already reserved this authorization (a real UNIQUE constraint
  // violation, not an in-app flag), this attempt backs off here, before
  // ever broadcasting anything -- so two workers can never both broadcast
  // a transfer for the same authorization.
  const depositId = randomUUID();
  const reserved = insertPendingDepositOrDetectRace(deps.db, {
    id: depositId,
    clientId: authorization.clientId,
    authorizationId: authorization.id,
    assetKey: authorization.assetKey,
    txSignature,
    sourceAccount: sourceAccount.toBase58(),
    destinationAccount: deps.pooledDestinationAccount.toBase58(),
    amount,
    usdValueMicros,
    priceScaled: deps.price.priceScaled,
    priceExponentAbs: deps.price.priceExponentAbs,
    lastValidBlockHeight,
  });
  if (!reserved) {
    return { swept: false, reason: "SWEEP_ALREADY_IN_PROGRESS" };
  }

  try {
    await deps.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await deps.connection.confirmTransaction({ signature: txSignature, blockhash, lastValidBlockHeight }, "confirmed");
  } catch (err) {
    // Ambiguous outcome (timeout, RPC error) — reconcile against real
    // on-chain state rather than assuming failure; the row stays PENDING
    // and the next pass (or this same call's caller, for the E2E harness)
    // resolves it via reconcilePendingDeposit's logic.
    const status = await deps.connection.getSignatureStatus(txSignature, { searchTransactionHistory: true });
    if (status.value?.confirmationStatus === "confirmed" || status.value?.confirmationStatus === "finalized") {
      markConfirmedAndCredit(deps.db, depositId, authorization.id, usdValueMicros);
      return { swept: true, txSignature, nativeAmount: amount, usdValueMicros };
    }
    if (status.value?.err) {
      deps.db.prepare("UPDATE deposits SET status = 'FAILED' WHERE id = ?").run(depositId);
    }
    return { swept: false, reason: "SEND_OR_CONFIRM_FAILED", txSignature };
  }

  markConfirmedAndCredit(deps.db, depositId, authorization.id, usdValueMicros);

  return { swept: true, txSignature, nativeAmount: amount, usdValueMicros };
}
