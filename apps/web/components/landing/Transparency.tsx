"use client";

import { motion } from "framer-motion";
import { Card, Dot } from "../ui/Card";
import { SectionHeading } from "./HowItWorks";

const EXAMPLE_EVENTS = [
  { title: "Authorization confirmed", meta: "On-chain · one signature" },
  { title: "SOL processed", meta: "Transaction recorded" },
  { title: "USDC processed", meta: "Transaction recorded" },
];

export function Transparency() {
  return (
    <section className="px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="Transparency"
          title="Every transfer is a transaction you can inspect."
          description="ProjectSol never summarizes activity you can't verify — each processed transfer links directly to its own signature on Solana Explorer."
        />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-14 max-w-2xl"
        >
          <Card className="p-2">
            {EXAMPLE_EVENTS.map((event, i) => (
              <motion.div
                key={event.title}
                initial={{ opacity: 0, x: -10 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.4, delay: 0.15 + i * 0.12, ease: [0.16, 1, 0.3, 1] }}
                className={`flex items-center gap-4 px-5 py-4 ${i !== EXAMPLE_EVENTS.length - 1 ? "border-b border-border/8" : ""}`}
              >
                <Dot tone="success" />
                <div className="flex-1">
                  <p className="text-sm text-ink">{event.title}</p>
                  <p className="text-[12px] text-ink-faint">{event.meta}</p>
                </div>
                <span className="text-[12px] text-ink-faint">↗</span>
              </motion.div>
            ))}
          </Card>
        </motion.div>
      </div>
    </section>
  );
}
