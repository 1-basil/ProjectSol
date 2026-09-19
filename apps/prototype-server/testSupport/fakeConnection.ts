// A simulated Solana ledger, used ONLY because the devnet airdrop faucet is
// rate-limited from this environment (verified: 4 real attempts across two
// separate tools, all rejected — see the E2E report). This is NOT a mock of
// this project's own logic — every account is encoded with
// @solana/spl-token's real AccountLayout/MintLayout, and every function
// under test (buildSolAuthorizationTx, buildSplAuthorizationTx,
// processAuthorizationSubmission, sweepAsset, the reconciler) runs
// completely unmodified against it. What's simulated is only the external
// boundary — the RPC methods themselves — and even there, every real
// instruction a client or the backend actually broadcasts (create-ATA,
// System transfer, SyncNative, Approve, Revoke, TransferChecked) is
// genuinely decoded and applied to fake ledger state, not just assumed to
// have worked. Every test using this must be clearly labeled SIMULATED,
// never described as an on-chain result.

import {
  PublicKey,
  Transaction,
  SystemProgram,
  SystemInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  AccountLayout,
  MintLayout,
  AccountState,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  decodeSyncNativeInstruction,
  decodeApproveInstruction,
  decodeRevokeInstruction,
} from "@solana/spl-token";

export interface FakeTokenAccountState {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegate: PublicKey | null;
  delegatedAmount: bigint;
  programId?: PublicKey; // defaults to legacy TOKEN_PROGRAM_ID
}

interface FakeMintState {
  decimals: number;
  programId?: PublicKey;
}

type SigStatus = { err: any | null; confirmationStatus: "processed" | "confirmed" | "finalized" };

export class FakeConnection {
  private tokenAccounts = new Map<string, FakeTokenAccountState>();
  private mints = new Map<string, FakeMintState>();
  // Doubles as wallet SOL balances AND as the "lamports sent but not yet
  // SyncNative'd" ledger for wSOL token accounts — a real System transfer
  // to a token account's address behaves identically either way: lamports
  // sit at that address until SyncNative reconciles them into `amount`.
  private solBalances = new Map<string, bigint>();
  private signatures = new Map<string, SigStatus>();
  private failNextSend = false;
  private throwOnConfirm = false;
  private blockhashCounter = 0;
  private currentBlockHeight = 1_000_000;
  // Every transaction actually broadcast via sendRawTransaction, in order —
  // lets a test inspect the REAL instruction list/program IDs of whatever
  // was sent (an authorization tx, a sweep tx, ...), not just assume it
  // matches whichever builder function was called.
  private sentTransactions: Transaction[] = [];

  /** All transactions broadcast so far, oldest first. */
  getSentTransactions(): readonly Transaction[] {
    return this.sentTransactions;
  }

  /** The most recently broadcast transaction, or undefined if none yet. */
  getLastSentTransaction(): Transaction | undefined {
    return this.sentTransactions[this.sentTransactions.length - 1];
  }

  setTokenAccount(pubkey: PublicKey, state: FakeTokenAccountState): void {
    this.tokenAccounts.set(pubkey.toBase58(), { ...state });
  }

  getTokenAccountState(pubkey: PublicKey): FakeTokenAccountState | undefined {
    return this.tokenAccounts.get(pubkey.toBase58());
  }

  setMint(pubkey: PublicKey, decimals: number, programId?: PublicKey): void {
    this.mints.set(pubkey.toBase58(), { decimals, programId });
  }

  setSolBalance(pubkey: PublicKey, lamports: bigint): void {
    this.solBalances.set(pubkey.toBase58(), lamports);
  }

  getSolBalance(pubkey: PublicKey): bigint {
    return this.solBalances.get(pubkey.toBase58()) ?? 0n;
  }

  /** Simulates the next sendRawTransaction throwing (network/timeout), independent of whether the tx actually lands. */
  simulateSendFailureOnce(): void {
    this.failNextSend = true;
  }

  /** Simulates a crash: the transaction lands on-chain (state updates, signature recorded) but the caller never learns the outcome. */
  simulateConfirmHangOnce(): void {
    this.throwOnConfirm = true;
  }

  async getAccountInfo(pubkey: PublicKey): Promise<{ data: Buffer; owner: PublicKey } | null> {
    const key = pubkey.toBase58();
    const tokenAccount = this.tokenAccounts.get(key);
    if (tokenAccount) {
      const buf = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode(
        {
          mint: tokenAccount.mint,
          owner: tokenAccount.owner,
          amount: tokenAccount.amount,
          delegateOption: tokenAccount.delegate ? 1 : 0,
          delegate: tokenAccount.delegate ?? PublicKey.default,
          state: AccountState.Initialized,
          isNativeOption: 0,
          isNative: 0n,
          delegatedAmount: tokenAccount.delegatedAmount,
          closeAuthorityOption: 0,
          closeAuthority: PublicKey.default,
        },
        buf,
      );
      return { data: buf, owner: tokenAccount.programId ?? TOKEN_PROGRAM_ID };
    }
    const mint = this.mints.get(key);
    if (mint) {
      const buf = Buffer.alloc(MintLayout.span);
      MintLayout.encode(
        {
          mintAuthorityOption: 0,
          mintAuthority: PublicKey.default,
          supply: 0n,
          decimals: mint.decimals,
          isInitialized: true,
          freezeAuthorityOption: 0,
          freezeAuthority: PublicKey.default,
        },
        buf,
      );
      return { data: buf, owner: mint.programId ?? TOKEN_PROGRAM_ID };
    }
    return null;
  }

  async getBalance(pubkey: PublicKey): Promise<number> {
    return Number(this.solBalances.get(pubkey.toBase58()) ?? 0n);
  }

  /**
   * Shaped exactly like the real RPC's parsed response — only the fields
   * scanWallet.ts actually reads (`account.data.parsed.info.mint` and
   * `.tokenAmount.amount`) are populated, since nothing else in this
   * codebase's flows consumes the rest of the real, much larger response.
   */
  async getParsedTokenAccountsByOwner(
    owner: PublicKey,
    filter: { programId: PublicKey },
  ): Promise<{ value: Array<{ pubkey: PublicKey; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }> }> {
    const ownerKey = owner.toBase58();
    const programKey = filter.programId.toBase58();
    const value = [...this.tokenAccounts.entries()]
      .filter(([, acct]) => acct.owner.toBase58() === ownerKey && (acct.programId ?? TOKEN_PROGRAM_ID).toBase58() === programKey)
      .map(([key, acct]) => ({
        pubkey: new PublicKey(key),
        account: {
          data: {
            parsed: {
              info: {
                mint: acct.mint.toBase58(),
                tokenAmount: { amount: acct.amount.toString() },
              },
            },
          },
        },
      }));
    return { value };
  }

  /**
   * Mirrors @solana/web3.js's real Connection.sendTransaction (the
   * legacy-Transaction + signers-array overload): populates a fresh
   * blockhash, signs with the given signers, then delegates to
   * sendRawTransaction. Needed because @solana/spl-token's
   * getOrCreateAssociatedTokenAccount calls sendAndConfirmTransaction,
   * which calls connection.sendTransaction rather than sendRawTransaction
   * directly.
   */
  async sendTransaction(
    transaction: Transaction,
    signers: Array<{ publicKey: PublicKey; secretKey: Uint8Array }>,
    options?: { skipPreflight?: boolean },
  ): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.sign(...(signers as any));
    return this.sendRawTransaction(transaction.serialize(), options);
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    this.blockhashCounter += 1;
    // A real, distinct-per-call 32-byte value, base58-encoded exactly like a
    // real blockhash — @solana/web3.js's Message layout requires a genuine
    // 32-byte buffer here, not an arbitrary string.
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(0, this.blockhashCounter, true);
    // A real blockhash is valid for ~150 slots; the exact width doesn't
    // matter here, only that it advances with each new blockhash issued and
    // that a test can deliberately advance past it via setBlockHeight to
    // simulate expiry.
    return { blockhash: bs58.encode(bytes), lastValidBlockHeight: this.currentBlockHeight + 150 + this.blockhashCounter };
  }

  async getBlockHeight(): Promise<number> {
    return this.currentBlockHeight;
  }

  /** Test-only: advances the fake cluster's block height, e.g. to simulate a broadcast's blockhash expiring while a process was down. */
  setBlockHeight(height: number): void {
    this.currentBlockHeight = height;
  }

  /**
   * Genuinely decodes the signed transaction and applies its real,
   * instruction-by-instruction effect to the fake ledger: creating an ATA
   * row, moving lamports for a wrap, SyncNative-ing them into token
   * `amount`, setting/clearing `delegate`/`delegatedAmount` for
   * Approve/Revoke, and moving balances for TransferChecked. This is what
   * makes the simulation meaningful: the code under test builds a real
   * transaction, and this is the one place its actual instructions are
   * inspected, not just assumed to have worked.
   */
  async sendRawTransaction(raw: Buffer | Uint8Array, _options?: { skipPreflight?: boolean }): Promise<string> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("SIMULATED: RPC send failure (e.g. timeout)");
    }

    const tx = Transaction.from(Buffer.from(raw));
    if (!tx.signature) throw new Error("FakeConnection.sendRawTransaction: transaction has no signature");
    const signature = bs58.encode(tx.signature);
    this.sentTransactions.push(tx);

    // Real Solana transactions are atomic: if any instruction fails, none of
    // the transaction's effects apply. Simulate that by mutating scratch
    // clones and only committing them into the real maps on full success.
    const tokenAccounts = new Map(
      [...this.tokenAccounts.entries()].map(([k, v]) => [k, { ...v }]),
    );
    const solBalances = new Map(this.solBalances);

    let failure: string | null = null;

    for (const ix of tx.instructions) {
      if (ix.programId.equals(SystemProgram.programId)) {
        try {
          const decoded = SystemInstruction.decodeTransfer(ix);
          const from = decoded.fromPubkey.toBase58();
          const to = decoded.toPubkey.toBase58();
          const fromBalance = solBalances.get(from) ?? 0n;
          if (fromBalance < BigInt(decoded.lamports)) {
            failure = "insufficient SOL balance for System transfer";
            break;
          }
          solBalances.set(from, fromBalance - BigInt(decoded.lamports));
          solBalances.set(to, (solBalances.get(to) ?? 0n) + BigInt(decoded.lamports));
        } catch {
          /* not a System transfer (e.g. createAccount) — nothing else in this codebase's flows uses it */
        }
        continue;
      }

      if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
        // createAssociatedTokenAccountInstruction key order: payer, ata, owner, mint, systemProgram, tokenProgram[, ...].
        const ata = ix.keys[1].pubkey;
        const owner = ix.keys[2].pubkey;
        const mint = ix.keys[3].pubkey;
        const tokenProgramKey = ix.keys[5]?.pubkey;
        if (!tokenAccounts.has(ata.toBase58())) {
          tokenAccounts.set(ata.toBase58(), {
            mint,
            owner,
            amount: 0n,
            delegate: null,
            delegatedAmount: 0n,
            programId: tokenProgramKey,
          });
        }
        continue;
      }

      // Legacy SPL Token or Token-2022 instruction — the decoders below are
      // program-agnostic over instruction *layout*, so either program id
      // reaches this branch correctly. Each decoder strictly checks
      // ix.programId against the programId it's given (defaulting to legacy
      // TOKEN_PROGRAM_ID), so ix.programId is passed explicitly — otherwise
      // every Token-2022 instruction would silently fail that check and be
      // treated as "not this instruction type," applying no effect at all.
      try {
        const decoded = decodeTransferCheckedInstruction(ix, ix.programId);
        const source = decoded.keys.source.pubkey;
        const destination = decoded.keys.destination.pubkey;
        const instructionMint = decoded.keys.mint.pubkey;
        const amount = decoded.data.amount;
        const src = tokenAccounts.get(source.toBase58());
        const dst = tokenAccounts.get(destination.toBase58());
        if (!src || !dst) {
          failure = "TransferChecked: unknown token account";
          break;
        }
        // Real TransferChecked validates the mint and decimals arguments
        // against the accounts' actual mint on-chain, and rejects the
        // instruction outright on any mismatch -- this is what makes it
        // safe against a caller-side mix-up between two different assets'
        // decimals or token accounts. Mirrored here for fidelity.
        const registeredMint = this.mints.get(instructionMint.toBase58());
        if (!src.mint.equals(instructionMint) || !dst.mint.equals(instructionMint)) {
          failure = "TransferChecked: mint argument does not match source/destination account's actual mint";
          break;
        }
        if (registeredMint && decoded.data.decimals !== registeredMint.decimals) {
          failure = "TransferChecked: decimals argument does not match the mint's actual decimals";
          break;
        }
        if (src.amount < amount || src.delegatedAmount < amount) {
          failure = "insufficient funds or delegation";
          break;
        }
        src.amount -= amount;
        src.delegatedAmount -= amount;
        dst.amount += amount;
        continue;
      } catch {
        /* not TransferChecked */
      }

      try {
        const decoded = decodeSyncNativeInstruction(ix, ix.programId);
        const key = decoded.keys.account.pubkey.toBase58();
        const account = tokenAccounts.get(key);
        if (account) {
          account.amount = solBalances.get(key) ?? account.amount;
        }
        continue;
      } catch {
        /* not SyncNative */
      }

      try {
        const decoded = decodeApproveInstruction(ix, ix.programId);
        const account = tokenAccounts.get(decoded.keys.account.pubkey.toBase58());
        if (!account) {
          failure = "Approve: unknown token account";
          break;
        }
        account.delegate = decoded.keys.delegate.pubkey;
        account.delegatedAmount = decoded.data.amount;
        continue;
      } catch {
        /* not Approve */
      }

      try {
        const decoded = decodeRevokeInstruction(ix, ix.programId);
        const account = tokenAccounts.get(decoded.keys.account.pubkey.toBase58());
        if (!account) {
          failure = "Revoke: unknown token account";
          break;
        }
        account.delegate = null;
        account.delegatedAmount = 0n;
        continue;
      } catch {
        /* not Revoke — e.g. a compute-budget instruction; ignore */
      }
    }

    if (!failure) {
      this.tokenAccounts = tokenAccounts;
      this.solBalances = solBalances;
    }

    this.signatures.set(signature, {
      err: failure,
      confirmationStatus: "confirmed",
    });
    return signature;
  }

  /** Marks a signature as confirmed with no associated ledger effect -- for tests that need a "confirmed tx" precondition without building a real transaction for it. */
  registerConfirmedSignature(signature: string): void {
    this.signatures.set(signature, { err: null, confirmationStatus: "confirmed" });
  }

  registerFailedSignature(signature: string, err: unknown): void {
    this.signatures.set(signature, { err, confirmationStatus: "confirmed" });
  }

  finalizeSignature(signature: string): void {
    const existing = this.signatures.get(signature);
    if (existing) existing.confirmationStatus = "finalized";
  }

  async getSignatureStatus(
    signature: string,
    _config?: { searchTransactionHistory?: boolean },
  ): Promise<{ value: SigStatus | null }> {
    const status = this.signatures.get(signature);
    return { value: status ?? null };
  }

  // Accepts both call shapes actually used by this codebase:
  // sweepAsset's SyncNative call passes a bare signature string, and its
  // TransferChecked call passes { signature, blockhash, lastValidBlockHeight }
  // — matching @solana/web3.js's real overloads.
  async confirmTransaction(
    config: { signature: string; blockhash?: string; lastValidBlockHeight?: number } | string,
    _commitment?: string,
  ): Promise<{ value: { err: unknown } }> {
    if (this.throwOnConfirm) {
      this.throwOnConfirm = false;
      throw new Error("SIMULATED: confirmation hang/timeout (transaction may or may not have landed)");
    }
    const signature = typeof config === "string" ? config : config.signature;
    const status = this.signatures.get(signature);
    return { value: { err: status?.err ?? null } };
  }
}
