import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSplAssets, isSolEligible, MAX_SPL_ASSETS_PER_CLIENT, type HeldAsset } from "../src/scan/selectAssets.ts";

function held(assetKey: string, usdDollars: number): HeldAsset {
  return { assetKey, nativeAmount: 1n, usdValueMicros: BigInt(usdDollars) * 1_000_000n };
}

const DUST = 1_000_000n; // $1.00

test("selects the top 7 SPL holdings by USD value, descending", () => {
  const heldAssets = [
    held("A", 10),
    held("B", 5000),
    held("C", 200),
    held("D", 50000),
    held("E", 1),
    held("F", 999),
    held("G", 2),
    held("H", 3),
  ];
  const result = selectSplAssets({ heldAssets, alreadyAuthorizedAssetKeys: new Set(), dustThresholdUsdMicros: DUST });
  assert.equal(result.length, 7);
  assert.deepEqual(result.map((r) => r.assetKey), ["D", "B", "F", "C", "A", "H", "G"]);
});

test("selects fewer than 7 when the client holds fewer than 7 eligible SPL assets", () => {
  const heldAssets = [held("A", 100), held("B", 50), held("C", 10)];
  const result = selectSplAssets({ heldAssets, alreadyAuthorizedAssetKeys: new Set(), dustThresholdUsdMicros: DUST });
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((r) => r.assetKey), ["A", "B", "C"]);
});

test("holding 12 eligible assets still selects only the top 7", () => {
  const heldAssets = Array.from({ length: 12 }, (_, i) => held(`T${i}`, (i + 1) * 100));
  const result = selectSplAssets({ heldAssets, alreadyAuthorizedAssetKeys: new Set(), dustThresholdUsdMicros: DUST });
  assert.equal(result.length, 7);
  // Highest values are T11 (1200) down to T5 (600).
  assert.deepEqual(
    result.map((r) => r.assetKey),
    ["T11", "T10", "T9", "T8", "T7", "T6", "T5"],
  );
});

test("dust balances below the threshold never consume a slot", () => {
  const heldAssets = [held("REAL", 100), held("DUST1", 0), held("DUST2", 0)];
  const dustHolding: HeldAsset = { assetKey: "DUST3", nativeAmount: 1n, usdValueMicros: 999_999n }; // $0.999999, just under $1
  const result = selectSplAssets({
    heldAssets: [...heldAssets, dustHolding],
    alreadyAuthorizedAssetKeys: new Set(),
    dustThresholdUsdMicros: DUST,
  });
  assert.deepEqual(result.map((r) => r.assetKey), ["REAL"]);
});

test("a balance exactly at the dust threshold counts as held", () => {
  const exact: HeldAsset = { assetKey: "EXACT", nativeAmount: 1n, usdValueMicros: DUST };
  const result = selectSplAssets({ heldAssets: [exact], alreadyAuthorizedAssetKeys: new Set(), dustThresholdUsdMicros: DUST });
  assert.equal(result.length, 1);
});

test("already-authorized assets are excluded and never re-selected", () => {
  const heldAssets = [held("A", 1000), held("B", 500), held("C", 100)];
  const result = selectSplAssets({
    heldAssets,
    alreadyAuthorizedAssetKeys: new Set(["A"]),
    dustThresholdUsdMicros: DUST,
  });
  assert.deepEqual(result.map((r) => r.assetKey), ["B", "C"]);
});

test("remaining slot budget shrinks as more assets are already authorized", () => {
  const heldAssets = Array.from({ length: 10 }, (_, i) => held(`T${i}`, 100 - i));
  const alreadyAuthorized = new Set(["T0", "T1", "T2", "T3", "T4"]); // 5 already authorized
  const result = selectSplAssets({ heldAssets, alreadyAuthorizedAssetKeys: alreadyAuthorized, dustThresholdUsdMicros: DUST });
  assert.equal(result.length, 2); // only 2 slots remain (7 - 5)
  assert.deepEqual(result.map((r) => r.assetKey), ["T5", "T6"]);
});

test("no remaining slots (7 already authorized) selects nothing, never an 8th SPL asset", () => {
  const heldAssets = [held("NEW", 1_000_000)]; // enormous value, still must not get a slot
  const alreadyAuthorized = new Set(["A", "B", "C", "D", "E", "F", "G"]);
  const result = selectSplAssets({ heldAssets, alreadyAuthorizedAssetKeys: alreadyAuthorized, dustThresholdUsdMicros: DUST });
  assert.deepEqual(result, []);
});

test("ties in USD value break deterministically by asset key, not input order", () => {
  const heldAssets = [held("Z", 100), held("A", 100), held("M", 100)];
  const result = selectSplAssets({ heldAssets, alreadyAuthorizedAssetKeys: new Set(), dustThresholdUsdMicros: DUST });
  assert.deepEqual(result.map((r) => r.assetKey), ["A", "M", "Z"]);
});

test("MAX_SPL_ASSETS_PER_CLIENT is 7, matching the locked spec", () => {
  assert.equal(MAX_SPL_ASSETS_PER_CLIENT, 7);
});

// ---- SOL: entirely independent of the SPL selection ----

test("SOL eligibility is independent of any SPL selection state", () => {
  const heldAssets = Array.from({ length: 20 }, (_, i) => held(`T${i}`, 1000)); // way more than 7 eligible SPL assets
  const splResult = selectSplAssets({ heldAssets, alreadyAuthorizedAssetKeys: new Set(), dustThresholdUsdMicros: DUST });
  assert.equal(splResult.length, 7); // SPL selection still capped at 7

  const solEligible = isSolEligible({ heldLamports: 5_000_000_000n, usdValueMicros: 500_000_000n }, DUST);
  assert.equal(solEligible, true); // SOL is unaffected by there being 20 competing SPL holdings
});

test("dust SOL (leftover fee reserve) is not eligible", () => {
  assert.equal(isSolEligible({ heldLamports: 1000n, usdValueMicros: 500_000n }, DUST), false); // $0.50
});

test("SOL exactly at the dust threshold is eligible", () => {
  assert.equal(isSolEligible({ heldLamports: 1000n, usdValueMicros: DUST }, DUST), true);
});
