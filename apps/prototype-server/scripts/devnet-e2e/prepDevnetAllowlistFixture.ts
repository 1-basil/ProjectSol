// Prep step for eightAssetsOneSignature.ts. Generates (or reuses) 8 stable
// disposable devnet test-mint keypairs and writes a SEPARATE, EPHEMERAL,
// fully-valid 395-entry allowlist fixture file that references their
// public keys -- so that processAuthorizationSubmission's real,
// unweakened ASSET_NOT_ALLOWLISTED check can be satisfied by disposable
// devnet mints, without ever touching or modifying the real production
// allowlist (data/allowlist/v2-2026-09-11.json, which this script only
// READS, to copy 387 of its untouched entries into the fixture and pad it
// out to a structurally valid 395).
//
// Run this BEFORE eightAssetsOneSignature.ts, then run that script with
// ALLOWLIST_VERSION_OVERRIDE=devnet-test-fixture-EPHEMERAL set (see
// run-eight-assets.sh). See src/allowlist/loadAllowlist.ts's comment on
// DEFAULT_ALLOWLIST_VERSION for why this env var exists and what it does
// and does not change.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(__dirname, "keys");
const REAL_ALLOWLIST_PATH = join(__dirname, "..", "..", "data", "allowlist", "v2-2026-09-11.json");
const FIXTURE_ALLOWLIST_PATH = join(__dirname, "..", "..", "data", "allowlist", "devnet-test-fixture-EPHEMERAL.json");

const NUM_TEST_MINTS = 8;

if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true });

function loadOrCreateTestMintKeypair(index: number): Keypair {
  const path = join(KEYS_DIR, `testmint-${index}.json`);
  if (existsSync(path)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

const testMints = Array.from({ length: NUM_TEST_MINTS }, (_, i) => loadOrCreateTestMintKeypair(i));

const realAllowlist = JSON.parse(readFileSync(REAL_ALLOWLIST_PATH, "utf8"));
if (realAllowlist.length !== 395) throw new Error(`FATAL: real allowlist does not have 395 entries (${realAllowlist.length}) -- refusing to build a fixture from unexpected data`);

// Keep 387 of the real entries UNCHANGED (this is purely to satisfy
// loadAllowlist()'s own "exactly 395 entries" structural check -- these
// 387 real mainnet entries are never used by this devnet test since none
// of them exist on devnet), and replace the last 8 slots with our
// disposable devnet test mints.
const fixture = [
  ...realAllowlist.slice(0, 395 - NUM_TEST_MINTS),
  ...testMints.map((kp, i) => ({
    rank: 999 + i,
    symbol: `DEVTEST${i + 1}`,
    name: `Devnet Test Fixture Asset ${i + 1} (NOT a real asset -- see scripts/devnet-e2e/prepDevnetAllowlistFixture.ts)`,
    mint: kp.publicKey.toBase58(),
    decimals: 6,
    token_program: "SPL_TOKEN",
    market_cap_usd: 0,
    verification_status: "VERIFIED_NATIVE", // required by loadAllowlist()'s structural check; this is a disposable devnet-only test mint this same harness creates and controls, not a claim about any real asset
    evidence: "EPHEMERAL DEVNET TEST FIXTURE -- created by scripts/devnet-e2e/prepDevnetAllowlistFixture.ts, never part of the real 160-token research artifact, never committed.",
    allowlist_version: "devnet-test-fixture-EPHEMERAL",
    snapshot_at: new Date().toISOString(),
  })),
];

const mintSet = new Set(fixture.map((e: any) => e.mint));
if (mintSet.size !== 395) throw new Error("FATAL: fixture has duplicate mints");

writeFileSync(FIXTURE_ALLOWLIST_PATH, JSON.stringify(fixture, null, 2));
console.log(`Wrote ${FIXTURE_ALLOWLIST_PATH}`);
console.log("Test mint public keys:", testMints.map((kp) => kp.publicKey.toBase58()));
