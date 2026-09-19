import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import {
  getOrCreateClient,
  recordAuthorization,
  recordRevocation,
  getAuthorization,
  listActiveAuthorizations,
  updateCumulativeCredited,
  MaxSplAssetsExceededError,
} from "../src/authorization/authorizationStore.ts";
import { freshTestDb as freshDb } from "../testSupport/testDb.ts";

test("recording a new authorization creates a client and an APPROVED event", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  const { authorizationId, alreadyProcessed } = recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 1_000_000n,
    txSignature: "sig1",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(alreadyProcessed, false);

  const auth = getAuthorization(db, clientId, "USDC_MINT");
  assert.ok(auth);
  assert.equal(auth!.id, authorizationId);
  assert.equal(auth!.status, "ACTIVE");
  assert.equal(auth!.cumulativeCreditedUsdMicros, 0n);

  const events = db.prepare("SELECT * FROM authorization_events WHERE client_asset_authorization_id = ?").all(authorizationId);
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).event_type, "APPROVED");
});

test("processing the same authorization tx_signature twice is a no-op (replay protection)", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  const first = recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 1_000_000n,
    txSignature: "sig-dup",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });
  const second = recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 1_000_000n,
    txSignature: "sig-dup",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(first.alreadyProcessed, false);
  assert.equal(second.alreadyProcessed, true);

  const events = db.prepare("SELECT * FROM authorization_events WHERE tx_signature = 'sig-dup'").all();
  assert.equal(events.length, 1); // never double-logged
});

test("a second Approve for the same (client, asset) is a re-approval, updating the same row, not a second authorization", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  const first = recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 1_000_000n,
    txSignature: "sig1",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });
  const second = recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 5_000_000n, // client raised the approval
    txSignature: "sig2",
    authorizedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(first.authorizationId, second.authorizationId); // same row

  const all = db.prepare("SELECT * FROM client_asset_authorizations WHERE client_id = ?").all(clientId);
  assert.equal(all.length, 1); // never a second competing row/cap for the same asset

  const auth = getAuthorization(db, clientId, "USDC_MINT");
  assert.equal(auth!.originalAuthorizedNativeAmount, 5_000_000n);

  const events = db.prepare("SELECT event_type FROM authorization_events WHERE client_asset_authorization_id = ? ORDER BY created_at").all(
    first.authorizationId,
  );
  assert.deepEqual(events.map((e: any) => e.event_type), ["APPROVED", "RE_APPROVED"]);
});

test("revoking one asset's authorization does not touch a different asset's authorization for the same client", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  recordAuthorization(db, {
    clientId,
    assetKey: "SOL",
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: "wSOL_ATA",
    delegate: "PooledWallet",
    authorizedNativeAmount: 10_000_000_000n,
    txSignature: "sol-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });
  recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 1_000_000n,
    txSignature: "usdc-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });

  recordRevocation(db, clientId, "SOL", "sol-revoke", "2026-01-03T00:00:00.000Z");

  const sol = getAuthorization(db, clientId, "SOL");
  const usdc = getAuthorization(db, clientId, "USDC_MINT");
  assert.equal(sol!.status, "REVOKED");
  assert.equal(usdc!.status, "ACTIVE"); // completely unaffected

  const active = listActiveAuthorizations(db, clientId);
  assert.deepEqual(active.map((a) => a.assetKey), ["USDC_MINT"]);
});

test("revoking USDC does not revoke SOL, and vice versa (symmetric check)", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  recordAuthorization(db, {
    clientId,
    assetKey: "SOL",
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: "wSOL_ATA",
    delegate: "PooledWallet",
    authorizedNativeAmount: 10_000_000_000n,
    txSignature: "sol-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });
  recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 1_000_000n,
    txSignature: "usdc-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });

  recordRevocation(db, clientId, "USDC_MINT", "usdc-revoke", "2026-01-03T00:00:00.000Z");

  assert.equal(getAuthorization(db, clientId, "USDC_MINT")!.status, "REVOKED");
  assert.equal(getAuthorization(db, clientId, "SOL")!.status, "ACTIVE");
});

test("revocation is idempotent under a replayed tx_signature", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  recordAuthorization(db, {
    clientId,
    assetKey: "SOL",
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: "wSOL_ATA",
    delegate: "PooledWallet",
    authorizedNativeAmount: 10_000_000_000n,
    txSignature: "sol-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });
  const first = recordRevocation(db, clientId, "SOL", "revoke-sig", "2026-01-03T00:00:00.000Z");
  const second = recordRevocation(db, clientId, "SOL", "revoke-sig", "2026-01-03T00:00:01.000Z");
  assert.equal(first.alreadyProcessed, false);
  assert.equal(second.alreadyProcessed, true);
  const events = db.prepare("SELECT * FROM authorization_events WHERE tx_signature = 'revoke-sig'").all();
  assert.equal(events.length, 1);
});

test("updateCumulativeCredited only ever affects the named authorization row", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  const sol = recordAuthorization(db, {
    clientId,
    assetKey: "SOL",
    tokenProgram: "NATIVE_SOL",
    authorizedTokenAccount: "wSOL_ATA",
    delegate: "PooledWallet",
    authorizedNativeAmount: 10_000_000_000n,
    txSignature: "sol-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });
  const usdc = recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 1_000_000n,
    txSignature: "usdc-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });

  updateCumulativeCredited(db, usdc.authorizationId, 900_000n * 1_000_000n);

  assert.equal(getAuthorization(db, clientId, "USDC_MINT")!.cumulativeCreditedUsdMicros, 900_000n * 1_000_000n);
  assert.equal(getAuthorization(db, clientId, "SOL")!.cumulativeCreditedUsdMicros, 0n); // untouched
});

// ---- Replay protection at the deposits table level ----

test("the deposits table's UNIQUE(tx_signature) constraint rejects a duplicate transfer signature", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  const { authorizationId } = recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 1_000_000n,
    txSignature: "usdc-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });

  const insert = db.prepare(
    `INSERT INTO deposits (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, status)
     VALUES (?, ?, ?, 'USDC_MINT', 'transfer-sig-1', 'ATA1', 'PooledATA', '100', '100000000', 'CONFIRMED')`,
  );
  insert.run("d1", clientId, authorizationId);

  assert.throws(() => insert.run("d2", clientId, authorizationId), /UNIQUE constraint failed/);

  const rows = db.prepare("SELECT * FROM deposits WHERE tx_signature = 'transfer-sig-1'").all();
  assert.equal(rows.length, 1); // never credited twice
});

// ---- Immutability triggers (code-review fix #12) ----

test("the deposits table rejects mutation of financial fields, even via a direct UPDATE", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  const { authorizationId } = recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 1_000_000n,
    txSignature: "usdc-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });
  db.prepare(
    `INSERT INTO deposits (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, status)
     VALUES ('d1', ?, ?, 'USDC_MINT', 'sig-x', 'ATA1', 'PooledATA', '100', '100000000', 'CONFIRMED')`,
  ).run(clientId, authorizationId);

  assert.throws(() => db.prepare("UPDATE deposits SET native_amount = '999999' WHERE id = 'd1'").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM deposits WHERE id = 'd1'").run(), /append-only/);

  // Status transitions remain allowed — that's the whole point of PENDING -> CONFIRMED -> FINALIZED.
  db.prepare("UPDATE deposits SET status = 'FINALIZED', finalized_at = datetime('now') WHERE id = 'd1'").run();
  const row = db.prepare("SELECT status, native_amount FROM deposits WHERE id = 'd1'").get() as any;
  assert.equal(row.status, "FINALIZED");
  assert.equal(row.native_amount, "100"); // untouched
});

test("authorization_events rows can never be updated or deleted", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  recordAuthorization(db, {
    clientId,
    assetKey: "USDC_MINT",
    tokenProgram: "SPL_TOKEN",
    authorizedTokenAccount: "ATA1",
    delegate: "PooledWallet",
    authorizedNativeAmount: 1_000_000n,
    txSignature: "usdc-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.throws(() => db.prepare("UPDATE authorization_events SET event_type = 'REVOKED' WHERE tx_signature = 'usdc-auth'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM authorization_events WHERE tx_signature = 'usdc-auth'").run(), /append-only/);
});

// ---- Max-7-SPL-assets enforcement at the write path (code-review fix #2) ----

function authorizeNSplAssets(db: DatabaseSync, clientId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    recordAuthorization(db, {
      clientId,
      assetKey: `SPL_${i}`,
      tokenProgram: "SPL_TOKEN",
      authorizedTokenAccount: `ATA_${i}`,
      delegate: "PooledWallet",
      authorizedNativeAmount: 1_000_000n,
      txSignature: `sig_${i}`,
      authorizedAt: "2026-01-01T00:00:00.000Z",
    });
  }
}

test("an 8th SPL authorization is rejected even if submitted directly, bypassing the proposal step", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  authorizeNSplAssets(db, clientId, 7);

  assert.throws(
    () =>
      recordAuthorization(db, {
        clientId,
        assetKey: "SPL_EIGHTH",
        tokenProgram: "SPL_TOKEN",
        authorizedTokenAccount: "ATA_8",
        delegate: "PooledWallet",
        authorizedNativeAmount: 1_000_000n,
        txSignature: "sig_8",
        authorizedAt: "2026-01-01T00:00:00.000Z",
      }),
    MaxSplAssetsExceededError,
  );

  assert.equal(listActiveAuthorizations(db, clientId).length, 7); // unchanged
});

test("SOL never counts toward the 7-SPL ceiling — the 8th slot is always available for it", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  authorizeNSplAssets(db, clientId, 7);

  // SOL authorization must succeed even with 7 SPL assets already authorized.
  assert.doesNotThrow(() =>
    recordAuthorization(db, {
      clientId,
      assetKey: "SOL",
      tokenProgram: "NATIVE_SOL",
      authorizedTokenAccount: "wSOL_ATA",
      delegate: "PooledWallet",
      authorizedNativeAmount: 10_000_000_000n,
      txSignature: "sol-auth",
      authorizedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  assert.equal(listActiveAuthorizations(db, clientId).length, 8); // 7 SPL + SOL
});

test("re-approving an already-authorized SPL asset never counts as a new one against the ceiling", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  authorizeNSplAssets(db, clientId, 7);

  // Re-approving SPL_0 (already authorized) must succeed at 7-of-7.
  assert.doesNotThrow(() =>
    recordAuthorization(db, {
      clientId,
      assetKey: "SPL_0",
      tokenProgram: "SPL_TOKEN",
      authorizedTokenAccount: "ATA_0",
      delegate: "PooledWallet",
      authorizedNativeAmount: 5_000_000n,
      txSignature: "sig_0_reapprove",
      authorizedAt: "2026-01-02T00:00:00.000Z",
    }),
  );
  assert.equal(listActiveAuthorizations(db, clientId).length, 7);
});

test("revoking one SPL asset frees a slot for a new one", () => {
  const db = freshDb();
  const clientId = getOrCreateClient(db, "WalletAAA");
  authorizeNSplAssets(db, clientId, 7);
  recordRevocation(db, clientId, "SPL_0", "revoke-0", "2026-01-03T00:00:00.000Z");

  assert.doesNotThrow(() =>
    recordAuthorization(db, {
      clientId,
      assetKey: "SPL_NEW",
      tokenProgram: "SPL_TOKEN",
      authorizedTokenAccount: "ATA_NEW",
      delegate: "PooledWallet",
      authorizedNativeAmount: 1_000_000n,
      txSignature: "sig_new",
      authorizedAt: "2026-01-03T00:00:01.000Z",
    }),
  );
  assert.equal(listActiveAuthorizations(db, clientId).length, 7); // 6 original + SPL_NEW, SPL_0 revoked
});
