"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";

// A wallet extension's Wallet Standard registration can still be finishing
// its internal connect-handshake wiring for a moment after page load --
// readyState already reports "Installed" by then, but calling connect()
// during that window silently does nothing (no error thrown, no popup, the
// connection just never completes). Empirically confirmed: waiting a
// couple seconds after page load before clicking reliably works. This
// gates the installed-wallet buttons on time since PAGE load (a module-
// scope timestamp), not time since this modal opened, so opening the modal
// well after the page has loaded -- the common case -- never waits at all.
const WALLET_SETTLE_MS = 1500;
const pageLoadAtMs = typeof window !== "undefined" ? Date.now() : 0;

export function WalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wallets, select, connect, connecting, connected, wallet } = useWallet();
  const { push } = useToast();
  const pendingSelection = useRef<WalletName | null>(null);
  const [settled, setSettled] = useState(() => Date.now() - pageLoadAtMs >= WALLET_SETTLE_MS);

  useEffect(() => {
    if (settled || !open) return;
    const remainingMs = WALLET_SETTLE_MS - (Date.now() - pageLoadAtMs);
    const t = setTimeout(() => setSettled(true), Math.max(remainingMs, 0));
    return () => clearTimeout(t);
  }, [open, settled]);

  // select() is async-by-effect in the adapter: it sets `wallet`, then we
  // connect once that selection has actually taken effect.
  useEffect(() => {
    if (!wallet || !pendingSelection.current || wallet.adapter.name !== pendingSelection.current) return;
    pendingSelection.current = null;
    connect().catch((err) => {
      push({ tone: "danger", title: "Signature declined", description: err instanceof Error ? err.message : "The wallet connection was cancelled." });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  useEffect(() => {
    if (connected) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed);
  const other = wallets.filter((w) => w.readyState !== WalletReadyState.Installed);

  // @solana/wallet-adapter-react persists the selected wallet's name to
  // localStorage (`walletName`) and its internal changeWallet() is a no-op
  // when the clicked name already matches the persisted one -- `wallet`
  // never changes, so the effect above (which only fires connect() in
  // response to a `wallet` change) never runs. Concretely: click Solflare,
  // it's already the persisted selection from an earlier click/visit, the
  // button shows "Detected" but does nothing at all on press -- no error,
  // no popup. Bypass select() entirely for that case and connect directly.
  function handleWalletClick(name: WalletName): void {
    if (wallet?.adapter.name === name) {
      connect().catch((err) => {
        push({ tone: "danger", title: "Signature declined", description: err instanceof Error ? err.message : "The wallet connection was cancelled." });
      });
      return;
    }
    pendingSelection.current = name;
    select(name);
  }

  return (
    <Modal open={open} onClose={onClose} title="Connect a wallet" description="Connecting only gives ProjectSol visibility into your eligible assets. Nothing moves until you explicitly authorize it.">
      <div className="flex flex-col gap-2">
        {installed.length === 0 && other.length === 0 && (
          <p className="rounded-xl bg-white/[0.03] p-4 text-sm text-ink-muted">No Solana wallets detected in this browser. Install Phantom, Solflare, or another wallet to continue.</p>
        )}
        {installed.map((w) => (
          <WalletRow
            key={w.adapter.name}
            name={w.adapter.name}
            icon={w.adapter.icon}
            label={settled ? "Detected" : "Detecting…"}
            onClick={() => handleWalletClick(w.adapter.name)}
            disabled={connecting || !settled}
          />
        ))}
        {other.length > 0 && (
          <>
            {installed.length > 0 && <div className="my-2 h-px bg-border/10" />}
            {other.map((w) => (
              <WalletRow
                key={w.adapter.name}
                name={w.adapter.name}
                icon={w.adapter.icon}
                label="Not installed"
                muted
                onClick={() => handleWalletClick(w.adapter.name)}
                disabled={connecting}
              />
            ))}
          </>
        )}
      </div>
      <p className="mt-5 text-center text-[12px] leading-relaxed text-ink-faint">
        ProjectSol never asks for your seed phrase or private key, at any step.
      </p>
    </Modal>
  );
}

function WalletRow({
  name,
  icon,
  label,
  muted,
  disabled,
  onClick,
}: {
  name: string;
  icon: string;
  label: string;
  muted?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="focus-ring group flex w-full items-center justify-between rounded-xl border border-transparent bg-white/[0.02] px-4 py-3.5 text-left transition-all duration-200 ease-premium hover:border-border-strong/14 hover:bg-white/[0.05] disabled:cursor-wait disabled:opacity-60"
    >
      <span className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={icon} alt="" width={28} height={28} className="rounded-md" />
        <span className={muted ? "text-sm text-ink-muted" : "text-sm font-medium text-ink"}>{name}</span>
      </span>
      <span className="text-[11px] uppercase tracking-wide text-ink-faint group-hover:text-ink-muted">{label}</span>
    </button>
  );
}
