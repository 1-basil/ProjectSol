"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Card, Badge } from "../ui/Card";
import { SectionHeading } from "./HowItWorks";
import { useReducedMotionPreference } from "../../lib/use-reduced-motion";

const STAGES = [
  { label: "Authorized", tone: "neutral" as const },
  { label: "Processing", tone: "warning" as const },
  { label: "Completed", tone: "success" as const },
];

/** Illustrates the concept, not a real event -- cycles through the three
 * stages a real authorized asset visibly passes through, looping only as a
 * demonstration (never implying a specific transfer actually completed). */
function useStageDemo() {
  const [active, setActive] = useState(0);
  const reducedMotion = useReducedMotionPreference();

  useEffect(() => {
    if (reducedMotion) return;
    const interval = setInterval(() => setActive((i) => (i + 1) % STAGES.length), 2200);
    return () => clearInterval(interval);
  }, [reducedMotion]);

  return reducedMotion ? STAGES.length - 1 : active;
}

export function Automation() {
  const activeStage = useStageDemo();

  return (
    <section className="px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="Automation"
          title="After authorization, ProjectSol takes it from there."
          description="Every authorized asset moves through the same visible stages — no additional signature required at any point in this sequence."
        />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-14 max-w-2xl"
        >
          <Card className="p-7">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <motion.div
                  className="h-8 w-8 rounded-full bg-accent-gradient"
                  animate={activeStage === 1 ? { scale: [1, 1.08, 1] } : { scale: 1 }}
                  transition={{ duration: 1.1, repeat: activeStage === 1 ? Infinity : 0, ease: "easeInOut" }}
                  aria-hidden
                />
                <span className="text-sm font-medium text-ink">SOL</span>
              </div>
              <div className="flex items-center gap-2">
                {STAGES.map((stage, i) => (
                  <div key={stage.label} className="flex items-center gap-2">
                    <motion.div animate={{ scale: i === activeStage ? 1.08 : 1, opacity: i <= activeStage ? 1 : 0.45 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}>
                      <Badge tone={i <= activeStage ? stage.tone : "neutral"}>{stage.label}</Badge>
                    </motion.div>
                    {i < STAGES.length - 1 && (
                      <span className="relative text-ink-faint">
                        →
                        {i < activeStage && (
                          <motion.span className="absolute inset-0 text-accent" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
                            →
                          </motion.span>
                        )}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </motion.div>
      </div>
    </section>
  );
}
