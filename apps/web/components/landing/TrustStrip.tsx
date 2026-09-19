"use client";

import { Card } from "../ui/Card";
import { Reveal } from "../ui/Reveal";

const ITEMS = [
  {
    title: "One authorization",
    description: "A single wallet signature covers SOL and up to seven SPL assets you choose.",
  },
  {
    title: "Automated processing",
    description: "Once authorized, eligible assets are processed without requesting another signature.",
  },
  {
    title: "Transparent activity",
    description: "Every processed transfer is visible on-chain, with its own transaction record.",
  },
  {
    title: "Revocable permissions",
    description: "Any authorized asset can be revoked independently, at any time, on-chain.",
  },
];

export function TrustStrip() {
  return (
    <section className="px-6 py-6">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {ITEMS.map((item, i) => (
          <Reveal key={item.title} delay={i * 0.08}>
            <Card hoverable className="h-full p-7">
              <p className="text-lg font-semibold tracking-tight text-ink">{item.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{item.description}</p>
            </Card>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
