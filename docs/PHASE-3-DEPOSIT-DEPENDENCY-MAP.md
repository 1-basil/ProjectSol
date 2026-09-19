# Deposit Flow Dependency Map

Maps the complete client-initiated deposit flow (`docs/specs/deposit-spec.md`)
against what's actually buildable right now, before any fund movement is
implemented. Each step is classified as one of:

- **UNBLOCKED** — no open decision or counsel question stands between this
  step and an implementation; only effort/scope decides whether it's built.
- **BLOCKED (OD-1)** — depends on vault-cardinality resolution.
- **BLOCKED (OD-31/OD-32)** — depends on the cap-semantics questions
  (identity-level dedup across `ClientAccount`s; contributed capital vs.
  account value).
- **BLOCKED (counsel)** — depends on `compliance-questions.md`.
- **REQUIRES RUNTIME** — the decision logic isn't in question, but proving
  the *instruction* does what it should requires actual Solana execution
  (BanksClient or a validator), which `cargo-build-sbf` cannot currently
  complete in this environment (see the two prior commit messages).

| # | Step | Classification | Notes |
|---|---|---|---|
| 1 | Client-initiated deposit | UNBLOCKED (decision logic) / REQUIRES RUNTIME (the instruction) | deposit-spec.md §1-§2 is a decided, frozen spec: one signed transaction, atomic transfer+unit-issuance, nothing pre-resolved. The pure allocation math behind it is buildable now (this commit). The actual instruction — CPI token transfer + conditional partial-mint + excess routing, in one atomic instruction — is explicitly deferred: PHASE-1-REVIEW.md §1 already flagged that whether this is even buildable as a single Anchor instruction was never verified, and verifying it needs real BPF execution, not a unit test. |
| 2 | Asset/mint identification | UNBLOCKED | Trivial: a `Pubkey`, nothing else. No new code needed beyond what `Account`/`UncheckedAccount` typing already gives every instruction. |
| 3 | Allowlist verification | UNBLOCKED | spec §4.2 lists `MintAllowlist`/`ProgramAllowlist` as Treasury-only append/remove. Never built until this round. **Implemented this round**: `AllowlistedMint`/`AllowlistedProgram` PDAs (one per entry), Treasury-gated add/remove, and the OD-27 Token-2022 disqualifying-combination check enforced at add-time (not just at deposit time). |
| 4 | USD valuation snapshot | UNBLOCKED (formula) / REQUIRES RUNTIME (the actual oracle read) | comparator-spec.md §3's formula is fully decided and was already ported to TypeScript. **Implemented this round**: bit-for-bit Rust port (`allocation::valuation`). Reading a live Pyth price account, checking staleness/confidence, is a real CPI/sysvar operation only provable under actual execution. |
| 5 | $1M NET managed-cap calculation | UNBLOCKED (mechanical formula) / BLOCKED (OD-31/OD-32) (semantics) | `headroom = max(0, cap − current_managed_nav)` is decided (spec §6.2 step 3) and implemented this round (`allocation::cap`) as a pure clamp over whatever two numbers a caller supplies. What those two numbers *mean* — does the cap attach to a person or an account (OD-31), does "managed" include organic trading gains or only contributed principal (OD-32) — is NOT decided, and this function does not decide it: it has no caller yet, and no caller is written this round. |
| 6 | Highest-USD-value-first allocation ordering | UNBLOCKED | comparator-spec.md's ranking rule is fully decided and already in TypeScript. **Implemented this round**: `allocation::comparator`, same fixtures (worked example, tiebreak, 3-way-tie transitivity, duplicate-mint rejection). |
| 7 | SOL 90%/reserve rule | UNBLOCKED | reserve-spec.md §1 is fully decided (the specific `min_sol_reserve` constant is a flagged-non-final placeholder, open-decisions.md OD-28, but the *formula* itself isn't blocked by that — it's a config input). **Implemented this round**: `allocation::reserve`. |
| 8 | Partial allocation at the cap boundary | UNBLOCKED | allocation-spec.md §3's boundary-rounding rule is decided; the same `allocate()` function that handles step 6 handles this — a boundary asset is just the ranked entry where `remaining` runs out mid-asset. Covered by the same tests (boundary-asset fixture, floor-not-round in `valuation`). |
| 9 | `UNMANAGED_EXCESS` segregation | UNBLOCKED (the split arithmetic) / REQUIRES RUNTIME (the actual token custody) | excess-return-spec.md §1's formula (`excess = total − creditable`) is exactly `allocate()`'s `unallocated_usd` output — no separate function exists or is needed for this; documented explicitly in `allocation::allocate`'s doc comment so this mapping isn't left implicit. The on-chain custody side (a real SPL token account owned by the `["excess_authority", owner, mint]` PDA scaffolded two commits ago) is not created or credited by anything yet — that's real token movement, deferred. |
| 10 | `UNATTRIBUTED` handling | UNBLOCKED (the invariant) / REQUIRES RUNTIME (the detection mechanism) | The invariant "never credited, never traded" is already implemented and adversarially tested off-chain (`packages/accounting/src/reconciliation.ts::checkUnattributedNotCredited`, from an earlier session). The detection mechanism itself — watching for a plain `spl-token transfer` to a per-client deposit PDA outside the signed-instruction flow — is explicitly the *secondary* path in deposit-spec.md §6.1 ("Prefer instruction-based deposits over transfer monitoring") and requires a live indexer/RPC watching real transfers; there is no pure-logic version of "did an unmatched transfer arrive" to write. Nothing new needed or attempted this round. |
| 11 | Exact quantity/account attribution | UNBLOCKED — already covered, no new code needed | deposit-spec.md §1: authority exists only inside the signed transaction, nothing is pre-resolved or recomputed. This is an architectural property of how the eventual instruction reads its own instruction data, not a separate mechanism to build. |
| 12 | Unit issuance | UNBLOCKED — already implemented (prior sessions) | `units_issued = floor(creditable_usd / unit_price)` is `math.rs::units_issued_on_subscribe` (Rust) / `ledger.ts::unitsIssuedOnSubscribe` (TypeScript), both tested against the same worked example. Composing it into a real deposit instruction (mutating `ClientVaultPosition.units_scaled` and `Vault.total_units_scaled` atomically alongside a real transfer) is deferred with the rest of step 1. |
| 13 | Replay/duplicate protection | UNBLOCKED — already covered, no new on-chain state needed | Two independent layers already exist and don't need a third: (a) Solana's own runtime guarantees a given transaction can execute successfully at most once, ever — nothing a deposit instruction does can be "replayed" on-chain by construction; (b) the off-chain idempotency key (`tx_signature, instruction_index, mint`) is a `UNIQUE` constraint in `db-schema.md`'s `deposits` table, and `packages/accounting/src/reconciliation.ts::checkTransactionAttribution` already detects both duplicate-ledger-rows and orphaned confirmations adversarially. Unlike signals (`ExecutedSignal`, backend-triggered and legitimately retryable), a deposit is client-signed and self-limiting — no analogous on-chain dedup PDA is needed, and adding one would be state for a scenario that can't happen. |
| 14 | Reconciliation after settlement | UNBLOCKED — already implemented (prior session) | `packages/accounting/src/reconciliation.ts` already checks unit conservation, NAV composition, deposit-units mismatches, and more, each with a passing + a deliberately-corrupted test. No new invariant surfaced by this round's allowlist/allocation work that isn't already covered — allowlist violations become reconciliation-relevant once an actual deposit instruction exists to violate them, not before. |

## Summary

Genuinely unblocked and implemented this round: steps 2, 3, 4 (formula), 5
(formula), 6, 7, 8, 9 (split arithmetic). Steps 11, 12, 13, 14 needed no new
code — already covered by prior sessions' work, cited above rather than
rebuilt. Step 10's invariant is likewise already covered; its detection
mechanism is out of scope (indexer work, not pure logic).

Nothing implemented resolves or narrows OD-1, OD-31, or OD-32. Step 5's
function is deliberately shaped so it works unchanged under any answer to
OD-31/OD-32 — it takes the cap and the current managed NAV as opaque
numbers and does not decide what "managed NAV" or "the cap" refer to.

What remains before a real `deposit` instruction can be attempted: the
atomic transfer+partial-mint+excess-routing instruction shape itself
(flagged as an unverified assumption in PHASE-1-REVIEW.md §1), real Pyth
price reads with staleness/confidence checks, and — as a prerequisite for
testing any of it — a working `cargo-build-sbf` or equivalent BanksClient
setup in this environment.
