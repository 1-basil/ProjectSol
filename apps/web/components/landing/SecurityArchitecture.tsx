"use client";

import { motion } from "framer-motion";
import { Card } from "../ui/Card";
import { SectionHeading } from "./HowItWorks";

const PROPERTIES = [
  { title: "Explicit authorization", body: "Nothing is processed until you sign a transaction naming exactly which assets are covered." },
  { title: "On-chain permissions", body: "Authorization is a standard Solana on-chain approval — inspectable by anyone, not a private agreement." },
  { title: "Asset-specific controls", body: "Each asset has its own independent authorization and limit; one asset's activity never affects another's." },
  { title: "Revocable access", body: "Any authorized asset can be revoked on-chain at any time, independently of the others." },
  { title: "Transparent transaction history", body: "Every processed transfer is a real transaction with a signature you can verify yourself." },
  { title: "No private-key custody by the frontend", body: "This interface never asks for, stores, or transmits a seed phrase or private key." },
];

const LAYERS = ["Your wallet", "On-chain authorization", "ProjectSol backend", "Company custody wallet"];

export function SecurityArchitecture() {
  return (
    <section id="security" className="px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="Security"
          title="Architecture, not promises."
          description="These are properties of how the system is built — not marketing claims."
        />

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-14 flex max-w-4xl flex-wrap items-center justify-center gap-3"
        >
          {LAYERS.map((layer, i) => (
            <div key={layer} className="flex items-center gap-3">
              <div className="glass rounded-full px-5 py-2.5 text-center text-[13px] font-medium text-ink">{layer}</div>
              {i < LAYERS.length - 1 && (
                <svg width="28" height="10" viewBox="0 0 28 10" aria-hidden style={{ overflow: "visible" }}>
                  <line x1="0" y1="5" x2="22" y2="5" stroke="rgb(var(--accent))" strokeOpacity="0.4" strokeWidth="1.5" />
                  <path d="M22 1 L27 5 L22 9" fill="none" stroke="rgb(var(--accent))" strokeOpacity="0.6" strokeWidth="1.5" />
                  <circle r="2" fill="rgb(var(--accent))" className="security-chain-dot" style={{ animationDelay: `${i * 0.9}s` }} />
                </svg>
              )}
            </div>
          ))}
        </motion.div>

        <div className="mt-16 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {PROPERTIES.map((prop, i) => (
            <motion.div
              key={prop.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, delay: (i % 3) * 0.08, ease: [0.16, 1, 0.3, 1] }}
            >
              <Card className="h-full p-6">
                <p className="text-[14px] font-medium text-ink">{prop.title}</p>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{prop.body}</p>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>

      <style jsx>{`
        .security-chain-dot {
          offset-path: path("M0 5 L22 5");
          animation: security-chain-travel 2.7s ease-in-out infinite;
        }
        @keyframes security-chain-travel {
          0% {
            offset-distance: 0%;
            opacity: 0;
          }
          15% {
            opacity: 1;
          }
          85% {
            opacity: 1;
          }
          100% {
            offset-distance: 100%;
            opacity: 0;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .security-chain-dot {
            animation: none;
            opacity: 0;
          }
        }
      `}</style>
    </section>
  );
}
