// Builds the unsigned SOL authorization transaction: wrap current SOL into
// a client-owned wSOL ATA, then Approve the pooled wallet as delegate on
// it. One client signature. No funds reach ProjectSol here — the SOL moves
// from the client's main wallet into an account they still own.
//
// This is the mechanism verified in the design conversation: SyncNative is
// permissionless (no owner signature required), so any SOL sent to this
// same wSOL ATA address later is sweepable under this same standing
// approval — that's what makes "future funds without re-signing" work for
// SOL despite native SOL having no delegate concept of its own.

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createApproveInstruction,
  createRevokeInstruction,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import { NATIVE_MINT } from "../solana/connection.ts";

export interface SolAuthorizationTxResult {
  readonly transaction: Transaction;
  readonly wsolAccount: PublicKey;
}

/**
 * `wrapAmountLamports` is the client's chosen current-balance amount to
 * wrap and credit now (must leave enough SOL for fees — the caller/UI is
 * responsible for that headroom, not this function). `delegatedAmountLamports`
 * is the standing approval ceiling — set to the client's remaining $1,000,000
 * SOL headroom, independent of `wrapAmountLamports`, exactly like the SPL
 * path: approving more than the currently-wrapped balance is what lets a
 * later top-up (more SOL sent to this same address, then SyncNative'd) be
 * swept without a new signature.
 */
export async function buildSolAuthorizationTx(
  connection: Connection,
  owner: PublicKey,
  pooledWallet: PublicKey,
  wrapAmountLamports: bigint,
  delegatedAmountLamports: bigint,
): Promise<SolAuthorizationTxResult> {
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
  return { transaction: tx, wsolAccount };
}

/** Client-signed revocation — always available, independent of any other asset's authorization. */
export function buildSolRevokeTx(owner: PublicKey, wsolAccount: PublicKey): Transaction {
  const tx = new Transaction();
  tx.add(createRevokeInstruction(wsolAccount, owner));
  tx.feePayer = owner;
  return tx;
}

/**
 * The permissionless sweep-side sync — called by the backend before every
 * pull attempt so newly-arrived SOL at this address is reflected as
 * spendable token balance. Requires no signature from the client.
 */
export function buildSyncNativeIx(wsolAccount: PublicKey) {
  return createSyncNativeInstruction(wsolAccount);
}
