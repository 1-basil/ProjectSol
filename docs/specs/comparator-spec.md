# Comparator Specification (Normative)

Status: **Normative implementation spec.** Phase 2 input. This document pins
down EXACTLY HOW the deposit-allocation ranking's comparator and its
underlying USD valuation are computed, byte-for-byte, in every implementation.
The WHY and the surrounding allocation algorithm live in
`docs/specs/allocation-spec.md`; this document is the reusable sorting/valuation
primitive that algorithm calls.

Ordinary string sorting (locale comparison, Base58 comparison, or reliance on
any language's default iteration/collection order) applied anywhere in this
path is a **correctness bug**, not a style preference. A future contributor
"simplifying" the comparator to `localeCompare` or dropping the raw-byte
comparison for Base58 convenience reintroduces exactly the divergence this
document exists to prevent — see §2. "Use integers" is necessary but not
sufficient to guarantee parity between implementations — §3's exact formula,
not just the type, is what parity actually depends on.

## 1. Canonical rule

```
PRIMARY:    usd_value, DESCENDING
TIE-BREAK:  mint public key, raw 32 bytes, unsigned lexicographic ASCENDING
            (first differing byte decides)
```

No asset type, symbol, name, or category participates in the ordering at any
stage. Never fall back to input order, RPC return order, or map/database
iteration order.

## 2. Prohibited as an ordering input, anywhere in the allocation path

- Base58 string ordering (Base58's alphabet omits `0`, `O`, `I`, `l` and is not
  monotonic with respect to raw byte order — two mints can have a Base58
  ordering that disagrees with their byte ordering; this is precisely why raw
  bytes are mandated in §1, not the human-readable address)
- Token symbol or name
- Token type or category (including "is this a stablecoin")
- Account creation order
- RPC return order
- JS object/`Map` iteration order
- Rust `HashMap` iteration order
- Database result order without an explicit `ORDER BY` matching §1 exactly
- Any other implicit ordering a language, library, or runtime happens to
  provide

If code in the allocation path ever relies on one of the above without an
explicit, documented reason unrelated to ranking, that is a defect against
this spec.

## 3. USD valuation — the canonical formula (this is the actual source of parity)

Two implementations can both use integers and still disagree if one divides
early, rounds an intermediate value, or handles the oracle exponent
differently. The formula below, not just "use integers," is what parity
depends on — both languages implement it exactly.

**Representation.** `usd_value` is `u128` (Rust) / `bigint` (TypeScript).
Fixed scale: **1e6, USD micro-units** (`$1,000,000.00 = 1_000_000_000_000`).

*Scale rationale, recorded here so it is not "adjusted" later without
understanding the consequences:* 1e6 gives sub-cent precision, keeps the
$1,000,000 managed-capital cap four orders of magnitude from any integer
bound in play, and matches USDC/USDT's native decimals, so the common case
(a USD-pegged stablecoin) needs no rescaling to reach this representation.

**Canonical valuation formula:**

```
usd_value = floor( quantity_native * price_scaled
                   / 10^(mint_decimals + price_exponent_abs - 6) )
```

- **One division, at the end.** Multiply first, always
  (`quantity_native * price_scaled`), in the full `u128`/`bigint` width —
  never narrow an intermediate, never round one.
- **Floor is applied exactly once**, by that single terminal division. There
  is no other rounding step anywhere in the valuation path.
- **Oracle prices enter as their native integer representation with their
  exponent** (e.g., a Pyth price's integer mantissa and its exponent field
  directly). Do **not** convert a price to a decimal string or a float and
  re-parse it — the float must never exist at any point in this path, not
  even transiently.
- **If the combined divisor exponent is negative** (a very-high-decimals
  price feed, where `mint_decimals + price_exponent_abs - 6 < 0`), multiply by
  `10^|exponent|` instead of dividing by it. Both branches (multiply-branch,
  divide-branch) are implemented identically in both languages and each is
  fixture-tested (§4).
- **Overflow.** Rust: `checked_mul`/`checked_add` throughout — never
  `wrapping_*`, never a silent overflow. TypeScript: explicit bounds
  assertions around the `bigint` arithmetic (JavaScript `bigint` doesn't
  silently wrap the way fixed-width integer overflow does, but an assertion
  that the result stays within the expected `u128` range is still required,
  so a bug that produces an absurd value fails loudly rather than propagating).
- **Both implementations must produce bit-identical `usd_value` integers**
  from identical `(quantity_native, price_scaled, mint_decimals,
  price_exponent_abs)` inputs. Test this directly, as its own test, separate
  from the comparator/ordering tests — a comparator can be implemented
  correctly while consuming two different `usd_value` integers that happen to
  rank the same way on today's fixtures and diverge on tomorrow's data.

## 4. Fixtures for the valuation formula and the comparator (requirements — see §7)

A shared fixture file, consumed by every implementation's test suite, never
duplicated per language. Required cases:

- Mint pairs whose Base58 ordering disagrees with their raw-byte ordering —
  constructed deliberately; the generator for these pairs is committed
  alongside the fixture file, not just its output.
- Multiple assets at exactly equal `usd_value` (pairwise ties).
- A 3-or-more-way tie, specifically to verify transitivity — pairwise
  agreement between every pair in a set does not by itself prove a consistent
  total order across the whole set.
- Boundary cases where the allocation cutoff lands exactly on a tie group.
- Single-asset and empty-input cases.
- **A case where multiply-before-divide and divide-before-multiply give
  different results.** This is the regression test for the formula itself in
  §3, and the one most likely to catch a future "simplification" that
  reorders the arithmetic.
- **`u128` near-overflow**: a large quantity of a high-decimals mint at a high
  price, deliberately close to the representable bound.
- **A negative-exponent price feed**, exercising the multiply branch in §3.
- **Zero quantity, zero price, and dust below one micro-unit** — each must
  floor to `usd_value = 0` and be *excluded* from ranking, never ranked at `0`
  ahead of (or interleaved with) a tie group of genuinely-zero-value assets
  that shouldn't be ranked at all.
- **An asset whose value floors to exactly the remaining headroom** (an exact
  boundary case, distinct from a boundary that falls *inside* an asset — see
  `allocation-spec.md` §3).
- Expected canonical ordering and expected allocated quantities stored as
  **data** in the fixture file, not computed by test code — the fixture is
  the independent authority implementations are checked against, not a
  mirror of one implementation's own output.

**Intermediate-product reordering cases must be derived, not hand-picked.** An
arbitrary realistic position is unlikely to happen to flip a rank under float
error, so a hand-written fixture will typically pass under both a correct and
a broken implementation and prove nothing while looking like it does. These
cases are found by a committed generator, not invented: fix a target final
`usd_value` and realistic `(mint_decimals, price_exponent)` pairs, then search
the quantity/price space for inputs where `quantity_native * price_scaled`
exceeds 2^53, the exact integer result and the `float64` result differ, and
that difference is large enough to reorder two assets whose exact values are
adjacent in the ranking. The fixture file commits the found inputs, both
results, and both rankings as data; the generator is committed alongside it so
a reviewer can verify the case was *found*, not invented, and so new cases can
be produced when decimals or feeds change. At minimum: a case where float
error promotes an asset one position up, one where it demotes an asset one
position down, one where it produces a **spurious tie** (invoking the
mint-byte tiebreak on values that are not actually equal — as wrong as the
tiebreak failing to fire, and harder to notice), and at least one case sitting
exactly at the allocation boundary, where a one-position reorder changes which
asset is truncated and therefore changes allocated *quantities*, not just
order — that is the case with financial consequence, and the other three
alone do not cover it.

**A fixture's own correctness must be provable, permanently, not asserted by
inspection.** A reference implementation using `float64` for the same
formula, run against the same fixtures, must be asserted to produce the
*wrong* ranking/tie result on the derived cases above. If a naive-float
reference implementation happens to pass a fixture, that fixture isn't
discriminating and must be regenerated — this assertion belongs in the
permanent suite (it's the fixture's own proof it tests anything), not a
one-off manual check performed once and forgotten.

**Assert at each stage of the pipeline, not only the final ranking**
(`quantity → price → intermediate product → fixed-point normalization →
usd_value → sort → allocated quantities`), so a future failure points at
*where* precision was lost rather than turning into a debugging exercise from
a single failed assertion on the final output.

**Fixture inputs, not decimal strings.** A case intended to show that, e.g.,
"400000.00000000006" and "400000.0" tie must be expressed as the *inputs*
that would produce those values under §3's formula (`quantity_native`,
`price_scaled`, exponents) — never as literal decimal strings the test parses.
A fixture written as decimal strings tests the parser, not the arithmetic;
the point of this fixture case is that the canonical formula makes both
inputs yield the identical integer and therefore correctly tie.

## 5. Requirement — comparator totality

The comparator must be a strict weak ordering over the input set: irreflexive,
antisymmetric, transitive, and — because every mint in a given allocation
input is unique by construction — **total** over that input. No two distinct
entries may ever compare `Equal`.

**If the comparator ever returns `Equal`, that is a bug** — specifically, a
duplicate mint in the input — and it must fail loudly (panic / throw / return
an error the caller cannot silently ignore), never fall through to whatever
order the underlying sort implementation happens to produce for equal
elements.

Both implementations use a **stable** sort (Rust: `sort_by`, never
`sort_unstable_by`; TypeScript: `Array.prototype.sort`, specified as stable in
modern engines, though that specification detail is not what this document
relies on for correctness). If the comparator is genuinely total, stability
is belt-and-braces and changes nothing — but it costs nothing either, and the
totality assertion above, not the sort's stability guarantee, is what
actually prevents divergence.

## 6. Monetary-representation boundary (integers vs. floats, system-wide)

This section states where §3's integer discipline is mandatory and where it
isn't, since the allocation path is not the only place USD values flow
through this system.

- **Mandatory (integers only, this formula or an equally exact one):** every
  site where a USD-equivalent value participates in sorting, cap enforcement,
  allocation, NAV computation, unit pricing, fee accrual, or reconciliation.
  This includes, at minimum, the allocation comparator (this document), NAV
  Engine computation (`accounting.md` §1/§4), fee accrual (`accounting.md`
  §3), and the reconciler's comparisons (`db-schema.md`
  `reconciliation_runs`/`reconciliation_breaks`).
- **Permitted (floats allowed):** display formatting, charting, and
  non-authoritative analytics — and only on values already computed as
  integers upstream, converted to a display form at the last step, never
  converted back into the authoritative path.
- **Recommended enforcement mechanisms** (for whoever implements this — see
  §7, none of this is built yet):
  - Rust: deny float types in `packages/accounting` and the allocation/NAV
    modules via a `clippy` lint or a CI grep that fails the build.
  - TypeScript: a branded `bigint` type for monetary values in those
    packages (e.g. `type UsdMicros = bigint & { __brand: 'UsdMicros' }`) so a
    raw `number` cannot be passed in by accident.
  - A CI check rejecting `parseFloat`, `Number(`, `as f64`, and `.toFixed(`
    within the monetary paths.
  - Reject `JSON.parse` of a monetary value into a `number` at every API and
    DB boundary — parse as a string, construct the `bigint`/`u128` explicitly.
    This is the most common way a float re-enters a system that has
    otherwise eliminated them, since JSON's number type has no integer/float
    distinction of its own.

**Scale-collision note.** `accounting.md`/`db-schema.md` already use a
**1e9** fixed-point scale for `unit_price_scaled` and NAV-related quantities,
distinct from this document's **1e6** USD-micro-unit scale for the allocation
path. Both are exact integers, so this is not a precision problem — it's a
same-shape-different-meaning problem: a `u128`/`bigint`/`NUMERIC` value
computed at one scale, passed to code expecting the other, is silently off by
1000x. **Recommendation:** wrap each scale in a distinct type
(`UsdMicros(u128)` vs. a `NavScaled1e9` equivalent) at module boundaries
rather than relying on naming discipline alone, so a mismatch is a
compile-time error, not a runtime 1000x bug. See `open-decisions.md` OD-29.

## 7. What this document does not do

Per this project's Phase 1 gate (spec §17: Phase 1's deliverable is design
docs, not application code) and the explicit instruction to keep code and CI
configuration out of the documentation phase, **this document specifies
requirements; it does not itself contain or constitute:**

- The actual Rust and/or TypeScript comparator or valuation implementations
- The actual shared fixture file or its generator script
- Actual unit tests, integration tests, or the differential-fuzz harness
- Actual CI pipeline configuration
- An audit of existing code sites — **there is no codebase yet** (this repo
  has no `package.json`, no Anchor project, no source files at all as of this
  document). `docs/specs/monetary-representation.md` records the *policy* in
  §6 above for when that audit becomes possible; it cannot honestly claim to
  have performed one yet.

Everything above is specified precisely enough to implement directly against
once `docs/specs/comparator-spec.md` §8 below (where a second, non-TypeScript
implementation would actually live) is resolved and Phase 2/13 begins.

## 8. Where this comparator actually runs — an open question this document surfaces rather than assumes

The requirement for "byte-identical implementations in Rust and TypeScript"
presupposes a second, Rust implementation. The current architecture doesn't
unambiguously supply one:

- The Deposit Quote Engine (which performs this ranking) is TypeScript/Node
  per spec §16 — the one implementation clearly called for today.
- Per `on-chain-invariants.md` §3, the Anchor program does not recompute or
  re-rank anything — the client signs already-decided exact quantities, and
  the program only enforces the cap incrementally against them in the order
  they appear in the signed transaction. **There is currently no on-chain
  comparator for a Rust port to achieve parity with.**
- The only place a second implementation would concretely belong, given
  what's designed so far, is the Signer service's independent pre-signing
  policy re-check (`architecture.md` §7) — *if* that service both (a) is
  built to re-derive the expected allocation, not just trade policy, and (b)
  is written in Rust. Neither is decided.

Introducing a second, off-chain Rust component is also a stack deviation from
spec §16 ("TypeScript/Node backend"), which requires the written
justification that section calls for. **This is `open-decisions.md` OD-30,
unresolved.** Until it resolves, this document's requirements are written to
be implementation-agnostic — "every implementation," "both implementations"
— rather than assuming Rust and TypeScript specifically; they apply from the
point a second implementation is actually introduced, in whatever language
and component that turns out to be.
