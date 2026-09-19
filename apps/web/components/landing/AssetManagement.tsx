"use client";

import { motion } from "framer-motion";
import { Card, Badge } from "../ui/Card";
import { TokenIcon } from "../ui/TokenIcon";
import { SectionHeading } from "./HowItWorks";

const PREVIEW_TOKENS = [
  { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
];

export function AssetManagement() {
  return (
    <section id="product" className="px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="Asset management"
          title="SOL, kept separate. Up to seven SPL assets, ranked by value."
          description="ProjectSol never mixes native SOL with your token holdings. SOL is evaluated on its own; your top SPL assets by current USD value fill the remaining slots."
        />

        <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-5">
          <motion.div
            initial={{ opacity: 0, x: -16 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-2"
          >
            <Card className="flex h-full flex-col justify-between p-7">
              <div>
                <Badge tone="accent">Always separate</Badge>
                <div className="mt-5 flex items-center gap-3">
                  <TokenIcon symbol="SOL" seed="SOL" size={44} />
                  <div>
                    <p className="text-lg font-semibold text-ink">SOL</p>
                    <p className="text-[13px] text-ink-muted">Native Solana balance</p>
                  </div>
                </div>
              </div>
              <p className="mt-6 text-[13px] leading-relaxed text-ink-muted">
                SOL never competes with SPL tokens for a slot — it&apos;s authorized and processed independently, with its own $1,000,000 limit.
              </p>
            </Card>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 16 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-3"
          >
            <Card className="h-full p-7">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-ink">Eligible tokens</p>
                <span className="text-[12px] text-ink-faint">Ranked by current USD value</span>
              </div>
              <div className="mt-5 flex flex-col gap-2.5">
                {PREVIEW_TOKENS.map((t, i) => (
                  <motion.div
                    key={t.symbol}
                    initial={{ opacity: 0, x: -12 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true, margin: "-80px" }}
                    transition={{ duration: 0.45, delay: 0.2 + i * 0.1, ease: [0.16, 1, 0.3, 1] }}
                    whileHover={{ x: 3 }}
                    className="flex items-center justify-between row-well rounded-xl px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <TokenIcon symbol={t.symbol} seed={t.mint} size={30} />
                      <span className="text-sm text-ink">{t.symbol}</span>
                    </div>
                    <motion.div
                      initial={{ opacity: 0, scale: 0.7 }}
                      whileInView={{ opacity: 1, scale: 1 }}
                      viewport={{ once: true, margin: "-80px" }}
                      transition={{ duration: 0.35, delay: 0.45 + i * 0.1, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <Badge tone="success">Eligible</Badge>
                    </motion.div>
                  </motion.div>
                ))}
              </div>
            </Card>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
