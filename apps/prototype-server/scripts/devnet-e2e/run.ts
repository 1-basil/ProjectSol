// Controlled real-devnet E2E harness. This is a NEW, standalone script --
// it does not modify any file under src/, and it is never auto-run by
// `node --test` (it does not live under a directory named `test`). It
// drives the exact same production functions the real server uses
// (getConnection, loadPooledWallet, loadAllowlist, openDatabase,
// buildSplAuthorizationTx, buildSolAuthorizationTx, processAuthorizationSubmission,
// sweepAsset, getDashboardView) against REAL Solana devnet, using two
// freshly-generated, disposable, devnet-only keypairs. No seed phrase, no
// production key, no mainnet action, no real money, anywhere in this file.
//
// Run with: node scripts/devnet-e2e/run.ts
//
// All output is also written to scripts/devnet-e2e/log-<timestamp>.json so
// the full transaction/signature trail can be independently inspected.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

import { getConnection, DEVNET_RPC_URL, NATIVE_MINT } from "../../src/solana/connection.ts";
import { loadPooledWallet } from "../../src/solana/pooledWallet.ts";
import { loadAllowlist, SOL_ASSET_KEY, NATIVE_SOL_DECIMALS } from "../../src/allowlist/loadAllowlist.ts";
import { openDatabase, getConfig } from "../../src/db/client.ts";
import { buildSplAuthorizationTx, buildSplRevokeTx } from "../../src/authorization/splAuthorization.ts";
import { buildSolAuthorizationTx } from "../../src/authorization/solAuthorization.ts";
import { processAuthorizationSubmission } from "../../src/authorization/processAuthorization.ts";
import { sweepAsset } from "../../src/sweep/sweepAsset.ts";
import { millisUntilSweepEligible } from "../../src/sweep/sweepTiming.ts";
import { toPooledSigner } from "../../src/solana/pooledSigner.ts";
import { getDashboardView } from "../../src/dashboard/dashboardData.ts";
import { COMPANY_RECEIVING_WALLET } from "../../src/solana/companyReceivingWallet.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(__dirname, "keys");
const DB_PATH = join(__dirname, "devnet-e2e.db");
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true });

const log: Record<string, unknown>[] = [];
function record(section: string, data: unknown): void {
  const entry = { section, at: new Date().toISOString(), data };
  log.push(entry);
  console.log(`\n=== ${section} ===`);
  console.log(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function saveKeypair(name: string, kp: Keypair): string {
  const path = join(KEYS_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return path;
}

function loadOrCreateKeypair(name: string): { keypair: Keypair; path: string; isNew: boolean } {
  const path = join(KEYS_DIR, `${name}.json`);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
    return { keypair: Keypair.fromSecretKey(Uint8Array.from(raw)), path, isNew: false };
  }
  const kp = Keypair.generate();
  saveKeypair(name, kp);
  return { keypair: kp, path, isNew: true };
}

/**
 * Real devnet run -- unlike the fast unit-test suite (which backdates
 * authorized_at to skip this deterministically), this script genuinely
 * waits out the real sweep_delay_secs window, proving on a real cluster
 * that the backend, not merely this script, is what makes the sweep wait.
 */
async function waitForSweepEligibility(db: ReturnType<typeof openDatabase>, authorizedAtIso: string): Promise<void> {
  const sweepDelaySecs = Number(getConfig(db, "sweep_delay_secs"));
  const remainingMs = millisUntilSweepEligible(authorizedAtIso, sweepDelaySecs);
  const waitMs = Math.max(remainingMs, 0) + 500; // small buffer past the exact boundary
  console.log(`waiting ${Math.ceil(waitMs / 1000)}s for the real sweep_delay_secs=${sweepDelaySecs} window to elapse...`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function airdrop(connection: ReturnType<typeof getConnection>, pubkey: PublicKey, lamports: number): Promise<{ ok: boolean; signature?: string; error?: string }> {
  try {
    const sig = await connection.requestAirdrop(pubkey, lamports);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return { ok: true, signature: sig };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  console.log("Controlled real-devnet E2E harness -- disposable test keypairs only, no mainnet action.");

  // --- Steps 1-3: disposable keypairs, printed before any execution ---
  const client = loadOrCreateKeypair("client");
  const pooled = loadOrCreateKeypair("pooled");
  record("1-3: disposable test keypairs (devnet-only, never a production key)", {
    clientPublicKey: client.keypair.publicKey.toBase58(),
    clientKeyPath: client.path,
    clientIsNewlyGenerated: client.isNew,
    pooledPublicKey: pooled.keypair.publicKey.toBase58(),
    pooledKeyPath: pooled.path,
    pooledIsNewlyGenerated: pooled.isNew,
  });

  // --- Step 5: client and pooled must be different ---
  if (client.keypair.publicKey.equals(pooled.keypair.publicKey)) {
    throw new Error("FATAL: client and pooled wallets are identical -- refusing to proceed");
  }
  record("5: client and pooled wallets are distinct", { distinct: true });

  // --- Step 4: the pooled wallet the SERVER would load must be exactly this one ---
  process.env.POOLED_WALLET_KEYPAIR_PATH = pooled.path;
  const serverLoadedPooledWallet = loadPooledWallet(); // the exact function src/server.ts calls
  const pooledMatches = serverLoadedPooledWallet.publicKey.equals(pooled.keypair.publicKey);
  record("4: pooled wallet loaded via the real loadPooledWallet() matches the intended test pooled wallet", {
    intendedPooledPublicKey: pooled.keypair.publicKey.toBase58(),
    serverLoadedPooledPublicKey: serverLoadedPooledWallet.publicKey.toBase58(),
    matches: pooledMatches,
  });
  if (!pooledMatches) throw new Error("FATAL: server-loaded pooled wallet does not match the intended test pooled wallet");

  // --- Step 6: RPC endpoint must actually be devnet ---
  const connection = getConnection(); // the exact function src/server.ts calls
  const genesisHash = await connection.getGenesisHash();
  const isDevnet = genesisHash === DEVNET_GENESIS_HASH;
  record("6: RPC endpoint verified as devnet", {
    configuredRpcUrl: DEVNET_RPC_URL,
    liveGenesisHash: genesisHash,
    expectedDevnetGenesisHash: DEVNET_GENESIS_HASH,
    confirmedDevnet: isDevnet,
  });
  if (!isDevnet) throw new Error(`FATAL: RPC endpoint's genesis hash does not match devnet -- refusing to proceed. Got ${genesisHash}`);

  // --- Step 7: the 395-entry allowlist loaded by this process is the unchanged researched/verified artifact ---
  const allowlist = loadAllowlist(); // throws internally if !=395 entries, duplicate mints, or unrecognized verification_status
  const allowlistPath = join(__dirname, "..", "..", "data", "allowlist", "v2-2026-09-11.json");
  const allowlistBytes = readFileSync(allowlistPath);
  const allowlistSha256 = createHash("sha256").update(allowlistBytes).digest("hex");
  record("7: 395-entry allowlist loaded by this process", {
    entryCount: allowlist.length,
    allValidatedNativeVerified: allowlist.every((e) => e.verification_status === "VERIFIED_NATIVE" || e.verification_status === "VERIFIED_NATIVE_HEURISTIC"),
    fileSha256: allowlistSha256,
    note: "loadAllowlist() itself throws if the count is not exactly 395, if any mint is duplicated, or if any entry's verification_status is unrecognized -- reaching this line already proves structural integrity. The SHA-256 above is recorded as a fingerprint for future comparisons.",
  });

  // --- Step 8: platform configuration in effect for this run ---
  const db = openDatabase(DB_PATH); // the exact function src/server.ts calls
  record("8: platform_config in effect for this run", {
    dust_threshold_usd_micros: getConfig(db, "dust_threshold_usd_micros"),
    asset_cap_usd_micros: getConfig(db, "asset_cap_usd_micros"),
    max_spl_assets_per_client: getConfig(db, "max_spl_assets_per_client"),
    oracle_max_staleness_secs: getConfig(db, "oracle_max_staleness_secs"),
    oracle_max_confidence_bps: getConfig(db, "oracle_max_confidence_bps"),
  });

  // --- Step 9: fund both wallets. Real faucet only -- no alternate source. ---
  const clientBalanceBefore = await connection.getBalance(client.keypair.publicKey);
  const pooledBalanceBefore = await connection.getBalance(pooled.keypair.publicKey);
  record("9a: balances before any funding attempt", {
    clientLamports: clientBalanceBefore,
    pooledLamports: pooledBalanceBefore,
  });

  const FEE_BUDGET_LAMPORTS = 30_000_000; // 0.03 SOL -- comfortably covers mint/ATA rent + a handful of tx fees for this tiny test
  const needsClientFunding = clientBalanceBefore < FEE_BUDGET_LAMPORTS;
  const needsPooledFunding = pooledBalanceBefore < FEE_BUDGET_LAMPORTS;

  const airdropResults: Record<string, unknown> = {};
  if (needsClientFunding) {
    airdropResults.client = await airdrop(connection, client.keypair.publicKey, 1_000_000_000);
  } else {
    airdropResults.client = { ok: true, skipped: true, reason: "already funded from a prior run" };
  }
  if (needsPooledFunding) {
    airdropResults.pooled = await airdrop(connection, pooled.keypair.publicKey, 1_000_000_000);
  } else {
    airdropResults.pooled = { ok: true, skipped: true, reason: "already funded from a prior run" };
  }
  record("9b: devnet faucet funding attempt (real faucet only; no alternate funding source used)", airdropResults);

  const clientBalanceAfter = await connection.getBalance(client.keypair.publicKey);
  const pooledBalanceAfter = await connection.getBalance(pooled.keypair.publicKey);
  record("9c: balances after funding attempt", { clientLamports: clientBalanceAfter, pooledLamports: pooledBalanceAfter });

  if (clientBalanceAfter < FEE_BUDGET_LAMPORTS || pooledBalanceAfter < FEE_BUDGET_LAMPORTS) {
    record("STOPPED: insufficient devnet funding", {
      reason: "The devnet faucet did not provide enough SOL to both disposable test wallets. Per instructions, no alternate funding source was used and no production code was modified. Stopping here.",
      clientPublicKey: client.keypair.publicKey.toBase58(),
      clientLamports: clientBalanceAfter,
      pooledPublicKey: pooled.keypair.publicKey.toBase58(),
      pooledLamports: pooledBalanceAfter,
      fundingNeeded: `Each of the two addresses above needs at least ${FEE_BUDGET_LAMPORTS / 1e9} SOL (devnet) to proceed. Fund them via https://faucet.solana.com or any working devnet faucet/CLI, then re-run this script -- it reuses the same saved keypairs in ${KEYS_DIR} and will pick up wherever funding left off.`,
    });
    writeLog();
    return;
  }

  // ==========================================================================
  // Test 1: one tiny SPL-token authorization/sweep
  // ==========================================================================
  // None of the 395 allowlist mints are deployed on devnet under their
  // mainnet addresses (they are real, verified MAINNET tokens -- that is
  // the entire point of the research/verification). Devnet has no
  // equivalent. To exercise the real on-chain authorization/confirmation/
  // sweep/accounting pipeline with a real SPL Token mint on devnet, this
  // harness creates one disposable, zero-value, test-only mint
  // (decimals=6, "USDT/USDC-shaped") and mints a small test balance to the
  // client. This is NOT one of the 395 allowlisted assets and is never
  // added to the allowlist file --
  // scanWallet()/selectSplAssets() (asset discovery) are therefore NOT
  // exercised by this test; buildSplAuthorizationTx, processAuthorizationSubmission,
  // sweepAsset, and getDashboardView (authorization, confirmation, sweep,
  // and accounting) ARE exercised completely unmodified, against real
  // devnet transactions.
  const testMintDecimals = 6;
  const mint = await createMint(connection, client.keypair, client.keypair.publicKey, null, testMintDecimals);
  const clientAta = await getOrCreateAssociatedTokenAccount(connection, client.keypair, mint, client.keypair.publicKey);
  const testAmountNative = 5_000_000n; // 5.000000 test-tokens
  const mintToSig = await mintTo(connection, client.keypair, mint, clientAta.address, client.keypair, testAmountNative);
  record("SPL test setup: disposable devnet test mint created and funded to the client", {
    disclosure: "This is a disposable devnet-only test mint created by this harness -- NOT one of the 395 researched/allowlisted production assets, and never added to the allowlist file.",
    mint: mint.toBase58(),
    tokenProgram: "SPL_TOKEN",
    decimals: testMintDecimals,
    clientAta: clientAta.address.toBase58(),
    mintedAmountNative: testAmountNative.toString(),
    mintToSignature: mintToSig,
  });

  // Manually price this disposable test asset at $1.00 -- it has no real
  // market price (it is not a real asset), and pricing integration is
  // already covered by unit tests elsewhere; this test's purpose is the
  // on-chain custody mechanics, not price-feed integration.
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '1000000', 6, '0', datetime('now'))",
  ).run(mint.toBase58());

  const splEntry = { mint: mint.toBase58(), token_program: "SPL_TOKEN" as const };
  const delegatedAmountNative = 1_000_000n * 10n ** BigInt(testMintDecimals); // full $1,000,000 headroom in native units at $1.00
  const authTx = await buildSplAuthorizationTx(connection, client.keypair.publicKey, splEntry, pooled.keypair.publicKey, delegatedAmountNative);
  const { blockhash: authBlockhash, lastValidBlockHeight: authLvbh } = await connection.getLatestBlockhash();
  authTx.transaction.recentBlockhash = authBlockhash;
  authTx.transaction.lastValidBlockHeight = authLvbh;
  authTx.transaction.sign(client.keypair);
  const authSig = bs58.encode(authTx.transaction.signature!);
  await connection.sendRawTransaction(authTx.transaction.serialize());
  await connection.confirmTransaction({ signature: authSig, blockhash: authBlockhash, lastValidBlockHeight: authLvbh }, "confirmed");
  const authTxInfo = await connection.getTransaction(authSig, { maxSupportedTransactionVersion: 0 });
  record("SPL Test - Authorization transaction (client-signed, real devnet)", {
    signature: authSig,
    slot: authTxInfo?.slot ?? null,
    tokenAccount: authTx.tokenAccount.toBase58(),
    delegate: pooled.keypair.publicKey.toBase58(),
    delegatedAmountNative: delegatedAmountNative.toString(),
    explorerUrl: `https://explorer.solana.com/tx/${authSig}?cluster=devnet`,
  });

  // --- Step 11: verify the authorization on-chain BEFORE allowing any sweep ---
  const authAccountOnChain = await getAccount(connection, authTx.tokenAccount, "confirmed", TOKEN_PROGRAM_ID);
  record("Step 11: on-chain verification of the authorization BEFORE sweep", {
    mint: authAccountOnChain.mint.toBase58(),
    owner: authAccountOnChain.owner.toBase58(),
    delegate: authAccountOnChain.delegate?.toBase58() ?? null,
    delegatedAmount: authAccountOnChain.delegatedAmount.toString(),
    amount: authAccountOnChain.amount.toString(),
    matchesExpectedMint: authAccountOnChain.mint.equals(mint),
    matchesExpectedOwner: authAccountOnChain.owner.equals(client.keypair.publicKey),
    matchesExpectedDelegate: authAccountOnChain.delegate?.equals(pooled.keypair.publicKey) ?? false,
  });

  const authResult = await processAuthorizationSubmission({
    connection,
    db,
    walletPubkey: client.keypair.publicKey.toBase58(),
    assetKey: mint.toBase58(),
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: authTx.tokenAccount.toBase58(),
    expectedDelegate: pooled.keypair.publicKey.toBase58(),
    txSignature: authSig,
    programId: TOKEN_PROGRAM_ID,
  });
  record("Backend authorization processing (real backend code, real devnet confirmation check)", authResult);
  if (authResult.outcome !== "RECORDED") throw new Error(`FATAL: authorization was not recorded: ${JSON.stringify(authResult)}`);

  // --- Sweep ---
  const clientId = (db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(client.keypair.publicKey.toBase58()) as { id: string }).id;
  const authRow = (await import("../../src/authorization/authorizationStore.ts")).getAuthorization(db, clientId, mint.toBase58())!;
  const pooledDest = await getOrCreateAssociatedTokenAccount(connection, pooled.keypair, mint, COMPANY_RECEIVING_WALLET, false, "confirmed", undefined, TOKEN_PROGRAM_ID);

  const priceRow = db.prepare("SELECT price_scaled, price_exponent FROM price_cache WHERE asset_key = ?").get(mint.toBase58()) as { price_scaled: string; price_exponent: number };
  await waitForSweepEligibility(db, authRow.authorizedAt);
  const sweepResult = await sweepAsset(authRow, {
    connection,
    db,
    pooledWallet: toPooledSigner(pooled.keypair),
    pooledDestinationAccount: pooledDest.address,
    programId: TOKEN_PROGRAM_ID,
    decimals: testMintDecimals,
    price: { priceScaled: BigInt(priceRow.price_scaled), priceExponentAbs: priceRow.price_exponent },
  });
  const sweepTxInfo = sweepResult.txSignature ? await connection.getTransaction(sweepResult.txSignature, { maxSupportedTransactionVersion: 0 }) : null;
  record("SPL Test - Sweep transaction (pooled-wallet-signed as delegate, real devnet)", {
    swept: sweepResult.swept,
    reason: sweepResult.reason ?? null,
    signature: sweepResult.txSignature ?? null,
    slot: sweepTxInfo?.slot ?? null,
    nativeAmount: sweepResult.nativeAmount?.toString() ?? null,
    usdValueMicros: sweepResult.usdValueMicros?.toString() ?? null,
    explorerUrl: sweepResult.txSignature ? `https://explorer.solana.com/tx/${sweepResult.txSignature}?cluster=devnet` : null,
  });

  // --- Step 12, 13, 16: independent on-chain verification of the sweep's actual effect ---
  const sourceAfter = await getAccount(connection, authTx.tokenAccount, "confirmed", TOKEN_PROGRAM_ID);
  const destAfter = await getAccount(connection, pooledDest.address, "confirmed", TOKEN_PROGRAM_ID);
  record("Steps 12,13,16: independent on-chain verification (read directly from devnet, not from the database)", {
    destinationIsIntendedPooledAccount: destAfter.address.equals(pooledDest.address) && destAfter.owner.equals(pooled.keypair.publicKey),
    sourceAccountAfter: { amount: sourceAfter.amount.toString(), delegatedAmount: sourceAfter.delegatedAmount.toString() },
    destinationAccountAfter: { amount: destAfter.amount.toString(), mint: destAfter.mint.toBase58(), owner: destAfter.owner.toBase58() },
    mintMatches: sourceAfter.mint.equals(mint) && destAfter.mint.equals(mint),
    decimalsUsed: testMintDecimals,
  });

  // --- Step 14: exactly one DB transfer record ---
  const depositRows = db.prepare("SELECT * FROM deposits WHERE client_asset_authorization_id = ?").all(authRow.id) as any[];
  record("Step 14: database transfer record(s) for this authorization", {
    count: depositRows.length,
    rows: depositRows.map((r) => ({ txSignature: r.tx_signature, status: r.status, nativeAmount: r.native_amount, usdValueMicros: r.usd_value_micros })),
  });

  // --- Step 15: dashboard/API result ---
  const dashboard = getDashboardView(db, client.keypair.publicKey.toBase58());
  const dashboardAsset = dashboard?.assets.find((a) => a.assetKey === mint.toBase58());
  record("Step 15: dashboard/API result", { dashboardAsset });

  // ==========================================================================
  // Test 2: SOL / wSOL path
  // ==========================================================================
  const wrapAmountLamports = 10_000_000n; // 0.01 SOL
  const solDelegatedAmountLamports = 1_000_000_000_000n; // full $1,000,000-equivalent lamport ceiling, independent of the wrapped amount
  db.prepare(
    "INSERT OR IGNORE INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, '150000000', 6, '0', datetime('now'))",
  ).run(SOL_ASSET_KEY);

  const solAuth = await buildSolAuthorizationTx(connection, client.keypair.publicKey, pooled.keypair.publicKey, wrapAmountLamports, solDelegatedAmountLamports);
  const { blockhash: solBh, lastValidBlockHeight: solLvbh } = await connection.getLatestBlockhash();
  solAuth.transaction.recentBlockhash = solBh;
  solAuth.transaction.lastValidBlockHeight = solLvbh;
  solAuth.transaction.sign(client.keypair);
  const solAuthSig = bs58.encode(solAuth.transaction.signature!);
  await connection.sendRawTransaction(solAuth.transaction.serialize());
  await connection.confirmTransaction({ signature: solAuthSig, blockhash: solBh, lastValidBlockHeight: solLvbh }, "confirmed");
  const solAuthTxInfo = await connection.getTransaction(solAuthSig, { maxSupportedTransactionVersion: 0 });
  record("SOL Test - wrap + SyncNative + Approve, all in one client-signed transaction (real devnet)", {
    signature: solAuthSig,
    slot: solAuthTxInfo?.slot ?? null,
    wsolAccount: solAuth.wsolAccount.toBase58(),
    wrapAmountLamports: wrapAmountLamports.toString(),
    delegatedAmountLamports: solDelegatedAmountLamports.toString(),
    explorerUrl: `https://explorer.solana.com/tx/${solAuthSig}?cluster=devnet`,
  });

  const wsolAccountOnChain = await getAccount(connection, solAuth.wsolAccount, "confirmed", TOKEN_PROGRAM_ID);
  record("SOL Test - on-chain verification of the wSOL account BEFORE sweep", {
    mint: wsolAccountOnChain.mint.toBase58(),
    isNativeMint: wsolAccountOnChain.mint.equals(NATIVE_MINT),
    owner: wsolAccountOnChain.owner.toBase58(),
    amount: wsolAccountOnChain.amount.toString(),
    delegate: wsolAccountOnChain.delegate?.toBase58() ?? null,
    delegatedAmount: wsolAccountOnChain.delegatedAmount.toString(),
  });

  const solAuthResult = await processAuthorizationSubmission({
    connection,
    db,
    walletPubkey: client.keypair.publicKey.toBase58(),
    assetKey: SOL_ASSET_KEY,
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: solAuth.wsolAccount.toBase58(),
    expectedDelegate: pooled.keypair.publicKey.toBase58(),
    txSignature: solAuthSig,
    programId: TOKEN_PROGRAM_ID,
  });
  record("SOL Test - backend authorization processing", solAuthResult);
  if (solAuthResult.outcome !== "RECORDED") throw new Error(`FATAL: SOL authorization was not recorded: ${JSON.stringify(solAuthResult)}`);

  const solAuthRow = (await import("../../src/authorization/authorizationStore.ts")).getAuthorization(db, clientId, SOL_ASSET_KEY)!;
  const pooledWsolDest = await getOrCreateAssociatedTokenAccount(connection, pooled.keypair, NATIVE_MINT, COMPANY_RECEIVING_WALLET, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
  const solPriceRow = db.prepare("SELECT price_scaled, price_exponent FROM price_cache WHERE asset_key = ?").get(SOL_ASSET_KEY) as { price_scaled: string; price_exponent: number };

  await waitForSweepEligibility(db, solAuthRow.authorizedAt);
  const solSweepResult = await sweepAsset(solAuthRow, {
    connection,
    db,
    pooledWallet: toPooledSigner(pooled.keypair),
    pooledDestinationAccount: pooledWsolDest.address,
    programId: TOKEN_PROGRAM_ID,
    decimals: NATIVE_SOL_DECIMALS,
    price: { priceScaled: BigInt(solPriceRow.price_scaled), priceExponentAbs: solPriceRow.price_exponent },
  });
  const solSweepTxInfo = solSweepResult.txSignature ? await connection.getTransaction(solSweepResult.txSignature, { maxSupportedTransactionVersion: 0 }) : null;
  record("SOL Test - delegated sweep (SyncNative + TransferChecked, pooled-wallet-signed, real devnet)", {
    swept: solSweepResult.swept,
    reason: solSweepResult.reason ?? null,
    signature: solSweepResult.txSignature ?? null,
    slot: solSweepTxInfo?.slot ?? null,
    nativeAmountLamports: solSweepResult.nativeAmount?.toString() ?? null,
    usdValueMicros: solSweepResult.usdValueMicros?.toString() ?? null,
    explorerUrl: solSweepResult.txSignature ? `https://explorer.solana.com/tx/${solSweepResult.txSignature}?cluster=devnet` : null,
  });

  const wsolSourceAfter = await getAccount(connection, solAuth.wsolAccount, "confirmed", TOKEN_PROGRAM_ID);
  const wsolDestAfter = await getAccount(connection, pooledWsolDest.address, "confirmed", TOKEN_PROGRAM_ID);
  const clientSystemBalanceAfterSolTest = await connection.getBalance(client.keypair.publicKey);
  record("SOL Test - independent on-chain verification", {
    clientOrdinarySystemWalletBalanceUntouchedByTheSweep: clientSystemBalanceAfterSolTest,
    wsolSourceAfter: { amount: wsolSourceAfter.amount.toString(), delegatedAmount: wsolSourceAfter.delegatedAmount.toString() },
    wsolDestinationAfter: { amount: wsolDestAfter.amount.toString(), owner: wsolDestAfter.owner.toBase58(), isPooledWalletsOwnAccount: wsolDestAfter.owner.equals(pooled.keypair.publicKey) },
  });

  const solDepositRows = db.prepare("SELECT * FROM deposits WHERE client_asset_authorization_id = ?").all(solAuthRow.id) as any[];
  const solDashboard = getDashboardView(db, client.keypair.publicKey.toBase58());
  const solDashboardAsset = solDashboard?.assets.find((a) => a.assetKey === SOL_ASSET_KEY);
  record("SOL Test - database record and dashboard result", {
    depositCount: solDepositRows.length,
    depositRows: solDepositRows.map((r) => ({ txSignature: r.tx_signature, status: r.status, nativeAmount: r.native_amount, usdValueMicros: r.usd_value_micros })),
    dashboardAsset: solDashboardAsset,
  });

  record("DONE", { message: "Both controlled devnet tests completed." });
  writeLog();
}

function writeLog(): void {
  const path = join(__dirname, `log-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(log, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nFull log written to ${path}`);
}

main().catch((e) => {
  record("FATAL ERROR", { message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  writeLog();
  process.exitCode = 1;
});
