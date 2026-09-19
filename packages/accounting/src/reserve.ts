// SOL reserve formula. Normatively specified in docs/specs/reserve-spec.md §1.
// A ceiling on what may be offered for deposit, never a target. Recomputed
// fresh at every quote — this module has no cache and callers must not add one.

export interface SolReserveResult {
  readonly eligibleSolLamports: bigint;
  readonly pctReserveLamports: bigint;
  readonly absoluteReserveLamports: bigint;
  readonly reserveAppliedLamports: bigint;
  readonly governedBy: "PCT_RESERVE" | "ABSOLUTE_RESERVE";
  readonly offeredSolLamports: bigint;
}

/**
 * pct_reserve      = 10% of eligible_sol (floor to the lamport)
 * absolute_reserve = min_sol_reserve (config, docs/specs/reserve-spec.md §3)
 * reserve_applied  = max(pct_reserve, absolute_reserve)
 * offered_sol      = max(eligible_sol - reserve_applied, 0)
 */
export function computeSolReserve(
  eligibleSolLamports: bigint,
  minSolReserveLamports: bigint,
): SolReserveResult {
  if (eligibleSolLamports < 0n) {
    throw new RangeError(`computeSolReserve: negative eligibleSolLamports ${eligibleSolLamports}`);
  }
  if (minSolReserveLamports < 0n) {
    throw new RangeError(`computeSolReserve: negative minSolReserveLamports ${minSolReserveLamports}`);
  }

  // Floor division by 10 (sub-lamport rounding, at most 9 lamports — immaterial
  // at any realistic balance, and floors the reserve rather than the offer,
  // consistent with rounding conventions elsewhere in this system).
  const pctReserveLamports = eligibleSolLamports / 10n;
  const absoluteReserveLamports = minSolReserveLamports;

  const governedByPct = pctReserveLamports >= absoluteReserveLamports;
  const reserveAppliedLamports = governedByPct ? pctReserveLamports : absoluteReserveLamports;

  const offeredSolLamports =
    eligibleSolLamports > reserveAppliedLamports ? eligibleSolLamports - reserveAppliedLamports : 0n;

  return {
    eligibleSolLamports,
    pctReserveLamports,
    absoluteReserveLamports,
    reserveAppliedLamports,
    governedBy: governedByPct ? "PCT_RESERVE" : "ABSOLUTE_RESERVE",
    offeredSolLamports,
  };
}

/**
 * Backend-side enforcement per docs/specs/deposit-spec.md §5: reject, never
 * clamp, a client-selected SOL quantity above the offered ceiling. Callers
 * must invoke this on every path that accepts a deposit selection, not just
 * the reference UI's path.
 */
export function assertSolSelectionWithinOffer(
  selectedSolLamports: bigint,
  reserve: SolReserveResult,
): void {
  if (selectedSolLamports > reserve.offeredSolLamports) {
    throw new RangeError(
      `assertSolSelectionWithinOffer: selected ${selectedSolLamports} exceeds offered ceiling ${reserve.offeredSolLamports}`,
    );
  }
}
