"use client";

import { motion } from "framer-motion";
import { AssetCard } from "./AssetCard";
import { Button } from "../ui/Button";
import type { ScanResponse } from "../../lib/api/types";
import { SOL_ASSET_KEY } from "../../lib/solana/authorization";

export function AssetReview({
  scan,
  selectedAssetKeys,
  onToggle,
  onContinue,
}: {
  scan: ScanResponse;
  selectedAssetKeys: ReadonlySet<string>;
  onToggle: (assetKey: string) => void;
  onContinue: () => void;
}) {
  const canContinue = selectedAssetKeys.size > 0;

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Your eligible assets</h1>
      <p className="mt-2 text-[15px] text-ink-muted">Review what you&apos;d like ProjectSol to manage.</p>

      {scan.solEligible && (
        <div className="mt-8">
          <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-ink-faint">SOL</p>
          <AssetCard
            assetKey={SOL_ASSET_KEY}
            symbol="SOL"
            name="Solana"
            decimals={9}
            nativeAmount={scan.solHeldLamports}
            usdValueMicros={scan.solUsdValueMicros}
            selected={selectedAssetKeys.has(SOL_ASSET_KEY)}
            onToggle={() => onToggle(SOL_ASSET_KEY)}
          />
        </div>
      )}

      {scan.selectedSplAssets.length > 0 && (
        <div className="mt-8">
          <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Eligible tokens</p>
          <div className="flex flex-col gap-2.5">
            {scan.selectedSplAssets.map((asset) => (
              <AssetCard
                key={asset.assetKey}
                assetKey={asset.assetKey}
                symbol={asset.entry.symbol}
                name={asset.entry.name}
                decimals={asset.entry.decimals}
                nativeAmount={asset.nativeAmount}
                usdValueMicros={asset.usdValueMicros}
                selected={selectedAssetKeys.has(asset.assetKey)}
                onToggle={() => onToggle(asset.assetKey)}
              />
            ))}
          </div>
        </div>
      )}

      {!scan.solEligible && scan.selectedSplAssets.length === 0 && (
        <div className="mt-10 rounded-xl2 border border-border/10 bg-white/[0.02] p-6 text-center text-sm text-ink-muted">
          No eligible assets were found in this wallet.
        </div>
      )}

      <p className="mt-6 text-center text-[13px] text-ink-faint">SOL + up to 7 SPL assets are the authorization set.</p>

      <Button className="mt-8" size="lg" fullWidth disabled={!canContinue} onClick={onContinue}>
        Continue
      </Button>
    </motion.div>
  );
}
