"use client";

import { motion } from "framer-motion";
import clsx from "clsx";
import { TokenIcon } from "../ui/TokenIcon";
import { Badge } from "../ui/Card";
import { formatNativeAmount, formatUsdMicros } from "../../lib/format";

export interface AssetCardProps {
  assetKey: string;
  symbol: string;
  name: string;
  decimals: number;
  nativeAmount: string;
  usdValueMicros: string;
  selected: boolean;
  alreadyAuthorized?: boolean;
  onToggle: () => void;
}

export function AssetCard({ assetKey, symbol, name, decimals, nativeAmount, usdValueMicros, selected, alreadyAuthorized, onToggle }: AssetCardProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={clsx(
        "focus-ring group relative flex w-full items-center gap-4 rounded-xl2 border p-4 text-left transition-all duration-300 ease-premium",
        selected
          ? "border-accent/40 bg-accent/[0.06] shadow-glow"
          : "border-border/10 bg-white/[0.02] hover:border-border-strong/16 hover:bg-white/[0.04]",
      )}
    >
      <TokenIcon symbol={symbol} seed={assetKey} size={40} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-ink">{name}</p>
          {alreadyAuthorized && (
            <Badge tone="success" className="shrink-0">
              Authorized
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-[13px] tabular-nums text-ink-muted">
          {formatNativeAmount(nativeAmount, decimals)} {symbol}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <p className="text-sm font-medium tabular-nums text-ink">{formatUsdMicros(usdValueMicros)}</p>
        <div
          className={clsx(
            "flex h-5 w-5 items-center justify-center rounded-full border transition-all duration-200",
            selected ? "border-accent bg-accent" : "border-border-strong/25 bg-transparent group-hover:border-border-strong/40",
          )}
          aria-hidden
        >
          {selected && (
            <motion.svg initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }} width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 6.2l2.4 2.4 4.6-5" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </motion.svg>
          )}
        </div>
      </div>
    </button>
  );
}
