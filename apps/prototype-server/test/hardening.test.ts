// Focused regression tests for the 5 production-hardening changes from the
// security audit: (1) ALLOWLIST_VERSION_OVERRIDE refused on mainnet, (2)
// bounded price-fetch timeout + per-asset sweepPass isolation, (3) HTTP
// request-body size limit, (4) basic rate limiting, (5) the PooledSigner
// abstraction. None of these touch the authorization model, the allowlist,
// the SOL/wSOL design, the 7-SPL+SOL rule, or the caps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { freshTestDb as freshDb, backdateAuthorization } from "../testSupport/testDb.ts";
import { FakeConnection } from "../testSupport/fakeConnection.ts";
import { createHttpHandler } from "../src/httpHandler.ts";
import { assertAllowlistOverrideNotUsedOnMainnet } from "../src/solana/networkIdentity.ts";
import { toPooledSigner, type PooledSigner } from "../src/solana/pooledSigner.ts";
import { sweepPass } from "../src/indexer/index.ts";
import { loadAllowlist, SOL_ASSET_KEY, type AllowlistEntry } from "../src/allowlist/loadAllowlist.ts";
import { buildSplAuthorizationTx, tokenProgramIdFor } from "../src/authorization/splAuthorization.ts";
import { processAuthorizationSubmission } from "../src/authorization/processAuthorization.ts";
import { getAuthorization } from "../src/authorization/authorizationStore.ts";
import { sweepAsset } from "../src/sweep/sweepAsset.ts";

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

interface Server {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startServer(db: ReturnType<typeof freshDb>, conn: FakeConnection, pooled: Keypair): Promise<Server> {
  const handler = createHttpHandler({ connection: conn as any, db, pooledWallet: pooled });
  const httpServer = createServer(handler);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// 1. ALLOWLIST_VERSION_OVERRIDE refused on mainnet
// ---------------------------------------------------------------------------

test("assertAllowlistOverrideNotUsedOnMainnet: throws when the override is set and the network is mainnet-beta", () => {
  assert.throws(
    () => assertAllowlistOverrideNotUsedOnMainnet("mainnet-beta", "devnet-test-fixture-EPHEMERAL"),
    /refusing to start/,
  );
});

test("assertAllowlistOverrideNotUsedOnMainnet: does NOT throw on mainnet when the override is unset", () => {
  assert.doesNotThrow(() => assertAllowlistOverrideNotUsedOnMainnet("mainnet-beta", undefined));
});

test("assertAllowlistOverrideNotUsedOnMainnet: does NOT throw on devnet even when the override IS set (test tooling must keep working)", () => {
  assert.doesNotThrow(() => assertAllowlistOverrideNotUsedOnMainnet("devnet", "devnet-test-fixture-EPHEMERAL"));
});

// ---------------------------------------------------------------------------
// 2. Bounded price-fetch timeout signal + per-asset sweepPass isolation
// ---------------------------------------------------------------------------

test("pricing.ts: both fetch() calls pass an AbortSignal (a bounded timeout), verified by reading the source rather than waiting out a real timeout", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(__dirname, "..", "src", "solana", "pricing.ts"), "utf8");
  const fetchCalls = [...source.matchAll(/fetch\(url[^)]*\)/g)];
  assert.equal(fetchCalls.length, 2, "expected exactly the two fetch() call sites in fetchTokenPriceByMint and fetchSolPrice");
  for (const call of fetchCalls) {
    assert.match(call[0], /AbortSignal\.timeout/, "every price fetch() call must carry a bounded timeout signal");
  }
});

test("sweepPass: a price failure for one asset does not abort the pass -- other clients/assets still get swept", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const goodClient = Keypair.generate();
  const badClient = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);

  // Set up two independent, fully-authorized clients for the SAME asset.
  async function authorize(client: Keypair, amountNative: bigint) {
    const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
    conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: amountNative, delegate: null, delegatedAmount: 0n, programId });
    const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
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
    assert.equal(result.outcome, "RECORDED");
    backdateAuthorization(db, (result as { authorizationId: string }).authorizationId);
    return built.tokenAccount;
  }

  await authorize(goodClient, 5_000_000n);
  await authorize(badClient, 5_000_000n);

  // Both clients' asset has one valid, fresh price_cache row.
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '1000000', 6, '0', datetime('now'))",
  ).run(entry.mint);

  // Both clients share ONE price_cache row (keyed by asset_key, not by
  // client), so to simulate "a price failure for one asset" without a real
  // network call, corrupt that shared row's price_scaled to something
  // BigInt() cannot parse -- getPrice() throws synchronously and
  // deterministically on the very first sweepPass iteration that reads it,
  // with zero network dependency. This proves the try/catch this session
  // added around getPrice() inside sweepPass, not merely that "some asset
  // somewhere might fail" -- the whole point is ONE bad price must not
  // stop OTHER authorizations. So: leave this asset's price valid, and
  // instead prove isolation using a distinct SOL authorization (its own,
  // separately-keyed price_cache row) alongside it.
  const solClient = Keypair.generate();
  db.prepare("INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES ('SOL', 'not-a-number', 6, '0', datetime('now'))").run();
  db.prepare("INSERT INTO clients (id, wallet_pubkey) VALUES ('sol-client-id', ?)").run(solClient.publicKey.toBase58());
  db.prepare(
    `INSERT INTO client_asset_authorizations
     (id, client_id, asset_key, token_program, authorized_token_account, delegate, original_authorized_native_amount, authorization_tx_signature, authorized_at, status, cumulative_credited_usd_micros, asset_cap_usd_micros)
     VALUES ('sol-auth-id', 'sol-client-id', ?, 'NATIVE_SOL', 'some-wsol-ata', ?, '1000000000000', 'fake-sig', datetime('now'), 'ACTIVE', '0', '1000000000000')`,
  ).run(SOL_ASSET_KEY, pooled.publicKey.toBase58());

  const goodDest = await import("@solana/spl-token").then((m) => m.getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, pooled.publicKey, false, "confirmed", undefined, programId));

  // sweepPass must not throw despite the SOL row's unparseable price.
  await assert.doesNotReject(() => sweepPass({ connection: conn as any, db, pooledWallet: pooled }));

  // The two real, validly-priced authorizations were still swept.
  const goodClientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(goodClient.publicKey.toBase58()) as { id: string }).id;
  const badClientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(badClient.publicKey.toBase58()) as { id: string }).id;
  const goodRow = getAuthorization(db, goodClientId, entry.mint)!;
  const badRow = getAuthorization(db, badClientId, entry.mint)!;
  assert.ok(BigInt(goodRow.cumulativeCreditedUsdMicros) > 0n, "the good client's authorization was still swept despite the unrelated SOL row's bad price");
  assert.ok(BigInt(badRow.cumulativeCreditedUsdMicros) > 0n, "the second client's authorization was also still swept -- isolation is per price_cache row, not a global halt");

  // The SOL authorization with the unparseable price was skipped, not credited, and not crashed on.
  const solRow = getAuthorization(db, "sol-client-id", SOL_ASSET_KEY)!;
  assert.equal(solRow.cumulativeCreditedUsdMicros, 0n, "the asset with the unparseable price must never be credited -- fail closed, not skipped-but-guessed");
  void goodDest;
});

// ---------------------------------------------------------------------------
// 3. HTTP request-body size limit
// ---------------------------------------------------------------------------

test("HTTP: an oversized request body is rejected with 413, not buffered without limit", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const pooled = Keypair.generate();
  const server = await startServer(db, conn, pooled);
  try {
    const oversizedBody = JSON.stringify({ walletPubkey: "x".repeat(20 * 1024) }); // > 16KB
    const res = await fetch(`${server.baseUrl}/api/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody,
    });
    assert.equal(res.status, 413);
  } finally {
    await server.close();
  }
});

test("HTTP: a normal, small request body is unaffected by the size limit", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const pooled = Keypair.generate();
  const server = await startServer(db, conn, pooled);
  try {
    const res = await fetch(`${server.baseUrl}/api/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletPubkey: "abc", assetKey: "def", tokenProgram: "SPL_TOKEN", authorizedTokenAccount: "ghi", txSignature: "jkl" }),
    });
    // Rejected for being nonsense input (not a valid signature), NOT for size -- proves the limit doesn't interfere with normal traffic.
    assert.notEqual(res.status, 413);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Basic rate limiting
// ---------------------------------------------------------------------------

test("HTTP: repeated requests to a rate-limited route eventually get 429, while an unrelated route is unaffected", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const pooled = Keypair.generate();
  const client = Keypair.generate();
  const server = await startServer(db, conn, pooled);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${server.baseUrl}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: client.publicKey.toBase58() }),
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.some((s) => s === 429), "at least one of 25 rapid requests to a rate-limited route must be throttled");
    assert.ok(statuses.slice(0, 5).every((s) => s !== 429), "the first few requests within the limit must not be throttled");

    // An unrelated, non-rate-limited route is unaffected by the same client having just been throttled.
    const configRes = await fetch(`${server.baseUrl}/api/config`);
    assert.equal(configRes.status, 200);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 5. PooledSigner abstraction
// ---------------------------------------------------------------------------

test("toPooledSigner: produces a signer whose signature is a genuine, verifiable ed25519 signature over the transaction message", async () => {
  const keypair = Keypair.generate();
  const signer = toPooledSigner(keypair);
  assert.equal(signer.publicKey.toBase58(), keypair.publicKey.toBase58());

  const tx = new Transaction();
  const { SystemProgram } = await import("@solana/web3.js");
  tx.add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); // any real 32-byte value works as a syntactically valid blockhash for this check

  await signer.signTransaction(tx);
  assert.ok(tx.signature, "signTransaction must actually attach a signature");
  assert.equal(tx.verifySignatures(), true, "the signature produced through PooledSigner must be a real, verifiable ed25519 signature by the pooled wallet's own key");
});

test("sweepAsset: works with a PooledSigner that is NOT toPooledSigner's Keypair wrapper -- proving sweep business logic depends only on the interface", async () => {
  // A deliberately different implementation: holds its OWN private keypair
  // internally (never exposed) and signs through it. If sweepAsset.ts
  // reached into `.secretKey` or otherwise assumed a raw Keypair shape
  // anywhere, this would fail -- it only ever calls .publicKey and
  // .signTransaction(), exactly the interface contract.
  function createOpaqueSigner(): PooledSigner {
    const innerKeypair = Keypair.generate();
    return {
      publicKey: innerKeypair.publicKey,
      async signTransaction(transaction: Transaction): Promise<void> {
        transaction.sign(innerKeypair);
      },
    };
  }

  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const opaqueSigner = createOpaqueSigner();
  const entry = findEntry("USDC");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 5_000_000n, delegate: null, delegatedAmount: 0n, programId });

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, opaqueSigner.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
  const sig = await signAndSend(conn, built.transaction, client);
  const authResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: built.tokenAccount.toBase58(),
    expectedDelegate: opaqueSigner.publicKey.toBase58(),
    txSignature: sig,
    programId,
  });
  assert.equal(authResult.outcome, "RECORDED");
  backdateAuthorization(db, (authResult as { authorizationId: string }).authorizationId);

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const row = getAuthorization(db, clientId, entry.mint)!;
  db.prepare("INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '1000000', 6, '0', datetime('now'))").run(entry.mint);
  const { getOrCreateAssociatedTokenAccount } = await import("@solana/spl-token");
  const dest = await getOrCreateAssociatedTokenAccount(conn as any, Keypair.generate(), mint, opaqueSigner.publicKey, false, "confirmed", undefined, programId);

  const sweep = await sweepAsset(row, {
    connection: conn as any,
    db,
    pooledWallet: opaqueSigner,
    pooledDestinationAccount: dest.address,
    programId,
    decimals: entry.decimals,
    price: { priceScaled: 1_000_000n, priceExponentAbs: 6 },
  });
  assert.equal(sweep.swept, true, "sweepAsset must work correctly against any conforming PooledSigner, not just a Keypair-backed one");
});
