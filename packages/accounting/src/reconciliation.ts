// Reconciliation invariants. Normatively grounded in spec §10, accounting.md
// §4, db-schema.md's `reconciliation_runs`/`reconciliation_breaks` tables,
// deposit-spec.md §6/§11-13, and excess-return-spec.md.
//
// This module is the pure, integer-only comparison logic a Phase 10
// reconciler service would call against already-fetched on-chain and ledger
// snapshots — it does no RPC, no DB I/O, no scheduling, and holds no state
// between calls. Each check is independently testable; `reconcile()` composes
// them for convenience.
//
// Scope note on OD-17: reconciliation tolerance thresholds ("tight tolerance"
// and "hard threshold") are explicitly *not decided* (open-decisions.md
// OD-17) pending real staging data. Every check in this module therefore
// treats any nonzero mismatch as a HARD_BREACH rather than inventing a WARN
// band — these are exact-integer-arithmetic invariants over an
// already-aligned snapshot pair, not noisy measurements, so exactness is the
// right default at this layer. A future tolerance band (e.g. for in-flight
// settlement timing) is a property of *how a snapshot pair is assembled*
// upstream of this module, not of the comparison logic itself.
//
// Scope note on OD-34: this module's deposit-units check (checkDepositUnitsIssued)
// takes the *execution-time* unit price actually recorded at credit (per
// deposit-spec.md §6, OD-19), never a pre-signature quote price — so it
// cannot manufacture the quote-vs-execution divergence OD-34 describes. That
// divergence, if it needs its own carve-out, belongs in whatever assembles
// the quote-side comparison, not here.

import type { NavScaled1e9 } from "./usd-micros.ts";
import { unitsIssuedOnSubscribe, payoutOnRedeem, recomputeUnitPrice } from "./ledger.ts";
import { accrueDailyManagementFee } from "./fees.ts";

export type BreakSeverity = "WARN" | "HARD_BREACH";

export type BreakType =
  | "UNIT_CONSERVATION_MISMATCH"
  | "NAV_COMPOSITION_MISMATCH"
  | "CLIENT_UNIT_BALANCE_MISMATCH"
  | "POSITION_BALANCE_MISMATCH"
  | "CASH_BALANCE_MISMATCH"
  | "UNEXPLAINED_ASSET_BALANCE"
  | "EXCESS_LEAKED_INTO_MANAGED"
  | "UNATTRIBUTED_FUNDS_MISUSED"
  | "FEE_ACCRUAL_MISMATCH"
  | "DEPOSIT_UNITS_MISMATCH"
  | "REDEMPTION_PAYOUT_MISMATCH"
  | "DUST_INVARIANT_VIOLATION"
  | "DUPLICATE_TX_ATTRIBUTION"
  | "ORPHAN_ONCHAIN_TX"
  | "ORPHAN_LEDGER_TX";

export interface ReconciliationBreak {
  readonly breakType: BreakType;
  readonly severity: BreakSeverity;
  readonly context: string;
  readonly expected?: bigint;
  readonly actual?: bigint;
  readonly delta?: bigint;
}

function mismatch(
  breakType: BreakType,
  context: string,
  expected: bigint,
  actual: bigint,
  severity: BreakSeverity = "HARD_BREACH",
): ReconciliationBreak {
  return { breakType, severity, context, expected, actual, delta: actual - expected };
}

// ============================================================
// 1. Unit conservation: sum(client.units) == vault.total_units
// accounting.md §4, "Unit conservation".
// ============================================================

export function checkUnitConservation(
  clientUnitsScaled: ReadonlyMap<string, NavScaled1e9>,
  totalUnitsScaled: NavScaled1e9,
): ReconciliationBreak[] {
  let sum = 0n;
  for (const units of clientUnitsScaled.values()) sum += units;
  if (sum !== totalUnitsScaled) {
    return [mismatch("UNIT_CONSERVATION_MISMATCH", "vault.total_units", totalUnitsScaled, sum)];
  }
  return [];
}

// ============================================================
// 2. NAV composition: NAV == cash + positions - liabilities - accrued_fees
// spec §5.4 / accounting.md §4, "NAV composition".
// ============================================================

export interface NavCompositionInput {
  readonly cashUsdScaled: NavScaled1e9;
  readonly positionsValueUsdScaled: NavScaled1e9;
  readonly liabilitiesUsdScaled: NavScaled1e9;
  readonly accruedFeesUsdScaled: NavScaled1e9;
  readonly recordedNavUsdScaled: NavScaled1e9;
}

export function checkNavComposition(input: NavCompositionInput): ReconciliationBreak[] {
  const expected =
    input.cashUsdScaled +
    input.positionsValueUsdScaled -
    input.liabilitiesUsdScaled -
    input.accruedFeesUsdScaled;
  if (expected !== input.recordedNavUsdScaled) {
    return [mismatch("NAV_COMPOSITION_MISMATCH", "nav_snapshots.nav_usd_scaled", expected, input.recordedNavUsdScaled)];
  }
  return [];
}

// ============================================================
// 3. Client-unit balance mismatches: ledger (client_vault_positions) vs the
// on-chain ClientAccount mirror, per client.
// ============================================================

export function checkClientUnitBalances(
  ledgerUnitsScaled: ReadonlyMap<string, NavScaled1e9>,
  onchainUnitsScaled: ReadonlyMap<string, NavScaled1e9>,
): ReconciliationBreak[] {
  const breaks: ReconciliationBreak[] = [];
  const clientIds = new Set([...ledgerUnitsScaled.keys(), ...onchainUnitsScaled.keys()]);
  for (const clientId of clientIds) {
    const ledger = ledgerUnitsScaled.get(clientId) ?? (0n as NavScaled1e9);
    const onchain = onchainUnitsScaled.get(clientId) ?? (0n as NavScaled1e9);
    if (ledger !== onchain) {
      breaks.push(mismatch("CLIENT_UNIT_BALANCE_MISMATCH", `client:${clientId}`, onchain, ledger));
    }
  }
  return breaks;
}

// ============================================================
// 4. Position / cash balance mismatches: ledger (positions table / NAV cash
// figure) vs on-chain token account balances, per mint. Raw native token
// quantities (mint decimals), not USD-scaled — matches db-schema.md
// `positions.quantity_raw`.
// ============================================================

export function checkPositionBalances(
  ledgerPositionsRaw: ReadonlyMap<string, bigint>,
  onchainPositionsRaw: ReadonlyMap<string, bigint>,
): ReconciliationBreak[] {
  const breaks: ReconciliationBreak[] = [];
  const mints = new Set([...ledgerPositionsRaw.keys(), ...onchainPositionsRaw.keys()]);
  for (const mint of mints) {
    const ledger = ledgerPositionsRaw.get(mint) ?? 0n;
    const onchain = onchainPositionsRaw.get(mint) ?? 0n;
    if (ledger !== onchain) {
      breaks.push(mismatch("POSITION_BALANCE_MISMATCH", `mint:${mint}`, onchain, ledger));
    }
  }
  return breaks;
}

export function checkCashBalance(
  ledgerCashRaw: bigint,
  onchainCashRaw: bigint,
  context = "vault_cash",
): ReconciliationBreak[] {
  if (ledgerCashRaw !== onchainCashRaw) {
    return [mismatch("CASH_BALANCE_MISMATCH", context, onchainCashRaw, ledgerCashRaw)];
  }
  return [];
}

// ============================================================
// 5. Unexplained asset balances: an on-chain balance for a mint that isn't
// fully accounted for by the sum of every bucket the ledger tracks for that
// mint (managed positions + UNMANAGED_EXCESS + UNATTRIBUTED). Distinct from
// #4: #4 compares the *managed position* figure directly; this compares the
// vault's *total custody* balance against everything that should explain it,
// catching balances no bucket claims at all (e.g. an untracked transfer, or
// an accounting write that silently dropped a bucket).
// ============================================================

export interface AssetBucketBalances {
  readonly managedRaw: bigint;
  readonly unmanagedExcessRaw: bigint;
  readonly unattributedRaw: bigint;
}

export function checkUnexplainedAssetBalances(
  onchainCustodyRaw: ReadonlyMap<string, bigint>,
  bucketBalances: ReadonlyMap<string, AssetBucketBalances>,
): ReconciliationBreak[] {
  const breaks: ReconciliationBreak[] = [];
  for (const [mint, onchain] of onchainCustodyRaw) {
    const buckets = bucketBalances.get(mint) ?? {
      managedRaw: 0n,
      unmanagedExcessRaw: 0n,
      unattributedRaw: 0n,
    };
    const accounted = buckets.managedRaw + buckets.unmanagedExcessRaw + buckets.unattributedRaw;
    if (accounted !== onchain) {
      breaks.push(mismatch("UNEXPLAINED_ASSET_BALANCE", `mint:${mint}`, onchain, accounted));
    }
  }
  return breaks;
}

// ============================================================
// 6. UNMANAGED_EXCESS must never issue units — excess-return-spec.md §1:
// "zero units issued, excluded from NAV" is the defining property of excess,
// for all three of its sources (cap excess, headroom-race shortfall,
// boundary-rounding remainder).
// ============================================================

export interface ExcessRecord {
  readonly clientId: string;
  readonly mint: string;
  readonly unitsIssuedScaled: NavScaled1e9;
}

export function checkExcessSegregation(excessRecords: readonly ExcessRecord[]): ReconciliationBreak[] {
  const breaks: ReconciliationBreak[] = [];
  for (const record of excessRecords) {
    if (record.unitsIssuedScaled !== (0n as NavScaled1e9)) {
      breaks.push(
        mismatch(
          "EXCESS_LEAKED_INTO_MANAGED",
          `client:${record.clientId}:mint:${record.mint}`,
          0n,
          record.unitsIssuedScaled,
        ),
      );
    }
  }
  return breaks;
}

// ============================================================
// 7. UNATTRIBUTED funds must never be credited (units issued) or traded —
// deposit-spec.md §6.1 fallback rule, restated in db-schema.md's
// `unattributed_deposits` comment: "Never auto-credited, never traded."
// ============================================================

export interface UnattributedRecord {
  readonly txSignature: string;
  readonly creditedUnitsScaled: NavScaled1e9;
  readonly tradedRaw: bigint;
}

export function checkUnattributedNotCredited(
  unattributedRecords: readonly UnattributedRecord[],
): ReconciliationBreak[] {
  const breaks: ReconciliationBreak[] = [];
  for (const record of unattributedRecords) {
    if (record.creditedUnitsScaled !== (0n as NavScaled1e9)) {
      breaks.push(
        mismatch(
          "UNATTRIBUTED_FUNDS_MISUSED",
          `tx:${record.txSignature}:credited`,
          0n,
          record.creditedUnitsScaled,
        ),
      );
    }
    if (record.tradedRaw !== 0n) {
      breaks.push(
        mismatch("UNATTRIBUTED_FUNDS_MISUSED", `tx:${record.txSignature}:traded`, 0n, record.tradedRaw),
      );
    }
  }
  return breaks;
}

// ============================================================
// 8. Fee-accrual mismatches: the recorded daily management-fee accrual must
// match the formula in accounting.md §3.1, recomputed independently.
// ============================================================

export interface ManagementFeeAccrualCheckInput {
  readonly navBeforeFeeUsdScaled: NavScaled1e9;
  readonly annualFeeBps: number;
  readonly recordedFeeUsdScaled: NavScaled1e9;
  readonly context?: string;
}

export function checkManagementFeeAccrual(input: ManagementFeeAccrualCheckInput): ReconciliationBreak[] {
  const expected = accrueDailyManagementFee(input.navBeforeFeeUsdScaled, input.annualFeeBps);
  if (expected.feeUsdScaled !== input.recordedFeeUsdScaled) {
    return [
      mismatch(
        "FEE_ACCRUAL_MISMATCH",
        input.context ?? "fee_accruals.amount_usd_scaled",
        expected.feeUsdScaled,
        input.recordedFeeUsdScaled,
      ),
    ];
  }
  return [];
}

// ============================================================
// 9. Deposit state mismatches: units_issued recorded on a deposit must match
// the subscribe formula applied to the amount and unit price actually
// recorded at credit time (execution-time-authoritative, deposit-spec.md §6).
// ============================================================

export interface DepositUnitsCheckInput {
  readonly txSignature: string;
  readonly amountUsdScaled: NavScaled1e9;
  readonly unitPriceScaledAtCredit: NavScaled1e9;
  readonly unitsIssuedRecorded: NavScaled1e9;
}

export function checkDepositUnitsIssued(
  deposits: readonly DepositUnitsCheckInput[],
): ReconciliationBreak[] {
  const breaks: ReconciliationBreak[] = [];
  for (const deposit of deposits) {
    const expected = unitsIssuedOnSubscribe(deposit.amountUsdScaled, deposit.unitPriceScaledAtCredit);
    if (expected !== deposit.unitsIssuedRecorded) {
      breaks.push(
        mismatch(
          "DEPOSIT_UNITS_MISMATCH",
          `tx:${deposit.txSignature}`,
          expected,
          deposit.unitsIssuedRecorded,
        ),
      );
    }
  }
  return breaks;
}

// ============================================================
// 10. Redemption state mismatches: payout_usd_scaled recorded on a settled
// redemption must match the redeem formula applied to the units burned and
// the price struck for that cycle.
// ============================================================

export interface RedemptionPayoutCheckInput {
  readonly redemptionId: string;
  readonly unitsBurnedScaled: NavScaled1e9;
  readonly struckUnitPriceScaled: NavScaled1e9;
  readonly payoutUsdScaledRecorded: NavScaled1e9;
}

export function checkRedemptionPayout(
  redemptions: readonly RedemptionPayoutCheckInput[],
): ReconciliationBreak[] {
  const breaks: ReconciliationBreak[] = [];
  for (const redemption of redemptions) {
    const expected = payoutOnRedeem(redemption.unitsBurnedScaled, redemption.struckUnitPriceScaled);
    if (expected !== redemption.payoutUsdScaledRecorded) {
      breaks.push(
        mismatch(
          "REDEMPTION_PAYOUT_MISMATCH",
          `redemption:${redemption.redemptionId}`,
          expected,
          redemption.payoutUsdScaledRecorded,
        ),
      );
    }
  }
  return breaks;
}

// ============================================================
// 11. Rounding/dust invariant: reconstructing pool value from total_units at
// the recorded unit price must never exceed NAV — accounting.md §4,
// "Rounding direction": rounding never manufactures value out of the pool.
// A violation here means either the recorded unit_price_scaled or
// total_units has been tampered with or corrupted, since correctly-derived
// values can never produce this.
// ============================================================

export interface DustInvariantInput {
  readonly navUsdScaled: NavScaled1e9;
  readonly totalUnitsScaled: NavScaled1e9;
  readonly unitPriceScaled: NavScaled1e9;
  readonly context?: string;
}

export function checkDustInvariant(input: DustInvariantInput): ReconciliationBreak[] {
  const reconstructedValue = payoutOnRedeem(input.totalUnitsScaled, input.unitPriceScaled);
  if (reconstructedValue > input.navUsdScaled) {
    return [
      mismatch(
        "DUST_INVARIANT_VIOLATION",
        input.context ?? "reconstructed_pool_value",
        input.navUsdScaled,
        reconstructedValue,
      ),
    ];
  }
  return [];
}

/**
 * Convenience: recomputes what unit_price_scaled *should* be from NAV and
 * total_units, for callers that want to detect a stale/tampered published
 * price directly rather than only its downstream dust symptom above.
 */
export function checkUnitPriceFreshness(
  navUsdScaled: NavScaled1e9,
  totalUnitsScaled: NavScaled1e9,
  recordedUnitPriceScaled: NavScaled1e9,
  context = "vault_state_mirror.unit_price_scaled",
): ReconciliationBreak[] {
  const expected = recomputeUnitPrice(navUsdScaled, totalUnitsScaled);
  if (expected !== recordedUnitPriceScaled) {
    return [mismatch("NAV_COMPOSITION_MISMATCH", context, expected, recordedUnitPriceScaled)];
  }
  return [];
}

// ============================================================
// 12. Duplicate or missing transaction attribution — spec §10: "every
// confirmed on-chain transaction has a matching internal record and vice
// versa (orphan detection both directions)"; db-schema.md's
// `uq_deposit_idempotency (tx_signature, instruction_index, mint)`.
// ============================================================

export interface TxAttributionKey {
  readonly txSignature: string;
  readonly instructionIndex: number;
  readonly mint: string;
}

function attributionKey(k: TxAttributionKey): string {
  return `${k.txSignature}:${k.instructionIndex}:${k.mint}`;
}

export function checkTransactionAttribution(
  onchainConfirmed: readonly TxAttributionKey[],
  ledgerRecorded: readonly TxAttributionKey[],
): ReconciliationBreak[] {
  const breaks: ReconciliationBreak[] = [];

  const ledgerCounts = new Map<string, number>();
  for (const record of ledgerRecorded) {
    const key = attributionKey(record);
    ledgerCounts.set(key, (ledgerCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of ledgerCounts) {
    if (count > 1) {
      breaks.push(mismatch("DUPLICATE_TX_ATTRIBUTION", key, 1n, BigInt(count)));
    }
  }

  const onchainKeys = new Set(onchainConfirmed.map(attributionKey));
  const ledgerKeys = new Set(ledgerCounts.keys());

  for (const key of onchainKeys) {
    if (!ledgerKeys.has(key)) {
      breaks.push(mismatch("ORPHAN_ONCHAIN_TX", key, 1n, 0n));
    }
  }
  for (const key of ledgerKeys) {
    if (!onchainKeys.has(key)) {
      breaks.push(mismatch("ORPHAN_LEDGER_TX", key, 0n, 1n));
    }
  }

  return breaks;
}

// ============================================================
// Aggregate entry point. Optional per-category inputs so a caller can run a
// partial reconciliation (e.g. just deposits) without assembling every
// section — every field is independently optional and independently
// checked; omitting a section runs zero checks for it rather than failing.
// ============================================================

export interface ReconciliationInput {
  readonly unitConservation?: {
    clientUnitsScaled: ReadonlyMap<string, NavScaled1e9>;
    totalUnitsScaled: NavScaled1e9;
  };
  readonly navComposition?: NavCompositionInput;
  readonly clientUnitBalances?: {
    ledgerUnitsScaled: ReadonlyMap<string, NavScaled1e9>;
    onchainUnitsScaled: ReadonlyMap<string, NavScaled1e9>;
  };
  readonly positionBalances?: {
    ledgerPositionsRaw: ReadonlyMap<string, bigint>;
    onchainPositionsRaw: ReadonlyMap<string, bigint>;
  };
  readonly cashBalance?: { ledgerCashRaw: bigint; onchainCashRaw: bigint };
  readonly unexplainedAssets?: {
    onchainCustodyRaw: ReadonlyMap<string, bigint>;
    bucketBalances: ReadonlyMap<string, AssetBucketBalances>;
  };
  readonly excessRecords?: readonly ExcessRecord[];
  readonly unattributedRecords?: readonly UnattributedRecord[];
  readonly managementFeeAccrual?: ManagementFeeAccrualCheckInput;
  readonly deposits?: readonly DepositUnitsCheckInput[];
  readonly redemptions?: readonly RedemptionPayoutCheckInput[];
  readonly dustInvariant?: DustInvariantInput;
  readonly transactionAttribution?: {
    onchainConfirmed: readonly TxAttributionKey[];
    ledgerRecorded: readonly TxAttributionKey[];
  };
}

export function reconcile(input: ReconciliationInput): ReconciliationBreak[] {
  const breaks: ReconciliationBreak[] = [];

  if (input.unitConservation) {
    breaks.push(
      ...checkUnitConservation(
        input.unitConservation.clientUnitsScaled,
        input.unitConservation.totalUnitsScaled,
      ),
    );
  }
  if (input.navComposition) {
    breaks.push(...checkNavComposition(input.navComposition));
  }
  if (input.clientUnitBalances) {
    breaks.push(
      ...checkClientUnitBalances(
        input.clientUnitBalances.ledgerUnitsScaled,
        input.clientUnitBalances.onchainUnitsScaled,
      ),
    );
  }
  if (input.positionBalances) {
    breaks.push(
      ...checkPositionBalances(
        input.positionBalances.ledgerPositionsRaw,
        input.positionBalances.onchainPositionsRaw,
      ),
    );
  }
  if (input.cashBalance) {
    breaks.push(...checkCashBalance(input.cashBalance.ledgerCashRaw, input.cashBalance.onchainCashRaw));
  }
  if (input.unexplainedAssets) {
    breaks.push(
      ...checkUnexplainedAssetBalances(
        input.unexplainedAssets.onchainCustodyRaw,
        input.unexplainedAssets.bucketBalances,
      ),
    );
  }
  if (input.excessRecords) {
    breaks.push(...checkExcessSegregation(input.excessRecords));
  }
  if (input.unattributedRecords) {
    breaks.push(...checkUnattributedNotCredited(input.unattributedRecords));
  }
  if (input.managementFeeAccrual) {
    breaks.push(...checkManagementFeeAccrual(input.managementFeeAccrual));
  }
  if (input.deposits) {
    breaks.push(...checkDepositUnitsIssued(input.deposits));
  }
  if (input.redemptions) {
    breaks.push(...checkRedemptionPayout(input.redemptions));
  }
  if (input.dustInvariant) {
    breaks.push(...checkDustInvariant(input.dustInvariant));
  }
  if (input.transactionAttribution) {
    breaks.push(
      ...checkTransactionAttribution(
        input.transactionAttribution.onchainConfirmed,
        input.transactionAttribution.ledgerRecorded,
      ),
    );
  }

  return breaks;
}
