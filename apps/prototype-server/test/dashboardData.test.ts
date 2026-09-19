import { test } from "node:test";
import assert from "node:assert/strict";
import { getOrCreateClient, recordAuthorization, updateCumulativeCredited } from "../src/authorization/authorizationStore.ts";
import { getDashboardView } from "../src/dashboard/dashboardData.ts";
import { freshTestDb as freshDb } from "../testSupport/testDb.ts";

test("dashboard returns null for a wallet with no client record yet", () => {
  const db = freshDb();
  assert.equal(getDashboardView(db, "UnknownWallet"), null);
});

test("dashboard shows each authorized asset's own cap/remaining/credited independently", () => {
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
    authorizedNativeAmount: 1_000_000_000n,
    txSignature: "usdc-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });

  updateCumulativeCredited(db, sol.authorizationId, 300_000n * 1_000_000n); // $300k credited on SOL
  updateCumulativeCredited(db, usdc.authorizationId, 900_000n * 1_000_000n); // $900k credited on USDC

  const view = getDashboardView(db, "WalletAAA")!;
  assert.equal(view.assets.length, 2);

  const solView = view.assets.find((a) => a.assetKey === "SOL")!;
  const usdcView = view.assets.find((a) => a.assetKey === "USDC_MINT")!;

  assert.equal(solView.cumulativeCreditedUsdMicros, (300_000n * 1_000_000n).toString());
  assert.equal(solView.remainingHeadroomUsdMicros, (700_000n * 1_000_000n).toString());

  assert.equal(usdcView.cumulativeCreditedUsdMicros, (900_000n * 1_000_000n).toString());
  assert.equal(usdcView.remainingHeadroomUsdMicros, (100_000n * 1_000_000n).toString());

  // Display-only total; not a cap input for either asset.
  assert.equal(view.totalCreditedUsdMicros, (1_200_000n * 1_000_000n).toString());
});

test("each asset's transfer list only contains that asset's own deposits", () => {
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
    authorizedNativeAmount: 1_000_000_000n,
    txSignature: "usdc-auth",
    authorizedAt: "2026-01-01T00:00:00.000Z",
  });

  const insert = db.prepare(
    `INSERT INTO deposits (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, status)
     VALUES (?, ?, ?, ?, ?, 'src', 'dst', '1000', '1000000', 'CONFIRMED')`,
  );
  insert.run("d1", clientId, sol.authorizationId, "SOL", "sol-transfer-1");
  insert.run("d2", clientId, usdc.authorizationId, "USDC_MINT", "usdc-transfer-1");

  const view = getDashboardView(db, "WalletAAA")!;
  const solView = view.assets.find((a) => a.assetKey === "SOL")!;
  const usdcView = view.assets.find((a) => a.assetKey === "USDC_MINT")!;

  assert.deepEqual(
    solView.transfers.map((t) => t.txSignature),
    ["sol-transfer-1"],
  );
  assert.deepEqual(
    usdcView.transfers.map((t) => t.txSignature),
    ["usdc-transfer-1"],
  );
});

test("dashboard exposes each transfer's source and destination account", () => {
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

  db.prepare(
    `INSERT INTO deposits (id, client_id, client_asset_authorization_id, asset_key, tx_signature, source_account, destination_account, native_amount, usd_value_micros, status)
     VALUES ('d1', ?, ?, 'SOL', 'sol-transfer-1', 'PooledWalletATA', 'CompanyReceivingWalletATA', '1000', '1000000', 'CONFIRMED')`,
  ).run(clientId, sol.authorizationId);

  const view = getDashboardView(db, "WalletAAA")!;
  const transfer = view.assets[0].transfers[0];
  assert.equal(transfer.sourceAccount, "PooledWalletATA");
  assert.equal(transfer.destinationAccount, "CompanyReceivingWalletATA");
});

test("a REVOKED asset still appears on the dashboard (visible status), it is not hidden", () => {
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
  db.prepare("UPDATE client_asset_authorizations SET status = 'REVOKED', revoked_at = '2026-01-02T00:00:00.000Z' WHERE client_id = ?").run(
    clientId,
  );

  const view = getDashboardView(db, "WalletAAA")!;
  assert.equal(view.assets[0].status, "REVOKED");
});
