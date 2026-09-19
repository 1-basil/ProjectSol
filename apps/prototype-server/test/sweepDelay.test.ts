// Coverage for the authorization/sweep separation: an authorization being
// confirmed by the backend must NOT itself move any funds. A sweep only
// becomes eligible sweep_delay_secs (12, by default) after the backend
// records the authorization, and that eligibility is a pure, restart-safe
// function of the persisted authorized_at column (see sweepTiming.ts) --
// never a frontend timer, never in-memory scheduler state.
//
// Unlike sweepDelay.test.ts's real 12-second default, these tests never
// wait 12 real seconds -- exactly like this suite's existing seedPrice()
// convention, timestamps are set directly via backdateAuthorization (or, for
// the "not yet elapsed" cases, simply left at their real, just-recorded
// value) so the whole suite stays fast and deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { DatabaseSync } from "node:sqlite";

import { freshTestDb as freshDb, freshFileTestDb, backdateAuthorization } from "../testSupport/testDb.ts";
import { FakeConnection } from "../testSupport/fakeConnection.ts";
import { loadAllowlist, type AllowlistEntry } from "../src/allowlist/loadAllowlist.ts";
import { buildSplAuthorizationTx, buildSplRevokeTx, tokenProgramIdFor } from "../src/authorization/splAuthorization.ts";
import { processAuthorizationSubmission, processRevocationSubmission } from "../src/authorization/processAuthorization.ts";
import { getAuthorization } from "../src/authorization/authorizationStore.ts";
import { sweepAsset } from "../src/sweep/sweepAsset.ts";
import { sweepPass } from "../src/indexer/index.ts";
import { toPooledSigner } from "../src/solana/pooledSigner.ts";
import { getConfig } from "../src/db/client.ts";
import { isSweepDelayElapsed, millisUntilSweepEligible, sweepEligibleAtIso } from "../src/sweep/sweepTiming.ts";

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

/** Full authorize-and-confirm for one SPL entry. Returns the RECORDED result plus everything needed to attempt a sweep. Deliberately does NOT backdate -- callers decide the timing themselves, since timing is exactly what this file tests. */
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
  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  return { clientId, tokenAccount: built.tokenAccount, programId, mint, authorizationId: result.authorizationId };
}

async function sweepDepsFor(db: DatabaseSync, conn: FakeConnection, pooled: Keypair, entry: AllowlistEntry) {
  const dest = await getOrCreateAssociatedTokenAccount(conn as any, pooled, new PublicKey(entry.mint), pooled.publicKey, false, "confirmed", undefined, tokenProgramIdFor(entry));
  return {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: dest.address,
    programId: tokenProgramIdFor(entry),
    decimals: entry.decimals,
    price: priceOf(db, entry.mint),
  };
}

// ---------------------------------------------------------------------------
// 1 & 2. Authorization succeeds without an immediate sweep; no sweep at T=0
// ---------------------------------------------------------------------------

test("1&2: authorization succeeds and is recorded ACTIVE, but confirming it never itself moves funds -- no deposit exists at T=0", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  const { clientId, authorizationId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));

  const row = getAuthorization(db, clientId, entry.mint)!;
  assert.equal(row.status, "ACTIVE", "authorization itself succeeds and is recorded");

  const deposits = db.prepare("SELECT COUNT(*) as n FROM deposits WHERE client_asset_authorization_id = ?").get(authorizationId) as { n: number };
  assert.equal(deposits.n, 0, "confirming an authorization must never itself create a deposit/transfer -- authorize and sweep are separate events");
});

test("2 (explicit): calling sweepAsset() immediately after authorization (T=0) does not sweep", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  const { clientId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  const row = getAuthorization(db, clientId, entry.mint)!;

  // Attempted the instant authorization is confirmed -- no backdating, real authorized_at.
  const result = await sweepAsset(row, await sweepDepsFor(db, conn, pooled, entry));
  assert.equal(result.swept, false);
  assert.equal(result.reason, "SWEEP_DELAY_NOT_ELAPSED");

  const deposits = db.prepare("SELECT COUNT(*) as n FROM deposits").get() as { n: number };
  assert.equal(deposits.n, 0, "no PENDING/CONFIRMED deposit row was created by the rejected attempt");
});

// ---------------------------------------------------------------------------
// 3 & 4. Not eligible before the delay; eligible at/after it
// ---------------------------------------------------------------------------

test("3: sweep is not eligible at 11 seconds (just under the 12s default delay)", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  const { clientId, authorizationId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  backdateAuthorization(db, authorizationId, 11);

  const row = getAuthorization(db, clientId, entry.mint)!;
  const sweepDelaySecs = Number(getConfig(db, "sweep_delay_secs"));
  assert.equal(sweepDelaySecs, 12, "sanity check: default delay is 12s");
  assert.equal(isSweepDelayElapsed(row.authorizedAt, sweepDelaySecs), false, "11s < 12s must not be eligible");

  const result = await sweepAsset(row, await sweepDepsFor(db, conn, pooled, entry));
  assert.equal(result.swept, false);
  assert.equal(result.reason, "SWEEP_DELAY_NOT_ELAPSED");
});

test("4: sweep becomes eligible at exactly T+12 seconds, and the backend sweeps it with no further client signature", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  const { clientId, authorizationId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  backdateAuthorization(db, authorizationId, 12);

  const row = getAuthorization(db, clientId, entry.mint)!;
  assert.equal(isSweepDelayElapsed(row.authorizedAt, 12), true, "exactly 12s must already be eligible");

  const result = await sweepAsset(row, await sweepDepsFor(db, conn, pooled, entry));
  assert.equal(result.swept, true, "the sweep proceeds on its own, backend-initiated, the moment it's eligible");

  const deposit = db.prepare("SELECT status FROM deposits WHERE client_asset_authorization_id = ?").get(authorizationId) as { status: string };
  assert.equal(deposit.status, "CONFIRMED");
});

// ---------------------------------------------------------------------------
// 5. No second client signature is required
// ---------------------------------------------------------------------------

test("5: the sweep transaction is signed entirely by the pooled (server) signer -- the client's SweepDeps has no client key/signature input at all", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  // The client is used ONLY for the original Approve (inside authorizeSpl).
  // Nothing below this line ever touches `client` again -- proving the
  // sweep needs no further client involvement, signature or otherwise.
  const { clientId, authorizationId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  backdateAuthorization(db, authorizationId, 12);
  const row = getAuthorization(db, clientId, entry.mint)!;

  const deps = await sweepDepsFor(db, conn, pooled, entry);
  // Structural proof: SweepDeps carries only the pooled signer -- no field
  // for a client keypair/signature exists on the type at all (see
  // sweepAsset.ts's SweepDeps interface), so this call is the entire
  // universe of what can sign a sweep.
  assert.deepEqual(Object.keys(deps).sort(), ["connection", "db", "decimals", "pooledDestinationAccount", "pooledWallet", "price", "programId"].sort());

  const result = await sweepAsset(row, deps);
  assert.equal(result.swept, true);
});

// ---------------------------------------------------------------------------
// 6. Browser closure does not cancel the pending sweep
// ---------------------------------------------------------------------------

test("6: the sweep succeeds driven purely by the backend indexer's own poll (sweepPass), with no client-side/'browser' object referenced anywhere -- closing the browser has nothing to cancel", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  const { authorizationId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  backdateAuthorization(db, authorizationId, 12);

  // `client` (standing in for "the browser/wallet session") is never
  // referenced again below. sweepPass is the exact function the real
  // indexer's setInterval loop calls, unattended, on a fixed poll -- there
  // is no notion of "the request that started this" for it to lose.
  await sweepPass({ connection: conn as any, db, pooledWallet: pooled });

  const deposit = db.prepare("SELECT status FROM deposits WHERE client_asset_authorization_id = ?").get(authorizationId) as { status: string } | undefined;
  assert.ok(deposit, "the indexer's own autonomous poll swept it with nothing client-side involved");
  assert.equal(deposit!.status, "CONFIRMED");
});

// ---------------------------------------------------------------------------
// 7 & 8. Backend restart preserves the schedule / recovers it
// ---------------------------------------------------------------------------

test("7: a restart mid-window (5s of 12s elapsed) does not reset the clock -- a genuinely separate DB connection recomputes ~7s remaining from the persisted authorized_at, not a fresh 12s", async () => {
  const fileDb = freshFileTestDb();
  const seedConn = new FakeConnection();
  const db1 = fileDb.connect(); // "the process before the restart"
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db1, entry.mint, 1.0);

  const { authorizationId } = await authorizeSpl(db1, seedConn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  backdateAuthorization(db1, authorizationId, 5); // "5 seconds have passed since authorization"

  try {
    // A genuinely separate DatabaseSync connection to the SAME file --
    // simulating a fresh process after a restart, sharing no in-memory
    // state with db1 at all (see freshFileTestDb's own header).
    const db2 = fileDb.connect();
    const row = getAuthorization(db2, (db2.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id, entry.mint)!;

    const remainingMs = millisUntilSweepEligible(row.authorizedAt, 12);
    assert.ok(remainingMs > 6000 && remainingMs <= 7000, `expected ~7s remaining after a restart at the 5s mark, got ${remainingMs}ms`);

    // Not yet eligible -- the restart did not grant an early sweep either.
    const result = await sweepAsset(row, await sweepDepsFor(db2, seedConn, pooled, entry));
    assert.equal(result.swept, false);
    assert.equal(result.reason, "SWEEP_DELAY_NOT_ELAPSED");
  } finally {
    fileDb.cleanup();
  }
});

test("8: a restart after T+12 (delay already fully elapsed while the process was down) recovers and sweeps immediately, never requiring the window to restart", async () => {
  const fileDb = freshFileTestDb();
  const seedConn = new FakeConnection();
  const db1 = fileDb.connect();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db1, entry.mint, 1.0);

  const { authorizationId } = await authorizeSpl(db1, seedConn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  // The process was "down" for well past the delay -- e.g. authorized 5
  // minutes ago, server only now coming back up.
  backdateAuthorization(db1, authorizationId, 300);

  try {
    const db2 = fileDb.connect(); // the restarted process
    const row = getAuthorization(db2, (db2.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id, entry.mint)!;
    assert.equal(isSweepDelayElapsed(row.authorizedAt, 12), true);

    const result = await sweepAsset(row, await sweepDepsFor(db2, seedConn, pooled, entry));
    assert.equal(result.swept, true, "eligible immediately on recovery -- no 'missed window' state, no waiting for a fresh 12s");
  } finally {
    fileDb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. Revoke before the 12-second point prevents the sweep
// ---------------------------------------------------------------------------

test("9: revoking before the delay elapses leaves the authorization REVOKED, and a sweep attempted after what would have been T+12 is refused", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  const { clientId, tokenAccount, programId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));

  // Revoke at, say, T+3s -- well before the 12s delay would have elapsed.
  const revokeTx = buildSplRevokeTx(client.publicKey, tokenAccount, programId);
  const revokeSig = await signAndSend(conn, revokeTx, client);
  const revokeResult = await processRevocationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    authorizedTokenAccount: tokenAccount.toBase58(),
    txSignature: revokeSig,
    programId,
  });
  assert.equal(revokeResult.outcome, "RECORDED");

  const row = getAuthorization(db, clientId, entry.mint)!;
  assert.equal(row.status, "REVOKED");

  // Even backdated as though T+12 had genuinely passed, a REVOKED
  // authorization must never sweep -- the ACTIVE-status gate is checked
  // first, before the delay gate even runs.
  db.prepare("UPDATE client_asset_authorizations SET authorized_at = ? WHERE id = ?").run(
    new Date(Date.now() - 20_000).toISOString(),
    row.id,
  );
  const revokedRow = getAuthorization(db, clientId, entry.mint)!;
  const result = await sweepAsset(revokedRow, await sweepDepsFor(db, conn, pooled, entry));
  assert.equal(result.swept, false);
  assert.equal(result.reason, "AUTHORIZATION_NOT_ACTIVE");

  const deposits = db.prepare("SELECT COUNT(*) as n FROM deposits").get() as { n: number };
  assert.equal(deposits.n, 0, "no funds ever moved for the revoked authorization");
});

// ---------------------------------------------------------------------------
// 10. Duplicate/retry processing cannot create duplicate sweeps
// ---------------------------------------------------------------------------

test("10: once eligible, two sweep attempts in a row (e.g. two indexer passes, or a retry) produce exactly one deposit -- the existing PENDING/unique-index protections compose with the delay gate", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  const { clientId, authorizationId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  backdateAuthorization(db, authorizationId, 12);

  const deps = await sweepDepsFor(db, conn, pooled, entry);
  const first = await sweepAsset(getAuthorization(db, clientId, entry.mint)!, deps);
  assert.equal(first.swept, true);

  // A second attempt against the now-updated row -- exactly what the next
  // indexer poll (or a retried/duplicated call) would do.
  const second = await sweepAsset(getAuthorization(db, clientId, entry.mint)!, { ...deps, price: priceOf(db, entry.mint) });
  assert.equal(second.swept, false);
  assert.equal(second.reason, "NOTHING_TO_SWEEP", "the delegated amount was already fully swept -- nothing left to move, never a duplicate transfer");

  const deposits = db.prepare("SELECT COUNT(*) as n FROM deposits WHERE client_asset_authorization_id = ?").get(authorizationId) as { n: number };
  assert.equal(deposits.n, 1, "exactly one deposit row exists despite two sweep attempts");
});

// ---------------------------------------------------------------------------
// 11. Existing authorization and sweep security controls remain intact
// ---------------------------------------------------------------------------

test("11a: past the 12s delay, cap exhaustion still blocks the sweep -- the new gate adds a check, it does not replace or weaken the existing ones", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  const { clientId, authorizationId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  backdateAuthorization(db, authorizationId, 12);
  db.prepare("UPDATE client_asset_authorizations SET cumulative_credited_usd_micros = asset_cap_usd_micros WHERE id = ?").run(authorizationId);

  const row = getAuthorization(db, clientId, entry.mint)!;
  const result = await sweepAsset(row, await sweepDepsFor(db, conn, pooled, entry));
  assert.equal(result.swept, false);
  assert.equal(result.reason, "CAP_EXHAUSTED");
});

test("11b: past the 12s delay, a mismatched on-chain delegate still blocks the sweep", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  seedPrice(db, entry.mint, 1.0);

  const { clientId, tokenAccount, authorizationId } = await authorizeSpl(db, conn, client, pooled, entry, 100_000_000n, 1_000_000n * 10n ** BigInt(entry.decimals));
  backdateAuthorization(db, authorizationId, 12);

  const acct = conn.getTokenAccountState(tokenAccount)!;
  conn.setTokenAccount(tokenAccount, { ...acct, delegate: Keypair.generate().publicKey });

  const row = getAuthorization(db, clientId, entry.mint)!;
  const result = await sweepAsset(row, await sweepDepsFor(db, conn, pooled, entry));
  assert.equal(result.swept, false);
  assert.equal(result.reason, "NOT_DELEGATED_TO_POOLED_WALLET");
});

test("11c: the delay is disclosed to the frontend via real backend-computed values, never left for the client to guess", async () => {
  const db = freshDb();
  const authorizedAt = new Date(Date.now() - 5000).toISOString();
  const eligibleAt = sweepEligibleAtIso(authorizedAt, 12);
  assert.equal(Date.parse(eligibleAt) - Date.parse(authorizedAt), 12000);
  assert.equal(isSweepDelayElapsed(authorizedAt, 12), false);
  void db;
});
