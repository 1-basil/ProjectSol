import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.ts";
import { usdMicros, type UsdMicros } from "../src/usd-micros.ts";
import type { RankableAsset } from "../src/comparator.ts";

function mint(id: number): Uint8Array {
  const arr = new Uint8Array(32);
  arr[31] = id;
  return arr;
}

function usd(dollars: number): UsdMicros {
  return usdMicros(BigInt(Math.round(dollars * 1_000_000)));
}

test("required worked example: $1.05M across 5 assets against $1,000,000 headroom (allocation-spec.md §2)", () => {
  const assets: RankableAsset[] = [
    { mint: mint(1), usdValue: usd(400_000) }, // USDC
    { mint: mint(2), usdValue: usd(300_000) }, // SOL (already net of reserve)
    { mint: mint(3), usdValue: usd(200_000) }, // USDT
    { mint: mint(4), usdValue: usd(100_000) }, // TokenX
    { mint: mint(5), usdValue: usd(50_000) }, // TokenY
  ];

  const result = allocate(assets, usd(1_000_000));

  assert.equal(result.length, 5);
  const byRank = [...result].sort((a, b) => a.rank - b.rank);

  assert.deepEqual(
    byRank.map((r) => [r.usdValue, r.allocatedUsd, r.unallocatedUsd]),
    [
      [usd(400_000), usd(400_000), usd(0)],
      [usd(300_000), usd(300_000), usd(0)],
      [usd(200_000), usd(200_000), usd(0)],
      [usd(100_000), usd(100_000), usd(0)],
      [usd(50_000), usd(0), usd(50_000)],
    ],
  );

  const totalAllocated = result.reduce((acc, r) => acc + r.allocatedUsd, 0n);
  assert.equal(totalAllocated, usd(1_000_000));
});

test("boundary asset: headroom lands inside an asset, not on a rank boundary", () => {
  const assets: RankableAsset[] = [
    { mint: mint(1), usdValue: usd(600_000) },
    { mint: mint(2), usdValue: usd(500_000) }, // boundary falls inside this one
  ];
  const result = allocate(assets, usd(900_000));
  const byRank = [...result].sort((a, b) => a.rank - b.rank);

  assert.equal(byRank[0].allocatedUsd, usd(600_000));
  assert.equal(byRank[0].unallocatedUsd, usd(0));
  assert.equal(byRank[1].allocatedUsd, usd(300_000)); // 900k - 600k remaining
  assert.equal(byRank[1].unallocatedUsd, usd(200_000)); // 500k - 300k excess

  const total = result.reduce((acc, r) => acc + r.allocatedUsd, 0n);
  assert.equal(total, usd(900_000));
});

test("lower-value stablecoin is excessed instead of a higher-value long-tail token — no type priority", () => {
  const stable: RankableAsset = { mint: mint(1), usdValue: usd(10_000) };
  const longTail: RankableAsset = { mint: mint(2), usdValue: usd(50_000) };
  const result = allocate([stable, longTail], usd(50_000));
  const byMint = new Map(result.map((r) => [r.mint[31], r]));

  // The higher-value asset (long-tail token) is fully allocated; the
  // lower-value stablecoin is entirely excessed, regardless of type.
  assert.equal(byMint.get(2)!.allocatedUsd, usd(50_000));
  assert.equal(byMint.get(1)!.allocatedUsd, usd(0));
});

test("zero headroom excesses everything", () => {
  const assets: RankableAsset[] = [{ mint: mint(1), usdValue: usd(10) }];
  const result = allocate(assets, usd(0));
  assert.equal(result[0].allocatedUsd, usd(0));
  assert.equal(result[0].unallocatedUsd, usd(10));
});

test("empty input allocates nothing and does not throw", () => {
  const result = allocate([], usd(1_000_000));
  assert.deepEqual(result, []);
});

test("single-asset input", () => {
  const result = allocate([{ mint: mint(1), usdValue: usd(500) }], usd(1_000_000));
  assert.equal(result.length, 1);
  assert.equal(result[0].allocatedUsd, usd(500));
});
