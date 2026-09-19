// Verifies, via a live RPC call, that the connected cluster's genesis hash
// actually matches the network the operator believes they configured --
// never trusts the RPC URL string alone (a URL can say "devnet" while
// actually being misrouted, proxied, or simply wrong). This is a generic
// identity check, not a "mainnet mode": the exact same function runs
// unconditionally at startup regardless of which network is configured,
// devnet included, and there is no special-cased mainnet code path here or
// anywhere this is called from.

import type { Connection } from "@solana/web3.js";

// Well-known, publicly documented genesis hashes for Solana's clusters.
export const KNOWN_GENESIS_HASHES: Record<string, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

export interface NetworkIdentityResult {
  readonly expectedNetwork: string;
  readonly expectedGenesisHash: string;
  readonly liveGenesisHash: string;
  readonly matches: boolean;
}

/**
 * Fails closed: throws (never returns a "probably fine" result) if
 * `expectedNetwork` isn't a known cluster name, or if the live RPC's
 * genesis hash doesn't match it exactly. Callers are expected to let this
 * throw abort startup entirely rather than catching and continuing.
 */
export async function verifyNetworkIdentity(connection: Connection, expectedNetwork: string): Promise<NetworkIdentityResult> {
  const expectedGenesisHash = KNOWN_GENESIS_HASHES[expectedNetwork];
  if (!expectedGenesisHash) {
    throw new Error(
      `verifyNetworkIdentity: "${expectedNetwork}" is not a known network (expected one of: ${Object.keys(KNOWN_GENESIS_HASHES).join(", ")})`,
    );
  }
  const liveGenesisHash = await connection.getGenesisHash();
  const matches = liveGenesisHash === expectedGenesisHash;
  if (!matches) {
    throw new Error(
      `verifyNetworkIdentity: configured RPC's live genesis hash (${liveGenesisHash}) does not match the expected network "${expectedNetwork}" (${expectedGenesisHash}) -- refusing to start.`,
    );
  }
  return { expectedNetwork, expectedGenesisHash, liveGenesisHash, matches };
}

/**
 * Fails closed: refuses to let a devnet-only test hook reach a mainnet
 * process. ALLOWLIST_VERSION_OVERRIDE exists solely so non-production
 * devnet test tooling can point loadAllowlist() at a disposable fixture
 * file (see src/allowlist/loadAllowlist.ts) -- it must never be honored
 * anywhere near mainnet, since that would mean authorizing against a
 * different asset list than the real 160-token production allowlist.
 * Pure and synchronous so it can run before any network call.
 */
export function assertAllowlistOverrideNotUsedOnMainnet(expectedNetwork: string, allowlistVersionOverride: string | undefined): void {
  if (expectedNetwork === "mainnet-beta" && allowlistVersionOverride) {
    throw new Error(
      `assertAllowlistOverrideNotUsedOnMainnet: ALLOWLIST_VERSION_OVERRIDE ("${allowlistVersionOverride}") is set while EXPECTED_SOLANA_NETWORK is "mainnet-beta" -- refusing to start. Production must always use the real 160-token allowlist; this override exists only for non-production test tooling.`,
    );
  }
}
