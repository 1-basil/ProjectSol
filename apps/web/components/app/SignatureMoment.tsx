"use client";

import { useEffect } from "react";
import { motion } from "framer-motion";

/** A deliberate visual beat between a confirmed signature and the processing screen -- not artificial delay of any backend call, purely the reveal animation. */
export function SignatureMoment({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 1800);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        className="flex h-20 w-20 items-center justify-center rounded-full bg-success/10 ring-1 ring-inset ring-success/25"
      >
        <motion.svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.5, delay: 0.3, ease: "easeOut" }}
        >
          <motion.path d="M5 13l4.5 4.5L19 7" stroke="rgb(var(--success))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </motion.svg>
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.4 }}
        className="mt-7 text-2xl font-semibold tracking-tight text-ink"
      >
        Authorization confirmed
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.5 }}
        className="mt-2 max-w-sm text-[15px] leading-relaxed text-ink-muted"
      >
        ProjectSol can now process your authorized assets according to the permissions you approved.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.6 }}
        className="mt-6 flex items-center gap-2 rounded-full border border-border/10 bg-white/[0.03] px-4 py-2"
      >
        <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M2.5 6.2l2.4 2.4 4.6-5" stroke="rgb(var(--success))" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[13px] font-medium text-ink">1 signature</span>
      </motion.div>
    </div>
  );
}
