import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkUnitConservation,
  checkNavComposition,
  checkUnitPriceFreshness,
  checkClientUnitBalances,
  checkPositionBalances,
  checkCashBalance,
  checkUnexplainedAssetBalances,
  checkExcessSegregation,
  checkUnattributedNotCredited,
  checkManagementFeeAccrual,
  checkDepositUnitsIssued,
  checkRedemptionPayout,
  checkDustInvariant,
  checkTransactionAttribution,
  reconcile,
  type AssetBucketBalances,
} from "../src/reconciliation.ts";
import { UNIT_PRICE_SCALE as SCALE, INITIAL_UNIT_PRICE, unitsIssuedOnSubscribe, payoutOnRedeem } from "../src/ledger.ts";
import { accrueDailyManagementFee } from "../src/fees.ts";
import { navScaled1e9 } from "../src/usd-micros.ts";

function usd(whole: bigint) {
  return navScaled1e9(whole * SCALE);
}

// ============================================================
// 1. Unit conservation
// ============================================================

test("unit conservation: valid state produces no break", () => {
  const clientUnits = new Map([
    ["A", navScaled1e9(50_000n * SCALE)],
    ["B", navScaled1e9(90_909_090_909_090n)],
  ]);
  const total = navScaled1e9(50_000n * SCALE + 90_909_090_909_090n);
  assert.deepEqual(checkUnitConservation(clientUnits, total), []);
});

test("unit conservation: corrupted total_units is detected", () => {
  const clientUnits = new Map([
    ["A", navScaled1e9(50_000n * SCALE)],
    ["B", navScaled1e9(90_909_090_909_090n)],
  ]);
  const trueSum = 50_000n * SCALE + 90_909_090_909_090n;
  const corruptedTotal = navScaled1e9(trueSum + 1n); // phantom unit minted with no client owner
  const breaks = checkUnitConservation(clientUnits, corruptedTotal);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "UNIT_CONSERVATION_MISMATCH");
  assert.equal(breaks[0].severity, "HARD_BREACH");
  assert.equal(breaks[0].expected, corruptedTotal);
  assert.equal(breaks[0].actual, trueSum);
});

// ============================================================
// 2. NAV vs ledger inconsistencies
// ============================================================

test("NAV composition: valid state produces no break", () => {
  const breaks = checkNavComposition({
    cashUsdScaled: usd(10_000n),
    positionsValueUsdScaled: usd(145_000n),
    liabilitiesUsdScaled: usd(0n),
    accruedFeesUsdScaled: usd(0n),
    recordedNavUsdScaled: usd(155_000n),
  });
  assert.deepEqual(breaks, []);
});

test("NAV composition: a NAV published inconsistent with cash+positions-liabilities-fees is detected", () => {
  const breaks = checkNavComposition({
    cashUsdScaled: usd(10_000n),
    positionsValueUsdScaled: usd(145_000n),
    liabilitiesUsdScaled: usd(0n),
    accruedFeesUsdScaled: usd(0n),
    recordedNavUsdScaled: usd(155_001n), // one dollar over — e.g. an insider-inflated publish
  });
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "NAV_COMPOSITION_MISMATCH");
  assert.equal(breaks[0].expected, usd(155_000n));
  assert.equal(breaks[0].actual, usd(155_001n));
});

test("unit price freshness: a correctly-derived price produces no break", () => {
  const nav = usd(170_500n);
  const totalUnits = navScaled1e9(140_909_090_909_090n);
  const breaks = checkUnitPriceFreshness(nav, totalUnits, navScaled1e9(1_210_000_000n));
  assert.deepEqual(breaks, []);
});

test("unit price freshness: a stale/tampered published price is detected", () => {
  const nav = usd(170_500n);
  const totalUnits = navScaled1e9(140_909_090_909_090n);
  const staleprice = navScaled1e9(1_100_000_000n); // yesterday's price, never recomputed
  const breaks = checkUnitPriceFreshness(nav, totalUnits, staleprice);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].expected, 1_210_000_000n);
  assert.equal(breaks[0].actual, staleprice);
});

// ============================================================
// 3. Client-unit balance mismatches
// ============================================================

test("client unit balances: matching ledger and on-chain state produces no break", () => {
  const ledger = new Map([["A", navScaled1e9(100n * SCALE)]]);
  const onchain = new Map([["A", navScaled1e9(100n * SCALE)]]);
  assert.deepEqual(checkClientUnitBalances(ledger, onchain), []);
});

test("client unit balances: a ledger/chain divergence for one client is detected", () => {
  const ledger = new Map([["A", navScaled1e9(100n * SCALE)]]);
  const onchain = new Map([["A", navScaled1e9(99n * SCALE)]]); // ledger over-credited A by 1 unit
  const breaks = checkClientUnitBalances(ledger, onchain);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "CLIENT_UNIT_BALANCE_MISMATCH");
  assert.equal(breaks[0].context, "client:A");
  assert.equal(breaks[0].expected, 99n * SCALE);
  assert.equal(breaks[0].actual, 100n * SCALE);
});

test("client unit balances: a client present in one snapshot but not the other is detected", () => {
  const ledger = new Map([["A", navScaled1e9(100n * SCALE)], ["B", navScaled1e9(50n * SCALE)]]);
  const onchain = new Map([["A", navScaled1e9(100n * SCALE)]]); // B never made it on-chain
  const breaks = checkClientUnitBalances(ledger, onchain);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].context, "client:B");
  assert.equal(breaks[0].expected, 0n);
  assert.equal(breaks[0].actual, 50n * SCALE);
});

// ============================================================
// 4. Position / cash balance mismatches
// ============================================================

test("position balances: matching ledger and on-chain token balances produce no break", () => {
  const ledger = new Map([["So1anaSOL", 1_000_000_000n]]);
  const onchain = new Map([["So1anaSOL", 1_000_000_000n]]);
  assert.deepEqual(checkPositionBalances(ledger, onchain), []);
});

test("position balances: a divergent on-chain token balance for a mint is detected", () => {
  const ledger = new Map([["So1anaSOL", 1_000_000_000n]]);
  const onchain = new Map([["So1anaSOL", 999_000_000n]]); // a trade recorded in the ledger but not confirmed on-chain
  const breaks = checkPositionBalances(ledger, onchain);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "POSITION_BALANCE_MISMATCH");
  assert.equal(breaks[0].context, "mint:So1anaSOL");
});

test("cash balance: matching ledger and on-chain cash produce no break", () => {
  assert.deepEqual(checkCashBalance(500_000_000n, 500_000_000n), []);
});

test("cash balance: a divergent on-chain cash balance is detected", () => {
  const breaks = checkCashBalance(500_000_000n, 400_000_000n);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "CASH_BALANCE_MISMATCH");
  assert.equal(breaks[0].expected, 400_000_000n);
  assert.equal(breaks[0].actual, 500_000_000n);
});

// ============================================================
// 5. Unexplained asset balances
// ============================================================

test("unexplained asset balances: fully-accounted custody balances produce no break", () => {
  const onchain = new Map([["USDC", 1_000n]]);
  const buckets = new Map<string, AssetBucketBalances>([
    ["USDC", { managedRaw: 800n, unmanagedExcessRaw: 150n, unattributedRaw: 50n }],
  ]);
  assert.deepEqual(checkUnexplainedAssetBalances(onchain, buckets), []);
});

test("unexplained asset balances: a custody balance no bucket claims is detected", () => {
  const onchain = new Map([["USDC", 1_000n]]);
  const buckets = new Map<string, AssetBucketBalances>([
    ["USDC", { managedRaw: 800n, unmanagedExcessRaw: 100n, unattributedRaw: 0n }], // 100 unexplained
  ]);
  const breaks = checkUnexplainedAssetBalances(onchain, buckets);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "UNEXPLAINED_ASSET_BALANCE");
  assert.equal(breaks[0].expected, 1_000n);
  assert.equal(breaks[0].actual, 900n);
});

// ============================================================
// 6. UNMANAGED_EXCESS accidentally entering managed accounting
// ============================================================

test("excess segregation: an excess record with zero units issued produces no break", () => {
  const breaks = checkExcessSegregation([
    { clientId: "A", mint: "USDC", unitsIssuedScaled: navScaled1e9(0n) },
  ]);
  assert.deepEqual(breaks, []);
});

test("excess segregation: an excess record that issued units is detected", () => {
  const breaks = checkExcessSegregation([
    { clientId: "A", mint: "USDC", unitsIssuedScaled: navScaled1e9(5n * SCALE) },
  ]);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "EXCESS_LEAKED_INTO_MANAGED");
  assert.equal(breaks[0].context, "client:A:mint:USDC");
  assert.equal(breaks[0].expected, 0n);
  assert.equal(breaks[0].actual, 5n * SCALE);
});

// ============================================================
// 7. UNATTRIBUTED funds being credited or traded
// ============================================================

test("unattributed funds: an untouched unattributed record produces no break", () => {
  const breaks = checkUnattributedNotCredited([
    { txSignature: "sig1", creditedUnitsScaled: navScaled1e9(0n), tradedRaw: 0n },
  ]);
  assert.deepEqual(breaks, []);
});

test("unattributed funds: crediting units or trading against an unattributed deposit is detected", () => {
  const creditedBreaks = checkUnattributedNotCredited([
    { txSignature: "sig1", creditedUnitsScaled: navScaled1e9(100n), tradedRaw: 0n },
  ]);
  assert.equal(creditedBreaks.length, 1);
  assert.equal(creditedBreaks[0].breakType, "UNATTRIBUTED_FUNDS_MISUSED");
  assert.equal(creditedBreaks[0].context, "tx:sig1:credited");

  const tradedBreaks = checkUnattributedNotCredited([
    { txSignature: "sig2", creditedUnitsScaled: navScaled1e9(0n), tradedRaw: 500n },
  ]);
  assert.equal(tradedBreaks.length, 1);
  assert.equal(tradedBreaks[0].breakType, "UNATTRIBUTED_FUNDS_MISUSED");
  assert.equal(tradedBreaks[0].context, "tx:sig2:traded");
});

// ============================================================
// 8. Fee-accrual mismatches
// ============================================================

test("management fee accrual: a correctly recomputed fee produces no break", () => {
  const nav = usd(155_000n);
  const expected = accrueDailyManagementFee(nav, 100);
  const breaks = checkManagementFeeAccrual({
    navBeforeFeeUsdScaled: nav,
    annualFeeBps: 100,
    recordedFeeUsdScaled: expected.feeUsdScaled,
  });
  assert.deepEqual(breaks, []);
});

test("management fee accrual: a recorded fee that doesn't match the formula is detected", () => {
  const nav = usd(155_000n);
  const expected = accrueDailyManagementFee(nav, 100);
  const corruptedFee = navScaled1e9(expected.feeUsdScaled + 1n);
  const breaks = checkManagementFeeAccrual({
    navBeforeFeeUsdScaled: nav,
    annualFeeBps: 100,
    recordedFeeUsdScaled: corruptedFee,
  });
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "FEE_ACCRUAL_MISMATCH");
  assert.equal(breaks[0].expected, expected.feeUsdScaled);
  assert.equal(breaks[0].actual, corruptedFee);
});

// ============================================================
// 9. Deposit state mismatches
// ============================================================

test("deposit units: a correctly recomputed units_issued produces no break", () => {
  const amount = usd(100n);
  const price = INITIAL_UNIT_PRICE;
  const expected = unitsIssuedOnSubscribe(amount, price);
  const breaks = checkDepositUnitsIssued([
    { txSignature: "sig1", amountUsdScaled: amount, unitPriceScaledAtCredit: price, unitsIssuedRecorded: expected },
  ]);
  assert.deepEqual(breaks, []);
});

test("deposit units: a recorded units_issued that doesn't match the subscribe formula is detected", () => {
  const amount = usd(100n);
  const price = INITIAL_UNIT_PRICE;
  const expected = unitsIssuedOnSubscribe(amount, price);
  const corrupted = navScaled1e9(expected + 1n); // one extra unit minted beyond what the deposit paid for
  const breaks = checkDepositUnitsIssued([
    { txSignature: "sig1", amountUsdScaled: amount, unitPriceScaledAtCredit: price, unitsIssuedRecorded: corrupted },
  ]);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "DEPOSIT_UNITS_MISMATCH");
  assert.equal(breaks[0].context, "tx:sig1");
  assert.equal(breaks[0].expected, expected);
  assert.equal(breaks[0].actual, corrupted);
});

// ============================================================
// 10. Redemption state mismatches
// ============================================================

test("redemption payout: a correctly recomputed payout produces no break", () => {
  const units = navScaled1e9(100n * SCALE);
  const price = navScaled1e9(1_210_000_000n);
  const expected = payoutOnRedeem(units, price);
  const breaks = checkRedemptionPayout([
    { redemptionId: "r1", unitsBurnedScaled: units, struckUnitPriceScaled: price, payoutUsdScaledRecorded: expected },
  ]);
  assert.deepEqual(breaks, []);
});

test("redemption payout: a recorded payout that doesn't match the redeem formula is detected", () => {
  const units = navScaled1e9(100n * SCALE);
  const price = navScaled1e9(1_210_000_000n);
  const expected = payoutOnRedeem(units, price);
  const corrupted = navScaled1e9(expected + usd(1n)); // client paid out $1 more than their units are worth
  const breaks = checkRedemptionPayout([
    { redemptionId: "r1", unitsBurnedScaled: units, struckUnitPriceScaled: price, payoutUsdScaledRecorded: corrupted },
  ]);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "REDEMPTION_PAYOUT_MISMATCH");
  assert.equal(breaks[0].expected, expected);
  assert.equal(breaks[0].actual, corrupted);
});

// ============================================================
// 11. Rounding/dust inconsistencies
// ============================================================

test("dust invariant: reconstructed value at or below NAV produces no break", () => {
  const breaks = checkDustInvariant({
    navUsdScaled: usd(170_500n),
    totalUnitsScaled: navScaled1e9(140_909_090_909_090n),
    unitPriceScaled: navScaled1e9(1_210_000_000n),
  });
  assert.deepEqual(breaks, []);
});

test("dust invariant: a tampered unit price that would manufacture value beyond NAV is detected", () => {
  const nav = usd(100n);
  const totalUnits = navScaled1e9(100n * SCALE);
  const inflatedPrice = navScaled1e9(2n * SCALE); // 2.0 instead of the true 1.0 — doubles apparent value
  const breaks = checkDustInvariant({ navUsdScaled: nav, totalUnitsScaled: totalUnits, unitPriceScaled: inflatedPrice });
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "DUST_INVARIANT_VIOLATION");
  assert.equal(breaks[0].expected, nav);
  assert.equal(breaks[0].actual, usd(200n));
});

// ============================================================
// 12. Duplicate or missing transaction attribution
// ============================================================

test("transaction attribution: matching on-chain and ledger sets produce no break", () => {
  const keys = [{ txSignature: "sig1", instructionIndex: 0, mint: "USDC" }];
  assert.deepEqual(checkTransactionAttribution(keys, keys), []);
});

test("transaction attribution: a duplicate ledger record for the same signature is detected", () => {
  const onchain = [{ txSignature: "sig1", instructionIndex: 0, mint: "USDC" }];
  const ledger = [
    { txSignature: "sig1", instructionIndex: 0, mint: "USDC" },
    { txSignature: "sig1", instructionIndex: 0, mint: "USDC" }, // double-processed by a retried worker
  ];
  const breaks = checkTransactionAttribution(onchain, ledger);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "DUPLICATE_TX_ATTRIBUTION");
  assert.equal(breaks[0].actual, 2n);
});

test("transaction attribution: an on-chain-confirmed deposit missing from the ledger is detected", () => {
  const onchain = [{ txSignature: "sig1", instructionIndex: 0, mint: "USDC" }];
  const ledger: typeof onchain = [];
  const breaks = checkTransactionAttribution(onchain, ledger);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "ORPHAN_ONCHAIN_TX");
});

test("transaction attribution: a ledger record with no matching on-chain confirmation is detected", () => {
  const onchain: { txSignature: string; instructionIndex: number; mint: string }[] = [];
  const ledger = [{ txSignature: "sig1", instructionIndex: 0, mint: "USDC" }];
  const breaks = checkTransactionAttribution(onchain, ledger);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "ORPHAN_LEDGER_TX");
});

// ============================================================
// Aggregate entry point
// ============================================================

test("reconcile: an entirely clean snapshot produces zero breaks across every category", () => {
  const clientUnits = new Map([["A", navScaled1e9(100n * SCALE)]]);
  const breaks = reconcile({
    unitConservation: { clientUnitsScaled: clientUnits, totalUnitsScaled: navScaled1e9(100n * SCALE) },
    navComposition: {
      cashUsdScaled: usd(50n),
      positionsValueUsdScaled: usd(50n),
      liabilitiesUsdScaled: usd(0n),
      accruedFeesUsdScaled: usd(0n),
      recordedNavUsdScaled: usd(100n),
    },
    clientUnitBalances: { ledgerUnitsScaled: clientUnits, onchainUnitsScaled: clientUnits },
    positionBalances: {
      ledgerPositionsRaw: new Map([["USDC", 1_000n]]),
      onchainPositionsRaw: new Map([["USDC", 1_000n]]),
    },
    cashBalance: { ledgerCashRaw: 500n, onchainCashRaw: 500n },
    excessRecords: [{ clientId: "A", mint: "USDC", unitsIssuedScaled: navScaled1e9(0n) }],
    unattributedRecords: [{ txSignature: "sig1", creditedUnitsScaled: navScaled1e9(0n), tradedRaw: 0n }],
    dustInvariant: {
      navUsdScaled: usd(100n),
      totalUnitsScaled: navScaled1e9(100n * SCALE),
      unitPriceScaled: SCALE,
    },
    transactionAttribution: {
      onchainConfirmed: [{ txSignature: "sig1", instructionIndex: 0, mint: "USDC" }],
      ledgerRecorded: [{ txSignature: "sig1", instructionIndex: 0, mint: "USDC" }],
    },
  });
  assert.deepEqual(breaks, []);
});

test("reconcile: a single corrupted category surfaces exactly that break and nothing else", () => {
  const clientUnits = new Map([["A", navScaled1e9(100n * SCALE)]]);
  const breaks = reconcile({
    unitConservation: { clientUnitsScaled: clientUnits, totalUnitsScaled: navScaled1e9(100n * SCALE) },
    excessRecords: [{ clientId: "A", mint: "USDC", unitsIssuedScaled: navScaled1e9(1n) }], // the corruption
  });
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].breakType, "EXCESS_LEAKED_INTO_MANAGED");
});

test("reconcile: omitted sections run zero checks rather than throwing", () => {
  assert.deepEqual(reconcile({}), []);
});
