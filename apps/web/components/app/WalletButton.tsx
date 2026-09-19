"use client";

import { useState, useRef, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "../ui/Button";
import { WalletModal } from "./WalletModal";
import { truncateAddress } from "../../lib/format";
import { SOLANA_CLUSTER } from "../../lib/env";
import { explorerAddressUrl } from "../../lib/solana/explorer";

export function WalletButton() {
  const { connected, publicKey, disconnect } = useWallet();
  const [modalOpen, setModalOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setPopoverOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  if (!connected || !publicKey) {
    return (
      <>
        <Button onClick={() => setModalOpen(true)} size="md">
          Connect Wallet
        </Button>
        <WalletModal open={modalOpen} onClose={() => setModalOpen(false)} />
      </>
    );
  }

  const address = publicKey.toBase58();

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setPopoverOpen((v) => !v)}
        className="focus-ring glass flex items-center gap-2 rounded-full py-2 pl-2 pr-3.5 text-sm font-medium text-ink transition-colors hover:border-border-strong/20"
        aria-haspopup="menu"
        aria-expanded={popoverOpen}
      >
        <span className="h-2 w-2 rounded-full bg-success shadow-[0_0_8px_rgb(var(--success)/0.8)]" aria-hidden />
        <span className="tabular-nums">{truncateAddress(address)}</span>
      </button>

      <AnimatePresence>
        {popoverOpen && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            role="menu"
            className="glass-strong absolute right-0 top-[calc(100%+8px)] z-50 w-72 rounded-xl2 p-4 shadow-elevated"
          >
            <p className="text-[11px] uppercase tracking-wide text-ink-faint">Connected wallet</p>
            <p className="mt-1.5 break-all font-mono text-[13px] text-ink">{address}</p>
            <div className="mt-3 flex items-center justify-between row-well rounded-lg px-3 py-2">
              <span className="text-xs text-ink-muted">Network</span>
              <span className="text-xs font-medium capitalize text-ink">{SOLANA_CLUSTER.replace("-beta", "")}</span>
            </div>
            <a
              href={explorerAddressUrl(address)}
              target="_blank"
              rel="noreferrer"
              className="focus-ring mt-3 block rounded-lg py-2 text-center text-xs text-ink-muted transition-colors hover:bg-white/[0.04] hover:text-ink"
            >
              View on Explorer ↗
            </a>
            <button
              onClick={() => {
                disconnect();
                setPopoverOpen(false);
              }}
              className="focus-ring mt-1 w-full rounded-lg py-2 text-center text-xs font-medium text-danger transition-colors hover:bg-danger/10"
            >
              Disconnect
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
