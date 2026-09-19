// Fee accrual. Normatively specified in docs/accounting.md §3. Management
// fee accrues daily into NAV before unit price is computed for the day
// (§3.1); performance fee crystallizes per-client against a high-water mark
// on unit price, realized by burning units rather than moving cash (§3.2).
// The specific rates here are all caller-supplied config — this module has
// no opinion on what a sane annual_fee_bps or performance_fee_bps is (see
// open-decisions.md OD-3); it only implements the accrual mechanism.

import { type NavScaled1e9, navScaled1e9, assertFitsU128 } from "./usd-micros.ts";
import { UNIT_PRICE_SCALE, unitsIssuedOnSubscribe } from "./ledger.ts";

const DAYS_PER_YEAR = 365n;
const BPS_DENOMINATOR = 10_000n;

function assertValidBps(bps: number, context: string): void {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new RangeError(`${context}: invalid bps value ${bps}`);
  }
}

export interface ManagementFeeAccrualResult {
  readonly feeUsdScaled: NavScaled1e9;
  readonly navAfterFeeScaled: NavScaled1e9;
}

/**
 * Daily management fee accrual, accounting.md §3.1:
 *   daily_accrual = NAV_before * annual_fee_bps / 10_000 / 365
 * A single terminal division (multiply everything first) so the fee is
 * floored exactly once, in the pool's favor per §3.1's illustration —
 * under-accruing the fee leaves more in NAV for remaining unit-holders
 * rather than overcharging them.
 */
export function accrueDailyManagementFee(
  navBeforeFeeScaled: NavScaled1e9,
  annualFeeBps: number,
): ManagementFeeAccrualResult {
  assertValidBps(annualFeeBps, "accrueDailyManagementFee");
  const numerator = navBeforeFeeScaled * BigInt(annualFeeBps);
  const feeUsdScaled = numerator / (BPS_DENOMINATOR * DAYS_PER_YEAR);
  assertFitsU128(feeUsdScaled, "accrueDailyManagementFee");
  if (feeUsdScaled > navBeforeFeeScaled) {
    // Guards against a fat-fingered annual_fee_bps consuming more than NAV
    // itself in a single day (accounting.md §4, "Fee non-negativity and
    // boundedness").
    throw new RangeError(
      `accrueDailyManagementFee: computed fee ${feeUsdScaled} exceeds NAV ${navBeforeFeeScaled}`,
    );
  }
  return {
    feeUsdScaled: navScaled1e9(feeUsdScaled),
    navAfterFeeScaled: navScaled1e9(navBeforeFeeScaled - feeUsdScaled),
  };
}

export interface PerformanceFeeCrystallizationResult {
  readonly feeValueUsdScaled: NavScaled1e9;
  readonly feeUnitsBurnedScaled: NavScaled1e9;
  readonly newHwmUnitPriceScaled: NavScaled1e9;
}

/**
 * Per-client high-water-mark performance fee, accounting.md §3.2. Charged
 * only on the client's own gain above their own prior HWM. Below or at the
 * HWM, no fee is charged and the HWM is left unchanged — it must never
 * decrease (accounting.md §4, "HWM monotonicity").
 *
 * The fee value is computed once (single terminal division combining the
 * per-unit-scale descale and the bps percentage into one division), then
 * converted to a unit count to burn using the same formula as a subscribe
 * at the current price — burning units is exactly "un-issuing" value at the
 * current unit price.
 */
export function crystallizePerformanceFee(
  clientUnitsScaled: NavScaled1e9,
  currentUnitPriceScaled: NavScaled1e9,
  hwmUnitPriceScaled: NavScaled1e9,
  performanceFeeBps: number,
): PerformanceFeeCrystallizationResult {
  assertValidBps(performanceFeeBps, "crystallizePerformanceFee");

  if (currentUnitPriceScaled <= hwmUnitPriceScaled) {
    return {
      feeValueUsdScaled: navScaled1e9(0n),
      feeUnitsBurnedScaled: navScaled1e9(0n),
      newHwmUnitPriceScaled: hwmUnitPriceScaled,
    };
  }

  const gainPerUnitScaled = currentUnitPriceScaled - hwmUnitPriceScaled;
  const numerator = clientUnitsScaled * gainPerUnitScaled * BigInt(performanceFeeBps);
  const feeValueUsdScaled = numerator / (UNIT_PRICE_SCALE * BPS_DENOMINATOR);
  assertFitsU128(feeValueUsdScaled, "crystallizePerformanceFee:feeValue");

  const feeUnitsBurnedScaled = unitsIssuedOnSubscribe(
    navScaled1e9(feeValueUsdScaled),
    currentUnitPriceScaled,
  );
  if (feeUnitsBurnedScaled > clientUnitsScaled) {
    throw new RangeError(
      `crystallizePerformanceFee: computed fee units ${feeUnitsBurnedScaled} exceed client holding ${clientUnitsScaled}`,
    );
  }

  return {
    feeValueUsdScaled: navScaled1e9(feeValueUsdScaled),
    feeUnitsBurnedScaled,
    newHwmUnitPriceScaled: currentUnitPriceScaled,
  };
}
