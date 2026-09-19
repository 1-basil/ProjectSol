"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const PHASES = ["Scanning your wallet", "Finding eligible assets...", "Calculating current values...", "Preparing your portfolio..."];

/**
 * The phase label advances on a timer purely for perceived narrative --
 * it never blocks or delays the actual transition to the review screen.
 * The parent unmounts this the instant the real /api/scan response
 * arrives, however far the label has gotten.
 */
export function ScanningScreen() {
  const [phaseIndex, setPhaseIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setPhaseIndex((i) => Math.min(i + 1, PHASES.length - 1));
    }, 900);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <div className="relative flex h-28 w-28 items-center justify-center">
        <motion.div
          className="absolute inset-0 rounded-full border border-accent/25"
          animate={{ scale: [1, 1.15, 1], opacity: [0.5, 0.15, 0.5] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute inset-3 rounded-full border border-accent/35"
          animate={{ scale: [1, 1.1, 1], opacity: [0.6, 0.25, 0.6] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut", delay: 0.3 }}
        />
        <motion.div
          className="h-3 w-3 rounded-full bg-accent shadow-glow"
          animate={{ scale: [1, 1.3, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      <div className="mt-8 h-7">
        <AnimatePresence mode="wait">
          <motion.p
            key={phaseIndex}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="text-[15px] font-medium text-ink"
          >
            {PHASES[phaseIndex]}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}
