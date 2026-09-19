// SIMULATED end-to-end test of the complete authorization -> confirmation ->
// sweep -> accounting -> dashboard flow, requested to demonstrate items A-O
// plus the listed failure cases.
//
// IMPORTANT — this is NOT a real on-chain test. Real devnet execution is
// currently blocked: the devnet airdrop faucet rejected 4 real attempts from
// this environment across two separate tools (2x @solana/web3.js
// requestAirdrop -> "Internal error"; 2x `solana airdrop` CLI, 8s backoff ->
// "airdrop request failed... rate limit is reached"), so no funded test
// keypair could be obtained here. See ../testSupport/fakeConnection.ts and
// the final report for the exact commands to run this suite for real on
// devnet once a funded keypair is available.
//
// What IS real here: every function under test (buildSolAuthorizationTx,
// buildSplAuthorizationTx, processAuthorizationSubmission,
// processRevocationSubmission, sweepAsset, scanWallet, selectSplAssets,
// getDashboardView) runs completely unmodified, against a FakeConnection
// that genuinely decodes and applies the real signed transactions the code
// builds (see fakeConnection.ts's header). Only the RPC transport boundary
// is simulated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import type { DatabaseSync } from "node:sqlite";

import { freshTestDb as freshDb, backdateAuthorization } from "../testSupport/testDb.ts";
import { FakeConnection } from "../testSupport/fakeConnection.ts";
import { NATIVE_MINT } from "../src/solana/connection.ts";
import { SOL_ASSET_KEY, NATIVE_SOL_DECIMALS, loadAllowlist, type AllowlistEntry } from "../src/allowlist/loadAllowlist.ts";
import { scanWallet } from "../src/scan/scanWallet.ts";
import { buildSolAuthorizationTx, buildSolRevokeTx } from "../src/authorization/solAuthorization.ts";
import { buildSplAuthorizationTx, buildSplRevokeTx, tokenProgramIdFor } from "../src/authorization/splAuthorization.ts";
import { processAuthorizationSubmission, processRevocationSubmission } from "../src/authorization/processAuthorization.ts";
import { getAuthorization, listActiveAuthorizations } from "../src/authorization/authorizationStore.ts";
import { sweepAsset } from "../src/sweep/sweepAsset.ts";
import { toPooledSigner } from "../src/solana/pooledSigner.ts";
import { getDashboardView } from "../src/dashboard/dashboardData.ts";

const USDC_MICROS = 1_000_000n; // OraclePrice / UsdMicros scale used throughout

/** Seeds a deterministic, non-stale price so no test depends on network access or timing. */
function seedPrice(db: DatabaseSync, assetKey: string, priceUsd: number): void {
  const priceScaled = BigInt(Math.round(priceUsd * 1_000_000));
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, ?, 6, '0', datetime('now'))",
  ).run(assetKey, priceScaled.toString());
}

function priceOf(db: DatabaseSync, assetKey: string): { priceScaled: bigint; priceExponentAbs: number } {
  const row = db.prepare("SELECT price_scaled, price_exponent FROM price_cache WHERE asset_key = ?").get(assetKey) as {
    price_scaled: string;
    price_exponent: number;
  };
  return { priceScaled: BigInt(row.price_scaled), priceExponentAbs: row.price_exponent };
}

function findEntry(symbol: string): AllowlistEntry {
  const e = loadAllowlist().find((x) => x.symbol === symbol);
  if (!e) throw new Error(`fixture setup: allowlist entry ${symbol} not found`);
  return e;
}

interface Ctx {
  db: DatabaseSync;
  conn: FakeConnection;
  client: Keypair;
  pooled: Keypair;
}

function setup(): Ctx {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  return { db, conn, client, pooled };
}

/** Client signs and broadcasts an unsigned Transaction exactly as a real wallet adapter would. */
async function signAndSend(conn: FakeConnection, tx: import("@solana/web3.js").Transaction, signer: Keypair): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(signer);
  return conn.sendRawTransaction(tx.serialize());
}

test("SIMULATED E2E: full authorize -> confirm -> sweep -> credit -> dashboard -> revoke flow (steps A-N)", async () => {
  const { db, conn, client, pooled } = setup();

  // Fixture: 9 held SPL assets (5 legacy SPL_TOKEN, 4 Token-2022) at
  // descending USD value, plus SOL. Top 7 by USD value must be selected
  // regardless of token program or allowlist rank order.
  const heldEntries = [
    { symbol: "USDT", amountTokens: 100 }, // SPL_TOKEN
    { symbol: "USDC", amountTokens: 90 }, // SPL_TOKEN
    { symbol: "USDS", amountTokens: 80 }, // SPL_TOKEN
    { symbol: "USDE", amountTokens: 70 }, // SPL_TOKEN
    { symbol: "USD1", amountTokens: 60 }, // SPL_TOKEN
    { symbol: "USDG", amountTokens: 50 }, // TOKEN_2022
    { symbol: "PYUSD", amountTokens: 40 }, // TOKEN_2022
    { symbol: "BUIDL", amountTokens: 30 }, // TOKEN_2022 -- must be EXCLUDED (8th by value)
    { symbol: "USYC", amountTokens: 20 }, // TOKEN_2022 -- must be EXCLUDED (9th by value)
  ] as const;

  // --- A: client wallet exists (just a Keypair here; "connect" = the
  // backend learning its pubkey, which scanWallet takes as input). ---
  conn.setSolBalance(client.publicKey, 5_000_000_000n); // 5 SOL
  conn.setMint(NATIVE_MINT, NATIVE_SOL_DECIMALS, TOKEN_PROGRAM_ID);
  seedPrice(db, SOL_ASSET_KEY, 150); // $150/SOL -> $750 held, comfortably above the $1 dust floor

  for (const h of heldEntries) {
    const entry = findEntry(h.symbol);
    const programId = tokenProgramIdFor(entry);
    const mint = new PublicKey(entry.mint);
    conn.setMint(mint, entry.decimals, programId);
    const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
    const nativeAmount = BigInt(h.amountTokens) * 10n ** BigInt(entry.decimals);
    conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: nativeAmount, delegate: null, delegatedAmount: 0n, programId });
    seedPrice(db, entry.mint, 1.0); // all are $1 stablecoins in this fixture -- ranking is purely by held amount
  }

  // --- B & C: scan holdings; SOL kept fully separate from the SPL ranking; top 7 SPL by USD value selected. ---
  const scan = await scanWallet(conn as any, db, client.publicKey, new Set());
  assert.equal(scan.solEligible, true);
  assert.equal(scan.solHeldLamports, 5_000_000_000n);
  assert.equal(scan.selectedSplAssets.length, 7, "max first movement is SOL + up to 7 SPL, never 7 total including SOL");
  const selectedSymbols = scan.selectedSplAssets.map((a) => a.entry.symbol);
  assert.deepEqual(selectedSymbols, ["USDT", "USDC", "USDS", "USDE", "USD1", "USDG", "PYUSD"], "selection must be strictly by USD value held, descending");
  assert.ok(!selectedSymbols.includes("BUIDL") && !selectedSymbols.includes("USYC"), "assets below the top-7 USD value cutoff must not be selected");

  // --- D: the exact proposed authorization set is exactly what a real UI would render. ---
  const proposedSet = { sol: scan.solEligible, splAssetKeys: scan.selectedSplAssets.map((a) => a.assetKey) };
  assert.equal(proposedSet.splAssetKeys.length, 7);

  // --- E, F, G: client signs each authorization transaction; backend
  // validates and records ONLY after on-chain confirmation; before that, no
  // client_asset_authorizations row and no deposit exists for the asset. ---
  assert.equal(listActiveAuthorizations(db, (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as any)?.id ?? "nonexistent").length, 0);

  // SOL authorization: wrap 2 of the 5 SOL now, approve a large standing ceiling.
  const solAuth = await buildSolAuthorizationTx(conn as any, client.publicKey, pooled.publicKey, 2_000_000_000n, 1_000_000_000_000n);
  const solAuthSig = await signAndSend(conn, solAuth.transaction, client);
  const solResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: solAuth.wsolAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: solAuthSig,
    programId: TOKEN_PROGRAM_ID, // wSOL is itself a legacy-Token-Program mint
  });
  assert.equal(solResult.outcome, "RECORDED");

  const splResults: Record<string, { authorizationId: string; entry: AllowlistEntry; tokenAccount: PublicKey }> = {};
  for (const assetKey of proposedSet.splAssetKeys) {
    const entry = loadAllowlist().find((e) => e.mint === assetKey)!;
    const programId = tokenProgramIdFor(entry);
    // Standing approval ceiling = full $1,000,000 headroom in native units at $1.00 -> 1,000,000 * 10^decimals.
    const delegatedAmountNative = 1_000_000n * 10n ** BigInt(entry.decimals);
    const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, delegatedAmountNative);
    const sig = await signAndSend(conn, built.transaction, client);
    const result = await processAuthorizationSubmission({
      connection: conn as any,
      db,
      walletPubkey: client.publicKey.toBase58(),
      assetKey,
      tokenProgram: entry.token_program,
      authorizedTokenAccount: built.tokenAccount.toBase58(),
      expectedDelegate: pooled.publicKey.toBase58(),
      txSignature: sig,
      programId,
    });
    assert.equal(result.outcome, "RECORDED", `authorization for ${entry.symbol} must be recorded once confirmed`);
    splResults[assetKey] = { authorizationId: result.outcome === "RECORDED" ? result.authorizationId : "", entry, tokenAccount: built.tokenAccount };
  }

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const activeAfterAuth = listActiveAuthorizations(db, clientId);
  assert.equal(activeAfterAuth.length, 8, "SOL + 7 SPL = 8 independent authorizations");
  const depositsBeforeSweep = db.prepare("SELECT COUNT(*) as n FROM deposits").get() as { n: number };
  assert.equal(depositsBeforeSweep.n, 0, "no transfer occurs merely because authorizations were confirmed -- a sweep must still happen");

  // Backend rejects a claimed-but-unconfirmed authorization outright (item G, negative direction).
  const bogusSig = "5".repeat(88);
  const rejected = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: solAuth.wsolAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: bogusSig,
    programId: TOKEN_PROGRAM_ID,
  });
  assert.equal(rejected.outcome, "REJECTED");
  assert.equal(rejected.reason, "TRANSACTION_NOT_CONFIRMED");

  // This test is about the authorize -> confirm -> sweep -> credit ->
  // dashboard -> revoke flow's OWN steps, not the sweep-delay gate (see
  // sweepDelay.test.ts for that) -- backdated so sweepAsset() is willing to
  // attempt a sweep immediately, for every authorization confirmed above.
  for (const auth of activeAfterAuth) backdateAuthorization(db, auth.id);

  // --- H, I, J, K: sweep only the explicitly authorized asset/account,
  // confirm on-chain, record exactly once, update credited/headroom. ---
  async function pooledDestFor(entry: AllowlistEntry | null): Promise<PublicKey> {
    const mint = entry ? new PublicKey(entry.mint) : NATIVE_MINT;
    const programId = entry ? tokenProgramIdFor(entry) : TOKEN_PROGRAM_ID;
    const dest = await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId);
    return dest.address;
  }

  const solPooledDest = await pooledDestFor(null);
  const solAuthRow = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  const solSweep = await sweepAsset(solAuthRow, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: solPooledDest,
    programId: TOKEN_PROGRAM_ID,
    decimals: NATIVE_SOL_DECIMALS,
    price: priceOf(db, SOL_ASSET_KEY),
  });
  assert.equal(solSweep.swept, true);
  assert.equal(solSweep.nativeAmount, 2_000_000_000n, "sweeps exactly the wrapped+synced wSOL balance, nothing more");

  for (const assetKey of proposedSet.splAssetKeys) {
    const { entry } = splResults[assetKey];
    const dest = await pooledDestFor(entry);
    const row = getAuthorization(db, clientId, assetKey)!;
    const result = await sweepAsset(row, {
      connection: conn as any,
      db,
      pooledWallet: toPooledSigner(pooled),
      pooledDestinationAccount: dest,
      programId: tokenProgramIdFor(entry),
      decimals: entry.decimals,
      price: priceOf(db, assetKey),
    });
    assert.equal(result.swept, true, `sweep of ${entry.symbol} must succeed`);
  }

  // Exactly one deposit per authorization -- never double-recorded.
  const depositCount = db.prepare("SELECT COUNT(*) as n FROM deposits").get() as { n: number };
  assert.equal(depositCount.n, 8);
  const distinctAuths = db.prepare("SELECT COUNT(DISTINCT client_asset_authorization_id) as n FROM deposits").get() as { n: number };
  assert.equal(distinctAuths.n, 8);

  const usdcAuthAfterSweep = getAuthorization(db, clientId, findEntry("USDC").mint)!;
  assert.equal(usdcAuthAfterSweep.cumulativeCreditedUsdMicros, 90n * USDC_MICROS, "USDC's own credited amount reflects only USDC's transfer");
  assert.equal(usdcAuthAfterSweep.assetCapUsdMicros - usdcAuthAfterSweep.cumulativeCreditedUsdMicros, (1_000_000n - 90n) * USDC_MICROS, "USDC's remaining headroom is untouched by any other asset");

  const usdtAuthAfterSweep = getAuthorization(db, clientId, findEntry("USDT").mint)!;
  assert.equal(usdtAuthAfterSweep.cumulativeCreditedUsdMicros, 100n * USDC_MICROS, "crediting USDC did not consume USDT's cap (item 11)");

  // --- L: dashboard/API reflects the completed transfers. ---
  const view = getDashboardView(db, client.publicKey.toBase58())!;
  assert.equal(view.assets.length, 8);
  const usdcView = view.assets.find((a) => a.assetKey === findEntry("USDC").mint)!;
  assert.equal(usdcView.cumulativeCreditedUsdMicros, (90n * USDC_MICROS).toString());
  assert.equal(usdcView.transfers.length, 1);
  assert.equal(usdcView.transfers[0].status, "CONFIRMED");
  const solView = view.assets.find((a) => a.assetKey === SOL_ASSET_KEY)!;
  assert.equal(solView.status, "ACTIVE");

  // --- M, N: revoke ONE asset (USDC); it can no longer be swept, while
  // another authorized asset (USDT) remains fully functional. ---
  const usdcEntry = findEntry("USDC");
  const revokeTx = buildSplRevokeTx(client.publicKey, splResults[usdcEntry.mint].tokenAccount, usdcEntry);
  const revokeSig = await signAndSend(conn, revokeTx, client);
  const revokeResult = await processRevocationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: usdcEntry.mint,
    authorizedTokenAccount: splResults[usdcEntry.mint].tokenAccount.toBase58(),
    txSignature: revokeSig,
    programId: tokenProgramIdFor(usdcEntry),
  });
  assert.equal(revokeResult.outcome, "RECORDED");

  // Simulate a top-up arriving after revocation -- must NOT be swept.
  const usdcAcct = conn.getTokenAccountState(splResults[usdcEntry.mint].tokenAccount)!;
  conn.setTokenAccount(splResults[usdcEntry.mint].tokenAccount, { ...usdcAcct, amount: usdcAcct.amount + 500_000n });
  const revokedRow = getAuthorization(db, clientId, usdcEntry.mint)!;
  assert.equal(revokedRow.status, "REVOKED");
  const revokedSweep = await sweepAsset(revokedRow, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: await pooledDestFor(usdcEntry),
    programId: tokenProgramIdFor(usdcEntry),
    decimals: usdcEntry.decimals,
    price: priceOf(db, usdcEntry.mint),
  });
  assert.equal(revokedSweep.swept, false);
  assert.equal(revokedSweep.reason, "AUTHORIZATION_NOT_ACTIVE");
  const depositsForUsdc = db.prepare("SELECT COUNT(*) as n FROM deposits WHERE asset_key = ?").get(usdcEntry.mint) as { n: number };
  assert.equal(depositsForUsdc.n, 1, "still exactly the one pre-revocation transfer -- the post-revocation top-up was never swept");

  // USDT, never revoked, is still fully functional -- revocation is asset-isolated.
  const usdtEntry = findEntry("USDT");
  const usdtAcct = conn.getTokenAccountState(splResults[usdtEntry.mint].tokenAccount)!;
  conn.setTokenAccount(splResults[usdtEntry.mint].tokenAccount, { ...usdtAcct, amount: usdtAcct.amount + 5_000_000n }); // +$5 top-up
  const usdtRow = getAuthorization(db, clientId, usdtEntry.mint)!;
  const usdtSweep2 = await sweepAsset(usdtRow, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: await pooledDestFor(usdtEntry),
    programId: tokenProgramIdFor(usdtEntry),
    decimals: usdtEntry.decimals,
    price: priceOf(db, usdtEntry.mint),
  });
  assert.equal(usdtSweep2.swept, true, "an unrelated, still-active authorization keeps working after a different asset is revoked");
  assert.equal(usdtSweep2.nativeAmount, 5_000_000n);
});

test("SIMULATED failure case: a hung confirmation is self-healed within the same sweep call by reconciling against real on-chain state, never left ambiguous", async () => {
  const { db, conn, client, pooled } = setup();
  const entry = findEntry("USDC");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  seedPrice(db, entry.mint, 1.0);

  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 200_000_000n, delegate: null, delegatedAmount: 0n, programId }); // 200 USDC

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
  const authSig = await signAndSend(conn, built.transaction, client);
  const authResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: built.tokenAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: authSig,
    programId,
  });
  assert.equal(authResult.outcome, "RECORDED");
  backdateAuthorization(db, (authResult as { authorizationId: string }).authorizationId);

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId)).address;

  // The transfer genuinely lands on-chain (FakeConnection applies it inside
  // sendRawTransaction, same as a real validator would), but the RPC call
  // that was supposed to report confirmation hangs/throws -- an ambiguous
  // outcome from the caller's point of view.
  conn.simulateConfirmHangOnce();
  const row = getAuthorization(db, clientId, entry.mint)!;
  const attempt = await sweepAsset(row, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: dest,
    programId,
    decimals: entry.decimals,
    price: priceOf(db, entry.mint),
  });
  // sweepAsset never assumes the ambiguous outcome was a failure -- it
  // re-checks real on-chain status before deciding, and correctly reports
  // the transfer as having succeeded rather than silently losing track of it.
  assert.equal(attempt.swept, true);

  const depositRow = db.prepare("SELECT status FROM deposits WHERE tx_signature = ?").get(attempt.txSignature!) as { status: string };
  assert.equal(depositRow.status, "CONFIRMED");
  const finalDeposits = db.prepare("SELECT COUNT(*) as n FROM deposits WHERE client_asset_authorization_id = ?").get(row.id) as { n: number };
  assert.equal(finalDeposits.n, 1);
});

test("SIMULATED: item O -- a PENDING row left behind by a crashed process (broadcast succeeded, process died before recording the outcome) is reconciled exactly once when a fresh process (the 'restart') calls sweepAsset again, never duplicating the transfer", async () => {
  const { db, conn, client, pooled } = setup();
  const entry = findEntry("USDC");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  seedPrice(db, entry.mint, 1.0);

  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 200_000_000n, delegate: null, delegatedAmount: 0n, programId }); // 200 USDC

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
  const authSig = await signAndSend(conn, built.transaction, client);
  const authResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: built.tokenAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: authSig,
    programId,
  });
  assert.equal(authResult.outcome, "RECORDED");
  backdateAuthorization(db, (authResult as { authorizationId: string }).authorizationId);

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId)).address;
  const row = getAuthorization(db, clientId, entry.mint)!;

  // Simulate a PRIOR process crashing exactly between "reserve" and
  // "broadcast confirmed" -- it signed and broadcast the transfer (so it
  // genuinely landed on-chain, exactly like sweepAsset's own reserve-before-
  // broadcast ordering guarantees) and inserted the PENDING row, then died
  // before ever updating that row's status. This is deliberately built by
  // hand, independent of sweepAsset's own code, so the test proves the
  // RECOVERY path (reconcilePendingDeposit / the `existingPending` branch)
  // rather than re-testing the same code path as the hung-confirmation case.
  const crashedTransferIx = (await import("@solana/spl-token")).createTransferCheckedInstruction(
    built.tokenAccount,
    mint,
    dest,
    pooled.publicKey,
    200_000_000n,
    entry.decimals,
    [],
    programId,
  );
  const { Transaction } = await import("@solana/web3.js");
  const crashedTx = new Transaction().add(crashedTransferIx);
  crashedTx.feePayer = pooled.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  crashedTx.recentBlockhash = blockhash;
  crashedTx.lastValidBlockHeight = lastValidBlockHeight;
  crashedTx.sign(pooled);
  if (!crashedTx.signature) throw new Error("test setup: no signature");
  const crashedSig = bs58.encode(crashedTx.signature);
  await conn.sendRawTransaction(crashedTx.serialize()); // genuinely lands -- balances move in the fake ledger
  db.prepare(
    `INSERT INTO deposits (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, status)
     VALUES ('crashed-1', ?, ?, ?, ?, ?, ?, '200000000', '200000000', 'PENDING')`,
  ).run(clientId, row.id, entry.mint, crashedSig, built.tokenAccount.toBase58(), dest.toBase58());

  // "Restart the server" -- a fresh process calls sweepAsset with no memory
  // of the crashed attempt, only what the database and chain say.
  const freshRow = getAuthorization(db, clientId, entry.mint)!;
  const restartAttempt = await sweepAsset(freshRow, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: dest,
    programId,
    decimals: entry.decimals,
    price: priceOf(db, entry.mint),
  });
  // The pre-existing PENDING row is reconciled (found CONFIRMED on-chain,
  // credited); no NEW transfer is attempted this pass since the entire
  // balance was already pulled by the crashed-but-landed transaction.
  assert.equal(restartAttempt.swept, false);
  assert.equal(restartAttempt.reason, "NOTHING_TO_SWEEP");

  const reconciledDeposit = db.prepare("SELECT status FROM deposits WHERE tx_signature = ?").get(crashedSig) as { status: string };
  assert.equal(reconciledDeposit.status, "CONFIRMED", "the crashed-process's deposit row is reconciled to CONFIRMED, not left PENDING or lost");

  const finalDeposits = db.prepare("SELECT COUNT(*) as n FROM deposits WHERE client_asset_authorization_id = ?").get(row.id) as { n: number };
  assert.equal(finalDeposits.n, 1, "exactly one deposit row exists -- the restart never created a duplicate alongside the reconciled one");

  const finalRow = getAuthorization(db, clientId, entry.mint)!;
  assert.equal(finalRow.cumulativeCreditedUsdMicros, 200n * USDC_MICROS, "credited exactly once, via the reconciliation, not twice");
});

test("SIMULATED failure case: authorization transaction rejected on-chain is never recorded", async () => {
  const { db, conn, client, pooled } = setup();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 100_000_000n, delegate: null, delegatedAmount: 0n, programId });

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  built.transaction.recentBlockhash = blockhash;
  built.transaction.lastValidBlockHeight = lastValidBlockHeight;
  built.transaction.sign(client);
  if (!built.transaction.signature) throw new Error("test setup: transaction signing produced no signature");
  const sig = bs58.encode(built.transaction.signature);
  conn.registerFailedSignature(sig, "InstructionError");

  const result = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: built.tokenAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: sig,
    programId,
  });
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.reason, "TRANSACTION_NOT_CONFIRMED");
  assert.equal(getAuthorization(db, "any", entry.mint), null);
});

test("SIMULATED failure case: authorization transaction that never confirms is never recorded", async () => {
  const { db, conn, client, pooled } = setup();
  const entry = findEntry("USDT");
  const result = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: PublicKey.default.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: "9".repeat(88), // never submitted, never in FakeConnection's signature map
    programId: tokenProgramIdFor(entry),
  });
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.reason, "TRANSACTION_NOT_CONFIRMED");
});

test("SIMULATED failure case: token account missing at authorization time is rejected, not silently created", async () => {
  const { db, conn, client, pooled } = setup();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  // A confirmed signature exists, but the named token account was never set up in FakeConnection.
  const fakeSig = "confirmed-but-account-missing";
  conn.registerConfirmedSignature(fakeSig);

  const result = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: Keypair.generate().publicKey.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: fakeSig,
    programId,
  });
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.reason, "TOKEN_ACCOUNT_NOT_FOUND");
});

test("SIMULATED failure case: RPC send failure during authorization submission surfaces as an error, records nothing", async () => {
  const { conn, client, pooled } = setup();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 100_000_000n, delegate: null, delegatedAmount: 0n, programId });

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
  conn.simulateSendFailureOnce();
  await assert.rejects(() => signAndSend(conn, built.transaction, client), /SIMULATED: RPC send failure/);
});

test("SIMULATED failure case: duplicate/replayed authorization signature is processed exactly once (idempotent)", async () => {
  const { db, conn, client, pooled } = setup();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 100_000_000n, delegate: null, delegatedAmount: 0n, programId });

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
  const sig = await signAndSend(conn, built.transaction, client);

  const input = {
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: built.tokenAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: sig,
    programId,
  };
  const first = await processAuthorizationSubmission(input);
  const second = await processAuthorizationSubmission(input); // e.g. the indexer observing the same confirmed tx twice
  assert.equal(first.outcome, "RECORDED");
  assert.equal(second.outcome, "ALREADY_PROCESSED");

  const eventCount = db.prepare("SELECT COUNT(*) as n FROM authorization_events WHERE tx_signature = ?").get(sig) as { n: number };
  assert.equal(eventCount.n, 1, "the duplicate observation must not create a second audit event");
});

test("SIMULATED failure case: stale/missing price fails closed -- the asset is excluded from selection, never valued at an invented price", async () => {
  const { db, conn, client } = setup();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 100_000_000n, delegate: null, delegatedAmount: 0n, programId });
  conn.setSolBalance(client.publicKey, 1_000_000_000n);
  seedPrice(db, SOL_ASSET_KEY, 150);
  // Deliberately do NOT seed a price for USDT -- getPrice() will attempt a
  // live re-fetch on the empty cache. That fetch is forced to fail here,
  // deterministically and without any real network call, by stubbing
  // fetch for the duration of this test only (restored in `finally`) --
  // this is what actually simulates "a price that cannot be obtained",
  // never a live network call's timing.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("SIMULATED: price provider unreachable");
  }) as typeof fetch;
  try {
    const scan = await scanWallet(conn as any, db, client.publicKey, new Set());
    assert.equal(scan.selectedSplAssets.length, 0, "an unpriced holding must never be selected, not even at an assumed/zero value");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("SIMULATED failure case: cap exhaustion blocks further sweeps for that asset only", async () => {
  const { db, conn, client, pooled } = setup();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  seedPrice(db, entry.mint, 1.0);
  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 1_000_000n * 10n ** BigInt(entry.decimals), delegate: null, delegatedAmount: 0n, programId });

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 10_000_000n * 10n ** BigInt(entry.decimals));
  const sig = await signAndSend(conn, built.transaction, client);
  const authResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: built.tokenAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: sig,
    programId,
  });
  assert.equal(authResult.outcome, "RECORDED");
  const authorizationId = authResult.outcome === "RECORDED" ? authResult.authorizationId : "";
  backdateAuthorization(db, authorizationId);

  // Directly mark the cap as already fully used, as if a prior sweep already credited $1,000,000.
  db.prepare("UPDATE client_asset_authorizations SET cumulative_credited_usd_micros = asset_cap_usd_micros WHERE id = ?").run(authorizationId);

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId)).address;
  const row = getAuthorization(db, clientId, entry.mint)!;
  const sweep = await sweepAsset(row, { connection: conn as any, db, pooledWallet: toPooledSigner(pooled), pooledDestinationAccount: dest, programId, decimals: entry.decimals, price: priceOf(db, entry.mint) });
  assert.equal(sweep.swept, false);
  assert.equal(sweep.reason, "CAP_EXHAUSTED");
});

test("SIMULATED failure case: NOT_DELEGATED_TO_POOLED_WALLET blocks a sweep if on-chain delegate doesn't match (e.g. tampered/foreign approval)", async () => {
  const { db, conn, client, pooled } = setup();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  seedPrice(db, entry.mint, 1.0);
  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 100_000_000n, delegate: null, delegatedAmount: 0n, programId });

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
  const sig = await signAndSend(conn, built.transaction, client);
  const authResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: built.tokenAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: sig,
    programId,
  });
  assert.equal(authResult.outcome, "RECORDED");
  backdateAuthorization(db, (authResult as { authorizationId: string }).authorizationId);

  // Simulate the delegate having been changed/cleared on-chain after recording (e.g. the client revoked directly on-chain without telling the backend).
  const acct = conn.getTokenAccountState(built.tokenAccount)!;
  conn.setTokenAccount(built.tokenAccount, { ...acct, delegate: Keypair.generate().publicKey });

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId)).address;
  const row = getAuthorization(db, clientId, entry.mint)!;
  const sweep = await sweepAsset(row, { connection: conn as any, db, pooledWallet: toPooledSigner(pooled), pooledDestinationAccount: dest, programId, decimals: entry.decimals, price: priceOf(db, entry.mint) });
  assert.equal(sweep.swept, false);
  assert.equal(sweep.reason, "NOT_DELEGATED_TO_POOLED_WALLET");
});
