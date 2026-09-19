// Regression tests for the fixed company receiving wallet (see
// COMPANY_RECEIVING_WALLET in src/solana/companyReceivingWallet.ts): every
// legitimately swept deposit -- SOL or any SPL asset -- must land in a
// token account owned by this exact, fixed address, never the pooled
// (delegate/signer) wallet and never anything a client could influence.
// These tests drive the REAL indexer entry point (sweepPass), not
// sweepAsset directly, so they exercise the actual production code path
// that decides the destination. Deliberately does not hardcode the address
// itself -- that's asserted once, structurally, below -- so rotating the
// configured address never requires touching this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { freshTestDb as freshDb, backdateAuthorization } from "../testSupport/testDb.ts";
import { FakeConnection } from "../testSupport/fakeConnection.ts";
import { COMPANY_RECEIVING_WALLET } from "../src/solana/companyReceivingWallet.ts";
import { NATIVE_MINT } from "../src/solana/connection.ts";
import { SOL_ASSET_KEY, NATIVE_SOL_DECIMALS, loadAllowlist, type AllowlistEntry } from "../src/allowlist/loadAllowlist.ts";
import { buildSolAuthorizationTx } from "../src/authorization/solAuthorization.ts";
import { buildSplAuthorizationTx, tokenProgramIdFor } from "../src/authorization/splAuthorization.ts";
import { processAuthorizationSubmission } from "../src/authorization/processAuthorization.ts";
import { sweepPass } from "../src/indexer/index.ts";
import { assertDistinctFromPooledWallet } from "../src/solana/pooledWallet.ts";

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

test("COMPANY_RECEIVING_WALLET is a well-formed, non-default Solana address", () => {
  // Deliberately does not pin the current literal address -- rotation is a
  // legitimate, deliberate operational event (see the module's own
  // comment); the module simply failing to load already catches a
  // malformed value (invalid base58/length throws at import time). This
  // asserts the structural properties that must always hold regardless of
  // which specific address is configured.
  assert.ok(COMPANY_RECEIVING_WALLET instanceof PublicKey);
  assert.equal(COMPANY_RECEIVING_WALLET.toBuffer().length, 32);
  assert.notEqual(COMPANY_RECEIVING_WALLET.toBase58(), PublicKey.default.toBase58(), "must not be the all-zero default address");
});

test("sweepPass (the real indexer entry point) sends a real SPL sweep to the company receiving wallet, never the pooled wallet", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  conn.setSolBalance(pooled.publicKey, 1_000_000_000n); // pooled wallet pays for destination ATA creation

  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 25_000_000n, delegate: null, delegatedAmount: 0n, programId });
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '1000000', 6, '0', datetime('now'))",
  ).run(entry.mint);

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

  await sweepPass({ connection: conn as any, db, pooledWallet: pooled });

  const deposit = db.prepare("SELECT destination_account, status, native_amount FROM deposits WHERE asset_key = ?").get(entry.mint) as
    | { destination_account: string; status: string; native_amount: string }
    | undefined;
  assert.ok(deposit, "sweepPass must have actually recorded a deposit");
  assert.equal(deposit!.status, "CONFIRMED");
  assert.equal(deposit!.native_amount, "25000000");

  const expectedCompanyAta = await getAssociatedTokenAddress(mint, COMPANY_RECEIVING_WALLET, false, programId);
  assert.equal(deposit!.destination_account, expectedCompanyAta.toBase58(), "the recorded destination must be the company wallet's ATA");

  const pooledOwnedAta = await getAssociatedTokenAddress(mint, pooled.publicKey, false, programId);
  assert.notEqual(deposit!.destination_account, pooledOwnedAta.toBase58(), "the destination must NOT be owned by the pooled (delegate/signer) wallet");

  // Independently confirm on the fake ledger: the ATA that actually received the funds is owned by the company wallet.
  const destAccountState = await getAccount(conn as any, expectedCompanyAta, "confirmed", programId);
  assert.equal(destAccountState.owner.toBase58(), COMPANY_RECEIVING_WALLET.toBase58());
  assert.equal(destAccountState.amount, 25_000_000n);
});

test("sweepPass sends a real SOL sweep to the company receiving wallet's wSOL account, never the pooled wallet's", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  conn.setMint(NATIVE_MINT, NATIVE_SOL_DECIMALS, TOKEN_PROGRAM_ID);
  conn.setSolBalance(client.publicKey, 5_000_000_000n);
  conn.setSolBalance(pooled.publicKey, 1_000_000_000n);
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '150000000', 6, '0', datetime('now'))",
  ).run(SOL_ASSET_KEY);

  const solBuilt = await buildSolAuthorizationTx(conn as any, client.publicKey, pooled.publicKey, 2_000_000_000n, 1_000_000_000_000n);
  const authSig = await signAndSend(conn, solBuilt.transaction, client);
  const authResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: solBuilt.wsolAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: authSig,
    programId: TOKEN_PROGRAM_ID,
  });
  assert.equal(authResult.outcome, "RECORDED");
  backdateAuthorization(db, (authResult as { authorizationId: string }).authorizationId);

  await sweepPass({ connection: conn as any, db, pooledWallet: pooled });

  const deposit = db.prepare("SELECT destination_account, status, native_amount FROM deposits WHERE asset_key = ?").get(SOL_ASSET_KEY) as
    | { destination_account: string; status: string; native_amount: string }
    | undefined;
  assert.ok(deposit, "sweepPass must have actually recorded a SOL deposit");
  assert.equal(deposit!.status, "CONFIRMED");
  assert.equal(deposit!.native_amount, "2000000000");

  const expectedCompanyWsolAta = await getAssociatedTokenAddress(NATIVE_MINT, COMPANY_RECEIVING_WALLET);
  assert.equal(deposit!.destination_account, expectedCompanyWsolAta.toBase58());

  const pooledOwnedWsolAta = await getAssociatedTokenAddress(NATIVE_MINT, pooled.publicKey);
  assert.notEqual(deposit!.destination_account, pooledOwnedWsolAta.toBase58());
});

test("a client cannot override the sweep destination: neither the authorization submission body nor the stored authorization row can redirect funds away from the company wallet", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const attackerWallet = Keypair.generate(); // a wallet an attacker fully controls, hoping to redirect funds here
  const entry = findEntry("USDC");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  conn.setSolBalance(pooled.publicKey, 1_000_000_000n);

  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 5_000_000n, delegate: null, delegatedAmount: 0n, programId });
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '1000000', 6, '0', datetime('now'))",
  ).run(entry.mint);

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
  const sig = await signAndSend(conn, built.transaction, client);

  // processAuthorizationSubmission's input shape has no destination-style
  // field at all -- there is nothing here for an attacker to even supply.
  // This is asserted structurally: the real function signature/behavior is
  // exercised end to end below, and the resulting sweep still lands
  // exactly at the company wallet regardless of anything the caller passes.
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

  // Tamper with the STORED authorization row's delegate column (simulating
  // a compromised DB, or a bug elsewhere that let a client-influenced value
  // through) to point at an attacker-controlled wallet. sweepAsset never
  // trusts this column for its authority decision -- it re-derives from
  // the LIVE on-chain delegate (still genuinely `pooled`, untouched) and
  // the server's own configured pooled wallet -- so the sweep still
  // proceeds correctly. The point of this test is what happens to the
  // DESTINATION when it does: it must still be the company wallet,
  // completely unaffected by the tampered delegate column, because
  // sweepPass/sweepAsset never read any destination-like value from the
  // authorization row at all.
  db.prepare("UPDATE client_asset_authorizations SET delegate = ? WHERE asset_key = ?").run(attackerWallet.publicKey.toBase58(), entry.mint);

  await sweepPass({ connection: conn as any, db, pooledWallet: pooled });

  const deposit = db.prepare("SELECT destination_account FROM deposits WHERE asset_key = ?").get(entry.mint) as { destination_account: string } | undefined;
  assert.ok(deposit, "the sweep still succeeds -- authority comes from the live on-chain delegate + the server's own pooled wallet, never the DB column");

  const expectedCompanyAta = await getAssociatedTokenAddress(mint, COMPANY_RECEIVING_WALLET, false, programId);
  assert.equal(deposit!.destination_account, expectedCompanyAta.toBase58(), "the destination is still the company wallet even with a tampered delegate column");

  const attackerAta = await getAssociatedTokenAddress(mint, attackerWallet.publicKey, false, programId);
  const attackerState = conn.getTokenAccountState(attackerAta);
  assert.equal(attackerState, undefined, "the attacker's wallet never received anything, despite being written into the DB's delegate column");
});

// ---------------------------------------------------------------------------
// Invariant: COMPANY_RECEIVING_WALLET must never coincide with the pooled
// (delegate/signing) wallet -- see server.ts's startup call to
// assertDistinctFromPooledWallet, which this exercises directly.
// ---------------------------------------------------------------------------

test("assertDistinctFromPooledWallet: refuses to proceed if a pooled wallet were ever configured to be the same address as COMPANY_RECEIVING_WALLET", () => {
  assert.throws(
    () => assertDistinctFromPooledWallet(COMPANY_RECEIVING_WALLET, COMPANY_RECEIVING_WALLET, "COMPANY_RECEIVING_WALLET"),
    /must not equal the configured pooled wallet/,
  );
});

test("assertDistinctFromPooledWallet: does not throw for a real, distinct pooled wallet", () => {
  const somePooledWallet = Keypair.generate();
  assert.doesNotThrow(() => assertDistinctFromPooledWallet(somePooledWallet.publicKey, COMPANY_RECEIVING_WALLET, "COMPANY_RECEIVING_WALLET"));
});
