# Accounting Model

Status: Phase 1 draft. Unitized (mutual-fund-style) accounting per spec §5. This
document assumes the single-pool-per-vault model flagged in `architecture.md` §0;
if that assumption is wrong, the worked examples still hold *per vault*, but the
system-wide picture changes.

## 1. Model

- Each vault has `total_units: u128` and `unit_price_scaled: u128` (fixed-point,
  1e9 scale per spec §4.2/§5.1).
- Initial `unit_price` = `1.000000000`.
- **Subscribe (deposit):** `units_issued = floor(deposit_usd_scaled / unit_price_scaled)`.
- **Redeem:** `payout_scaled = floor(units_burned * unit_price_scaled)`.
- Rounding is always toward the pool, never toward the client. Dust accrues to
  remaining unit-holders; it is never created or destroyed, and it never leaves
  the pool through a rounding error.
- **No floating point in the accounting path, anywhere.** All units, prices, and
  USD-scaled quantities are `u128` fixed-point integers. This should be a lint
  rule (Phase 2: forbid `f32`/`f64` in `packages/accounting`, enforce via
  `clippy::float_arithmetic` on the Rust side and an eslint rule or custom AST
  check on the TypeScript side) rather than a convention people remember.

Why unit accounting instead of percentage-of-pool: percentage ownership
recomputed ad hoc silently breaks the moment two clients deposit or redeem at
different times, because "your %" implicitly assumes everyone's capital has been
in the pool for the same duration. Unit accounting makes time-of-entry
economically correct by construction — see the worked example below.

## 2. Worked example (required test case, spec §5.2)

| Event | NAV before | Unit price | Action | Units issued/burned | Total units after | NAV after |
|---|---|---|---|---|---|---|
| A deposits $50,000 | $0 | 1.000000000 | issue to A | +50,000.000000000 | 50,000.000000000 | $50,000 |
| Pool gains 10% | $50,000 | → 1.100000000 | — | — | 50,000.000000000 | $55,000 |
| B deposits $100,000 | $55,000 | 1.100000000 | issue to B | +90,909.090909090 | 140,909.090909090 | $155,000 |
| Pool gains 10% | $155,000 | → 1.210000000 | — | — | 140,909.090909090 | $170,500 |

**Final state:**
- A holds 50,000.000000000 units × 1.210000000 = **$60,500.00**
- B holds 90,909.090909090 units × 1.210000000 = **$110,000.00** (rounding on the
  last digit of B's unit count is the only place fixed-point truncation shows up,
  and it favors the pool by construction)

B, who joined after the first +10% move, correctly receives only the appreciation
that occurred after their deposit (their $100,000 became $110,000, a 10% gain —
not 21%). A percentage-of-pool model that recomputed "B owns 100,000/155,000 =
64.5%" at deposit time and then reapplied that percentage to the post-second-gain
NAV would get this wrong. This worked example must exist as an automated test
(property test target for Phase 3's acceptance gate, spec §17).

## 3. Fee accrual

### 3.1 Management fee (accrues into NAV daily)

Management fees must reduce NAV **before** unit price is computed for the day,
not be deducted from a client's balance separately, so that:

- A client redeeming mid-period receives a price already net of fees owed for
  time elapsed — never a stale, overstated price at the expense of remaining
  unit-holders.
- The fee itself doesn't need its own ledger reconciliation against client
  balances; it falls out of the unit-price math automatically.

Formula (illustrative only — the annual rate below is a placeholder for exposition,
**not a proposed production value**; the actual rate is an open decision, see
`open-decisions.md` OD-3):

```
daily_accrual_usd = NAV_before_fee * (annual_fee_bps / 10_000) / 365
NAV_after_fee      = NAV_before_fee - daily_accrual_usd
unit_price_scaled  = NAV_after_fee / total_units
```

**Illustrative extension of the worked example above**, assuming a hypothetical
1% annualized management fee accrued for one day immediately after B's deposit,
before the second +10% move (numbers below are for illustration of the mechanism
only):

```
NAV before fee accrual:  $155,000.00
Daily accrual:           $155,000.00 * 0.01 / 365 = $4.25 (rounded down at the
                          pool's favor to $4.24 in a real fixed-point impl)
NAV after fee accrual:   $154,995.76
unit_price:              $154,995.76 / 140,909.090909090 = 1.099969...
```

The fee amount itself must be recorded as its own ledger entry
(`fee_accruals` table, see `db-schema.md`) crediting an operator-controlled fee
receivable, *not* simply vanishing from NAV — otherwise `NAV == cash + positions
- liabilities - accrued_fees` (spec §5.4) can't be reconciled.

### 3.2 Performance fee (high-water-mark, per client)

- Each `ClientAccount` stores `hwm_unit_price` — the highest unit price at which
  that client's crystallization has already accounted for a performance fee.
- At each crystallization point (period end), if the current unit price exceeds
  a client's `hwm_unit_price`, a performance fee is charged **only on the client's
  own gain above their own HWM**, realized by burning a corresponding number of
  units from that client (not by moving cash, so it doesn't require a separate
  liquidity event).
- After crystallization, that client's `hwm_unit_price` is updated to the
  (post-fee) current price.

**Documented alternative: equalization / series accounting.** The HWM-per-client
approach is simpler to implement and reason about, but has a known, accepted
inequity at the margins: two clients who deposited at different unit prices and
therefore have different HWMs can end up paying different effective performance
fees for the same absolute pool performance over the same period, because each
is only taxed relative to their own entry point. Series/equalization accounting
(tracking separate "series" of units per entry cohort, each with its own
performance-fee equalization credit/debit at redemption) removes this inequity
but adds meaningfully to implementation and reconciliation complexity. **Only
build performance fees at all if they are in the actual commercial model** (spec
§5.3) — this is an open decision (OD-3) and the HWM-vs-equalization choice should
not be made until that's answered. Default recommendation if performance fees
are in scope: start with per-client HWM; it's the industry-standard simplification
for smaller managed pools and the inequity it produces is bounded and disclosable
in the client agreement, whereas equalization accounting is usually only worth
its complexity at fund sizes well beyond ~100 clients / $100M ceiling implied
here.

## 4. Invariants (assert in code and in property tests)

| Invariant | Statement | Enforcement |
|---|---|---|
| Unit conservation | `sum(client.units) == vault.total_units` at all times, no exceptions | On-chain structurally (see on-chain-invariants.md); re-checked by the reconciler every cycle |
| Controlled unit creation/destruction | Units are created **only** by a confirmed deposit and destroyed **only** by a settled redemption. No other code path — not a fee, not a trade, not an admin action — may change `total_units` | On-chain instruction set has no other mint/burn path; property test fuzzes random interleavings of deposit/redeem/trade/fee-accrual and asserts this |
| NAV composition | `NAV == cash + Σ(position_qty × oracle_price) − liabilities − accrued_fees` | NAV Engine computation, checked against on-chain token balances by the reconciler |
| Trade neutrality on units | A trade changes NAV *composition* (cash ⟷ position) but must never change `total_units` | On-chain: `execute_trade` has no unit-mint/burn instruction path at all |
| Rounding direction | Every rounding operation in the subscribe/redeem path rounds in the pool's favor (down for issuance, down for payout) | Property test: run random sequences of deposits/redemptions and assert `sum(payouts) + remaining_pool_value <= total_ever_deposited + total_gains`, i.e., no value manufactured by rounding |
| Fee non-negativity and boundedness | Daily fee accrual is non-negative and never exceeds a sane per-day cap (guards against a fat-fingered `annual_fee_bps`) | Backend validation on the fee-parameter config path; NAV sanity band on `publish_nav` provides an on-chain backstop against an extreme single-day NAV move regardless of cause |
| HWM monotonicity (if performance fees are built) | A client's `hwm_unit_price` never decreases | Assert in the crystallization instruction/job; property test |

## 5. Multi-asset deposits, allocation, and reserves (summary)

The onboarding design (`architecture.md` §3) lets a client deposit several
distinct mints in one signed session, each credited as a separate position —
no conversion happens at deposit time. This extends, but does not change,
the subscribe formula in §1: total deposited value is priced at a single
oracle timestamp, capped at remaining headroom, and whatever doesn't fit is
held as excess rather than credited. The implementation-level detail —
exactly which assets get credited vs. excessed, the ranking algorithm behind
that, the SOL-reserve carve-out, and where the excess goes — is normatively
specified in `docs/specs/`, not here:

- **`docs/specs/allocation-spec.md`** — the deterministic ranking (strict
  USD-value descending, no asset type prioritized — this supersedes any
  "stables-first" rule from earlier drafts) that decides which assets get
  credited when a deposit's total exceeds headroom, plus the boundary,
  snapshot-integrity, and deselection rules.
- **`docs/specs/comparator-spec.md`** — the exact sort/valuation primitive
  the ranking above uses, specified to the bit level for cross-implementation
  parity.
- **`docs/specs/reserve-spec.md`** — the SOL reserve formula (a ceiling
  ensuring a client is never left unable to pay for their own future
  transactions) and the separate vault-side operational SOL reserve.
- **`docs/specs/excess-return-spec.md`** — what counts as excess, custody
  segregation for it, and how a client gets it back.

## 6. What this document deliberately does not do

It does not propose a management or performance fee rate, a crystallization
cadence, or a NAV-publish cadence — those are commercial and risk decisions, not
engineering ones, and are listed in `open-decisions.md` rather than guessed here.
