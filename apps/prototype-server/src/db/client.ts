// Thin wrapper over node:sqlite. Chosen specifically because it requires no
// native compilation (this machine has no MSVC Build Tools — the same gap
// that blocks cargo-build-sbf, see docs/PHASE-3-SBF-TOOLCHAIN-BLOCKER.md —
// and a native-addon driver like better-sqlite3 would hit the identical
// wall) and no server process to run, appropriate for a ~100-200-client
// prototype. Schema in ./schema.sql is applied once at startup; there is no
// migration history to preserve since this is a fresh database.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DUST_THRESHOLD_USD_MICROS = "1000000"; // $1.00, configurable — see platform_config

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  seedDefaultConfig(db);
  return db;
}

export function seedDefaultConfig(db: DatabaseSync): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO platform_config (key, value) VALUES (?, ?)",
  );
  // $1,000,000 per asset, at the 1e6 UsdMicros scale used throughout
  // packages/accounting: 1_000_000 * 1_000_000 = 1e12.
  insert.run("asset_cap_usd_micros", "1000000000000");
  insert.run("dust_threshold_usd_micros", DEFAULT_DUST_THRESHOLD_USD_MICROS);
  insert.run("max_spl_assets_per_client", "7");
  insert.run("oracle_max_staleness_secs", "60");
  insert.run("oracle_max_confidence_bps", "100");
  // Authorization and sweep are deliberately two separate events (see
  // src/sweep/sweepTiming.ts): a sweep only becomes eligible this many
  // seconds after the backend confirms/records an authorization. Anchored
  // to the persisted authorized_at column, never to a timer started at
  // request time or process start -- restart-safe by construction.
  insert.run("sweep_delay_secs", "12");
}

export function getConfig(db: DatabaseSync, key: string): string {
  const row = db.prepare("SELECT value FROM platform_config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) throw new Error(`platform_config: missing required key "${key}"`);
  return row.value;
}

/**
 * Wraps `fn` in a real SQL transaction (BEGIN IMMEDIATE / COMMIT, ROLLBACK on
 * throw). BEGIN IMMEDIATE takes the write lock up front rather than lazily,
 * so two DatabaseSync connections to the same file (two backend processes)
 * cannot interleave their writes inside the transaction body.
 *
 * Used specifically where two statements must land together or not at all —
 * e.g. marking a deposit CONFIRMED and crediting its authorization's
 * cumulative_credited_usd_micros. Without this, a crash between the two
 * statements would leave a deposit marked CONFIRMED whose value was never
 * added to the authorization's cap accounting (or vice versa), and nothing
 * would ever notice or re-run the missing half — see the "restart after
 * confirmation but before DB finalization" scenario in the concurrency
 * review this exists to close.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function setConfig(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO platform_config (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
}
