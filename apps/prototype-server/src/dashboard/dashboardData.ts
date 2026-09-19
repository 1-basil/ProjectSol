// Read-only dashboard data assembly. Pure DB reads plus the same
// computeAssetHeadroomUsdMicros used everywhere else — no separate
// "dashboard math" that could drift from the authoritative cap logic.

import type { DatabaseSync } from "node:sqlite";
import { computeAssetHeadroomUsdMicros } from "../cap/capCheck.ts";
import { loadAllowlist, SOL_ASSET_KEY } from "../allowlist/loadAllowlist.ts";
import { getConfig } from "../db/client.ts";
import { isSweepDelayElapsed, sweepEligibleAtIso } from "../sweep/sweepTiming.ts";

export interface DashboardAssetView {
  readonly assetKey: string;
  readonly symbol: string;
  readonly status: "ACTIVE" | "REVOKED";
  readonly authorizedTokenAccount: string;
  readonly originalAuthorizedNativeAmount: string;
  readonly cumulativeCreditedUsdMicros: string;
  readonly assetCapUsdMicros: string;
  readonly remainingHeadroomUsdMicros: string;
  readonly authorizedAt: string;
  // Real, backend-computed values -- the frontend renders these directly
  // rather than running its own countdown. sweepEligible is recomputed on
  // every request against the current server clock, so a client polling
  // this endpoint sees the actual gate state, not a cached/stale guess.
  readonly sweepEligibleAt: string;
  readonly sweepEligible: boolean;
  readonly transfers: readonly DashboardTransferView[];
}

export interface DashboardTransferView {
  readonly txSignature: string;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly nativeAmount: string;
  readonly usdValueMicros: string;
  readonly status: "PENDING" | "CONFIRMED" | "FINALIZED" | "FAILED";
  readonly confirmedAt: string | null;
  readonly finalizedAt: string | null;
  readonly createdAt: string;
}

export interface DashboardView {
  readonly walletPubkey: string;
  readonly clientId: string;
  readonly assets: readonly DashboardAssetView[];
  readonly totalCreditedUsdMicros: string; // display-only sum; never fed back into any cap check
}

function symbolFor(assetKey: string): string {
  if (assetKey === SOL_ASSET_KEY) return "SOL";
  return loadAllowlist().find((e) => e.mint === assetKey)?.symbol ?? assetKey;
}

export function getDashboardView(db: DatabaseSync, walletPubkey: string): DashboardView | null {
  const client = db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(walletPubkey) as
    | { id: string }
    | undefined;
  if (!client) return null;

  const authRows = db
    .prepare("SELECT * FROM client_asset_authorizations WHERE client_id = ? ORDER BY authorized_at ASC")
    .all(client.id) as any[];

  const sweepDelaySecs = Number(getConfig(db, "sweep_delay_secs"));

  let totalCredited = 0n;
  const assets: DashboardAssetView[] = authRows.map((row) => {
    const headroom = computeAssetHeadroomUsdMicros({
      cumulativeCreditedUsdMicros: BigInt(row.cumulative_credited_usd_micros),
      assetCapUsdMicros: BigInt(row.asset_cap_usd_micros),
    });
    totalCredited += BigInt(row.cumulative_credited_usd_micros);

    const transferRows = db
      .prepare("SELECT * FROM deposits WHERE client_asset_authorization_id = ? ORDER BY created_at ASC")
      .all(row.id) as any[];

    return {
      assetKey: row.asset_key,
      symbol: symbolFor(row.asset_key),
      status: row.status,
      authorizedTokenAccount: row.authorized_token_account,
      originalAuthorizedNativeAmount: row.original_authorized_native_amount,
      cumulativeCreditedUsdMicros: row.cumulative_credited_usd_micros,
      assetCapUsdMicros: row.asset_cap_usd_micros,
      remainingHeadroomUsdMicros: headroom.toString(),
      authorizedAt: row.authorized_at,
      sweepEligibleAt: sweepEligibleAtIso(row.authorized_at, sweepDelaySecs),
      sweepEligible: isSweepDelayElapsed(row.authorized_at, sweepDelaySecs),
      transfers: transferRows.map((t) => ({
        txSignature: t.tx_signature,
        sourceAccount: t.source_account,
        destinationAccount: t.destination_account,
        nativeAmount: t.native_amount,
        usdValueMicros: t.usd_value_micros,
        status: t.status,
        confirmedAt: t.confirmed_at,
        finalizedAt: t.finalized_at,
        createdAt: t.created_at,
      })),
    };
  });

  return {
    walletPubkey,
    clientId: client.id,
    assets,
    totalCreditedUsdMicros: totalCredited.toString(),
  };
}
