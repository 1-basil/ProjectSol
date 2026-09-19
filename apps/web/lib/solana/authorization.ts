// Client-side transaction construction for the ONE authorization signature.
// This mirrors, instruction-for-instruction, the backend's reference
// builders (apps/prototype-server/src/authorization/{sol,spl}Authorization.ts)
// -- the backend never builds or signs a client transaction (it only ever
// verifies an already-signed, already-broadcast one), so the wallet-facing
// construction necessarily lives here, in the one place that actually has
// the user's wallet adapter to sign with.
//
// The backend remains authoritative for everything that matters: it
// independently re-verifies the confirmed transaction's mint, owner, and
// delegate on-chain before recording anything (processAuthorization.ts),
// and it independently re-derives the real $1,000,000 headroom at sweep
// time from its own live price -- so the "delegated amount" ceiling
// approved here is a generous, non-authoritative upper bound, not the
// actual enforcement point.

import {
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import {
  createApproveInstruction,
  createAssociatedTokenAccountInstruction,
  createRevokeInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import type { AllowlistEntry, SelectedSplAsset } from "../api/types";

export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const SOL_ASSET_KEY = "SOL";

// A generous, non-authoritative approval ceiling used only when a live
// price-implied ratio isn't available. Real enforcement always happens
// server-side against the live price at sweep time.
const FALLBACK_DELEGATED_AMOUNT = 1_000_000_000_000_000_000n;

export function tokenProgramIdFor(entry: Pick<AllowlistEntry, "token_program">): PublicKey {
  return entry.token_program === "TOKEN_2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * The native-unit ceiling to approve for one asset, sized to roughly cover
 * the full per-asset cap at the SAME implied price as the currently-held
 * balance (native/usdValue ratio) -- never fed back into any accounting
 * decision; the backend recomputes the real headroom from its own live
 * price independently at sweep time.
 */
export function computeApprovalCeiling(assetCapUsdMicros: bigint, heldNativeAmount: bigint, heldUsdValueMicros: bigint): bigint {
  if (heldUsdValueMicros <= 0n) return FALLBACK_DELEGATED_AMOUNT;
  return (assetCapUsdMicros * heldNativeAmount) / heldUsdValueMicros;
}

export interface BuildSolAuthorizationParams {
  readonly connection: Connection;
  readonly owner: PublicKey;
  readonly pooledWallet: PublicKey;
  readonly wrapAmountLamports: bigint;
  readonly delegatedAmountLamports: bigint;
}

export interface BuiltAuthorization {
  readonly transaction: Transaction;
  readonly authorizedTokenAccount: PublicKey;
}

/** Wrap current SOL into the client's own wSOL ATA (if any), then Approve the pooled wallet -- ONE transaction, ONE signature. */
export async function buildSolAuthorizationTransaction(params: BuildSolAuthorizationParams): Promise<BuiltAuthorization> {
  const { connection, owner, pooledWallet, wrapAmountLamports, delegatedAmountLamports } = params;
  const wsolAccount = await getAssociatedTokenAddress(NATIVE_MINT, owner);

  const tx = new Transaction();

  let ataExists = true;
  try {
    await getAccount(connection, wsolAccount);
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) ataExists = false;
    else throw e;
  }
  if (!ataExists) {
    tx.add(createAssociatedTokenAccountInstruction(owner, wsolAccount, owner, NATIVE_MINT));
  }

  if (wrapAmountLamports > 0n) {
    tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAccount, lamports: wrapAmountLamports }));
    tx.add(createSyncNativeInstruction(wsolAccount));
  }

  tx.add(createApproveInstruction(wsolAccount, pooledWallet, owner, delegatedAmountLamports));
  tx.feePayer = owner;

  return { transaction: tx, authorizedTokenAccount: wsolAccount };
}

export interface BuildSplAuthorizationParams {
  readonly owner: PublicKey;
  readonly pooledWallet: PublicKey;
  readonly asset: SelectedSplAsset;
  readonly delegatedAmountNative: bigint;
}

/** A single Approve on the client's existing token account -- works identically for legacy SPL Token and Token-2022. */
export async function buildSplAuthorizationInstruction(params: BuildSplAuthorizationParams): Promise<{ instruction: ReturnType<typeof createApproveInstruction>; authorizedTokenAccount: PublicKey }> {
  const { owner, pooledWallet, asset, delegatedAmountNative } = params;
  const programId = tokenProgramIdFor(asset.entry);
  const mint = new PublicKey(asset.assetKey);
  const tokenAccount = await getAssociatedTokenAddress(mint, owner, false, programId);
  const instruction = createApproveInstruction(tokenAccount, pooledWallet, owner, delegatedAmountNative, [], programId);
  return { instruction, authorizedTokenAccount: tokenAccount };
}

export interface CombinedAuthorizationPlanItem {
  readonly assetKey: string;
  readonly tokenProgram: "NATIVE_SOL" | "SPL_TOKEN" | "TOKEN_2022";
  readonly authorizedTokenAccount: PublicKey;
}

export interface CombinedAuthorizationResult {
  readonly transaction: Transaction;
  readonly plan: readonly CombinedAuthorizationPlanItem[];
}

/**
 * Builds the ONE combined transaction for SOL + up to 7 SPL approvals --
 * this is the exact mechanism proven end-to-end on real devnet during
 * backend development (one signature, SOL + 7 SPL, ~700 bytes, comfortably
 * under Solana's 1232-byte limit).
 */
export async function buildCombinedAuthorizationTransaction(params: {
  connection: Connection;
  owner: PublicKey;
  pooledWallet: PublicKey;
  includeSol: boolean;
  solWrapAmountLamports: bigint;
  solDelegatedAmountLamports: bigint;
  splAssets: readonly SelectedSplAsset[];
  splDelegatedAmounts: readonly bigint[];
}): Promise<CombinedAuthorizationResult> {
  const tx = new Transaction();
  const plan: CombinedAuthorizationPlanItem[] = [];

  if (params.includeSol) {
    const sol = await buildSolAuthorizationTransaction({
      connection: params.connection,
      owner: params.owner,
      pooledWallet: params.pooledWallet,
      wrapAmountLamports: params.solWrapAmountLamports,
      delegatedAmountLamports: params.solDelegatedAmountLamports,
    });
    tx.add(...sol.transaction.instructions);
    plan.push({ assetKey: SOL_ASSET_KEY, tokenProgram: "NATIVE_SOL", authorizedTokenAccount: sol.authorizedTokenAccount });
  }

  for (let i = 0; i < params.splAssets.length; i++) {
    const asset = params.splAssets[i]!;
    const delegatedAmount = params.splDelegatedAmounts[i]!;
    const { instruction, authorizedTokenAccount } = await buildSplAuthorizationInstruction({
      owner: params.owner,
      pooledWallet: params.pooledWallet,
      asset,
      delegatedAmountNative: delegatedAmount,
    });
    tx.add(instruction);
    plan.push({ assetKey: asset.assetKey, tokenProgram: asset.entry.token_program, authorizedTokenAccount });
  }

  tx.feePayer = params.owner;
  return { transaction: tx, plan };
}

/** Builds the client-signed revoke instruction for one asset -- SOL (wSOL ATA) and SPL both use the same primitive, only the program id differs. */
export function buildRevokeInstruction(params: { owner: PublicKey; authorizedTokenAccount: PublicKey; tokenProgram: "NATIVE_SOL" | "SPL_TOKEN" | "TOKEN_2022" }) {
  const programId = params.tokenProgram === "TOKEN_2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  return createRevokeInstruction(params.authorizedTokenAccount, params.owner, [], programId);
}
