# Phase 2 Kickoff — Consolidated Decision Report

Scope: read `docs/accounting.md`, `docs/custody-map.md`, `docs/threat-model.md`
in full (your message named `docs/specs/` for these three, but they live at
`docs/` root — the six `docs/specs/` files are the other specs; correcting the
path silently since it's unambiguous which files you meant, not asking).
Cross-checked against all six files in `docs/specs/`. This report is the
one-time consolidation; implementation follows it in this same response.

## 1. What is already decided

- Custodial, pooled-capital, unitized-NAV architecture; role separation
  (Trader/Treasury/Guardian); on-chain enforcement of allowlists, caps, pause,
  withdrawal destination, replay, unit conservation (`on-chain-invariants.md`).
- Unitized subscribe/redeem math, rounding-to-pool-favor, no floats anywhere
  in the accounting path (`accounting.md` §1, verified worked example §2).
- Client-pushed, single-explicit-signature deposit model; nothing resolved at
  execution time; separate positions per mint; multi-tx batches are not
  atomic and credit only what confirms (`deposit-spec.md`).
- Deposit allocation ranking: strict USD-value descending, mint-byte tiebreak,
  no asset-type priority (`allocation-spec.md`, `comparator-spec.md`).
- SOL reserve formula: `max(10%, min_sol_reserve)`, computed pre-ranking,
  ceiling not target (`reserve-spec.md`).
- Server-side asset filtering, reason-coded, never exposed to a client payload;
  Token-2022 extensions disqualifying for v1 (`deposit-spec.md` §4).
- Monetary representation: integer-only, 1e6 USD-micro-units for the
  allocation path, exact valuation formula, Postgres `NUMERIC` never
  `float8`, JSON-as-string wire format (`monetary-representation.md`,
  `comparator-spec.md` §3).
- 21 threats modeled with on-chain/off-chain mitigation split
  (`threat-model.md`).

## 2. Genuinely unresolved

Distinguishing *why* each is unresolved, since that determines who clears it.

| Item | Why unresolved |
|---|---|
| Vault cardinality (OD-1) | Depends on a legal classification question you haven't put to counsel |
| Client jurisdictions (OD-11) | Pure business/market decision, zero engineering content |
| KYC/AML provider (OD-10) | Downstream of jurisdiction + counsel's licensing answer |
| Fee rates, DEX router, initial mint list, risk limit values, KMS vendor, multisig holders (OD-2, OD-5, OD-6, OD-7, OD-12) | Commercial/strategy/vendor choices — no engineering argument picks one over another |
| Reconciliation tolerance thresholds (OD-17), vault SOL reserve target (OD-28), redemption gating threshold, large-redemption review threshold | Genuinely need real usage data (staging/production), not decidable from first principles |

## 3. Which unresolved items block Phase 2 (the Anchor program)

**Only one, partially: OD-1.** Everything else in §2 is either config-driven
(the program takes a pubkey/number from `Config`, and *which* pubkey/number
is a later deployment concern, not a code-shape concern) or simply doesn't
touch the on-chain program at all (KYC provider, jurisdictions).

OD-1 doesn't fully block either, because the account design was already
built to be neutral to its outcome: `Vault` is parameterized by `vault_id`
from day one. What OD-1 *would* change, if it resolves toward per-client
vaults instead of a shared pool: the `ClientAccount`-to-`Vault` cardinality
(currently one client → one vault's units) and whether unit accounting is
needed at all. **Decision: build for the pooled-vault model now** (it's the
only reading consistent with the worked example everywhere in `accounting.md`
§2, and the spec's own product description), parameterized so a second vault
is a config addition. If OD-1 resolves the other way later, `ClientAccount`
and the deposit/redemption instructions need rework — the Config, allowlist,
pause, replay, and `execute_trade` machinery do not.

## 4. Engineering decisions made now (documented, not asked)

| # | Decision | Reasoning |
|---|---|---|
| OD-13 | Risk reservation via Postgres `SELECT ... FOR UPDATE`, not Redis | Already recommended with no countervailing input; keeps reservation in the same durability domain as everything else |
| OD-14 | `UNMANAGED_EXCESS` gets its own token account per `(client, mint)`, PDA `["excess", client_id, mint]`, distinct from the tradable vault account for that mint | Required so `execute_trade`'s mint-allowlist path structurally cannot reach it — a label can't provide this, a separate account can |
| OD-19 | Execution-time on-chain state is authoritative for the credited/excess split, not the pre-signature quote | Pure architectural consistency: the chain is authoritative for every other balance-affecting number in this system; making the quote authoritative would be the one exception |
| OD-21 | Multi-tx split threshold computed from actual serialized transaction size against Solana's 1232-byte limit with a safety margin, not a guessed asset count | Turns a guess into a measured, self-verifying check |
| OD-22 | `quote_staleness_seconds` = 20s default (config) | Midpoint of the recommended 15-30s band; adjustable without code change |
| OD-23 | The 7s latency figure is an internal alerting threshold, not a hard SLA | Consistent with "never present as a settlement guarantee"; a hard SLA implies paging on network conditions no one controls |
| OD-24 | Excess return is a self-service on-chain instruction (`claim_excess`), mirroring `claim_redemption`'s existing pattern | Consistent with the architecture's existing self-service claim design; no new mechanism class introduced |
| OD-27 | Token-2022 mints with any of transfer-hook/transfer-fee/permanent-delegate/non-transferable are blanket-disqualified for v1, no exceptions | Each one breaks a different downstream assumption already documented; supporting any safely is unscoped work |
| OD-29 | Distinct branded types per fixed-point scale (`UsdMicros` vs. `NavScaled1e9`) | Directly implementable now; prevents a whole bug class at compile time |
| OD-30 | Build the comparator as a standalone Rust crate **and** a TypeScript package now, independent of where/whether a Signer-side Rust check ever gets wired in | The comparator's correctness doesn't depend on that unresolved architecture question — building it now is "an unrelated engineering component" per your instruction not to wait |
| New | Program-upgrade freeze mechanism = the standard BPF Loader Upgradeable `set-upgrade-authority` call with no new authority (`None`), executed via the Treasury multisig once the timelock passes. **Trigger/timing policy remains unresolved** — that's a governance decision, not an engineering one. | This was miscited in `custody-map.md` as `open-decisions.md` OD-11 (client jurisdictions — unrelated). Fixed the citation and gave the mechanism an actual answer instead of leaving it dangling. This is a pure technical-mechanism fact (how a Solana upgrade authority is frozen), not a legal or policy question, which is why it's decided here and the cap-semantics items below are not. |

**Correction to an earlier draft of this report:** the cap-semantics question
(does the $1,000,000 cap govern contributed capital or account value, and
does it attach to the natural person or the account) and cross-account KYC
deduplication were originally listed in this table as engineering decisions.
That was wrong — both presuppose an answer to a legal question about what
the cap is for, which hasn't been asked yet. They're **`open-decisions.md`
OD-31 and OD-32, marked blocking and counsel-dependent**, not decided here.
Reconciliation's "expected divergence" category and the excess-return/AML
question are genuine engineering items, but are **tracked as OD-33/OD-34/OD-35
rather than resolved** — they need the NAV Engine, reconciler, and AML
screening mechanism to actually exist before they can be designed, not
first-principles reasoning now.

`open-decisions.md` is updated to mark all of the above as **Decided**
rather than "recommended default."

## 5. Requires counsel

- Vault-cardinality-adjacent classification question (pooled vehicle vs.
  segregated accounts) — this is the actual blocker behind OD-1, per your own
  last message.
- Everything in `compliance-questions.md`, unchanged — jurisdiction,
  licensing, KYC/AML obligations, fund structure, fee/compensation
  restrictions, tax, data protection, conflicts of interest, liability,
  program-freeze disclosure obligations.

Nothing here blocks the engineering work in this response.

## 6. Contradictions and security gaps found

1. **`custody-map.md` C12 cites `open-decisions.md` OD-11 for the program
   freeze path; OD-11 is "client jurisdictions."** Stale/wrong cross-reference
   — fixed, and the freeze mechanism now has an actual answer (§4 above).
2. **No document anywhere prevents one person from registering multiple
   `client` records to circumvent the $1,000,000 cap.** KYC is referenced
   throughout but identity-level deduplication *across* registrations was
   never specified. **Not resolved by engineering** — promoted to
   `open-decisions.md` OD-31, blocking, counsel-dependent (see correction
   note above §5).
3. **The $1,000,000 cap's semantics (contributed capital vs. account value)
   were never stated explicitly anywhere**, including in `on-chain-invariants.md`'s
   own cap-enforcement row. **Not resolved by engineering** — this is the
   same question as item 2 above; promoted to `open-decisions.md` OD-32,
   blocking, counsel-dependent, and added to `compliance-questions.md` §1
   alongside the OD-1 classification question.
4. **Reconciliation (`open-decisions.md` OD-17) predates the deposit engine's
   execution-time-authoritative headroom (OD-19) and has no category for the
   legitimate divergence that design can produce.** Tracked as OD-34,
   non-blocking, engineering-track — not resolved here, since it needs the
   actual reconciler design (Phase 10) to specify properly.
5. **`custody-map.md` was never revisited against the deposit-engine specs**
   added after it, beyond the single C9 note. Re-checked now: no new custody
   point is missing except the `claim_excess` self-service path (OD-24),
   which is the same shape as `claim_redemption` (C8) and doesn't need a new
   row — it resolves to the registered address exactly like every other
   outbound path.
6. **`threat-model.md` T17-T21 don't cover a self-interested client gaming
   their own wallet contents to manipulate the allocation ranking/tiebreak in
   their own favor** (as opposed to an external attacker). Genuine gap;
   low severity (bounded to that client's own allocation outcome, not
   exploitable against anyone else) but adding it below for completeness.

---

## DECISION REQUIRED

Only items where engineering reasoning genuinely cannot pick an answer.

**D1. Redemption cycle cadence and notice period (OD-3)**
- Options: (a) daily strike / T+1 settlement, no extra notice; (b) daily
  strike with a longer notice period (7-30 days) layered on top; (c) a
  longer strike cycle itself (weekly/monthly).
- Recommended: (a).
- Why: it's the tightest cadence that still gives the liquidation pipeline a
  full trading day before settlement, without promising liquidity the pooled
  model can't provide. Longer notice reduces liquidity risk further but is a
  client-experience/competitiveness tradeoff — not something engineering
  reasoning can resolve, since (b) and (c) are both internally consistent.

**D2. Withdrawal-address change: client-signed-only, or support-assisted path too?**
- Options: (a) client-signed-only, forever; (b) client-signed-only for v1,
  explicitly revisit if support load demands it; (c) build a support-assisted
  path now with extra verification.
- Recommended: (b) — I'm building (a) now since it's the secure default and
  nothing in Phase 2 depends on (c) existing; flagging that this is a
  product/support-capacity tradeoff, not purely a security one, so it's
  listed here rather than silently decided.

Everything else previously listed as needing your input (fee rates, DEX
router, mint allowlist, risk limits, gating threshold, large-redemption
threshold, KMS vendor, multisig holders) is unchanged from `open-decisions.md`
and still needs you eventually — but none of it blocks the code in this
response, so it's not repeated here as a blocking question.

## COUNSEL REQUIRED

Unchanged from `compliance-questions.md`, plus the specific classification
question behind OD-1, **plus its logical extension**: what the $1,000,000 cap
is actually for and whether it attaches to the natural person or the account
(`open-decisions.md` OD-31/OD-32, `compliance-questions.md` §1) — this is the
same conversation as OD-1, not a separate one, and both are now blocking. Not
restating the full `compliance-questions.md` list here — it hasn't otherwise
changed.
