// Loads the versioned allowlist. This module never modifies, re-derives, or
// re-ranks that data — it only reads the versioned snapshot file.
//
// Two verification tiers coexist in v2-2026-09-11.json, both real and both
// disclosed, never conflated:
//   - VERIFIED_NATIVE (ranks 2-161, the original 160): individually
//     hand-researched, each entry's `evidence` field cites issuer
//     documentation or equivalent primary-source confirmation of native
//     (non-bridged) Solana issuance.
//   - VERIFIED_NATIVE_HEURISTIC (ranks 162-396, 235 entries): tool-assisted
//     — real live market-cap ranking and holder/organic-trading-score data
//     from Jupiter's token API, filtered to organicScore >= 50 and no
//     bridged/wrapped naming pattern, plus a narrow manual content-safety
//     pass. Native issuance is inferred (absence of bridge-program
//     association), not individually confirmed with issuer documentation
//     the way the original 160 were — a genuinely lower assurance tier,
//     not equivalent rigor dressed up as the same thing.
//
// SOL is represented separately here (constants.SOL_ASSET_KEY) since it was
// never part of the SPL mint list — it's the native asset, handled by its
// own wSOL authorization path (see src/authorization/solAuthorization.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SOL_ASSET_KEY = "SOL";
export const NATIVE_SOL_DECIMALS = 9;

export interface AllowlistEntry {
  readonly rank: number;
  readonly symbol: string;
  readonly name: string;
  readonly mint: string;
  readonly decimals: number;
  readonly token_program: "SPL_TOKEN" | "TOKEN_2022";
  readonly market_cap_usd: number;
  readonly verification_status: string;
  readonly evidence: string;
  readonly allowlist_version: string;
  readonly snapshot_at: string;
}

let cached: AllowlistEntry[] | null = null;

// Every real call site in this codebase calls loadAllowlist() with no
// argument, so this constant is what actually governs production
// behavior. It reads an override env var ONLY so that isolated,
// non-production test tooling (a devnet harness that must use disposable
// devnet-only mints, since none of the real mainnet mints exist on
// devnet) can point the DEFAULT at a separate, equally-valid fixture file
// -- never at fewer entries, never at a relaxed check, and never touching
// this file: v2-2026-09-11.json itself. The env var is unset in every real
// deployment and in every test in test/, so this changes nothing about
// production or CI behavior.
const DEFAULT_ALLOWLIST_VERSION = process.env.ALLOWLIST_VERSION_OVERRIDE || "v2-2026-09-11";

// The two disclosed verification tiers this file's entries are allowed to
// carry -- see the module header. Anything else fails closed.
const VALID_VERIFICATION_STATUSES = new Set(["VERIFIED_NATIVE", "VERIFIED_NATIVE_HEURISTIC"]);
const EXPECTED_ENTRY_COUNT = 395;

/** Loads and validates the versioned allowlist snapshot. Cached in-process — this data is fixed for the process lifetime. */
export function loadAllowlist(
  version = DEFAULT_ALLOWLIST_VERSION,
): readonly AllowlistEntry[] {
  if (cached) return cached;
  const path = join(__dirname, "..", "..", "data", "allowlist", `${version}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as AllowlistEntry[];
  if (raw.length !== EXPECTED_ENTRY_COUNT) {
    throw new Error(`loadAllowlist: expected exactly ${EXPECTED_ENTRY_COUNT} entries, got ${raw.length}`);
  }
  const mints = new Set<string>();
  for (const entry of raw) {
    if (mints.has(entry.mint)) {
      throw new Error(`loadAllowlist: duplicate mint ${entry.mint} in ${version}`);
    }
    mints.add(entry.mint);
    if (!VALID_VERIFICATION_STATUSES.has(entry.verification_status)) {
      throw new Error(`loadAllowlist: entry ${entry.symbol} has unrecognized verification_status ${entry.verification_status}`);
    }
  }
  cached = raw;
  return raw;
}

export function findAllowlistEntryByMint(
  mint: string,
  version?: string,
): AllowlistEntry | undefined {
  return loadAllowlist(version).find((e) => e.mint === mint);
}

/** Exposed for tests only, to reset the module-level cache between test files that load different fixture data. */
export function _resetAllowlistCacheForTests(): void {
  cached = null;
}
