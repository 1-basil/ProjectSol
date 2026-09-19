// Narrow signing abstraction for the pooled wallet. sweepAsset.ts (the
// actual sweep business logic) depends only on this interface, never on a
// raw Keypair -- so a future remote-signing/HSM/KMS implementation can be
// substituted later by adding a new function that returns a PooledSigner,
// without touching sweepAsset.ts or its tests at all. This session adds
// ONLY the interface and the existing Keypair-backed implementation; no
// KMS/HSM integration is implemented here.

import type { Keypair, PublicKey, Transaction } from "@solana/web3.js";

export interface PooledSigner {
  readonly publicKey: PublicKey;
  /** Signs `transaction` in place, exactly as Transaction.sign(keypair) would. */
  signTransaction(transaction: Transaction): Promise<void>;
}

/** Wraps a real Keypair as a PooledSigner -- the only implementation that exists today. */
export function toPooledSigner(keypair: Keypair): PooledSigner {
  return {
    publicKey: keypair.publicKey,
    async signTransaction(transaction: Transaction): Promise<void> {
      transaction.sign(keypair);
    },
  };
}
