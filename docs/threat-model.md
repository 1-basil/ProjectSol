# Threat Model (Phase 1 draft)

Per spec §15. Baseline assumption for every entry below: **every off-chain
component is eventually compromised.** The question this document answers,
threat by threat, is what the on-chain program still guarantees when that`
happens, and what off-chain controls exist to detect and limit damage in the
meantime — not to pretend the compromise won't occur.

Severity/blast-radius scale used throughout: **Single-client**, **Bounded**
(capped by an explicit on-chain limit — a cap, a slippage bound, a pause), or
**Pool-wide** (can affect all clients' capital or the integrity of the ledger
itself).

---

## T1. Compromised expert account

- **Attack path:** Attacker obtains an expert's signing credential and submits
  malicious signals (e.g., BUY into an allowlisted-but-illiquid mint at max
  slippage, repeatedly).
- **Blast radius:** Bounded. An expert has no key, no withdrawal path, and no
  instruction access beyond submitting signal intent (architecture.md §5.2).
  Worst case equals the Trader-key residual risk in T4: value destruction within
  per-trade/per-day caps, not value exfiltration.
- **On-chain mitigation:** Mint/program allowlists, per-trade and rolling
  notional caps, slippage/min-out assertion — all enforced regardless of signal
  origin.
- **Off-chain mitigation:** Expert credential is separate from any funds-moving
  key; per-expert rate limits and anomaly detection on signal patterns; ability
  to pause a single expert (spec §4.3's expert-active check) without pausing the
  whole platform.
- **Detection signal:** Signal volume/size anomaly per expert; realized slippage
  anomaly; repeated signals into the same illiquid mint.
- **Response:** Pause the expert (`status: PAUSED`); Guardian pauses trading
  platform-wide if damage is already in progress; review and revoke credential;
  post-incident reconciliation.

## T2. Compromised backend (API, workers, queue, Signal Service)

- **Attack path:** Attacker gains code execution or credentials across the
  backend fleet — the baseline assumption this whole document is written under.
- **Blast radius:** Bounded, *provided* the Signer service holds the line (see
  architecture.md §5.3/§7). A fully compromised backend can submit arbitrary
  `execute_trade`-shaped requests to the Signer, but cannot construct a valid
  withdrawal (no withdrawal-authority key lives in the backend), cannot forge a
  deposit (deposit is client-signed), and cannot exceed on-chain caps.
- **On-chain mitigation:** All of §4.4's `execute_trade` checks; replay
  protection; role separation.
- **Off-chain mitigation:** Signer's independent policy re-check
  (architecture.md §5.3) so a compromised backend can't get a bad-but-technically
  loggable transaction signed just because upstream stages claimed it was fine;
  least-privilege between services; secrets never in backend-reachable plaintext
  (spec §3.3).
- **Detection signal:** Anomalous request volume/pattern to the Signer;
  reconciliation break; unexpected signal sources.
- **Response:** Guardian pause (fast, unilateral); rotate all backend
  credentials and the Signer's trust list; forensic review before unpause
  (which requires Treasury, a deliberately slow path).

## T3. Compromised admin account

- **Attack path:** Attacker phishes or otherwise obtains an admin dashboard
  credential.
- **Blast radius:** Single-client to moderate — an admin alone cannot move
  funds (dual control on any balance-adjacent action, spec §7.2) but can view
  PII, attempt to misattribute an unattributed deposit, or attempt a manual
  ledger adjustment that requires a second authorizer to take effect.
- **On-chain mitigation:** None directly — this is a pure off-chain identity
  threat; the mitigation is that the chain doesn't grant admin dashboards any
  signing authority at all.
- **Off-chain mitigation:** MFA required (schema: `admin_users.mfa_enabled`);
  dual authorization on `ledger_entries`/`admin_actions` for anything
  balance-adjacent; role-scoped permissions (`OPS`/`RISK`/`TREASURY_OPS`/
  `READONLY`); session/device anomaly detection.
- **Detection signal:** Login from new device/geo; attempted action outside a
  role's scope; a lone-authorizer attempt on a dual-control action (should be
  structurally impossible, but log the attempt).
- **Response:** Disable account, force credential rotation, audit every action
  taken under that session via `admin_actions`.

## T4. Compromised Trader key

- **Attack path:** Attacker obtains the Trader hot key (KMS/HSM/MPC compromise
  or Signer-service compromise).
- **Blast radius:** Bounded, but the most economically damaging *bounded*
  scenario in the system. Per spec §3.1, `execute_trade` cannot move funds out
  of the vault — it can only route into allowlisted DEX programs and must
  receive value back into vault-owned accounts. The honest residual risk: the
  attacker can trade repeatedly into an allowlisted-but-illiquid mint at maximum
  permitted slippage, destroying value within the daily notional cap, every day,
  until stopped.
- **On-chain mitigation:** Allowlists, per-trade/rolling-daily caps, min-out
  assertion, pause.
- **Off-chain mitigation:** Tight allowlist curation (liquidity-vetted mints
  only); realized-slippage anomaly alerting with a low threshold; **guardian
  auto-pause on threshold breach** (spec §3.1) — this should be an automated
  trigger, not a human-in-the-loop step, given the attack repeats daily if
  unaddressed.
- **Detection signal:** Realized slippage per trade / per day exceeding
  historical baseline; notional cap being hit repeatedly at the maximum; trades
  concentrating into a single low-liquidity mint.
- **Response:** Immediate guardian pause; rotate/revoke the Trader key in KMS;
  do not unpause until root cause is found (Treasury-gated by design).

## T5. Compromised Treasury quorum

- **Attack path:** Attacker compromises enough of the m-of-n Treasury signers to
  reach quorum.
- **Blast radius:** Pool-wide. This is the second-highest-severity entry in the
  system (after program-upgrade compromise, see custody-map.md C12). A
  compromised quorum can approve fraudulent config changes, allowlist edits, or
  redemption settlements, and — critically — can also approve a withdrawal
  address change, at which point it *can* redirect that client's future
  redemptions to an attacker-controlled address (custody-map.md C7).
- **On-chain mitigation:** m-of-n structure itself (a single compromised signer
  is insufficient); withdrawal-address changes still require the timelock even
  with Treasury involved in unrelated approvals, so a client has a window to
  notice a change they didn't request; program upgrade requires Treasury *plus*
  a separate timelock.
- **Off-chain mitigation:** Geographically/organizationally separated holders,
  hardware keys, no single individual holding two of the n keys; out-of-band
  confirmation with the client for any withdrawal-address change (not just the
  on-chain notification) — recommended addition, see open-decisions.md.
- **Detection signal:** Config/allowlist change outside change-management
  process; withdrawal-address change without a matching client-initiated support
  ticket; unusual settlement pattern.
- **Response:** This is the scenario the dead-man's switch (spec §4.6) exists
  to bound in the *total-abandonment* case, but a still-operating malicious
  quorum is worse than abandonment. There is no purely technical response here
  beyond alerting and client notification — this is fundamentally a governance
  and key-ceremony problem, which is why holder selection and quorum size
  (open-decisions.md OD-12) matter as much as any code in this repository.

## T6. Malicious or defective token (mint)

- **Attack path:** An allowlisted mint turns out to have a malicious transfer
  hook, a freeze authority the platform doesn't control, or some other
  token-2022 extension behavior that violates the "it's just a balance" mental
  model `execute_trade`'s pre/post-balance checks assume.
- **Blast radius:** Bounded to that mint's position size, potentially larger if
  the malicious behavior can affect *other* token accounts in the same
  transaction (this is exactly what the post-balance "no other account
  decreased" assertion is designed to catch — spec §4.4 step 7).
- **On-chain mitigation:** Allowlist is the primary control; the post-balance
  assertion catches an unexpected balance change even from an allowlisted mint's
  own weird behavior.
- **Off-chain mitigation:** Allowlist review process must inspect mint/token
  program extensions (freeze authority, transfer hooks, transfer fees) before
  approval, not just liquidity; Token-2022 extensions are a specific, named
  review checklist item, not implicit.
- **Detection signal:** Unexpected balance delta on a supposedly-uninvolved
  token account (caught structurally, transaction fails); support reports of
  frozen balances.
- **Response:** Remove mint from allowlist (Treasury); if funds are already
  stuck due to a freeze authority the platform doesn't hold, this becomes a
  legal/recovery problem outside engineering's control — a reason to be
  conservative about allowlist criteria from day one.
- **Related, distinct attack path:** rather than an allowlisted mint turning
  out to be bad, an attacker who compromises enough of the Treasury quorum (T5)
  to write to the allowlist can make a *worthless* token appear as a
  legitimate deposit or trading option in the first place. This makes
  allowlist write access itself a fund-loss vector, not merely a config
  surface — a client who deposits into a fraudulently-allowlisted mint has
  real capital in a token the platform never should have accepted. The
  mitigation is the same Treasury quorum/timelock discipline as T5, plus the
  allowlist-review checklist (`open-decisions.md` OD-6/OD-27) actually being
  enforced as a gate, not a formality.

## T7. Malicious or buggy DEX/route

- **Attack path:** An allowlisted router program is compromised, upgraded
  maliciously, or simply has a bug that returns less than promised or drains an
  unrelated account during CPI.
- **Blast radius:** Bounded by the min-out assertion and the "no other vault
  account decreased" check — this is precisely the scenario spec §4.4 step 7
  exists for.
- **On-chain mitigation:** Program allowlist; pre/post balance assertions;
  min-out/max-in bounds.
- **Off-chain mitigation:** Prefer routers with their own upgrade timelocks and
  established audit history for allowlist inclusion; monitor allowlisted
  programs for upgrade events and re-review on any upgrade.
- **Detection signal:** Trade failing the post-balance assertion (transaction
  simply fails on-chain — this is a successful defense, but should still alert
  loudly since it means an allowlisted dependency turned hostile or buggy);
  execution price persistently worse than oracle-implied fair value.
- **Response:** Remove program from allowlist immediately; pause trading if
  the same router is used broadly; post-mortem before re-allowlisting anything
  from the same upgrade authority.

## T8. Oracle manipulation

- **Attack path:** The price oracle (Pyth or equivalent) is manipulated,
  stale, or returns a low-confidence price that gets used anyway.
- **Blast radius:** Pool-wide if it affects `publish_nav` (mis-prices every
  client's units simultaneously); bounded if it only affects a single
  `execute_trade`'s cap/sizing computation.
- **On-chain mitigation:** Staleness check, confidence-interval band check on
  every oracle read (both in `execute_trade` and implicitly feeding
  `publish_nav`); NAV sanity band bounds how far a single bad publish can move
  unit price without Treasury co-sign.
- **Off-chain mitigation:** Use a decentralized oracle (not a single
  self-hosted feed) as spec §11 already requires; never accept an
  expert-supplied price (explicit hard requirement, spec §11); define and honor
  `UNPRICEABLE` handling for assets with no acceptable price rather than
  guessing.
- **Detection signal:** Oracle staleness/confidence alerts (spec §14); NAV
  publish rejected by the sanity band; divergence between oracle price and
  observed DEX price beyond a threshold.
- **Response:** Reject the price (automatic, on-chain); if persistent, pause
  trading for the affected mint or platform-wide; investigate oracle health
  with the provider.

## T9. NAV manipulation by insider

- **Attack path:** Someone with access to the NAV Engine's inputs or publish
  path pushes a favorable-to-them NAV (e.g., inflate NAV right before their own
  redemption is struck, or right before a performance-fee crystallization).
- **Blast radius:** Bounded per publish by the sanity band; pool-wide in
  cumulative effect if repeated small manipulations go undetected over time
  (the sanity band bounds *each* move, not the *sum* of many small moves in one
  direction).
- **On-chain mitigation:** `publish_nav` sanity band (spec §4.5); publish
  requires the backend's signer, and unusual moves require Treasury co-sign,
  creating a second set of eyes on exactly the transactions most worth
  scrutinizing.
- **Off-chain mitigation:** NAV computation should be reproducible/auditable
  from `positions` + `oracle_price_snapshots` + `fee_accruals` independent of
  the publisher's say-so; reconciliation compares the published NAV against an
  independently recomputed NAV every cycle, not just against on-chain balances;
  a persistent one-directional drift (even within-band each time) should itself
  be a detection signal, not just single-publish outliers.
- **Detection signal:** Reconciliation break between recomputed and published
  NAV; NAV moves correlating suspiciously with large redemption or
  crystallization events; repeated near-band-limit publishes in the same
  direction.
- **Response:** Auto-pause on hard reconciliation breach (spec §10); manual
  review of the NAV Engine's inputs and the publisher's access; no
  self-correction — any fix is a reviewed, signed, reason-coded journal entry.

## T10. Replay (of a signal or a transaction)

- **Attack path:** An old, already-executed signal or transaction is
  resubmitted, intentionally or via a retry bug.
- **Blast radius:** None, by design — this is the threat the architecture is
  most directly built to eliminate structurally rather than merely mitigate.
- **On-chain mitigation:** `ExecutedSignal` PDA `init` constraint — atomic,
  authoritative, holds regardless of backend state (on-chain-invariants.md §1).
- **Off-chain mitigation:** Postgres unique constraints
  (`executed_signals`, `deposits`, `trades`) as a fast-path that avoids wasted
  RPC round-trips; retries only attempted when idempotency is provably intact,
  and reconciliation happens before retry, never after (spec §9).
- **Detection signal:** A rejected duplicate `init` on-chain (should be logged,
  not just silently absorbed, since a legitimate retry hitting this path
  frequently indicates a backend bug worth fixing).
- **Response:** None needed for correctness; investigate if frequency is high
  (indicates retry logic is too aggressive or confirmation-checking is broken).

## T11. Duplicate execution (two workers race the same signal)

- **Attack path:** Not malicious — a concurrency bug where two workers pick up
  the same signal and both attempt to execute it.
- **Blast radius:** None, by design — same structural defense as T10. This is
  listed separately because the *cause* differs (concurrency bug vs. replay
  attack) even though the defense is identical.
- **On-chain mitigation:** Same `ExecutedSignal` PDA `init` atomicity — this is
  exactly the race condition it exists to close (spec §4.2's stated rationale).
- **Off-chain mitigation:** Per-vault serialization key on the queue reduces
  how often this is even attempted; risk-engine reservation (`FOR UPDATE`/Lua)
  prevents both workers from believing they have headroom simultaneously.
- **Detection signal:** Two workers both reaching the submit stage for the same
  `signal_id` (should be rare given the serialization key; a high rate
  indicates the queue's per-vault locking isn't working).
- **Response:** One submission succeeds, one fails the `init` and is treated as
  a normal execution failure (release reservation, no retry needed since the
  signal is in fact executed).

## T12. RPC compromise / unreliability

- **Attack path:** An RPC provider returns stale, incomplete, or (in the worst
  case) actively false data — e.g., a fabricated "confirmed" status for a
  transaction that never landed.
- **Blast radius:** Bounded to operational/availability impact for ordinary
  unreliability; a genuinely malicious RPC forging confirmation status could
  cause the backend to believe an execution succeeded (or a redemption settled)
  when it didn't, leading to ledger drift — this is caught by reconciliation
  against a *second*, independent RPC/provider before it becomes a client-facing
  problem.
- **On-chain mitigation:** None directly — RPC is a read/submit transport, not
  part of the trust boundary the program can enforce anything about.
- **Off-chain mitigation:** Multiple providers, health-checked, automatic
  failover, separate endpoints for reads vs. sends (spec §9); reconciliation
  cross-checks state against more than one provider rather than trusting
  whichever one answered a given request.
- **Detection signal:** Divergence between providers on the same query;
  confirmation status flapping; elevated error/timeout rate from one provider.
- **Response:** Failover automatically; if divergence is detected, treat as a
  reconciliation break, not a routine retry, until resolved.

## T13. Database (Postgres) compromise

- **Attack path:** Attacker gains read or write access to the primary
  database.
- **Blast radius:** Read compromise: pool-wide PII/financial-detail exposure
  (serious, but not a funds-movement threat). Write compromise: could corrupt
  the off-chain ledger, but **cannot** move on-chain funds or mint/burn real
  units, because Postgres is never authoritative for either — reconciliation
  against chain state will surface the divergence.
- **On-chain mitigation:** None directly needed — this is precisely why the
  chain, not the database, is authoritative for balances and unit counts.
- **Off-chain mitigation:** Encryption at rest, least-privilege DB roles
  (application role cannot `UPDATE`/`DELETE` append-only tables), network
  isolation, backups tested for restore; reconciliation runs against on-chain
  state independent of whatever the database currently claims.
- **Detection signal:** Reconciliation break (ledger vs. chain divergence);
  unexpected schema/data changes outside migration tooling; anomalous query
  patterns.
- **Response:** Auto-pause on hard reconciliation breach; restore from a known-
  good backup and replay confirmed on-chain events to rebuild ledger state if
  corruption is confirmed; rotate DB credentials.

## T14. Withdrawal fraud

- **Attack path:** Any attempt to route a client's redemption to an address the
  client did not register, via any combination of the above compromises.
- **Blast radius:** Single-client, structurally — every withdrawal-shaped
  instruction resolves its destination from `ClientAccount.registered_withdrawal_addr`,
  which itself can only change through the timelocked, notified process
  (custody-map.md C7). This is the threat every other row in this document
  ultimately funnels into, which is why the withdrawal-address timelock is one
  of the highest-leverage single controls in the system.
- **On-chain mitigation:** Destination-address derivation from `ClientAccount`,
  not instruction-supplied data; timelock + notification on any change.
- **Off-chain mitigation:** Out-of-band confirmation for address changes
  (recommended addition, open-decisions.md); large-redemption Treasury review
  threshold (spec §7.2).
- **Detection signal:** Withdrawal-address change without a corresponding
  support interaction; redemption to a newly-registered address shortly after
  a change; client-reported "I didn't request this."
- **Response:** Client can, in principle, notice and act within the timelock
  window before it takes effect — the process must make this realistic (clear,
  urgent notification, not a buried dashboard note); post-effective-date fraud
  requires the same investigation path as T5.

## T15. Insider abuse

- **Attack path:** Someone with legitimate access (developer, ops, an
  individual Treasury holder) uses it beyond their authorized scope — e.g., an
  engineer with database access manually crafts a ledger entry, or a single
  Treasury holder attempts to act alone.
- **Blast radius:** Bounded by the same dual-control and multisig structures
  used against external compromise — insider abuse is treated identically to
  compromise for control-design purposes, per this document's baseline
  assumption.
- **On-chain mitigation:** m-of-n Treasury quorum (a single insider cannot act
  alone); role separation at the instruction level.
- **Off-chain mitigation:** Dual authorization on manual ledger entries; every
  admin action attributed and immutable (`admin_actions`); least-privilege
  database roles (an engineer with prod DB read access should not, by default,
  have write access to accounting tables); background checks / access review
  cadence for anyone holding a Treasury key.
- **Detection signal:** Any manual `ledger_entries` row (should be rare enough
  that each one is individually reviewable); access outside role scope.
- **Response:** Immediate access revocation; full audit trail review of that
  actor's history; this is also fundamentally an HR/governance control, not
  purely a technical one.

## T16. Social engineering of a client's withdrawal address

- **Attack path:** Attacker impersonates the platform (or the client) to
  convince a client to request a withdrawal-address change to an
  attacker-controlled address, or convinces support staff to initiate one.
- **Blast radius:** Single-client, bounded by the same timelock as T14 — the
  defense here is specifically that the timelock creates a window for the
  *real* client to notice a change they didn't actually initiate, which is the
  scenario social engineering produces (the request itself may look legitimate
  to the system; the client is the one who can tell it's fraudulent).
- **On-chain mitigation:** Timelock on the change taking effect.
- **Off-chain mitigation:** Notification through a channel the attacker doesn't
  control (not just an in-dashboard notice — email/SMS to the client's
  on-file, out-of-band contact); support-initiated changes should require
  additional identity verification beyond whatever the attacker just used to
  convince support; consider requiring the change request itself to be
  client-signed on-chain (per spec's `request_withdrawal_address_change`
  instruction) rather than ever accepting a support-ticket-initiated change —
  recommended as the *only* path, with support only able to answer questions,
  never initiate the change (open-decisions.md addition).
- **Detection signal:** Client contacting support about a change they didn't
  request; unusual pattern of support-assisted address changes.
- **Response:** Cancel the pending change if still within the timelock window;
  if already effective, this becomes a T14 investigation.

---

## Deposit-authorization boundary (T17-T21)

These five are additional to the spec §15 list, surfaced by the onboarding /
single-explicit-deposit-authorization design (`architecture.md` §3). They
share a common theme: the pre-signature side of a deposit (enumeration,
pricing, allocation suggestion, SOL-reserve computation, asset filtering) has
**no execution authority** by design, which is the whole point of the model —
but it means the *quality* of what gets proposed to the client for signature
is a backend-honesty question, not something the chain can verify, in exactly
the same way NAV composition is (`on-chain-invariants.md` §2).

### T17. Blind-signing gap — a compromised Deposit Quote Engine proposes a transaction the client didn't intend

- **Attack path:** The Quote Engine (compromised or buggy) builds an unsigned
  transaction whose actual instruction data doesn't match what the UI
  displayed — e.g., a larger quantity, an extra mint, or a different mint than
  shown.
- **Blast radius:** Single-client, and bounded further because a deposit
  instruction can only ever move funds *into* the vault, never out or
  elsewhere (hard prohibition, spec §1.2) — the worst case is a client
  depositing more or different assets than they meant to, not losing funds to
  an outside address. Still a real trust violation and a support/legal
  problem, not a "no harm done" outcome.
- **On-chain mitigation:** None directly — the chain faithfully executes
  whatever valid, signed instruction it receives; it has no concept of "what
  the UI showed."
- **Off-chain mitigation:** The client's own wallet transaction-review UI is
  the actual control here, and the platform doesn't control it — the
  platform's obligation is to not work against it: never construct
  intentionally opaque instruction data, prefer standard, simulatable
  instruction shapes so wallets can render an accurate balance-change preview,
  and keep the signed transaction's contents identical to what was quoted
  (step 8's "submit exactly what was signed, never re-derive quantities" is
  itself a mitigation for a related but distinct failure — see T19).
- **Detection signal:** Client dispute of a confirmed deposit's contents;
  divergence between `deposit_quotes.client_selected_allocation` and what was
  actually submitted.
- **Response:** Treat as a P1 support/security incident; audit the Quote
  Engine's build path; funds remain in the vault and are still the client's
  (per the unit ledger), so this is recoverable via normal ledger correction
  (dual-authorized, reason-coded) rather than a funds-recovery problem.

### T18. Stale-quote timing arbitrage

- **Attack path:** A client (or automated tooling acting on their behalf)
  deliberately delays signing a favorable quote, waiting for oracle price or
  headroom conditions to move in their favor before submitting, effectively
  getting a free option on price movement between quote and execution.
- **Blast radius:** Bounded and small per-instance (limited by how much price
  can move in the delay window), but could be systematically exploited at
  scale if the staleness window is too generous.
- **On-chain mitigation:** None directly — pricing at execution time is
  legitimate oracle behavior, not a bug; this is a UX-policy threat, not a
  chain-integrity one.
- **Off-chain mitigation:** `quote_staleness_seconds` invalidates a quote that
  wasn't signed promptly, forcing a re-quote against current conditions
  (`docs/specs/deposit-spec.md` §7) — this is the primary control, and its value is
  therefore a real risk parameter, not just a latency nicety.
- **Detection signal:** Unusual delay-to-signature patterns concentrated
  around volatile price movements; repeated re-quote cycles from the same
  client.
- **Response:** Tighten `quote_staleness_seconds` (`open-decisions.md` OD-22)
  if exploitation is observed; this is a tuning response, not an incident
  response, unless volume suggests coordinated abuse.

### T19. Partial multi-transaction deposit dispute

- **Attack path:** Not necessarily adversarial — in a multi-transaction batch,
  some transactions confirm and others fail or are dropped. A client could
  later dispute what they actually sent or received credit for, or a bug
  could cause the batch's status bookkeeping to disagree with on-chain reality.
- **Blast radius:** Single-client, bounded to that batch's contents.
- **On-chain mitigation:** Each transaction's confirmation status is itself
  the ground truth (Solana's own finality); nothing here relies on backend
  bookkeeping being correct to determine what actually happened on-chain, only
  to *present* it correctly.
- **Off-chain mitigation:** `deposit_transactions` records every submission
  attempt with its own signature and status independent of the parent batch's
  rolled-up status; credit exactly what confirmed, never intent
  (`docs/specs/deposit-spec.md` §3); full signature-level audit trail for dispute
  resolution.
- **Detection signal:** Reconciliation between `deposit_batches`/
  `deposit_transactions` status and actual on-chain confirmation for every
  signature in the batch.
- **Response:** Resolve from signatures, not from batch-status labels — the
  labels are a UX summary of the signatures, never the other way around.

### T20. SOL-reserve ceiling bypassed via a crafted request

- **Attack path:** A client (or a modified client bypassing the normal UI)
  submits a deposit-build request specifying a SOL quantity greater than the
  quote's computed `offered_sol_lamports` ceiling, attempting to strand
  themselves without transaction funds, or probing for a validation gap.
- **Blast radius:** Single-client if successful (leaves that client unable to
  pay their own future transaction fees, including a withdrawal — treated as a
  system failure per `docs/specs/reserve-spec.md` §2, not an acceptable outcome even if the
  client requested it themselves, since a client requesting it likely doesn't
  understand the consequence).
- **On-chain mitigation:** None — this is purely a backend input-validation
  question; the chain has no concept of "offered ceiling," only the exact
  quantity in the signed instruction.
- **Off-chain mitigation:** Server-side rejection (not clamping) of any
  selected SOL quantity exceeding `offered_sol_lamports`, applied to every
  caller of the transaction-build endpoint, not just the reference UI
  (`db-schema.md`'s "Additional integrity constraints" section); alert if any
  client's post-deposit wallet SOL nonetheless falls below `min_sol_reserve` —
  that indicates this control failed, not that the client made a bad choice.
- **Detection signal:** Rejected requests exceeding the ceiling (expected,
  low-frequency, informative if it spikes); post-deposit wallet-SOL-below-
  reserve alert firing (should never fire if the control works).
- **Response:** If the alert fires, treat as a bug in the reserve calculation
  or its enforcement, not a client-support ticket — fix the calculation, and
  proactively check whether other clients were affected by the same bug
  window.

### T21. Filtered/scam-mint data exposure via the enumeration API

- **Attack path:** An attacker probes the deposit-enumeration API to recover
  the platform's filtered-mint list, reason codes, or scam-mint intelligence
  — either to map the allowlist/filter logic or to identify which of their own
  scam mints have been detected.
- **Blast radius:** No funds at risk directly; the risk is intelligence
  leakage that could help an attacker route around the filter (e.g., learning
  exactly which heuristic flagged a mint and adjusting a future scam token to
  evade it) or identify which wallets hold flagged assets.
- **On-chain mitigation:** None — this is an API-contract question.
- **Off-chain mitigation:** Filtering happens server-side before the
  client-facing payload is constructed (`docs/specs/deposit-spec.md` §4) — there is no
  filtered-mint data in any client-reachable response to recover, by
  construction, not by UI convention; `filtered_deposit_candidates`
  (`db-schema.md`) is never joined into a client-facing query, enforced as an
  explicit code-review checklist item; the one deliberate disclosure (the
  >5%-materiality line) is non-interactive and carries no identifiers.
- **Detection signal:** Anomalous enumeration-endpoint request patterns
  (repeated calls with varying wallet contents, consistent with probing);
  code-review or API-contract test catching an accidental join of
  `filtered_deposit_candidates` into a response.
- **Response:** Fix the leak path immediately if found (this would be a
  regression against an explicit design requirement, not a gray area);
  rate-limit/monitor the enumeration endpoint regardless as routine API
  hygiene.

---

## Summary: what holds under total off-chain compromise

Even if every item in the "off-chain mitigation" column above simultaneously
fails, the on-chain program still guarantees: funds leave the vault only into
an allowlisted DEX program (and must return to a vault-owned account) or to a
client's registered, timelocked withdrawal address; no signal or transaction
executes twice; per-trade and daily notional caps hold; NAV cannot move more
than the sanity band per publish without Treasury co-signature; units are
conserved and only created/destroyed by a real deposit or settled redemption;
and a unilateral pause is always available and requires no off-chain component
to be trustworthy to take effect. What it does *not* guarantee: that the
capital inside those bounds was used wisely, that the NAV publisher was honest
within the band, or that no client's redemption was fraudulently redirected
during an unnoticed timelock window. Those residual risks are named above, not
hidden, per the spec's own framing in §3.1 and §15.

The deposit-authorization boundary (T17-T21) adds one more honestly-stated
residual: the chain guarantees that a deposit instruction can only ever move
funds *into* the vault under the client's own signature, never out and never
more/different than what that signature actually authorizes — but it cannot
guarantee that what was proposed for signature accurately reflected the
client's intent. That gap is closed, to the extent it's closed at all, by the
client's own wallet review at signing time, not by anything the platform's
backend can prove about itself.
