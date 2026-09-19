import type { ComponentType } from "react";

export interface HyperspeedProps {
  effectOptions?: Record<string, unknown>;
  lightMode?: boolean;
}

declare const Hyperspeed: ComponentType<HyperspeedProps>;
export default Hyperspeed;
