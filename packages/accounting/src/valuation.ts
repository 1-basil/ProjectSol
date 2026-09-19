// Canonical USD valuation formula. Normatively specified in
// docs/specs/comparator-spec.md §3. This is the actual source of
// cross-implementation parity — not "use integers" alone, but this exact
// sequence of operations: multiply everything first, divide (or multiply,
// for a negative combined exponent) exactly once, at the end.
//
// usd_value = floor( quantity_native * price_scaled
//                    / 10^(mint_decimals + price_exponent_abs - 6) )
//
// The Rust port in crates/comparator/src/valuation.rs must perform the
// identical sequence of operations on the identical inputs and produce a
// bit-identical result. Do not "simplify" this by dividing early or by
// converting the oracle price through a float/decimal-string at any point.

import { type UsdMicros, usdMicros, assertFitsU128 } from "./usd-micros.ts";

/**
 * An oracle price expressed as its native integer mantissa plus a
 * *non-negative* exponent magnitude, mirroring how Pyth (and similar
 * oracles) represent prices: actual_price = priceScaled / 10^priceExponentAbs.
 * Never pass a price that has been round-tripped through a float or a
 * decimal string — the float must never exist at any point in this path.
 */
export interface OraclePrice {
  readonly priceScaled: bigint;
  readonly priceExponentAbs: number;
}

const USD_MICRO_SCALE_EXPONENT = 6;

/**
 * Compute a USD-micro-unit (1e6 scale) valuation for a native token quantity,
 * per docs/specs/comparator-spec.md §3. Floors exactly once, at the single
 * terminal division (or, for a negative combined exponent, does not divide
 * at all — it multiplies instead, per the formula's own branch).
 */
export function computeUsdValueMicros(
  quantityNative: bigint,
  price: OraclePrice,
  mintDecimals: number,
): UsdMicros {
  if (quantityNative < 0n) {
    throw new RangeError(`computeUsdValueMicros: negative quantity ${quantityNative}`);
  }
  if (price.priceScaled < 0n) {
    throw new RangeError(`computeUsdValueMicros: negative price ${price.priceScaled}`);
  }
  if (!Number.isInteger(mintDecimals) || mintDecimals < 0) {
    throw new RangeError(`computeUsdValueMicros: invalid mintDecimals ${mintDecimals}`);
  }
  if (!Number.isInteger(price.priceExponentAbs) || price.priceExponentAbs < 0) {
    throw new RangeError(
      `computeUsdValueMicros: invalid priceExponentAbs ${price.priceExponentAbs}`,
    );
  }

  // Multiply first, in the full bigint width. Never narrow, never round an
  // intermediate value.
  const numerator = quantityNative * price.priceScaled;

  const divisorExponent = mintDecimals + price.priceExponentAbs - USD_MICRO_SCALE_EXPONENT;

  let result: bigint;
  if (divisorExponent >= 0) {
    // The single specified rounding point: one terminal integer division.
    // BigInt division truncates toward zero, which is floor for two
    // non-negative operands (guaranteed by the checks above).
    result = numerator / 10n ** BigInt(divisorExponent);
  } else {
    // Negative combined exponent (a very-high-decimals price feed): multiply
    // instead of dividing by a negative power of ten. No rounding occurs on
    // this branch at all, since it's pure multiplication.
    result = numerator * 10n ** BigInt(-divisorExponent);
  }

  assertFitsU128(result, "computeUsdValueMicros");
  return usdMicros(result);
}

/**
 * Inverse of computeUsdValueMicros, for converting a USD-micro-unit boundary
 * back into a native token quantity, floored to the mint's own decimals.
 * Used for the "boundary asset" case in docs/specs/allocation-spec.md §3 —
 * the rounding remainder here is what joins the excess, never rounds up
 * into the pool.
 */
export function usdMicrosToNativeQuantityFloor(
  usd: UsdMicros,
  price: OraclePrice,
  mintDecimals: number,
): bigint {
  if (price.priceScaled === 0n) {
    throw new RangeError("usdMicrosToNativeQuantityFloor: zero price");
  }
  const divisorExponent = mintDecimals + price.priceExponentAbs - USD_MICRO_SCALE_EXPONENT;

  if (divisorExponent >= 0) {
    const numerator = usd * 10n ** BigInt(divisorExponent);
    return numerator / price.priceScaled;
  }
  // usd = qty * price * 10^|divisorExponent|  =>  qty = usd / (price * 10^|divisorExponent|)
  const denominator = price.priceScaled * 10n ** BigInt(-divisorExponent);
  return usd / denominator;
}
