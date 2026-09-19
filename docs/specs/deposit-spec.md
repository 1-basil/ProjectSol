# Deposit Engine Specification (Normative)

Status: **Normative implementation spec.** Phase 2 input. Pins down EXACTLY
HOW the single-explicit-deposit-authorization onboarding flow works: the
pre-signature/post-signature split, server-side asset filtering, the
headroom-authority resolution, multi-transaction atomicity, and latency
instrumentation. The WHY (client-pushed deposits over transfer monitoring,
custody boundaries) lives in `architecture.md` §3 and `custody-map.md`; the
allocation ranking and SOL reserve this engine calls are specified separately
in `docs/specs/allocation-spec.md` and `docs/specs/reserve-spec.md`.

## 1. The authorization boundary, restated

Authority to move a specific mint and exact quantity exists only inside the
one transaction the client signs, and does not survive it. Nothing
enumerated, quoted, or suggested before that signature has any execution
authority, and nothing is resolved or recomputed at execution time — the
signed instruction data is a closed, explicit statement of mints and
quantities.

## 2. Pipeline

```
PRE-SIGNATURE (read-only, advisory, no authority)
──────────────────────────────────────────────────
  Client wallet ──▶ Deposit Quote Engine:
    1. Enumerate wallet assets, read-only RPC, then FILTER server-side before
       any response is constructed (§4).
    2. Price via oracle, single timestamp for the whole computation.
    3. headroom = max(0, 1,000,000 − current_managed_nav_usd).
    4. Apply the cap.
    5. Rank eligible assets and allocate down the ranked list until headroom
       is exhausted (`docs/specs/allocation-spec.md`) to produce the
       suggestion. Client can override/deselect — the client's final
       selection is authoritative, and any deselection triggers a full
       re-rank, never a patch.
    6. Compute fees + SOL reserve (`docs/specs/reserve-spec.md`); deduct
       reserve from allocatable SOL. Backend must reject, not just decline to
       suggest, any client-selected SOL quantity above the computed ceiling
       (§5; `threat-model.md` T20).
    7. Build the unsigned transaction(s), splitting across multiple if asset
       count/size exceeds limits (`open-decisions.md` OD-21); present the
       complete set to the client.
  Result: a `deposit_quotes` row — advisory, time-bounded
  (`quote_staleness_seconds`, OD-22), never persisted as something any code
  path can act on unilaterally.

  ══════════════════ CLIENT SIGNS — authority begins and ends here ══════════════════

POST-SIGNATURE (execution-authoritative)
──────────────────────────────────────────────────
  Deposit Submission Pipeline:
    8. Submit exactly what was signed. Never re-derive quantities.
    9. Record every signature (`deposit_transactions`).
   10. Confirm to configured finality.
   11. Credit the unit ledger only after finality — §6 on which headroom
       evaluation is authoritative for the actual credited/excess split.
   12. Excess per `docs/specs/excess-return-spec.md`: zero units, excluded
       from NAV.
   13. Reconcile ledger against on-chain balances.
```

Assets are credited as **separate positions** — no conversion happens at
deposit time; a client depositing three different mints in one session ends
up with three position entries in the vault, and any later conversion
happens only as a trade, under normal risk controls, from a signal.

The secondary path (unique per-client deposit PDA + sweeper, for a plain
`spl-token transfer` outside the app flow) and the `UNATTRIBUTED` fallback
bucket are unaffected by this engine and continue to coexist — they exist for
exactly the case this engine doesn't cover: a transfer that never went
through the quote/sign flow at all.

## 3. Multi-transaction atomicity

Solana cannot make N transactions atomic, so a multi-transaction deposit
(triggered when asset count or size exceeds per-transaction limits, OD-21) is
handled as N independent, individually-atomic `deposit` instruction calls,
each of which is itself atomic (transfer + unit issuance together). If 2 of 3
land and 1 fails:

- Credit exactly what confirmed. Never credit intent.
- Mark the batch `PARTIAL`, surface it to the client, offer retry of the
  remainder as a **new signed transaction** — never auto-retry an unsigned
  remainder, since that would silently recreate a standing authority the
  whole design exists to avoid.
- Recompute headroom and re-quote before the retry — NAV and prices have
  moved.
- Never assume the client still holds the unsent assets.

## 4. Server-side asset filtering and the materiality disclosure exception

Filtering is a safety control, not a business one — it exists to keep unsafe
or unsupported assets out of the deposit flow, never to hide assets the
platform simply prefers not to handle without a recorded reason. Every
exclusion carries one of the enumerated reason codes in `db-schema.md`'s
`filtered_deposit_candidates` table (`NOT_ON_ALLOWLIST`, `NO_ORACLE_PRICE`,
`INSUFFICIENT_LIQUIDITY`, `FROZEN_ACCOUNT`, `NON_TRANSFERABLE`,
`UNSUPPORTED_PROGRAM`, `KNOWN_SCAM`, `TRANSFER_HOOK_PRESENT`,
`FEE_ON_TRANSFER`, `NFT`), recorded for reconciliation, security analytics,
and scam-mint intelligence — never surfaced to the client as a deposit
option, and never returned by the API at all. Filtering happens before the
response is constructed; there is no "hidden" or "greyed out" state, because
a frontend-only filter is still exfiltrated data reachable by a modified
client (`threat-model.md` T21).

Token-2022 mints get explicit, per-extension checks rather than being treated
as interchangeable with SPL Token mints anywhere in the codebase — a transfer
hook, a transfer fee, a permanent delegate, and non-transferability each
break a different downstream assumption (the post-balance assertion in
`on-chain-invariants.md`, the unit-issuance valuation, the redemption payout
path, respectively), so each is checked and coded separately even though all
four currently lead to the same v1 outcome (disqualified; `open-decisions.md`
OD-27).

**One disclosure exception.** If a filtered-out asset represents a material
share of the client's wallet value (default >5%, `open-decisions.md` OD-26),
the UI shows a single non-interactive line — "Some assets in this wallet are
not supported and will not be included" — with no mint list, no values, no
selection affordance, and no link. Silence in this specific case reads as the
platform malfunctioning and generates support load that looks like
concealment; the disclosure itself must leak nothing that would help someone
map the platform's filter logic or scam-mint list.

## 5. Backend rejection of an over-ceiling SOL request

Per `docs/specs/reserve-spec.md` §2: the backend must **reject** (not clamp)
any client-selected SOL quantity above `offered_sol`, at the API layer,
applied to every caller of the transaction-build endpoint — not just the
reference UI. Silently clamping would hide a bug or an attempted bypass. See
`threat-model.md` T20.

## 6. Which headroom evaluation is authoritative at credit time

Step 11 above is ambiguous between two designs, resolved here rather than
guessed silently:

- **Quote-time headroom is authoritative** — the off-chain ledger credits
  exactly what was disclosed to the client pre-signature, even if on-chain
  state has moved by the time the transaction confirms.
- **Execution-time on-chain state is authoritative** — the `deposit`
  instruction computes the actual managed/excess split from live on-chain
  state at the moment it executes, and the off-chain `deposits` row records
  what the chain actually did.

**Resolution: execution-time on-chain state is authoritative.** This is the
only choice consistent with this system's central principle that the backend
is never authoritative for a balance-affecting number — the chain is (see
`on-chain-invariants.md` §1's cap-enforcement row, which specifies the
assertion runs "at the point units would be issued," i.e., at execution
time, against live state). Making the quote authoritative instead would mean
the off-chain ledger could disagree with what the chain actually recorded,
which is exactly the class of bug `db-schema.md`'s reconciliation tables
exist to catch. `quote_staleness_seconds` (§7) is what keeps the gap between
quote and execution small in practice — it does not make the quote itself
authoritative. **Still needs your confirmation — `open-decisions.md` OD-19**;
if quote-time authority is actually intended for a contractual reason, the
crediting logic and reconciliation tolerance both need to change.

## 7. Latency instrumentation (not a settlement guarantee)

The 7-second target applies only to `t1 (submitted) − t0 (signature
received)`. Pre-signature enumeration/quoting (bounded by RPC and client
reading time) and post-submission confirmation (bounded by the network) are
explicitly out of scope for that figure and must be instrumented and
reported separately: quote latency, submit latency, and submit-to-finality,
each at p50/p95/p99. The 7s figure must never be presented to clients as a
settlement-time guarantee — it measures backend dispatch speed, not when
their deposit is final. Whether it is an internal hard SLO or an
aspirational target is unresolved — `open-decisions.md` OD-23.

If quote-to-signature time exceeds `quote_staleness_seconds`, the quote is
invalidated and re-quoted rather than submitted against a stale price or
stale headroom.

Cap enforcement ($1,000,000 managed capital per client) happens **at credit
time**, on-chain, inside the `deposit` instruction path (see
`on-chain-invariants.md`). Amounts pushing a client over the cap are split
per `docs/specs/excess-return-spec.md`: the creditable portion is issued as
units; the remainder is recorded as `UNMANAGED_EXCESS`.
