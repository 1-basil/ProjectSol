import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAssetHeadroomUsdMicros, computeSweepAmountNative, computeCreditedUsdMicros } from "../src/cap/capCheck.ts";

const ONE_MILLION_USD_MICROS = 1_000_000n * 1_000_000n;

test("headroom is cap minus cumulative credited", () => {
  const headroom = computeAssetHeadroomUsdMicros({
    cumulativeCreditedUsdMicros: 400_000n * 1_000_000n,
    assetCapUsdMicros: ONE_MILLION_USD_MICROS,
  });
  assert.equal(headroom, 600_000n * 1_000_000n);
});

test("headroom saturates to zero rather than going negative", () => {
  const headroom = computeAssetHeadroomUsdMicros({
    cumulativeCreditedUsdMicros: 1_200_000n * 1_000_000n, // somehow over cap
    assetCapUsdMicros: ONE_MILLION_USD_MICROS,
  });
  assert.equal(headroom, 0n);
});

test("headroom is exactly zero at the cap boundary", () => {
  const headroom = computeAssetHeadroomUsdMicros({
    cumulativeCreditedUsdMicros: ONE_MILLION_USD_MICROS,
    assetCapUsdMicros: ONE_MILLION_USD_MICROS,
  });
  assert.equal(headroom, 0n);
});

// ---- Per-asset isolation: the whole point of the corrected design ----

test("crediting USDC to its cap leaves an independently-tracked SOL cap state completely untouched", () => {
  // Two entirely separate AssetCapState objects, exactly mirroring two
  // separate client_asset_authorizations rows. Nothing about computing one
  // reads or writes the other — there is no shared aggregate to entangle them.
  const usdcState = { cumulativeCreditedUsdMicros: ONE_MILLION_USD_MICROS, assetCapUsdMicros: ONE_MILLION_USD_MICROS };
  const solState = { cumulativeCreditedUsdMicros: 0n, assetCapUsdMicros: ONE_MILLION_USD_MICROS };

  assert.equal(computeAssetHeadroomUsdMicros(usdcState), 0n); // USDC maxed out
  assert.equal(computeAssetHeadroomUsdMicros(solState), ONE_MILLION_USD_MICROS); // SOL fully available, unaffected
});

test("$900k USDC + $900k SOL are both independently valid (neither shares a ceiling)", () => {
  const usdcState = { cumulativeCreditedUsdMicros: 900_000n * 1_000_000n, assetCapUsdMicros: ONE_MILLION_USD_MICROS };
  const solState = { cumulativeCreditedUsdMicros: 900_000n * 1_000_000n, assetCapUsdMicros: ONE_MILLION_USD_MICROS };
  assert.equal(computeAssetHeadroomUsdMicros(usdcState), 100_000n * 1_000_000n);
  assert.equal(computeAssetHeadroomUsdMicros(solState), 100_000n * 1_000_000n);
});

test("each of many assets stops independently at exactly $1,000,000", () => {
  const assets = ["SOL", "USDC", "USDT", "TOKEN_A"].map((key) => ({
    key,
    state: { cumulativeCreditedUsdMicros: 0n, assetCapUsdMicros: ONE_MILLION_USD_MICROS },
  }));
  // Drive SOL and USDC to their caps; TOKEN_A and USDT untouched.
  assets[0].state = { ...assets[0].state, cumulativeCreditedUsdMicros: ONE_MILLION_USD_MICROS };
  assets[1].state = { ...assets[1].state, cumulativeCreditedUsdMicros: ONE_MILLION_USD_MICROS };

  assert.equal(computeAssetHeadroomUsdMicros(assets[0].state), 0n); // SOL maxed
  assert.equal(computeAssetHeadroomUsdMicros(assets[1].state), 0n); // USDC maxed
  assert.equal(computeAssetHeadroomUsdMicros(assets[2].state), ONE_MILLION_USD_MICROS); // USDT untouched
  assert.equal(computeAssetHeadroomUsdMicros(assets[3].state), ONE_MILLION_USD_MICROS); // TOKEN_A untouched
});

// ---- Sweep amount: three independent ceilings, minimum wins ----

const DOLLAR_PRICE = { priceScaled: 100_000_000n, priceExponentAbs: 8 }; // $1.00

test("sweep amount is capped by the live account balance when that is the tightest ceiling", () => {
  const amount = computeSweepAmountNative({
    onChainDelegatedRemainingNative: 1_000_000_000n,
    liveAccountBalanceNative: 500_000_000n, // 6-decimal token, $500
    headroomUsdMicros: 1_000_000n * 1_000_000n, // $1,000,000 headroom
    price: DOLLAR_PRICE,
    decimals: 6,
  });
  assert.equal(amount, 500_000_000n);
});

test("sweep amount is capped by the on-chain delegated amount when that is the tightest ceiling", () => {
  const amount = computeSweepAmountNative({
    onChainDelegatedRemainingNative: 100_000_000n, // only $100 approved remaining
    liveAccountBalanceNative: 500_000_000n,
    headroomUsdMicros: 1_000_000n * 1_000_000n,
    price: DOLLAR_PRICE,
    decimals: 6,
  });
  assert.equal(amount, 100_000_000n);
});

test("sweep amount is capped by remaining USD headroom when that is the tightest ceiling", () => {
  const amount = computeSweepAmountNative({
    onChainDelegatedRemainingNative: 1_000_000_000_000n,
    liveAccountBalanceNative: 1_000_000_000_000n,
    headroomUsdMicros: 50n * 1_000_000n, // only $50 of headroom left
    price: DOLLAR_PRICE,
    decimals: 6,
  });
  assert.equal(amount, 50_000_000n); // 50 USDC-equivalent, 6 decimals
});

test("zero headroom sweeps nothing", () => {
  const amount = computeSweepAmountNative({
    onChainDelegatedRemainingNative: 1_000_000n,
    liveAccountBalanceNative: 1_000_000n,
    headroomUsdMicros: 0n,
    price: DOLLAR_PRICE,
    decimals: 6,
  });
  assert.equal(amount, 0n);
});

test("a live price above the on-chain approval's implied ceiling still cannot exceed USD headroom", () => {
  // SOL price doubles after approval: the on-chain lamport ceiling would
  // technically allow more value than $1,000,000 now, but the live USD
  // check must still govern.
  const dustSol = { priceScaled: 200_000_000n, priceExponentAbs: 8 }; // $2.00 (was $1.00 at approval time)
  const oneMillionSolInLamports = 1_000_000n * 1_000_000_000n; // $1,000,000 worth of SOL at $1.00/SOL, at approval time
  const amount = computeSweepAmountNative({
    onChainDelegatedRemainingNative: oneMillionSolInLamports,
    liveAccountBalanceNative: oneMillionSolInLamports,
    headroomUsdMicros: 1_000_000n * 1_000_000n, // still only $1,000,000 remaining cap
    price: dustSol,
    decimals: 9,
  });
  // At $2/SOL, $1,000,000 of headroom converts to 500,000 SOL (5e14 lamports),
  // which is less than the 1e12-lamport on-chain ceiling and live balance —
  // the live USD check is the binding constraint, exactly as designed.
  assert.equal(amount, 500_000_000_000_000n);
});

test("computeCreditedUsdMicros matches the amount actually priced for the sweep", () => {
  const usd = computeCreditedUsdMicros(500_000_000n, DOLLAR_PRICE, 6);
  assert.equal(usd, 500_000_000n); // 500 tokens at $1 = $500 = 500_000_000 micros
});
