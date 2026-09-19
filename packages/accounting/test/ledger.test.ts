import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UnitLedger,
  UNIT_PRICE_SCALE as SCALE,
  INITIAL_UNIT_PRICE,
  unitsIssuedOnSubscribe,
  payoutOnRedeem,
  recomputeUnitPrice,
} from "../src/ledger.ts";
import { navScaled1e9 } from "../src/usd-micros.ts";

function usd(whole: bigint) {
  return navScaled1e9(whole * SCALE);
}

test("required worked example: A/B deposit sequence (accounting.md §2, spec §5.2)", () => {
  const ledger = new UnitLedger();

  // A deposits $50,000 at the initial 1.000000000 price.
  const aIssued = ledger.subscribe("A", usd(50_000n), INITIAL_UNIT_PRICE);
  assert.equal(aIssued, 50_000_000_000_000n); // 50,000.000000000 units
  assert.equal(ledger.totalUnitsScaled, 50_000_000_000_000n);

  // Pool gains 10%: NAV moves from $50,000 to $55,000 with no subscribe/redeem.
  const priceAfterFirstGain = recomputeUnitPrice(usd(55_000n), ledger.totalUnitsScaled);
  assert.equal(priceAfterFirstGain, 1_100_000_000n); // 1.100000000

  // B deposits $100,000 at the new 1.1 price.
  const bIssued = ledger.subscribe("B", usd(100_000n), priceAfterFirstGain);
  assert.equal(bIssued, 90_909_090_909_090n); // 90,909.090909090 units, per the table
  assert.equal(ledger.totalUnitsScaled, 140_909_090_909_090n); // 140,909.090909090

  // Sanity: NAV is now $55,000 + $100,000 = $155,000.
  const navAfterBDeposit = usd(155_000n);
  assert.equal(navAfterBDeposit, 155_000_000_000_000n);

  // Pool gains 10% again: NAV moves from $155,000 to $170,500.
  const priceAfterSecondGain = recomputeUnitPrice(usd(170_500n), ledger.totalUnitsScaled);
  assert.equal(priceAfterSecondGain, 1_210_000_000n); // 1.210000000, per the table

  // Final per-client value, computed via the same redeem-payout formula the
  // ledger uses (a hypothetical full redemption at this price).
  const aFinal = payoutOnRedeem(ledger.clientUnitsScaled("A"), priceAfterSecondGain);
  const bFinal = payoutOnRedeem(ledger.clientUnitsScaled("B"), priceAfterSecondGain);

  assert.equal(aFinal, 60_500_000_000_000n); // exactly $60,500.00, matches the table
  // The table displays B's final value as "$110,000.00", but the exact
  // fixed-point result is $109,999.999999998 — the table's own prose notes
  // "rounding on the last digit of B's unit count is the only place
  // fixed-point truncation shows up, and it favors the pool by construction".
  // Assert the precise value rather than the display-rounded one; see
  // PHASE-1-REVIEW.md §4's instruction to re-derive this arithmetic rather
  // than trust the document.
  assert.equal(bFinal, 109_999_999_999_998n);

  // B's gain is ~10% on their $100,000 (correct — they joined after the
  // first gain), never 21% (what a percentage-of-pool model would give them).
  assert.ok(bFinal > usd(109_999n) && bFinal < usd(110_001n));

  // Dust: the sum of both payouts is at most the NAV it was struck against,
  // and the shortfall (if any) accrues to the pool, never manufactured.
  const totalPayout = aFinal + bFinal;
  const finalNav = usd(170_500n);
  assert.ok(totalPayout <= finalNav);
  assert.equal(finalNav - totalPayout, 2n); // 2 units of 1e-9 USD kept by the pool
});

test("unitsIssuedOnSubscribe rejects a non-positive unit price", () => {
  assert.throws(() => unitsIssuedOnSubscribe(usd(100n), navScaled1e9(0n)), RangeError);
});

test("recomputeUnitPrice rejects zero/negative total units", () => {
  assert.throws(() => recomputeUnitPrice(usd(100n), navScaled1e9(0n)), RangeError);
});

test("redeem rejects burning more units than a client holds", () => {
  const ledger = new UnitLedger();
  ledger.subscribe("A", usd(1_000n), INITIAL_UNIT_PRICE);
  assert.throws(
    () => ledger.redeem("A", ledger.clientUnitsScaled("A") + 1n, INITIAL_UNIT_PRICE),
    RangeError,
  );
});

test("unit conservation holds after a redeem, and payout matches payoutOnRedeem", () => {
  const ledger = new UnitLedger();
  ledger.subscribe("A", usd(1_000n), INITIAL_UNIT_PRICE);
  const held = ledger.clientUnitsScaled("A");
  const half = navScaled1e9(held / 2n);
  const payout = ledger.redeem("A", half, INITIAL_UNIT_PRICE);
  assert.equal(payout, payoutOnRedeem(half, INITIAL_UNIT_PRICE));
  assert.equal(ledger.totalUnitsScaled, held - half);
  assert.equal(ledger.clientUnitsScaled("A"), held - half);
});

test("property: sum(client.units) == total_units under random interleaved deposit/redeem", () => {
  const ledger = new UnitLedger();
  const clients = ["A", "B", "C", "D", "E"];
  let priceScaled = INITIAL_UNIT_PRICE;

  // Deterministic PRNG so failures are reproducible without a seed file.
  let seed = 42;
  function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  for (let i = 0; i < 500; i++) {
    const client = clients[Math.floor(rand() * clients.length)];
    const action = rand();

    // Occasionally move the price (simulating NAV drift) without touching units.
    if (action < 0.1) {
      const bump = 900 + Math.floor(rand() * 200); // 0.90x - 1.10x, in integer permille
      priceScaled = navScaled1e9((priceScaled * BigInt(bump)) / 1000n || 1n);
      continue;
    }

    if (action < 0.6) {
      const amount = usd(BigInt(1 + Math.floor(rand() * 10_000)));
      ledger.subscribe(client, amount, priceScaled);
    } else {
      const held = ledger.clientUnitsScaled(client);
      if (held === 0n) continue;
      const burn = navScaled1e9((held * BigInt(1 + Math.floor(rand() * 100))) / 100n);
      if (burn === 0n || burn > held) continue;
      ledger.redeem(client, burn, priceScaled);
    }

    // Conservation is asserted internally by every mutation already; this
    // recomputes it independently from the outside as a second check.
    let sum = 0n;
    for (const c of clients) sum += ledger.clientUnitsScaled(c);
    assert.equal(sum, ledger.totalUnitsScaled);
  }
});

test("performance-fee unit burn keeps conservation and moves HWM forward only", () => {
  const ledger = new UnitLedger();
  ledger.subscribe("A", usd(10_000n), INITIAL_UNIT_PRICE);
  const held = ledger.clientUnitsScaled("A");
  const burn = navScaled1e9(held / 100n); // burn 1% of A's units as a fee
  const newHwm = navScaled1e9(SCALE + SCALE / 10n); // 1.1

  ledger.burnUnitsForPerformanceFee("A", burn, newHwm);

  assert.equal(ledger.clientUnitsScaled("A"), held - burn);
  assert.equal(ledger.totalUnitsScaled, held - burn);
  assert.equal(ledger.clientHwmUnitPriceScaled("A"), newHwm);

  // A subsequent lower HWM must be rejected (monotonicity, accounting.md §4).
  assert.throws(
    () => ledger.burnUnitsForPerformanceFee("A", 0n, INITIAL_UNIT_PRICE),
    RangeError,
  );
});
