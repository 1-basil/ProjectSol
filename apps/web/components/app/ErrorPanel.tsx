"use client";

import { motion } from "framer-motion";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";

export function ErrorPanel({ title, description, onRetry }: { title: string; description?: string; onRetry?: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <Card className="mx-auto max-w-md p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
            <path d="M10 6.5v4M10 13.5h.01" stroke="rgb(var(--danger))" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="10" cy="10" r="7.25" stroke="rgb(var(--danger))" strokeWidth="1.3" />
          </svg>
        </div>
        <p className="mt-4 text-[15px] font-medium text-ink">{title}</p>
        {description && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{description}</p>}
        {onRetry && (
          <Button className="mt-5" variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </Card>
    </motion.div>
  );
}

/** Maps a raw backend/network error into user-facing copy. Never surfaces a stack trace or internal message. */
export function friendlyErrorMessage(context: "wallet" | "network" | "authorize" | "sweep" | "revoke", raw?: string): { title: string; description: string } {
  if (raw && /reject|declin|denied/i.test(raw)) {
    return { title: "Signature declined", description: "You closed or rejected the request in your wallet." };
  }
  if (raw && /network|unreachable|fetch/i.test(raw)) {
    return { title: "ProjectSol is temporarily unavailable", description: "We couldn't reach the backend. Please try again in a moment." };
  }
  switch (context) {
    case "wallet":
      return { title: "Unsupported network", description: "Your wallet may be pointed at a different Solana network than ProjectSol." };
    case "authorize":
      return { title: "Authorization could not be confirmed", description: "The transaction may not have been confirmed on-chain. No assets were processed." };
    case "sweep":
      return { title: "Processing could not be completed", description: "ProjectSol will retry automatically. Your authorization remains valid." };
    case "revoke":
      return { title: "Revocation could not be confirmed", description: "The on-chain delegate may not have been removed yet. Please try again." };
    default:
      return { title: "Something went wrong", description: "Please try again." };
  }
}
