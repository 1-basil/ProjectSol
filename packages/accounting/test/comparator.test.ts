import { test } from "node:test";
import assert from "node:assert/strict";
import { compareMintBytes, compareAssets, rankAssets, type RankableAsset } from "../src/comparator.ts";
import { usdMicros } from "../src/usd-micros.ts";

function mint(...bytes: number[]): Uint8Array {
  const arr = new Uint8Array(32);
  arr.set(bytes);
  return arr;
}

test("compareMintBytes: byte order, not lexical/base58", () => {
  const a = mint(0x01);
  const b = mint(0x02);
  assert.equal(compareMintBytes(a, b), -1);
  assert.equal(compareMintBytes(b, a), 1);
  assert.equal(compareMintBytes(a, a), 0);
});

test("primary sort: usd_value descending", () => {
  const assets: RankableAsset[] = [
    { mint: mint(1), usdValue: usdMicros(100n) },
    { mint: mint(2), usdValue: usdMicros(300n) },
    { mint: mint(3), usdValue: usdMicros(200n) },
  ];
  const ranked = rankAssets(assets);
  assert.deepEqual(ranked.map((a) => a.usdValue), [300n, 200n, 100n]);
});

test("tiebreak: equal usd_value orders by mint bytes ascending", () => {
  const assets: RankableAsset[] = [
    { mint: mint(9), usdValue: usdMicros(100n) },
    { mint: mint(2), usdValue: usdMicros(100n) },
    { mint: mint(5), usdValue: usdMicros(100n) },
  ];
  const ranked = rankAssets(assets);
  assert.deepEqual(
    ranked.map((a) => a.mint[0]),
    [2, 5, 9],
  );
});

test("3-way tie is transitive, not just pairwise-consistent", () => {
  const assets: RankableAsset[] = [
    { mint: mint(30), usdValue: usdMicros(50n) },
    { mint: mint(10), usdValue: usdMicros(50n) },
    { mint: mint(20), usdValue: usdMicros(50n) },
  ];
  const ranked = rankAssets(assets);
  assert.deepEqual(
    ranked.map((a) => a.mint[0]),
    [10, 20, 30],
  );
});

test("duplicate mint is a bug and fails loudly rather than falling through", () => {
  const dup = mint(7);
  const assets: RankableAsset[] = [
    { mint: dup, usdValue: usdMicros(100n) },
    { mint: dup, usdValue: usdMicros(100n) },
  ];
  assert.throws(() => rankAssets(assets), /duplicate mint/);
});

test("comparator never falls back to input order for non-tied, non-duplicate entries", () => {
  const assets: RankableAsset[] = [
    { mint: mint(255), usdValue: usdMicros(1n) },
    { mint: mint(0), usdValue: usdMicros(2n) },
  ];
  // Input order is [low-value-high-mint, high-value-low-mint]; correct output
  // must be value-first regardless of input order.
  const ranked = rankAssets(assets);
  assert.equal(ranked[0].usdValue, 2n);
});
