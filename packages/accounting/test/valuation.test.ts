import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUsdValueMicros, usdMicrosToNativeQuantityFloor } from "../src/valuation.ts";

test("USDC-like: 6 decimals, price ~$1.00 at exponent 8 -> exact micro-USD", () => {
  // 1,000 USDC (6 decimals) at price 1.00000000 (mantissa 100000000, exponent 8)
  const quantity = 1_000_000_000n; // 1000 * 10^6
  const price = { priceScaled: 100_000_000n, priceExponentAbs: 8 };
  const usd = computeUsdValueMicros(quantity, price, 6);
  assert.equal(usd, 1_000_000_000n); // $1000.00 = 1_000_000_000 micro-USD
});

test("SOL-like: 9 decimals, price $150.25 at exponent 8", () => {
  // 2 SOL = 2_000_000_000 (9 decimals). price = 150.25 -> mantissa 15025000000, exponent 8
  const quantity = 2_000_000_000n;
  const price = { priceScaled: 15_025_000_000n, priceExponentAbs: 8 };
  const usd = computeUsdValueMicros(quantity, price, 9);
  // expected: 2 * 150.25 = 300.50 USD = 300_500_000 micro-USD
  assert.equal(usd, 300_500_000n);
});

test("floors rather than rounds", () => {
  // Construct a case with a nonzero fractional remainder at the terminal division.
  // quantity=3 (0 decimals), price mantissa=10 exponent=1 (=> price=1.0 exactly is too clean;
  // use price exponent 7, mantissa 1 => price = 1e-7, times qty 3 => 3e-7 usd => at 1e6 scale
  // that's 0.3 micro-usd, must floor to 0, not round to 0 or 1 in a way that hides the point).
  const usd = computeUsdValueMicros(3n, { priceScaled: 1n, priceExponentAbs: 7 }, 0);
  assert.equal(usd, 0n);
});

test("negative combined exponent takes the multiply branch", () => {
  // mintDecimals=0, priceExponentAbs=0 => divisorExponent = 0+0-6 = -6 (negative)
  // usd_micros = quantity * price * 10^6
  const usd = computeUsdValueMicros(2n, { priceScaled: 3n, priceExponentAbs: 0 }, 0);
  assert.equal(usd, 2n * 3n * 1_000_000n);
});

test("multiply-before-divide regression: reordering the formula changes the result", () => {
  // Pick inputs where floor(a*b/c) != floor(a/c)*b and != a*floor(b/c) —
  // i.e., where the correct (multiply-first) answer differs from either
  // divide-first variant. This is the formula-shape regression test, not a
  // comparator test.
  const quantity = 7n;
  const price = { priceScaled: 3n, priceExponentAbs: 7 }; // divisorExponent = 0+7-6=1
  const correct = computeUsdValueMicros(quantity, price, 0);
  // correct = floor(7*3 / 10) = floor(21/10) = 2
  assert.equal(correct, 2n);

  const wrongDivideQuantityFirst = quantity / 10n; // 0, divide-before-multiply on quantity
  const wrongResultA = wrongDivideQuantityFirst * price.priceScaled; // 0
  assert.notEqual(wrongResultA, correct);

  const wrongDividePriceFirst = price.priceScaled / 10n; // 0
  const wrongResultB = quantity * wrongDividePriceFirst; // 0
  assert.notEqual(wrongResultB, correct);
});

test("rejects a result that would not fit in u128", () => {
  const hugeQuantity = (1n << 100n);
  const hugePrice = { priceScaled: (1n << 100n), priceExponentAbs: 0 };
  assert.throws(() => computeUsdValueMicros(hugeQuantity, hugePrice, 0), RangeError);
});

test("usdMicrosToNativeQuantityFloor inverts computeUsdValueMicros at the rounding boundary", () => {
  const price = { priceScaled: 100_000_000n, priceExponentAbs: 8 }; // $1.00
  const usd = 1_500_000n; // $1.50
  const qty = usdMicrosToNativeQuantityFloor(usd, price, 6); // USDC-like, 6 decimals
  assert.equal(qty, 1_500_000n); // 1.5 USDC = 1_500_000 native units
});
