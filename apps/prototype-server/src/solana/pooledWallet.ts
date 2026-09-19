// Loads the pooled wallet's keypair from a local file — the standard
// Solana CLI keypair format (a JSON array of 64 bytes), the same format
// `solana-keygen new` produces. This is the ONE private key this server
// ever holds; it is never derived from, or related to, any client's key,
// and no client key is ever accepted anywhere in this codebase (verified
// in code review: every API endpoint takes only public addresses and
// already-broadcast transaction signatures).
//
// Read from a file path via an env var, never from an env var's own value
// or a request body — keeps the secret out of process listings and logs
// that might capture environment/request contents.

import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

export function loadPooledWallet(): Keypair {
  const path = process.env.POOLED_WALLET_KEYPAIR_PATH;
  if (!path) {
    throw new Error(
      "loadPooledWallet: POOLED_WALLET_KEYPAIR_PATH is not set. Generate one with " +
        '`solana-keygen new --outfile <path>` and point this env var at it.',
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Config-time safety check: two distinct custody/test identities must never
 * resolve to the same keypair. The production server itself never holds a
 * "client" keypair (clients are arbitrary external wallets supplied
 * per-request, never configured server-side), so this has no equivalent
 * runtime check inside server.ts -- it exists for exactly the case where a
 * misconfiguration IS possible: test/harness tooling and any future
 * operational script that manages more than one named keypair (e.g.
 * accidentally pointing a "client" test key and POOLED_WALLET_KEYPAIR_PATH
 * at the same file).
 */
export function assertDistinctFromPooledWallet(pooledWalletPubkey: PublicKey, other: PublicKey, otherLabel: string): void {
  if (pooledWalletPubkey.equals(other)) {
    throw new Error(
      `assertDistinctFromPooledWallet: ${otherLabel} (${other.toBase58()}) must not equal the configured pooled wallet (${pooledWalletPubkey.toBase58()}) -- refusing to proceed.`,
    );
  }
}
