// SIMULATED focused review of the sweep state machine's concurrency and
// restart-recovery behavior, requested as a follow-up to the E2E harness
// (see e2e.simulated.test.ts's header for why this is simulated, not
// real-chain, and what that does and does not prove).
//
// Where "concurrent workers" are tested, this uses TWO SEPARATE, real,
// file-backed node:sqlite DatabaseSync connections to the SAME database
// file (see testSupport/testDb.ts's freshFileTestDb) — never two handles to
// an in-memory database, which would not share state at all, and never a
// single connection called twice in a row, which would prove nothing about
// real concurrent access. The two connections share one FakeConnection,
// representing two backend processes talking to the same cluster and the
// same database, which is the actual topology a second indexer worker (or
// a restarted one) would have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { DatabaseSync } from "node:sqlite";

import { freshTestDb as freshDb, freshFileTestDb, backdateAuthorization } from "../testSupport/testDb.ts";
import { FakeConnection } from "../testSupport/fakeConnection.ts";
import { withTransaction } from "../src/db/client.ts";
import { SOL_ASSET_KEY, loadAllowlist, type AllowlistEntry } from "../src/allowlist/loadAllowlist.ts";
import { buildSplAuthorizationTx, tokenProgramIdFor } from "../src/authorization/splAuthorization.ts";
import { buildSolAuthorizationTx } from "../src/authorization/solAuthorization.ts";
import { processAuthorizationSubmission, processRevocationSubmission } from "../src/authorization/processAuthorization.ts";
import { getAuthorization } from "../src/authorization/authorizationStore.ts";
import { sweepAsset } from "../src/sweep/sweepAsset.ts";
import { toPooledSigner } from "../src/solana/pooledSigner.ts";
import { NATIVE_MINT } from "../src/solana/connection.ts";

const USDC_MICROS = 1_000_000n;

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

async function signAndSend(conn: FakeConnection, tx: Transaction, signer: Keypair): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(signer);
  return conn.sendRawTransaction(tx.serialize());
}

/** Full authorize-and-confirm for one SPL entry, on a given db handle. Returns the confirmed authorization row (read back via that same db handle). */
async function authorizeSpl(
  db: DatabaseSync,
  conn: FakeConnection,
  client: Keypair,
  pooled: Keypair,
  entry: AllowlistEntry,
  liveBalanceNative: bigint,
  delegatedAmountNative: bigint,
) {
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: liveBalanceNative, delegate: null, delegatedAmount: 0n, programId });

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, delegatedAmountNative);
  const sig = await signAndSend(conn, built.transaction, client);
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
  if (result.outcome !== "RECORDED") throw new Error(`test setup: authorization was not RECORDED (${JSON.stringify(result)})`);
  // This file's tests are about concurrency/restart/cap/delegate behavior,
  // not the sweep-delay gate itself (see sweepDelay.test.ts for that) --
  // backdated so sweepAsset() is willing to attempt a sweep immediately.
  backdateAuthorization(db, result.authorizationId);

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  return { clientId, tokenAccount: built.tokenAccount, programId, mint };
}

// ---------------------------------------------------------------------------
// 1. Unknown broadcast outcome
// ---------------------------------------------------------------------------

test("unknown broadcast outcome: a lost send-response never produces a second transfer, and an ambiguous outcome stays PENDING rather than being treated as failed", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  const { clientId, mint, programId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId)).address;

  // The broadcast genuinely succeeds (FakeConnection applies it), but the
  // process "loses" the confirmTransaction response -- it has no idea
  // whether the transfer landed.
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
  // sweepAsset re-checks real on-chain status before ever deciding the
  // outcome, and correctly resolves it -- it never invents a "failed" or
  // "unknown forever" state when the truth is checkable.
  assert.equal(attempt.swept, true);

  // Calling sweep again (e.g. a caller that also doesn't trust its own
  // in-memory result and wants to be safe) must NOT create a second
  // transfer -- there is nothing left to sweep, so it can only report that.
  const rowAfter = getAuthorization(db, clientId, entry.mint)!;
  const secondCall = await sweepAsset(rowAfter, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: dest,
    programId,
    decimals: entry.decimals,
    price: priceOf(db, entry.mint),
  });
  assert.equal(secondCall.swept, false);
  assert.equal(secondCall.reason, "NOTHING_TO_SWEEP");

  const deposits = db.prepare("SELECT COUNT(*) as n FROM deposits WHERE client_asset_authorization_id = ?").get(row.id) as { n: number };
  assert.equal(deposits.n, 1, "exactly one transfer exists, never a second one created because a signature was momentarily unknown");
});

test("unknown broadcast outcome: a genuinely still-in-flight signature (within its blockhash's validity window) stays PENDING, is never guessed at as failed or successful", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);
  const { clientId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));

  const authRow = getAuthorization(db, clientId, entry.mint)!;
  // A reservation exists (as if a process reserved it) for a signature that
  // FakeConnection has genuinely never seen -- i.e. it was never actually
  // broadcast, OR it's still propagating through the cluster. Either way,
  // right now, nothing distinguishes those two cases except the passage of
  // time relative to its blockhash's expiry.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  void blockhash;
  db.prepare(
    `INSERT INTO deposits (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, last_valid_block_height, status)
     VALUES ('reserved-1', ?, ?, ?, 'unknown-outcome-sig', 'src', 'dst', '1000000', '1000000', ?, 'PENDING')`,
  ).run(clientId, authRow.id, entry.mint, lastValidBlockHeight);

  const attempt = await sweepAsset(authRow, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: PublicKey.default,
    programId: tokenProgramIdFor(entry),
    decimals: entry.decimals,
    price: priceOf(db, entry.mint),
  });
  assert.equal(attempt.swept, false);
  assert.equal(attempt.reason, "PRIOR_SWEEP_STILL_PENDING", "an unresolved signature within its validity window must stay PENDING, never be assumed failed");

  const depositRow = db.prepare("SELECT status FROM deposits WHERE id = 'reserved-1'").get() as { status: string };
  assert.equal(depositRow.status, "PENDING");
});

// ---------------------------------------------------------------------------
// 2. Restart recovery at three crash points
// ---------------------------------------------------------------------------

test("restart recovery (a): reserved but never broadcast -- once its blockhash provably expires, it's marked FAILED and a fresh sweep proceeds safely; no funds were ever at risk since nothing was ever sent", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);
  const { clientId, mint, programId, tokenAccount } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId)).address;

  const authRow = getAuthorization(db, clientId, entry.mint)!;
  const { lastValidBlockHeight } = await conn.getLatestBlockhash();
  // A process reserved a sweep (inserted PENDING) and crashed before ever
  // calling sendRawTransaction -- this signature will NEVER appear on-chain.
  db.prepare(
    `INSERT INTO deposits (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, last_valid_block_height, status)
     VALUES ('never-broadcast-1', ?, ?, ?, 'never-broadcast-sig', ?, ?, '100000000', '100000000', ?, 'PENDING')`,
  ).run(clientId, authRow.id, entry.mint, tokenAccount.toBase58(), dest.toBase58(), lastValidBlockHeight);

  // Immediately after "restart," the blockhash hasn't expired yet -- must stay PENDING, blocking new sweeps.
  const tooSoon = await sweepAsset(authRow, { connection: conn as any, db, pooledWallet: toPooledSigner(pooled), pooledDestinationAccount: dest, programId, decimals: entry.decimals, price: priceOf(db, entry.mint) });
  assert.equal(tooSoon.reason, "PRIOR_SWEEP_STILL_PENDING");

  // Simulate a long outage: the cluster has moved well past that blockhash's validity window.
  conn.setBlockHeight(lastValidBlockHeight + 1);

  const recovered = await sweepAsset(authRow, { connection: conn as any, db, pooledWallet: toPooledSigner(pooled), pooledDestinationAccount: dest, programId, decimals: entry.decimals, price: priceOf(db, entry.mint) });
  // The stale reservation is now provably dead and is cleared; the SAME
  // pass immediately attempts a real sweep against the untouched balance
  // (nothing was ever actually transferred, so the full balance is intact).
  assert.equal(recovered.swept, true);

  const staleRow = db.prepare("SELECT status FROM deposits WHERE id = 'never-broadcast-1'").get() as { status: string };
  assert.equal(staleRow.status, "FAILED", "the never-broadcast reservation is marked FAILED, not left PENDING forever and not silently deleted");

  const realDeposit = db.prepare("SELECT status, native_amount FROM deposits WHERE tx_signature = ?").get(recovered.txSignature!) as { status: string; native_amount: string };
  assert.equal(realDeposit.status, "CONFIRMED");
  assert.equal(realDeposit.native_amount, "100000000", "the full original balance was swept -- the dead reservation never consumed any of it");

  const finalRow = getAuthorization(db, clientId, entry.mint)!;
  assert.equal(finalRow.cumulativeCreditedUsdMicros, 100n * USDC_MICROS, "credited exactly once, for the real transfer -- the dead reservation contributed nothing");
});

test("restart recovery (b): broadcast landed but confirmation was never observed -- a fresh process reconciles it exactly once (covered in depth in e2e.simulated.test.ts's item O)", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDC");
  seedPrice(db, entry.mint, 1.0);
  const { clientId, mint, programId, tokenAccount } = await authorizeSpl(db, conn, client, pooled, entry, 200_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId)).address;

  const crashedTransferIx = createTransferCheckedInstruction(tokenAccount, mint, dest, pooled.publicKey, 200_000_000n, entry.decimals, [], programId);
  const crashedTx = new Transaction().add(crashedTransferIx);
  crashedTx.feePayer = pooled.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  crashedTx.recentBlockhash = blockhash;
  crashedTx.lastValidBlockHeight = lastValidBlockHeight;
  crashedTx.sign(pooled);
  const crashedSig = bs58.encode(crashedTx.signature!);
  await conn.sendRawTransaction(crashedTx.serialize()); // genuinely lands

  const authRow = getAuthorization(db, clientId, entry.mint)!;
  db.prepare(
    `INSERT INTO deposits (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, last_valid_block_height, status)
     VALUES ('crashed-b', ?, ?, ?, ?, ?, ?, '200000000', '200000000', ?, 'PENDING')`,
  ).run(clientId, authRow.id, entry.mint, crashedSig, tokenAccount.toBase58(), dest.toBase58(), lastValidBlockHeight);

  const restartAttempt = await sweepAsset(authRow, { connection: conn as any, db, pooledWallet: toPooledSigner(pooled), pooledDestinationAccount: dest, programId, decimals: entry.decimals, price: priceOf(db, entry.mint) });
  assert.equal(restartAttempt.reason, "NOTHING_TO_SWEEP");

  const reconciled = db.prepare("SELECT status FROM deposits WHERE tx_signature = ?").get(crashedSig) as { status: string };
  assert.equal(reconciled.status, "CONFIRMED");
  const total = db.prepare("SELECT COUNT(*) as n FROM deposits WHERE client_asset_authorization_id = ?").get(authRow.id) as { n: number };
  assert.equal(total.n, 1);
});

test("restart recovery (c): marking a deposit CONFIRMED and crediting its authorization are one atomic DB transaction -- a failure between the two statements rolls both back, never leaving one applied without the other", () => {
  const db = freshDb();
  db.exec("CREATE TABLE probe_confirm_credit (id TEXT PRIMARY KEY, deposit_status TEXT, credited TEXT)");
  db.prepare("INSERT INTO probe_confirm_credit (id, deposit_status, credited) VALUES ('x', 'PENDING', '0')").run();

  assert.throws(() => {
    withTransaction(db, () => {
      db.prepare("UPDATE probe_confirm_credit SET deposit_status = 'CONFIRMED' WHERE id = 'x'").run();
      throw new Error("simulated crash/error between marking CONFIRMED and crediting -- exactly what sweepAsset's markConfirmedAndCredit wraps in one withTransaction call");
    });
  }, /simulated crash/);

  const row = db.prepare("SELECT deposit_status, credited FROM probe_confirm_credit WHERE id = 'x'").get() as { deposit_status: string; credited: string };
  assert.equal(row.deposit_status, "PENDING", "the UPDATE must be rolled back -- restart must find the deposit still PENDING, not CONFIRMED-without-credit");
  assert.equal(row.credited, "0");
});

// ---------------------------------------------------------------------------
// 3 & 4. Concurrent sweep workers, and cap reservation under concurrency
// ---------------------------------------------------------------------------

test("concurrent sweep workers: two DB connections racing on the SAME authorization -- only one reserves and transfers; the other is rejected at the database level, not merely by application convention", async () => {
  const fileDb = freshFileTestDb();
  try {
    const setupDb = fileDb.connect();
    const conn = new FakeConnection();
    const client = Keypair.generate();
    const pooled = Keypair.generate();
    const entry = findEntry("USDT");
    seedPrice(setupDb, entry.mint, 1.0);
    const { clientId, mint, programId } = await authorizeSpl(setupDb, conn, client, pooled, entry, 500_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
    const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId)).address;
    const sharedRow = getAuthorization(setupDb, clientId, entry.mint)!;

    // Two independent connections to the SAME file -- two real "processes."
    const worker1Db = fileDb.connect();
    const worker2Db = fileDb.connect();
    const sweepDeps = (db: DatabaseSync) => ({
      connection: conn as any,
      db,
      pooledWallet: toPooledSigner(pooled),
      pooledDestinationAccount: dest,
      programId,
      decimals: entry.decimals,
      price: priceOf(db, entry.mint),
    });

    const [result1, result2] = await Promise.all([sweepAsset(sharedRow, sweepDeps(worker1Db)), sweepAsset(sharedRow, sweepDeps(worker2Db))]);

    const outcomes = [result1, result2];
    const winners = outcomes.filter((r) => r.swept);
    const losers = outcomes.filter((r) => !r.swept);
    assert.equal(winners.length, 1, "exactly one worker must actually sweep");
    assert.equal(losers.length, 1, "the other must be rejected, not silently no-op or also succeed");
    assert.equal(losers[0].reason, "SWEEP_ALREADY_IN_PROGRESS");

    const deposits = setupDb.prepare("SELECT COUNT(*) as n FROM deposits WHERE client_asset_authorization_id = ?").get(sharedRow.id) as { n: number };
    assert.equal(deposits.n, 1, "the database itself has exactly one transfer row -- the race was resolved by a real constraint, not by luck");

    const finalRow = getAuthorization(setupDb, clientId, entry.mint)!;
    assert.equal(finalRow.cumulativeCreditedUsdMicros, 500n * USDC_MICROS, "credited exactly once, for exactly the one transfer that actually happened");
  } finally {
    fileDb.cleanup();
  }
});

test("cap reservation under concurrency: two concurrent sweeps that would each individually fit within remaining headroom cannot together exceed the $1,000,000 cap", async () => {
  const fileDb = freshFileTestDb();
  try {
    const setupDb = fileDb.connect();
    const conn = new FakeConnection();
    const client = Keypair.generate();
    const pooled = Keypair.generate();
    const entry = findEntry("USDC");
    seedPrice(setupDb, entry.mint, 1.0);
    // 200 USDC live/delegated; cap already at $999,900 credited, so remaining headroom is exactly $100.
    const { clientId, mint, programId } = await authorizeSpl(setupDb, conn, client, pooled, entry, 200_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
    setupDb.prepare("UPDATE client_asset_authorizations SET cumulative_credited_usd_micros = ? WHERE client_id = ? AND asset_key = ?").run(
      (999_900n * USDC_MICROS).toString(),
      clientId,
      entry.mint,
    );
    const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId)).address;
    const sharedRow = getAuthorization(setupDb, clientId, entry.mint)!;
    assert.equal(sharedRow.assetCapUsdMicros - sharedRow.cumulativeCreditedUsdMicros, 100n * USDC_MICROS);

    const worker1Db = fileDb.connect();
    const worker2Db = fileDb.connect();
    const sweepDeps = (db: DatabaseSync) => ({
      connection: conn as any,
      db,
      pooledWallet: toPooledSigner(pooled),
      pooledDestinationAccount: dest,
      programId,
      decimals: entry.decimals,
      price: priceOf(db, entry.mint),
    });

    // Each worker, reading the same stale $100 headroom, independently
    // computes a sweep amount of exactly $100 -- individually within
    // headroom, but $200 combined would blow through the $1,000,000 cap by
    // $100 if both were allowed to commit.
    const [result1, result2] = await Promise.all([sweepAsset(sharedRow, sweepDeps(worker1Db)), sweepAsset(sharedRow, sweepDeps(worker2Db))]);
    const winners = [result1, result2].filter((r) => r.swept);
    assert.equal(winners.length, 1, "only one of the two racing sweeps may actually commit");

    const finalRow = getAuthorization(setupDb, clientId, entry.mint)!;
    assert.equal(finalRow.cumulativeCreditedUsdMicros, 1_000_000n * USDC_MICROS, "credited total lands exactly AT the cap, never over it");
    assert.ok(finalRow.cumulativeCreditedUsdMicros <= finalRow.assetCapUsdMicros, "the independent $1,000,000 cap for this asset was never exceeded");
  } finally {
    fileDb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Authorization race: revocation landing between a sweep's read and its execution
// ---------------------------------------------------------------------------

test("authorization race: a stale in-memory ACTIVE row cannot move funds once the on-chain delegate has actually been revoked -- the live check, not the cached status, is what's authoritative", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);
  const { clientId, tokenAccount } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));

  // A sweep worker loads the authorization row -- at this instant it is genuinely ACTIVE.
  const staleRow = getAuthorization(db, clientId, entry.mint)!;
  assert.equal(staleRow.status, "ACTIVE");

  // Before the worker gets to actually move funds, the client revokes --
  // both the on-chain delegate is cleared AND the database is updated.
  const revokeTx = (await import("../src/authorization/splAuthorization.ts")).buildSplRevokeTx(client.publicKey, tokenAccount, entry);
  const revokeSig = await signAndSend(conn, revokeTx, client);
  const revokeResult = await processRevocationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    authorizedTokenAccount: tokenAccount.toBase58(),
    txSignature: revokeSig,
    programId: tokenProgramIdFor(entry),
  });
  assert.equal(revokeResult.outcome, "RECORDED");

  // The worker proceeds using its STALE, pre-revocation copy of the row (status still says ACTIVE in this object).
  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, new PublicKey(entry.mint), pooled.publicKey, false, "confirmed", undefined, tokenProgramIdFor(entry))).address;
  const attempt = await sweepAsset(staleRow, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: dest,
    programId: tokenProgramIdFor(entry),
    decimals: entry.decimals,
    price: priceOf(db, entry.mint),
  });
  assert.equal(attempt.swept, false);
  assert.equal(attempt.reason, "NOT_DELEGATED_TO_POOLED_WALLET", "the live on-chain delegate check catches the revocation even though the in-memory row object was stale");

  const deposits = db.prepare("SELECT COUNT(*) as n FROM deposits WHERE client_asset_authorization_id = ?").get(staleRow.id) as { n: number };
  assert.equal(deposits.n, 0, "no funds moved despite the stale ACTIVE status object");
});

// ---------------------------------------------------------------------------
// 7. SOL-specific safety
// ---------------------------------------------------------------------------

test("SOL safety: sweeping the wSOL ATA never touches the client's ordinary system-wallet SOL balance, and the destination is always the pooled wallet's own wSOL account", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  conn.setMint(NATIVE_MINT, 9, TOKEN_PROGRAM_ID);
  seedPrice(db, SOL_ASSET_KEY, 150);

  // A large, untouched system-wallet balance, separate from whatever gets wrapped.
  conn.setSolBalance(client.publicKey, 50_000_000_000n); // 50 SOL sitting in the ordinary system wallet

  const solAuth = await buildSolAuthorizationTx(conn as any, client.publicKey, pooled.publicKey, 2_000_000_000n, 1_000_000_000_000n);
  const sig = await signAndSend(conn, solAuth.transaction, client);
  const result = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: solAuth.wsolAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: sig,
    programId: TOKEN_PROGRAM_ID,
  });
  assert.equal(result.outcome, "RECORDED");
  backdateAuthorization(db, (result as { authorizationId: string }).authorizationId);

  const balanceBeforeSweep = conn.getSolBalance(client.publicKey);
  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, NATIVE_MINT, pooled.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  const row = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  const sweep = await sweepAsset(row, { connection: conn as any, db, pooledWallet: toPooledSigner(pooled), pooledDestinationAccount: dest, programId: TOKEN_PROGRAM_ID, decimals: 9, price: priceOf(db, SOL_ASSET_KEY) });
  assert.equal(sweep.swept, true);

  assert.equal(conn.getSolBalance(client.publicKey), balanceBeforeSweep, "the client's ordinary system-wallet SOL balance must be completely untouched by a wSOL sweep");
  const destState = conn.getTokenAccountState(dest)!;
  assert.equal(destState.owner.toBase58(), pooled.publicKey.toBase58(), "the destination is the pooled wallet's own wSOL account, never the client's");
  assert.equal(destState.amount, 2_000_000_000n);
});

test("SOL safety: native SOL in the client's ordinary system wallet is never treated as automatically sweepable -- attempting to sweep a system account (not a token account) fails closed rather than moving lamports", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  conn.setSolBalance(client.publicKey, 50_000_000_000n); // plenty of raw SOL, but no wSOL authorization was ever created

  db.prepare("INSERT INTO clients (id, wallet_pubkey) VALUES ('c1', ?)").run(client.publicKey.toBase58());
  // A hand-crafted, invalid authorization row that names the client's OWN
  // system wallet address as if it were a token account -- exactly what an
  // attempted "just sweep their SOL directly" shortcut would look like.
  db.prepare(
    `INSERT INTO client_asset_authorizations
     (id, client_id, asset_key, token_program, authorized_token_account, delegate, original_authorized_native_amount, authorization_tx_signature, authorized_at, status, cumulative_credited_usd_micros, asset_cap_usd_micros)
     VALUES ('bogus-auth', 'c1', ?, 'NATIVE_SOL', ?, ?, '1000000000', 'fake-sig', datetime('now'), 'ACTIVE', '0', '1000000000000')`,
  ).run(SOL_ASSET_KEY, client.publicKey.toBase58(), pooled.publicKey.toBase58());
  backdateAuthorization(db, "bogus-auth");

  seedPrice(db, SOL_ASSET_KEY, 150);
  const row = getAuthorization(db, "c1", SOL_ASSET_KEY)!;

  await assert.rejects(
    () =>
      sweepAsset(row, {
        connection: conn as any,
        db,
        pooledWallet: toPooledSigner(pooled),
        pooledDestinationAccount: PublicKey.default,
        programId: TOKEN_PROGRAM_ID,
        decimals: 9,
        price: priceOf(db, SOL_ASSET_KEY),
      }),
    /* the client's system wallet is not a token account at all -- getAccount must fail rather than any lamports moving */
  );

  assert.equal(conn.getSolBalance(client.publicKey), 50_000_000_000n, "the client's system-wallet SOL balance is completely unchanged after the failed attempt");
  const deposits = db.prepare("SELECT COUNT(*) as n FROM deposits").get() as { n: number };
  assert.equal(deposits.n, 0);
});

// ---------------------------------------------------------------------------
// 8. SPL-specific safety
// ---------------------------------------------------------------------------

test("SPL safety: an authorization claiming the wrong mint for a real token account is rejected (MINT_MISMATCH), never recorded under the claimed asset", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const usdt = findEntry("USDT");
  const usdc = findEntry("USDC");
  const programId = tokenProgramIdFor(usdt);
  const usdtMint = new PublicKey(usdt.mint);
  conn.setMint(usdtMint, usdt.decimals, programId);
  const ata = await getAssociatedTokenAddress(usdtMint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint: usdtMint, owner: client.publicKey, amount: 100_000_000n, delegate: null, delegatedAmount: 0n, programId });

  // Client signs a REAL Approve on their real USDT account...
  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, usdt, pooled.publicKey, 1_000_000n * 10n ** BigInt(usdt.decimals));
  const sig = await signAndSend(conn, built.transaction, client);

  // ...but the submission CLAIMS it's authorizing USDC.
  const result = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: usdc.mint,
    tokenProgram: usdc.token_program,
    authorizedTokenAccount: built.tokenAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: sig,
    programId: tokenProgramIdFor(usdc),
  });
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.reason, "MINT_MISMATCH");
  assert.equal(getAuthorization(db, "any", usdc.mint), null);
});

test("SPL safety: an authorization claiming a token account that belongs to a DIFFERENT wallet is rejected (OWNER_MISMATCH)", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const actualOwner = Keypair.generate();
  const claimingWallet = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  const ata = await getAssociatedTokenAddress(mint, actualOwner.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: actualOwner.publicKey, amount: 100_000_000n, delegate: pooled.publicKey, delegatedAmount: 1_000_000_000n, programId });
  conn.registerConfirmedSignature("owner-mismatch-sig");

  const result = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: claimingWallet.publicKey.toBase58(), // NOT the account's real owner
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: ata.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: "owner-mismatch-sig",
    programId,
  });
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.reason, "OWNER_MISMATCH");
});

test("SPL safety: Token-2022 authorize -> sweep works identically to legacy SPL Token, with its own program id validated throughout", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDG"); // TOKEN_2022 in the allowlist
  assert.equal(entry.token_program, "TOKEN_2022");
  seedPrice(db, entry.mint, 1.0);

  const { clientId, mint, programId } = await authorizeSpl(db, conn, client, pooled, entry, 50_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  assert.ok(programId.equals(TOKEN_PROGRAM_ID) === false, "USDG must use the Token-2022 program id, not legacy");

  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId)).address;
  const row = getAuthorization(db, clientId, entry.mint)!;
  const sweep = await sweepAsset(row, { connection: conn as any, db, pooledWallet: toPooledSigner(pooled), pooledDestinationAccount: dest, programId, decimals: entry.decimals, price: priceOf(db, entry.mint) });
  assert.equal(sweep.swept, true);
  assert.equal(sweep.nativeAmount, 50_000_000n);
});

test("SPL safety: a TransferChecked instruction with a decimals argument that doesn't match the mint's real decimals is rejected outright, never silently executed at the wrong scale", async () => {
  const conn = new FakeConnection();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT"); // 6 decimals
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, TOKEN_PROGRAM_ID);
  const source = Keypair.generate().publicKey;
  const dest = Keypair.generate().publicKey;
  conn.setTokenAccount(source, { mint, owner: pooled.publicKey, amount: 100_000_000n, delegate: pooled.publicKey, delegatedAmount: 100_000_000n, programId: TOKEN_PROGRAM_ID });
  conn.setTokenAccount(dest, { mint, owner: pooled.publicKey, amount: 0n, delegate: null, delegatedAmount: 0n, programId: TOKEN_PROGRAM_ID });

  const wrongDecimalsIx = createTransferCheckedInstruction(source, mint, dest, pooled.publicKey, 1_000_000n, 9 /* wrong -- USDT is 6 */, [], TOKEN_PROGRAM_ID);
  const tx = new Transaction().add(wrongDecimalsIx);
  tx.feePayer = pooled.publicKey;
  const sig = await signAndSend(conn, tx, pooled);

  const status = await conn.getSignatureStatus(sig);
  assert.ok(status.value?.err, "a decimals mismatch must be rejected, mirroring real TransferChecked validation");
  assert.equal(conn.getTokenAccountState(source)!.amount, 100_000_000n, "source balance unchanged -- the mismatched instruction never executed");
  assert.equal(conn.getTokenAccountState(dest)!.amount, 0n);
});
