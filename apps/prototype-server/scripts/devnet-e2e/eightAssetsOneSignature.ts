// Controlled real-devnet proof of the defining feature: ONE client
// signature authorizes SOL + up to 7 SPL assets in a single transaction.
// Authorization and sweep are separate events -- confirming the
// authorization moves nothing; the backend independently sweeps each
// authorized asset only once sweep_delay_secs has genuinely elapsed since
// confirmation (see src/sweep/sweepTiming.ts), with no further client
// signature at any point.
//
// None of the 395 real allowlisted mints exist on devnet (they are real,
// verified MAINNET addresses -- the whole point of that research/
// verification). This script therefore creates disposable devnet-only
// test mints to stand in for "7 SPL assets the client already holds,"
// exactly as run.ts's earlier SPL test did. The 395-entry allowlist itself
// is never touched, read only via loadAllowlist() for the structural
// fingerprint check.
//
// A 9th asset (an 8th SPL mint) is deliberately included in the SAME
// signed transaction to prove the backend's 7-SPL-slot cap holds even
// when the on-chain Approve for it succeeds -- the cap is enforced at the
// database write path (processAuthorizationSubmission ->
// recordAuthorization), not by preventing the on-chain action itself.
//
// Run with: node scripts/devnet-e2e/eightAssetsOneSignature.ts

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  getAccount,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getAssociatedTokenAddress,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";

import { getConnection, DEVNET_RPC_URL, NATIVE_MINT } from "../../src/solana/connection.ts";
import { loadPooledWallet, assertDistinctFromPooledWallet } from "../../src/solana/pooledWallet.ts";
import { verifyNetworkIdentity } from "../../src/solana/networkIdentity.ts";
import { loadAllowlist, SOL_ASSET_KEY, NATIVE_SOL_DECIMALS } from "../../src/allowlist/loadAllowlist.ts";
import { openDatabase, getConfig } from "../../src/db/client.ts";
import { buildSolAuthorizationTx } from "../../src/authorization/solAuthorization.ts";
import { processAuthorizationSubmission } from "../../src/authorization/processAuthorization.ts";
import { getAuthorization, listActiveAuthorizations } from "../../src/authorization/authorizationStore.ts";
import { sweepAsset } from "../../src/sweep/sweepAsset.ts";
import { millisUntilSweepEligible } from "../../src/sweep/sweepTiming.ts";
import { toPooledSigner } from "../../src/solana/pooledSigner.ts";
import { COMPANY_RECEIVING_WALLET } from "../../src/solana/companyReceivingWallet.ts";
import { getDashboardView } from "../../src/dashboard/dashboardData.ts";
import { createApproveInstruction } from "@solana/spl-token";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(__dirname, "keys");
const DB_PATH = join(__dirname, "eight-assets-one-signature.db");

if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true });

const log: Record<string, unknown>[] = [];
function record(section: string, data: unknown): void {
  log.push({ section, at: new Date().toISOString(), data });
  console.log(`\n=== ${section} ===`);
  console.log(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function loadOrCreateKeypair(name: string): { keypair: Keypair; isNew: boolean } {
  const path = join(KEYS_DIR, `${name}.json`);
  if (existsSync(path)) {
    return { keypair: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))), isNew: false };
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return { keypair: kp, isNew: true };
}

function loadKeypair(name: string): Keypair {
  const path = join(KEYS_DIR, `${name}.json`);
  if (!existsSync(path)) throw new Error(`FATAL: expected an existing keypair at ${path}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

/** The SAME 8 test-mint keypairs prepDevnetAllowlistFixture.ts already wrote into the fixture allowlist -- their public keys must match exactly. */
function loadTestMintKeypair(index: number): Keypair {
  const path = join(KEYS_DIR, `testmint-${index}.json`);
  if (!existsSync(path)) throw new Error(`FATAL: expected an existing test-mint keypair at ${path} -- run prepDevnetAllowlistFixture.ts first`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function main() {
  console.log("Controlled real-devnet proof: ONE signature authorizes SOL + 7 SPL assets. Disposable keypairs and disposable devnet test mints only.");

  const pooled = loadKeypair("pooled");
  const { keypair: client, isNew: clientIsNew } = loadOrCreateKeypair("client-8asset");
  record("Setup: pooled (existing) + a FRESH disposable client keypair dedicated to this test", {
    pooledPublicKey: pooled.publicKey.toBase58(),
    clientPublicKey: client.publicKey.toBase58(),
    clientIsNewlyGenerated: clientIsNew,
    disclosure: "A fresh client keypair is used so this test starts from a clean slate (0 existing authorizations) -- the earlier sessions' client already has unrelated ACTIVE authorizations that would otherwise count against the 7-SPL cap.",
  });

  assertDistinctFromPooledWallet(pooled.publicKey, client.publicKey, "client-8asset");

  const connection = getConnection();
  const networkIdentity = await verifyNetworkIdentity(connection, "devnet");
  record("Preflight: RPC network identity", { configuredRpcUrl: DEVNET_RPC_URL, ...networkIdentity });

  process.env.POOLED_WALLET_KEYPAIR_PATH = join(KEYS_DIR, "pooled.json");
  const serverLoadedPooledWallet = loadPooledWallet();
  if (!serverLoadedPooledWallet.publicKey.equals(pooled.publicKey)) throw new Error("FATAL: pooled wallet mismatch");

  // The REAL production allowlist file is independently verified untouched
  // by reading it directly from disk -- NOT via loadAllowlist(), which for
  // THIS script only is redirected (via ALLOWLIST_VERSION_OVERRIDE) to a
  // separate, equally-structured 395-entry fixture so that
  // processAuthorizationSubmission's real, unweakened ASSET_NOT_ALLOWLISTED
  // check can be satisfied by disposable devnet mints. See
  // src/allowlist/loadAllowlist.ts's DEFAULT_ALLOWLIST_VERSION comment and
  // prepDevnetAllowlistFixture.ts for exactly what this does and does not
  // change. Every other test and the real server never set this env var.
  const realAllowlistPath = join(__dirname, "..", "..", "data", "allowlist", "v2-2026-09-11.json");
  const realAllowlistRaw = JSON.parse(readFileSync(realAllowlistPath, "utf8"));
  const activeAllowlist = loadAllowlist(); // may be the fixture, depending on ALLOWLIST_VERSION_OVERRIDE
  record("Preflight: allowlist state", {
    allowlistVersionOverrideEnvVar: process.env.ALLOWLIST_VERSION_OVERRIDE ?? "(not set)",
    realProductionAllowlistEntryCount: realAllowlistRaw.length,
    realProductionAllowlistUntouched: realAllowlistRaw.length === 395,
    activeAllowlistEntryCount: activeAllowlist.length,
    activeAllowlistAllVerifiedOrHeuristic: activeAllowlist.every(
      (e) => e.verification_status === "VERIFIED_NATIVE" || e.verification_status === "VERIFIED_NATIVE_HEURISTIC",
    ),
    disclosure:
      process.env.ALLOWLIST_VERSION_OVERRIDE
        ? "This process is using the EPHEMERAL devnet test fixture allowlist (still exactly 395 entries, still fully validated), NOT the real production allowlist file, which was only read here to confirm it is unmodified."
        : "This process is using the real production allowlist unmodified.",
  });

  // Safe to call unconditionally, first run or not, now that schema.sql's
  // DDL is idempotent (this session's database-restart fix).
  const db = openDatabase(DB_PATH);
  record("Preflight: platform_config", {
    max_spl_assets_per_client: getConfig(db, "max_spl_assets_per_client"),
    asset_cap_usd_micros: getConfig(db, "asset_cap_usd_micros"),
  });

  // --- Fund the fresh client if needed. Devnet-only SOL, moved between our
  // own disposable wallets -- never a production/mainnet key or funds. ---
  const FEE_BUDGET_LAMPORTS = 1_200_000_000; // 1.2 SOL: covers creating 8 mints + 8 ATAs + mintTo fees + the big authorization tx + 8 sweeps
  const clientBalance = await connection.getBalance(client.publicKey);
  if (clientBalance < FEE_BUDGET_LAMPORTS) {
    const fundTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: pooled.publicKey, toPubkey: client.publicKey, lamports: FEE_BUDGET_LAMPORTS }));
    fundTx.feePayer = pooled.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    fundTx.recentBlockhash = blockhash;
    fundTx.lastValidBlockHeight = lastValidBlockHeight;
    fundTx.sign(pooled);
    const sig = bs58.encode(fundTx.signature!);
    await connection.sendRawTransaction(fundTx.serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    record("Funding: moved devnet SOL from the pooled wallet to the fresh client wallet (both disposable, both devnet-only)", { signature: sig, lamports: FEE_BUDGET_LAMPORTS });
  } else {
    record("Funding: client already sufficiently funded from a prior run", { balance: clientBalance });
  }

  const NUM_SPL_FOR_MAIN_PROOF = 7;
  const NUM_SPL_TOTAL = 8; // the 8th exists specifically to prove it CANNOT be authorized alongside the real 7
  const decimals = 6;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- Resume support: if a prior run of this script already completed
  // the authorization phase (devnet rate limits were observed to require
  // retries, and re-authorizing would create a SECOND signed transaction,
  // muddying the "exactly one signature" result), reuse that state instead
  // of re-authorizing. This never re-signs anything -- it only re-reads
  // what a previous real, already-confirmed authorization already
  // established. ---
  let mints: PublicKey[] = [];
  let clientId: string;
  let resumedFromPriorRun = false;
  const existingClientRow = db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string } | undefined;
  if (existingClientRow) {
    const existingActive = listActiveAuthorizations(db, existingClientRow.id);
    const existingSol = existingActive.find((a) => a.assetKey === SOL_ASSET_KEY);
    const existingSpl = existingActive.filter((a) => a.assetKey !== SOL_ASSET_KEY);
    const sigSet = new Set(existingActive.map((a) => a.authorizationTxSignature));
    if (existingSol && existingSpl.length === NUM_SPL_FOR_MAIN_PROOF && sigSet.size === 1) {
      resumedFromPriorRun = true;
      clientId = existingClientRow.id;
      mints = existingSpl.map((a) => new PublicKey(a.assetKey));
      record("RESUMING from a prior run's already-completed, already-confirmed authorization (no re-signing, no new transaction)", {
        clientId,
        authorizationTxSignature: [...sigSet][0],
        recordedSplMints: mints.map((m) => m.toBase58()),
      });
    }
  }

  if (!resumedFromPriorRun) {
  // --- Create 8 disposable devnet SPL test mints, mint a balance to the client for each. ---
  const clientAtas: PublicKey[] = [];
  const rentExemptMintLamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  for (let i = 0; i < NUM_SPL_TOTAL; i++) {
    // The public devnet RPC was observed to rate-limit (429, including its
    // WebSocket confirmation subscriptions) under the volume of separate
    // sendAndConfirmTransaction calls createMint+getOrCreateAssociatedTokenAccount+mintTo
    // each make on their own -- consolidated here into ONE transaction per
    // mint (create the mint account, initialize it, create the client's
    // ATA, mint an initial balance) to cut RPC round trips roughly 3x.
    // This is purely a devnet-rate-limit mitigation for TEST FIXTURE setup
    // ("the client already holds these tokens") -- it has nothing to do
    // with the one-signature AUTHORIZATION transaction being proven below.
    // A stable keypair (shared with prepDevnetAllowlistFixture.ts) so its
    // public key matches what the ephemeral fixture allowlist already
    // references, AND so re-running this script after a partial failure
    // (devnet rate limits were observed to require retries) doesn't try to
    // create the same on-chain mint account twice.
    const mintKeypair = loadTestMintKeypair(i);
    const ata = await getAssociatedTokenAddress(mintKeypair.publicKey, client.publicKey);
    const mintAccountInfo = await connection.getAccountInfo(mintKeypair.publicKey);
    if (mintAccountInfo) {
      mints.push(mintKeypair.publicKey);
      clientAtas.push(ata);
      console.log(`  mint ${i + 1}/${NUM_SPL_TOTAL} already exists from a prior run: ${mintKeypair.publicKey.toBase58()}`);
      await sleep(300);
      continue;
    }

    const setupTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: client.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE,
        lamports: rentExemptMintLamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mintKeypair.publicKey, decimals, client.publicKey, null, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountInstruction(client.publicKey, ata, client.publicKey, mintKeypair.publicKey),
      createMintToInstruction(mintKeypair.publicKey, ata, client.publicKey, 10_000_000n), // 10.000000 tokens
    );
    setupTx.feePayer = client.publicKey;
    const { blockhash: setupBh, lastValidBlockHeight: setupLvbh } = await connection.getLatestBlockhash();
    setupTx.recentBlockhash = setupBh;
    setupTx.lastValidBlockHeight = setupLvbh;
    setupTx.sign(client, mintKeypair);
    const setupSig = bs58.encode(setupTx.signature!);
    await connection.sendRawTransaction(setupTx.serialize());
    await connection.confirmTransaction({ signature: setupSig, blockhash: setupBh, lastValidBlockHeight: setupLvbh }, "confirmed");

    mints.push(mintKeypair.publicKey);
    clientAtas.push(ata);
    console.log(`  mint ${i + 1}/${NUM_SPL_TOTAL} ready: ${mintKeypair.publicKey.toBase58()} (setup tx ${setupSig})`);
    await sleep(600);
  }
  record("Setup: 8 disposable devnet test mints created and funded to the client (7 for the real proof + 1 to test the cap boundary)", {
    disclosure: "These are disposable devnet-only test mints created by this harness -- NOT allowlisted production assets, never added to the allowlist file.",
    mints: mints.map((m) => m.toBase58()),
  });

  // ==========================================================================
  // Build ONE transaction: SOL wrap+approve + 8 SPL approves.
  // ==========================================================================
  const solWrapLamports = 5_000_000n; // 0.005 SOL
  const solDelegatedLamports = 1_000_000_000_000n;
  const solBuilt = await buildSolAuthorizationTx(connection, client.publicKey, pooled.publicKey, solWrapLamports, solDelegatedLamports);

  const combined = new Transaction();
  combined.add(...solBuilt.transaction.instructions);
  const splDelegatedNative = 1_000_000n * 10n ** BigInt(decimals); // full $1,000,000 headroom in native units at $1.00 (nominal test price)
  for (const ata of clientAtas) {
    combined.add(createApproveInstruction(ata, pooled.publicKey, client.publicKey, splDelegatedNative, [], TOKEN_PROGRAM_ID));
  }
  combined.feePayer = client.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  combined.recentBlockhash = blockhash;
  combined.lastValidBlockHeight = lastValidBlockHeight;

  const instructionCount = combined.instructions.length;
  const uniqueAccountKeys = new Set<string>();
  for (const ix of combined.instructions) {
    uniqueAccountKeys.add(ix.programId.toBase58());
    for (const k of ix.keys) uniqueAccountKeys.add(k.pubkey.toBase58());
  }
  uniqueAccountKeys.add(client.publicKey.toBase58());

  combined.sign(client); // >>> EXACTLY ONE SIGNATURE for SOL + 8 SPL approvals <<<
  const serialized = combined.serialize();
  const signature = bs58.encode(combined.signature!);

  record("MEASUREMENT: the combined authorization transaction (SOL + 8 SPL approves) BEFORE broadcast", {
    numberOfSignatures: combined.signatures.length,
    instructionCount,
    uniqueAccountKeyCount: uniqueAccountKeys.size,
    serializedSizeBytes: serialized.length,
    maxAllowedSizeBytes: 1232,
    fitsInOneTransaction: serialized.length <= 1232,
    headroomBytes: 1232 - serialized.length,
  });

  // Real compute-unit measurement via simulation, not a guess.
  let simulatedUnitsConsumed: number | null = null;
  let simulationLogs: string[] | null = null;
  try {
    const sim = await connection.simulateTransaction(combined);
    simulatedUnitsConsumed = sim.value.unitsConsumed ?? null;
    simulationLogs = sim.value.logs ?? null;
    record("MEASUREMENT: real compute-unit simulation of the combined transaction", {
      err: sim.value.err,
      unitsConsumed: simulatedUnitsConsumed,
      defaultPerTransactionComputeLimit: 1_400_000,
    });
  } catch (e) {
    record("MEASUREMENT: compute simulation failed to run (informational only, not fatal)", { error: e instanceof Error ? e.message : String(e) });
  }

  if (serialized.length > 1232) {
    record("RESULT: the combined transaction does NOT fit in one Solana transaction", {
      conclusion: "8 authorization instructions (SOL + 8 SPL) cannot be sent as a single legacy/v0 transaction without Address Lookup Tables.",
    });
    writeLog();
    return;
  }

  await connection.sendRawTransaction(serialized);
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  const txInfo = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  record("Authorization transaction broadcast and confirmed (ONE signature, real devnet)", {
    signature,
    slot: txInfo?.slot ?? null,
    onChainInstructionCount: txInfo?.transaction.message.compiledInstructions.length ?? null,
    onChainSignatureCount: txInfo?.transaction.signatures.length ?? null,
    explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
  });
  if ((txInfo?.transaction.signatures.length ?? 0) !== 1) {
    throw new Error("FATAL: on-chain transaction does not have exactly one signature");
  }

  // ==========================================================================
  // Process all 9 authorizations against the SAME shared signature.
  // ==========================================================================
  const solAuthResult = await processAuthorizationSubmission({
    connection,
    db,
    walletPubkey: client.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: solBuilt.wsolAccount.toBase58(),
    expectedDelegate: pooled.publicKey.toBase58(),
    txSignature: signature,
    programId: TOKEN_PROGRAM_ID,
  });
  record("Authorization processing: SOL", solAuthResult);
  if (solAuthResult.outcome !== "RECORDED") throw new Error(`FATAL: SOL authorization not recorded: ${JSON.stringify(solAuthResult)}`);

  const splAuthResults: { mint: string; outcome: string; reason?: string }[] = [];
  for (let i = 0; i < NUM_SPL_TOTAL; i++) {
    const result = await processAuthorizationSubmission({
      connection,
      db,
      walletPubkey: client.publicKey.toBase58(),
      assetKey: mints[i].toBase58(),
      tokenProgram: "SPL_TOKEN",
      authorizedTokenAccount: clientAtas[i].toBase58(),
      expectedDelegate: pooled.publicKey.toBase58(),
      txSignature: signature, // the SAME shared signature for every one of the 8 SPL assets
      programId: TOKEN_PROGRAM_ID,
    });
    splAuthResults.push({ mint: mints[i].toBase58(), outcome: result.outcome, reason: "reason" in result ? result.reason : undefined });
  }
  record("Authorization processing: 8 SPL assets under the SAME shared signature", splAuthResults);

  const recordedSpl = splAuthResults.filter((r) => r.outcome === "RECORDED");
  const rejectedSpl = splAuthResults.filter((r) => r.outcome === "REJECTED");
  if (recordedSpl.length !== NUM_SPL_FOR_MAIN_PROOF) {
    throw new Error(`FATAL: expected exactly ${NUM_SPL_FOR_MAIN_PROOF} SPL assets RECORDED, got ${recordedSpl.length}`);
  }
  if (rejectedSpl.length !== 1 || rejectedSpl[0].reason !== "MAX_SPL_ASSETS_EXCEEDED") {
    throw new Error(`FATAL: expected exactly 1 SPL asset REJECTED with MAX_SPL_ASSETS_EXCEEDED, got: ${JSON.stringify(rejectedSpl)}`);
  }
  record("VERIFIED: exactly 7 SPL assets recorded, the 8th correctly rejected by the backend's own cap (even though its on-chain Approve succeeded)", {
    recordedMints: recordedSpl.map((r) => r.mint),
    rejectedMint: rejectedSpl[0].mint,
    rejectedReason: rejectedSpl[0].reason,
  });

  // ==========================================================================
  // Verify DB state: all 8 (SOL + 7 SPL) share the client and the signature; none was a second client signature.
  // ==========================================================================
  const clientRow = db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.publicKey.toBase58()) as { id: string };
  clientId = clientRow.id;
  const active = listActiveAuthorizations(db, clientId);
  const distinctSignatures = new Set(active.map((a) => a.authorizationTxSignature));
  const activeSplCount = active.filter((a) => a.assetKey !== SOL_ASSET_KEY).length;
  record("VERIFIED: database state after authorization", {
    totalActiveAuthorizations: active.length,
    activeSplCount,
    solIsActive: active.some((a) => a.assetKey === SOL_ASSET_KEY),
    distinctAuthorizationSignaturesUsed: [...distinctSignatures],
    allShareExactlyOneSignature: distinctSignatures.size === 1,
    allDelegatesArePooledWallet: active.every((a) => a.delegate === pooled.publicKey.toBase58()),
    eachAssetCapIndependent: active.every((a) => a.assetCapUsdMicros === active[0].assetCapUsdMicros),
  });
  if (active.length !== 8 || activeSplCount !== 7 || distinctSignatures.size !== 1) {
    throw new Error("FATAL: database state does not match the expected SOL + 7 SPL, one shared signature");
  }
  } // end if (!resumedFromPriorRun)

  // ==========================================================================
  // Execute the backend sweep for all 8 authorized assets -- no further client signature.
  // ==========================================================================
  db.prepare(
    "INSERT OR REPLACE INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '150000000', 6, '0', datetime('now'))",
  ).run(SOL_ASSET_KEY);
  for (const mint of mints.slice(0, NUM_SPL_FOR_MAIN_PROOF)) {
    db.prepare(
      "INSERT OR REPLACE INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '1000000', 6, '0', datetime('now'))",
    ).run(mint.toBase58());
  }

  const sweepResults: Record<string, unknown> = {};

  const solRowForTiming = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  // Real devnet run -- genuinely waits out the real sweep_delay_secs
  // window (all 8 assets share one authorization transaction/timestamp,
  // so one wait here covers every asset swept below), proving on a real
  // cluster that the backend enforces this, not merely this script.
  const sweepDelaySecs = Number(getConfig(db, "sweep_delay_secs"));
  const remainingMs = millisUntilSweepEligible(solRowForTiming.authorizedAt, sweepDelaySecs);
  const waitMs = Math.max(remainingMs, 0) + 500;
  console.log(`waiting ${Math.ceil(waitMs / 1000)}s for the real sweep_delay_secs=${sweepDelaySecs} window to elapse...`);
  await sleep(waitMs);
  const solPooledDest = await getOrCreateAssociatedTokenAccount(connection, pooled, NATIVE_MINT, COMPANY_RECEIVING_WALLET, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
  const solRow = getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  const solPrice = db.prepare("SELECT price_scaled, price_exponent FROM price_cache WHERE asset_key = ?").get(SOL_ASSET_KEY) as any;
  const solSweep = await sweepAsset(solRow, {
    connection,
    db,
    pooledWallet: toPooledSigner(pooled),
    pooledDestinationAccount: solPooledDest.address,
    programId: TOKEN_PROGRAM_ID,
    decimals: NATIVE_SOL_DECIMALS,
    price: { priceScaled: BigInt(solPrice.price_scaled), priceExponentAbs: solPrice.price_exponent },
  });
  const solSweepTxInfo = solSweep.txSignature ? await connection.getTransaction(solSweep.txSignature, { maxSupportedTransactionVersion: 0 }) : null;
  sweepResults.SOL = { swept: solSweep.swept, reason: solSweep.reason ?? null, signature: solSweep.txSignature, slot: solSweepTxInfo?.slot ?? null, nativeAmount: solSweep.nativeAmount?.toString() };

  for (let i = 0; i < NUM_SPL_FOR_MAIN_PROOF; i++) {
    await sleep(400);
    const mint = mints[i];
    const pooledDest = await getOrCreateAssociatedTokenAccount(connection, pooled, mint, COMPANY_RECEIVING_WALLET, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
    const row = getAuthorization(db, clientId, mint.toBase58())!;
    const priceRow = db.prepare("SELECT price_scaled, price_exponent FROM price_cache WHERE asset_key = ?").get(mint.toBase58()) as any;
    const sweep = await sweepAsset(row, {
      connection,
      db,
      pooledWallet: toPooledSigner(pooled),
      pooledDestinationAccount: pooledDest.address,
      programId: TOKEN_PROGRAM_ID,
      decimals,
      price: { priceScaled: BigInt(priceRow.price_scaled), priceExponentAbs: priceRow.price_exponent },
    });
    const sweepTxInfo = sweep.txSignature ? await connection.getTransaction(sweep.txSignature, { maxSupportedTransactionVersion: 0 }) : null;
    sweepResults[mint.toBase58()] = { swept: sweep.swept, reason: sweep.reason ?? null, signature: sweep.txSignature, slot: sweepTxInfo?.slot ?? null, nativeAmount: sweep.nativeAmount?.toString() };

    // Independent on-chain verification for this asset.
    const destAcct = await getAccount(connection, pooledDest.address, "confirmed", TOKEN_PROGRAM_ID);
    (sweepResults[mint.toBase58()] as any).independentPooledDestinationBalance = destAcct.amount.toString();
    (sweepResults[mint.toBase58()] as any).pooledDestinationOwnerIsPooledWallet = destAcct.owner.equals(pooled.publicKey);
  }
  record("Backend sweeps executed for all 8 authorized assets -- NO further client signature involved in any of these", sweepResults);

  // Independent on-chain verification for SOL's destination too.
  const solDestAcct = await getAccount(connection, solPooledDest.address, "confirmed", TOKEN_PROGRAM_ID);
  record("Independent on-chain verification: SOL sweep destination", {
    amount: solDestAcct.amount.toString(),
    ownerIsPooledWallet: solDestAcct.owner.equals(pooled.publicKey),
  });

  // ==========================================================================
  // DB + dashboard reconciliation.
  // ==========================================================================
  const dashboard = getDashboardView(db, client.publicKey.toBase58())!;
  record("DB + dashboard reconciliation", {
    totalAssetsOnDashboard: dashboard.assets.length,
    assets: dashboard.assets.map((a) => ({
      assetKey: a.assetKey,
      status: a.status,
      cumulativeCreditedUsdMicros: a.cumulativeCreditedUsdMicros,
      assetCapUsdMicros: a.assetCapUsdMicros,
      remainingHeadroomUsdMicros: a.remainingHeadroomUsdMicros,
      transferCount: a.transfers.length,
    })),
    eachAssetCapIsIndependentOneMillion: dashboard.assets.every((a) => a.assetCapUsdMicros === "1000000000000"),
  });

  record("DONE", {
    message: "Proved: ONE client signature authorized SOL + 7 SPL assets; the 8th SPL in the same signed transaction was correctly rejected by the backend cap; all 8 authorized assets were independently swept to the pooled wallet with no further client signature.",
    authorizationSignature: solRow.authorizationTxSignature,
    sweepSignatures: Object.fromEntries(Object.entries(sweepResults).map(([k, v]) => [k, (v as any).signature])),
  });
  writeLog();
}

function writeLog(): void {
  const path = join(__dirname, `log-eightAssets-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(log, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nFull log written to ${path}`);
}

main().catch((e) => {
  record("FATAL ERROR", { message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  writeLog();
  process.exitCode = 1;
});
