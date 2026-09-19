# On-Chain Invariants

Status: Phase 1 draft. This document exists to prevent a specific class of lie:
claiming a backend check as an on-chain guarantee. Every row below is either
enforced by the Anchor program (and therefore holds even if every off-chain
component is compromised) or explicitly marked backend-only (and therefore holds
only if the backend is honest and correct).

If Phase 2 implements something in this table's "on-chain" column as a backend
check instead, that is a spec deviation and must be raised, not merged silently.

## 1. Enforced on-chain (holds under full backend compromise)

| Invariant | Instruction(s) | Mechanism |
|---|---|---|
| Only allowlisted mints can be traded | `execute_trade` | Reads `MintAllowlist` PDA; asserts input and output mint membership before CPI |
| Only allowlisted DEX/router programs can be CPI'd into | `execute_trade` | Reads `ProgramAllowlist` PDA; asserts target program ID membership |
| Trading halts instantly on pause | `execute_trade` | Asserts `Config.paused_global == false` and `Vault.paused == false` (or `paused_trading`) before any other logic |
| Deposits can be halted independently of trading | `deposit` | Asserts `Config.paused_deposits == false` |
| No signal executes twice | `execute_trade` | `ExecutedSignal` PDA at `["exec", vault, signal_id]` created with Anchor's `init` constraint — the runtime rejects a second `init` for the same seeds atomically, even under two workers racing. This is the authoritative dedup layer; the Postgres unique constraint is a fast-path optimization, not the guarantee |
| Per-trade and rolling-window notional caps | `execute_trade` | Oracle price read in the *same* instruction, notional computed, compared against `Vault.daily_notional_used` + per-trade cap from `Config.fee_params`/risk config; counter incremented atomically in the same transaction |
| Slippage / minimum-out bound | `execute_trade` | Pre/post token-account balance deltas compared against `min_out`/`max_in` passed into the instruction — not trusted from the route's own claimed output |
| No CPI drains an unrelated vault token account | `execute_trade` | Post-balance assertion: no vault token account may decrease except the declared input account (spec §4.4 step 7) — this is what survives a malicious or buggy route, and it is the single most important line of code in the program |
| Withdrawal destination is always the client's registered address | `settle_redemption`, `claim_redemption`, `emergency_in_kind_redeem` | Destination account constraint is derived from `ClientAccount.registered_withdrawal_addr`, not from instruction-supplied data |
| Withdrawal-address changes are timelocked and cannot be instant | `request_withdrawal_address_change` / `confirm_withdrawal_address_change` | `confirm` asserts `now >= withdrawal_addr_effective_at`, set by `request` to `now + min_delay` (min 24-48h per spec §4.3) |
| Role separation: Trader cannot withdraw | `execute_trade` account constraints | The instruction's account list has no destination-outside-vault account for the Trader signer to name; withdrawal-shaped instructions require Treasury signer, a structurally different code path |
| Guardian can only pause, never unpause | `pause` vs `unpause` | Separate instructions with separate signer constraints — `pause` accepts the Guardian key, `unpause` requires Treasury |
| NAV cannot move further than the sanity band per publish (absent Treasury co-sign) | `publish_nav` | Asserts `abs(new_price - old_price) / old_price <= nav_sanity_band_bps` unless the transaction also carries a valid Treasury co-signature; also asserts publish recency (rejects if the previous publish is older than the allowed staleness window without one) |
| Unit conservation | `deposit`, `settle_redemption`/`claim_redemption` (burn), `execute_trade` (must not touch `total_units`) | Units are minted only inside the deposit code path from a verified token transfer, burned only inside the settled-redemption code path; `execute_trade` has no instruction path that touches `total_units` at all — it can only reallocate the vault's token holdings |
| Config/allowlist changes require Treasury + timelock | `update_config`, mint/program allowlist edits | Signer constraint requires Treasury multisig PDA; a timelock account gates the effective slot/timestamp, mirroring the withdrawal-address-change pattern |
| Dead-man's switch unlock is permissionless once triggered | `emergency_in_kind_redeem` | Asserts `now - Vault.last_nav_ts > dead_man_switch_seconds` AND no trade executed in that window; once true, any client (not just an authorized caller) can invoke pro-rata withdrawal for themselves |
| $1,000,000 managed-capital cap is enforced at the point units would be issued | `deposit` | Asserts `(existing managed value + this deposit's USD value) <= ClientAccount.managed_cap_usd`; the excess portion is not included in the unit-issuance amount for that instruction call (see open-decisions.md OD-9 for how the excess is actually held, which has an on-chain custody implication per custody-map.md C9) |

## 2. Backend-only (requires attestation + reconciliation; does NOT hold under backend compromise)

| Item | Why it cannot be on-chain | What bounds the risk instead |
|---|---|---|
| Full portfolio NAV across many venues | The chain only sees vault token balances directly; it cannot independently price complex positions or verify off-venue state | NAV sanity band on `publish_nav` (bounds how much a bad NAV can move in one publish) + continuous reconciliation + auto-pause on breach (spec §10) |
| Price-impact estimation for a prospective trade | This is a predictive quality judgment, not a verifiable fact at execution time | Post-hoc: realized slippage is checked on-chain (min-out assertion); pattern-level anomaly detection is backend/alerting |
| Route selection quality (did the router find a good price, not just an acceptable one) | The program can verify the *outcome* (min-out) but not that a better outcome was available elsewhere | Backend monitoring compares realized execution price against oracle price and flags outliers; does not block execution in real time unless it exceeds the on-chain min-out bound |
| Client identity / KYC status | Off-chain legal/compliance process, not a cryptographic fact | Backend gates account creation and deposit-instruction issuance to clients who cleared KYC; the chain has no concept of "verified human" |
| Fee accrual correctness (daily management fee math, HWM performance-fee crystallization) | These are NAV-derived numbers computed off-chain before being folded into the published `unit_price_scaled` | The published price itself is bounded by the sanity band; the *composition* of that price (how much is fee vs. performance) is only as correct as the NAV Engine, and is audited via `docs/accounting.md`'s invariants and reconciliation, not enforced on-chain |
| Which mints/programs *should* be on the allowlist | The chain enforces membership, not appropriateness of membership | Treasury governance process (off-chain judgment, on-chain-enforced execution of that judgment) |
| Oracle price *accuracy* (as opposed to staleness/confidence-interval checks) | The program can validate the shape of the oracle's answer (fresh enough, confident enough) but not that Pyth itself is correct | Externalized risk — see threat-model.md "oracle manipulation"; mitigated by using a decentralized oracle rather than a single feed, not eliminated |
| Deposit attribution via the secondary (transfer-monitoring) path | Matching an inbound transfer to a client PDA is an off-chain indexing operation, even though the PDA address itself is program-derived | Unique-deposit-PDA-per-client design makes the matching deterministic rather than probabilistic (spec §6.1); still an off-chain indexer that could theoretically be paused/DoS'd, bounded by the unattributed-bucket fallback |

## 3. The deposit-allocation ranking is not an on-chain concept

Stated plainly, per the requirement that this document be honest about the
enforceable/backend-only boundary rather than overstate it: **the Anchor
program does not compute, recompute, or validate any ranking or ordering of
a client's deposited assets.** It has no concept of "which asset ranks above
which" at all.

What the program actually does, given the single-explicit-deposit-
authorization design (`architecture.md` §3.1, normatively specified in
`docs/specs/deposit-spec.md`): a signed deposit transaction already contains
explicit, fully-decided `(mint, quantity)` pairs — decided by the off-chain
Deposit Quote Engine's ranking (`docs/specs/allocation-spec.md`, comparator
normatively specified in `docs/specs/comparator-spec.md`) before the client
ever saw a transaction to sign. The program's only job per pair is the
invariant already listed in §1 above: assert the managed-capital cap
incrementally against live on-chain state as each transfer is processed, in
whatever order the instructions appear in the transaction the client actually
signed. It never asks "is this the correct asset to prioritize" — that
question was answered off-chain, before signature, and is not re-litigated
on-chain.

**Consequence for `docs/specs/comparator-spec.md`'s dual-implementation
requirement:** because the program itself has no comparator, there is
currently no on-chain Rust implementation of this ranking for a second,
off-chain implementation to achieve parity *with*. If a Rust implementation is
introduced elsewhere (see `comparator-spec.md` §8 and `open-decisions.md`
OD-30 — the leading candidate being the Signer service's independent
pre-signing policy check, not the Anchor program itself), the comparator
parity that implementation needs is between the TypeScript Deposit Quote
Engine and that Rust service, not between the backend and the Anchor program.
Do not build Rust ranking logic into the Anchor program itself on the
assumption that this is what "on-chain consistency" requires — it would be
unnecessary program complexity solving a problem the program doesn't have,
since the client's signature already fixes the exact quantities before the
program ever runs.

## 4. The honest summary

The chain guarantees: **what a valid transaction is allowed to do to the vault's
token accounts and unit ledger**, given the accounts and signers it requires. It
does not and cannot guarantee: **that the numbers fed into those transactions
(NAV, prices, position quality) are wise or even correct**, beyond the bounds
explicitly checked (staleness, confidence interval, sanity band, min-out).

Concretely, under full backend compromise: an attacker cannot move a single token
out of the vault to anywhere but a client's registered, timelocked address, and
cannot mint or burn a unit without a real deposit or a Treasury-settled
redemption. An attacker *can*, if they also control the Trader key or enough of
the NAV pipeline, cause real economic damage within the caps (trade into a bad
allowlisted mint at max slippage repeatedly, or push NAV the full width of the
sanity band once per publish interval). Those residual risks are named, not
hidden — see `docs/threat-model.md`.
