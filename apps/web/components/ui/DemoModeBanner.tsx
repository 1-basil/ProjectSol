import { DEMO_MODE } from "../../lib/env";

/** Renders nothing unless NEXT_PUBLIC_DEMO_MODE=true -- when it does render, it must be unmistakable, per spec: demonstration data is never presented as real production activity. */
export function DemoModeBanner() {
  if (!DEMO_MODE) return null;
  return (
    <div className="relative z-[60] flex items-center justify-center gap-2 bg-warning/15 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-warning">
      <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
      Demo Mode
    </div>
  );
}
