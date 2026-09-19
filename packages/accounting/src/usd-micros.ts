// Branded fixed-point monetary types. See docs/specs/monetary-representation.md
// §3: two distinct scales exist in this system (1e6 for allocation USD, 1e9
// for NAV/unit-price elsewhere) and must never be silently interchangeable.
// Branding makes a scale mismatch a compile-time type error instead of a
// silent 1000x runtime bug. No float type may ever construct one of these.

const USD_MICROS_BRAND: unique symbol = Symbol("UsdMicros");
const NAV_SCALED_1E9_BRAND: unique symbol = Symbol("NavScaled1e9");

/** USD value in micro-units (1e6 scale). Used only in the allocation path. */
export type UsdMicros = bigint & { readonly [USD_MICROS_BRAND]: true };

/** NAV / unit-price fixed-point value (1e9 scale). Used in accounting.md's model. */
export type NavScaled1e9 = bigint & { readonly [NAV_SCALED_1E9_BRAND]: true };

export function usdMicros(value: bigint): UsdMicros {
  if (value < 0n) {
    throw new RangeError(`usdMicros: negative value ${value}`);
  }
  return value as UsdMicros;
}

export function navScaled1e9(value: bigint): NavScaled1e9 {
  if (value < 0n) {
    throw new RangeError(`navScaled1e9: negative value ${value}`);
  }
  return value as NavScaled1e9;
}

export const ZERO_USD: UsdMicros = usdMicros(0n);

export const U128_MAX: bigint = (1n << 128n) - 1n;

export function assertFitsU128(value: bigint, context: string): void {
  if (value < 0n || value > U128_MAX) {
    throw new RangeError(`${context}: value ${value} does not fit in u128 range`);
  }
}

export function addUsd(a: UsdMicros, b: UsdMicros): UsdMicros {
  const r = a + b;
  assertFitsU128(r, "addUsd");
  return usdMicros(r);
}

export function subUsd(a: UsdMicros, b: UsdMicros): UsdMicros {
  const r = a - b;
  if (r < 0n) {
    throw new RangeError(`subUsd: ${a} - ${b} is negative`);
  }
  return usdMicros(r);
}

export function minUsd(a: UsdMicros, b: UsdMicros): UsdMicros {
  return a < b ? a : b;
}
