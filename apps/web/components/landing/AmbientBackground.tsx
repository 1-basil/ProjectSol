"use client";

import { motion } from "framer-motion";
import { useReducedMotionPreference } from "../../lib/use-reduced-motion";
import { useParallax } from "../../lib/use-parallax";

// A handful of fixed points for a very sparse, slow-breathing "light field" --
// deliberately few and dim so it reads as ambient depth, never as
// distracting particle effects.
const LIGHTS = [
  { top: "18%", left: "22%", delay: 0 },
  { top: "32%", left: "68%", delay: 1.4 },
  { top: "62%", left: "12%", delay: 2.8 },
  { top: "70%", left: "78%", delay: 0.7 },
  { top: "45%", left: "45%", delay: 2.1 },
];

/**
 * Slow ambient gradient orbs + a sparse breathing light field, with a subtle
 * pointer-parallax offset on the orb layer. Pure transform/opacity
 * animation (GPU-composited), and inert under prefers-reduced-motion.
 */
export function AmbientBackground() {
  const reducedMotion = useReducedMotionPreference();
  const { ref, x, y } = useParallax<HTMLDivElement>(14);

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
      <motion.div
        style={{ x, y }}
        className="absolute inset-0"
      >
        <motion.div
          className="absolute -left-[10%] top-[-10%] h-[520px] w-[520px] rounded-full bg-accent/25 blur-[110px]"
          animate={reducedMotion ? undefined : { x: [0, 40, -10, 0], y: [0, 25, 50, 0] }}
          transition={{ duration: 26, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute right-[-8%] top-[8%] h-[440px] w-[440px] rounded-full bg-accent-2/20 blur-[100px]"
          animate={reducedMotion ? undefined : { x: [0, -30, 20, 0], y: [0, 40, -20, 0] }}
          transition={{ duration: 32, repeat: Infinity, ease: "easeInOut", delay: 2 }}
        />
        <motion.div
          className="absolute bottom-[-15%] left-[30%] h-[380px] w-[380px] rounded-full bg-accent/10 blur-[100px]"
          animate={reducedMotion ? undefined : { x: [0, 25, -25, 0], y: [0, -20, 15, 0] }}
          transition={{ duration: 22, repeat: Infinity, ease: "easeInOut", delay: 1 }}
        />
      </motion.div>

      {!reducedMotion &&
        LIGHTS.map((light, i) => (
          <motion.span
            key={i}
            className="absolute h-1 w-1 rounded-full bg-white"
            style={{ top: light.top, left: light.left }}
            animate={{ opacity: [0, 0.5, 0] }}
            transition={{ duration: 5.5, repeat: Infinity, ease: "easeInOut", delay: light.delay }}
          />
        ))}
    </div>
  );
}
