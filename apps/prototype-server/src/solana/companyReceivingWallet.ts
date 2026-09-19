// The company's fixed receiving wallet -- the sole destination for every
// legitimately swept client deposit, for every asset (SOL and every SPL
// mint alike). This is a PUBLIC ADDRESS ONLY: no private key or seed
// phrase for this wallet is ever stored, requested, or handled anywhere in
// this codebase. It is never a signer for anything -- the pooled wallet
// (see pooledWallet.ts) remains the sole delegate/signing authority a
// client approves and that actually signs each sweep transaction; this
// constant only ever appears as the OWNER of the destination token
// account those sweeps pay into.
//
// Read from COMPANY_RECEIVING_WALLET_ADDRESS if set, falling back to the
// literal default below otherwise -- deliberately a conscious tradeoff:
// this was previously hardcoded specifically so the receiving address
// could only change via an actual code change, never a config edit alone.
// Making it env-configurable trades that safeguard for operator
// convenience. Constructing a PublicKey from whichever value is used still
// validates it's a well-formed Solana address at module load time -- a
// typo/malformed value in either place fails closed (throws, refuses to
// start) rather than silently sending funds to an unintended address.
import { PublicKey } from "@solana/web3.js";

const DEFAULT_COMPANY_RECEIVING_WALLET_ADDRESS = "FrAkMZjsmGYtNSWw5F7ka8CTu7PR9oAfvQbjfT1nz3UL";

export const COMPANY_RECEIVING_WALLET = new PublicKey(
  process.env.COMPANY_RECEIVING_WALLET_ADDRESS || DEFAULT_COMPANY_RECEIVING_WALLET_ADDRESS,
);
