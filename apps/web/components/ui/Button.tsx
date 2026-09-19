"use client";

import { forwardRef } from "react";
import { motion } from "framer-motion";
import clsx from "clsx";
import { useReducedMotionPreference } from "../../lib/use-reduced-motion";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart"> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary: "btn btn-primary relative overflow-hidden disabled:opacity-50",
  secondary: "btn btn-secondary",
  ghost: "btn btn-ghost text-ink-muted hover:text-ink",
  outline: "btn btn-secondary",
  danger: "btn btn-danger",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-9 px-3.5 text-[13px] gap-1.5 rounded-full",
  md: "h-11 px-5 text-sm gap-2 rounded-full",
  lg: "h-14 px-7 text-[15px] gap-2.5 rounded-full",
};

// Named variants so the child sweep can inherit the parent's hover state --
// a motion.span with pointer-events-none can never receive its own hover.
const buttonVariants = {
  rest: { scale: 1, y: 0 },
  hover: { scale: 1.02 },
  tap: { scale: 0.97 },
};

const sweepVariants = {
  rest: { x: "-140%", opacity: 0 },
  hover: { x: "340%", opacity: [0, 1, 0], transition: { duration: 0.7, ease: "easeInOut" } },
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", loading, fullWidth, disabled, children, ...props },
  ref,
) {
  const reducedMotion = useReducedMotionPreference();
  const isDisabled = disabled || loading;

  return (
    <motion.button
      ref={ref}
      disabled={isDisabled}
      initial="rest"
      animate="rest"
      whileHover={isDisabled || reducedMotion ? undefined : "hover"}
      whileTap={isDisabled || reducedMotion ? undefined : "tap"}
      variants={buttonVariants}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={clsx(
        "focus-ring inline-flex items-center justify-center whitespace-nowrap font-medium",
        "select-none",
        "disabled:cursor-not-allowed disabled:pointer-events-none",
        variantClasses[variant],
        sizeClasses[size],
        fullWidth && "w-full",
        className,
      )}
      {...props}
    >
      {/* Diagonal light sweep on hover -- primary CTA only, one pass, never looping. Inherits the button's "hover" variant since it can't receive its own (pointer-events-none). */}
      {variant === "primary" && !reducedMotion && (
        <motion.span aria-hidden variants={sweepVariants} className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12 bg-white/30" />
      )}
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-80" aria-hidden />
      )}
      <span className="relative">{children}</span>
    </motion.button>
  );
});
