"use client";

import { motion } from "framer-motion";

type Direction = "up" | "left" | "right" | "scale" | "none";

const OFFSETS: Record<Direction, { x?: number; y?: number; scale?: number }> = {
  up: { y: 20 },
  left: { x: -20 },
  right: { x: 20 },
  scale: { scale: 0.96 },
  none: {},
};

/**
 * Shared scroll-reveal primitive so every landing section animates in with
 * the same easing/feel instead of each one hand-rolling whileInView. Distinct
 * `direction`s per section are what keep the page from feeling like
 * everything appears on one timer.
 */
export function Reveal({
  children,
  direction = "up",
  delay = 0,
  duration = 0.6,
  className,
  once = true,
}: {
  children: React.ReactNode;
  direction?: Direction;
  delay?: number;
  duration?: number;
  className?: string;
  once?: boolean;
}) {
  const offset = OFFSETS[direction];
  return (
    <motion.div
      initial={{ opacity: 0, ...offset }}
      whileInView={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      viewport={{ once, margin: "-80px" }}
      transition={{ duration, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
