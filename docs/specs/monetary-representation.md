# Monetary Representation Policy (Normative)

Status: **Normative policy spec.** Phase 2 input. This document states where
integer-only monetary representation is mandatory across the system, where
floats are permitted, and what mechanically enforces the boundary. It is
**not** an audit of existing code — as of this document, this repository
contains no application code (`CLAUDE-CODE-SPEC.md` and `KICKOFF-PROMPT.md`
plus `docs/` are the entire contents). A per-site before/after audit is a
Phase 2 deliverable, produced once there are sites to audit; this document is
the policy that audit will be checked against.

## 1. Where integers are mandatory

Every site where a USD-equivalent value participates in **sorting, cap
enforcement, allocation, NAV computation, unit pricing, fee accrual, or
reconciliation**. Concretely, at minimum:

| Site | Governing spec |
|---|---|
| Deposit-allocation comparator and valuation | `docs/specs/comparator-spec.md` §3 (1e6 USD micro-units) |
| NAV computation, unit price | `accounting.md` §1/§4 (1e9 scale) |
| Fee accrual (management, performance/HWM) | `accounting.md` §3 |
| Reconciliation comparisons | `db-schema.md` `reconciliation_runs`/`reconciliation_breaks` |
| $1,000,000 managed-capital cap check | `on-chain-invariants.md` §1; `docs/specs/excess-return-spec.md` §1 |
| SOL reserve computation | `docs/specs/reserve-spec.md` §1 |

No `f32`/`f64` (Rust), no native `number` (TypeScript), and no
arbitrary-precision decimal library with a configurable/implicit rounding
mode, in any of the above. Rounding mode must be explicit and singular per
computation (each governing spec above states its own single rounding
point), never a library default.

## 2. Where floats are permitted

Display formatting, charting, and non-authoritative analytics — and only on
values already computed as integers upstream in an authoritative path,
converted to a display form at the last step. A displayed/converted value is
never converted back into an authoritative computation.

## 3. The scale-collision fact

Two distinct fixed-point scales are mandated across the specs above: **1e9**
for NAV/unit-price-related quantities, **1e6 (USD micro-units)** for the
allocation comparator's valuation. Both are exact integers, so this is not a
precision problem — it is a same-shape-different-meaning problem: a
`u128`/`bigint`/`NUMERIC` value computed at one scale, used where the other is
expected, is silently off by 1000x, and nothing about a bare integer type
catches that.

**Recommendation:** wrap each scale in a distinct type at module boundaries —
e.g. `UsdMicros(u128)` vs. a `NavScaled1e9(u128)` equivalent in Rust, and the
analogous branded-type pattern in TypeScript
(`type UsdMicros = bigint & { __brand: 'UsdMicros' }`) — rather than relying
on naming discipline (`_scaled` suffixes) alone, so a mismatch is a
compile-time error, not a runtime 1000x bug. See `open-decisions.md` OD-29.

## 4. Enforcement mechanisms (requirements for Phase 2 CI, not yet built)

- **Rust:** deny float types in `packages/accounting` and the allocation/NAV
  modules via a `clippy` lint (e.g. `clippy::float_arithmetic`) or a CI grep
  that fails the build on `f32`/`f64` in those paths.
- **TypeScript:** branded `bigint` types for monetary values in those
  packages, so a raw `number` cannot be passed in by accident; a lint rule
  banning bare `number` in monetary-typed function signatures.
- **CI check rejecting** `parseFloat`, `Number(`, `as f64`, and `.toFixed(`
  within the monetary paths listed in §1.
- **Reject `JSON.parse` of a monetary value into a `number`** at every API
  and DB boundary — parse as a string, construct the `bigint`/`u128`
  explicitly. This is the most common way a float re-enters a system that
  has otherwise eliminated them, since JSON's number type makes no
  integer/float distinction.
- **Overflow discipline:** Rust uses `checked_mul`/`checked_add` throughout
  the monetary paths — never `wrapping_*`, never a silent overflow.
  TypeScript uses explicit bounds assertions around `bigint` arithmetic in
  the same paths.
- **The >2^53 end-to-end test (§9a) runs in the required/blocking test suite,
  not an optional or nightly job** — it is the test most likely to catch a
  real regression, and gating on it only when convenient defeats the point.
- **Rust/TS differential fuzz on allocation ordering** is `comparator-spec.md`
  §4's requirement, not a separate mechanism — listed here only as a
  cross-reference so the full CI picture for monetary correctness is visible
  from one place.

## 5. PostgreSQL column types

Monetary/valuation columns: `NUMERIC` (exact) or `NUMERIC(39,0)` for scaled
integers. **Never `DOUBLE PRECISION`, never `REAL`, never `FLOAT8`.**

`u128`'s maximum value needs 39 decimal digits; `BIGINT` (`int8`) is 64-bit
and **cannot** hold a `u128`-range value. If any monetary column is `BIGINT`,
its value range must be proven to fit (e.g., a lamports counter that will
never approach 2^63), or it must be `NUMERIC` instead. `db-schema.md`'s
monetary columns already use `NUMERIC(39,0)` throughout for this reason.

**Verify against the live catalog, not the migration files**, once a database
exists — migrations and reality diverge (a hand-run `ALTER`, a drifted
staging DB, or an ORM sync that silently chose `float8` won't show up in
migration history):

```sql
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE data_type IN ('double precision','real')
   OR column_name ~ '(usd|value|price|nav|amount|pnl|fee|balance|cap|quantity)';
```

This query is a required CI check (run against a live schema, not statically
against migration files) once a database exists: it fails the build on any
float column in the monetary set.

## 6. Driver boundary — the highest-risk item

`node-postgres` parses `NUMERIC` as a string by default (correct) but also
parses `INT8`/`BIGINT` as a string by default — many ORMs and custom type
parsers override this and silently coerce to `number`, which only loses
precision **above 2^53**. This means the defect passes every small-value
test and only breaks on large balances in production — the exact shape of
bug that stays invisible until it's expensive.

Required, once a driver/ORM exists:

- Register explicit type parsers for OIDs 1700 (`numeric`) and 20 (`int8`)
  returning `string` or `bigint`. Never `Number`.
- Assert the registration at startup: read a known large value from the DB
  and verify it survives unchanged. Fail fast on mismatch — a wrong parser
  must not be a silent runtime condition.
- Audit every ORM custom type, every `pg.types.setTypeParser` call, and any
  ORM config that "helpfully" converts numerics — this is an actual Phase 2
  audit task, not one this document can perform without an ORM to inspect.
- Test with a value **above 2^53** (e.g. `9_007_199_254_740_993` micro-units)
  specifically, since a test using a realistic small balance (e.g. $50,000)
  proves nothing about this failure mode.

## 7. JSON / API boundary

Monetary values cross the wire as **strings, not JSON numbers.**
`JSON.parse` maps every JSON number to `f64` — a monetary value serialized
as a JSON number is already corrupted before any application code touches
it, regardless of how careful the rest of the path is.

- **Serialize:** `bigint` → decimal string, no thousands separators, no
  exponent notation.
- **Deserialize:** string → `bigint` via an explicit constructor, rejecting
  anything that is not a canonical integer string (no leading zeros beyond a
  single `"0"`, no `+` sign, no `.`, no `e`/`E`).
- **Reject at the schema layer**, not by coercion: the API contract types
  these fields as `string` with a pattern constraint. A JSON number arriving
  in a monetary field is a `400`, not a silently coerced value.
- No `Number()`, `parseFloat()`, unary `+`, or a `JSON.parse` reviver
  returning `number`, anywhere in the authoritative path (extends §1/§4's
  banned-pattern list to the wire boundary specifically).
- The branded `UsdMicros` type (§3) applies here too, so a raw `number`
  cannot be passed in structurally at a deserialization boundary.
- Client-side (dashboard) code reading these fields may do float arithmetic
  for **display only** (§2) — it must never write a float-derived value back
  into an authoritative field.

## 8. Round-trip tests (requirements)

Verify exact representation survives DB → driver → backend → JSON → backend
→ DB unchanged, byte-for-byte, once the relevant components exist. Required
cases: a value above 2^53; a `u128`-range value; a value whose nearest
`float64` neighbor differs (the last-bit case that a float round-trip would
silently corrupt); two values that must tie and correctly trigger the
mint-byte tiebreak (`comparator-spec.md` §1) *after* a full round trip; zero;
and a maximum-range value. Assert exact equality on the representation, never
a tolerance — **any test using an epsilon in a monetary path is itself a
bug**, since it would pass while masking the exact class of defect this
document exists to prevent.

## 9. Scope

Every table and endpoint touching USD valuation, sorting, allocation, caps,
NAV, unit price, P&L, fees, and reconciliation is in scope for the audit this
document's policy will be checked against — §1's table names the specs
governing each area. Where a coercion path is found, it must be fixed, not
assumed safe because small-value tests pass — small values hide this defect
completely (§6).

## 9a. The >2^53 verification procedure (documented now, run once the data path exists)

`Number.MAX_SAFE_INTEGER` (2^53−1 = 9,007,199,254,740,991) is the boundary
where a coercion-to-`float64` bug stops being invisible. This procedure is
recorded here so it can be run — and re-run whenever the data path changes —
once there is an actual Postgres instance, driver/ORM configuration,
serializer, and API handler to run it against. **It has not been executed.**
No database or application code exists in this repository yet (this
document's own Status line).

**Test value selection matters more than the boundary itself.** A round
number above 2^53 can still be exactly representable in `float64` by
coincidence, so a test using one passes even when coercion is present. Use
values whose nearest `float64` neighbor is provably different:
`9_007_199_254_740_993` (2^53+1), `9_007_199_254_740_995`,
`18_014_398_509_481_985` (2^54+1), and a `u128`-range value well beyond
`float64` integer precision entirely. For each, assert the exact value **and**
assert it is *not* the `float64`-coerced neighbor — an explicit negative
assertion, so a future refactor reintroducing coercion fails loudly instead of
passing on a value that happens to survive.

**Intermediate products are the likeliest miss.** Per `comparator-spec.md`
§3's formula, `quantity_native × price_scaled` crosses 2^53 long before the
final `usd_value` does — a modest position in a 9-decimal mint at a normal
price produces an intermediate in the 1e17–1e20 range while the final value
is a few thousand dollars and looks entirely ordinary. Required fixture
shape: an intermediate product exceeding 2^53 with a final `usd_value` under
2^53; and a pair of assets differing only in the bits an `f64` intermediate
would lose, such that a float implementation ties them incorrectly and the
correct implementation does not (and the symmetric case: correct
implementation ties, float implementation doesn't). **This pair is the
highest-value test in the suite** — it's the exact defect the comparator
effort exists to prevent, and the final value looks normal enough that no
reviewer would flag it by inspection. Also include an intermediate exceeding
`u64` range, to prove `u128` is actually in use in Rust and no narrowing
occurs.

**Verification points, each asserted independently, once these components
exist:**

1. PostgreSQL stores the value exactly — verified by reading back via a raw
   protocol/`psql` query, bypassing the ORM, so an ORM that corrupts
   symmetrically on both write and read can't hide the fault behind a
   self-consistent round trip.
2. The driver/ORM reads without coercion — assert `typeof === 'bigint'` or
   `'string'`, never `'number'`; assert on the parser registration itself
   (§6), not only on a sample value.
3. JSON serialization preserves the exact value as a string.
4. Deserialization reconstructs the identical `bigint`; a JSON number in a
   monetary field is rejected, not coerced (§7).
5. TypeScript computes using the approved `bigint`/fixed-point
   representation.
6. Rust produces a byte-identical result from identical inputs.
7. Allocation ordering and tie detection remain deterministic across both
   implementations (`comparator-spec.md`).

**Mutation check — proves the test can actually fail.** Temporarily
reintroduce a `Number()`-style coercion at each boundary in turn (driver
parser, JSON serialize, JSON deserialize, TS arithmetic) and confirm the
suite fails at each injection point. A precision test that cannot detect a
deliberately injected coercion isn't protecting anything; this check is cheap
and should be run whenever the verification suite itself changes, not only
once.

## 10. What this document does not do

**It does not list actual code sites with before/after states, and does not
perform the audit its own §6/§9 describe, and §9a's >2^53 procedure has not
been executed.** As stated in this document's Status line, no application
code, database, driver configuration, or API implementation exists yet in
this repository — there is nothing to open a live catalog against, no ORM to
inspect, no wire format or running Postgres instance to test round-trips or
the >2^53 procedure against, and no mutation check to run. A request for
"every audited site, before/after" or "the end-to-end test passing against
the real production data path" is a Phase 2 (or Phase 13 security-testing)
deliverable, produced once those components exist; this document is the
policy and the documented procedure — column types, driver requirements,
wire format, test coverage, the exact fixture values and verification points
— that audit and that test run will be checked against. Producing a table
that looks like an audit, or a result that looks like a passed test run,
without an actual codebase and database behind it would be fabricating
verification that didn't happen, which is worse than not producing one.
