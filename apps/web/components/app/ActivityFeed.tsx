"use client";

import { motion } from "framer-motion";
import { Card } from "../ui/Card";
import { formatRelativeTime } from "../../lib/format";
import { explorerTxUrl } from "../../lib/solana/explorer";
import type { DashboardResponse } from "../../lib/api/types";

interface FeedEntry {
  key: string;
  label: string;
  createdAt: string;
  txSignature: string;
}

/** Built ONLY from real transfers already present in the dashboard response -- never fabricates an activity event. */
export function ActivityFeed({ dashboard }: { dashboard: DashboardResponse }) {
  const entries: FeedEntry[] = dashboard.assets.flatMap((asset) =>
    asset.transfers.map((t) => ({
      key: t.txSignature,
      label:
        t.status === "FAILED"
          ? `${asset.symbol} processing failed`
          : t.status === "PENDING"
            ? `${asset.symbol} processing`
            : `${asset.symbol} processed`,
      createdAt: t.createdAt,
      txSignature: t.txSignature,
    })),
  );
  entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (entries.length === 0) {
    return <Card className="p-6 text-center text-sm text-ink-muted">No activity yet.</Card>;
  }

  return (
    <Card className="divide-y divide-border/10 p-1.5">
      {entries.map((entry, i) => (
        <motion.a
          key={entry.key}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: Math.min(i, 6) * 0.05, ease: [0.16, 1, 0.3, 1] }}
          whileHover={{ x: 2 }}
          href={explorerTxUrl(entry.txSignature)}
          target="_blank"
          rel="noreferrer"
          className="focus-ring flex items-center justify-between rounded-lg px-4 py-3.5 transition-colors hover:bg-white/[0.03]"
        >
          <span className="text-sm text-ink">{entry.label}</span>
          <span className="text-[12px] tabular-nums text-ink-faint">{formatRelativeTime(entry.createdAt)}</span>
        </motion.a>
      ))}
    </Card>
  );
}
