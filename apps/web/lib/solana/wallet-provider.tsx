"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SOLANA_RPC_URL } from "../env";

/**
 * Phantom is registered explicitly for broad compatibility. Solflare is
 * deliberately NOT registered here -- current Solflare extensions
 * self-register via the Wallet Standard protocol, and also passing the
 * legacy @solana/wallet-adapter-solflare adapter alongside that produces a
 * duplicate "Solflare" registration that silently breaks connect() (see
 * useStandardWalletAdapters' own console warning). Any other
 * Wallet-Standard-compliant wallet a user has installed (Backpack,
 * Solflare included) registers itself automatically and appears alongside
 * Phantom in useWallet()'s `wallets` list -- no extra adapter needed for
 * those.
 */
export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  // Explicit for the same reason as the backend's getConnection() (see
  // apps/prototype-server/src/solana/connection.ts): the previous bare
  // `endpoint={SOLANA_RPC_URL}` form left @solana/web3.js's defaults in
  // charge of the confirmation timeout and left disableRetryOnRateLimit
  // unset, which is the config surface behind users occasionally seeing the
  // wallet "take too long to connect" with no bounded upper wait.
  const config = useMemo(() => ({ commitment: "confirmed" as const, confirmTransactionInitialTimeout: 20_000 }), []);

  return (
    <ConnectionProvider endpoint={SOLANA_RPC_URL} config={config}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
