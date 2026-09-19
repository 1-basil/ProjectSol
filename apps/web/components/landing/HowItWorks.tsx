"use client";

import { Card } from "../ui/Card";
import { Badge } from "../ui/Card";
import { Reveal } from "../ui/Reveal";

const STEPS = [
  {
    number: "01",
    title: "Connect",
    heading: "Connect your Solana wallet.",
    body: "Connecting gives ProjectSol visibility into your eligible assets. Nothing moves merely by connecting.",
  },
  {
    number: "02",
    title: "Review",
    heading: "ProjectSol scans supported SOL and SPL assets.",
    body: "See SOL, token symbols, current USD values, eligibility, and which assets are selected.",
  },
  {
    number: "03",
    title: "Authorize",
    heading: "Review the assets and sign one authorization transaction.",
    body: "Your authorization determines which assets ProjectSol may process — nothing more.",
    highlight: "1 wallet signature",
  },
  {
    number: "04",
    title: "Automate",
    heading: "ProjectSol processes authorized assets automatically.",
    body: "Processing follows the permissions and limits displayed to you before you signed.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <SectionHeading eyebrow="How it works" title="Four steps. One signature." />

        <div className="mt-16 grid grid-cols-1 gap-5 md:grid-cols-2">
          {STEPS.map((step, i) => (
            <Reveal key={step.number} direction={i % 2 === 0 ? "left" : "right"} duration={0.55} delay={(i % 2) * 0.1}>
              <Card hoverable className="relative h-full overflow-hidden p-8">
                <span className="text-accent-gradient text-4xl font-bold tracking-tight">{step.number}</span>
                <h3 className="mt-3 text-sm font-medium uppercase tracking-wider text-ink-faint">{step.title}</h3>
                <p className="mt-3 text-2xl font-semibold leading-snug tracking-tight text-ink">{step.heading}</p>
                <p className="mt-3 text-[14px] leading-relaxed text-ink-muted">{step.body}</p>
                {step.highlight && (
                  <div className="mt-5">
                    <Badge tone="accent">{step.highlight}</Badge>
                  </div>
                )}
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-accent-gradient text-[13px] font-semibold uppercase tracking-[0.18em]">{eyebrow}</p>
      <h2 className="mt-4 text-balance text-4xl font-bold leading-[1.05] tracking-[-0.03em] text-ink sm:text-5xl">{title}</h2>
      {description && <p className="mt-5 text-base leading-relaxed text-ink-muted sm:text-lg">{description}</p>}
    </div>
  );
}
