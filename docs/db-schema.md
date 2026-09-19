# Postgres Schema

Status: Phase 1 draft. This is the off-chain mirror/ledger described in
`architecture.md`. Postgres is never authoritative for on-chain balances or unit
counts — it is reconciled against chain state continuously (spec §10) — but it
**is** authoritative for idempotency (has this signature/signal been processed
before?), audit trail, and everything the chain cannot express (KYC status,
expert metadata, human-readable reason codes).

Conventions used throughout:
- All USD-scaled and unit quantities use `NUMERIC(39,0)` to safely mirror an
  on-chain `u128` fixed-point value (1e9 scale) without floating point, with
  headroom beyond `u128`'s max (~3.4e38) for defensive margin — see
  `accounting.md` §1 on the no-floats rule.
- Every table that represents a fact about money movement is `INSERT`-only at
  the application layer; corrections are new rows (`ledger_entries`), never
  `UPDATE`/`DELETE` on historical rows. Where Postgres can enforce this
  (`REVOKE UPDATE, DELETE` for the app role, or a `BEFORE UPDATE/DELETE` trigger
  that raises), it does.
- `vault_id` appears throughout even though the Phase 1 default is a single
  vault (`architecture.md` §0 / `open-decisions.md` OD-1), so that resolving
  that decision toward multi-vault later is additive, not a migration of every
  table's grain.

```sql
-- ============================================================
-- Identity / actors
-- ============================================================

CREATE TABLE clients (
    client_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_pubkey            TEXT NOT NULL UNIQUE,            -- wallet the client deposits from
    kyc_status              TEXT NOT NULL DEFAULT 'PENDING'
                              CHECK (kyc_status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
    kyc_provider_ref        TEXT,
    registered_withdrawal_addr TEXT NOT NULL,                -- mirrors on-chain ClientAccount field
    managed_cap_usd_scaled  NUMERIC(39,0) NOT NULL,          -- $1,000,000 default; per-client override only via signed config change
    status                  TEXT NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE','SUSPENDED','OFFBOARDED')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experts (
    expert_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signing_pubkey          TEXT NOT NULL UNIQUE,             -- key used to authenticate signal submission, NOT a funds key
    display_name            TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE','PAUSED','REVOKED')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_users (
    admin_user_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                    TEXT NOT NULL UNIQUE,
    role                     TEXT NOT NULL CHECK (role IN ('OPS','RISK','TREASURY_OPS','READONLY','SUPERADMIN')),
    mfa_enabled              BOOLEAN NOT NULL DEFAULT false,
    status                   TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Vaults and per-client positions
-- ============================================================

CREATE TABLE vaults (
    vault_id                TEXT PRIMARY KEY,                 -- matches on-chain PDA seed, e.g. 'main'
    display_name            TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE','PAUSED','FROZEN')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Off-chain mirror of the on-chain Vault account. Never written to
-- independently of a confirmed on-chain read; the reconciler owns this table.
CREATE TABLE vault_state_mirror (
    vault_id                TEXT PRIMARY KEY REFERENCES vaults(vault_id),
    total_units             NUMERIC(39,0) NOT NULL,
    unit_price_scaled       NUMERIC(39,0) NOT NULL,
    last_nav_ts             TIMESTAMPTZ NOT NULL,
    paused                  BOOLEAN NOT NULL,
    daily_notional_used_scaled NUMERIC(39,0) NOT NULL,
    daily_window_start      TIMESTAMPTZ NOT NULL,
    sol_reserve_lamports    NUMERIC(39,0) NOT NULL,           -- vault's own operational SOL reserve (R1), separate from any
                                                                -- client-wallet reserve -- funds the vault's own fee-payer cost
                                                                -- for trades, redemption settlement, and ATA creation on
                                                                -- clients' behalf. Never counted toward NAV or client units.
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    onchain_slot            BIGINT NOT NULL
);

-- A client's holding within one vault. Unique per (client, vault) so the
-- schema tolerates multiple vaults even under the Phase-1 single-vault default.
CREATE TABLE client_vault_positions (
    client_id               UUID NOT NULL REFERENCES clients(client_id),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    units                   NUMERIC(39,0) NOT NULL DEFAULT 0 CHECK (units >= 0),
    hwm_unit_price_scaled   NUMERIC(39,0),                    -- null until performance fees are in scope, see accounting.md §3.2
    unmanaged_excess_usd_scaled NUMERIC(39,0) NOT NULL DEFAULT 0 CHECK (unmanaged_excess_usd_scaled >= 0),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, vault_id)
);

-- ============================================================
-- Deposits (idempotency-critical)
-- ============================================================

-- Advisory pre-signature quote from the Deposit Quote Engine (architecture.md
-- §3.1, normatively specified in docs/specs/deposit-spec.md). Carries no
-- execution authority and is never read by any code path that moves funds --
-- it exists for UI continuity, staleness checks, and audit trace-back only.
-- A stale/expired quote must be re-quoted, never submitted against
-- (docs/specs/deposit-spec.md §7).
CREATE TABLE deposit_quotes (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               UUID NOT NULL REFERENCES clients(client_id),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    oracle_prices           JSONB NOT NULL,                   -- {mint: price_scaled} snapshot, single timestamp for the whole quote
    headroom_usd_scaled_at_quote NUMERIC(39,0) NOT NULL,
    suggested_allocation    JSONB NOT NULL,                   -- denormalized summary for UI use only; strict USD-value-descending
                                                                 -- ranking (docs/specs/allocation-spec.md, no asset type prioritized) —
                                                                 -- the authoritative, replayable record is deposit_quote_allocations below
    client_selected_allocation JSONB,                          -- null until the client finalizes/overrides the selection; backend
                                                                 -- MUST reject (not merely warn) any SOL quantity here exceeding
                                                                 -- offered_sol_lamports below, including a payload built outside
                                                                 -- the UI -- see threat-model.md T20
    -- SOL reserve computation (R1) -- recomputed fresh at every quote, never cached
    eligible_sol_lamports     NUMERIC(39,0) NOT NULL,           -- client's SOL balance before any reserve is applied
    sol_pct_reserve_lamports  NUMERIC(39,0) NOT NULL,           -- 10% of eligible_sol_lamports
    sol_absolute_reserve_lamports NUMERIC(39,0) NOT NULL,       -- current value of platform_config['min_sol_reserve_lamports']
    offered_sol_lamports      NUMERIC(39,0) NOT NULL,           -- clamp(eligible - max(pct, absolute), 0); a CEILING, never a target
    sol_excluded_reason       TEXT,                             -- non-null iff offered_sol_lamports = 0; shown to client in plain language
    fee_estimate_lamports   NUMERIC(39,0) NOT NULL,
    quote_staleness_seconds INT NOT NULL,                      -- config value in effect at quote time, see open-decisions.md OD-22
    expires_at              TIMESTAMPTZ NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE','EXPIRED','CONSUMED','SUPERSEDED')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Authoritative, replayable per-asset audit record for a quote's allocation
-- ranking (docs/specs/allocation-spec.md). One row per mint considered, whether
-- allocated, partially allocated, or excluded -- sufficient on its own to
-- recompute and reproduce the allocation byte-for-byte without re-querying
-- an oracle or RPC. SOL's row here reflects offered_sol (post-reserve), never
-- the client's full SOL balance (R1 ordering requirement).
CREATE TABLE deposit_quote_allocations (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id                 UUID NOT NULL REFERENCES deposit_quotes(id),
    mint                     TEXT NOT NULL,
    valuation_timestamp      TIMESTAMPTZ NOT NULL,             -- the single snapshot timestamp shared by every row for this quote_id
    price_source             TEXT NOT NULL,
    price_scaled             NUMERIC(39,0),                    -- null iff inclusion_status = 'EXCLUDED_UNPRICEABLE'
    oracle_confidence_scaled NUMERIC(39,0),
    asset_quantity_raw       NUMERIC(39,0) NOT NULL,
    usd_value_scaled         NUMERIC(39,0) NOT NULL DEFAULT 0,
    rank                     INT,                              -- null if excluded before ranking
    tiebreak_applied         BOOLEAN NOT NULL DEFAULT false,    -- true iff this row shared usd_value with another and was ordered by mint-byte comparison
    allocated_quantity_raw   NUMERIC(39,0) NOT NULL DEFAULT 0,
    allocated_usd_scaled     NUMERIC(39,0) NOT NULL DEFAULT 0,
    unallocated_quantity_raw NUMERIC(39,0) NOT NULL DEFAULT 0,  -- boundary-rounding remainder and/or full excess land here
    unallocated_usd_scaled   NUMERIC(39,0) NOT NULL DEFAULT 0,
    inclusion_status         TEXT NOT NULL CHECK (inclusion_status IN
                               ('RANKED','EXCLUDED_UNPRICEABLE','EXCLUDED_FILTERED')),
    exclusion_reason_code    TEXT,                              -- mirrors filtered_deposit_candidates reason codes for EXCLUDED_FILTERED;
                                                                  -- 'UNPRICEABLE' is its own status, not a reason code, since it's a
                                                                  -- pricing-time condition rather than a static mint property
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_deposit_quote_allocation UNIQUE (quote_id, mint)
);

-- Every eligible-wallet asset that did NOT make it into a quote's candidate
-- list, and why. This table is written to server-side, by the same service
-- that builds deposit_quotes, and is NEVER joined into any client-facing API
-- response -- filtering happens before the client-facing payload is
-- constructed, not in the UI layer, so there is nothing for a modified client
-- to recover (R2). Exists for reconciliation, security analytics, and
-- scam-mint intelligence.
CREATE TABLE filtered_deposit_candidates (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               UUID NOT NULL REFERENCES clients(client_id),
    quote_id                UUID REFERENCES deposit_quotes(id),
    mint                    TEXT NOT NULL,
    reason_code             TEXT NOT NULL CHECK (reason_code IN (
                               'NOT_ON_ALLOWLIST','NO_ORACLE_PRICE','INSUFFICIENT_LIQUIDITY',
                               'FROZEN_ACCOUNT','NON_TRANSFERABLE','UNSUPPORTED_PROGRAM',
                               'KNOWN_SCAM','TRANSFER_HOOK_PRESENT','FEE_ON_TRANSFER','NFT')),
    wallet_value_usd_scaled_at_detection NUMERIC(39,0),         -- used only to evaluate the >5% materiality-disclosure trigger;
                                                                  -- never returned per-mint to the client (see threat-model.md T21)
    detected_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One deposit_batch groups the "complete set" of transactions presented to
-- the client in a single signing session (docs/specs/deposit-spec.md §3).
-- Multi-tx deposits are NOT atomic across the batch; status tracks how much
-- of the batch actually confirmed.
CREATE TABLE deposit_batches (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               UUID NOT NULL REFERENCES clients(client_id),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    quote_id                UUID NOT NULL REFERENCES deposit_quotes(id),
    status                  TEXT NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING','PARTIAL','COMPLETE','FAILED')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at            TIMESTAMPTZ
);

-- Every submission attempt within a batch, whether or not it ever confirms.
-- This is the raw material for the three-window latency instrumentation
-- (quote latency / submit latency / submit-to-finality) required by
-- docs/specs/deposit-spec.md §7, and for reconstructing exactly what was and
-- wasn't confirmed after a partial-batch failure.
CREATE TABLE deposit_transactions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id                UUID NOT NULL REFERENCES deposit_batches(id),
    tx_signature            TEXT,                              -- null until the client returns a signed tx / it's broadcast
    planned_mints           JSONB NOT NULL,                    -- {mint: amount_raw} this specific transaction carries
    signature_received_at   TIMESTAMPTZ NOT NULL,               -- t0
    submitted_at            TIMESTAMPTZ,                        -- t1
    confirmed_at            TIMESTAMPTZ,
    status                  TEXT NOT NULL DEFAULT 'PENDING_SUBMIT'
                              CHECK (status IN ('PENDING_SUBMIT','SUBMITTED','CONFIRMED','FAILED','DROPPED')),
    CONSTRAINT uq_deposit_transaction_signature UNIQUE (tx_signature)
);

CREATE TABLE deposits (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               UUID NOT NULL REFERENCES clients(client_id),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    tx_signature            TEXT NOT NULL,
    instruction_index       INT NOT NULL,
    mint                    TEXT NOT NULL,
    amount_raw              NUMERIC(39,0) NOT NULL,
    amount_usd_scaled       NUMERIC(39,0) NOT NULL,           -- oracle-valued at deposit time, per spec §6.2 (never DEX spot)
    units_issued            NUMERIC(39,0) NOT NULL,
    unmanaged_excess_usd_scaled NUMERIC(39,0) NOT NULL DEFAULT 0,
    path                    TEXT NOT NULL CHECK (path IN ('INSTRUCTION','PDA_SWEEP')),
    batch_id                UUID REFERENCES deposit_batches(id),   -- null for PDA_SWEEP path; links multi-tx onboarding deposits
    quote_id                UUID REFERENCES deposit_quotes(id),    -- the advisory quote this credit traces back to, for audit only —
                                                                     -- never the source of truth for the amounts above (docs/specs/deposit-spec.md §6)
    signature_received_at   TIMESTAMPTZ,                            -- t0, latency instrumentation (docs/specs/deposit-spec.md §7)
    submitted_at            TIMESTAMPTZ,                            -- t1
    confirmed_at            TIMESTAMPTZ,
    finality_policy         TEXT NOT NULL DEFAULT 'finalized',
    status                  TEXT NOT NULL DEFAULT 'CREDITED'
                              CHECK (status IN ('CREDITED','REJECTED_UNSUPPORTED_MINT')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The idempotency key from spec §6.2: reprocessing a signature is a no-op, always.
    CONSTRAINT uq_deposit_idempotency UNIQUE (tx_signature, instruction_index, mint)
);

-- Per-client unique deposit PDAs for the secondary (transfer-monitoring) path.
-- Never shared across clients (spec §6.1) — enforced by the unique constraint.
CREATE TABLE deposit_pdas (
    pda_address             TEXT PRIMARY KEY,
    client_id               UUID NOT NULL REFERENCES clients(client_id),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_deposit_pda_per_client_vault UNIQUE (client_id, vault_id)
);

-- Funds nobody could attribute. Never auto-credited, never traded (spec §6.1).
CREATE TABLE unattributed_deposits (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_signature            TEXT NOT NULL,
    instruction_index       INT NOT NULL,
    mint                    TEXT NOT NULL,
    amount_raw              NUMERIC(39,0) NOT NULL,
    source_address          TEXT,
    reason                  TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'OPEN'
                              CHECK (status IN ('OPEN','RETURNED','MANUALLY_ATTRIBUTED','FORFEITED_TO_OPS_REVIEW')),
    reviewed_by             UUID REFERENCES admin_users(admin_user_id),
    reviewed_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_unattributed_idempotency UNIQUE (tx_signature, instruction_index, mint)
);

-- ============================================================
-- Signals, execution, risk reservation
-- ============================================================

CREATE TABLE signals (
    signal_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expert_id               UUID NOT NULL REFERENCES experts(expert_id),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    action                  TEXT NOT NULL CHECK (action IN ('BUY','SELL','SET_ALLOCATION','CLOSE')),
    target_mint             TEXT NOT NULL,                    -- mint address only, never symbol (spec §8.1)
    size_spec               JSONB NOT NULL,                   -- {pct_of_nav}|{pct_of_position}|{target_allocation_pct}|{close:true}
    max_slippage_bps        INT NOT NULL,
    max_price_impact_bps    INT NOT NULL,
    constraints             JSONB NOT NULL DEFAULT '{}',
    status                  TEXT NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING','VALIDATED','REJECTED','QUEUED','EXECUTING','EXECUTED','EXPIRED','CANCELLED')),
    rejection_reason        TEXT,
    expires_at              TIMESTAMPTZ NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast-path mirror of the on-chain ExecutedSignal PDA. The on-chain `init`
-- constraint is the authoritative dedup layer (see on-chain-invariants.md);
-- this table exists so a worker can avoid a wasted RPC round-trip, and its
-- unique constraint must match the on-chain PDA seeds exactly: (vault, signal_id).
CREATE TABLE executed_signals (
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    signal_id               UUID NOT NULL REFERENCES signals(signal_id),
    tx_signature            TEXT NOT NULL,
    amount_in_raw           NUMERIC(39,0) NOT NULL,
    amount_out_raw          NUMERIC(39,0) NOT NULL,
    executed_at             TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (vault_id, signal_id)
);

-- Risk-engine reservation/commit (spec §8.2). One row per attempted signal
-- execution; status transitions RESERVED -> COMMITTED | RELEASED | EXPIRED.
-- Reservation is a UX/throughput optimization; the on-chain daily counter in
-- execute_trade is the authoritative cap (see on-chain-invariants.md).
CREATE TABLE risk_reservations (
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    signal_id               UUID NOT NULL REFERENCES signals(signal_id),
    reserved_notional_usd_scaled NUMERIC(39,0) NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'RESERVED'
                              CHECK (status IN ('RESERVED','COMMITTED','RELEASED','EXPIRED')),
    reserved_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at              TIMESTAMPTZ NOT NULL,             -- crashed-worker headroom recovery (spec §8.2 point 4)
    resolved_at             TIMESTAMPTZ,
    PRIMARY KEY (vault_id, signal_id)
);

CREATE TABLE trades (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    signal_id               UUID NOT NULL REFERENCES signals(signal_id),
    tx_signature            TEXT NOT NULL,
    input_mint              TEXT NOT NULL,
    output_mint             TEXT NOT NULL,
    amount_in_raw           NUMERIC(39,0) NOT NULL,
    amount_out_raw          NUMERIC(39,0) NOT NULL,
    oracle_price_scaled     NUMERIC(39,0) NOT NULL,
    slippage_bps_realized   INT NOT NULL,
    route_program           TEXT NOT NULL,
    status                  TEXT NOT NULL CHECK (status IN ('CONFIRMED','FAILED')),
    executed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_trade_tx_signature UNIQUE (tx_signature)
);

CREATE TABLE positions (
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    mint                    TEXT NOT NULL,
    quantity_raw            NUMERIC(39,0) NOT NULL,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, mint)
);

-- ============================================================
-- NAV, fees
-- ============================================================

CREATE TABLE nav_snapshots (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    nav_usd_scaled          NUMERIC(39,0) NOT NULL,
    unit_price_scaled       NUMERIC(39,0) NOT NULL,
    total_units             NUMERIC(39,0) NOT NULL,
    cash_usd_scaled         NUMERIC(39,0) NOT NULL,
    positions_value_usd_scaled NUMERIC(39,0) NOT NULL,
    liabilities_usd_scaled  NUMERIC(39,0) NOT NULL DEFAULT 0,
    accrued_fees_usd_scaled NUMERIC(39,0) NOT NULL DEFAULT 0,
    treasury_cosigned       BOOLEAN NOT NULL DEFAULT false,   -- true when publish exceeded the sanity band and required co-sign
    publish_tx_signature    TEXT,
    published_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_nav_publish UNIQUE (vault_id, publish_tx_signature)
);

CREATE TABLE fee_accruals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    accrual_date            DATE NOT NULL,
    fee_type                TEXT NOT NULL CHECK (fee_type IN ('MANAGEMENT','PERFORMANCE')),
    amount_usd_scaled       NUMERIC(39,0) NOT NULL,
    nav_snapshot_id         UUID REFERENCES nav_snapshots(id),
    client_id               UUID REFERENCES clients(client_id), -- non-null for PERFORMANCE (per-client HWM), null for pool-level MANAGEMENT
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_fee_accrual UNIQUE (vault_id, accrual_date, fee_type, client_id)
);

-- ============================================================
-- Redemptions
-- ============================================================

CREATE TABLE redemption_cycles (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    cycle_seq               BIGINT NOT NULL,
    strike_at               TIMESTAMPTZ NOT NULL,
    struck_unit_price_scaled NUMERIC(39,0),
    settlement_due_at       TIMESTAMPTZ NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING','STRUCK','SETTLED')),
    CONSTRAINT uq_redemption_cycle UNIQUE (vault_id, cycle_seq)
);

CREATE TABLE redemption_requests (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               UUID NOT NULL REFERENCES clients(client_id),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    client_seq              BIGINT NOT NULL,                  -- matches on-chain RedemptionRequest PDA seed ["redeem", client_id, seq]
    units_requested         NUMERIC(39,0) NOT NULL CHECK (units_requested > 0),
    requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    cycle_id                UUID REFERENCES redemption_cycles(id),
    struck_unit_price_scaled NUMERIC(39,0),
    payout_usd_scaled       NUMERIC(39,0),
    status                  TEXT NOT NULL DEFAULT 'REQUESTED'
                              CHECK (status IN ('REQUESTED','STRUCK','LIQUIDATING','SETTLED','CLAIMABLE','CLAIMED','GATED')),
    settled_tx_signature    TEXT,
    claimed_tx_signature    TEXT,
    CONSTRAINT uq_redemption_request UNIQUE (client_id, vault_id, client_seq)
);

-- ============================================================
-- Withdrawal address changes (timelocked, spec §4.3/§7.2)
-- ============================================================

CREATE TABLE withdrawal_address_changes (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               UUID NOT NULL REFERENCES clients(client_id),
    old_address             TEXT NOT NULL,
    new_address             TEXT NOT NULL,
    requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_at            TIMESTAMPTZ NOT NULL,             -- requested_at + timelock (min 24-48h)
    confirmed_at            TIMESTAMPTZ,
    notification_sent_at    TIMESTAMPTZ,
    status                  TEXT NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING','CONFIRMED','CANCELLED')),
    -- Only one pending change per client at a time.
    CONSTRAINT uq_one_pending_change_per_client
        EXCLUDE (client_id WITH =) WHERE (status = 'PENDING')
);

-- ============================================================
-- Ledger, reconciliation, pause, allowlists, oracle, audit
-- ============================================================

-- Append-only. No operator action ever mutates a balance directly (spec §7.2);
-- every adjustment is a posted, dual-authorised, reason-coded entry here.
CREATE TABLE ledger_entries (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    client_id               UUID REFERENCES clients(client_id),
    entry_type              TEXT NOT NULL,                    -- DEPOSIT, REDEMPTION, FEE, TRADE, MANUAL_ADJUSTMENT, ...
    amount_usd_scaled       NUMERIC(39,0),
    units_delta             NUMERIC(39,0),
    reason_code             TEXT NOT NULL,
    actor                   TEXT NOT NULL,                    -- system component or admin_user_id as text
    dual_authorized_by      UUID REFERENCES admin_users(admin_user_id), -- required (NOT NULL enforced at app layer) for MANUAL_ADJUSTMENT
    before_state            JSONB,
    after_state             JSONB,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_runs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id                TEXT NOT NULL REFERENCES vaults(vault_id),
    run_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    status                  TEXT NOT NULL CHECK (status IN ('CLEAN','BREAK')),
    onchain_snapshot        JSONB NOT NULL,
    ledger_snapshot         JSONB NOT NULL,
    nav_snapshot            JSONB NOT NULL
);

CREATE TABLE reconciliation_breaks (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                  UUID NOT NULL REFERENCES reconciliation_runs(id),
    break_type              TEXT NOT NULL,                    -- UNIT_MISMATCH, BALANCE_MISMATCH, ORPHAN_ONCHAIN_TX, ORPHAN_LEDGER_TX
    expected_value          NUMERIC(39,0),
    actual_value            NUMERIC(39,0),
    delta                   NUMERIC(39,0),
    severity                TEXT NOT NULL CHECK (severity IN ('WARN','HARD_BREACH')),
    auto_paused             BOOLEAN NOT NULL DEFAULT false,
    resolved_by             UUID REFERENCES admin_users(admin_user_id),
    resolved_at             TIMESTAMPTZ,
    resolution_notes        TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pause_events (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id                TEXT REFERENCES vaults(vault_id),  -- null = global pause
    scope                   TEXT NOT NULL CHECK (scope IN ('GLOBAL','TRADING','DEPOSITS')),
    triggered_by            TEXT NOT NULL CHECK (triggered_by IN ('GUARDIAN','RECONCILER_AUTO','MANUAL_ADMIN')),
    reason                  TEXT NOT NULL,
    tx_signature            TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    unpaused_at             TIMESTAMPTZ,
    unpaused_by             TEXT                              -- must be Treasury per spec §3.1; recorded for audit
);

-- Adding a mint here is a Treasury-authorized, fund-loss-relevant action, not
-- a routine config edit: an attacker who could write to this table (or the
-- on-chain MintAllowlist it mirrors) could make a worthless token appear as a
-- legitimate deposit option (threat-model.md T6 / T21 note). The Token-2022
-- extension flags exist because the onboarding filter (R2) treats each
-- extension as its own disqualifying condition, not an interchangeable
-- "SPL-token-like" bucket.
CREATE TABLE allowlist_mints (
    mint_address             TEXT PRIMARY KEY,
    symbol                   TEXT,
    token_program            TEXT NOT NULL CHECK (token_program IN ('SPL_TOKEN','TOKEN_2022')),
    has_transfer_hook        BOOLEAN NOT NULL DEFAULT false,
    has_transfer_fee         BOOLEAN NOT NULL DEFAULT false,
    has_permanent_delegate   BOOLEAN NOT NULL DEFAULT false,
    is_transferable          BOOLEAN NOT NULL DEFAULT true,
    -- v1 disqualifying combination, enforced at the application layer wherever
    -- deposit eligibility is computed: token_program = 'TOKEN_2022' AND
    -- (has_transfer_hook OR has_transfer_fee OR has_permanent_delegate OR NOT is_transferable)
    -- must never reach ACTIVE allowlist status (see open-decisions.md OD-6/OD-27).
    reviewed_by              TEXT NOT NULL,
    reviewed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    added_by                 TEXT NOT NULL,                   -- Treasury signer ref
    added_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at                TIMESTAMPTZ
);

CREATE TABLE allowlist_programs (
    program_id               TEXT PRIMARY KEY,
    label                    TEXT NOT NULL,
    added_by                 TEXT NOT NULL,
    added_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at                TIMESTAMPTZ
);

-- Scalar operational config, versioned by row history rather than in-place
-- overwrite of a value nothing else references. Holds the numeric knobs this
-- Phase 1 pass explicitly refused to hardcode as production policy (see
-- open-decisions.md): min_sol_reserve_lamports, sol_reserve_pct_bps,
-- quote_staleness_seconds, materiality_disclosure_threshold_bps,
-- vault_sol_reserve_target_lamports, vault_sol_reserve_min_lamports, and
-- similar. Every change is attributed and timestamped -- this table is
-- read-heavy/write-rare and every write is itself an auditable event.
CREATE TABLE platform_config (
    key                      TEXT PRIMARY KEY,
    value                    JSONB NOT NULL,
    description              TEXT NOT NULL,
    updated_by               TEXT NOT NULL,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oracle_price_snapshots (
    id                       BIGSERIAL PRIMARY KEY,
    mint                     TEXT NOT NULL,
    price_scaled             NUMERIC(39,0) NOT NULL,
    confidence_scaled        NUMERIC(39,0) NOT NULL,
    oracle_published_at      TIMESTAMPTZ NOT NULL,
    ingested_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_oracle_price_mint_time ON oracle_price_snapshots (mint, oracle_published_at DESC);

CREATE TABLE admin_actions (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id            UUID NOT NULL REFERENCES admin_users(admin_user_id),
    action_type              TEXT NOT NULL,
    target_type              TEXT NOT NULL,
    target_id                TEXT NOT NULL,
    before_state             JSONB,
    after_state              JSONB,
    dual_authorized_by       UUID REFERENCES admin_users(admin_user_id),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Catch-all append-only audit log per spec §14. Must be able to answer, for
-- any client at any past timestamp: what were their units, what was the unit
-- price, and what did they own -- via nav_snapshots + client_vault_positions
-- history (consider a temporal/history table or event-sourcing the position
-- table if point-in-time queries prove too slow against ledger_entries replay).
CREATE TABLE audit_log (
    id                       BIGSERIAL PRIMARY KEY,
    event_type               TEXT NOT NULL,
    actor_type               TEXT NOT NULL CHECK (actor_type IN ('CLIENT','EXPERT','ADMIN','SYSTEM')),
    actor_id                 TEXT,
    subject_type              TEXT,
    subject_id                TEXT,
    payload                   JSONB NOT NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_subject ON audit_log (subject_type, subject_id, created_at);

CREATE TABLE kms_key_refs (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role                      TEXT NOT NULL CHECK (role IN ('TRADER','GUARDIAN')),
    provider                  TEXT NOT NULL,
    key_ref                   TEXT NOT NULL,                   -- opaque reference into KMS/HSM/MPC, never raw key material
    status                    TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ROTATING','REVOKED')),
    rotated_at                TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Idempotency constraints, called out explicitly

| Constraint | Table | Prevents |
|---|---|---|
| `uq_deposit_idempotency (tx_signature, instruction_index, mint)` | `deposits` | Double-crediting a deposit if a worker or webhook replays the same on-chain transaction (spec §6.2 requirement, verbatim) |
| `uq_unattributed_idempotency (tx_signature, instruction_index, mint)` | `unattributed_deposits` | Same signature landing in the unattributed bucket twice |
| `(vault_id, signal_id)` primary key | `executed_signals` | Double-processing a signal in the off-chain fast path; on-chain `ExecutedSignal` `init` is the authoritative version of this same guarantee |
| `(vault_id, signal_id)` primary key | `risk_reservations` | Two workers reserving headroom for the same signal twice |
| `uq_trade_tx_signature (tx_signature)` | `trades` | Recording the same confirmed trade twice under retry |
| `uq_deposit_pda_per_client_vault (client_id, vault_id)` | `deposit_pdas` | A client ever being issued two deposit PDAs for the same vault (or, transitively via the address itself being the PK, a PDA ever being shared across clients) |
| `uq_redemption_request (client_id, vault_id, client_seq)` | `redemption_requests` | Double-submission of the same redemption sequence number |
| `uq_redemption_cycle (vault_id, cycle_seq)` | `redemption_cycles` | Two strike events colliding on the same cycle |
| `uq_fee_accrual (vault_id, accrual_date, fee_type, client_id)` | `fee_accruals` | Double-accruing the same day's fee if the NAV/fee job is retried |
| `uq_nav_publish (vault_id, publish_tx_signature)` | `nav_snapshots` | Recording the same on-chain NAV publish twice |
| `uq_one_pending_change_per_client` (exclusion constraint) | `withdrawal_address_changes` | A client having two conflicting in-flight address changes racing each other |

## Additional integrity constraints introduced by the onboarding engine (R1/R2)

These aren't idempotency constraints, but they're load-bearing enough to call
out explicitly rather than leave implicit in column comments:

- **`offered_sol_lamports` is a ceiling the backend must enforce, not a UI
  hint.** Postgres can't express "reject any `client_selected_allocation` SOL
  entry greater than this row's own `offered_sol_lamports`" as a `CHECK`
  constraint against a JSONB sibling column portably, so this is an
  application-layer invariant: the API handler that accepts a client's final
  selection (whether from the normal UI or any other caller of the same
  endpoint) must validate against the quote row before building a transaction.
  Treat a violation as a rejected request, not a clamped one — silently
  clamping would hide a bug or an attempted bypass.
- **Token-2022 disqualifying combination is an application-layer gate on
  `allowlist_mints`**, checked wherever deposit eligibility is computed (the
  Deposit Quote Engine's enumeration step), not just at allowlist-write time —
  belt-and-suspenders, since the allowlist-write check and the deposit-time
  check are different code paths and both need to independently refuse a
  disqualifying mint.
- **`uq_deposit_quote_allocation (quote_id, mint)`** prevents an asset from
  being recorded twice in one quote's ranking (e.g., a retried ranking
  computation double-writing rows), which would corrupt the byte-for-byte
  replay guarantee the table exists to provide.
- **`filtered_deposit_candidates` must never be joined into a client-facing
  query.** This is a code-review/API-contract discipline item, not something
  the schema itself can enforce — flagged here so it's an explicit review
  checklist item for Phase 4, not an assumption.

## Open item

Point-in-time client history ("what did they own on date X") is answerable
either by replaying `ledger_entries` or by snapshotting
`client_vault_positions` + `nav_snapshots` on a schedule. This document doesn't
pick one — it's a Phase 5 (NAV engine) implementation decision once query
performance against real data volume is known, not a Phase 1 schema commitment
beyond ensuring the raw facts (`ledger_entries`, `nav_snapshots`) are never
overwritten.
