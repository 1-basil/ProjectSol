// Cache-first price lookup. CoinGecko's free tier is rate-limited to a
// handful of requests per minute (verified empirically during allowlist
// research), so every price consumer MUST go through this, never call
// pricing.ts directly.

import type { DatabaseSync } from "node:sqlite";
import type { OraclePrice } from "@platform/accounting";
import { fetchSolPrice, fetchTokenPriceByMint } from "./pricing.ts";
import { getConfig } from "../db/client.ts";
import { SOL_ASSET_KEY } from "../allowlist/loadAllowlist.ts";

export interface CachedPrice {
  readonly price: OraclePrice;
  readonly fetchedAtUnixSecs: number;
  readonly fromCache: boolean;
}

/**
 * Returns a fresh-enough price for `assetKey` (a mint, or SOL_ASSET_KEY),
 * fetching live only if the cached value is missing or older than
 * `oracle_max_staleness_secs`. This does NOT itself reject a stale price —
 * it always returns the best available value with `fromCache`/age visible;
 * `validatePriceForCapCheck` (below) is the actual accept/reject gate,
 * mirroring the staleness/confidence split already established for the
 * on-chain oracle design.
 */
export async function getPrice(db: DatabaseSync, assetKey: string): Promise<CachedPrice> {
  const maxStalenessSecs = Number(getConfig(db, "oracle_max_staleness_secs"));
  const nowSecs = Math.floor(Date.now() / 1000);

  const row = db
    .prepare("SELECT price_scaled, price_exponent, fetched_at FROM price_cache WHERE asset_key = ?")
    .get(assetKey) as { price_scaled: string; price_exponent: number; fetched_at: string } | undefined;

  if (row) {
    const fetchedAtUnixSecs = Math.floor(new Date(row.fetched_at + "Z").getTime() / 1000);
    if (nowSecs - fetchedAtUnixSecs <= maxStalenessSecs) {
      return {
        price: { priceScaled: BigInt(row.price_scaled), priceExponentAbs: row.price_exponent },
        fetchedAtUnixSecs,
        fromCache: true,
      };
    }
  }

  const quote = assetKey === SOL_ASSET_KEY ? await fetchSolPrice() : await fetchTokenPriceByMint(assetKey);
  db.prepare(
    "INSERT INTO price_cache (asset_key, price_scaled, price_exponent, confidence_scaled, fetched_at) VALUES (?, ?, ?, ?, datetime(?, 'unixepoch')) " +
      "ON CONFLICT(asset_key) DO UPDATE SET price_scaled = excluded.price_scaled, price_exponent = excluded.price_exponent, confidence_scaled = excluded.confidence_scaled, fetched_at = excluded.fetched_at",
  ).run(
    assetKey,
    quote.price.priceScaled.toString(),
    quote.price.priceExponentAbs,
    "0", // CoinGecko's simple price API carries no confidence interval; recorded as 0 (see validatePriceForCapCheck's note)
    quote.fetchedAtUnixSecs,
  );

  return { price: quote.price, fetchedAtUnixSecs: quote.fetchedAtUnixSecs, fromCache: false };
}

/**
 * The actual accept/reject gate before a price is used in any cap decision.
 * Only staleness is enforced here — CoinGecko's simple price API has no
 * confidence-interval concept the way Pyth does, so the confidence check
 * from the on-chain design does not carry over; this is a real, disclosed
 * reduction in price-quality assurance relative to that design, acceptable
 * for a prototype using a different (off-chain, broader-coverage) price
 * source by necessity — see pricing.ts's header.
 */
export function isPriceFreshEnough(cached: CachedPrice, maxStalenessSecs: number, nowUnixSecs: number): boolean {
  return nowUnixSecs - cached.fetchedAtUnixSecs <= maxStalenessSecs && cached.price.priceScaled > 0n;
}
