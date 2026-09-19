"use client";

import { motion } from "framer-motion";
import { Card, Badge } from "../ui/Card";
import { Button } from "../ui/Button";
import { SectionHeading } from "./HowItWorks";

export function UserControl() {
  return (
    <section className="px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="Your control"
          title="You can revoke any asset, at any time."
          description="Authorization is never permanent. Revoking one asset never affects the others."
        />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-14 max-w-xl"
        >
          <Card className="flex items-center justify-between p-6">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-full bg-accent-gradient" aria-hidden />
              <div>
                <p className="text-sm font-medium text-ink">USDC</p>
                <Badge tone="success" className="mt-1">
                  <span className="relative flex h-1.5 w-1.5" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                  </span>
                  Active
                </Badge>
              </div>
            </div>
            <Button variant="danger" size="sm">
              Revoke
            </Button>
          </Card>
        </motion.div>
      </div>
    </section>
  );
}
