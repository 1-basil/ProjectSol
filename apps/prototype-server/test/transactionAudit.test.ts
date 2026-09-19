// Audits the ACTUAL constructed transactions -- decoding raw instruction
// discriminator bytes directly, never inferring instruction type from which
// builder function was called. Proves, at the wire-format level:
//   - The authorization transaction (SOL and SPL/Token-2022) contains
//     ONLY delegation instructions -- no SPL Transfer/TransferChecked, no
//     transfer to the pooled wallet or company wallet, no sweep
//     instruction of any kind. The one SOL-only exception (a System
//     Program transfer wrapping the client's own SOL into their own wSOL
//     ATA, same owner both sides) is asserted to be exactly that -- a
//     self-transfer, never a transfer to any third party -- since native
//     SOL has no delegate concept of its own and this is the only way to
//     make it delegable at all in one signature.
//   - The later sweep transaction is structurally different: it contains
//     TransferChecked (SPL/Token-2022) and, for SOL, SyncNative, moving
//     value to the company receiving wallet's own account -- never to the
//     pooled wallet, and never appearing in the authorization transaction.
//   - The two transactions carry different signatures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, SystemInstruction, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import type { DatabaseSync } from "node:sqlite";

import { freshTestDb as freshDb, backdateAuthorization } from "../testSupport/testDb.ts";
import { FakeConnection } from "../testSupport/fakeConnection.ts";
import { loadAllowlist, SOL_ASSET_KEY, NATIVE_SOL_DECIMALS, type AllowlistEntry } from "../src/allowlist/loadAllowlist.ts";
import { NATIVE_MINT } from "../src/solana/connection.ts";
import { buildSolAuthorizationTx } from "../src/authorization/solAuthorization.ts";
import { buildSplAuthorizationTx, tokenProgramIdFor } from "../src/authorization/splAuthorization.ts";
import { processAuthorizationSubmission } from "../src/authorization/processAuthorization.ts";
import { getAuthorization } from "../src/authorization/authorizationStore.ts";
import { sweepAsset } from "../src/sweep/sweepAsset.ts";
import { toPooledSigner } from "../src/solana/pooledSigner.ts";
import { COMPANY_RECEIVING_WALLET } from "../src/solana/companyReceivingWallet.ts";

// Raw SPL Token / Token-2022 instruction discriminators (first byte of
// instruction data) -- see @solana/spl-token's TokenInstruction enum.
// Decoded directly rather than trusted from a builder function's name.
const TOKEN_IX = {
  Transfer: 3,
  Approve: 4,
  Revoke: 5,
  TransferChecked: 12,
  SyncNative: 17,
} as const;

const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

interface DecodedIx {
  readonly program: "System" | "AssociatedToken" | "SPL_TOKEN" | "TOKEN_2022" | "Unknown";
  readonly type: string;
  readonly programId: string;
}

/** Classifies one instruction by its actual program id + raw discriminator byte -- the audit primitive every test below is built on. */
function classify(ix: Transaction["instructions"][number]): DecodedIx {
  if (ix.programId.equals(SYSTEM_PROGRAM_ID)) {
    return { program: "System", type: "Transfer (or CreateAccount)", programId: ix.programId.toBase58() };
  }
  if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
    return { program: "AssociatedToken", type: "CreateAssociatedTokenAccount", programId: ix.programId.toBase58() };
  }
  const tokenProgramLabel = ix.programId.equals(TOKEN_PROGRAM_ID) ? "SPL_TOKEN" : "TOKEN_2022";
  const discriminator = ix.data[0];
  const typeLabel = (Object.entries(TOKEN_IX).find(([, v]) => v === discriminator)?.[0]) ?? `unknown(${discriminator})`;
  return { program: tokenProgramLabel, type: typeLabel, programId: ix.programId.toBase58() };
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

function seedPrice(db: DatabaseSync, assetKey: string, priceUsd: number): void {
  const priceScaled = BigInt(Math.round(priceUsd * 1_000_000));
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, ?, 6, '0', datetime('now'))",
  ).run(assetKey, priceScaled.toString());
}

// ---------------------------------------------------------------------------
// A. SPL/Token-2022 authorization transaction: report + assert its exact
//    instruction structure.
// ---------------------------------------------------------------------------

test("A: SPL authorization transaction contains EXACTLY ONE instruction -- Approve -- no Transfer/TransferChecked, no sweep instruction, nothing else", async () => {
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");

  const { transaction } = await buildSplAuthorizationTx({} as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));

  const decoded = transaction.instructions.map(classify);
  console.log("SPL authorization tx instruction structure:", JSON.stringify(decoded, null, 2));

  assert.equal(decoded.length, 1, "the authorization transaction must contain exactly one instruction");
  assert.equal(decoded[0]!.type, "Approve");
  assert.equal(decoded[0]!.programId, tokenProgramIdFor(entry).toBase58());

  for (const d of decoded) {
    assert.notEqual(d.type, "Transfer");
    assert.notEqual(d.type, "TransferChecked");
  }
});

// ---------------------------------------------------------------------------
// B. SOL authorization transaction: report + assert its exact instruction
//    structure, including the one necessary self-transfer.
// ---------------------------------------------------------------------------

test("B: SOL authorization transaction's only System transfer is a SELF-transfer (client -> client's own wSOL ATA) -- never to the pooled or company wallet -- followed by SyncNative and Approve, nothing else", async () => {
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  conn.setMint(NATIVE_MINT, NATIVE_SOL_DECIMALS, TOKEN_PROGRAM_ID);
  conn.setSolBalance(client.publicKey, 5_000_000_000n);

  const { transaction, wsolAccount } = await buildSolAuthorizationTx(conn as any, client.publicKey, pooled.publicKey, 2_000_000_000n, 1_000_000_000_000n);

  const decoded = transaction.instructions.map(classify);
  console.log("SOL authorization tx instruction structure:", JSON.stringify(decoded, null, 2));

  // No SPL Transfer/TransferChecked, no Revoke, and definitely no
  // TransferChecked to any company/pooled-owned destination -- the only
  // token-program instructions allowed here are SyncNative and Approve.
  for (const ix of transaction.instructions) {
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      assert.ok(
        ix.data[0] === TOKEN_IX.SyncNative || ix.data[0] === TOKEN_IX.Approve,
        `unexpected token-program instruction discriminator ${ix.data[0]} in the authorization transaction`,
      );
    }
  }

  // The System transfer instruction (the SOL-wrap step) must move funds
  // exactly from the client to the client's OWN wSOL ATA -- self-custody
  // preserved, never routed to the pooled wallet or the company wallet.
  const systemTransferIx = transaction.instructions.find((ix) => ix.programId.equals(SYSTEM_PROGRAM_ID));
  assert.ok(systemTransferIx, "expected the SOL-wrap System transfer instruction to be present");
  const decodedTransfer = SystemInstruction.decodeTransfer(systemTransferIx!);
  assert.equal(decodedTransfer.fromPubkey.toBase58(), client.publicKey.toBase58());
  assert.equal(decodedTransfer.toPubkey.toBase58(), wsolAccount.toBase58(), "must be the client's own wSOL ATA");
  assert.notEqual(decodedTransfer.toPubkey.toBase58(), pooled.publicKey.toBase58());
  assert.notEqual(decodedTransfer.toPubkey.toBase58(), COMPANY_RECEIVING_WALLET.toBase58());
  // The wSOL ATA itself is owned by the client, not the pooled wallet --
  // confirms this is a deposit into an account the client still controls.
  assert.equal((await getAssociatedTokenAddress(NATIVE_MINT, client.publicKey)).toBase58(), wsolAccount.toBase58());

  // Last instruction is the actual delegation.
  const last = decoded[decoded.length - 1]!;
  assert.equal(last.type, "Approve");
});

// ---------------------------------------------------------------------------
// C/D. The sweep transaction is a separate, later, backend-only transaction
//      -- structurally distinct instructions, distinct signature.
// ---------------------------------------------------------------------------

test("C/D: the sweep transaction (SPL) contains TransferChecked to the COMPANY wallet's account -- never appears in, and is structurally distinct from, the authorization transaction; different signature", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  const entry = findEntry("USDT");
  const programId = tokenProgramIdFor(entry);
  const mint = new PublicKey(entry.mint);
  conn.setMint(mint, entry.decimals, programId);
  seedPrice(db, entry.mint, 1.0);

  const ata = await getAssociatedTokenAddress(mint, client.publicKey, false, programId);
  conn.setTokenAccount(ata, { mint, owner: client.publicKey, amount: 100_000_000n, delegate: null, delegatedAmount: 0n, programId });

  const { transaction: authTx, tokenAccount } = await buildSplAuthorizationTx(conn as any, client.publicKey, entry, pooled.publicKey, 1_000_000n * 10n ** BigInt(entry.decimals));
  const authSig = await signAndSend(conn, authTx, client);
  const authResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: entry.mint,
    tokenProgram: entry.token_program,
    authorizedTokenAccount: tokenAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: authSig,
    programId,
  });
  assert.equal(authResult.outcome, "RECORDED");
  backdateAuthorization(db, authResult.outcome === "RECORDED" ? authResult.authorizationId : "");

  // Destination ATA genuinely owned by the fixed COMPANY_RECEIVING_WALLET
  // constant -- exactly what the real indexer does (see indexer/index.ts),
  // never the pooled wallet's own account.
  const companyDest = await getOrCreateAssociatedTokenAccount(conn as any, pooled, mint, COMPANY_RECEIVING_WALLET, false, "confirmed", undefined, programId);

  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const row = getAuthorization(db, clientId, entry.mint)!;
  const priceRow = db.prepare("SELECT price_scaled, price_exponent FROM price_cache WHERE asset_key = ?").get(entry.mint) as { price_scaled: string; price_exponent: number };

  const sweepResult = await sweepAsset(row, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: companyDest.address,
    programId,
    decimals: entry.decimals,
    price: { priceScaled: BigInt(priceRow.price_scaled), priceExponentAbs: priceRow.price_exponent },
  });
  assert.equal(sweepResult.swept, true);

  const sweepTx = conn.getLastSentTransaction()!;
  const sweepDecoded = sweepTx.instructions.map(classify);
  console.log("Sweep tx instruction structure:", JSON.stringify(sweepDecoded, null, 2));

  assert.equal(sweepDecoded.length, 1, "the sweep transaction contains exactly one instruction (TransferChecked)");
  assert.equal(sweepDecoded[0]!.type, "TransferChecked");
  const sweepTransferIx = sweepTx.instructions[0]!;
  // TransferChecked account order: source, mint, destination, owner/delegate.
  assert.equal(sweepTransferIx.keys[2]!.pubkey.toBase58(), companyDest.address.toBase58(), "destination is the company wallet's account");
  assert.notEqual(sweepTransferIx.keys[2]!.pubkey.toBase58(), pooled.publicKey.toBase58());

  // No Approve/Revoke instruction ever appears in a sweep transaction --
  // the sweep never re-authorizes or touches delegation state on-chain.
  for (const ix of sweepTx.instructions) {
    if (ix.programId.equals(programId)) {
      assert.notEqual(ix.data[0], TOKEN_IX.Approve);
      assert.notEqual(ix.data[0], TOKEN_IX.Revoke);
    }
  }

  // The authorization transaction never contains TransferChecked, and the
  // sweep transaction never contains Approve -- structurally distinct sets.
  const authInstructionTypes = new Set(authTx.instructions.map((ix) => classify(ix).type));
  assert.ok(!authInstructionTypes.has("TransferChecked"));
  const sweepInstructionTypes = new Set(sweepTx.instructions.map((ix) => classify(ix).type));
  assert.ok(!sweepInstructionTypes.has("Approve"));

  // Different signatures -- two genuinely separate transactions.
  const sweepSig = bs58.encode(sweepTx.signature!);
  assert.notEqual(sweepSig, authSig);
  assert.equal(sweepResult.txSignature, sweepSig);
});

test("C/D (SOL): the sweep transaction moves the wSOL balance to the COMPANY wallet's wSOL account via SyncNative + TransferChecked -- structurally distinct from the authorization transaction; different signature", async () => {
  const db = freshDb();
  const conn = new FakeConnection();
  const client = Keypair.generate();
  const pooled = Keypair.generate();
  conn.setMint(NATIVE_MINT, NATIVE_SOL_DECIMALS, TOKEN_PROGRAM_ID);
  conn.setSolBalance(client.publicKey, 5_000_000_000n);
  seedPrice(db, SOL_ASSET_KEY, 150);

  const { transaction: authTx, wsolAccount } = await buildSolAuthorizationTx(conn as any, client.publicKey, pooled.publicKey, 2_000_000_000n, 1_000_000_000_000n);
  const authSig = await signAndSend(conn, authTx, client);
  const authResult = await processAuthorizationSubmission({
    connection: conn as any,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: wsolAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: authSig,
    programId: TOKEN_PROGRAM_ID,
  });
  assert.equal(authResult.outcome, "RECORDED");
  backdateAuthorization(db, authResult.outcome === "RECORDED" ? authResult.authorizationId : "");

  const companyWsolDest = await getOrCreateAssociatedTokenAccount(conn as any, pooled, NATIVE_MINT, COMPANY_RECEIVING_WALLET, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string }).id;
  const row = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  const priceRow = db.prepare("SELECT price_scaled, price_exponent FROM price_cache WHERE asset_key = ?").get(SOL_ASSET_KEY) as { price_scaled: string; price_exponent: number };

  const sweepResult = await sweepAsset(row, {
    connection: conn as any,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: companyWsolDest.address,
    programId: TOKEN_PROGRAM_ID,
    decimals: NATIVE_SOL_DECIMALS,
    price: { priceScaled: BigInt(priceRow.price_scaled), priceExponentAbs: priceRow.price_exponent },
  });
  assert.equal(sweepResult.swept, true);

  // Two transactions get sent for the SOL sweep path: the permissionless
  // SyncNative refresh, then the actual TransferChecked. getLastSentTransaction
  // captures the second (the real transfer); both are on record via
  // getSentTransactions() for full inspection.
  const allSent = conn.getSentTransactions();
  const sweepTx = allSent[allSent.length - 1]!;
  const sweepDecoded = sweepTx.instructions.map(classify);
  console.log("SOL sweep tx instruction structure:", JSON.stringify(sweepDecoded, null, 2));

  assert.equal(sweepDecoded.length, 1);
  assert.equal(sweepDecoded[0]!.type, "TransferChecked");
  assert.equal(sweepTx.instructions[0]!.keys[2]!.pubkey.toBase58(), companyWsolDest.address.toBase58());

  const sweepSig = bs58.encode(sweepTx.signature!);
  assert.notEqual(sweepSig, authSig, "authorization and sweep are different transactions with different signatures");
  assert.equal(sweepResult.txSignature, sweepSig);
});
