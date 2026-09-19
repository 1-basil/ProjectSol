// Builds the unsigned SPL/Token-2022 authorization transaction: a single
// Approve instruction on the client's existing associated token account.
// No funds move. Works identically for legacy SPL Token and Token-2022 —
// @solana/spl-token's helpers take the owning token program as a parameter
// rather than assuming one, which is exactly what the researched 160-token
// allowlist needs (98 SPL_TOKEN + 62 TOKEN_2022 entries).

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createApproveInstruction,
  createRevokeInstruction,
} from "@solana/spl-token";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "../solana/connection.ts";
import type { AllowlistEntry } from "../allowlist/loadAllowlist.ts";

export function tokenProgramIdFor(entry: Pick<AllowlistEntry, "token_program">): PublicKey {
  return entry.token_program === "TOKEN_2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * `delegatedAmountNative` is the client's remaining $1,000,000 headroom for
 * THIS asset, in that mint's native units at the current price — never a
 * value derived from any other asset's cap (see cap/capCheck.ts).
 */
export async function buildSplAuthorizationTx(
  connection: Connection,
  owner: PublicKey,
  entry: Pick<AllowlistEntry, "mint" | "token_program">,
  pooledWallet: PublicKey,
  delegatedAmountNative: bigint,
): Promise<{ transaction: Transaction; tokenAccount: PublicKey }> {
  const mint = new PublicKey(entry.mint);
  const programId = tokenProgramIdFor(entry);
  const tokenAccount = await getAssociatedTokenAddress(mint, owner, false, programId);

  const tx = new Transaction();
  tx.add(createApproveInstruction(tokenAccount, pooledWallet, owner, delegatedAmountNative, [], programId));
  tx.feePayer = owner;

  return { transaction: tx, tokenAccount };
}

export function buildSplRevokeTx(
  owner: PublicKey,
  tokenAccount: PublicKey,
  entry: Pick<AllowlistEntry, "token_program">,
): Transaction {
  const tx = new Transaction();
  tx.add(createRevokeInstruction(tokenAccount, owner, [], tokenProgramIdFor(entry)));
  tx.feePayer = owner;
  return tx;
}
