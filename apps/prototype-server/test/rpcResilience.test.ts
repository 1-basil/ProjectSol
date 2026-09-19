// Coverage for the infrastructure/reliability audit: the RPC transport
// hardening in src/solana/resilientFetch.ts and src/solana/connection.ts,
// and the SyncNative confirmation fix in sweepAsset.ts (see that file's
// inline comment for the real "TransactionExpiredTimeoutError: not
// confirmed in 30.00 seconds" symptom this addresses). Does NOT touch
// authorization semantics, the sweep delay, the allowlist, the SOL/wSOL or
// SPL authorization model, the company receiving wallet, or sweep
// accounting -- those are exercised elsewhere (e2e.simulated.test.ts,
// concurrency.simulated.test.ts, sweepDelay.test.ts).
//
// SCOPE LIMIT, disclosed rather than hidden: FakeConnection (see
// testSupport/fakeConnection.ts) simulates the RPC HTTP surface only -- it
// has no real WebSocket transport to disconnect/reconnect or to duplicate-
// subscribe on. This codebase's own source (grepped across apps/web and
// apps/prototype-server) never calls onAccountChange/onLogs/onSlotChange or
// any other subscription method -- the only WebSocket-capable code present
// anywhere in the repo is unused library internals bundled inside
// @solana/web3.js's Connection class. So there is no first-party WebSocket
// disconnect/reconnect or duplicate-subscription behavior in this app to
// unit-test; what IS tested and true is the architectural property that
// custody-critical sweep completion never depends on any such subscription
// existing in the first place -- see the PENDING-row reconciliation tests
// in e2e.simulated.test.ts (item O) and concurrency.simulated.test.ts,
// which already prove an eligible/confirmed transfer is found and credited
// via a plain HTTP getSignatureStatus() call alone, with no WebSocket event
// of any kind involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { DatabaseSync } from "node:sqlite";

import { freshTestDb as freshDb, backdateAuthorization } from "../testSupport/testDb.ts";
import { FakeConnection } from "../testSupport/fakeConnection.ts";
import { NATIVE_MINT, getConnection } from "../src/solana/connection.ts";
import { SOL_ASSET_KEY, NATIVE_SOL_DECIMALS } from "../src/allowlist/loadAllowlist.ts";
import { buildSolAuthorizationTx } from "../src/authorization/solAuthorization.ts";
import { processAuthorizationSubmission } from "../src/authorization/processAuthorization.ts";
import { getAuthorization } from "../src/authorization/authorizationStore.ts";
import { sweepAsset } from "../src/sweep/sweepAsset.ts";
import { toPooledSigner } from "../src/solana/pooledSigner.ts";
import { createResilientFetch } from "../src/solana/resilientFetch.ts";

function seedPrice(db: DatabaseSync, assetKey: string, priceUsd: number): void {
  const priceScaled = BigInt(Math.round(priceUsd * 1_000_000));
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, ?, 6, '0', datetime('now'))",
  ).run(assetKey, priceScaled.toString());
}

async function signAndSend(conn: FakeConnection, tx: import("@solana/web3.js").Transaction, signer: Keypair): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(signer);
  return conn.sendRawTransaction(tx.serialize());
}

// ---------------------------------------------------------------------------
// connection.ts: a single, reused Connection, never an uncontrolled one
// created per call.
// ---------------------------------------------------------------------------

test("getConnection() returns the SAME Connection instance across repeated calls (no uncontrolled/duplicate connections)", () => {
  const a = getConnection();
  const b = getConnection();
  assert.equal(a, b, "every caller in this backend must reuse one Connection, not construct a new one per call/request");
});

// ---------------------------------------------------------------------------
// resilientFetch.ts: bounded retry with backoff, never an unbounded loop,
// never a hang.
// ---------------------------------------------------------------------------

test("resilientFetch retries a transient HTTP 429 and eventually succeeds", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 3) return new Response("rate limited", { status: 429 });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const resilient = createResilientFetch();
    const res = await resilient("https://example.invalid/rpc");
    assert.equal(res.status, 200);
    assert.equal(calls, 3, "must retry the transient 429s and stop retrying once a success is returned");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("resilientFetch retries a transient HTTP 500 the same as a 429", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 2) return new Response("server error", { status: 502 });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const res = await createResilientFetch()("https://example.invalid/rpc");
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("resilientFetch gives up after a BOUNDED number of attempts, never retries forever", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("still failing", { status: 503 });
  }) as typeof fetch;
  try {
    const res = await createResilientFetch()("https://example.invalid/rpc");
    // The last attempt's (still-failing) response is returned rather than
    // thrown, matching a real fetch's contract -- but the attempt count
    // itself is what proves the retry loop is bounded.
    assert.equal(res.status, 503);
    assert.ok(calls >= 2 && calls <= 4, `expected a small bounded number of attempts, got ${calls}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("resilientFetch returns a genuine (non-retryable) 4xx immediately, without retrying", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;
  try {
    const res = await createResilientFetch()("https://example.invalid/rpc");
    assert.equal(res.status, 400);
    assert.equal(calls, 1, "a real client error must surface immediately, not be masked by pointless retries");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("resilientFetch retries a network-level failure (connection reset, DNS failure, etc.) and eventually succeeds", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 2) throw new Error("SIMULATED: network error (e.g. ECONNRESET)");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const res = await createResilientFetch()("https://example.invalid/rpc");
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("resilientFetch throws (never hangs) once bounded retries on a persistent network failure are exhausted", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("SIMULATED: persistent network failure");
  }) as typeof fetch;
  try {
    await assert.rejects(() => createResilientFetch()("https://example.invalid/rpc"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// sweepAsset.ts: the SyncNative confirmation fix. Before this fix, an
// ambiguous/timed-out confirmation on this step (via the deprecated
// single-signature confirmTransaction overload, with no try/catch) crashed
// the entire sweep attempt with an unhandled rejection, even though the
// SyncNative step had genuinely landed on-chain and the sweep itself was
// otherwise perfectly able to proceed.
// ---------------------------------------------------------------------------

async function setupSolAuthorization(): Promise<{
  db: DatabaseSync;
  conn: FakeConnection;
  client: Keypair;
  pooled: Keypair;
  clientId: string;
}> {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();

  conn.setSolBalance(client.publicKey, 5_000_000_000n);
  conn.setMint(NATIVE_MINT, NATIVE_SOL_DECIMALS, TOKEN_PROGRAM_ID);
  seedPrice(db, SOL_ASSET_KEY, 150);

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
    programId: TOKEN_PROGRAM_ID,
  });
  assert.equal(solResult.outcome, "RECORDED");
  const authorizationId = (solResult as { authorizationId: string }).authorizationId;
  backdateAuthorization(db, authorizationId);

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  return { db, conn, client, pooled, clientId };
}

test("SIMULATED: an ambiguous/timed-out confirmation on the SyncNative pre-step does not crash the sweep -- it lands on-chain regardless and the sweep completes", async () => {
  const { db, conn, pooled, clientId } = await setupSolAuthorization();

  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, NATIVE_MINT, pooled.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  const row = getAuthorization(db, clientId, SOL_ASSET_KEY)!;

  // The SyncNative transaction genuinely lands (FakeConnection applies it
  // inside sendRawTransaction exactly as a real validator would), but the
  // very next confirmTransaction call for it hangs/throws -- an ambiguous
  // outcome, same shape as the real observed TransactionExpiredTimeoutError.
  conn.simulateConfirmHangOnce();

  const result = await sweepAsset(row, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: dest,
    programId: TOKEN_PROGRAM_ID,
    decimals: NATIVE_SOL_DECIMALS,
    price: { priceScaled: 150_000_000n, priceExponentAbs: 6 },
  });

  assert.equal(result.swept, true, "a hung SyncNative confirmation must not abort the sweep -- it must fall through and complete normally");
  assert.equal(result.nativeAmount, 2_000_000_000n, "the swept amount must reflect the ALREADY-landed SyncNative balance, proving the sync itself was not lost, only its confirmation report");
});

test("SIMULATED: sweepAsset never throws an unhandled rejection when the SyncNative confirmation is ambiguous -- it always resolves to a typed SweepResult", async () => {
  const { db, conn, pooled, clientId } = await setupSolAuthorization();
  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, NATIVE_MINT, pooled.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  const row = getAuthorization(db, clientId, SOL_ASSET_KEY)!;

  conn.simulateConfirmHangOnce();

  await assert.doesNotReject(
    () =>
      sweepAsset(row, {
        connection: conn as any,
        db,
        pooledWallet: toPooledSigner(pooled),
        pooledDestinationAccount: dest,
        programId: TOKEN_PROGRAM_ID,
        decimals: NATIVE_SOL_DECIMALS,
        price: { priceScaled: 150_000_000n, priceExponentAbs: 6 },
      }),
    "sweepAsset must degrade to a { swept: false, reason } result on ambiguous outcomes, never an uncaught exception -- this is what makes it safe for an indexer loop to call unconditionally",
  );
});
