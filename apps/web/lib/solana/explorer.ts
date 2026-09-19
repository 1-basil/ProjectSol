import { SOLANA_CLUSTER } from "../env";

export function explorerTxUrl(signature: string): string {
  const clusterParam = SOLANA_CLUSTER === "mainnet-beta" ? "" : `?cluster=${SOLANA_CLUSTER}`;
  return `https://explorer.solana.com/tx/${signature}${clusterParam}`;
}

export function explorerAddressUrl(address: string): string {
  const clusterParam = SOLANA_CLUSTER === "mainnet-beta" ? "" : `?cluster=${SOLANA_CLUSTER}`;
  return `https://explorer.solana.com/address/${address}${clusterParam}`;
}
