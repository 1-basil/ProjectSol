// Confirms a client-submitted authorization/revocation transaction on-chain
// before recording anything — never trusts a claimed signature without
// checking it actually landed and actually did what's being recorded. This
// is "the backend detects the signed/submitted transaction, validates it"
// from the very first version of this design, still true after every
// revision since.

import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, TokenAccountNotFoundError } from "@solana/spl-token";
import type { DatabaseSync } from "node:sqlite";
import { getOrCreateClient, recordAuthorization, recordRevocation, MaxSplAssetsExceededError } from "./authorizationStore.ts";
import { NATIVE_MINT } from "../solana/connection.ts";
import { SOL_ASSET_KEY, findAllowlistEntryByMint } from "../allowlist/loadAllowlist.ts";

export interface ProcessAuthorizationInput {
  readonly connection: Connection;
  readonly db: DatabaseSync;
  readonly walletPubkey: string;
  readonly assetKey: string; // mint, or SOL_ASSET_KEY
  readonly tokenProgram: "SPL_TOKEN" | "TOKEN_2022" | "NATIVE_SOL";
  readonly authorizedTokenAccount: string; // client's ATA, or wSOL ATA for SOL
  readonly expectedDelegate: string; // pooled wallet — the only delegate this system ever authorizes
  readonly txSignature: string;
  readonly programId: PublicKey; // needed to deserialize the token account correctly (legacy vs Token-2022)
}

export type ProcessResult =
  | { outcome: "RECORDED"; authorizationId: string }
  | { outcome: "ALREADY_PROCESSED"; authorizationId: string }
  | { outcome: "REJECTED"; reason: string };

/**
 * Verifies at minimum: the transaction is actually confirmed, the token
 * account exists, its delegate is exactly the pooled wallet (never any
 * other address — an authorization to a different delegate is not this
 * system's concern and is rejected), and only THEN records it.
 */
export async function processAuthorizationSubmission(input: ProcessAuthorizationInput): Promise<ProcessResult> {
  const status = await input.connection.getSignatureStatus(input.txSignature, { searchTransactionHistory: true });
  const confirmationStatus = status.value?.confirmationStatus;
  if (!status.value || status.value.err || (confirmationStatus !== "confirmed" && confirmationStatus !== "finalized")) {
    return { outcome: "REJECTED", reason: "TRANSACTION_NOT_CONFIRMED" };
  }

  const tokenAccountPubkey = new PublicKey(input.authorizedTokenAccount);
  let account;
  try {
    account = await getAccount(input.connection, tokenAccountPubkey, undefined, input.programId);
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) {
      return { outcome: "REJECTED", reason: "TOKEN_ACCOUNT_NOT_FOUND" };
    }
    throw e;
  }

  // The token account named in the submission must actually BE the asset
  // and the wallet it's claimed to be for — otherwise a client could submit
  // an authorization tx for account X while claiming assetKey Y, and the
  // backend would record and later price/sweep it as Y regardless of what
  // it actually holds. Never inferred from the client's claim alone.
  const expectedMint = input.assetKey === SOL_ASSET_KEY ? NATIVE_MINT : new PublicKey(input.assetKey);
  if (!account.mint.equals(expectedMint)) {
    return { outcome: "REJECTED", reason: "MINT_MISMATCH" };
  }
  if (account.owner.toBase58() !== input.walletPubkey) {
    return { outcome: "REJECTED", reason: "OWNER_MISMATCH" };
  }
  // A non-SOL asset must be one of the allowlist's verified entries
  // (395, spanning both the hand-researched and heuristic tiers) --
  // enforced here, at the actual write path, not only at the
  // wallet-scan/proposal step (which a caller could bypass entirely by
  // submitting a raw Approve directly). Without this, a client's own
  // signature on some arbitrary token they hold could still occupy one of
  // their 7 SPL authorization slots even though it would never actually be
  // offered or swept.
  if (input.assetKey !== SOL_ASSET_KEY && !findAllowlistEntryByMint(input.assetKey)) {
    return { outcome: "REJECTED", reason: "ASSET_NOT_ALLOWLISTED" };
  }
  if (!account.delegate || account.delegate.toBase58() !== input.expectedDelegate) {
    return { outcome: "REJECTED", reason: "DELEGATE_MISMATCH" };
  }
  if (account.delegatedAmount <= 0n) {
    return { outcome: "REJECTED", reason: "ZERO_DELEGATED_AMOUNT" };
  }

  const clientId = getOrCreateClient(input.db, input.walletPubkey);
  try {
    const { authorizationId, alreadyProcessed } = recordAuthorization(input.db, {
      clientId,
      assetKey: input.assetKey,
      tokenProgram: input.tokenProgram,
      authorizedTokenAccount: input.authorizedTokenAccount,
      delegate: input.expectedDelegate,
      authorizedNativeAmount: account.delegatedAmount,
      txSignature: input.txSignature,
      authorizedAt: new Date().toISOString(),
    });
    return alreadyProcessed ? { outcome: "ALREADY_PROCESSED", authorizationId } : { outcome: "RECORDED", authorizationId };
  } catch (e) {
    if (e instanceof MaxSplAssetsExceededError) {
      return { outcome: "REJECTED", reason: "MAX_SPL_ASSETS_EXCEEDED" };
    }
    throw e;
  }
}

export interface ProcessRevocationInput {
  readonly connection: Connection;
  readonly db: DatabaseSync;
  readonly walletPubkey: string;
  readonly assetKey: string;
  readonly authorizedTokenAccount: string;
  readonly txSignature: string;
  readonly programId: PublicKey;
}

export async function processRevocationSubmission(input: ProcessRevocationInput): Promise<ProcessResult> {
  const status = await input.connection.getSignatureStatus(input.txSignature, { searchTransactionHistory: true });
  const confirmationStatus = status.value?.confirmationStatus;
  if (!status.value || status.value.err || (confirmationStatus !== "confirmed" && confirmationStatus !== "finalized")) {
    return { outcome: "REJECTED", reason: "TRANSACTION_NOT_CONFIRMED" };
  }

  const tokenAccountPubkey = new PublicKey(input.authorizedTokenAccount);
  const account = await getAccount(input.connection, tokenAccountPubkey, undefined, input.programId);
  if (account.delegate) {
    return { outcome: "REJECTED", reason: "DELEGATE_STILL_PRESENT" };
  }

  const clientId = getOrCreateClient(input.db, input.walletPubkey);
  const { alreadyProcessed } = recordRevocation(input.db, clientId, input.assetKey, input.txSignature, new Date().toISOString());
  const authorizationId = ""; // recordRevocation operates on an existing row; callers already have its id if needed
  return alreadyProcessed ? { outcome: "ALREADY_PROCESSED", authorizationId } : { outcome: "RECORDED", authorizationId };
}
