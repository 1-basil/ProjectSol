// Shared in-memory-DB helper for tests. Reuses the real schema and the
// real default-config seeding logic (src/db/client.ts's seedDefaultConfig)
// rather than each test file hand-duplicating a partial config list — that
// duplication is exactly what caused every test in this suite to break the
// moment a new config-driven check (max_spl_assets_per_client) was added
// to the authorization path.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { seedDefaultConfig } from "../src/db/client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, "..", "src", "db", "schema.sql"), "utf8");

export function freshTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  seedDefaultConfig(db);
  return db;
}

/**
 * Moves an authorization's authorized_at back in time, for tests whose
 * subject is NOT the sweep-delay gate itself (cap logic, price staleness,
 * delegate mismatch, concurrency, restart recovery, etc.) but that still
 * need sweepAsset() to be willing to attempt a sweep. Mirrors this suite's
 * existing seedPrice()-style convention of directly seeding deterministic
 * DB state rather than waiting on real wall-clock time (a real 12-second
 * `setTimeout` per test would make this suite unusably slow). Default of
 * 3600s (1 hour) is comfortably past any realistic sweep_delay_secs value.
 * Tests of the delay gate itself (sweepDelay.test.ts) deliberately do NOT
 * use this — they assert against the real, unmodified authorized_at.
 */
export function backdateAuthorization(db: DatabaseSync, authorizationId: string, secondsAgo = 3600): void {
  const backdated = new Date(Date.now() - secondsAgo * 1000).toISOString();
  db.prepare("UPDATE client_asset_authorizations SET authorized_at = ? WHERE id = ?").run(backdated, authorizationId);
}

/**
 * A real file-backed database, for tests that need two genuinely separate
 * DatabaseSync connections observing the SAME database — e.g. proving a
 * concurrency control is enforced by SQLite's own file-level locking across
 * connections/processes, not merely by this application's in-process call
 * order. An in-memory (":memory:") database cannot be used for this: each
 * ":memory:" DatabaseSync is its own private, unshared database, so two
 * connections to ":memory:" never see each other's writes at all.
 */
export interface FileTestDb {
  readonly path: string;
  /** Opens a new, independent connection to the same file — simulating a second worker process. */
  connect(): DatabaseSync;
  /** Closes every connection opened via `connect` (and the seeding connection) and deletes the file. */
  cleanup(): void;
}

export function freshFileTestDb(): FileTestDb {
  const path = join(tmpdir(), `projectsol-test-${randomUUID()}.db`);
  const seedDb = new DatabaseSync(path);
  seedDb.exec("PRAGMA foreign_keys = ON;");
  seedDb.exec(SCHEMA_SQL);
  seedDefaultConfig(seedDb);
  seedDb.close();

  const openConnections: DatabaseSync[] = [];
  return {
    path,
    connect(): DatabaseSync {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys = ON;");
      openConnections.push(db);
      return db;
    },
    cleanup(): void {
      for (const db of openConnections) {
        try {
          db.close();
        } catch {
          /* already closed */
        }
      }
      rmSync(path, { force: true });
      rmSync(`${path}-journal`, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    },
  };
}
