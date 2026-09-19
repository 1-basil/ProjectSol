# Solana Managed Trading Platform — Engineering Build Spec

**Audience:** Claude Code (and the humans reviewing its output)
**Status:** Design-and-build spec. Not a marketing document.
**Prime directive:** This system takes custody of other people's money. Every design
decision is subordinate to the question *"what can a compromised or dishonest
component do, and how do we make that as small as possible?"*

---

## 0. How to use this file

Feed this file to Claude Code as project context (save it as `SPEC.md` at the repo
root and reference it, or paste it as the opening message). Then work through
**§17 Build Phases** in order. Each phase has an acceptance gate. Do not start a
phase until the previous gate passes.

**Do not generate the entire codebase in one pass.** Phase 1 output is documents and
schemas, not application code. If you are tempted to skip ahead to writing services,
that is the signal to stop and finish the design artifacts first.

---

## 1. What this is, and what it explicitly is not

### 1.1 Product

A Solana managed trading platform. Roughly 100 clients voluntarily deposit
supported fungible assets into platform-controlled vaults. Authorized experts emit
BUY/SELL signals with explicit position sizing. An autonomous engine executes those
signals against the pooled managed capital while clients are offline. Per-client
ownership is tracked in a unitized ledger, reconciled continuously against on-chain
state. Clients redeem through a defined, auditable withdrawal process.

Per-client managed capital cap: **$1,000,000 USD equivalent**. Deposits above that
are held uninvested and flagged, not silently managed.

### 1.2 Hard prohibitions

The system MUST NOT, in any phase, under any refactor:

- Request, receive, or store a client's seed phrase or private key.
- Take delegate/authority over a wallet the client did not deposit *from* into the
  platform's own vault. No `approve` on client-held token accounts. No sweeping.
- Touch any asset that is not inside a platform vault as the result of a recorded,
  reconciled deposit.
- Grant experts withdrawal authority, signing authority, or key access.
- Move client funds to any destination other than that client's registered,
  timelocked withdrawal address (or an allowlisted DEX program during trading).
- Allow the backend to relax an on-chain constraint by changing an API payload.
- Convert a position "all-in" — every trade carries an explicit size.

If a future request asks for any of the above, treat it as a spec violation and
raise it rather than implementing it.

### 1.3 Custody is the defining fact of this architecture

The previous design was non-custodial and dangerous. This design is custodial and
therefore *regulated*. Pooled client capital, discretionary management by a third
party, and profit sharing is, in most jurisdictions, some combination of a
collective investment scheme, investment-adviser activity, and money transmission.

**Phase 16 (production) has a legal gate, not just a security gate.** Claude Code
should produce `docs/compliance-questions.md` in Phase 1 listing the specific
questions counsel must answer (client jurisdictions, KYC/AML obligations, fund
registration, custody licensing, marketing restrictions, tax reporting). It should
not attempt to answer them. Building the software is fine; operating it with real
client money without those answers is where the exposure lives.

---

## 2. System overview

```
                     ┌───────────────────────────────┐
   Expert ──signal──▶ │ Signal Service + Validator    │
                     └──────────────┬────────────────┘
                                    ▼
                            Durable Job Queue
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
          Worker 1              Worker 2              Worker N
              └─────────────────────┼─────────────────────┘
                                    ▼
                      Risk Engine (reservation/commit)
                                    ▼
                    Pricing/Oracle  ·  Quote & Routing
                                    ▼
                          Transaction Builder
                                    ▼
                          Simulation / Preflight
                                    ▼
                    Signer (policy-constrained, hot)
                                    ▼
              ┌──── Anchor Program: trading-vault ────┐
              │  enforces allowlists, caps, pause,    │
              │  withdrawal destinations, replay      │
              └──────────────────┬────────────────────┘
                                 ▼
                            Solana RPC
                                 ▼
                     Confirmation → Reconciliation
                                 ▼
              NAV Engine → Unit Ledger → Dashboards / Audit
```

Client deposits and redemptions are a separate path that also terminates in the
Anchor program and the unit ledger.

---

## 3. Custody and key architecture

This is the highest-value section. Get it wrong and nothing else matters.

### 3.1 Role separation — three distinct authorities

| Authority | Can do | Cannot do | Key material |
|---|---|---|---|
| **Trader** (hot) | Call `execute_trade` on allowlisted mints/programs within caps | Move funds out of the vault. Change config. Mint units. | Hot signer in KMS/HSM or MPC. Rotatable. |
| **Treasury** (cold) | Approve redemption settlements, config changes, allowlist edits | Trade | m-of-n multisig (e.g. Squads), hardware keys, geographically separated holders |
| **Guardian** (warm) | Pause — instantly, unilaterally | Unpause. Move funds. Trade. | Single key, low ceremony, deliberately asymmetric |

The asymmetry matters: pausing must be cheap and fast, unpausing must be expensive
and deliberate. A compromised guardian key can only halt the system, which is a
survivable failure.

**Critical invariant:** compromise of the trader key must not be able to remove
value from the vault. The program enforces that `execute_trade` can only move tokens
into an allowlisted DEX program and receive tokens back into vault-owned accounts.
Withdrawal instructions require Treasury.

Note the residual risk honestly in `docs/threat-model.md`: a compromised trader key
can still *destroy* value by trading into an allowlisted-but-illiquid mint at max
slippage repeatedly. Mitigations: tight per-day notional caps, tight allowlist,
anomaly alerting on realized slippage, guardian auto-pause on threshold breach.

### 3.2 Program upgrade authority

An upgradeable Anchor program means every on-chain guarantee is only as strong as
the upgrade key. Put the upgrade authority behind the Treasury multisig **plus a
timelock** from day one, publish the timelock, and document a path to eventually
freezing the program. If you skip this, §11 of the source brief ("backend must never
be able to bypass these constraints") is not actually true.

### 3.3 Key storage

Never in source, `.env` in production, git, plaintext DB, or logs. Use a real
signing service (cloud KMS with a Solana-compatible signer, or an MPC/HSM provider).
The backend should call a signer API, not hold bytes. Document rotation and
recovery procedures in `docs/key-management.md` before mainnet.

---

## 4. On-chain program (`programs/trading-vault`)

### 4.1 What the chain can and cannot enforce

Be precise here rather than claiming more than is true.

**Enforceable on-chain:** allowlisted mints; allowlisted DEX program IDs; pause
flags; per-trade and rolling-window notional caps (against oracle price read in the
same instruction); min-out / slippage bound (via pre/post balance deltas);
withdrawal destination equals registered address; replay protection; unit
mint/burn conservation; role separation.

**Not enforceable on-chain, must be backend + attested + reconciled:** full
portfolio NAV across many venues; price impact estimation; route selection quality;
client identity/KYC; fee accrual correctness.

Write this boundary into `docs/on-chain-invariants.md` and design accordingly. Do
not pretend a backend check is an on-chain guarantee.

### 4.2 Accounts (sketch — refine in Phase 2)

```
Config          PDA["config"]
  treasury_multisig, guardian, trader_signer,
  paused_global: bool, paused_trading: bool, paused_deposits: bool,
  fee_params, oracle_registry, upgrade_timelock_ref

Vault           PDA["vault", vault_id]
  authority_bump, total_units: u128, unit_price_scaled: u128,
  last_nav_ts, nav_sanity_band_bps, paused: bool,
  daily_notional_used: u128, daily_window_start: i64

ClientAccount   PDA["client", client_id]
  owner, units: u128, registered_withdrawal_addr,
  pending_withdrawal_addr, withdrawal_addr_effective_at: i64,
  managed_cap_usd, hwm_unit_price, status

MintAllowlist   PDA["mints"]          // append/remove = Treasury only
ProgramAllowlist PDA["programs"]      // Treasury only

ExecutedSignal  PDA["exec", vault, signal_id]
  // init-on-execute: creation fails if it already exists → free replay protection

RedemptionRequest PDA["redeem", client_id, seq]
  units_requested, requested_at, cycle_id, struck_unit_price, status
```

`ExecutedSignal` using Anchor's `init` constraint is the cleanest idempotency
primitive available — the runtime rejects the duplicate for you, atomically, even
if two workers race. Use it as the authoritative dedup layer, with the database
unique constraint as the fast-path.

### 4.3 Instructions

`initialize_config`, `update_config` (Treasury + timelock), `register_client`,
`request_withdrawal_address_change` / `confirm_withdrawal_address_change`
(timelocked, min 24–48h, notified), `deposit`, `request_redemption`,
`strike_redemption_cycle`, `settle_redemption` (Treasury), `claim_redemption`,
`execute_trade` (Trader), `publish_nav`, `pause` (Guardian), `unpause` (Treasury),
`emergency_in_kind_redeem`.

### 4.4 `execute_trade` pattern

Do not accept arbitrary instruction data and CPI blindly. Pattern:

1. Assert not paused; assert caller is Trader; assert `ExecutedSignal` init succeeds.
2. Assert input and output mints are on the allowlist.
3. Assert the target program ID is on the allowlist.
4. Read pre-balances of the vault's token accounts.
5. Read oracle price (Pyth) with staleness and confidence-interval checks; compute
   notional; assert per-trade cap and rolling daily cap; increment the counter.
6. CPI to the routing program.
7. Read post-balances. Assert `amount_in <= max_in` and `amount_out >= min_out`.
   Assert no vault token account decreased other than the intended input.
8. Emit event.

Step 7 is the one that survives a malicious or buggy route. Do not omit it.

### 4.5 `publish_nav` sanity band

NAV is published by the backend and is the input to unit pricing — which means it is
the lever an insider would pull. Constrain it: reject any published NAV that moves
more than `nav_sanity_band_bps` from the previous value, or that is older than N
seconds, unless co-signed by Treasury. Log every rejection loudly.

### 4.6 Dead-man's switch

If no NAV has been published and no trade executed for N days (suggest 30),
`emergency_in_kind_redeem` unlocks: any client may withdraw their pro-rata share of
each vault token directly to their registered address without operator action. This
is what makes the custodial model defensible to a client — the operator disappearing
is not the same as the money disappearing. Strongly recommended; if the business
declines it, record that decision and its rationale in the docs.

---

## 5. Accounting model — unitized, not percentage-based

**Use unit (share) accounting, mutual-fund style.** Percentage-of-pool recomputed ad
hoc is the single most common source of silent fund-accounting bugs, because it
breaks the moment clients deposit or redeem at different times.

### 5.1 Model

- Pool has `total_units` and `unit_price = NAV / total_units`.
- Initial `unit_price` = 1.000000000 (scaled integer, 1e9).
- **Subscribe:** `units_issued = floor(deposit_usd / unit_price)` — round **down**.
- **Redeem:** `payout = floor(units_burned * unit_price)` — round **down**.
- Always round in the pool's favour. Dust accrues to the pool, never leaks out.
- Store all units and prices as scaled integers (`u128`). **No floating point
  anywhere in the accounting path.** Add a lint rule if you can.

### 5.2 Worked example (this must appear as a test)

| Event | NAV before | Unit price | Action | Units | NAV after |
|---|---|---|---|---|---|
| A deposits $50,000 | $0 | 1.00 | issue 50,000 u to A | 50,000 | $50,000 |
| Pool +10% | $50,000 | 1.10 | — | 50,000 | $55,000 |
| B deposits $100,000 | $55,000 | 1.10 | issue 90,909.0909 u to B | 140,909.09 | $155,000 |
| Pool +10% | $155,000 | 1.21 | — | 140,909.09 | $170,500 |

Final: A = 50,000 × 1.21 = **$60,500**. B = 90,909.09 × 1.21 = **$110,000**.

B, who joined later, correctly earns only the gain that occurred after they joined.
A percentage-based model gets this wrong. This is the required behaviour.

### 5.3 Fee accrual

Management fees must accrue **into NAV daily** so that unit price is always net of
accrued fees. Otherwise a client redeeming mid-period gets a price that overstates
their entitlement at the expense of everyone remaining.

Performance fees: implement per-client high-water-mark on unit price, crystallising
at period end. Document the alternative (equalisation / series accounting) in
`docs/accounting.md` and note that the HWM approach can produce small cross-client
inequities at the margins. Only build performance fees if they're actually in the
commercial model — do not build speculative fee machinery.

### 5.4 Invariants (assert these in code and in property tests)

- `sum(client.units) == vault.total_units` — always, no exceptions.
- Units are only created by a confirmed deposit and only destroyed by a settled
  redemption. No other code path may change `total_units`.
- `NAV == cash + Σ(position_qty × oracle_price) − liabilities − accrued_fees`.
- A trade changes NAV composition but must not change `total_units`.

---

## 6. Deposits

### 6.1 Prefer instruction-based deposits over transfer monitoring

The source brief describes monitoring addresses for incoming transfers and matching
them to clients. That matching is the weak point — memo-based or amount-based
attribution misassigns funds under concurrency and is a support nightmare.

**Primary path:** client calls the program's `deposit` instruction from their own
wallet. Token transfer and unit issuance happen in one atomic transaction against a
`ClientAccount` PDA. No matching required, no ambiguity, no double-credit window.

**Secondary path:** each client also gets a **unique deposit PDA** so that a plain
`spl-token transfer` is self-identifying by destination address. A sweeper credits
these into the pool and issues units at the next strike. Never share one deposit
address across clients.

**Fallback:** unidentifiable inbound funds go to an `UNATTRIBUTED` ledger bucket
and raise an operational alert. They are never auto-credited and never traded.

### 6.2 Rules

- Idempotency key: transaction signature + instruction index + mint. Unique
  constraint in Postgres. Re-processing a signature is a no-op, always.
- Wait for the configured finality policy before crediting (specify: `finalized`).
- Valuation at deposit uses the oracle, not a DEX spot quote.
- Enforce the $1M cap at credit time: amounts above the cap are recorded as
  `UNMANAGED_EXCESS`, held, not traded, and clearly shown on the dashboard. Never
  silently manage the overflow.
- Unsupported mints are received-but-not-credited-to-managed-capital, with a
  recorded reason, and are returnable.

---

## 7. Withdrawals and redemptions

### 7.1 Be honest about liquidity

In a pooled vault with open positions, instantaneous full withdrawal is impossible.
Do not build a UI that implies otherwise. Build a **redemption cycle**:

```
REQUESTED → struck at next NAV point (unit price fixed here)
          → liquidation if cash insufficient
          → SETTLED (Treasury co-sign)
          → CLAIMABLE (client claims to registered address)
```

Publish the cycle cadence (e.g. daily strike, T+1 or T+2 settlement) and the notice
period in the client agreement and the dashboard. The unit price is struck at the
cycle point *after* the request, never at request time — otherwise clients can
arbitrage the NAV.

### 7.2 Controls

- Destination is the client's registered withdrawal address, enforced on-chain.
  Changing it requires the timelock in §4.3 plus notification to the client.
- Operators cannot alter a client balance directly. Any adjustment is a posted,
  signed, reason-coded ledger entry, dual-authorised, visible to the client.
- Large redemptions (configurable threshold, or >X% of NAV) require Treasury review.
- Full audit chain from request through on-chain signature.
- Document gating/queueing policy for the case where redemptions exceed available
  liquidity — pro-rata gating is standard; whatever you choose, it must be in the
  client agreement *before* it is ever used.

---

## 8. Signals and risk engine

### 8.1 Signal

```
signal_id, expert_id, action (BUY|SELL|SET_ALLOCATION|CLOSE),
target_mint, size_spec, created_at, expires_at,
max_slippage_bps, max_price_impact_bps, constraints, status
```

`size_spec` is explicit and relative: `{pct_of_nav: 5}`, `{pct_of_position: 20}`,
`{target_allocation_pct: 10}`, or `{close: true}`. There is no "all available
capital" option. Tokens are identified by **mint address only** — never symbol.

Validation before queueing: signal exists, expert active and not paused, not
expired, not cancelled, mint on allowlist, action supported, params in range,
vault not paused, sufficient balance, risk permits.

### 8.2 Risk engine — atomic reservation

~100 vaults and N workers means naive read-check-write lets concurrent workers
breach shared caps. Required pattern:

1. `RESERVE` — atomically decrement available headroom (Postgres `SELECT … FOR
   UPDATE` on the risk row, or a Redis Lua script; pick one and be consistent).
2. Execute.
3. `COMMIT` on confirmation, or `RELEASE` on failure/timeout.
4. Reservations expire on a timer so a crashed worker cannot permanently strand
   headroom.

Reservations are an optimisation and a UX guarantee. **The on-chain counter in
`execute_trade` is the authoritative limit.** Both layers exist deliberately.

Configurable limits: max position size (% NAV), max trade notional, max daily
traded notional, max concentration per mint, max slippage, max price impact,
min liquidity depth for the target mint.

---

## 9. Execution pipeline

`validate → reserve risk → quote → build → simulate → final policy check → sign →
submit → confirm → reconcile → update NAV`.

- RPC: multiple providers, health-checked, automatic failover, separate endpoints
  for reads and sends.
- Blockhash refresh; explicit compute-budget and priority-fee strategy driven by
  observed network conditions.
- Simulation is not a guarantee. Re-run the policy check immediately before
  broadcast against fresh state.
- Retries only when idempotency is provably intact — the `ExecutedSignal` PDA makes
  this safe, but confirm status before any resubmit. On uncertain failure,
  **reconcile first, retry second, never the reverse.**
- Dead-letter queue for jobs that exhaust retries, with an operator runbook.

---

## 10. Reconciliation

A dedicated service comparing, on a schedule and after every execution batch:

on-chain token balances ⟷ internal position ledger ⟷ NAV/unit accounting

Discrepancy beyond a tight tolerance → alert, and **auto-pause trading** if it
exceeds a hard threshold. Never silently self-correct. Every correction is a
reviewed, signed, reason-coded journal entry. Trading resumes only after a human
clears the break.

Also reconcile: `sum(client.units) == total_units`, and every confirmed on-chain
transaction has a matching internal record and vice versa (orphan detection both
directions).

---

## 11. Pricing and valuation

- Use **Pyth** (or equivalent oracle) as primary for NAV valuation. Reject stale
  prices and prices with a confidence interval wider than a configured band.
- Never use a single DEX spot price for NAV — it is manipulable, and NAV drives unit
  price, which drives what clients receive.
- Never accept a price supplied by an expert.
- Define fallback ordering and behaviour when no acceptable price exists for a held
  asset: mark it `UNPRICEABLE`, exclude from tradable NAV, alert, and surface it on
  both dashboards. Do not guess a price.
- Document the valuation methodology in `docs/valuation.md`. It must be stable and
  disclosed — changing it silently changes everyone's balance.

---

## 12. Concurrency

Durable queue (BullMQ/Redis or Postgres-backed), worker pool, per-vault
serialisation key so two signals never mutate one vault's state concurrently,
persistent execution state machine, idempotency at DB and chain layers, retry and
dead-letter queues, graceful shutdown that does not orphan in-flight submissions.

Target: all ~100 vaults processed concurrently, measured in staging. Track
signal→submit latency at p50/p95/p99 and optimise against measurements rather than
promising a settlement time you cannot control.

---

## 13. API and dashboards

Follow the endpoint structure in the brief (§29/§47 equivalents). Additional
requirements:

- Client dashboard must visually separate **deposited principal**, **current
  value**, **P&L**, **fees accrued**, and **units held**. Show the current unit
  price and its history. Show pending redemptions and their cycle status. Show
  unmanaged excess above the $1M cap.
- Show the client their registered withdrawal address and any pending change to it.
- Admin dashboard: total AUM, per-client NAV, exposure by mint, reconciliation
  status (green/break), risk violations, pending redemptions, pause states, failed
  transactions, oracle health.
- All sensitive admin actions: strong auth, dual control where funds move, logged
  immutably.

---

## 14. Observability and audit

Structured logs, metrics, traces. Alert on: reconciliation break, oracle staleness,
NAV move outside sanity band, realized slippage anomaly, RPC degradation, queue
backlog, failure-rate spike, redemption backlog, any pause event, any allowlist
change, any withdrawal-address change.

Append-only audit log for every event in the brief's §24 list. Every trade retains
its Solana signature. Every ledger mutation records actor, reason, before/after.
The audit log must be able to answer, for any client at any past timestamp: what
were their units, what was the unit price, and what did they own.

---

## 15. Threat model

Produce `docs/threat-model.md` covering at minimum: compromised expert account,
compromised backend, compromised admin, compromised trader key, compromised
Treasury quorum, malicious token, malicious DEX/route, oracle manipulation, NAV
manipulation by insider, replay, duplicate execution, RPC compromise, database
compromise, withdrawal fraud, insider abuse, social engineering of a client's
withdrawal address.

For each: attack path, blast radius, on-chain mitigation, off-chain mitigation,
detection signal, response runbook. Assume every off-chain component is eventually
compromised and state what the on-chain program still guarantees in that world.

---

## 16. Repository structure

```
/programs/trading-vault          Anchor program (Rust)
/apps/api                        Client + admin + expert API
/apps/worker                     Execution workers
/apps/deposit-monitor            Deposit detection + attribution
/apps/reconciler                 Reconciliation service
/apps/nav-engine                 Valuation + unit pricing + fee accrual
/apps/web                        Next.js dashboards
/packages/solana                 RPC, tx building, signing client
/packages/risk-engine
/packages/accounting             Unit ledger — no floats, heavily tested
/packages/pricing                Oracle adapters
/packages/routing                DEX adapters behind one interface
/packages/types /packages/config
/tests/unit /integration /e2e /security
/docs
```

Docs required before Phase 16: architecture, on-chain invariants, accounting,
valuation, key-management, threat-model, runbook, db-schema, api, compliance-questions.

Stack: Anchor/Rust on-chain, TypeScript/Node backend, PostgreSQL, durable queue,
Next.js frontend. Change any of these only with a written justification.

---

## 17. Build phases and acceptance gates

| Phase | Deliverable | Gate |
|---|---|---|
| 1 | Architecture docs, threat model draft, DB schema, on-chain invariants, accounting model, compliance-questions.md | Human review of design docs. **No app code yet.** |
| 2 | Anchor program: accounts, instructions, allowlists, pause, replay | Program tests pass incl. negative cases |
| 3 | Client registry + unit ledger | §5.2 example passes; property tests on invariants |
| 4 | Deposit path (instruction + per-client PDA + unattributed bucket) | Double-credit impossible under fuzz |
| 5 | NAV engine, fee accrual, unit pricing | NAV reconciles to chain; no float in path |
| 6 | Signal service + validation | Invalid signals rejected with reason codes |
| 7 | Risk engine with reservation/commit | Concurrency test: N workers cannot breach caps |
| 8 | Routing + transaction engine | Pre/post balance assertions hold vs hostile mock route |
| 9 | Worker pool | 100 vaults concurrently in staging; crash/restart no duplicates |
| 10 | Redemption cycle | Full request→claim audit chain; operator cannot alter balance |
| 11 | Dashboards | Principal/value/P&L visually distinct |
| 12 | Observability + audit | Every §14 alert fires in drill |
| 13 | Security testing | Fuzz, property tests, adversarial suite |
| 14 | Devnet | End-to-end with synthetic clients |
| 15 | Staging, controlled capital | Sustained run; reconciliation clean |
| 16 | Production | **Independent security review AND legal/compliance sign-off** |

---

## 18. Test strategy

- **Property tests on accounting.** `sum(units) == total_units` under random
  interleavings of deposit/redeem/trade/fee-accrual. Units never created without a
  deposit. Rounding never leaks value out of the pool.
- **Adversarial program tests.** Non-allowlisted mint → reject. Non-allowlisted
  program → reject. Trader key attempting withdrawal → reject. Replayed signal →
  reject. Cap breach → reject. Paused → reject. Malicious route that drains a
  second token account → caught by post-balance assertion.
- **Concurrency tests.** Parallel workers against shared caps; verify no breach at
  both the reservation layer and the on-chain counter.
- **Failure injection.** RPC death mid-submit, worker SIGKILL after submit before
  confirm, oracle staleness, duplicate deposit signature, partial fills.
- **Reconciliation tests.** Inject a deliberate break; verify alert + auto-pause and
  that nothing self-corrects.

---

## 19. Decisions to surface, not guess

Claude Code must ask rather than assume: fee model and rates; redemption cycle
cadence and notice period; gating policy; which DEX/aggregator programs to allowlist;
initial mint allowlist; specific risk limit values; NAV sanity band width; dead-man's
switch duration and whether it is included; KYC/AML provider; client jurisdictions;
signing/KMS provider; multisig quorum and holders.

Where a decision is missing, implement behind a config interface with a conservative
default and flag it in `docs/open-decisions.md`. Never invent a number and let it
silently become production policy.

---

**Final note for the implementer.** The tightest constraints in this document —
role separation, on-chain enforcement, unitized accounting, the dead-man's switch,
the reconciliation auto-pause — are the parts that protect the operator as much as
the client. If a shortcut is proposed in any of those areas, that is where to push
back hardest.
