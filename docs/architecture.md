# Architecture

Status: Phase 1 draft. Companion to `CLAUDE-CODE-SPEC.md` (hereafter "the spec").
This document assumes the reader has read the spec; it does not restate rationale
already given there except where needed to explain a design choice.

## 0. An assumption this document depends on — flagged, not silently resolved

**The spec is internally inconsistent about how many "vaults" exist, and this
document had to pick an interpretation to be able to draw a diagram at all.**

- §1.1 and §5 describe **one pool**: "an autonomous engine executes those signals
  against **the pooled managed capital**," and §5.2's worked example has clients A
  and B sharing a single `unit_price` that only makes sense if they are co-owners
  of one NAV.
- §4.2's account sketch parameterizes `Vault` by `vault_id`, implying more than one
  can exist, but `ClientAccount` has a single scalar `units: u128` and a single
  `managed_cap_usd` — not `units` keyed by vault. That only type-checks if each
  client belongs to exactly one vault.
- §12 says "Target: all **~100 vaults** processed concurrently" — but §1.1 says
  ~100 **clients**. Read literally, §12 describes one vault per client, which is a
  *segregated-account* model, not a pooled one. A segregated model doesn't need
  unit accounting at all (§5 exists specifically to solve the problem of unequal
  entry/exit points into a *shared* pool); if each client had their own vault,
  §5.2's worked example would be nonsensical (A and B never share a unit price if
  they don't share a pool).

**Working assumption for this document and every other Phase 1 doc:** there is a
small, explicit set of named strategy vaults (initially **one**: `main`), each an
independent unitized pool per §5. Clients hold units in one vault. "100 vaults" in
§12 is treated as a leftover artifact of the prior non-custodial per-client-wallet
design referenced in §1.3, not current intent — a per-vault worker/locking
architecture is still built (see §6 below) so that adding a second strategy vault
later is a config change, not a rearchitecture. **This needs your confirmation —
see `docs/open-decisions.md` item OD-1.** If the actual intent is one vault per
client, most of this document, `docs/accounting.md`, and `docs/db-schema.md`
change shape, so resolve this before Phase 2.

## 1. Component inventory

| Component | Responsibility | Owns (source of truth for) | Trust level |
|---|---|---|---|
| **Anchor program** (`trading-vault`) | Enforces custody rules on-chain: allowlists, caps, pause, withdrawal destination, replay, unit conservation | Vault token accounts, `total_units`, `unit_price_scaled`, allowlists, pause flags, `ExecutedSignal` dedup records, `RedemptionRequest` state | Highest — the only component whose guarantees hold even if everything else is compromised |
| **Signer service** | Holds/brokers the Trader hot key (KMS/HSM/MPC); signs `execute_trade` transactions | Nothing durable — it is a policy gate + signing oracle | High — see §5, it is deliberately *not* a rubber stamp |
| **Signal Service + Validator** | Accepts expert signals, validates against schema/allowlist/expert status, enqueues | `signals` table (submitted intent, not truth of execution) | Medium |
| **Risk Engine** | Atomic reservation/commit against shared caps (§8.2 of spec) | `risk_reservations` table (soft, advisory cap headroom) | Medium |
| **Worker pool** | Executes the pipeline: quote → build → simulate → submit → confirm | In-flight execution state machine per signal | Medium |
| **Pricing/Oracle adapter** | Wraps Pyth (or equivalent); staleness/confidence filtering | Nothing durable — a read-through cache at most | Medium |
| **Routing/DEX adapter** | Builds CPI instructions for allowlisted DEX programs | Nothing | Low-trust by design — treated as hostile input, see on-chain-invariants.md §4.4 |
| **Reconciler** | Compares on-chain balances ⟷ internal ledger ⟷ NAV/unit accounting; auto-pauses on hard breach | `reconciliation_runs`, `reconciliation_breaks` | Medium — has real power (auto-pause) but no power to move funds or self-correct |
| **NAV Engine** | Computes NAV from priced positions + cash − liabilities − accrued fees; publishes to chain | `nav_snapshots`, `fee_accruals` (off-chain detail); the on-chain `unit_price_scaled` is authoritative once published | Medium |
| **Deposit Quote Engine** (pre-signature) | Enumerates a client's eligible assets (read-only RPC), prices them at a single oracle timestamp, computes headroom and a ranked suggested allocation (`docs/specs/allocation-spec.md`), deducts a SOL reserve, builds the unsigned transaction(s) for the client to review and sign | `deposit_quotes`, `deposit_quote_allocations` (advisory only — never a durable instruction to act on; see §3 below) | Low — every number it produces is advisory until the client signs; it has zero execution authority |
| **Deposit Submission Pipeline** (post-signature) | Submits exactly the transaction(s) the client signed, without re-deriving quantities; tracks per-transaction confirmation; credits the ledger only after finality | `deposit_batches`, `deposit_transactions`, `deposits` | Medium — same trust level as the rest of the worker pool; it cannot change what it submits, only whether/when |
| **Deposit monitor / sweeper** | Watches per-client deposit PDAs (secondary path), credits at next strike | `deposits`, `unattributed_deposits` | Medium |
| **API (client/admin/expert)** | AuthN/Z, presentation, request intake | Nothing accounting-relevant; a view over the above | Low — assume compromised, see threat-model.md |
| **Web dashboards** | Read-mostly presentation | Nothing | Low |
| **Postgres** | Durable off-chain state, audit log, idempotency keys | Everything not listed above as chain-owned | Medium — reconciled against chain continuously, never authoritative for balances |
| **Treasury multisig (Squads or equivalent)** | Approves redemption settlement, config/allowlist changes, program upgrades | Nothing directly; it is a signing authority | Highest, human-mediated |
| **Guardian key** | Pause only | Nothing | High for a single, narrow power |

## 2. Data flow: signal → execution → settlement

```
Expert ── HTTPS ──▶ API ──▶ Signal Service/Validator ──▶ Durable Queue (per-vault key)
                                                              │
                                                              ▼
                                                        Worker (claims job)
                                                              │
                                                    Risk Engine: RESERVE (Postgres FOR UPDATE
                                                    or Redis Lua — pick one, see open-decisions OD-2)
                                                              │
                                                    Oracle price fetch (staleness/CI checked)
                                                              │
                                                    Quote & Routing (allowlisted DEX adapter)
                                                              │
                                                    Transaction Builder ──▶ Simulation/Preflight
                                                              │
                                                    Signer service: INDEPENDENT policy re-check
                                                    (see §5) ──▶ signs with Trader key
                                                              │
                                                    Submit ──▶ Anchor program `execute_trade`
                                                    (init ExecutedSignal PDA = atomic dedup)
                                                              │
                                        ┌─────────────────────┼─────────────────────┐
                                        ▼                                           ▼
                              Confirmed on-chain                          Failed / dropped
                                        │                                           │
                              Risk Engine: COMMIT                          Risk Engine: RELEASE
                                        │                                  (or timer expiry)
                              Reconciler picks up next cycle
                                        │
                              NAV Engine recomputes on next
                              scheduled publish (§4.5 sanity band)
```

Two independent idempotency layers exist deliberately (spec §4.2, §9): the
Postgres unique constraint on `(vault_id, signal_id)` is the fast-path check a
worker does before spending RPC calls; the on-chain `ExecutedSignal` PDA `init`
constraint is the layer that is authoritative under concurrency, crash, or a
compromised worker, because Solana's runtime rejects the second `init` for the
same PDA atomically regardless of what the backend believes happened.

## 3. Data flow: deposit

### 3.1 Primary path — single explicit deposit authorization

The defining property, and the reason this is client-pushed rather than
transfer-monitored (spec §6.1's stated preference): **authority to move a
specific mint and exact quantity exists only inside the one transaction the
client signs, and does not survive it.** Nothing enumerated, quoted, or
suggested before that signature has any execution authority, and nothing is
resolved or recomputed at execution time — the signed instruction data is a
closed, explicit statement of mints and quantities.

```
PRE-SIGNATURE (read-only, advisory, no authority)
  Enumerate + filter eligible assets → price via oracle → apply the $1M
  headroom cap → rank and allocate a suggestion → compute SOL reserve →
  build unsigned transaction(s) → present to client.

  ══════ CLIENT SIGNS — authority begins and ends here ══════

POST-SIGNATURE (execution-authoritative)
  Submit exactly what was signed → record signatures → confirm to finality →
  credit the unit ledger → excess held, zero units → reconcile.
```

Assets are credited as **separate positions** — no conversion happens at
deposit time; a client depositing three different mints in one session ends
up with three position entries in the vault, and any later conversion
happens only as a trade, under normal risk controls, from a signal.

The secondary path (unique per-client deposit PDA + sweeper, for a plain
`spl-token transfer` outside the app flow) and the `UNATTRIBUTED` fallback
bucket are unchanged by this design and continue to coexist — they exist for
exactly the case the primary engine doesn't cover: a transfer that never went
through the quote/sign flow at all.

**Exactly how each step works — filtering rules, the allocation ranking,
SOL-reserve formula, multi-transaction atomicity, latency instrumentation,
and the quote-vs-execution headroom-authority resolution — is normatively
specified in `docs/specs/deposit-spec.md`, `docs/specs/allocation-spec.md`,
`docs/specs/reserve-spec.md`, and `docs/specs/excess-return-spec.md`.** This
document stays at the level of *why* the boundary exists and *what* it
guarantees; those documents pin down *exactly how*.

## 4. Data flow: redemption

```
Client ──▶ request_redemption ix ──▶ RedemptionRequest PDA (status: REQUESTED)
                                              │
                              Next scheduled strike point (NAV Engine)
                                              │
                                   struck_unit_price fixed on the PDA
                                              │
                              Liquidation if cash insufficient (worker pipeline,
                              same execute_trade path, SELL side)
                                              │
                                   Treasury co-signs `settle_redemption`
                                              │
                                   status: CLAIMABLE
                                              │
                              Client calls `claim_redemption` ──▶ tokens move
                              to the client's *registered* withdrawal address only
```

The unit price is struck **after** the request is queued, never at request time —
this is a spec requirement (§7.1) that prevents clients from timing NAV moves.

## 5. Trust boundaries

1. **Client device ⟷ platform.** Client controls only their own wallet and their
   registered withdrawal address. The platform never has signing authority over
   anything the client holds outside a deposit into the vault (hard prohibition,
   spec §1.2). This boundary is enforced entirely on-chain: the `deposit`
   instruction is client-signed, and nothing in the program design gives the
   backend a path to move tokens from a client-owned account it doesn't already
   hold via a completed deposit.

2. **Expert ⟷ backend.** An expert can only *submit signal intent* — action, mint,
   explicit relative size, expiry. An expert has no path to a key, no path to
   arbitrary instruction data, and no path to withdrawal. This boundary is
   enforced by the Signal Validator (schema + allowlist checks) and, more
   importantly, on-chain: `execute_trade` requires the Trader signer, which an
   expert never holds.

3. **Backend perimeter ⟷ Signer service.** This is the boundary that matters most
   and the one the spec's diagram underspecifies. See §5 below — the backend
   (API, workers, queue, Postgres) should be treated as **eventually compromised**
   (spec §15's framing), and the Signer service is the last checkpoint before a
   transaction gets a live signature. It must not trust the worker's claim that a
   trade is within policy; it must re-derive that itself from allowlist/cap state
   it reads independently.

4. **Signer service ⟷ Anchor program.** Even a fully compromised Signer that signs
   anything a worker asks is still bounded by the program: it can only produce a
   valid `execute_trade` if the program's own allowlist/cap/pause checks pass, and
   it can never produce a valid withdrawal (Trader key has no withdrawal
   authority at the instruction level — this is enforced by which accounts each
   instruction's `#[derive(Accounts)]` constraints require, not by convention).

5. **Program ⟷ upgrade authority.** The program's guarantees are only as strong as
   whoever can upgrade it. Per spec §3.2, upgrade authority sits behind the
   Treasury multisig plus a timelock. This is a trust boundary in its own right —
   document it in `custody-map.md` as a form of custody (control over the rules is
   a superset of control over the funds).

6. **Pre-signature advisory computation ⟷ post-signature execution (deposit
   authorization boundary).** The Deposit Quote Engine's enumeration, pricing,
   headroom, and suggested-allocation output carry no execution authority
   whatsoever — they exist to produce an unsigned transaction for the client to
   review. The only real control at this boundary is the client's own wallet
   correctly displaying what it's about to sign; the platform cannot make that
   guarantee, only avoid working against it (e.g., never obscuring instruction
   data, never batching in a way that makes review harder). See
   `threat-model.md` T17-T19 for what this boundary does and doesn't protect
   against.

7. **RPC providers ⟷ everything.** RPC is assumed byzantine-unreliable, not
   byzantine-malicious in the security sense (spec doesn't ask us to defend
   against a malicious RPC forging confirmations, and doing so is hard — Solana's
   trust model already assumes you talk to *a* validator you don't fully trust and
   verify via signatures/state roots). Multiple providers with failover (spec §9)
   is a reliability boundary, not primarily a security one. Flagged in
   threat-model.md under "RPC compromise" with that distinction made explicit.

## 6. Concurrency architecture (ownership of in-flight state)

Per-vault serialization key on the durable queue means two signals targeting the
same vault never execute concurrently from the backend's perspective — this is
what makes the risk-engine reservation pattern (spec §8.2) sound. Cross-vault
concurrency is real and required (spec's "~100 vaults processed concurrently"
target, however that number resolves per §0 above): the queue, worker pool, and
risk engine are all designed to scale horizontally across vaults, just not within
one vault's own signal stream.

## 7. Where this document extends the spec

- **Independent policy re-check at the Signer boundary (§5.3 above).** The spec's
  pipeline diagram (§2, §9) shows Signer as a pipeline stage after Simulation, which
  could be read as "sign whatever preflight approved." Recommendation: the Signer
  service holds its own read-only copy of allowlist/cap/pause state (or queries the
  program's own accounts directly, not the backend's cache) and refuses to sign
  anything that fails that independent check, even if every upstream stage
  approved it. This costs one extra state read per trade and closes the gap where
  a compromised worker + a compromised transaction builder could otherwise get a
  technically-signable-but-policy-violating transaction in front of the Signer.
  The on-chain program is still the final backstop regardless, but a Signer that
  never signs bad transactions in the first place produces fewer failed/wasted
  submissions and fewer alert-fatigue events.

  **Open question this recommendation raises, not yet resolved:** if this
  independent check is built to include re-deriving the expected deposit
  allocation (not just trade policy), it would need its own implementation of
  the comparator specified in `docs/specs/comparator-spec.md` §8 — and if
  that service is written in Rust, it becomes the second implementation the
  comparator's "byte-identical Rust and TypeScript" requirement is actually
  about, which is also a stack deviation from spec §16 requiring explicit
  justification. See `open-decisions.md` OD-30.
