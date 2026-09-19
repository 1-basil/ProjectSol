"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";

type Phase = "confirm" | "submitting" | "succeeded";

export function RevokeModal({
  open,
  onClose,
  symbol,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  onConfirm: () => Promise<boolean>;
}) {
  const [phase, setPhase] = useState<Phase>("confirm");

  // Reset to a clean slate every time the modal is (re)opened for a
  // (possibly different) asset.
  useEffect(() => {
    if (open) setPhase("confirm");
  }, [open]);

  async function handleConfirm() {
    setPhase("submitting");
    const succeeded = await onConfirm();
    if (succeeded) {
      setPhase("succeeded");
      // A brief, deliberate beat before closing -- long enough to register
      // as a real confirmation, short enough not to feel like a delay.
      setTimeout(onClose, 1100);
    } else {
      // Failure is already surfaced via toast; let the user see the dialog
      // again to retry or cancel rather than silently closing.
      setPhase("confirm");
    }
  }

  return (
    <Modal
      open={open}
      onClose={phase === "submitting" ? () => {} : onClose}
      title={phase === "succeeded" ? undefined : "Revoke authorization?"}
      description={phase === "succeeded" ? undefined : `After revocation is confirmed on-chain, ProjectSol will no longer be able to process ${symbol} under this authorization.`}
    >
      <AnimatePresence mode="wait">
        {phase === "succeeded" ? (
          <motion.div key="success" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center py-4 text-center">
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 ring-1 ring-inset ring-success/25"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <motion.path
                  d="M5 13l4.5 4.5L19 7"
                  stroke="rgb(var(--success))"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.4, delay: 0.15, ease: "easeOut" }}
                />
              </svg>
            </motion.div>
            <p className="mt-4 text-sm font-medium text-ink">Authorization revoked</p>
          </motion.div>
        ) : (
          <motion.div key="confirm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex gap-3">
            <Button variant="secondary" fullWidth onClick={onClose} disabled={phase === "submitting"}>
              Cancel
            </Button>
            <Button variant="danger" fullWidth loading={phase === "submitting"} onClick={handleConfirm}>
              {phase === "submitting" ? "Waiting for wallet signature" : "Revoke authorization"}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}
