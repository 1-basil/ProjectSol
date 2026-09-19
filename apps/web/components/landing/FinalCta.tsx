"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { WalletModal } from "../app/WalletModal";

export function FinalCta() {
  const { connected } = useWallet();
  const [open, setOpen] = useState(false);

  return (
    <section className="px-6 py-28">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl border border-white/10 bg-black px-8 py-24 text-center sm:px-16"
      >
        <div className="pointer-events-none absolute inset-0 bg-grid-fade" aria-hidden />
        <h2 className="text-balance text-4xl font-bold tracking-[-0.03em] text-ink sm:text-6xl">Ready <span className="text-shimmer">when you are.</span></h2>
        <p className="mx-auto mt-5 max-w-md text-base sm:text-lg text-ink-muted">
          Connect your wallet to see which assets are eligible. Nothing is authorized until you explicitly approve it.
        </p>
        <div className="mt-8">
          {connected ? (
            <Link href="/app">
              <Button size="lg">Open dashboard</Button>
            </Link>
          ) : (
            <Button size="lg" onClick={() => setOpen(true)}>
              Connect Wallet
            </Button>
          )}
        </div>
      </motion.div>
      <WalletModal open={open} onClose={() => setOpen(false)} />
    </section>
  );
}
