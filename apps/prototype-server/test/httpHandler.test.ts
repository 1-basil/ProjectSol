// HTTP-level tests: exercises the REAL createServer + createHttpHandler
// wiring (the same code server.ts composes at startup), over real HTTP
// requests to an ephemeral local port, with only the Solana RPC connection
// swapped for FakeConnection (see testSupport/fakeConnection.ts's header
// for what that does and doesn't simulate). Before this file, server.ts
// had zero test coverage of any kind -- every other test in this suite
// calls the underlying functions (processAuthorizationSubmission,
// sweepAsset, ...) directly, never through the actual HTTP request path a
// real client hits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { DatabaseSync } from "node:sqlite";

import { freshTestDb as freshDb } from "../testSupport/testDb.ts";
import { FakeConnection } from "../testSupport/fakeConnection.ts";
import { createHttpHandler } from "../src/httpHandler.ts";
import { loadAllowlist, SOL_ASSET_KEY, type AllowlistEntry } from "../src/allowlist/loadAllowlist.ts";
import { buildSplAuthorizationTx, tokenProgramIdFor } from "../src/authorization/splAuthorization.ts";
import { getAuthorization } from "../src/authorization/authorizationStore.ts";

function findEntry(symbol: string): AllowlistEntry {
  const e = loadAllowlist().find((x) => x.symbol === symbol);
  if (!e) throw new Error(`fixture setup: allowlist entry ${symbol} not found`);
  return e;
}

interface Server {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startServer(db: DatabaseSync, conn: FakeConnection, pooled: Keypair): Promise<Server> {
  const handler = createHttpHandler({ connection: conn as any, db, pooledWallet: pooled });
  const httpServer = createServer(handler);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        // fetch()'s underlying client keeps connections alive by default,
        // which would otherwise make server.close() wait indefinitely for
        // a socket that's never going to close itself within the test.
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

async function signAndSend(conn: FakeConnection, tx: Transaction, signer: Keypair): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(signer);
  return conn.sendRawTransaction(tx.serialize());
}

/** Sets up a real, confirmed Approve on a real token account, delegated to `actualDelegate` (which may or may not be the "real" pooled wallet, depending on the test). */
async function setUpApprovedTokenAccount(
  conn: FakeConnection,
  client: Keypair,
  actualDelegate: PublicKey,
  entry: AllowlistEntry,
): Promise<{ tokenAccount: PublicKey; txSignature: string }> {
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 100_000_000n, delegate: null, delegatedAmount: 0n, programId });
  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, actualDelegate, 1_000_000n * 10n ** BigInt(entry.decimals));
  const sig = await signAndSend(conn, built.transaction, client);
  return { tokenAccount: built.tokenAccount, txSignature: sig };
}

test("HTTP regression (Category C fix): a client-supplied expectedDelegate cannot become the recorded authorization delegate", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const realPooledWallet = Keypair.generate();
  const attackerWallet = Keypair.generate(); // NOT the configured pooled wallet
  const entry = findEntry("USDT");

  // The client's real, on-chain Approve genuinely delegates to the REAL pooled wallet.
  const { tokenAccount, txSignature } = await setUpApprovedTokenAccount(conn, client, realPooledWallet.publicKey, entry);

  const server = await startServer(db, conn, realPooledWallet);
  try {
    const res = await fetch(`${server.baseUrl}/api/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletPubkey: client.publicKey.toBase58(),
        assetKey: entry.mint,
        tokenProgram: entry.token_program,
        authorizedTokenAccount: tokenAccount.toBase58(),
        // The attacker/malicious client tries to smuggle a different
        // delegate into the request body, hoping the server trusts it.
        expectedDelegate: attackerWallet.publicKey.toBase58(),
        txSignature,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.outcome, "RECORDED", "the real on-chain delegate (the real pooled wallet) is what's checked, regardless of the body's claim");

    const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
    const row = getAuthorization(db, clientId, entry.mint)!;
    assert.equal(row.delegate, realPooledWallet.publicKey.toBase58(), "the recorded delegate must be the server's real pooled wallet");
    assert.notEqual(row.delegate, attackerWallet.publicKey.toBase58(), "the attacker-supplied expectedDelegate must never end up as the recorded delegate");
  } finally {
    await server.close();
  }
});

test("HTTP regression: if the on-chain delegate is NOT the real pooled wallet, authorization is rejected even if the client's claimed expectedDelegate matches the (wrong) on-chain delegate", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const realPooledWallet = Keypair.generate();
  const attackerWallet = Keypair.generate();
  const entry = findEntry("USDC");

  // The client's real, on-chain Approve delegates to the ATTACKER, not the real pooled wallet.
  const { tokenAccount, txSignature } = await setUpApprovedTokenAccount(conn, client, attackerWallet.publicKey, entry);

  const server = await startServer(db, conn, realPooledWallet);
  try {
    const res = await fetch(`${server.baseUrl}/api/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletPubkey: client.publicKey.toBase58(),
        assetKey: entry.mint,
        tokenProgram: entry.token_program,
        authorizedTokenAccount: tokenAccount.toBase58(),
        // Claiming the (wrong, attacker) delegate as "expected" does not help --
        // the server never reads this field.
        expectedDelegate: attackerWallet.publicKey.toBase58(),
        txSignature,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.outcome, "REJECTED");
    assert.equal(body.reason, "DELEGATE_MISMATCH");

    const clientRow = db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58());
    assert.equal(clientRow, undefined, "no client or authorization row should be created for a rejected submission");
  } finally {
    await server.close();
  }
});

test("HTTP: POST /api/authorize rejects a non-allowlisted asset (ASSET_NOT_ALLOWLISTED), proven through the real endpoint", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();

  // A real, validly-approved token account for a mint that is NOT on the allowlist.
  const programId = TOKEN_PROGRAM_ID;
  const bogusMint = Keypair.generate().publicKey;
  conn.setMint(bogusMint, 6, programId);
  const ata = await getAssociatedTokenAddress(bogusMint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint: bogusMint, owner: client.publicKey, amount: 100_000_000n, delegate: null, delegatedAmount: 0n, programId });
  const { createApproveInstruction } = await import("@solana/spl-token");
  const tx = new Transaction().add(createApproveInstruction(ata, pooled.publicKey, client.publicKey, 1_000_000_000n, [], programId));
  tx.feePayer = client.publicKey;
  const sig = await signAndSend(conn, tx, client);

  const server = await startServer(db, conn, pooled);
  try {
    const res = await fetch(`${server.baseUrl}/api/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletPubkey: client.publicKey.toBase58(),
        assetKey: bogusMint.toBase58(),
        tokenProgram: "SPL_TOKEN",
        authorizedTokenAccount: ata.toBase58(),
        expectedDelegate: pooled.publicKey.toBase58(), // even the "correct" value here doesn't matter -- see prior tests
        txSignature: sig,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.outcome, "REJECTED");
    assert.equal(body.reason, "ASSET_NOT_ALLOWLISTED");
  } finally {
    await server.close();
  }
});

test("HTTP: full authorize -> dashboard -> revoke -> dashboard round trip through the real endpoints", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");

  const { tokenAccount, txSignature } = await setUpApprovedTokenAccount(conn, client, pooled.publicKey, entry);
  const server = await startServer(db, conn, pooled);
  try {
    const configRes = await fetch(`${server.baseUrl}/api/config`);
    const config = await configRes.json();
    assert.equal(config.pooledWalletPubkey, pooled.publicKey.toBase58());

    const allowlistRes = await fetch(`${server.baseUrl}/api/allowlist`);
    const allowlistBody = await allowlistRes.json();
    assert.equal(allowlistBody.sol, SOL_ASSET_KEY);
    assert.equal(allowlistBody.splTokens.length, 395);

    const authRes = await fetch(`${server.baseUrl}/api/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletPubkey: client.publicKey.toBase58(),
        assetKey: entry.mint,
        tokenProgram: entry.token_program,
        authorizedTokenAccount: tokenAccount.toBase58(),
        expectedDelegate: pooled.publicKey.toBase58(),
        txSignature,
      }),
    });
    assert.equal(authRes.status, 200);
    const authBody = await authRes.json();
    assert.equal(authBody.outcome, "RECORDED");

    const dashRes = await fetch(`${server.baseUrl}/api/dashboard?wallet=${client.publicKey.toBase58()}`);
    assert.equal(dashRes.status, 200);
    const dash = await dashRes.json();
    assert.equal(dash.assets.find((a: any) => a.assetKey === entry.mint)?.status, "ACTIVE");

    // Revoke: clear the on-chain delegate for real, then submit through the endpoint.
    const { createRevokeInstruction } = await import("@solana/spl-token");
    const revokeTx = new Transaction().add(createRevokeInstruction(tokenAccount, client.publicKey, [], tokenProgramIdFor(entry)));
    revokeTx.feePayer = client.publicKey;
    const revokeSig = await signAndSend(conn, revokeTx, client);

    const revokeRes = await fetch(`${server.baseUrl}/api/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletPubkey: client.publicKey.toBase58(),
        assetKey: entry.mint,
        authorizedTokenAccount: tokenAccount.toBase58(),
        txSignature: revokeSig,
      }),
    });
    assert.equal(revokeRes.status, 200);
    const revokeBody = await revokeRes.json();
    assert.equal(revokeBody.outcome, "RECORDED");

    const dashAfterRevoke = await (await fetch(`${server.baseUrl}/api/dashboard?wallet=${client.publicKey.toBase58()}`)).json();
    assert.equal(dashAfterRevoke.assets.find((a: any) => a.assetKey === entry.mint)?.status, "REVOKED");
  } finally {
    await server.close();
  }
});

test("HTTP: OPTIONS preflight and unknown routes behave correctly", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const pooled = Keypair.generate();
  const server = await startServer(db, conn, pooled);
  try {
    const optionsRes = await fetch(`${server.baseUrl}/api/authorize`, { method: "OPTIONS" });
    assert.equal(optionsRes.status, 204);
    assert.equal(optionsRes.headers.get("access-control-allow-origin"), "*");

    const notFoundRes = await fetch(`${server.baseUrl}/api/does-not-exist`);
    assert.equal(notFoundRes.status, 404);
  } finally {
    await server.close();
  }
});
