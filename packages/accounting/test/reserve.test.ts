import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSolReserve, assertSolSelectionWithinOffer } from "../src/reserve.ts";

const MIN_SOL_RESERVE_LAMPORTS = 50_000_000n; // 0.05 SOL, docs/specs/reserve-spec.md §3 illustrative default
const LAMPORTS_PER_SOL = 1_000_000_000n;

test("small balance: absolute floor governs, not the 10% rule (reserve-spec.md §1)", () => {
  const eligible = LAMPORTS_PER_SOL / 5n; // 0.2 SOL
  const r = computeSolReserve(eligible, MIN_SOL_RESERVE_LAMPORTS);
  assert.equal(r.governedBy, "ABSOLUTE_RESERVE");
  assert.equal(r.offeredSolLamports, eligible - MIN_SOL_RESERVE_LAMPORTS); // 0.15 SOL
});

test("large balance: 10% rule governs", () => {
  const eligible = 500n * LAMPORTS_PER_SOL;
  const r = computeSolReserve(eligible, MIN_SOL_RESERVE_LAMPORTS);
  assert.equal(r.governedBy, "PCT_RESERVE");
  assert.equal(r.offeredSolLamports, eligible - eligible / 10n); // 450 SOL
});

test("below-reserve balance: SOL entirely excluded, offered clamps to zero", () => {
  const eligible = (3n * LAMPORTS_PER_SOL) / 100n; // 0.03 SOL
  const r = computeSolReserve(eligible, MIN_SOL_RESERVE_LAMPORTS);
  assert.equal(r.offeredSolLamports, 0n);
});

test("offered_sol is always <= eligible_sol (never negative, never a phantom increase)", () => {
  for (const eligible of [0n, 1n, MIN_SOL_RESERVE_LAMPORTS, MIN_SOL_RESERVE_LAMPORTS - 1n, 10_000n * LAMPORTS_PER_SOL]) {
    const r = computeSolReserve(eligible, MIN_SOL_RESERVE_LAMPORTS);
    assert.ok(r.offeredSolLamports <= eligible);
    assert.ok(r.offeredSolLamports >= 0n);
  }
});

test("backend rejects a selection above the offered ceiling, including a crafted payload (threat-model.md T20)", () => {
  const r = computeSolReserve(LAMPORTS_PER_SOL, MIN_SOL_RESERVE_LAMPORTS);
  assert.throws(() => assertSolSelectionWithinOffer(r.offeredSolLamports + 1n, r), RangeError);
  assert.doesNotThrow(() => assertSolSelectionWithinOffer(r.offeredSolLamports, r));
});
