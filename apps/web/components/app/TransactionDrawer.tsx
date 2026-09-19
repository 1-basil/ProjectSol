"use client";

import { Drawer } from "../ui/Drawer";
import { Badge } from "../ui/Card";
import { formatNativeAmount, formatUsdMicros, truncateAddress } from "../../lib/format";
import { explorerTxUrl } from "../../lib/solana/explorer";
import { SOLANA_CLUSTER } from "../../lib/env";
import type { DashboardTransfer } from "../../lib/api/types";

const STATUS_TONE = {
  PENDING: "warning",
  CONFIRMED: "success",
  FINALIZED: "success",
  FAILED: "danger",
} as const;

export function TransactionDrawer({
  open,
  onClose,
  transfer,
  symbol,
  decimals,
}: {
  open: boolean;
  onClose: () => void;
  transfer: DashboardTransfer | null;
  symbol: string;
  decimals: number | null;
}) {
  return (
    <Drawer open={open} onClose={onClose} title="Transaction details">
      {transfer && (
        <div className="flex flex-col gap-5">
          <Row label="Asset" value={symbol} />
          <Row label="Amount" value={decimals !== null ? `${formatNativeAmount(transfer.nativeAmount, decimals)} ${symbol}` : "Unavailable"} />
          <Row label="USD value" value={formatUsdMicros(transfer.usdValueMicros)} />
          <Row label="Source wallet" value={truncateAddress(transfer.sourceAccount, 6)} mono />
          <Row label="Destination" value={truncateAddress(transfer.destinationAccount, 6)} mono sublabel="Company receiving wallet" />
          <Row label="Signature" value={truncateAddress(transfer.txSignature, 6)} mono />
          <Row label="Timestamp" value={new Date(transfer.createdAt.endsWith("Z") ? transfer.createdAt : `${transfer.createdAt}Z`).toLocaleString()} />
          <Row label="Status" value={<Badge tone={STATUS_TONE[transfer.status]}>{transfer.status}</Badge>} />
          <Row label="Network" value={SOLANA_CLUSTER} />

          <a
            href={explorerTxUrl(transfer.txSignature)}
            target="_blank"
            rel="noreferrer"
            className="focus-ring mt-2 flex items-center justify-center rounded-xl border border-border-strong/16 py-3 text-sm font-medium text-ink transition-colors hover:bg-white/[0.04]"
          >
            View on Solana Explorer ↗
          </a>
        </div>
      )}
    </Drawer>
  );
}

function Row({ label, value, mono, sublabel }: { label: string; value: React.ReactNode; mono?: boolean; sublabel?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[13px] text-ink-muted">{label}</p>
        {sublabel && <p className="text-[11px] text-ink-faint">{sublabel}</p>}
      </div>
      <div className={mono ? "break-all text-right font-mono text-[13px] text-ink" : "text-right text-sm text-ink"}>{value}</div>
    </div>
  );
}
