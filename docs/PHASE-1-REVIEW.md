# Phase 1 Review Guide

This is not a summary — it's a checklist for the human review Phase 1 is
gated on. For each of the eight Phase 1 documents: what to verify before
trusting it, what I was least confident about while writing it, and any
place I made an assumption you never actually confirmed. Ordered by
consequence-if-wrong, highest first.

`docs/specs/` is frozen input per your last message — not re-reviewed
document-by-document here, but several of the "unconfirmed assumption" items
below name specific places where a `docs/specs/` file depends on an
assumption made in one of these eight documents, so a wrong assumption here
can propagate into frozen specs that then need to be reopened.

## 0. Where I resolved an instruction inconsistency without asking

You asked for this explicitly, so it goes first, not buried at the end.

- **"Stop adding detail" vs. three subsequent requests for more detail.**
  After you said Phase 1 was complete and to stop, three more messages asked
  for progressively deeper implementation specification (the exact valuation
  formula, DB/driver/JSON boundary rules, fixture-derivation methodology). For
  each of the first three, I decided on my own that this was in-scope because
  it landed in the newly-created `docs/specs/` layer rather than the trimmed
  `docs/` layer — I did not pause to confirm that reasoning until the fourth
  round, when I finally asked. You've since resolved this (frozen input, stay
  in Phase 1), but the pattern is what you asked me to name: I made that call
  three times before checking it once.
- **Declining to produce CI configuration.** When asked to update `docs/
  allocation-spec.md`, `architecture.md`, `on-chain-invariants.md`, "and the
  CI configuration," I decided unilaterally not to produce the CI piece (no
  repo exists to configure), explained why in prose, and moved on without
  waiting for you to confirm that was acceptable.
- **Substituting a policy document for a requested audit, three times.**
  "Deliver `docs/specs/monetary-representation.md` listing every audited
  site, its before/after state" was asked three times, each more insistent.
  Each time I wrote a policy/procedure document instead of an audit, on the
  reasoning that fabricating an audit of code that doesn't exist would be
  worse than declining — but I made that substitution myself each time rather
  than asking first, until you settled it directly.
- **Treating my own unaccepted recommendation as load-bearing.** The
  Signer-service independent policy re-check (`architecture.md` §7) is
  something I proposed, not something you asked for. `open-decisions.md`
  OD-30 and `comparator-spec.md` §8 both now reason about it as if it were a
  real architectural element ("if that service is built in Rust...") rather
  than flagging every time that its *existence* is still just my suggestion.
  That's a smaller version of the same pattern: I let a provisional idea
  accumulate downstream dependents before you'd agreed to it.

## 1. `on-chain-invariants.md` — highest consequence if wrong

This document's entire job is telling you what's actually enforced by code
versus what's a claim about intent. If a row here is wrong, someone builds a
security model on a guarantee that doesn't exist.

- **Verify:** the new §3 claim that "the Anchor program does not compute,
  recompute, or validate any ranking or ordering" is stated as settled fact
  but is actually *inferred* from the onboarding spec's "nothing is resolved
  at execution time" language, combined with an assumption I made about
  on-chain instruction granularity (see below). If that assumption is wrong,
  this section's reasoning needs rework, not just a footnote.
- **Least confident about:** whether a single Anchor instruction can
  atomically do "transfer + conditionally-partial-mint (up to headroom) +
  route the remainder to a segregated excess account" for a given mint. I
  described the cap-split as happening "at the point units would be issued,"
  atomically, against live state — that's a specific instruction design that
  was never in the original spec's account/instruction sketch (§4.2/§4.3),
  and I did not verify it's actually buildable under Anchor's constraint
  system versus needing a different shape entirely.
- **Unconfirmed assumption:** that a multi-mint deposit within one signed
  transaction is structured as **multiple sequential instruction
  invocations** (one per mint), each checking the cap incrementally, rather
  than **one instruction handling several transfers internally**. The claim
  that "the program has no comparator, it just processes them in the order
  the transaction presents" only cleanly holds under the first structure. I
  never confirmed which one the design actually calls for — I picked the
  interpretation that made the on-chain-invariants story simplest, not one
  that was specified anywhere.

## 2. `custody-map.md` — very high consequence if wrong

- **Verify independently, don't take my categorization on trust:** the claim
  in §2 that "rows C3, C5, and C12 are the only pool-wide-blast-radius
  points." If a security reviewer finds a missed pool-wide vector, the
  document's central argument (effort should concentrate on those three)
  is wrong, not just incomplete.
- **Least confident about:** whether C4 (Trader key) is genuinely bounded to
  "Bounded" severity once the full deposit-engine surface is accounted for. I
  traced C4's blast radius against `execute_trade` carefully; I did not trace
  it against the newer deposit-engine custody points (e.g., who can trigger
  the excess-return self-service withdrawal recommended in
  `excess-return-spec.md` §4 — that's a new outbound path this table doesn't
  list at all).
- **Unconfirmed assumption:** this document was written before the deposit
  engine (comparator, reserve, excess-return specs) existed and was only
  patched once, for C9. It should be re-read in full against
  `docs/specs/excess-return-spec.md` and `docs/specs/reserve-spec.md` for
  missing rows — I did not do this pass, and I'm flagging that gap rather
  than claiming completeness I haven't checked.

## 3. `architecture.md` — high consequence, and directly affected by your stated blockers

- **Verify:** everything downstream of §0's vault-cardinality assumption
  (OD-1). You've now told me this actually depends on a legal question
  (collective investment scheme classification) you haven't asked counsel
  yet. Worth being explicit about what that means: my "single pool"
  recommendation was made purely on internal-consistency grounds (it's the
  only reading that makes §5.2's worked example make sense) — it cannot and
  did not account for the legal answer, which could independently force a
  different structure (e.g., separate legal vehicles per vault) regardless of
  which reading is more internally consistent. Don't let engineering
  consistency substitute for the legal answer when it arrives.
- **Least confident about:** the RPC trust-boundary framing in §5 item 7
  ("byzantine-unreliable, not byzantine-malicious... defending against a
  malicious RPC is hard"). This is based on general Solana ecosystem
  convention, not a specific analysis of this system's RPC usage pattern for
  a custodial platform. Someone with deeper Solana infrastructure expertise
  should confirm this framing is actually adequate here, not just
  conventional.
- **Unconfirmed assumption:** the Signer independent policy re-check (§7) is
  my proposal, not your requirement — see §0 above. Don't read `OD-30` as a
  real blocker on an accepted design; it's a hypothetical blocker on a
  design element that doesn't exist yet unless you accept the proposal.

## 4. `accounting.md` — high consequence (silent fund-accounting bugs are the named failure mode)

- **Verify:** re-derive the §2 worked-example arithmetic yourself rather than
  trust that I checked it correctly — this exact example is supposed to
  become an automated test, so an error here would be load-bearing.
- **Least confident about:** the illustrative fee-accrual rounding in §3.1
  (the "$4.25 rounds down to $4.24" step). I asserted a plausible-looking
  fixed-point truncation without working through the exact scaled-integer
  arithmetic precisely — it's labeled illustrative, but don't copy the number
  itself into an implementation without re-deriving it.
- **Unconfirmed assumption:** that execution-time on-chain headroom being
  authoritative (`deposit-spec.md` §6, OD-19) is compatible with the
  invariant `NAV == cash + positions − liabilities − accrued_fees` being
  computed off-chain without a new, *expected* source of reconciliation
  divergence. I didn't trace whether the reconciliation tolerance design
  (spec §10, `open-decisions.md` OD-17) already accounts for this or needs a
  new carve-out.

## 5. `db-schema.md` — medium-high consequence, more mechanically checkable

- **Verify against a real Postgres instance, not by reading:** the
  `EXCLUDE (client_id WITH =) WHERE (status = 'PENDING')` constraint syntax
  on `withdrawal_address_changes`. I wrote this from memory of Postgres
  exclusion-constraint syntax; I have not run it.
- **Least confident about:** `NUMERIC(39,0)` sizing and performance at scale.
  The sizing is correct for holding a `u128`-range value; I did not verify
  indexing/sorting performance characteristics for `NUMERIC(39,0)` columns,
  though at ~100 clients' worth of data this is very unlikely to matter.
- **Unconfirmed assumption:** that `filtered_deposit_candidates.reason_code`
  and `deposit_quote_allocations.inclusion_status = 'EXCLUDED_UNPRICEABLE'`
  are actually non-overlapping and jointly exhaustive. These two tables were
  designed in separate rounds; I have not re-read them side by side to
  confirm there's no gap or double-classification case.

## 6. `threat-model.md` — medium consequence (a planning document, one step removed from code)

- **Verify:** T17-T21 (the deposit-boundary threats) are mine, not named in
  spec §15 — confirm they're the right five, not just complete-looking. I
  specifically suspect a gap: there's no entry for "a client structures their
  own wallet contents to manipulate which asset the ranking tiebreak or
  boundary computation excesses" (a self-interested client gaming their own
  allocation, as opposed to an external attacker) — I don't think I covered
  that angle anywhere.
- **Least confident about:** every Single-client/Bounded/Pool-wide severity
  label is my judgment call, not adversarially reviewed by anyone else.
- **Unconfirmed assumption:** that the "detection signal" entries throughout
  are actually buildable against the observability stack in spec §14. I
  wrote them assuming the alerting infrastructure already existed to support
  them; I didn't check each one against §14's actual list for feasibility.

## 7. `open-decisions.md` — lower consequence by design

Nothing here is meant to be acted on without your confirmation, so a wrong
entry is much cheaper than a wrong claim elsewhere in this list.

- **Verify:** OD numbering is still consistent after several rounds of edits
  (I've checked this by grep once; a second human pass is cheap insurance).
- **Least confident about:** every numeric "recommended default" (fee rate,
  NAV sanity band, risk limits, SOL reserve constants) is a generically
  plausible industry number, not derived from anything specific to this
  platform's actual client base or strategy. Treat these as having
  essentially zero grounding — more so than the document's own hedging
  language already implies.

## 8. `compliance-questions.md` — different risk shape, not lower stakes

Engineering review can't validate this one — a missing question isn't caught
by rereading the document, only by counsel's independent judgment.

- **Verify:** nothing here should be treated as legally vetted. I have no
  legal training; this is a checklist assembled from engineering-visible
  facts (cap size, pooling, discretionary trading), not legal analysis.
- **Least confident about:** jurisdiction-specific coverage. The list is
  necessarily generic because client jurisdictions (OD-11) aren't decided
  yet — it may be missing entire categories of jurisdiction-specific
  question that only become visible once that's answered.

---

## Section A — Confirmed by you

Kept deliberately short, per your instruction: default to B, and a
requirement you handed me is not the same thing as a validation. Everything
below is something in a specific message where you decided or confirmed
something, rather than specified a requirement for me to work from. If I
can't point to the message, it isn't here.

1. **The scope-drift assessment was correct.** "Your scope-drift flag is
   correct and well raised" — confirms my read that Phase 1 documents were
   accumulating implementation-level detail inappropriately. This validated a
   *judgment*, not a technical design fact.
2. **The scale-collision and dual-implementation-location flags were valid
   concerns.** "Correct on both layers" — confirms OD-29 (1e6/1e9 scale
   collision) and OD-30 (where a second, Rust implementation would live) were
   real gaps worth specifying against. It does not resolve either — OD-30 is
   still open, and no message has said where or whether a Rust
   implementation actually gets built.
3. **We are staying in Phase 1; Phase 2 has not started.** Explicit decision
   in response to the phase-boundary question.
4. **OD-1 (vault cardinality) is blocked on a legal question you have not
   yet asked counsel** — collective investment scheme classification — not
   on an engineering ambiguity I can resolve by re-reading the spec more
   carefully. This is new, confirmed information that changes how OD-1
   should be treated: no amount of internal-consistency argument in
   `architecture.md` §0 can substitute for that answer.
5. **No human has read the Phase 1 documents end to end yet.** Stated
   directly — relevant to Section H below, since it means zero external
   verification has happened on any of this so far, not just the specific
   gaps this review calls out.
6. **The `docs/` vs. `docs/specs/` split and its purpose** — "Phase 1 docs
   should explain WHY and WHAT; docs/specs/ pins down EXACTLY HOW" — a
   confirmed organizing decision, distinct from confirming that any
   particular piece of content is correctly classified under it (that
   classification is mine, and is Section B).
7. **The A/B distinction and evidentiary standard used in this section** —
   this message: instructions are requirements, not validations, and the
   default is B.

That's the complete list. Everything else this project has produced —
including every number, formula, and design choice you dictated directly —
is Section B below, because a dictated requirement has not been checked
against anything, including by you.

## Section B — Specified, not validated

This is not a re-listing of every sentence in fourteen documents — that
would be the documents themselves. It's the set of assumptions and design
choices substantial enough that another engineer or reviewer would need to
independently check them before relying on them, organized so Section G can
cross-reference each one. Many of these already appear as "least confident
about" or "unconfirmed assumption" items in §1-8 above; they're consolidated
and numbered here because Section G needs stable references.

| # | Item | Nature |
|---|---|---|
| B1 | Single pooled vault, not one vault per client (OD-1) | My interpretation of an internally inconsistent spec, offered as a recommendation — now known to also depend on an unanswered legal question (Section A item 4) |
| B2 | The Anchor program performs no ranking/recomputation of deposit allocation | Inferred from the deposit-authorization design's "nothing resolved at execution time" language, not derived from an actual instruction spec |
| B3 | Multi-mint deposits execute as N sequential per-mint instruction calls within one transaction (not one instruction handling several transfers) | An assumption I made to make B2's reasoning work — never stated by you, never checked against Anchor's actual constraints |
| B4 | Execution-time on-chain headroom, not quote-time, is authoritative for the credited/excess split (OD-19) | My recommendation, argued from a general principle ("the chain is authoritative"), never confirmed by you |
| B5 | `UNMANAGED_EXCESS` needs a segregated per-client token account, not a ledger label (OD-14, custody-map.md C9) | My inference from the custody model; not checked against what's actually buildable under Anchor's account-rent/validation model |
| B6 | The Signer service's independent pre-signing policy re-check exists or will be built | My own proposal (architecture.md §7), never accepted by you, but treated as a real element by OD-30 and `comparator-spec.md` §8 |
| B7 | Distinct types per fixed-point scale (`UsdMicros` vs. a 1e9-scaled type) prevent the 1e9/1e6 scale-collision bug (OD-29) | My recommendation; not validated against how these types would actually thread through two languages and a database |
| B8 | The exact comparator formula, totality rule, and fixture-derivation methodology (`comparator-spec.md`) | Dictated by you directly — a specification, not a validated design; nothing has checked it against, e.g., a real Pyth price payload |
| B9 | The SOL reserve formula and the `min_sol_reserve` = 0.05 SOL derivation (`reserve-spec.md`) | Dictated by you (formula) and derived by me (the specific 0.05 arithmetic) — you explicitly flagged the derived number as non-final |
| B10 | Threat model entries T17-T21 are the complete set of deposit-boundary threats | My own addition to the spec's named threat list; no independent threat-modeling pass has checked for gaps (I already suspect one — see Section H) |
| B11 | Every numeric "recommended default" in `open-decisions.md` (fee rates, NAV band, risk limits, etc.) | Generic, industry-plausible placeholders with no grounding in this platform's actual strategy or client base |
| B12 | The $1,000,000 cap is checked at deposit/credit time only | Carried forward from spec §6.2 without checking whether it needs to be re-evaluated as a client's managed value grows from trading gains — see Section H |

## Section G — Who can verify each item

For each Section B item: which document(s) assert it, and whether any other
document independently derives or checks it, versus merely citing it. The
chain length varies — some items pass through two documents, some through
four — but the pattern is consistent enough to be the main finding of this
section: **almost nothing in this document set has independent
corroboration.** Every item below has exactly one point of origin; every
other document that touches it does so by reference, not by separately
re-deriving or checking it. Read "cited by" as *inherits the same
assumption*, not *agrees after independent examination*.

| # | Asserted in (origin) | Also appears in (by citation, not independent check) | Independently corroborated? |
|---|---|---|---|
| B1 | `architecture.md` §0 | `accounting.md` (status line), `db-schema.md` (schema grain), `on-chain-invariants.md` (implicit) | **No — single point of failure.** Every downstream document assumes §0's conclusion rather than re-deriving it from the spec. |
| B2 | `on-chain-invariants.md` §3 | `architecture.md` §7, `comparator-spec.md` §8, `deposit-spec.md` | **No.** All three downstream mentions cite `on-chain-invariants.md` §3 directly; none independently re-examines whether the program actually has no ranking logic. |
| B3 | `on-chain-invariants.md` §3 (unstated premise) | `comparator-spec.md` §1 ("order they appear in the signed transaction") | **No.** This is the least-corroborated item in the set — it's not even stated as an assumption where it originates, only surfaced as a gap in this review. |
| B4 | `architecture.md` §3.2 (original) → now `deposit-spec.md` §6 | `accounting.md` §5 (excess formula), `excess-return-spec.md` §1, `db-schema.md` (`deposits.quote_id` comment) | **No.** Four documents use this conclusion; none derives it independently — all trace to the same one-paragraph argument. |
| B5 | `custody-map.md` C9 (§3) | `excess-return-spec.md` §3, `open-decisions.md` OD-14 | **No.** `excess-return-spec.md` restates the requirement; it doesn't check it against an actual account design. |
| B6 | `architecture.md` §7 | `open-decisions.md` OD-30, `comparator-spec.md` §8 | **No, and marked explicitly as unaccepted in Section A item 2.** This is the clearest case of a provisional idea being treated as settled by the documents that cite it. |
| B7 | `comparator-spec.md` §6 | `monetary-representation.md` §3, `open-decisions.md` OD-29 | **No.** `monetary-representation.md` §3 was written by me restating `comparator-spec.md`'s own reasoning — it reads as a second source but has the same author and the same absence of independent check. |
| B8 | `comparator-spec.md` §3 (your specification) | `allocation-spec.md` (references, doesn't re-derive), `monetary-representation.md` (references) | **No.** Two documents cite the formula; neither independently tests it against real oracle data, because none exists yet. |
| B9 | `reserve-spec.md` §1/§3 | `allocation-spec.md` §5, `deposit-spec.md` §5 | **No.** Both citing documents use the formula's output; neither re-derives the `min_sol_reserve` arithmetic. |
| B10 | `threat-model.md` T17-T21 | (none) | **No — zero corroboration.** No other document threat-models the deposit boundary independently. |
| B11 | `open-decisions.md` | (none, by design) | **N/A — not meant to be corroborated.** Flagged only so it isn't mistaken for a gap in this table; these are explicitly placeholders. |
| B12 | Spec §6.2 (origin), carried into `on-chain-invariants.md` and `excess-return-spec.md` | Both cite the cap mechanism; neither questions its timing | **No — and this is a Section H item, not just a corroboration gap**, since the question of *whether* deposit-time-only checking is sufficient was never actually raised anywhere, including by the original spec. |

## Section H — What the documents do not cover

Gaps in this project's own Phase 1 output, distinct from the internal
inconsistencies already flagged elsewhere. Per your framing: agreement
between documents is not evidence of correctness if none of them examined
the question, and a requirement I carried forward without independently
checking it against the rest of the design is a gap, not a confirmed fact.

**Requirements carried forward without checking coherence against later
additions:**

- The $1,000,000 cap (spec §1.1/§6.2) is checked only at deposit/credit time
  (B12). Nothing anywhere — not `on-chain-invariants.md`, not
  `open-decisions.md`, not `compliance-questions.md` — asks whether a
  client's managed value growing *past* $1,000,000 through trading gains
  (not a new deposit) should trigger anything. The cap's own stated purpose
  ("deposits above that are held uninvested and flagged, not silently
  managed," spec §1.1) is about deposits, but I never checked whether the
  same governance concern applies to organic growth, and no document raises
  it as a question to even leave open.
- **Nothing anywhere checks whether one person can register as multiple
  `clients` to circumvent the per-client cap.** KYC is referenced throughout
  (`db-schema.md`'s `clients.kyc_status`, `compliance-questions.md` §3) but
  identity-deduplication *across* client registrations — the actual control
  that would make the cap mean anything against a determined client — is not
  mentioned in any of the eight documents or six specs. This is a silent
  gap, not a resolved design point.
- The redemption cycle (`architecture.md` §4, spec §7.1) strikes NAV at a
  scheduled cycle point; the deposit engine (`deposit-spec.md`) credits at
  transaction finality against live on-chain state. I never checked whether
  these two timing models are mutually consistent — e.g., whether a deposit
  confirming between two redemption strikes is guaranteed to be reflected in
  the next NAV publish, or whether there's a window where it's neither.
- The reconciliation design (spec §10, `open-decisions.md` OD-17) predates
  the deposit engine and assumes divergence between ledger and chain state
  is always an error. The deposit engine's execution-time-authoritative
  headroom (B4) creates a *legitimate* source of quote-vs-execution
  divergence. I flagged this once, narrowly, as an "unconfirmed assumption"
  under `accounting.md` in §4 of this review — but no document, including
  `open-decisions.md`, actually poses it as an open question. It should have
  been an OD item and isn't.
- `excess-return-spec.md` §4 recommends self-service on-chain withdrawal for
  `UNMANAGED_EXCESS`. This is an outbound movement of client funds, and
  `compliance-questions.md` §3's KYC/AML questions are framed around deposits
  and standard redemptions — nothing checks whether an excess-return payout
  needs the same AML re-screening a redemption would. Two documents about
  outbound fund movement and compliance were written without being read
  against each other for this case.

**Things I specified without confidence** (cross-reference — already
flagged individually, consolidated here per your instruction rather than
re-derived): the on-chain instruction shape for atomic partial-mint-plus-
excess-routing (§1 of this review); whether C4's blast radius still holds
given the full deposit-engine surface (§2); the fee-accrual rounding
arithmetic (§4); the Postgres `EXCLUDE` constraint syntax (§5); every
severity label in `threat-model.md` (§6); and every numeric default in
`open-decisions.md` (§7). None of these were flagged as confident
conclusions anywhere in the source documents themselves — this list exists
so they're visible in one place instead of scattered across eight files.

**Where three (or more) documents "agree" only because none examined the
question:** every row in Section G marked "No" is, by construction, also a
Section H item — the documents don't disagree, but only because the
question was asked once and answered once, and everywhere else it appears by
citation. The single clearest case is B2/B3 together: `on-chain-invariants.md`,
`architecture.md`, and `comparator-spec.md` all now describe a system where
"the program doesn't rank anything" as if it were settled, and they agree
with each other — but that agreement traces to one inference in one document
resting on one unconfirmed assumption about instruction structure (B3). Three
documents citing the same unchecked premise is not three-way validation of
that premise.

---

Per your instruction: stopping here. I won't treat further specification
requests on the frozen `docs/specs/` content as documentation asks — I'll
name them as Phase 2 requests instead.
