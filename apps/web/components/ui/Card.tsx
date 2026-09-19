"use client";

import clsx from "clsx";

export function Card({
  className,
  hoverable,
  strong,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { hoverable?: boolean; strong?: boolean }) {
  return (
    <div
      className={clsx(
        strong ? "glass-strong" : "glass",
        "rounded-2xl",
        hoverable && "transition-[border-color,box-shadow] duration-300 hover:border-white/25 hover:shadow-[0_0_40px_-12px_rgb(var(--accent)/0.55)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "danger" | "accent";
  className?: string;
  children: React.ReactNode;
}) {
  const toneClasses: Record<string, string> = {
    neutral: "bg-white/[0.06] text-ink-muted border-border/10",
    success: "bg-success/10 text-success border-success/20",
    warning: "bg-warning/10 text-warning border-warning/20",
    danger: "bg-danger/10 text-danger border-danger/20",
    accent: "bg-accent/10 text-accent border-accent/25",
  };
  return (
    <span
      className={clsx(
        "badge-flat inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = "neutral" }: { tone?: "neutral" | "success" | "warning" | "danger" | "accent" }) {
  const toneClasses: Record<string, string> = {
    neutral: "bg-ink-faint",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    accent: "bg-accent",
  };
  return <span className={clsx("h-1.5 w-1.5 rounded-full", toneClasses[tone])} aria-hidden />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("shimmer-bg animate-shimmer rounded-lg", className)} aria-hidden />;
}
