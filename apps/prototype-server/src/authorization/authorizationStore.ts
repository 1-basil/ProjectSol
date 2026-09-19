// DB access for client_asset_authorizations + authorization_events. Shared
// by both the SOL/wSOL and SPL authorization paths — the per-asset model is
// identical for both once an authorized_token_account exists; only how that
// account/authorization comes into being differs (see solAuthorization.ts
// vs splAuthorization.ts).

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { getConfig } from "../db/client.ts";
import { SOL_ASSET_KEY } from "../allowlist/loadAllowlist.ts";

export class MaxSplAssetsExceededError extends Error {
  constructor(clientId: string, limit: number) {
    super(`recordAuthorization: client ${clientId} already has ${limit} active SPL authorizations`);
    this.name = "MaxSplAssetsExceededError";
  }
}

/** Count of a client's currently-ACTIVE SPL authorizations — SOL is never counted, per the locked "SOL separate from the 7" rule. */
function countActiveSplAuthorizations(db: DatabaseSync, clientId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as n FROM client_asset_authorizations WHERE client_id = ? AND status = 'ACTIVE' AND asset_key != ?")
    .get(clientId, SOL_ASSET_KEY) as { n: number };
  return row.n;
}

export interface ClientAssetAuthorizationRow {
  readonly id: string;
  readonly clientId: string;
  readonly assetKey: string;
  readonly tokenProgram: "SPL_TOKEN" | "TOKEN_2022" | "NATIVE_SOL";
  readonly authorizedTokenAccount: string;
  readonly delegate: string;
  readonly originalAuthorizedNativeAmount: bigint;
  readonly authorizationTxSignature: string;
  readonly authorizedAt: string;
  readonly status: "ACTIVE" | "REVOKED";
  readonly revokedAt: string | null;
  readonly cumulativeCreditedUsdMicros: bigint;
  readonly assetCapUsdMicros: bigint;
}

export function rowFromDb(r: any): ClientAssetAuthorizationRow {
  return {
    id: r.id,
    clientId: r.client_id,
    assetKey: r.asset_key,
    tokenProgram: r.token_program,
    authorizedTokenAccount: r.authorized_token_account,
    delegate: r.delegate,
    originalAuthorizedNativeAmount: BigInt(r.original_authorized_native_amount),
    authorizationTxSignature: r.authorization_tx_signature,
    authorizedAt: r.authorized_at,
    status: r.status,
    revokedAt: r.revoked_at,
    cumulativeCreditedUsdMicros: BigInt(r.cumulative_credited_usd_micros),
    assetCapUsdMicros: BigInt(r.asset_cap_usd_micros),
  };
}

export function getOrCreateClient(db: DatabaseSync, walletPubkey: string): string {
  const existing = db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(walletPubkey) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare("INSERT INTO clients (id, wallet_pubkey) VALUES (?, ?)").run(id, walletPubkey);
  return id;
}

export function getAuthorization(db: DatabaseSync, clientId: string, assetKey: string): ClientAssetAuthorizationRow | null {
  const row = db
    .prepare("SELECT * FROM client_asset_authorizations WHERE client_id = ? AND asset_key = ?")
    .get(clientId, assetKey);
  return row ? rowFromDb(row) : null;
}

export function listActiveAuthorizations(db: DatabaseSync, clientId: string): ClientAssetAuthorizationRow[] {
  const rows = db
    .prepare("SELECT * FROM client_asset_authorizations WHERE client_id = ? AND status = 'ACTIVE'")
    .all(clientId);
  return rows.map(rowFromDb);
}

export interface RecordAuthorizationInput {
  readonly clientId: string;
  readonly assetKey: string;
  readonly tokenProgram: "SPL_TOKEN" | "TOKEN_2022" | "NATIVE_SOL";
  readonly authorizedTokenAccount: string;
  readonly delegate: string;
  readonly authorizedNativeAmount: bigint;
  readonly txSignature: string;
  readonly authorizedAt: string;
}

/**
 * Idempotent: if this exact tx_signature was already recorded as an
 * authorization_event for this SPECIFIC (client, asset), this is a no-op —
 * protects against the indexer processing the same confirmed transaction
 * twice. Scoped to (tx_signature, client, asset) rather than tx_signature
 * alone -- a single transaction legitimately authorizes multiple assets at
 * once (SOL plus up to 7 SPL assets, one client signature), so checking
 * tx_signature alone would treat every asset after the first one processed
 * under that signature as "already processed" and silently drop it. A NEW
 * authorization tx for an asset that already has a row is treated as a
 * re-approval (updates the current-state row, logs a new event) — never a
 * second competing cap.
 */
export function recordAuthorization(db: DatabaseSync, input: RecordAuthorizationInput): { authorizationId: string; alreadyProcessed: boolean } {
  const existingEvent = db
    .prepare(
      `SELECT ae.id FROM authorization_events ae
       JOIN client_asset_authorizations caa ON caa.id = ae.client_asset_authorization_id
       WHERE ae.tx_signature = ? AND caa.client_id = ? AND caa.asset_key = ?`,
    )
    .get(input.txSignature, input.clientId, input.assetKey) as { id: string } | undefined;

  const existing = getAuthorization(db, input.clientId, input.assetKey);
  if (existingEvent) {
    return { authorizationId: existing?.id ?? "", alreadyProcessed: true };
  }

  const assetCapUsdMicros = getConfig(db, "asset_cap_usd_micros");
  let authorizationId: string;
  let eventType: "APPROVED" | "RE_APPROVED";

  if (existing) {
    authorizationId = existing.id;
    eventType = "RE_APPROVED";
    db.prepare(
      `UPDATE client_asset_authorizations
       SET original_authorized_native_amount = ?, authorization_tx_signature = ?, authorized_at = ?, status = 'ACTIVE', revoked_at = NULL
       WHERE id = ?`,
    ).run(input.authorizedNativeAmount.toString(), input.txSignature, input.authorizedAt, authorizationId);
  } else {
    // Enforced here, at the actual write path — not merely relied upon at
    // the proposal/scan step, which a caller could bypass by submitting an
    // Approve directly. SOL never counts against this ceiling.
    if (input.assetKey !== SOL_ASSET_KEY) {
      const maxSplAssets = Number(getConfig(db, "max_spl_assets_per_client"));
      const activeCount = countActiveSplAuthorizations(db, input.clientId);
      if (activeCount >= maxSplAssets) {
        throw new MaxSplAssetsExceededError(input.clientId, maxSplAssets);
      }
    }
    authorizationId = randomUUID();
    eventType = "APPROVED";
    db.prepare(
      `INSERT INTO client_asset_authorizations
       (id, client_id, asset_key, token_program, authorized_token_account, delegate,
        original_authorized_native_amount, authorization_tx_signature, authorized_at,
        status, cumulative_credited_usd_micros, asset_cap_usd_micros)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', '0', ?)`,
    ).run(
      authorizationId,
      input.clientId,
      input.assetKey,
      input.tokenProgram,
      input.authorizedTokenAccount,
      input.delegate,
      input.authorizedNativeAmount.toString(),
      input.txSignature,
      input.authorizedAt,
      assetCapUsdMicros,
    );
  }

  db.prepare(
    `INSERT INTO authorization_events (id, client_asset_authorization_id, event_type, tx_signature, native_amount, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), authorizationId, eventType, input.txSignature, input.authorizedNativeAmount.toString(), input.authorizedAt);

  return { authorizationId, alreadyProcessed: false };
}

/**
 * Records a revocation. Only ever touches the ONE (client, asset) row named
 * — revoking one asset's authorization never reads or writes any other
 * asset's row, by construction (there is no shared/aggregate row to touch).
 */
export function recordRevocation(db: DatabaseSync, clientId: string, assetKey: string, txSignature: string, revokedAt: string): { alreadyProcessed: boolean } {
  // Scoped to (tx_signature, client, asset), same reasoning as
  // recordAuthorization above -- a single transaction could in principle
  // revoke multiple assets at once under one signature.
  const existingEvent = db
    .prepare(
      `SELECT ae.id FROM authorization_events ae
       JOIN client_asset_authorizations caa ON caa.id = ae.client_asset_authorization_id
       WHERE ae.tx_signature = ? AND caa.client_id = ? AND caa.asset_key = ?`,
    )
    .get(txSignature, clientId, assetKey);
  if (existingEvent) return { alreadyProcessed: true };

  const existing = getAuthorization(db, clientId, assetKey);
  if (!existing) throw new Error(`recordRevocation: no authorization found for client ${clientId} asset ${assetKey}`);

  db.prepare("UPDATE client_asset_authorizations SET status = 'REVOKED', revoked_at = ? WHERE id = ?").run(revokedAt, existing.id);
  db.prepare(
    `INSERT INTO authorization_events (id, client_asset_authorization_id, event_type, tx_signature, occurred_at)
     VALUES (?, ?, 'REVOKED', ?, ?)`,
  ).run(randomUUID(), existing.id, txSignature, revokedAt);

  return { alreadyProcessed: false };
}

/**
 * Reads the current value, adds in JS as BigInt, writes the result back as
 * a string — never delegates the arithmetic to SQLite's own CAST/INTEGER,
 * which is exactly the "arithmetic through a type that can silently lose
 * precision" this schema's TEXT-column convention exists to avoid.
 */
export function updateCumulativeCredited(db: DatabaseSync, authorizationId: string, additionalUsdMicros: bigint): void {
  const row = db
    .prepare("SELECT cumulative_credited_usd_micros FROM client_asset_authorizations WHERE id = ?")
    .get(authorizationId) as { cumulative_credited_usd_micros: string } | undefined;
  if (!row) throw new Error(`updateCumulativeCredited: no authorization row ${authorizationId}`);
  const newValue = BigInt(row.cumulative_credited_usd_micros) + additionalUsdMicros;
  db.prepare("UPDATE client_asset_authorizations SET cumulative_credited_usd_micros = ? WHERE id = ?").run(
    newValue.toString(),
    authorizationId,
  );
}
