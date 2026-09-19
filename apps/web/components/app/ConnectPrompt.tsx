"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { WalletModal } from "./WalletModal";

export function ConnectPrompt() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}>
        <Card className="max-w-md p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent-gradient shadow-glow">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h13A2.5 2.5 0 0 1 21 8.5v7A2.5 2.5 0 0 1 18.5 18h-13A2.5 2.5 0 0 1 3 15.5v-7Z" stroke="white" strokeWidth="1.5" />
              <path d="M16 12h.01" stroke="white" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="mt-6 text-xl font-semibold text-ink">Connect your wallet</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
            Connecting gives ProjectSol visibility into your eligible assets. Nothing moves merely by connecting.
          </p>
          <Button className="mt-7" size="lg" fullWidth onClick={() => setOpen(true)}>
            Connect Wallet
          </Button>
        </Card>
      </motion.div>
      <WalletModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
