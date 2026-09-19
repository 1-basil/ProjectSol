"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useAppActions, useAppState } from "../../lib/app-state";
import { api, ApiError } from "../../lib/api/client";
import type { AllowlistResponse, ConfigResponse } from "../../lib/api/types";
import {
  buildCombinedAuthorizationTransaction,
  buildRevokeInstruction,
  computeApprovalCeiling,
  SOL_ASSET_KEY,
} from "../../lib/solana/authorization";
import { useToast } from "../ui/Toast";
import { ConnectPrompt } from "./ConnectPrompt";
import { ScanningScreen } from "./ScanningScreen";
import { AssetReview } from "./AssetReview";
import { AuthorizationSummary } from "./AuthorizationSummary";
import { SignatureMoment } from "./SignatureMoment";
import { ProcessingScreen } from "./ProcessingScreen";
import { Dashboard } from "./Dashboard";
import { ErrorPanel, friendlyErrorMessage } from "./ErrorPanel";

// A conservative buffer left un-wrapped so the wallet always retains SOL for
// future transaction fees -- wrapping 100% of a client's SOL balance into
// wSOL would leave them unable to pay for anything afterward.
const SOL_FEE_RESERVE_LAMPORTS = 5_000_000n;

const PROCESSING_POLL_INTERVAL_MS = 1500;

export function AppExperience() {
  const { connected, publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { state } = useAppState();
  const actions = useAppActions();
  const { push } = useToast();

  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [allowlist, setAllowlist] = useState<AllowlistResponse | null>(null);
  const [submittingAuthorization, setSubmittingAuthorization] = useState(false);
  const [fatalError, setFatalError] = useState<{ title: string; description: string } | null>(null);
  const planRef = useRef<readonly { assetKey: string }[]>([]);

  const decimalsByAssetKey = new Map<string, number>();
  decimalsByAssetKey.set(SOL_ASSET_KEY, 9);
  for (const entry of allowlist?.splTokens ?? []) decimalsByAssetKey.set(entry.mint, entry.decimals);

  const tokenProgramByAssetKey = new Map<string, "SPL_TOKEN" | "TOKEN_2022">();
  for (const entry of allowlist?.splTokens ?? []) tokenProgramByAssetKey.set(entry.mint, entry.token_program);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => undefined);
    api.getAllowlist().then(setAllowlist).catch(() => undefined);
  }, []);

  const walletAddress = publicKey?.toBase58() ?? null;

  const loadInitialState = useCallback(
    async (wallet: string) => {
      actions.setStep("checking");
      setFatalError(null);
      try {
        const dashboard = await api.getDashboard(wallet);
        if (dashboard && dashboard.assets.length > 0) {
          actions.setDashboard(dashboard);
          actions.setStep("dashboard");
          return;
        }
        actions.setStep("scanning");
        const scan = await api.scan(wallet);
        actions.setScan(scan);
        actions.setStep("review");
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : "network";
        setFatalError(friendlyErrorMessage("network", msg));
        actions.setStep("idle");
      }
    },
    [actions],
  );

  useEffect(() => {
    if (connected && walletAddress) {
      void loadInitialState(walletAddress);
    } else {
      actions.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, walletAddress]);

  async function signAndSend(tx: Transaction): Promise<string> {
    if (!publicKey) throw new Error("wallet not connected");
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latest.blockhash;
    tx.feePayer = publicKey;
    const signature = await sendTransaction(tx, connection);
    await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
    return signature;
  }

  async function handleAuthorize() {
    if (!publicKey || !state.scan || !config) return;
    setSubmittingAuthorization(true);
    try {
      const assetCapUsdMicros = BigInt(config.assetCapUsdMicros);
      const includeSol = state.selectedAssetKeys.has(SOL_ASSET_KEY) && state.scan.solEligible;
      const splAssets = state.scan.selectedSplAssets.filter((a) => state.selectedAssetKeys.has(a.assetKey));

      const solHeld = BigInt(state.scan.solHeldLamports);
      const solWrapAmount = solHeld > SOL_FEE_RESERVE_LAMPORTS ? solHeld - SOL_FEE_RESERVE_LAMPORTS : 0n;
      const solDelegated = includeSol ? computeApprovalCeiling(assetCapUsdMicros, solWrapAmount, BigInt(state.scan.solUsdValueMicros)) : 0n;

      const splDelegatedAmounts = splAssets.map((a) =>
        computeApprovalCeiling(assetCapUsdMicros, BigInt(a.nativeAmount), BigInt(a.usdValueMicros)),
      );

      const { transaction, plan } = await buildCombinedAuthorizationTransaction({
        connection,
        owner: publicKey,
        pooledWallet: new PublicKey(config.pooledWalletPubkey),
        includeSol,
        solWrapAmountLamports: solWrapAmount,
        solDelegatedAmountLamports: solDelegated,
        splAssets,
        splDelegatedAmounts,
      });

      const signature = await signAndSend(transaction);
      actions.startAuthorization();
      actions.authorizationSigned(signature);
      planRef.current = plan;

      for (const item of plan) {
        const result = await api.authorize({
          walletPubkey: publicKey.toBase58(),
          assetKey: item.assetKey,
          tokenProgram: item.tokenProgram,
          authorizedTokenAccount: item.authorizedTokenAccount.toBase58(),
          txSignature: signature,
        });
        if (result.outcome === "REJECTED") {
          push({ tone: "danger", title: "Authorization could not be confirmed", description: `${item.assetKey}: ${result.reason}` });
        }
      }

      for (const item of plan) actions.setAssetProcessingState(item.assetKey, "authorized");
      actions.setStep("awaiting-signature");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const friendly = friendlyErrorMessage("authorize", raw);
      push({ tone: "danger", ...friendly });
    } finally {
      setSubmittingAuthorization(false);
    }
  }

  // Poll the real backend for actual per-asset sweep progress -- never
  // fabricates a status, only reflects what /api/dashboard reports.
  useEffect(() => {
    if (state.step !== "processing" || !walletAddress) return;
    let cancelled = false;

    async function poll() {
      try {
        const dashboard = await api.getDashboard(walletAddress!);
        if (cancelled || !dashboard) return;
        actions.setDashboard(dashboard);

        for (const item of planRef.current) {
          const asset = dashboard.assets.find((a) => a.assetKey === item.assetKey);
          if (!asset || asset.transfers.length === 0) {
            actions.setAssetProcessingState(item.assetKey, "authorized");
            continue;
          }
          const latest = asset.transfers[asset.transfers.length - 1]!;
          if (latest.status === "FAILED") actions.setAssetProcessingState(item.assetKey, "failed");
          else if (latest.status === "PENDING") actions.setAssetProcessingState(item.assetKey, "processing");
          else actions.setAssetProcessingState(item.assetKey, "completed");
        }
      } catch {
        // A transient poll failure isn't fatal -- just try again on the next tick.
      }
    }

    void poll();
    const interval = setInterval(poll, PROCESSING_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [state.step, walletAddress, actions]);

  const allProcessingDone =
    planRef.current.length > 0 &&
    planRef.current.every((item) => {
      const s = state.processingByAsset.get(item.assetKey);
      return s === "completed" || s === "failed";
    });

  async function handleRevoke(assetKey: string): Promise<boolean> {
    if (!publicKey || !state.dashboard || !walletAddress) return false;
    const asset = state.dashboard.assets.find((a) => a.assetKey === assetKey);
    if (!asset) return false;

    const tokenProgram = assetKey === SOL_ASSET_KEY ? "NATIVE_SOL" : (tokenProgramByAssetKey.get(assetKey) ?? "SPL_TOKEN");
    const authorizedTokenAccount = new PublicKey(asset.authorizedTokenAccount);
    const instruction = buildRevokeInstruction({ owner: publicKey, authorizedTokenAccount, tokenProgram });
    const tx = new Transaction().add(instruction);

    try {
      const signature = await signAndSend(tx);
      const result = await api.revoke({
        walletPubkey: walletAddress,
        assetKey,
        authorizedTokenAccount: asset.authorizedTokenAccount,
        txSignature: signature,
      });
      if (result.outcome === "REJECTED") {
        push({ tone: "danger", title: "Revocation could not be confirmed", description: result.reason });
        return false;
      }
      const refreshed = await api.getDashboard(walletAddress);
      actions.setDashboard(refreshed);
      push({ tone: "success", title: "Authorization revoked", description: `${asset.symbol} authorization has been revoked.` });
      return true;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      push({ tone: "danger", ...friendlyErrorMessage("revoke", raw) });
      return false;
    }
  }

  if (!connected) return <ConnectPrompt />;

  if (fatalError) return <div className="flex min-h-[70vh] items-center justify-center px-6"><ErrorPanel {...fatalError} onRetry={() => walletAddress && loadInitialState(walletAddress)} /></div>;

  switch (state.step) {
    case "idle":
    case "checking":
      return <ScanningScreen />;
    case "scanning":
      return <ScanningScreen />;
    case "review":
      return state.scan ? (
        <AssetReview scan={state.scan} selectedAssetKeys={state.selectedAssetKeys} onToggle={actions.toggleAsset} onContinue={() => actions.setStep("summary")} />
      ) : null;
    case "summary":
      return state.scan ? (
        <AuthorizationSummary scan={state.scan} config={config} selectedAssetKeys={state.selectedAssetKeys} submitting={submittingAuthorization} onAuthorize={handleAuthorize} />
      ) : null;
    case "awaiting-signature":
      return <SignatureMoment onDone={() => actions.setStep("processing")} />;
    case "processing": {
      const items = planRef.current.map((item) => ({
        assetKey: item.assetKey,
        symbol: item.assetKey === SOL_ASSET_KEY ? "SOL" : (state.scan?.selectedSplAssets.find((a) => a.assetKey === item.assetKey)?.entry.symbol ?? item.assetKey),
      }));
      // Real, backend-computed eligibility timestamps for the "authorized,
      // waiting to sweep" state below -- never a value invented client-side.
      const sweepEligibleAtByAsset = new Map(state.dashboard?.assets.map((a) => [a.assetKey, a.sweepEligibleAt]) ?? []);
      return (
        <ProcessingScreen
          items={items}
          processingByAsset={state.processingByAsset}
          sweepEligibleAtByAsset={sweepEligibleAtByAsset}
          authorizationStartedAt={state.authorizationStartedAt}
          authorizationElapsedMs={allProcessingDone ? state.authorizationElapsedMs : null}
          allCompleted={allProcessingDone}
          onContinue={() => actions.setStep("dashboard")}
        />
      );
    }
    case "dashboard":
      return state.dashboard ? <Dashboard dashboard={state.dashboard} decimalsByAssetKey={decimalsByAssetKey} onRevokeAsset={handleRevoke} /> : <ScanningScreen />;
    default:
      return null;
  }
}
