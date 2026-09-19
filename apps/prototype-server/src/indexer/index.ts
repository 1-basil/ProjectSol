// Polling indexer: periodically attempts a sweep for every ACTIVE
// authorization, and separately upgrades CONFIRMED deposits to FINALIZED
// once the network actually finalizes them. No artificial delay anywhere —
// each pass does exactly the work that's ready; the interval only bounds
// how quickly a newly-confirmed authorization or newly-arrived top-up gets
// noticed, it is not a designed-in processing delay.

import type { Connection, Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import type { DatabaseSync } from "node:sqlite";
import { getPrice, isPriceFreshEnough } from "../solana/priceCache.ts";
import { getConfig } from "../db/client.ts";
import { sweepAsset } from "../sweep/sweepAsset.ts";
import { rowFromDb } from "../authorization/authorizationStore.ts";
import { tokenProgramIdFor } from "../authorization/splAuthorization.ts";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "../solana/connection.ts";
import { loadAllowlist, SOL_ASSET_KEY, NATIVE_SOL_DECIMALS } from "../allowlist/loadAllowlist.ts";
import { toPooledSigner } from "../solana/pooledSigner.ts";
import { COMPANY_RECEIVING_WALLET } from "../solana/companyReceivingWallet.ts";

export interface IndexerDeps {
  readonly connection: Connection;
  readonly db: DatabaseSync;
  readonly pooledWallet: Keypair;
}

// Exported for direct, interval-free testing of a single pass's behavior
// (e.g. per-asset price-failure isolation) -- startIndexer's own callers
// still just use startIndexer.
export async function sweepPass(deps: IndexerDeps): Promise<void> {
  const rows = deps.db.prepare("SELECT * FROM client_asset_authorizations WHERE status = 'ACTIVE'").all() as any[];
  const maxStalenessSecs = Number(getConfig(deps.db, "oracle_max_staleness_secs"));
  const nowSecs = Math.floor(Date.now() / 1000);

  for (const row of rows) {
    const isSol = row.asset_key === SOL_ASSET_KEY;
    const entry = isSol ? null : loadAllowlist().find((e) => e.mint === row.asset_key);
    if (!isSol && !entry) continue; // asset dropped from the allowlist snapshot — never swept silently

    const decimals = isSol ? NATIVE_SOL_DECIMALS : entry!.decimals;
    const programId = isSol ? TOKEN_PROGRAM_ID : tokenProgramIdFor(entry!);
    const mint = isSol ? NATIVE_MINT : new PublicKey(row.asset_key);

    // A price-fetch failure (CoinGecko timeout, rate limit, malformed
    // response) for THIS asset must never abort the pass for every other
    // client/asset -- isolated here, per-row, exactly like the sweepAsset
    // try/catch below it. Falls through to "skip this asset this pass" the
    // same way a stale price already does; the next pass retries.
    let priceQuote;
    try {
      priceQuote = await getPrice(deps.db, row.asset_key);
    } catch (err) {
      console.error(`price fetch failed for ${row.asset_key} / client ${row.client_id}:`, err);
      continue;
    }
    if (!isPriceFreshEnough(priceQuote, maxStalenessSecs, nowSecs)) continue;

    // The pooled wallet remains the fee payer/signer for creating this
    // account (it's the only signing authority the indexer holds); the
    // account's OWNER -- where the swept funds actually end up -- is
    // always the fixed company receiving wallet, never the pooled wallet
    // and never anything client-supplied.
    const pooledDestination = await getOrCreateAssociatedTokenAccount(
      deps.connection,
      deps.pooledWallet,
      mint,
      COMPANY_RECEIVING_WALLET,
      false,
      "confirmed",
      undefined,
      programId,
    );

    const authorization = rowFromDb(row);

    try {
      const result = await sweepAsset(authorization, {
        connection: deps.connection,
        db: deps.db,
        pooledWallet: toPooledSigner(deps.pooledWallet),
        pooledDestinationAccount: pooledDestination.address,
        programId,
        decimals,
        price: priceQuote.price,
      });
      if (result.swept) {
        console.log(`swept ${row.asset_key} for client ${row.client_id}: ${result.txSignature}`);
      }
    } catch (err) {
      console.error(`sweep failed for ${row.asset_key} / client ${row.client_id}:`, err);
    }
  }
}

async function finalityPass(deps: IndexerDeps): Promise<void> {
  const pending = deps.db.prepare("SELECT id, tx_signature FROM deposits WHERE status = 'CONFIRMED'").all() as {
    id: string;
    tx_signature: string;
  }[];
  for (const row of pending) {
    const status = await deps.connection.getSignatureStatus(row.tx_signature, { searchTransactionHistory: true });
    if (status.value?.confirmationStatus === "finalized") {
      deps.db.prepare("UPDATE deposits SET status = 'FINALIZED', finalized_at = datetime('now') WHERE id = ?").run(row.id);
    }
  }
}

export function startIndexer(deps: IndexerDeps, intervalMs = 4000): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      await sweepPass(deps).catch((e) => console.error("sweepPass error:", e));
      await finalityPass(deps).catch((e) => console.error("finalityPass error:", e));
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  loop();
  return () => {
    stopped = true;
  };
}
