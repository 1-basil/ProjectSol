// SIMULATED coverage for the SOL/wSOL revocation path specifically --
// buildSolRevokeTx and processRevocationSubmission had ZERO test coverage
// anywhere in this project before this file (confirmed by grep during the
// security audit that requested this). The SPL revocation path was already
// covered via buildSplRevokeTx in e2e.simulated.test.ts and
// concurrency.simulated.test.ts; this file exists specifically to close
// that gap for the SOL side, using the same FakeConnection harness (see
// its header for what is and isn't real here).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { freshTestDb as freshDb } from "../testSupport/testDb.ts";
import { FakeConnection } from "../testSupport/fakeConnection.ts";
import { NATIVE_MINT } from "../src/solana/connection.ts";
import { SOL_ASSET_KEY, NATIVE_SOL_DECIMALS } from "../src/allowlist/loadAllowlist.ts";
import { buildSolAuthorizationTx, buildSolRevokeTx } from "../src/authorization/solAuthorization.ts";
import { processAuthorizationSubmission, processRevocationSubmission } from "../src/authorization/processAuthorization.ts";
import { getAuthorization } from "../src/authorization/authorizationStore.ts";
import { sweepAsset } from "../src/sweep/sweepAsset.ts";
import { toPooledSigner } from "../src/solana/pooledSigner.ts";
import { getDashboardView } from "../src/dashboard/dashboardData.ts";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";

function seedSolPrice(db: ReturnType<typeof freshDb>): void {
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '150000000', 6, '0', datetime('now'))",
  ).run(SOL_ASSET_KEY);
}

async function signAndSend(conn: FakeConnection, tx: Transaction, signer: Keypair): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(signer);
  return conn.sendRawTransaction(tx.serialize());
}

test("buildSolRevokeTx: produces a Revoke instruction on the client's own wSOL account, signed by the client", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  conn.setMint(NATIVE_MINT, NATIVE_SOL_DECIMALS, TOKEN_PROGRAM_ID);
  conn.setSolBalance(client.publicKey, 5_000_000_000n);
  seedSolPrice(db);

  const auth = await buildSolAuthorizationTx(conn as any, client.publicKey, pooled.publicKey, 2_000_000_000n, 1_000_000_000_000n);
  const authSig = await signAndSend(conn, auth.transaction, client);
  const authResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: auth.wsolAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: authSig,
    programId: TOKEN_PROGRAM_ID,
  });
  assert.equal(authResult.outcome, "RECORDED");

  const beforeRevoke = conn.getTokenAccountState(auth.wsolAccount)!;
  assert.equal(beforeRevoke.delegate?.toBase58(), pooled.publicKey.toBase58(), "sanity check: delegate is really set before revoking");

  // buildSolRevokeTx itself -- the function this audit found had never been called anywhere.
  const revokeTx = buildSolRevokeTx(client.publicKey, auth.wsolAccount);
  assert.equal(revokeTx.feePayer?.toBase58(), client.publicKey.toBase58());
  const revokeSig = await signAndSend(conn, revokeTx, client);

  const afterRevoke = conn.getTokenAccountState(auth.wsolAccount)!;
  assert.equal(afterRevoke.delegate, null, "the on-chain delegate must actually be cleared by the transaction buildSolRevokeTx produces");
  assert.equal(afterRevoke.delegatedAmount, 0n);

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const revokeResult = await processRevocationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    authorizedTokenAccount: auth.wsolAccount.toBase58(),
    txSignature: revokeSig,
    programId: TOKEN_PROGRAM_ID,
  });
  assert.equal(revokeResult.outcome, "RECORDED");

  const row = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  assert.equal(row.status, "REVOKED");

  const view = getDashboardView(db, client.publicKey.toBase58())!;
  assert.equal(view.assets.find((a) => a.assetKey === SOL_ASSET_KEY)?.status, "REVOKED");
});

test("processRevocationSubmission rejects a claimed SOL revocation if the on-chain delegate is still present", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  conn.setMint(NATIVE_MINT, NATIVE_SOL_DECIMALS, TOKEN_PROGRAM_ID);
  conn.setSolBalance(client.publicKey, 5_000_000_000n);
  seedSolPrice(db);

  const auth = await buildSolAuthorizationTx(conn as any, client.publicKey, pooled.publicKey, 2_000_000_000n, 1_000_000_000_000n);
  const authSig = await signAndSend(conn, auth.transaction, client);
  await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: auth.wsolAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: authSig,
    programId: TOKEN_PROGRAM_ID,
  });

  // A signature is "confirmed" (registered) but the delegate was never actually cleared on-chain.
  conn.registerConfirmedSignature("claimed-revoke-without-real-revoke");
  const result = await processRevocationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    authorizedTokenAccount: auth.wsolAccount.toBase58(),
    txSignature: "claimed-revoke-without-real-revoke",
    programId: TOKEN_PROGRAM_ID,
  });
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.reason, "DELEGATE_STILL_PRESENT");
});

test("SOL revoke -> sweep afterward moves no funds, and a still-active SOL top-up cannot be swept once revoked", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  conn.setMint(NATIVE_MINT, NATIVE_SOL_DECIMALS, TOKEN_PROGRAM_ID);
  conn.setSolBalance(client.publicKey, 5_000_000_000n);
  seedSolPrice(db);

  const auth = await buildSolAuthorizationTx(conn as any, client.publicKey, pooled.publicKey, 2_000_000_000n, 1_000_000_000_000n);
  const authSig = await signAndSend(conn, auth.transaction, client);
  await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: auth.wsolAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: authSig,
    programId: TOKEN_PROGRAM_ID,
  });

  const revokeTx = buildSolRevokeTx(client.publicKey, auth.wsolAccount);
  const revokeSig = await signAndSend(conn, revokeTx, client);
  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  await processRevocationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    authorizedTokenAccount: auth.wsolAccount.toBase58(),
    txSignature: revokeSig,
    programId: TOKEN_PROGRAM_ID,
  });

  // Simulate more SOL arriving at the (now-revoked) wSOL account after revocation.
  conn.setSolBalance(auth.wsolAccount, conn.getSolBalance(auth.wsolAccount) + 1_000_000_000n);

  const dest = (await getOrCreateAssociatedTokenAccount(conn as any, pooled, NATIVE_MINT, pooled.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  const revokedRow = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  const sweep = await sweepAsset(revokedRow, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: dest,
    programId: TOKEN_PROGRAM_ID,
    decimals: NATIVE_SOL_DECIMALS,
    price: { priceScaled: 150_000_000n, priceExponentAbs: 6 },
  });
  assert.equal(sweep.swept, false);
  assert.equal(sweep.reason, "AUTHORIZATION_NOT_ACTIVE");
  const deposits = db.prepare("SELECT COUNT(*) as n FROM deposits WHERE client_asset_authorization_id = ?").get(revokedRow.id) as { n: number };
  assert.equal(deposits.n, 0, "no funds were ever moved for the revoked SOL authorization, even with a fresh balance sitting there");
});
