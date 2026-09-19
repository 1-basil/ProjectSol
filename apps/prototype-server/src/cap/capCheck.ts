// Per-asset $1,000,000 cap enforcement. One cap per (client, asset) — never
// aggregated across assets. This is the corrected model from the design
// conversation: using $800k of USDC must never reduce SOL's (or any other
// asset's) remaining capacity, because each asset's headroom is computed
// solely from that asset's own `client_asset_authorizations` row.
//
// Pure, integer-only (bigint UsdMicros throughout), no floats. Reuses
// packages/accounting's existing, tested valuation formulas rather than
// re-deriving them here — computeUsdValueMicros and
// usdMicrosToNativeQuantityFloor are exact inverses of each other and are
// already covered by that package's own test suite.

import {
  usdMicros,
  type UsdMicros,
  type OraclePrice,
  computeUsdValueMicros,
  usdMicrosToNativeQuantityFloor,
} from "@platform/accounting";

export interface AssetCapState {
  readonly cumulativeCreditedUsdMicros: bigint;
  readonly assetCapUsdMicros: bigint;
}

/** `max(0, cap - cumulative_credited)`, saturating rather than erroring if already at/over cap. */
export function computeAssetHeadroomUsdMicros(state: AssetCapState): UsdMicros {
  if (state.cumulativeCreditedUsdMicros >= state.assetCapUsdMicros) return usdMicros(0n);
  return usdMicros(state.assetCapUsdMicros - state.cumulativeCreditedUsdMicros);
}

export interface SweepAmountInput {
  readonly onChainDelegatedRemainingNative: bigint;
  readonly liveAccountBalanceNative: bigint;
  readonly headroomUsdMicros: UsdMicros;
  readonly price: OraclePrice;
  readonly decimals: number;
}

/**
 * The amount actually pulled in a sweep is the minimum of three
 * independent ceilings — the on-chain delegate approval (a backstop the
 * chain itself enforces), the live token balance (can't pull what isn't
 * there), and the USD headroom converted to native units at the current
 * live price. The live USD check is authoritative for the $1,000,000
 * figure regardless of what the on-chain ceiling would technically permit —
 * price movement can make the two disagree, and the live check always wins
 * for the USD figure (see the design conversation's OD-32-style finding).
 */
export function computeSweepAmountNative(input: SweepAmountInput): bigint {
  if (input.headroomUsdMicros === 0n) return 0n;
  if (input.price.priceScaled <= 0n) return 0n;

  const headroomNative = usdMicrosToNativeQuantityFloor(input.headroomUsdMicros, input.price, input.decimals);

  const ceilings = [input.onChainDelegatedRemainingNative, input.liveAccountBalanceNative, headroomNative];
  return ceilings.reduce((min, v) => (v < min ? v : min));
}

/** USD value actually credited for a given native amount pulled, at the same price used to size the pull. */
export function computeCreditedUsdMicros(nativeAmount: bigint, price: OraclePrice, decimals: number): UsdMicros {
  return computeUsdValueMicros(nativeAmount, price, decimals);
}
