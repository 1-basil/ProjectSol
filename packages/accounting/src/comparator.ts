// Canonical allocation comparator. Normatively specified in
// docs/specs/comparator-spec.md §1/§2/§5. PRIMARY: usd_value descending.
// TIE-BREAK: raw 32-byte mint pubkey, unsigned lexicographic ascending.
// Never Base58, never symbol/name/category, never input/RPC/map/DB iteration
// order. A comparator returning "equal" for two distinct mints is a bug
// (duplicate mint in the input) and must fail loudly — see compareAssets.

import type { UsdMicros } from "./usd-micros.ts";

export const MINT_LENGTH_BYTES = 32;

export interface RankableAsset {
  readonly mint: Uint8Array;
  readonly usdValue: UsdMicros;
}

/**
 * Unsigned lexicographic byte comparison of two 32-byte mint pubkeys. The
 * first differing byte decides. This is deliberately NOT Base58 comparison —
 * Base58's alphabet omits 0/O/I/l and is not monotonic with respect to raw
 * byte order, so Base58-sorted and byte-sorted mint lists can disagree. See
 * docs/specs/comparator-spec.md §2.
 */
export function compareMintBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== MINT_LENGTH_BYTES || b.length !== MINT_LENGTH_BYTES) {
    throw new RangeError(
      `compareMintBytes: mint must be exactly ${MINT_LENGTH_BYTES} bytes`,
    );
  }
  for (let i = 0; i < MINT_LENGTH_BYTES; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The canonical comparator. Throws if two distinct-position entries would
 * compare equal (i.e., the same mint appears twice in the input) — per
 * docs/specs/comparator-spec.md §5, this must never silently fall through to
 * whatever order the underlying sort happens to produce.
 */
export function compareAssets(a: RankableAsset, b: RankableAsset): number {
  if (a.usdValue > b.usdValue) return -1;
  if (a.usdValue < b.usdValue) return 1;

  const tie = compareMintBytes(a.mint, b.mint);
  if (tie === 0) {
    throw new Error(
      "compareAssets: two entries with identical usd_value AND identical mint — " +
        "duplicate mint in input, which the comparator's totality requirement forbids",
    );
  }
  return tie;
}

/**
 * Ranks assets per the canonical comparator. Uses a stable sort
 * (Array.prototype.sort is specified as stable in modern engines, and the
 * comparator's own totality assertion is the real guarantee regardless —
 * see docs/specs/comparator-spec.md §5).
 */
export function rankAssets<T extends RankableAsset>(assets: readonly T[]): T[] {
  return [...assets].sort(compareAssets);
}
