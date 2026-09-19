// Unit ledger: subscribe/redeem and the per-vault unit-conservation
// invariant. Normatively specified in docs/accounting.md §1/§2/§4. NAV, unit
// price, and unit counts all share the same 1e9 fixed-point scale
// (docs/specs/monetary-representation.md §1) and are represented with the
// same NavScaled1e9 brand — the caller's variable names carry the semantic
// distinction; the type only prevents mixing this scale with UsdMicros'
// 1e6 scale. No floats anywhere in this path.

import { type NavScaled1e9, navScaled1e9, assertFitsU128 } from "./usd-micros.ts";

export const UNIT_PRICE_SCALE = 1_000_000_000n; // 1e9, accounting.md §1
export const INITIAL_UNIT_PRICE: NavScaled1e9 = navScaled1e9(UNIT_PRICE_SCALE);

/**
 * Subscribe (deposit): units_issued = floor(deposit_usd_scaled * SCALE / unit_price_scaled).
 * accounting.md §1. The single terminal division floors — bigint division
 * truncates toward zero, which is floor here since both operands are
 * non-negative. Rounds down, in the pool's favor.
 */
export function unitsIssuedOnSubscribe(
  depositUsdScaled: NavScaled1e9,
  unitPriceScaled: NavScaled1e9,
): NavScaled1e9 {
  if (unitPriceScaled <= 0n) {
    throw new RangeError(
      `unitsIssuedOnSubscribe: unit price must be positive, got ${unitPriceScaled}`,
    );
  }
  const numerator = depositUsdScaled * UNIT_PRICE_SCALE;
  const units = numerator / unitPriceScaled;
  assertFitsU128(units, "unitsIssuedOnSubscribe");
  return navScaled1e9(units);
}

/**
 * Redeem: payout_scaled = floor(units_burned_scaled * unit_price_scaled / SCALE).
 * accounting.md §1. Rounds down — the client never receives more than their
 * units are worth; the remainder accrues to the pool.
 */
export function payoutOnRedeem(
  unitsBurnedScaled: NavScaled1e9,
  unitPriceScaled: NavScaled1e9,
): NavScaled1e9 {
  if (unitPriceScaled < 0n) {
    throw new RangeError(`payoutOnRedeem: negative unit price ${unitPriceScaled}`);
  }
  const numerator = unitsBurnedScaled * unitPriceScaled;
  const payout = numerator / UNIT_PRICE_SCALE;
  assertFitsU128(payout, "payoutOnRedeem");
  return navScaled1e9(payout);
}

/**
 * unit_price = NAV / total_units, recomputed whenever NAV moves without an
 * accompanying subscribe/redeem event — accounting.md §2's "pool gains 10%"
 * rows. Not part of subscribe/redeem themselves; the NAV Engine calls this
 * whenever it publishes a new NAV against an unchanged total_units.
 */
export function recomputeUnitPrice(
  navScaledValue: NavScaled1e9,
  totalUnitsScaled: NavScaled1e9,
): NavScaled1e9 {
  if (totalUnitsScaled <= 0n) {
    throw new RangeError("recomputeUnitPrice: total units must be positive");
  }
  const price = (navScaledValue * UNIT_PRICE_SCALE) / totalUnitsScaled;
  assertFitsU128(price, "recomputeUnitPrice");
  return navScaled1e9(price);
}

export interface ClientLedgerEntry {
  readonly unitsScaled: NavScaled1e9;
  readonly hwmUnitPriceScaled: NavScaled1e9;
}

/**
 * A single vault's unit ledger: total_units plus the per-client breakdown
 * that must sum to it (accounting.md §4, "Unit conservation"). Units are
 * created only by subscribe() and destroyed only by redeem() or
 * burnUnitsForFee() — accounting.md §4, "Controlled unit creation/destruction".
 * The conservation invariant is re-checked after every mutation; a violation
 * throws immediately rather than persisting a broken state.
 */
export class UnitLedger {
  #totalUnitsScaled: NavScaled1e9 = navScaled1e9(0n);
  readonly #clients = new Map<string, ClientLedgerEntry>();

  get totalUnitsScaled(): NavScaled1e9 {
    return this.#totalUnitsScaled;
  }

  clientUnitsScaled(clientId: string): NavScaled1e9 {
    return this.#clients.get(clientId)?.unitsScaled ?? navScaled1e9(0n);
  }

  clientHwmUnitPriceScaled(clientId: string): NavScaled1e9 {
    return this.#clients.get(clientId)?.hwmUnitPriceScaled ?? INITIAL_UNIT_PRICE;
  }

  /** Issues units to a client against a deposit. Returns units issued. */
  subscribe(
    clientId: string,
    depositUsdScaled: NavScaled1e9,
    unitPriceScaled: NavScaled1e9,
  ): NavScaled1e9 {
    const issued = unitsIssuedOnSubscribe(depositUsdScaled, unitPriceScaled);
    const existing = this.#clients.get(clientId);
    const newUnits = navScaled1e9((existing?.unitsScaled ?? 0n) + issued);
    this.#clients.set(clientId, {
      unitsScaled: newUnits,
      hwmUnitPriceScaled: existing?.hwmUnitPriceScaled ?? INITIAL_UNIT_PRICE,
    });
    this.#totalUnitsScaled = navScaled1e9(this.#totalUnitsScaled + issued);
    this.#assertUnitConservation();
    return issued;
  }

  /** Burns a client's units against a redemption. Returns the USD payout. */
  redeem(
    clientId: string,
    unitsToBurnScaled: NavScaled1e9,
    unitPriceScaled: NavScaled1e9,
  ): NavScaled1e9 {
    const held = this.clientUnitsScaled(clientId);
    if (unitsToBurnScaled > held) {
      throw new RangeError(
        `redeem: client ${clientId} holds ${held} units, cannot burn ${unitsToBurnScaled}`,
      );
    }
    const payout = payoutOnRedeem(unitsToBurnScaled, unitPriceScaled);
    this.#burnUnits(clientId, unitsToBurnScaled);
    return payout;
  }

  /**
   * Burns units for a performance-fee crystallization (accounting.md §3.2) —
   * the only other permitted destroyer of units besides redeem(). Also
   * updates the client's HWM. Callers must pass a newHwm that is >= the
   * client's current HWM (accounting.md §4, "HWM monotonicity"); this method
   * asserts that rather than silently accepting a decrease.
   */
  burnUnitsForPerformanceFee(
    clientId: string,
    unitsToBurnScaled: NavScaled1e9,
    newHwmUnitPriceScaled: NavScaled1e9,
  ): void {
    const held = this.clientUnitsScaled(clientId);
    if (unitsToBurnScaled > held) {
      throw new RangeError(
        `burnUnitsForPerformanceFee: client ${clientId} holds ${held} units, cannot burn ${unitsToBurnScaled}`,
      );
    }
    const currentHwm = this.clientHwmUnitPriceScaled(clientId);
    if (newHwmUnitPriceScaled < currentHwm) {
      throw new RangeError(
        `burnUnitsForPerformanceFee: HWM would decrease (${currentHwm} -> ${newHwmUnitPriceScaled})`,
      );
    }
    this.#burnUnits(clientId, unitsToBurnScaled, newHwmUnitPriceScaled);
  }

  #burnUnits(clientId: string, unitsToBurnScaled: NavScaled1e9, newHwm?: NavScaled1e9): void {
    const existing = this.#clients.get(clientId);
    const held = existing?.unitsScaled ?? navScaled1e9(0n);
    this.#clients.set(clientId, {
      unitsScaled: navScaled1e9(held - unitsToBurnScaled),
      hwmUnitPriceScaled: newHwm ?? existing?.hwmUnitPriceScaled ?? INITIAL_UNIT_PRICE,
    });
    this.#totalUnitsScaled = navScaled1e9(this.#totalUnitsScaled - unitsToBurnScaled);
    this.#assertUnitConservation();
  }

  #assertUnitConservation(): void {
    let sum = 0n;
    for (const entry of this.#clients.values()) {
      sum += entry.unitsScaled;
    }
    if (sum !== this.#totalUnitsScaled) {
      throw new Error(
        `UnitLedger: invariant violated — sum(client.units)=${sum} != total_units=${this.#totalUnitsScaled}`,
      );
    }
  }
}
