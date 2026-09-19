"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotionPreference } from "../../lib/use-reduced-motion";

/** Animates a numeric value smoothly when it changes -- never invents a value, only tweens between two REAL values already provided by the caller. */
export function CountUp({ value, formatter, durationMs = 900 }: { value: number; formatter: (n: number) => string; durationMs?: number }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const reducedMotion = useReducedMotionPreference();

  useEffect(() => {
    if (reducedMotion) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    let raf = 0;
    function tick(now: number) {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (to - from) * eased);
      if (progress < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, durationMs, reducedMotion]);

  return <span className="tabular-nums">{formatter(display)}</span>;
}
