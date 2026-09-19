// Deposit-allocation ranking and cutoff. Normatively specified in
// docs/specs/allocation-spec.md.

import { type UsdMicros, usdMicros, ZERO_USD } from "./usd-micros.ts";
import { type RankableAsset, rankAssets } from "./comparator.ts";

export interface AllocationEntry {
  readonly mint: Uint8Array;
  readonly usdValue: UsdMicros;
  readonly rank: number;
  readonly allocatedUsd: UsdMicros;
  readonly unallocatedUsd: UsdMicros;
}

/**
 * Ranks assets (docs/specs/comparator-spec.md §1) and allocates down the
 * ranked list until headroom is exhausted (docs/specs/allocation-spec.md
 * §1-§3). The boundary asset receives only the remaining headroom; the rest
 * of its value is unallocated (excess — see docs/specs/excess-return-spec.md).
 *
 * Callers passing SOL must pre-compute `offeredSol` (docs/specs/reserve-spec.md
 * §1) and pass ITS usd value here — never the client's full SOL balance. This
 * function has no opinion on SOL specifically; the caller enforces the
 * reserve-first-then-rank ordering required by allocation-spec.md §5.
 */
export function allocate(
  assets: readonly RankableAsset[],
  headroomUsd: UsdMicros,
): AllocationEntry[] {
  const ranked = rankAssets(assets);
  let remaining = headroomUsd;
  const results: AllocationEntry[] = [];

  ranked.forEach((asset, index) => {
    const allocated: UsdMicros =
      remaining <= 0n
        ? ZERO_USD
        : asset.usdValue <= remaining
          ? asset.usdValue
          : usdMicros(remaining);

    remaining = usdMicros(remaining - allocated);
    const unallocated = usdMicros(asset.usdValue - allocated);

    results.push({
      mint: asset.mint,
      usdValue: asset.usdValue,
      rank: index + 1,
      allocatedUsd: allocated,
      unallocatedUsd: unallocated,
    });
  });

  const totalAllocated = results.reduce((acc, r) => acc + r.allocatedUsd, 0n);
  if (totalAllocated > headroomUsd) {
    // Required fail-closed assertion, docs/specs/allocation-spec.md §3.
    throw new Error(
      `allocate: computed allocation ${totalAllocated} exceeds headroom ${headroomUsd} — aborting rather than submitting an invalid quote`,
    );
  }

  return results;
}
