import { test } from "node:test";
import assert from "node:assert/strict";
import { accrueDailyManagementFee, crystallizePerformanceFee } from "../src/fees.ts";
import { UNIT_PRICE_SCALE as SCALE, unitsIssuedOnSubscribe } from "../src/ledger.ts";
import { navScaled1e9 } from "../src/usd-micros.ts";

function usd(whole: bigint) {
  return navScaled1e9(whole * SCALE);
}

test("accrueDailyManagementFee matches the formula exactly (no separate rounding step)", () => {
  const nav = usd(155_000n);
  const annualFeeBps = 100; // 1%, illustrative per accounting.md §3.1 — not a proposed rate
  const result = accrueDailyManagementFee(nav, annualFeeBps);

  // Independently derived expected value, from the same single-division
  // formula: floor(nav_scaled * bps / (10_000 * 365)).
  const expectedFee = (nav * 100n) / (10_000n * 365n);
  assert.equal(result.feeUsdScaled, expectedFee);
  assert.equal(result.navAfterFeeScaled, nav - expectedFee);
});

test("management fee is non-negative and strictly less than NAV for any sane rate", () => {
  const nav = usd(1_000_000n);
  for (const bps of [0, 1, 25, 100, 500, 10_000]) {
    const result = accrueDailyManagementFee(nav, bps);
    assert.ok(result.feeUsdScaled >= 0n);
    assert.ok(result.feeUsdScaled <= nav);
    assert.ok(result.navAfterFeeScaled >= 0n);
  }
});

test("zero-bps management fee accrues nothing", () => {
  const nav = usd(42_000n);
  const result = accrueDailyManagementFee(nav, 0);
  assert.equal(result.feeUsdScaled, 0n);
  assert.equal(result.navAfterFeeScaled, nav);
});

test("accrueDailyManagementFee rejects a negative or non-integer bps", () => {
  assert.throws(() => accrueDailyManagementFee(usd(1_000n), -1), RangeError);
  assert.throws(() => accrueDailyManagementFee(usd(1_000n), 1.5), RangeError);
});

test("performance fee: no fee charged at or below the client's HWM", () => {
  const units = usd(1_000n); // reusing usd() purely as a scaled-bigint constructor
  const atHwm = crystallizePerformanceFee(units, SCALE, SCALE, 2000);
  assert.equal(atHwm.feeUnitsBurnedScaled, 0n);
  assert.equal(atHwm.newHwmUnitPriceScaled, SCALE);

  const belowHwm = crystallizePerformanceFee(units, SCALE, SCALE * 2n, 2000);
  assert.equal(belowHwm.feeUnitsBurnedScaled, 0n);
  assert.equal(belowHwm.newHwmUnitPriceScaled, SCALE * 2n); // HWM unchanged, never lowered
});

test("performance fee: charged only on gain above HWM, at the configured rate", () => {
  const clientUnits = 100n * SCALE; // 100.000000000 units
  const currentPrice = navScaled1e9((SCALE * 3n) / 2n); // 1.5
  const hwm = SCALE; // 1.0
  const performanceFeeBps = 2000; // 20%

  const result = crystallizePerformanceFee(clientUnits, currentPrice, hwm, performanceFeeBps);

  // gain_per_unit = 0.5; fee_value = 100 units * 0.5 * 20% = $10.00
  assert.equal(result.feeValueUsdScaled, usd(10n));
  // Burning units at the current price to realize exactly that fee value.
  assert.equal(result.feeUnitsBurnedScaled, unitsIssuedOnSubscribe(usd(10n), currentPrice));
  assert.equal(result.newHwmUnitPriceScaled, currentPrice);
  assert.ok(result.feeUnitsBurnedScaled < clientUnits);
});

test("performance fee never burns more units than the client holds", () => {
  const clientUnits = 1n; // a single (scaled) unit, i.e. a dust-sized holding
  const result = crystallizePerformanceFee(clientUnits, SCALE * 100n, SCALE, 10_000);
  assert.ok(result.feeUnitsBurnedScaled <= clientUnits);
});

test("crystallizePerformanceFee rejects a negative or non-integer bps", () => {
  assert.throws(() => crystallizePerformanceFee(SCALE, SCALE * 2n, SCALE, -1), RangeError);
  assert.throws(() => crystallizePerformanceFee(SCALE, SCALE * 2n, SCALE, 1.5), RangeError);
});
