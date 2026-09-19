// RPC glue: fetches a client wallet's actual holdings, prices them, filters
// to the allowlist, and calls the pure selection logic in selectAssets.ts.
// This file is intentionally thin — every decision rule lives in the pure
// module so it's covered by cargo/node-test-style unit tests without an RPC.

import type { Connection, PublicKey } from "@solana/web3.js";
import type { DatabaseSync } from "node:sqlite";
import { computeUsdValueMicros } from "@platform/accounting";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "../solana/connection.ts";
import { getPrice, isPriceFreshEnough } from "../solana/priceCache.ts";
import { getConfig } from "../db/client.ts";
import { loadAllowlist, SOL_ASSET_KEY, NATIVE_SOL_DECIMALS, type AllowlistEntry } from "../allowlist/loadAllowlist.ts";
import { selectSplAssets, isSolEligible, type HeldAsset } from "./selectAssets.ts";

export interface WalletScanResult {
  readonly solEligible: boolean;
  readonly solHeldLamports: bigint;
  readonly solUsdValueMicros: bigint;
  readonly selectedSplAssets: readonly (HeldAsset & { entry: AllowlistEntry })[];
}

/**
 * Fetches on-chain holdings, prices every allowlisted asset the wallet
 * actually holds, and returns the selected set per the locked algorithm.
 * `alreadyAuthorizedAssetKeys` excludes assets the client has already
 * authorized (relevant on an "authorize more" run) — see selectAssets.ts.
 */
export async function scanWallet(
  connection: Connection,
  db: DatabaseSync,
  owner: PublicKey,
  alreadyAuthorizedAssetKeys: ReadonlySet<string>,
): Promise<WalletScanResult> {
  const dustThreshold = BigInt(getConfig(db, "dust_threshold_usd_micros"));
  const maxStalenessSecs = Number(getConfig(db, "oracle_max_staleness_secs"));
  const nowSecs = Math.floor(Date.now() / 1000);

  // --- SOL balance, SOL price, and both token-account lists are four
  // independent RPC calls -- previously issued one after another, now
  // dispatched together. Each keeps exactly the error handling it had
  // before (the SOL price fetch is still individually try/caught here; the
  // account list fetches are still unguarded, exactly as before, so a
  // failure there still rejects the whole scan just like it always did) --
  // only the fact that they now overlap in flight is new. ---
  const allowlist = loadAllowlist();
  const byMint = new Map(allowlist.map((e) => [e.mint, e]));

  const [solLamportsRaw, solPriceQuote, legacyAccounts, token2022Accounts] = await Promise.all([
    connection.getBalance(owner),
    (async () => {
      // A SOL price-fetch failure must not crash the whole scan either --
      // same isolation as the SPL loop below; SOL just becomes ineligible
      // for this scan (never valued at an invented price) rather than
      // aborting before the SPL holdings are even looked at.
      try {
        return await getPrice(db, SOL_ASSET_KEY);
      } catch (err) {
        console.error("price fetch failed for SOL during scan:", err);
        return undefined;
      }
    })(),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const solLamports = BigInt(solLamportsRaw);

  const solPriceFresh = solPriceQuote != null && isPriceFreshEnough(solPriceQuote, maxStalenessSecs, nowSecs);
  const solUsdValueMicros = solPriceFresh
    ? computeUsdValueMicros(solLamports, solPriceQuote!.price, NATIVE_SOL_DECIMALS)
    : 0n;
  const solEligible = solPriceFresh && isSolEligible({ heldLamports: solLamports, usdValueMicros: solUsdValueMicros }, dustThreshold);

  // --- SPL / Token-2022 holdings, filtered to the allowlist ---

  // Each held asset's price lookup (a cache read, or a live CoinGecko fetch
  // on a cache miss) is independent of every other's -- keyed by a distinct
  // mint, with the same per-asset try/catch isolation as before. Dispatching
  // them concurrently rather than one-at-a-time collapses what was
  // previously N sequential network round trips on a cold cache into one
  // wave; the DB reads/writes inside getPrice() are synchronous (node:sqlite)
  // so they can't interleave with each other regardless of await ordering,
  // and every asset is still validated and filtered exactly as before --
  // only wall-clock time changes, never which assets get selected or at
  // what price.
  const accounts = [...legacyAccounts.value, ...token2022Accounts.value];
  const priced = await Promise.all(
    accounts.map(async ({ account }) => {
      const info = account.data.parsed.info;
      const mint: string = info.mint;
      const entry = byMint.get(mint);
      if (!entry) return null; // not on the allowlist — never eligible, per spec

      const nativeAmount = BigInt(info.tokenAmount.amount);
      if (nativeAmount === 0n) return null;

      let priceQuote;
      try {
        priceQuote = await getPrice(db, mint);
      } catch (err) {
        console.error(`price fetch failed for ${mint} during scan:`, err);
        return null;
      }
      if (!isPriceFreshEnough(priceQuote, maxStalenessSecs, nowSecs)) return null; // unpriced -> never selected, never silently valued at 0 and included

      const usdValueMicros = computeUsdValueMicros(nativeAmount, priceQuote.price, entry.decimals);
      return { assetKey: mint, nativeAmount, usdValueMicros, entry };
    }),
  );

  const held: HeldAsset[] = [];
  const entryByAssetKey = new Map<string, AllowlistEntry>();
  for (const p of priced) {
    if (!p) continue;
    held.push({ assetKey: p.assetKey, nativeAmount: p.nativeAmount, usdValueMicros: p.usdValueMicros });
    entryByAssetKey.set(p.assetKey, p.entry);
  }

  const maxSplAssets = Number(getConfig(db, "max_spl_assets_per_client"));
  const selected = selectSplAssets({
    heldAssets: held,
    alreadyAuthorizedAssetKeys,
    dustThresholdUsdMicros: dustThreshold,
    maxSplAssets,
  });

  return {
    solEligible,
    solHeldLamports: solLamports,
    solUsdValueMicros,
    selectedSplAssets: selected.map((a) => ({ ...a, entry: entryByAssetKey.get(a.assetKey)! })),
  };
}
