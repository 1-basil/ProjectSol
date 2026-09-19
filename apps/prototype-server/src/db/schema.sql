-- Prototype deposit-flow schema. No separate migration history/tooling --
-- this file IS the schema, and every statement in it is written to be
-- idempotent (IF NOT EXISTS / OR IGNORE) so that applying it against an
-- already-initialized database file is a safe no-op rather than an error.
-- This is what makes a real server restart against its persistent DB file
-- safe: src/db/client.ts's openDatabase() runs this same file on every
-- startup, first-run or not. If a real schema CHANGE is ever needed later
-- (a new column, a new table), add it as a new idempotent statement here
-- guarded the same way -- never rewrite an existing CREATE statement in a
-- way that would fail against a database that already has the old shape.
--
-- Every monetary/native-amount value is stored as TEXT (an exact decimal
-- integer string), never SQLite INTEGER/REAL, and parsed as BigInt in
-- application code. This mirrors docs/specs/monetary-representation.md's
-- rule for this whole project: no floats in any monetary path, and no
-- coercion through a type that silently loses precision above 2^53. A raw
-- u64 token amount or a u128-range USD-micros cap total both fit this
-- concern; TEXT columns sidestep it entirely rather than relying on
-- SQLite's 64-bit INTEGER happening to be wide enough.

CREATE TABLE IF NOT EXISTS clients (
    id              TEXT PRIMARY KEY,
    wallet_pubkey   TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (client, asset). This is the entire per-asset cap/authorization
-- state — see docs/PHASE-3-... conversation history: replaces any single
-- client-wide aggregate figure. asset_key is a mint pubkey for SPL/Token-2022
-- assets, or the literal string 'SOL' for native SOL (whose authorized
-- account is a client-owned wSOL ATA, not the mint itself).
CREATE TABLE IF NOT EXISTS client_asset_authorizations (
    id                              TEXT PRIMARY KEY,
    client_id                       TEXT NOT NULL REFERENCES clients(id),
    asset_key                       TEXT NOT NULL,
    token_program                   TEXT NOT NULL CHECK (token_program IN ('SPL_TOKEN','TOKEN_2022','NATIVE_SOL')),
    authorized_token_account        TEXT NOT NULL,
    delegate                        TEXT NOT NULL,
    original_authorized_native_amount TEXT NOT NULL,
    authorization_tx_signature      TEXT NOT NULL,
    authorized_at                   TEXT NOT NULL,
    status                          TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
    revoked_at                      TEXT,
    cumulative_credited_usd_micros  TEXT NOT NULL DEFAULT '0',
    asset_cap_usd_micros            TEXT NOT NULL,
    created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (client_id, asset_key)
);

-- Append-only audit log. Never updated or deleted; every authorization
-- lifecycle event is a new row here regardless of what the current-state
-- row above says now.
CREATE TABLE IF NOT EXISTS authorization_events (
    id                              TEXT PRIMARY KEY,
    client_asset_authorization_id   TEXT NOT NULL REFERENCES client_asset_authorizations(id),
    event_type                      TEXT NOT NULL CHECK (event_type IN ('APPROVED','RE_APPROVED','REVOKED')),
    tx_signature                    TEXT NOT NULL,
    native_amount                   TEXT,
    occurred_at                     TEXT NOT NULL,
    created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per actual transfer (an authorization-time credit or a later
-- sweep). tx_signature is UNIQUE — this is the replay/duplicate-protection
-- constraint: reprocessing the same signature is a no-op at the database
-- level, not just an application-level check.
CREATE TABLE IF NOT EXISTS deposits (
    id                              TEXT PRIMARY KEY,
    client_id                       TEXT NOT NULL REFERENCES clients(id),
    client_asset_authorization_id   TEXT NOT NULL REFERENCES client_asset_authorizations(id),
    asset_key                       TEXT NOT NULL,
    tx_signature                    TEXT NOT NULL UNIQUE,
    source_account                  TEXT NOT NULL,
    destination_account             TEXT NOT NULL,
    native_amount                   TEXT NOT NULL,
    usd_value_micros                TEXT NOT NULL,
    price_scaled                    TEXT,
    price_exponent                  INTEGER,
    -- The blockhash-expiry block height recorded at broadcast time. If a
    -- signature is later found neither confirmed nor erred, this is what
    -- lets the reconciler tell "genuinely still in flight" apart from
    -- "provably can never land" (current block height has passed it) —
    -- see sweepAsset.ts's reconcilePendingDeposit. Null only for rows this
    -- column predates (none exist -- fresh prototype DB, no migration
    -- history to preserve).
    last_valid_block_height         INTEGER,
    status                          TEXT NOT NULL CHECK (status IN ('PENDING','CONFIRMED','FINALIZED','FAILED')),
    confirmed_at                    TEXT,
    finalized_at                    TEXT,
    created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- At most one in-flight sweep per authorization at any time. This is the
-- actual concurrency control for concurrent sweep workers/processes: two
-- workers racing to sweep the same authorization will both pass an
-- in-application "is anything pending?" check before either has written
-- anything, but only ONE of their INSERTs here can ever succeed — SQLite
-- itself serializes conflicting writers across connections/processes, so
-- this is enforced by the database, not by application-level convention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_deposit_per_authorization
ON deposits(client_asset_authorization_id)
WHERE status = 'PENDING';

-- Latest known price per asset. asset_key 'SOL' for native SOL, mint pubkey
-- otherwise. Used for staleness/confidence checks before any cap decision.
CREATE TABLE IF NOT EXISTS price_cache (
    asset_key           TEXT PRIMARY KEY,
    price_scaled        TEXT NOT NULL,
    price_exponent      INTEGER NOT NULL,
    confidence_scaled   TEXT NOT NULL,
    fetched_at          TEXT NOT NULL
);

-- Configurable tunables — never hardcoded into application logic. Seeded
-- with the agreed defaults at DB init time (see src/db/client.ts) via
-- INSERT OR IGNORE, so a restart never resets a value an operator changed.
CREATE TABLE IF NOT EXISTS platform_config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_authorizations_client ON client_asset_authorizations(client_id);
CREATE INDEX IF NOT EXISTS idx_deposits_client ON deposits(client_id);
CREATE INDEX IF NOT EXISTS idx_deposits_authorization ON deposits(client_asset_authorization_id);
CREATE INDEX IF NOT EXISTS idx_events_authorization ON authorization_events(client_asset_authorization_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(client_asset_authorization_id, status);

-- Financial facts on a deposit row are immutable once written — only the
-- status lifecycle (PENDING -> CONFIRMED/FAILED -> FINALIZED) and its
-- timestamps may change. Enforced here at the database level, not just by
-- application-code discipline, matching db-schema.md's established
-- "INSERT-only for money-movement facts" convention elsewhere in this
-- project.
CREATE TRIGGER IF NOT EXISTS prevent_deposit_financial_field_mutation
BEFORE UPDATE OF native_amount, usd_value_micros, price_scaled, price_exponent, tx_signature, source_account, destination_account, asset_key, client_asset_authorization_id, client_id
ON deposits
BEGIN
  SELECT RAISE(ABORT, 'deposits: financial fields are immutable; only status/confirmed_at/finalized_at may be updated');
END;

CREATE TRIGGER IF NOT EXISTS prevent_deposit_deletion
BEFORE DELETE ON deposits
BEGIN
  SELECT RAISE(ABORT, 'deposits: rows are append-only and may never be deleted');
END;

-- authorization_events is a pure audit log: no field, including status
-- fields, is ever updated or deleted once written.
CREATE TRIGGER IF NOT EXISTS prevent_authorization_event_mutation
BEFORE UPDATE ON authorization_events
BEGIN
  SELECT RAISE(ABORT, 'authorization_events: append-only, rows are never updated');
END;

CREATE TRIGGER IF NOT EXISTS prevent_authorization_event_deletion
BEFORE DELETE ON authorization_events
BEGIN
  SELECT RAISE(ABORT, 'authorization_events: append-only, rows are never deleted');
END;
