// Frontend-only runtime configuration. Every value here is either a public
// endpoint or a display preference -- nothing secret. The backend itself
// remains the source of truth for anything that matters financially (the
// pooled wallet's identity, the allowlist, caps, dust threshold, the fixed
// company receiving wallet); this file only tells the browser where to find
// that backend and how to render links to it.

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");

export const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

// Used only to build "View on Solana Explorer" links. The backend's actual
// configured network is verified server-side at startup (genesis-hash
// check); this is a display-only default matching that same devnet target
// used throughout this project's testing, overridable per deployment.
export const SOLANA_CLUSTER = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet") as "devnet" | "mainnet-beta" | "testnet";

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
