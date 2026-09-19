"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, Dot } from "../ui/Card";
import { Button } from "../ui/Button";
import { useReducedMotionPreference } from "../../lib/use-reduced-motion";
import type { ProcessingState } from "../../lib/app-state";

function formatElapsed(ms: number): string {
  const totalTenths = Math.floor(ms / 100);
  const whole = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  return `${whole.toString().padStart(2, "0")}.${tenths}s`;
}

const STATE_LABEL: Record<ProcessingState, string> = {
  authorized: "Authorized",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
};

const STATE_TONE: Record<ProcessingState, "neutral" | "warning" | "success" | "danger"> = {
  authorized: "neutral",
  processing: "warning",
  completed: "success",
  failed: "danger",
};

export function ProcessingScreen({
  items,
  processingByAsset,
  sweepEligibleAtByAsset,
  authorizationStartedAt,
  authorizationElapsedMs,
  allCompleted,
  onContinue,
}: {
  items: readonly { assetKey: string; symbol: string }[];
  processingByAsset: ReadonlyMap<string, ProcessingState>;
  // Real sweep-eligibility timestamps from the backend (dashboard poll),
  // keyed by assetKey -- rendered as a live countdown, never a countdown
  // this component invents or starts on its own.
  sweepEligibleAtByAsset: ReadonlyMap<string, string>;
  authorizationStartedAt: number | null;
  authorizationElapsedMs: number | null;
  allCompleted: boolean;
  onContinue: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (allCompleted || !authorizationStartedAt) return;
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, [allCompleted, authorizationStartedAt]);

  const liveElapsedMs = authorizationElapsedMs ?? (authorizationStartedAt ? now - authorizationStartedAt : null);
  const reducedMotion = useReducedMotionPreference();

  const completedCount = items.filter((item) => {
    const s = processingByAsset.get(item.assetKey);
    return s === "completed" || s === "failed";
  }).length;
  const progressFraction = items.length > 0 ? completedCount / items.length : 0;

  const RADIUS = 42;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} className="mx-auto max-w-xl px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Automated processing</h1>

      {/* Progress ring reflects the real completed/total fraction across the
          authorized assets -- never a simulated or time-based fill. */}
      <div className="relative mx-auto mt-6 flex h-32 w-32 items-center justify-center">
        <svg width="112" height="112" viewBox="0 0 96 96" className="absolute -rotate-90">
          <circle cx="48" cy="48" r={RADIUS} fill="none" stroke="rgb(var(--border-strong) / 0.1)" strokeWidth="4" />
          <motion.circle
            cx="48"
            cy="48"
            r={RADIUS}
            fill="none"
            stroke={allCompleted ? "rgb(var(--success))" : "rgb(var(--accent))"}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            initial={{ strokeDashoffset: CIRCUMFERENCE }}
            animate={{ strokeDashoffset: CIRCUMFERENCE * (1 - progressFraction) }}
            transition={{ duration: reducedMotion ? 0 : 0.6, ease: [0.16, 1, 0.3, 1] }}
          />
        </svg>
        <p className="font-mono text-2xl font-semibold tabular-nums text-accent">
          {liveElapsedMs !== null ? formatElapsed(liveElapsedMs) : "—"}
        </p>
      </div>

      <AnimatePresence mode="wait">
        {allCompleted && (
          <motion.p
            key="completed-label"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-2 text-sm font-medium text-success"
          >
            Completed
          </motion.p>
        )}
      </AnimatePresence>

      <Card className="mt-8 divide-y divide-border/10 p-1.5 text-left">
        {items.map((item) => {
          const state = processingByAsset.get(item.assetKey) ?? "authorized";
          // Real, backend-sourced remaining time until this authorization's
          // sweep becomes eligible -- the target timestamp comes from the
          // last dashboard poll; only the tick between polls is local,
          // exactly like the elapsed-time display above. Never shown once
          // the backend reports it eligible or once sweeping has started.
          const eligibleAtIso = sweepEligibleAtByAsset.get(item.assetKey);
          const remainingSecs = state === "authorized" && eligibleAtIso ? Math.ceil((Date.parse(eligibleAtIso) - now) / 1000) : null;
          const label = remainingSecs !== null && remainingSecs > 0 ? `Authorized · sweeping in ${remainingSecs}s` : STATE_LABEL[state];
          return (
            <motion.div
              key={item.assetKey}
              className="flex items-center justify-between px-4 py-3.5"
              animate={state === "processing" ? { backgroundColor: ["rgba(255,255,255,0)", "rgba(255,255,255,0.03)", "rgba(255,255,255,0)"] } : { backgroundColor: "rgba(255,255,255,0)" }}
              transition={{ duration: 1.8, repeat: state === "processing" && !reducedMotion ? Infinity : 0, ease: "easeInOut" }}
            >
              <span className="text-sm font-medium text-ink">{item.symbol}</span>
              <span className="flex items-center gap-2 text-[13px] text-ink-muted">
                <motion.span animate={state === "processing" && !reducedMotion ? { opacity: [1, 0.4, 1] } : { opacity: 1 }} transition={{ duration: 1.2, repeat: state === "processing" && !reducedMotion ? Infinity : 0, ease: "easeInOut" }}>
                  <Dot tone={STATE_TONE[state]} />
                </motion.span>
                <AnimatePresence mode="wait">
                  <motion.span key={state} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.25 }}>
                    {label}
                  </motion.span>
                </AnimatePresence>
              </span>
            </motion.div>
          );
        })}
      </Card>

      {allCompleted && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}>
          <Button className="mt-8" size="lg" fullWidth onClick={onContinue}>
            Go to dashboard
          </Button>
        </motion.div>
      )}
    </motion.div>
  );
}
