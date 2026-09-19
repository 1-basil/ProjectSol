# Open Decisions

Status: Phase 1 draft. Per spec §19, every item below is a decision Claude Code
must **ask about, not guess**. Nothing here should be read as a chosen value —
each entry has a recommended default and the reasoning behind it, but the
default does not take effect until you confirm it. Where a decision requires a
number that will become production policy (fee rates, caps, cadences), treat
the "recommended default" as a strawman for discussion, not an answer.

Items OD-1 through OD-12 are the exact list from spec §19. Items OD-13 onward
are additional decisions this Phase 1 pass surfaced while writing the other
seven documents.

---

### OD-1. Vault cardinality — one pool, or one vault per client?

**Why this blocks Phase 2:** `architecture.md` §0 flags a direct contradiction
between §1.1/§5 (one pooled vault, unit accounting) and §12 ("~100 vaults").
The on-chain account layout, the DB schema's grain, and whether unit accounting
is even the right model all depend on this.

**Recommended default:** A single pooled vault (`vault_id = 'main'`) for launch,
with the schema and program account design left parameterized by `vault_id` so
a second strategy vault is a config addition later, not a rearchitecture.

**Reasoning:** This is the only interpretation consistent with §5.2's worked
example (A and B sharing one unit price only makes sense in a shared pool) and
with the stated product (§1.1: "executes signals against the pooled managed
capital"). A per-client-vault model doesn't need unit accounting at all, which
would make §5 pointless — so if §12's "100 vaults" is literal, that's the
section to rewrite, not §5.

---

### OD-2. Fee model and rates

**Recommended default:** Flat annualized management fee (e.g. in the 1-2%/year
range, accrued daily into NAV per `accounting.md` §3.1), **no** performance fee
at launch. Add performance fees later, behind the HWM mechanism already
designed in `accounting.md` §3.2, once the commercial model calls for it.

**Reasoning:** Spec §5.3 explicitly says "only build performance fees if
they're actually in the commercial model — do not build speculative fee
machinery." Management-fee-only is the simpler, safer default and defers real
complexity (HWM tracking, crystallization cadence, equalization debate) until
it's commercially justified.

**Needs from you:** Actual fee rate(s), whether performance fees are in scope
at all, and if so, crystallization cadence (monthly/quarterly/annual).

---

### OD-3. Redemption cycle cadence and notice period

**Recommended default:** Daily strike, T+1 settlement, no additional notice
period beyond the strike/settlement lag itself (i.e., a request made any time
before the daily cutoff strikes at that day's NAV point and settles the next
day).

**Reasoning:** Daily is the tightest cadence that still gives the liquidation
pipeline (spec §7.1's "liquidation if cash insufficient" step) a full trading
day to unwind positions before settlement, without promising instant liquidity
the pooled model can't honestly provide (spec §7.1's explicit warning against
this). A longer notice period (e.g., 7-30 days, common in real managed
vehicles) reduces liquidity risk further but is a client-experience and
competitiveness tradeoff you're better positioned to make than an engineering
default.

**Needs from you:** Confirm cadence, and whether any notice period beyond the
cycle itself is required.

---

### OD-4. Gating policy for redemptions exceeding available liquidity

**Recommended default:** Pro-rata gating — if a strike's total redemption
requests exceed a configurable percentage of the vault's liquid (cash + readily
liquidatable) assets, every request in that strike is filled at the same
pro-rata percentage, with the unfilled remainder automatically rolled to the
next cycle rather than requiring re-request.

**Reasoning:** Spec §7.2 names pro-rata gating as the standard approach and
requires it be in the client agreement *before* first use — this is as much a
legal-drafting decision as an engineering one.

**Needs from you:** Confirm pro-rata is acceptable, and the gating threshold
(e.g., gate if requested redemptions exceed 20% of liquid NAV in one cycle).

---

### OD-5. DEX/aggregator programs to allowlist

**Recommended default:** Start with exactly one well-audited router (e.g.
Jupiter's aggregator program) rather than multiple, to minimize the allowlist
review surface named in `threat-model.md` T7. Expand only after each candidate
gets its own allowlist-review checklist pass (audit history, upgrade-authority
structure, historical incident record).

**Needs from you:** Which router(s), and who owns the allowlist-review
checklist sign-off.

---

### OD-6. Initial mint allowlist

**Recommended default:** Start narrow — SOL, USDC, and a small number of
large-cap, deeply liquid SPL tokens the experts actually intend to trade.
Explicitly exclude any Token-2022 mint with a transfer hook or freeze authority
the platform doesn't control until `threat-model.md` T6's review checklist
exists and has been run against it.

**Needs from you:** The actual initial list, and expected trading universe from
the experts (this can't be guessed — it's a product/strategy decision).

---

### OD-7. Specific risk limit values

Per spec §8.2: max position size (% NAV), max trade notional, max daily traded
notional, max concentration per mint, max slippage, max price impact, min
liquidity depth for a target mint. **No recommended defaults are given here
deliberately** — these numbers directly determine both how much daily damage a
compromised Trader key or expert account can do (`threat-model.md` T4) and how
the strategy can actually perform, and picking them requires risk appetite and
strategy knowledge this document doesn't have. Implement behind a config
interface (spec §19's own instruction) with conservative placeholder values
that are visibly flagged as non-production in code and config, never silently
promoted.

**Needs from you:** Every value in the list above.

---

### OD-8. NAV sanity band width (`nav_sanity_band_bps`)

**Recommended default:** A band wide enough to accommodate a genuinely volatile
trading day (e.g., 500-1000 bps) but tight enough that a single insider publish
can't meaningfully move client balances without triggering Treasury co-sign —
this needs to be set with the *actual* traded asset volatility in mind, so
treat the number itself as a placeholder.

**Needs from you:** Confirm the tradeoff direction (tighter band = more
frequent Treasury co-sign friction; wider band = larger single-publish
manipulation window per `threat-model.md` T9) and a number informed by expected
strategy volatility.

---

### OD-9. Dead-man's switch: duration, and whether it ships at all

**Recommended default:** Include it (spec §4.6 calls it "strongly recommended"
and it's the single control that makes the custodial model defensible if the
operator disappears — see `on-chain-invariants.md` §1). Suggested duration: 30
days, matching the spec's own suggestion, with no trade or NAV publish in that
window as the trigger condition.

**Needs from you:** Confirm inclusion (if declined, spec §4.6 requires
recording the rationale, not just skipping it silently) and the duration.

---

### OD-10. KYC/AML provider

**Recommended default:** No default given. This is gated on jurisdiction (OD-11)
and counsel's requirements in `compliance-questions.md` — do not select a
vendor before those questions are answered, since jurisdiction determines which
providers/tiers are even compliant options.

**Needs from you:** Deferred to Phase 1's compliance track; not an engineering
choice.

---

### OD-11. Client jurisdictions

**Recommended default:** None given — this is the single input `compliance-
questions.md` most depends on, and answering it is the first legal task, not an
engineering one.

**Needs from you:** The intended jurisdiction(s) of the ~100 clients, even as a
first approximation, so counsel has a concrete question to answer rather than
an abstract one.

---

### OD-12. Signing/KMS provider, and multisig quorum and holders

**Recommended default (KMS):** A cloud KMS with a Solana-compatible signer
(e.g. Turnkey, Fireblocks, or a cloud HSM with a custom signing service) over a
self-hosted raw-key setup, purely on operational-security grounds — spec §3.3
requires "the backend should call a signer API, not hold bytes," which most
naturally maps to one of these.

**Recommended default (Treasury quorum):** 3-of-5, geographically and
organizationally separated holders, no two holders reporting to the same
person, hardware keys. This is a common baseline for this asset scale, not a
value this document can respons­ibly finalize.

**Needs from you:** Actual KMS/MPC vendor selection (has commercial and vendor-
risk implications beyond engineering), and the actual quorum size and identity
of holders (an organizational decision, not a technical one).

---

## Additional decisions surfaced while writing the other Phase 1 docs

### OD-13. Risk-reservation mechanism: Postgres `SELECT … FOR UPDATE` vs. Redis Lua

**Recommended default:** Postgres `FOR UPDATE` on a dedicated risk-row table.

**Reasoning:** Spec §8.2 says "pick one and be consistent" without a
preference. Postgres keeps the reservation in the same transactional/durability
domain as everything else this system already treats as its off-chain source
of truth (deposits, signals, ledger), avoiding a second stateful system
(Redis) whose failure modes (eviction, restart data loss) would need their own
recovery story for something that gates real capital, even if only as an
optimization layer. Redis/Lua would outperform at much higher throughput than
~100 vaults need. This is a low-stakes engineering call, included here mainly
so it's an explicit decision rather than whatever the first PR happens to pick.

### OD-14. `UNMANAGED_EXCESS` needs real custody segregation, not just a ledger flag

Per `custody-map.md` §3: deposits above the $1M cap must be held in a way a
compromised Trader key cannot reach through `execute_trade`'s mint-allowlist
path — a separate token account per client, not a commingled balance with a
database label. This is an engineering requirement to build into the Phase 2
account design, not something requiring your input, but it's flagged here
because it wasn't explicit in the spec's account sketch (§4.2) and would be
easy to under-build.

### OD-15. Withdrawal-address changes: client-signed only, or support-assisted?

**Recommended default:** Client-signed on-chain only (via
`request_withdrawal_address_change`), with support staff able to answer
questions but never able to initiate or approve a change on a client's behalf.

**Reasoning:** `threat-model.md` T16 (social engineering) is materially worse
if a support agent can be socially engineered into initiating a change, since
that removes the client's own judgment from the loop entirely. Restricting the
path to client-signed transactions means the attacker must compromise the
client's own signing capability, not just convince a third party.

**Needs from you:** Confirm this is acceptable given expected client technical
sophistication — some clients may need white-glove support for this operation,
which would argue for a support-assisted path with extra verification instead.
If so, that path needs its own design (out of scope for Phase 1) with
verification at least as strong as the client's original onboarding KYC.

### OD-16. Out-of-band notification channel for withdrawal-address changes and large redemptions

**Recommended default:** Email + SMS to the contact info captured at KYC,
independent of the dashboard notice already required by spec §7.2.

**Reasoning:** A notice that only appears inside the platform's own dashboard
is useless against an attacker who has also compromised the client's dashboard
session; an out-of-band channel is what actually gives `threat-model.md` T16's
timelock window teeth.

**Needs from you:** Confirm channel(s) and provider (may already be answered by
whatever provider you choose for KYC/AML, OD-10).

### OD-17. Reconciliation tolerance thresholds ("tight tolerance" and "hard threshold," spec §10)

**Recommended default:** No numeric default given deliberately — this
determines how sensitive the auto-pause trigger is, and setting it too tight
causes alert fatigue / unnecessary pauses, too loose lets real breaks run
undetected. Needs to be tuned against real reconciliation noise (rounding,
in-flight settlement timing) observed in staging (Phase 15 gate), not guessed
in Phase 1.

**Needs from you:** Nothing yet — flagged so it isn't forgotten before Phase 15,
not because it's decidable now.

### OD-18. Large-redemption Treasury-review threshold (spec §7.2)

**Recommended default:** Flag for review any single redemption exceeding the
greater of $250,000 or 5% of vault NAV.

**Needs from you:** Confirm or adjust — this is a liquidity-risk/operational-
friction tradeoff tied to the same judgment as OD-4's gating threshold and
should probably be set alongside it, not independently.

---

## Additional decisions from the deposit-authorization / onboarding design

Surfaced while updating the docs for the single-explicit-deposit-authorization
onboarding spec (client-pushed multi-asset deposit, SOL reserve mechanics,
server-side asset filtering).

### OD-19. Quote-time vs. execution-time authoritative headroom/credit split

**Recommended default:** Execution-time on-chain state is authoritative for
what actually gets credited as units vs. excess; the pre-signature quote is
advisory only and shapes the suggestion and the staleness/re-quote trigger, not
the final ledger entry.

**Reasoning:** Detailed in `docs/specs/deposit-spec.md` §6 — this is the only choice
consistent with the system's central principle that the backend is never
authoritative for a balance-affecting number. Flagged as a decision rather than
just implemented because the onboarding spec's own wording ("using the SAME
headroom evaluation that priced the quote") can be read either way, and if
quote-time authority is actually intended for a disclosure/contractual reason,
the crediting logic and reconciliation tolerance both need to change
accordingly.

**Needs from you:** Confirm execution-time authority, or state the
contractual reason for quote-time authority if that's actually intended.

### OD-20. ~~Stables-first allocation ordering~~ — RESOLVED, superseded

Superseded in full: allocation ordering is a strict USD-value-descending
ranking with a canonical-byte mint-address tiebreak, no asset type
prioritized. See `docs/specs/allocation-spec.md` for the algorithm and worked example.
This is no longer an open decision — it's fully specified and deterministic.
Left in place (rather than deleted) only so this entry's number isn't reused
for something else and any old reference to "OD-20 stables-first" in history
resolves to this note.

### OD-21. Per-transaction asset-count/size limits that trigger a multi-tx split

**Recommended default:** No number given — this is bounded by Solana's
transaction size limit (~1232 bytes) and compute-budget constraints per
instruction, and the actual safe threshold should come from empirical testing
against the real `deposit` instruction's account/data footprint in Phase 2,
not a guess here.

**Needs from you:** Nothing yet — flagged so Phase 2 treats it as a measured
constant, not an assumption.

### OD-22. `quote_staleness_seconds` value

**Recommended default:** Short — on the order of 15-30 seconds — to keep the
timing-arbitrage window in `threat-model.md` T18 small while still giving a
client realistic time to review a multi-asset selection before it expires.

**Needs from you:** Confirm the tradeoff direction (tighter = more re-quotes
and friction for a client reviewing multiple assets; looser = larger T18
window) and a number.

### OD-23. The 7-second submit-latency target: internal SLO, or externally implied?

**Recommended default:** Internal alerting/SLO threshold only, instrumented
per `docs/specs/deposit-spec.md` §7's three separate windows, never surfaced to clients
as any form of settlement promise.

**Needs from you:** Confirm this framing — the onboarding spec is explicit
that it must never be presented as a settlement guarantee, but doesn't say
whether it's a hard internal SLA (pages on-call if missed) or an aspirational
target (tracked, not alerted). Those imply different infra investment.

### OD-24. Return/reclaim mechanism for filtered assets and `UNMANAGED_EXCESS`

Filtered assets (R2) never leave the client's wallet in the first place, so no
return mechanism is needed for those — they simply aren't offered. But
`UNMANAGED_EXCESS` (deposits above the $1,000,000 cap, or a headroom-race
shortfall per OD-19) *has* been transferred into the vault and needs an actual
client-facing reclaim path.

**Recommended default:** A self-service on-chain withdrawal path for
`UNMANAGED_EXCESS` specifically (distinct from the standard redemption cycle,
since this capital was never unitized/invested and shouldn't be subject to
strike/settlement timing), resolving to the client's registered withdrawal
address like every other outbound path.

**Needs from you:** Confirm self-service is acceptable, or whether excess
return should route through support/manual review instead (this was already
flagged as open in OD-14; this entry narrows it to the specific mechanism).

### OD-25. `min_sol_reserve` default value

**Recommended default:** 0.05 SOL, per the illustrative derivation in
`docs/specs/reserve-spec.md` §3 (rent-exempt minimums + one future ATA creation + N=5
transactions at a p95 priority-fee assumption + a 5x safety multiple).

**This is explicitly not final** — the derivation, not the constant, is the
durable artifact; re-run it against live network rent/fee parameters before it
becomes a production value, and whenever fee-market conditions shift
materially afterward.

**Needs from you:** Confirm the derivation methodology and the safety
multiple, or supply your own risk tolerance for how much fee-market drift the
reserve should absorb before a client could theoretically be caught short.

### OD-26. Materiality disclosure threshold (default >5% of wallet value)

**Recommended default:** 5%, as stated in the onboarding spec.

**Needs from you:** Confirm 5% is the right sensitivity — too low and the
disclosure fires often enough to become noise (undermining its own purpose);
too high and a client with, say, 20% of their wallet in a filtered scam token
gets no explanation.

### OD-27. Token-2022 extensions: blanket v1 exclusion, no exceptions?

**Recommended default:** Yes — any allowlist candidate on the Token-2022
program with a transfer hook, transfer fee, permanent delegate, or
non-transferable flag is disqualified for v1, full stop, even if it's
otherwise a desirable, high-liquidity asset.

**Reasoning:** Each of these extensions breaks a different assumption the
system's on-chain checks and off-chain accounting currently rely on (see
`docs/specs/deposit-spec.md` §4); supporting any of them safely is a real engineering
project (e.g., handling a transfer fee correctly throughout the
subscribe/redeem/trade math), not a config flag, and shouldn't be taken on
speculatively before it's needed.

**Needs from you:** Confirm no early exception is needed for a specific asset
you already know you want to support — if one exists, say so now rather than
after the allowlist review process is built assuming a blanket rule.

### OD-28. Vault operational SOL reserve — target and minimum thresholds

**Recommended default:** No number given — sizing this requires expected
trade frequency, redemption frequency, and ATA-creation rate at steady state,
none of which exist yet. Treat like OD-7's risk limits: implement behind
config with a conservative placeholder, tune from real usage in staging.

**Needs from you:** Nothing yet — flagged for the Phase 15 staging gate, not
decidable now.

---

## Additional decisions from the allocation comparator specification

### OD-29. Fixed-point scale collision: 1e9 (NAV/unit price) vs. 1e6 (allocation USD micro-units)

`docs/specs/comparator-spec.md` §3 mandates a 1e6 USD micro-unit scale for the
allocation comparator specifically, which now coexists with the 1e9 scale
already used for `unit_price_scaled`/NAV throughout `accounting.md` and
`db-schema.md`. Both are exact-integer fixed-point (no floats either way), so
this isn't a precision problem — it's a **same-shape-different-meaning**
problem: two `u128`/`bigint`/`NUMERIC` values can look identical in code or in
a database column and be off by 1000x if one assumes 1e9 and the other 1e6.

**Recommended default:** Adopt distinct types per scale
(`UsdMicros`/`NavScaled1e9` or equivalent) at the module boundary in whichever
languages implement this, rather than relying on naming discipline
(`_scaled` suffixes) alone, precisely because this class of bug is silent —
it produces a wrong number, not a crash, and the whole point of
`comparator-spec.md` is closing off silent-divergence bugs.

**Needs from you:** Nothing decision-shaped yet — this is an implementation
discipline recommendation for whoever builds Phase 2, flagged now so it's
visible before two scales are load-bearing in production code, not after.

### OD-30. Where does a second (Rust) implementation of the allocation comparator actually live?

`docs/specs/comparator-spec.md` §8 and `on-chain-invariants.md` §3 both surface the
same gap: the requirement for "byte-identical Rust and TypeScript
implementations" of the allocation comparator assumes a second implementation
exists, but the Anchor program — the only Rust currently in this stack per
spec §16 — doesn't rank anything on-chain under the current
single-explicit-deposit-authorization design (the client signs already-decided
exact quantities; the program only enforces the cap incrementally against
them). The most plausible place a second implementation would actually belong
is the Signer service's independent pre-signing policy re-check
(`architecture.md` §7), *if* that service is built in Rust — which is not yet
decided, and which is itself a deviation from spec §16's named stack
("TypeScript/Node backend") requiring the written justification that section
calls for.

**No recommended default given** — this is a real architecture decision (does
a second implementation exist at all, and if so where and in what language),
not a numeric parameter with a safe placeholder.

**Needs from you:** Confirm whether the Signer-side independent check
(already itself only a recommendation from this Phase 1 pass, not yet
accepted by you) is in scope, whether it's Rust or TypeScript if so, and
whether that constitutes sufficient justification for the stack deviation. If
neither the Signer check nor any other second implementation is actually
planned, say so — the dual-implementation testing requirements in
`comparator-spec.md` §4 would then have nothing to apply to yet, and should be
treated as dormant requirements for whenever a second implementation is
introduced, not a mandate to build one just to satisfy the test spec.

---

## Additional decisions from the Phase 2 consolidated review

Surfaced while cross-checking `accounting.md`, `custody-map.md`, and
`threat-model.md` against `docs/specs/`. OD-31 and OD-32 are **counsel-
dependent, blocking** — do not resolve by engineering judgment. OD-33 through
OD-35 are engineering-track and non-blocking, tracked here rather than only
in the review document that surfaced them.

### OD-31. Multiple client registrations circumventing the $1,000,000 cap — BLOCKING, counsel-dependent

No document anywhere prevents one natural person from registering more than
one `client` record to multiply their effective managed-capital cap. KYC is
referenced throughout (`db-schema.md` `clients.kyc_status`,
`compliance-questions.md` §3) but identity-level deduplication *across*
registrations is not specified anywhere.

**Not an engineering decision.** Whether this needs preventing at all, and
how strictly, depends on what the cap is actually for — see the shared
question below. An earlier draft of this report treated this as something
engineering could just require; that was wrong, because "require dedup"
presupposes an answer to a question that hasn't been asked yet.

**Needs from you (via counsel):** see the shared question below.

### OD-32. Organic growth past the cap — BLOCKING, counsel-dependent

The $1,000,000 cap is enforced at deposit/credit time only. Nothing checks
or acts when a client's managed value grows past $1,000,000 through trading
performance rather than a new deposit. Whether that matters — whether the
cap represents a ceiling on account value or only on contributed capital —
is the same open question as OD-31, not a separate one.

**Needs from you (via counsel):** see the shared question below.

**Shared question behind OD-31 and OD-32:** what obligation is the
$1,000,000 cap actually satisfying, and does it attach to the natural person
or to the account/client record? This determines both whether cross-account
deduplication is required and whether organic growth past the cap needs any
on-chain or off-chain action. This is the same conversation as OD-1's
classification question, not a separate legal inquiry, and has been added to
`compliance-questions.md` alongside it.

### OD-33. Redemption-cycle NAV timing vs. deposit-engine crediting timing — tracked, non-blocking

The redemption cycle (`architecture.md` §4, spec §7.1) strikes NAV at a
scheduled cycle point; the deposit engine (`deposit-spec.md`) credits at
transaction finality against live on-chain state. Whether a deposit
confirming between two redemption strikes is guaranteed to be reflected in
the next NAV publish, or whether there's a window where it's neither, has
not been checked. Engineering-resolvable once the NAV Engine's publish
scheduler is designed (Phase 5); not decidable in the abstract now, and does
not block the Anchor program or comparator work.

### OD-34. Reconciliation needs an "expected divergence" category for quote-vs-execution headroom drift — tracked, non-blocking

OD-19 (execution-time on-chain headroom is authoritative, not the
pre-signature quote) creates a legitimate, expected source of
quote-vs-ledger divergence that the original reconciliation design (spec
§10, OD-17) predates and has no category for — it currently treats all
divergence as a break. Needs a bounded-tolerance carve-out (bounded by
`quote_staleness_seconds` and normal deposit sizes) designed alongside the
reconciler itself (Phase 10-ish), not decided here.

### OD-35. Does excess-return withdrawal need the same AML screening as a redemption claim? — tracked, non-blocking

`excess-return-spec.md` §4 recommends self-service on-chain withdrawal for
`UNMANAGED_EXCESS`. It's an outbound movement of client funds like a
redemption claim, but no document checks whether it needs the same
AML-screening gate a redemption claim would. Likely yes, on the general
principle that outbound fund movement doesn't get a lighter compliance path
just because the capital was never invested — but this should be confirmed
against whatever AML screening mechanism actually gets built (downstream of
OD-10), not decided in isolation now.

---

## How to respond

For each item above, the fastest path to unblocking Phase 2 is: confirm the
recommended default, give a different number/choice, or say "not yet decided,
proceed with the conservative default behind a config flag and flag it loudly
in code" — per spec §19's own instruction, the last option is always safe,
silence is not.
