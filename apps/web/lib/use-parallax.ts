"use client";

import { useEffect, useRef } from "react";
import { useMotionValue, useSpring } from "framer-motion";
import { useReducedMotionPreference } from "./use-reduced-motion";

/**
 * Tracks pointer position within `ref`'s element as a small, spring-damped
 * offset -- for a subtle depth/parallax cue, never a literal cursor-follow.
 * Returns motion values (not React state) so the caller can bind them
 * directly to a style prop without re-rendering on every pointer move.
 * A no-op (fixed at 0,0) under prefers-reduced-motion.
 */
export function useParallax<T extends HTMLElement>(strength = 16) {
  const ref = useRef<T>(null);
  const reducedMotion = useReducedMotionPreference();
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const x = useSpring(rawX, { stiffness: 60, damping: 20, mass: 0.6 });
  const y = useSpring(rawY, { stiffness: 60, damping: 20, mass: 0.6 });

  useEffect(() => {
    if (reducedMotion) return;
    const el = ref.current;
    if (!el) return;

    function onPointerMove(e: PointerEvent) {
      const rect = el!.getBoundingClientRect();
      const fracX = (e.clientX - rect.left) / rect.width - 0.5;
      const fracY = (e.clientY - rect.top) / rect.height - 0.5;
      rawX.set(fracX * strength);
      rawY.set(fracY * strength);
    }
    function onPointerLeave() {
      rawX.set(0);
      rawY.set(0);
    }

    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerleave", onPointerLeave);
    return () => {
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [reducedMotion, strength, rawX, rawY]);

  return { ref, x, y };
}
