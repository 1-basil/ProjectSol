// Regression test for a real bug found during the security audit: the
// production openDatabase() re-runs the entire schema.sql on every call,
// and before this fix schema.sql's CREATE TABLE/INDEX/TRIGGER statements
// had no IF NOT EXISTS guards -- so a real server process restarting
// against its own already-initialized database file would crash with
// "table clients already exists" on its very next startup. This test uses
// the REAL production openDatabase() (not a test-only bypass) against a
// real file-backed database, closes it, and reopens it exactly as a
// restarted server process would.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { openDatabase, getConfig, setConfig } from "../src/db/client.ts";

function tempDbPath(): string {
  return join(tmpdir(), `projectsol-restart-test-${randomUUID()}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

test("openDatabase(): second startup against the same file succeeds cleanly and preserves all existing data", () => {
  const path = tempDbPath();
  assert.equal(existsSync(path), false, "test setup: must start from a genuinely fresh path");

  try {
    // --- First startup: create the database normally. ---
    const db1 = openDatabase(path);

    const clientId = randomUUID();
    db1.prepare("INSERT INTO clients (id, wallet_pubkey) VALUES (?, ?)").run(clientId, "RestartTestWallet111");

    const authorizationId = randomUUID();
    db1.prepare(
      `INSERT INTO client_asset_authorizations
       (id, client_id, asset_key, token_program, authorized_token_account, delegate,
        original_authorized_native_amount, authorization_tx_signature, authorized_at,
        status, cumulative_credited_usd_micros, asset_cap_usd_micros)
       VALUES (?, ?, 'SOL', 'NATIVE_SOL', 'wsolAta111', 'pooledWallet111', '1000000000000', 'restart-auth-sig', datetime('now'), 'ACTIVE', '2500000', '1000000000000')`,
    ).run(authorizationId, clientId);

    db1.prepare(
      `INSERT INTO authorization_events (id, client_asset_authorization_id, event_type, tx_signature, native_amount, occurred_at)
       VALUES (?, ?, 'APPROVED', 'restart-auth-sig', '1000000000000', datetime('now'))`,
    ).run(randomUUID(), authorizationId);

    const depositId = randomUUID();
    db1.prepare(
      `INSERT INTO deposits
       (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, status)
       VALUES (?, ?, ?, 'SOL', 'restart-deposit-sig', 'wsolAta111', 'pooledWsolAta111', '2500000', '2500000', 'CONFIRMED')`,
    ).run(depositId, clientId, authorizationId);

    // A config value an operator changed from the seeded default -- must not be reset back on restart.
    setConfig(db1, "dust_threshold_usd_micros", "2000000");
    assert.equal(getConfig(db1, "dust_threshold_usd_micros"), "2000000");

    db1.close();

    // --- Second startup against the SAME file: must not throw. ---
    const db2 = openDatabase(path);

    // --- Existing state must be completely intact. ---
    const clientRow = db2.prepare("SELECT * FROM clients WHERE id = ?").get(clientId) as any;
    assert.ok(clientRow, "client row must survive a restart");
    assert.equal(clientRow.wallet_pubkey, "RestartTestWallet111");

    const authRow = db2.prepare("SELECT * FROM client_asset_authorizations WHERE id = ?").get(authorizationId) as any;
    assert.ok(authRow, "authorization row must survive a restart");
    assert.equal(authRow.status, "ACTIVE");
    assert.equal(authRow.cumulative_credited_usd_micros, "2500000");

    const eventRows = db2.prepare("SELECT * FROM authorization_events WHERE client_asset_authorization_id = ?").all(authorizationId);
    assert.equal(eventRows.length, 1, "audit event must survive a restart");

    const depositRow = db2.prepare("SELECT * FROM deposits WHERE id = ?").get(depositId) as any;
    assert.ok(depositRow, "deposit row must survive a restart");
    assert.equal(depositRow.status, "CONFIRMED");
    assert.equal(depositRow.native_amount, "2500000");

    // The operator-changed config value must not have been silently reset
    // back to the seeded default by the second schema application.
    assert.equal(getConfig(db2, "dust_threshold_usd_micros"), "2000000", "existing config must never be overwritten by re-seeding on restart");

    // --- A normal DB operation must still work correctly post-restart:
    // every real constraint/trigger must still be in force (not silently
    // dropped or duplicated by the idempotent re-creation). ---
    const secondClientId = randomUUID();
    db2.prepare("INSERT INTO clients (id, wallet_pubkey) VALUES (?, ?)").run(secondClientId, "RestartTestWallet222");
    const secondClientRow = db2.prepare("SELECT * FROM clients WHERE id = ?").get(secondClientId);
    assert.ok(secondClientRow, "a fresh insert must still work normally after a restart");

    // The append-only trigger on deposits must still be active post-restart.
    assert.throws(() => {
      db2.prepare("UPDATE deposits SET native_amount = '999' WHERE id = ?").run(depositId);
    }, /financial fields are immutable/);

    // The one-PENDING-per-authorization partial unique index must still be active post-restart.
    db2.prepare(
      `INSERT INTO deposits (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, status)
       VALUES (?, ?, ?, 'SOL', 'restart-pending-1', 'wsolAta111', 'pooledWsolAta111', '1000', '1000', 'PENDING')`,
    ).run(randomUUID(), clientId, authorizationId);
    assert.throws(() => {
      db2.prepare(
        `INSERT INTO deposits (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, status)
         VALUES (?, ?, ?, 'SOL', 'restart-pending-2', 'wsolAta111', 'pooledWsolAta111', '1000', '1000', 'PENDING')`,
      ).run(randomUUID(), clientId, authorizationId);
    }, /UNIQUE constraint failed/);

    db2.close();

    // --- A THIRD startup must also succeed (idempotency isn't a one-time fluke). ---
    const db3 = openDatabase(path);
    const clientRowAgain = db3.prepare("SELECT * FROM clients WHERE id = ?").get(clientId);
    assert.ok(clientRowAgain, "data must still be present after a second restart");
    db3.close();
  } finally {
    cleanup(path);
  }
});
