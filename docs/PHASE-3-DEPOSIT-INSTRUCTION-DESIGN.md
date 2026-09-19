# On-Chain Deposit Instruction — Account/Instruction Interface Design

Design for `deposit`, written before implementation per instruction. Scope
is the **primary, client-pushed, instruction-based deposit path**
(`docs/specs/deposit-spec.md` §2, the path that spec prefers over transfer
monitoring). Redemption, trading, and any CPI routing are out of scope and
not designed here.

## 0. Shape decision: one instruction per mint

A multi-mint deposit is **N sequential `deposit` invocations, one per mint**,
not one instruction handling several transfers internally.

`PHASE-1-REVIEW.md` B3 flagged this as an unconfirmed assumption that
`on-chain-invariants.md` §3's reasoning silently depended on. Resolving it
here, with reasons, rather than leaving it implicit:

- Each invocation carries one explicit `(mint, quantity)` pair in its own
  instruction data — which is what makes "nothing is resolved at execution
  time" (`deposit-spec.md` §1) literally true rather than aspirational.
- The cap/headroom check runs per invocation against live state, so a
  concurrent deposit landing between two of them shrinks the headroom the
  later ones see, exactly as `deposit-spec.md` §6 (OD-19) requires.
- Multiple instructions in **one transaction** are still atomic as a group;
  only when the set exceeds transaction size limits does it split into
  multiple transactions, which is the `PARTIAL` batch case `deposit-spec.md`
  §3 already specifies ("Credit exactly what confirmed").

This is an engineering decision about instruction granularity. It does not
depend on OD-1 (it behaves identically under any vault cardinality) or on
OD-31/OD-32 (it is orthogonal to what the cap measures).

## 1. Client deposit source

| | |
|---|---|
| Account | `source_token_account: Account<TokenAccount>` |
| Constraints | `owner == owner.key()`, `mint == mint.key()`, `mut` |
| Authority | `owner: Signer` — the client's own wallet, signing this transaction |

The SPL transfer CPI is authorized by `owner`'s signature on this very
transaction. There is no `approve`/delegate, no PDA-signed pull, and no
standing authority of any kind: authority to move this exact quantity of
this exact mint exists only inside this one signed instruction and does not
survive it (`deposit-spec.md` §1). The quantity is instruction data, never
re-derived from the account's balance — so this instruction structurally
cannot sweep a wallet, only move the amount the client put in the
instruction they signed.

**Native SOL is out of scope for this instruction.** It moves SPL tokens
only, via `token::transfer`. It never touches the client's native lamport
balance except for rent the client explicitly pays for accounts they own.
The SOL reserve rule (`reserve-spec.md` §1) therefore cannot be bypassed
through this path — it binds on a native-SOL deposit path that is not
implemented.

## 2. Managed vault destination

| | |
|---|---|
| Account | `vault_token_account: Account<TokenAccount>` |
| Constraints | `owner == vault.key()` (the `["vault", vault_id]` PDA), `mint == mint.key()`, `mut` |

The destination is not a parameter the caller chooses freely: it must be a
token account owned by the vault PDA for this exact mint. An arbitrary
destination is structurally rejected by the constraint, not by a check the
backend could relax.

## 3. Allowlisted mint

| | |
|---|---|
| Accounts | `mint: Account<Mint>`, `allowlisted_mint: Account<AllowlistedMint>` |
| Constraints | `allowlisted_mint` at `seeds = ["mint_allowlist", mint.key()]`, and `active == true` (`assert_mint_allowlisted`) |

Deriving the allowlist PDA from the mint means a non-allowlisted mint has no
valid account to pass — the check cannot be satisfied by substituting a
different entry. `mint.decimals` is read from the real `Mint` account, so
decimals are trustless, not attested.

## 4. Allocation / valuation inputs

| | |
|---|---|
| Instruction data | `quantity_native: u64`, `deposit_seq: u64` |
| Account | `oracle_price: UncheckedAccount` (see §10) |
| Derived on-chain | `total_usd`, `credited_usd`, `excess_usd`, `credited_native`, `excess_native`, `units_issued` |

The **cross-asset ranking is not an input to this instruction and is never
recomputed on-chain.** The comparator (`comparator-spec.md`) decides *which
mints, in what order,* the client is asked to sign; the chain sees only the
resulting per-mint instructions and processes each one as presented. This
confirms `on-chain-invariants.md` §3 rather than assuming it: with the §0
shape, the program provably has no ranking logic because it never sees more
than one mint at a time.

## 5. Client vault position

| | |
|---|---|
| Accounts | `client: Account<ClientAccount>` (read), `position: Account<ClientVaultPosition>` (mut) |
| Constraints | `client` at `["client", owner]` with `client.owner == owner.key()`; `position` at `["client_position", vault_id, owner]`; `client.status == Active` |

Unchanged from the existing OD-1-neutral split: identity on `ClientAccount`,
per-vault units on `ClientVaultPosition`.

**New field:** `position.cumulative_credited_usd_micros` — the running sum
of USD value this program has credited as managed capital for this
(client, vault). Written only by this instruction, from its own execution.

## 6. Excess segregation

| | |
|---|---|
| Accounts | `excess_token_account: Account<TokenAccount>` (mut), `excess_position: Account<ExcessPosition>` (mut) |
| Constraints | `excess_token_account.owner == excess_authority` PDA at `["excess_authority", owner, mint]`; `excess_token_account.mint == mint.key()`; `excess_position` at `["excess_position", owner, mint]` |

Excess is moved by a **second, separate `token::transfer` into a different
token account owned by a different PDA** — physical, account-level
segregation, exactly as `excess-return-spec.md` §3 requires and explicitly
not a database label. The excess authority PDA is derived per
(client, mint) and appears in no vault-side account set, so a future
`execute_trade` operating over vault-owned accounts structurally cannot
reach it.

Both accounts must already exist; a separate `initialize_excess_account`
instruction creates them. A deposit needing excess routing into
non-existent accounts **fails closed** rather than silently creating
accounts mid-transfer or dropping the excess.

## 7. Unit issuance / accounting state

| | |
|---|---|
| Accounts | `vault: Account<Vault>` (mut), `position` (mut) |
| Formula | `math::units_issued_on_subscribe(credited_usd_nav_scaled, vault.unit_price_scaled)` — unchanged, exact, floor |

`vault.total_units_scaled` and `position.units_scaled` are incremented by
the identical amount in the same instruction as the transfer, so units are
created only by a confirmed deposit (`accounting.md` §4) and unit
conservation holds by construction.

**Scale seam.** The allocation path is 1e6 (`UsdMicros`); NAV/unit-price is
1e9 (`NavScaled1e9`). This instruction is the one place both meet.
Conversions are explicit, named, and tested in both directions
(`usd_micros_to_nav_scaled`, `nav_scaled_to_usd_micros`), never implicit —
this is `monetary-representation.md` §3 / OD-29's failure mode, made
visible at the exact site where it would otherwise occur silently.

## 8. Replay protection

| | |
|---|---|
| Account | `deposit_receipt: Account<DepositReceipt>`, `init`, `seeds = ["deposit", owner, deposit_seq]` |

Anchor's `init` fails if the account already exists, so a repeated
`deposit_seq` for the same client is rejected by the runtime, atomically —
the `ExecutedSignal` idempotency pattern from `CLAUDE-CODE-SPEC.md` §4.2,
applied per client sequence number like `RedemptionRequest`'s `seq`.

This revises the position taken in `PHASE-3-DEPOSIT-DEPENDENCY-MAP.md` step
13, which argued no on-chain dedup account was needed because Solana already
prevents transaction replay. That remains true, but it was the wrong
question: the receipt's value is not preventing runtime-level replay, it is
(a) making the idempotency key explicit and client-chosen rather than
implicit in a transaction signature, and (b) giving the off-chain ledger a
durable on-chain record — credited/excess/units, per deposit — to reconcile
against, which `db-schema.md`'s `deposits` table otherwise has no on-chain
counterpart for. Legitimate repeat deposits are unaffected: they use a new
`deposit_seq`.

## 9. Authorities

| Authority | Role in `deposit` |
|---|---|
| **Client (`owner`)** | The only signer. Authorizes the transfer of an exact quantity, pays rent for accounts they own. |
| **Trader** | No role. Cannot invoke or influence this instruction. |
| **Treasury** | No role at execution. Governs the allowlist and config out-of-band. |
| **Guardian** | No role at execution, but `config.paused_global` / `paused_deposits` / `vault.paused` are all checked and any of them halts this instruction. |

No PDA signs anything in this instruction — every transfer is
client-authorized. PDA signing is required only for outbound movement
(redemption, trading), which is not implemented.

## 10. Oracle inputs

| | |
|---|---|
| Account | `oracle_price: UncheckedAccount` |
| Pure validation | `validate_price_snapshot(snapshot, now, max_staleness_secs, max_confidence_bps)` — implemented and tested |
| Account parsing | **Not implemented — fails closed** |

Per `spec` §11, price must come from Pyth (or equivalent) with staleness and
confidence-interval rejection. The *validation rules* are implemented as
pure functions with tests. The *adapter* that deserializes a real Pyth price
account is deliberately **not** implemented and returns an error on every
call, so this instruction cannot execute against an unvalidated price. It is
the one deliberately-missing piece, and it is missing in the fail-closed
direction.

Reason: parsing a real Pyth account requires adding the Pyth SDK and cannot
be verified without runtime execution, which is unavailable
(`cargo-build-sbf`). Shipping an unverified parser that silently produces a
wrong price would be strictly worse than shipping one that refuses to run —
a wrong price directly mis-sizes unit issuance, which is client money.

---

## Trustless on-chain vs. necessarily off-chain

**Enforced trustlessly on-chain** (holds even if the entire backend is
compromised):

- Client authorization — nothing moves without the client's signature on
  this exact instruction.
- Exact quantity moved — instruction data, never re-derived from balances.
- Destination — vault PDA-owned account for managed, excess-authority
  PDA-owned account for excess. No other destination is expressible.
- Mint allowlist membership and active status; mint decimals (read from the
  `Mint` account).
- `credited_native + excess_native == quantity_native`, and
  `credited_usd + excess_usd == total_usd` — asserted, fail-closed.
- `credited_usd <= headroom`.
- Unit issuance arithmetic, exact integer, floor, pool-favoring.
- Unit conservation: `position.units_scaled` and `vault.total_units_scaled`
  move together, in this instruction only.
- Replay: duplicate `deposit_seq` rejected by the runtime.
- Pause states and client status.
- CPI target: `Program<Token>` — Anchor checks the address against the SPL
  Token program ID. There is no caller-supplied program to invoke.

**Necessarily off-chain** (the chain either cannot know, or can only verify
a number someone else produced):

- **The price itself.** The chain can check staleness and confidence around
  a published price; it cannot originate one.
- **Cross-asset ranking and selection.** The comparator runs off-chain; the
  chain sees only the per-mint instructions that result. It cannot verify
  the ranking was computed correctly — this is the boundary
  `on-chain-invariants.md` §3 describes, now confirmed structurally.
- **Token-2022 extension flags** on an allowlist entry — Treasury-attested
  at allowlist time, not derived from the mint account.
- **Identity-level cap aggregation (OD-31).** If the cap attaches to a
  natural person rather than a `ClientAccount`, the chain cannot enforce it:
  it has no identity primitive. Per-`ClientAccount` enforcement is the
  ceiling of what on-chain enforcement can offer, and cross-account
  aggregation is necessarily a KYC-layer control.
- **The `AccountValue` cap basis, if chosen (OD-32).** See below.

## The OD-32 finding: the cap basis changes the security model

The headroom formula needs a number for "how much of this client's cap is
used." The two candidate meanings behind OD-32 are **not equally
enforceable**:

- **Contributed capital** — `position.cumulative_credited_usd_micros`, a sum
  this program computes from its own executions. Fully trustless: a
  compromised backend cannot inflate a client's headroom.
- **Account value** — `units_scaled × vault.unit_price_scaled`. The
  arithmetic is trustless, but `unit_price_scaled` comes from a
  backend-published NAV. Cap enforcement then inherits the trust level of
  the NAV publish path (sanity-banded, but backend-originated).

So OD-32 is not purely a legal/business question: choosing *account value*
converts the cap from an on-chain guarantee into a backend-dependent
control. This was not previously noted anywhere and should go to whoever
answers OD-32.

**How the implementation avoids deciding it:** `Config` carries a
`cap_basis: CapBasis` enum, set explicitly at `initialize_config` (no
default in code) and changeable only through the existing Treasury timelock.
Both underlying quantities are maintained on-chain from day one, so either
answer needs no migration and no new field. The code computes headroom from
whichever basis the deployment configured; it never picks one.

Per-`ClientAccount` enforcement is likewise a structural limit, not a
decision — documented in `ClientAccount` and restated here so OD-31 is not
read as answered.
