"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, Badge, Dot } from "../ui/Card";
import { Button } from "../ui/Button";
import { CountUp } from "../ui/CountUp";
import { TokenIcon } from "../ui/TokenIcon";
import { ActivityFeed } from "./ActivityFeed";
import { RevokeModal } from "./RevokeModal";
import { TransactionDrawer } from "./TransactionDrawer";
import { formatUsdMicros, formatRelativeTime } from "../../lib/format";
import type { DashboardAsset, DashboardResponse, DashboardTransfer } from "../../lib/api/types";

function usdMicrosToNumber(v: string): number {
  return Number(BigInt(v)) / 1_000_000;
}

export function Dashboard({
  dashboard,
  decimalsByAssetKey,
  onRevokeAsset,
}: {
  dashboard: DashboardResponse;
  decimalsByAssetKey: ReadonlyMap<string, number>;
  onRevokeAsset: (assetKey: string) => Promise<boolean>;
}) {
  const [revokeTarget, setRevokeTarget] = useState<DashboardAsset | null>(null);
  const [openTransfer, setOpenTransfer] = useState<{ asset: DashboardAsset; transfer: DashboardTransfer } | null>(null);

  const totalUsd = usdMicrosToNumber(dashboard.totalCreditedUsdMicros);
  const activeAssets = dashboard.assets.filter((a) => a.status === "ACTIVE");

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Portfolio</p>
      <p className="mt-2 font-mono text-5xl font-semibold tracking-tight text-ink">
        <CountUp value={totalUsd} formatter={(n) => formatUsdMicros(BigInt(Math.round(n * 1_000_000)))} />
      </p>

      <div className="mt-10">
        <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Authorized assets</p>
        <Card className="divide-y divide-border/10 p-1.5">
          {dashboard.assets.map((asset, i) => {
            const lastTransfer = asset.transfers[asset.transfers.length - 1] ?? null;
            return (
              <motion.div
                key={asset.assetKey}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: i * 0.06, ease: [0.16, 1, 0.3, 1] }}
                className="flex items-center gap-4 px-4 py-4"
              >
                <TokenIcon symbol={asset.symbol} seed={asset.assetKey} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-ink">{asset.symbol}</p>
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div key={asset.status} initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={{ duration: 0.25 }}>
                        <Badge tone={asset.status === "ACTIVE" ? "success" : "neutral"}>
                          {asset.status === "ACTIVE" && (
                            <span className="relative flex h-1.5 w-1.5" aria-hidden>
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                            </span>
                          )}
                          {asset.status}
                        </Badge>
                      </motion.div>
                    </AnimatePresence>
                  </div>
                  <p className="mt-0.5 text-[12px] text-ink-muted">
                    Processed {formatUsdMicros(asset.cumulativeCreditedUsdMicros)} of {formatUsdMicros(asset.assetCapUsdMicros)} limit
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    {lastTransfer ? `Last activity ${formatRelativeTime(lastTransfer.createdAt)}` : "No activity yet"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {lastTransfer && (
                    <button
                      onClick={() => setOpenTransfer({ asset, transfer: lastTransfer })}
                      className="focus-ring rounded-lg px-2.5 py-1.5 text-[12px] text-ink-muted transition-colors hover:bg-white/[0.05] hover:text-ink"
                    >
                      Details
                    </button>
                  )}
                  {asset.status === "ACTIVE" && (
                    <Button variant="danger" size="sm" onClick={() => setRevokeTarget(asset)}>
                      Revoke
                    </Button>
                  )}
                </div>
              </motion.div>
            );
          })}
        </Card>
      </div>

      <div className="mt-10">
        <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Activity</p>
        <ActivityFeed dashboard={dashboard} />
      </div>

      {activeAssets.length === 0 && dashboard.assets.length > 0 && (
        <p className="mt-8 flex items-center justify-center gap-2 text-center text-[13px] text-ink-faint">
          <Dot tone="neutral" /> All authorizations have been revoked.
        </p>
      )}

      <RevokeModal
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        symbol={revokeTarget?.symbol ?? ""}
        onConfirm={async () => {
          if (!revokeTarget) return false;
          return onRevokeAsset(revokeTarget.assetKey);
        }}
      />

      <TransactionDrawer
        open={openTransfer !== null}
        onClose={() => setOpenTransfer(null)}
        transfer={openTransfer?.transfer ?? null}
        symbol={openTransfer?.asset.symbol ?? ""}
        decimals={openTransfer ? (decimalsByAssetKey.get(openTransfer.asset.assetKey) ?? null) : null}
      />
    </motion.div>
  );
}
