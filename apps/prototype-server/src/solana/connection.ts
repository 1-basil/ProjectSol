import { Connection, PublicKey } from "@solana/web3.js";
import { createResilientFetch } from "./resilientFetch.ts";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export const DEVNET_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

// Explicit -- everywhere this used to fall through to @solana/web3.js's own
// defaults (an implicit 60s HTTP-side wait per attempt with no bounded
// retry, and an implicit derived WS endpoint) it's now controlled here.
// confirmTransactionInitialTimeout bounds how long a single
// confirmTransaction() call will wait before giving up and throwing --
// callers (sweepAsset.ts, processAuthorization.ts) already reconcile via a
// plain HTTP getSignatureStatus() call afterward rather than trusting this
// wait alone, so bounding it tighter just means a stuck/slow confirmation
// surfaces (and gets reconciled) sooner, never that a real confirmation is
// missed. disableRetryOnRateLimit is set because retry-on-429 is now
// handled once, predictably, inside createResilientFetch() -- leaving
// web3.js's own built-in retry enabled too would mean two independent,
// uncoordinated retry loops stacking their delays.
let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(DEVNET_RPC_URL, {
      commitment: "confirmed",
      fetch: createResilientFetch(),
      disableRetryOnRateLimit: true,
      confirmTransactionInitialTimeout: 20_000,
    });
  }
  return connection;
}
