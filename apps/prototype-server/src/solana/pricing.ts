// USD pricing for the backend's live cap/selection checks. Deliberately
// CoinGecko's contract-address price API, not the on-chain Pyth adapter
// built for the (currently shelved) Anchor program — see
// docs/PHASE-3-ORACLE-INTEGRATION-DESIGN.md's reasoning for why an
// off-chain price lookup is simpler for a backend service, and this
// prototype's practical need to price all 395 allowlisted tokens, most of
// which have no Pyth feed at all (Pyth was verified to exist and work for
// on-chain use in the shelved design; it does not cover this allowlist's
// long tail).
//
// CoinGecko's free tier allows exactly ONE contract address per request
// (verified empirically — batching returns error_code 10012) and is
// rate-limited; callers MUST go through the cache in src/db, never call
// this directly in a hot loop.
//
// Float-safety note: CoinGecko's wire response is a JSON *number* for the
// price field, which this project's convention (monetary-representation.md
// §7) treats as an already-corrupted representation for anything
// authoritative — a JSON number is parsed by any generic `.json()` call as
// an IEEE-754 float64 before application code ever sees it. Since this is a
// third-party API whose wire format is outside this project's control, the
// most rigorous available mitigation is applied: the raw response TEXT is
// regex-extracted for the price field as a STRING before any JSON.parse
// touches that field, then converted to a scaled bigint via pure string
// arithmetic (decimalStringToScaled below) — never via Number()/parseFloat.

import type { OraclePrice } from "@platform/accounting";

const PRICE_EXPONENT = 8; // matches this project's existing Pyth-style OraclePrice convention

export interface PriceQuote {
  readonly price: OraclePrice;
  readonly fetchedAtUnixSecs: number;
}

/** Exact decimal-string -> scaled-bigint conversion. No float ever constructed. */
export function decimalStringToScaled(decimalStr: string, exponent: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(decimalStr)) {
    throw new Error(`decimalStringToScaled: not a plain non-negative decimal: ${decimalStr}`);
  }
  const [intPart, fracPart = ""] = decimalStr.split(".");
  const fracPadded = (fracPart + "0".repeat(exponent)).slice(0, exponent);
  const combined = (intPart + fracPadded).replace(/^0+(?=\d)/, "");
  return BigInt(combined);
}

/**
 * Converts a decimal string that may be in scientific notation (CoinGecko
 * uses it for very low-priced tokens -- verified empirically against
 * BONK's real API response: "usd":2.76e-06) into an exact plain decimal
 * string ("0.00000276"), via pure digit-string manipulation -- never
 * Number()/parseFloat() on the price itself, preserving this file's
 * no-float policy. decimalStringToScaled above only accepts plain decimal
 * strings; this is what lets it accept CoinGecko's actual wire format for
 * low-priced tokens instead of throwing on it.
 *
 * parseInt is used only on the EXPONENT (always a small integer, e.g. -6
 * or +10) -- exact and lossless for any realistic exponent, unlike
 * parsing the monetary value itself, which this function never does.
 */
export function normalizeScientificNotation(raw: string): string {
  const match = raw.match(/^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new Error(`normalizeScientificNotation: not a valid decimal/scientific number: ${raw}`);
  const [, intPart, fracPart = "", expStr] = match;
  if (!expStr) return fracPart ? `${intPart}.${fracPart}` : intPart;

  const exponent = parseInt(expStr, 10);
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exponent;

  if (pointPos <= 0) {
    return `0.${"0".repeat(-pointPos)}${digits}`;
  }
  if (pointPos >= digits.length) {
    return `${digits}${"0".repeat(pointPos - digits.length)}`;
  }
  return `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

const SOLANA_TOKEN_PRICE_URL = "https://api.coingecko.com/api/v3/simple/token_price/solana";
const SIMPLE_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";

// Neither fetch() call had a timeout before this -- a hung connection would
// block whatever awaited it (a wallet scan, an indexer sweep pass)
// indefinitely. Bounded here so a stalled third-party dependency can never
// stall this process; callers still see a normal thrown error either way,
// so this changes nothing about fail-closed behavior, only its worst-case
// latency.
const PRICE_FETCH_TIMEOUT_MS = 5_000;

function extractUsdField(rawJsonText: string, topLevelKey: string): { usdStr: string; lastUpdatedAt: number } {
  // Matches: "<topLevelKey>":{"usd":<digits[.digits][e[+-]digits]>,"last_updated_at":<digits>}
  // Anchored to the specific key so this can't accidentally grab a sibling
  // entry's price in a (currently unused, single-key) multi-entry response.
  // The optional [eE][+-]?\d+ suffix is required for CoinGecko's own wire
  // format on very low-priced tokens (e.g. BONK: "usd":2.76e-06) -- without
  // it, this regex simply fails to match and the price fetch throws,
  // silently excluding any sufficiently low-priced allowlisted asset from
  // every scan (verified: this was happening for BONK on real mainnet
  // data before this fix).
  const escapedKey = topLevelKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`"${escapedKey}"\\s*:\\s*\\{\\s*"usd"\\s*:\\s*(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\s*,\\s*"last_updated_at"\\s*:\\s*(\\d+)`);
  const match = rawJsonText.match(re);
  if (!match) throw new Error(`extractUsdField: no usd/last_updated_at field found for key "${topLevelKey}"`);
  return { usdStr: normalizeScientificNotation(match[1]!), lastUpdatedAt: Number(match[2]) };
}

/** Fetches a live price for one SPL/Token-2022 mint. One HTTP call — callers must cache. */
export async function fetchTokenPriceByMint(mint: string): Promise<PriceQuote> {
  const url = `${SOLANA_TOKEN_PRICE_URL}?contract_addresses=${mint}&vs_currencies=usd&include_last_updated_at=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(PRICE_FETCH_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`fetchTokenPriceByMint(${mint}): HTTP ${res.status}: ${text}`);
  const { usdStr } = extractUsdField(text, mint);
  return {
    price: { priceScaled: decimalStringToScaled(usdStr, PRICE_EXPONENT), priceExponentAbs: PRICE_EXPONENT },
    // The staleness gate (isPriceFreshEnough) exists to answer "is OUR
    // cached copy stale", not "is CoinGecko's own upstream snapshot
    // stale" -- those are different questions. CoinGecko's own
    // last_updated_at routinely lags real time by more than this
    // project's oracle_max_staleness_secs even on a fresh, successful
    // fetch (verified empirically), which made every price look stale
    // the instant it was cached. The local fetch time is what actually
    // answers the question this timestamp is used for.
    fetchedAtUnixSecs: Math.floor(Date.now() / 1000),
  };
}

/** Fetches a live price for native SOL. One HTTP call — callers must cache. */
export async function fetchSolPrice(): Promise<PriceQuote> {
  const url = `${SIMPLE_PRICE_URL}?ids=solana&vs_currencies=usd&include_last_updated_at=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(PRICE_FETCH_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`fetchSolPrice: HTTP ${res.status}: ${text}`);
  const { usdStr } = extractUsdField(text, "solana");
  return {
    price: { priceScaled: decimalStringToScaled(usdStr, PRICE_EXPONENT), priceExponentAbs: PRICE_EXPONENT },
    fetchedAtUnixSecs: Math.floor(Date.now() / 1000),
  };
}
