"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { Button } from "../ui/Button";
import { WalletModal } from "../app/WalletModal";
import { HeroFlow } from "./HeroFlow";
import Hyperspeed from "../ui/Hyperspeed/Hyperspeed";

// Module-level constant so the WebGL scene is not recreated on re-render.
// Colours follow the Solana purple/green palette.
const HYPERSPEED_OPTIONS = {
  distortion: "turbulentDistortion",
  lanesPerRoad: 3,
  colors: {
    roadColor: 0x080808,
    islandColor: 0x0a0a0a,
    background: 0x000000,
    shoulderLines: 0x2a2a35,
    brokenLines: 0x2a2a35,
    leftCars: [0x9945ff, 0x7a35d1, 0xb46bff],
    rightCars: [0x14f195, 0x0fbf78, 0x5dfab9],
    sticks: 0x14f195,
  },
};

export function Hero() {
  const { connected } = useWallet();
  const [walletModalOpen, setWalletModalOpen] = useState(false);

  return (
    <section className="relative overflow-hidden px-6 pb-20 pt-40 sm:pb-28 sm:pt-48">
      <div className="pointer-events-none absolute inset-x-0 -top-[18%] -z-10 h-[118%] opacity-60" aria-hidden>
        <Hyperspeed effectOptions={HYPERSPEED_OPTIONS} />
      </div>
      <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-black/50 via-transparent to-black" aria-hidden />
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[900px] bg-grid-fade" aria-hidden />

      <div className="mx-auto max-w-5xl text-center">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-border/10 bg-white/[0.03] px-3.5 py-1.5 text-[12px] text-ink-muted"
        >
          <span className="relative flex h-1.5 w-1.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
          </span>
          Live on Solana
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16, clipPath: "inset(0 100% 0 0)" }}
          animate={{ opacity: 1, y: 0, clipPath: "inset(0 0% 0 0)" }}
          transition={{ duration: 0.9, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          className="text-balance text-5xl font-bold leading-[1.02] tracking-[-0.035em] text-ink sm:text-7xl md:text-[5.5rem]"
        >
          One signature.
          <br />
          <span className="text-shimmer animate-gradient-move">Automated asset management.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-7 max-w-2xl text-balance text-lg leading-relaxed text-ink-muted sm:text-xl"
        >
          Connect your Solana wallet, review eligible assets, authorize what you choose, and let ProjectSol handle the rest automatically.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
        >
          {connected ? (
            <Link href="/app">
              <Button size="lg">Open dashboard</Button>
            </Link>
          ) : (
            <Button size="lg" onClick={() => setWalletModalOpen(true)}>
              Connect Wallet
            </Button>
          )}
          <a href="#how-it-works">
            <Button size="lg" variant="secondary">
              See how it works
            </Button>
          </a>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.35 }}
          className="mt-5 text-[13px] text-ink-faint"
        >
          Connecting your wallet never moves funds.
        </motion.p>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="mx-auto mt-20 max-w-4xl"
      >
        <HeroFlow />
      </motion.div>

      <WalletModal open={walletModalOpen} onClose={() => setWalletModalOpen(false)} />
    </section>
  );
}
