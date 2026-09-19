# Deposit Allocation Specification (Normative)

Status: **Normative implementation spec.** Phase 2 input. Pins down EXACTLY
HOW a multi-asset deposit's suggested allocation is ranked and cut off at
headroom. The WHY (unit accounting, subscribe/redeem formulas) lives in
`accounting.md` §1-4; the underlying sort/valuation primitive this algorithm
calls lives in `docs/specs/comparator-spec.md`; what happens to whatever
doesn't get allocated lives in `docs/specs/excess-return-spec.md`; the SOL
reserve computation referenced in §5 below lives in
`docs/specs/reserve-spec.md`.

**Supersedes any "stables-first" allocation rule appearing in earlier drafts
of any Phase 1 document.** No asset type is prioritized — not stablecoins,
not SOL, not anything. Any surviving reference to "stables-first" anywhere in
these docs is stale.

## 1. The ranking algorithm

Given the set of eligible assets for a deposit quote (after server-side
filtering per `docs/specs/deposit-spec.md` §4), rank them once, using the
comparator in `docs/specs/comparator-spec.md` §1 (usd_value descending,
mint-byte tiebreak), then allocate down the ranked list, in order, until
headroom is exhausted:

```
for asset in ranked_assets:               # comparator-spec.md §1 order
    if remaining_headroom <= 0: break
    allocate = min(asset.usd_value, remaining_headroom)
    remaining_headroom -= allocate
    # allocate < asset.usd_value only for the boundary asset — see §3
```

A higher-USD-value asset always precedes a lower-value one regardless of
type — a large long-tail-token balance outranks a small stablecoin balance if
its `usd_value` is higher.

## 2. Worked example (required test case)

Eligible assets USDC $400K, SOL $300K (already net of reserve — see §5),
USDT $200K, TokenX $100K, TokenY $50K, total $1.05M, against a $1,000,000
headroom:

| Rank | Asset | usd_value | Allocated | Unallocated (excess) |
|---|---|---|---|---|
| 1 | USDC | $400,000 | $400,000 | $0 |
| 2 | SOL | $300,000 | $300,000 | $0 |
| 3 | USDT | $200,000 | $200,000 | $0 |
| 4 | TokenX | $100,000 | $100,000 | $0 |
| 5 | TokenY | $50,000 | $0 | $50,000 |

TokenY, the lowest-ranked asset, absorbs the entire shortfall — not because it
is "least important" by type, but purely because it sorts last under §1's
rule. A stablecoin ranked below TokenY by `usd_value` would be excessed
instead; the algorithm has no opinion on asset type. See
`docs/specs/excess-return-spec.md` for what happens to the $50,000.

## 3. Boundary asset

When the headroom boundary falls **inside** an asset (unlike the clean
example above, where it happens to land exactly on a rank boundary): allocate
only the required quantity. Convert the USD boundary to a native quantity at
the snapshot price, then round **down** to the mint's decimals — the rounding
remainder joins the excess (`docs/specs/excess-return-spec.md`), never rounds
up into the pool. After computing the full allocation, assert
`sum(allocated_usd) <= headroom`; if this assertion fails for any reason,
fail closed and abort the quote rather than submit an allocation that
violates it.

## 4. Snapshot integrity

One oracle read, one timestamp, for the entire ranking. Re-reading prices
mid-sort can reorder the list and make the result irreproducible — the
ranking is only meaningful, and only auditable, if every asset was priced at
the same instant. If any eligible asset lacks an acceptable price at that
snapshot, it is `UNPRICEABLE`: excluded from the ranking entirely, never
allocated, with the exclusion recorded (a different
`filtered_deposit_candidates` reason path than the R2 safety filters in
`docs/specs/deposit-spec.md` §4, since this is a pricing-time condition, not
a static property of the mint). Never fall back to a stale or lower-quality
price to force an asset into the ranking — a bad price doesn't just misvalue
the asset, it can change its *rank*, which changes whether it makes the cut
at all. If the snapshot is older than `quote_staleness_seconds` at signature
time, invalidate and recompute rather than submit against it
(`docs/specs/deposit-spec.md` §7 / `open-decisions.md` OD-22).

## 5. Interaction with the SOL reserve — order matters

The reserve is computed *before* ranking, not after (full formula in
`docs/specs/reserve-spec.md` §1):

```
1. offered_sol = max(eligible_sol - max(0.10 * eligible_sol, min_sol_reserve), 0)
2. SOL enters the ranking at the usd_value of offered_sol ONLY
```

Ranking SOL on its full balance and trimming the reserve out afterward would
let the reserve itself displace a genuinely higher-value asset from the
allocation — e.g., a large SOL balance could out-rank TokenX in §2's example,
then lose enough to the reserve that TokenX should have made the cut instead.
Reserve first, then rank, avoids that distortion entirely.

## 6. Client deselection triggers a full re-run, not a patch

If the client deselects an asset from the suggestion, the allocation is
recomputed from scratch (§1) over the remaining eligible set — subsequent
assets move up and may now fall inside the boundary that a full re-rank
exposes. Freed headroom is never left unfilled, and a deselected asset is
never silently re-added in a later re-run.

## 7. Audit record

For full reproducibility — an auditor should never need to re-query an
oracle or an RPC to verify a past allocation — every asset considered in a
quote, whether allocated, partially allocated, or excluded, is persisted
with: valuation timestamp, price source, price, oracle confidence, asset
quantity, `usd_value`, rank (null if excluded pre-ranking), allocated
quantity, allocated USD, unallocated quantity, unallocated USD, whether a
mint-byte tiebreak was applied, and an inclusion/exclusion reason code. See
`db-schema.md`'s `deposit_quote_allocations` table. Replaying this record
must reproduce the original allocation byte-for-byte.
