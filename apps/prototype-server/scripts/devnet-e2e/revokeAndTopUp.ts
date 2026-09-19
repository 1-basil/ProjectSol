// Controlled real-devnet test for two specific behaviors requested by the
// follow-up security audit, using the SAME disposable devnet keypairs and
// the SAME already-ACTIVE SOL/wSOL authorization created by run.ts's
// earlier successful devnet run (see scripts/devnet-e2e/keys/ and
// devnet-e2e.db). No new authorization is signed here for the top-up step
// -- that IS the point being proven.
//
// 1) SOL top-up: send additional real devnet SOL into the client's
//    ALREADY-AUTHORIZED wSOL account, without signing a new Approve, and
//    show the existing authorization's standing delegation sweeps it.
// 2) SOL revoke: buildSolRevokeTx + processRevocationSubmission, verified
//    independently on-chain, then prove a sweep attempt afterward moves
//    nothing even though new funds are sitting in the (now-revoked)
//    account.
//
// Run with: node scripts/devnet-e2e/revokeAndTopUp.ts
// Requires scripts/devnet-e2e/keys/{client,pooled}.json and
// scripts/devnet-e2e/devnet-e2e.db to already exist from a prior run.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAccount, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";

import { getConnection, DEVNET_RPC_URL, NATIVE_MINT } from "../../src/solana/connection.ts";
import { loadPooledWallet, assertDistinctFromPooledWallet } from "../../src/solana/pooledWallet.ts";
import { verifyNetworkIdentity } from "../../src/solana/networkIdentity.ts";
import { loadAllowlist, SOL_ASSET_KEY, NATIVE_SOL_DECIMALS } from "../../src/allowlist/loadAllowlist.ts";
import { openDatabase, getConfig } from "../../src/db/client.ts";
import { buildSolRevokeTx } from "../../src/authorization/solAuthorization.ts";
import { processRevocationSubmission } from "../../src/authorization/processAuthorization.ts";
import { getAuthorization } from "../../src/authorization/authorizationStore.ts";
import { sweepAsset } from "../../src/sweep/sweepAsset.ts";
import { toPooledSigner } from "../../src/solana/pooledSigner.ts";
import { getDashboardView } from "../../src/dashboard/dashboardData.ts";
import { COMPANY_RECEIVING_WALLET } from "../../src/solana/companyReceivingWallet.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(__dirname, "keys");
const DB_PATH = join(__dirname, "devnet-e2e.db");
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const log: Record<string, unknown>[] = [];
function record(section: string, data: unknown): void {
  log.push({ section, at: new Date().toISOString(), data });
  console.log(`\n=== ${section} ===`);
  console.log(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function loadKeypair(name: string): Keypair {
  const path = join(KEYS_DIR, `${name}.json`);
  if (!existsSync(path)) throw new Error(`FATAL: expected an existing keypair at ${path} from a prior run -- none found.`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Opens the existing devnet-e2e.db WITHOUT re-running schema.sql (openDatabase() is not safe to call twice against an already-initialized file -- a real gap this harness works around locally rather than papering over; see the audit report). */
function openExistingDb(path: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`FATAL: expected an existing database at ${path} from a prior run -- none found.`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

async function signAndSend(connection: ReturnType<typeof getConnection>, tx: Transaction, signer: Keypair): Promise<{ signature: string; blockhash: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(signer);
  const signature = bs58.encode(tx.signature!);
  await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return { signature, blockhash, lastValidBlockHeight };
}

async function main() {
  console.log("Controlled real-devnet test: SOL top-up (no new signature) + SOL revoke. Disposable keypairs only.");

  const client = loadKeypair("client");
  const pooled = loadKeypair("pooled");
  record("Setup: reusing existing disposable keypairs", {
    clientPublicKey: client.publicKey.toBase58(),
    pooledPublicKey: pooled.publicKey.toBase58(),
  });

  assertDistinctFromPooledWallet(pooled.publicKey, client.publicKey, "client");
  process.env.POOLED_WALLET_KEYPAIR_PATH = join(KEYS_DIR, "pooled.json");
  const serverLoadedPooledWallet = loadPooledWallet();
  if (!serverLoadedPooledWallet.publicKey.equals(pooled.publicKey)) {
    throw new Error("FATAL: server-loaded pooled wallet does not match the intended test pooled wallet");
  }
  record("Preflight: distinctness + pooled wallet identity", { distinct: true, pooledWalletMatches: true });

  const connection = getConnection();
  const networkIdentity = await verifyNetworkIdentity(connection, "devnet");
  record("Preflight: RPC network identity", { configuredRpcUrl: DEVNET_RPC_URL, ...networkIdentity });

  const allowlist = loadAllowlist();
  record("Preflight: allowlist structural check", { entryCount: allowlist.length, allValidatedNativeVerified: allowlist.every((e) => e.verification_status === "VERIFIED_NATIVE") });

  const db = openExistingDb(DB_PATH);
  record("Preflight: platform_config in effect", {
    dust_threshold_usd_micros: getConfig(db, "dust_threshold_usd_micros"),
    asset_cap_usd_micros: getConfig(db, "asset_cap_usd_micros"),
    oracle_max_staleness_secs: getConfig(db, "oracle_max_staleness_secs"),
  });

  const clientRow = db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string } | undefined;
  if (!clientRow) throw new Error("FATAL: no client row found -- expected the prior SOL authorization run to have created one.");
  const clientId = clientRow.id;
  const originalAuthRow = getAuthorization(db, clientId, SOL_ASSET_KEY);
  if (!originalAuthRow || originalAuthRow.status !== "ACTIVE") {
    throw new Error(`FATAL: expected an existing ACTIVE SOL authorization from the prior run, found: ${JSON.stringify(originalAuthRow)}`);
  }
  const wsolAccount = new PublicKey(originalAuthRow.authorizedTokenAccount);
  const originalAuthorizationId = originalAuthRow.id;
  const originalAuthTxSignature = originalAuthRow.authorizationTxSignature;
  record("Loaded existing ACTIVE SOL authorization from the prior devnet run", {
    authorizationId: originalAuthorizationId,
    wsolAccount: wsolAccount.toBase58(),
    originalAuthorizationTxSignature: originalAuthTxSignature,
    cumulativeCreditedUsdMicrosSoFar: originalAuthRow.cumulativeCreditedUsdMicros.toString(),
  });

  // Refresh the price with a fresh timestamp -- sweepAsset now independently
  // enforces staleness (this session's fix), and the prior run's price_cache
  // row is long stale by now.
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '150000000', 6, '0', datetime('now')) " +
      "ON CONFLICT(asset_key) DO UPDATE SET price_scaled = excluded.price_scaled, fetched_at = excluded.fetched_at",
  ).run(SOL_ASSET_KEY);

  // --- Independent on-chain check: does the wSOL account currently have the pooled wallet as delegate? ---
  const wsolBefore = await getAccount(connection, wsolAccount, "confirmed", TOKEN_PROGRAM_ID);
  record("Independent check: wSOL account's CURRENT on-chain state (before top-up)", {
    mint: wsolBefore.mint.toBase58(),
    isNativeMint: wsolBefore.mint.equals(NATIVE_MINT),
    owner: wsolBefore.owner.toBase58(),
    amount: wsolBefore.amount.toString(),
    delegate: wsolBefore.delegate?.toBase58() ?? null,
    delegatedAmount: wsolBefore.delegatedAmount.toString(),
    delegateIsPooledWallet: wsolBefore.delegate?.equals(pooled.publicKey) ?? false,
  });
  if (!wsolBefore.delegate?.equals(pooled.publicKey)) {
    throw new Error("FATAL: wSOL account's current on-chain delegate is not the pooled wallet -- cannot proceed with the top-up test");
  }

  const pooledWsolDest = await getOrCreateAssociatedTokenAccount(connection, pooled, NATIVE_MINT, COMPANY_RECEIVING_WALLET, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
  const pooledDestBefore = await getAccount(connection, pooledWsolDest.address, "confirmed", TOKEN_PROGRAM_ID);

  // ==========================================================================
  // Item 7: SOL top-up -- additional SOL into the ALREADY-AUTHORIZED wSOL
  // account, with NO new signature, swept under the standing authorization.
  // ==========================================================================
  const topUpLamports = 5_000_000n; // 0.005 SOL
  const topUpTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: client.publicKey, toPubkey: wsolAccount, lamports: Number(topUpLamports) }));
  topUpTx.feePayer = client.publicKey;
  const topUp = await signAndSend(connection, topUpTx, client);
  record("Item 7: additional devnet SOL sent to the EXISTING wSOL account (client-signed System transfer only -- NOT an authorization/Approve)", {
    signature: topUp.signature,
    lamportsSent: topUpLamports.toString(),
    destination: wsolAccount.toBase58(),
    explorerUrl: `https://explorer.solana.com/tx/${topUp.signature}?cluster=devnet`,
    disclosure: "This transaction contains no Approve instruction and is not signed as, or processed as, a new authorization submission.",
  });

  const rowBeforeSweep = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  const priceRow = db.prepare("SELECT price_scaled, price_exponent FROM price_cache WHERE asset_key = ?").get(SOL_ASSET_KEY) as { price_scaled: string; price_exponent: number };
  const topUpSweep = await sweepAsset(rowBeforeSweep, {
    connection,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: pooledWsolDest.address,
    programId: TOKEN_PROGRAM_ID,
    decimals: NATIVE_SOL_DECIMALS,
    price: { priceScaled: BigInt(priceRow.price_scaled), priceExponentAbs: priceRow.price_exponent },
  });
  const topUpSweepTxInfo = topUpSweep.txSignature ? await connection.getTransaction(topUpSweep.txSignature, { maxSupportedTransactionVersion: 0 }) : null;
  record("Item 7: sweep of the top-up, run through the normal sweep path (no new client signature involved)", {
    swept: topUpSweep.swept,
    reason: topUpSweep.reason ?? null,
    signature: topUpSweep.txSignature ?? null,
    slot: topUpSweepTxInfo?.slot ?? null,
    nativeAmountLamports: topUpSweep.nativeAmount?.toString() ?? null,
    usdValueMicros: topUpSweep.usdValueMicros?.toString() ?? null,
    explorerUrl: topUpSweep.txSignature ? `https://explorer.solana.com/tx/${topUpSweep.txSignature}?cluster=devnet` : null,
  });
  if (!topUpSweep.swept || topUpSweep.nativeAmount !== topUpLamports) {
    throw new Error(`FATAL: top-up sweep did not behave as expected: ${JSON.stringify(topUpSweep)}`);
  }

  // --- Independent verification: destination increased by exactly the top-up amount; governing authorization row is unchanged. ---
  const pooledDestAfter = await getAccount(connection, pooledWsolDest.address, "confirmed", TOKEN_PROGRAM_ID);
  const wsolAfterTopUp = await getAccount(connection, wsolAccount, "confirmed", TOKEN_PROGRAM_ID);
  const rowAfterTopUp = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  const dashboardAfterTopUp = getDashboardView(db, client.publicKey.toBase58());
  const solDepositsAfterTopUp = db.prepare("SELECT tx_signature, status, native_amount FROM deposits WHERE client_asset_authorization_id = ? ORDER BY created_at ASC").all(originalAuthorizationId);
  record("Item 7: independent on-chain + DB + dashboard verification", {
    pooledWsolDestinationDelta: (pooledDestAfter.amount - pooledDestBefore.amount).toString(),
    matchesTopUpAmountExactly: pooledDestAfter.amount - pooledDestBefore.amount === topUpLamports,
    wsolAccountAfterTopUp: { amount: wsolAfterTopUp.amount.toString(), delegatedAmount: wsolAfterTopUp.delegatedAmount.toString() },
    governingAuthorizationIdUnchanged: rowAfterTopUp.id === originalAuthorizationId,
    governingAuthorizationTxSignatureUnchanged: rowAfterTopUp.authorizationTxSignature === originalAuthTxSignature,
    allDepositsForThisAuthorization: solDepositsAfterTopUp,
    dashboardSolAsset: dashboardAfterTopUp?.assets.find((a) => a.assetKey === SOL_ASSET_KEY),
  });

  // ==========================================================================
  // Item 2: SOL revoke
  // ==========================================================================
  const revokeTx = buildSolRevokeTx(client.publicKey, wsolAccount);
  const revoke = await signAndSend(connection, revokeTx, client);
  const revokeTxInfo = await connection.getTransaction(revoke.signature, { maxSupportedTransactionVersion: 0 });
  record("Item 2: revoke transaction (client-signed, real devnet)", {
    signature: revoke.signature,
    slot: revokeTxInfo?.slot ?? null,
    explorerUrl: `https://explorer.solana.com/tx/${revoke.signature}?cluster=devnet`,
  });

  const wsolAfterRevokeOnChain = await getAccount(connection, wsolAccount, "confirmed", TOKEN_PROGRAM_ID);
  record("Item 2: independent on-chain verification -- delegate must now be absent", {
    delegate: wsolAfterRevokeOnChain.delegate?.toBase58() ?? null,
    delegatedAmount: wsolAfterRevokeOnChain.delegatedAmount.toString(),
    delegateRemoved: wsolAfterRevokeOnChain.delegate === null,
  });
  if (wsolAfterRevokeOnChain.delegate !== null) {
    throw new Error("FATAL: on-chain delegate was not actually removed by the revoke transaction");
  }

  const revokeResult = await processRevocationSubmission({
    connection,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    authorizedTokenAccount: wsolAccount.toBase58(),
    txSignature: revoke.signature,
    programId: TOKEN_PROGRAM_ID,
  });
  record("Item 2: backend revocation processing", revokeResult);
  if (revokeResult.outcome !== "RECORDED") throw new Error(`FATAL: revocation was not recorded: ${JSON.stringify(revokeResult)}`);

  const revokedRow = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  const dashboardAfterRevoke = getDashboardView(db, client.publicKey.toBase58());
  record("Item 2: DB + dashboard state after revocation", {
    dbStatus: revokedRow.status,
    dbRevokedAt: (db.prepare("SELECT revoked_at FROM client_asset_authorizations WHERE id = ?").get(revokedRow.id) as any).revoked_at,
    dashboardSolAsset: dashboardAfterRevoke?.assets.find((a) => a.assetKey === SOL_ASSET_KEY),
  });

  // --- Prove a sweep attempt afterward moves nothing, even with fresh funds sitting there. ---
  const postRevokeFunds = 3_000_000n; // 0.003 SOL, sent to the now-revoked account
  const postRevokeTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: client.publicKey, toPubkey: wsolAccount, lamports: Number(postRevokeFunds) }));
  postRevokeTx.feePayer = client.publicKey;
  const postRevokeSend = await signAndSend(connection, postRevokeTx, client);
  record("Item 2: additional SOL sent to the now-revoked wSOL account, to prove it is still not swept", {
    signature: postRevokeSend.signature,
    lamportsSent: postRevokeFunds.toString(),
  });

  const pooledDestBeforeFinalAttempt = await getAccount(connection, pooledWsolDest.address, "confirmed", TOKEN_PROGRAM_ID);
  const revokedRowFresh = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  const finalSweepAttempt = await sweepAsset(revokedRowFresh, {
    connection,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: pooledWsolDest.address,
    programId: TOKEN_PROGRAM_ID,
    decimals: NATIVE_SOL_DECIMALS,
    price: { priceScaled: 150_000_000n, priceExponentAbs: 6 },
  });
  const pooledDestAfterFinalAttempt = await getAccount(connection, pooledWsolDest.address, "confirmed", TOKEN_PROGRAM_ID);
  const finalDeposits = db.prepare("SELECT COUNT(*) as n FROM deposits WHERE client_asset_authorization_id = ?").get(originalAuthorizationId) as { n: number };
  record("Item 2: final sweep attempt against the revoked authorization -- must move nothing", {
    swept: finalSweepAttempt.swept,
    reason: finalSweepAttempt.reason ?? null,
    pooledWsolDestinationDelta: (pooledDestAfterFinalAttempt.amount - pooledDestBeforeFinalAttempt.amount).toString(),
    totalDepositRowsForThisAuthorization: finalDeposits.n,
  });
  if (finalSweepAttempt.swept) {
    throw new Error("FATAL SAFETY VIOLATION: a sweep succeeded against a revoked authorization");
  }

  record("DONE", { message: "SOL top-up-without-resigning and SOL revoke tests both completed." });
  writeLog();
}

function writeLog(): void {
  const path = join(__dirname, `log-revokeAndTopUp-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(log, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nFull log written to ${path}`);
}

main().catch((e) => {
  record("FATAL ERROR", { message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  writeLog();
  process.exitCode = 1;
});
