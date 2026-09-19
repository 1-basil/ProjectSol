// SIMULATED regression test for a real bug found while building the
// devnet proof of "one client signature authorizes SOL + up to 7 SPL
// assets": recordAuthorization's idempotency check was scoped only by
// tx_signature, not by (tx_signature, client, asset). Since a single
// transaction legitimately authorizes multiple different assets under one
// signature, the OLD code would record only the first asset processed
// under a given signature and silently treat every subsequent asset
// sharing that same signature as "ALREADY_PROCESSED" -- dropping it
// entirely. This is exactly the defining feature the devnet test proves,
// so it has to be correct here first, in a fast, deterministic simulation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { freshTestDb as freshDb } from "../testSupport/testDb.ts";
import { FakeConnection } from "../testSupport/fakeConnection.ts";
import { NATIVE_MINT } from "../src/solana/connection.ts";
import { SOL_ASSET_KEY, NATIVE_SOL_DECIMALS, loadAllowlist, type AllowlistEntry } from "../src/allowlist/loadAllowlist.ts";
import { buildSolAuthorizationTx } from "../src/authorization/solAuthorization.ts";
import { buildSplAuthorizationTx, tokenProgramIdFor } from "../src/authorization/splAuthorization.ts";
import { processAuthorizationSubmission } from "../src/authorization/processAuthorization.ts";
import { listActiveAuthorizations } from "../src/authorization/authorizationStore.ts";

function findEntry(symbol: string): AllowlistEntry {
  const e = loadAllowlist().find((x) => x.symbol === symbol);
  if (!e) throw new Error(`fixture setup: allowlist entry ${symbol} not found`);
  return e;
}

test("one shared tx_signature can legitimately authorize SOL + 7 different SPL assets -- none are dropped as false-positive replays of each other", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  conn.setMint(NATIVE_MINT, NATIVE_SOL_DECIMALS, TOKEN_PROGRAM_ID);
  conn.setSolBalance(client.publicKey, 5_000_000_000n);

  const splSymbols = ["USDT", "USDC", "USDS", "USDE", "USD1", "USDG", "PYUSD"];
  const entries = splSymbols.map(findEntry);

  // Build ALL instructions (SOL wrap+approve, plus 7 SPL approves) into one
  // combined Transaction, exactly mirroring what the devnet harness does.
  const solBuilt = await buildSolAuthorizationTx(conn as any, client.publicKey, pooled.publicKey, 2_000_000_000n, 1_000_000_000_000n);
  const combined = new Transaction();
  combined.add(...solBuilt.transaction.instructions);

  const splAtas: PublicKey[] = [];
  for (const entry of entries) {
    const programId = tokenProgramIdFor(entry);
    const mint = new PublicKey(entry.mint);
    conn.setMint(mint, entry.decimals, programId);
    const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
    conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 10_000_000n, delegate: null, delegatedAmount: 0n, programId });
    splAtas.push(ata);
    const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
    combined.add(...built.transaction.instructions);
  }

  combined.feePayer = client.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  combined.recentBlockhash = blockhash;
  combined.lastValidBlockHeight = lastValidBlockHeight;
  combined.sign(client); // ONE signature for all 8 authorizations
  const sig = await conn.sendRawTransaction(combined.serialize());
  const status = await conn.getSignatureStatus(sig);
  assert.equal(status.value?.err, null, "the combined authorization transaction must land without error");

  // Process all 8 authorizations against the SAME shared signature.
  const solResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: solBuilt.wsolAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: sig,
    programId: TOKEN_PROGRAM_ID,
  });
  assert.equal(solResult.outcome, "RECORDED", "SOL, the first asset processed, must be recorded");

  const splResults = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const result = await processAuthorizationSubmission({
      connection: conn as any,
      db,
      walletPubkey: client.publicKey.toBase58(),
      assetKey: entry.mint,
      tokenProgram: entry.token_program,
      authorizedTokenAccount: splAtas[i].toBase58(),
      expectedDelegate: pooled.publicKey.toBase58(),
      txSignature: sig, // the SAME shared signature for every one of the 7 SPL assets too
      programId: tokenProgramIdFor(entry),
    });
    splResults.push({ symbol: entry.symbol, outcome: result.outcome });
  }

  // This is the actual bug this test exists to catch: before the fix, every
  // SPL result here would incorrectly read "ALREADY_PROCESSED" because the
  // idempotency check only looked at tx_signature, which SOL had already
  // "claimed" moments earlier.
  for (const r of splResults) {
    assert.equal(r.outcome, "RECORDED", `${r.symbol} must be RECORDED, not dropped as a false-positive replay of another asset's authorization under the same shared signature`);
  }

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const active = listActiveAuthorizations(db, clientId);
  assert.equal(active.length, 8, "all 8 authorizations (SOL + 7 SPL) must actually exist as independent ACTIVE rows");
  assert.equal(new Set(active.map((a) => a.assetKey)).size, 8, "8 distinct assets, not 8 copies of one");
});

test("a genuine replay (the SAME signature AND the SAME asset, reprocessed) is still correctly detected as ALREADY_PROCESSED", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 10_000_000n, delegate: null, delegatedAmount: 0n, programId });

  const built = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  built.transaction.recentBlockhash = blockhash;
  built.transaction.lastValidBlockHeight = lastValidBlockHeight;
  built.transaction.sign(client);
  const sig = await conn.sendRawTransaction(built.transaction.serialize());

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
  const second = await processAuthorizationSubmission(input);
  assert.equal(first.outcome, "RECORDED");
  assert.equal(second.outcome, "ALREADY_PROCESSED", "a true replay -- same signature, same asset -- must still be caught");
});
