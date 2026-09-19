// Wire types for the existing ProjectSol backend (apps/prototype-server).
// These mirror the actual JSON shapes returned by src/httpHandler.ts --
// every bigint-valued field crosses the wire as a decimal STRING (the
// backend's own json() helper stringifies bigints), so every "*Micros" /
// "*Amount" field below is typed `string`, never `number`, to avoid ever
// losing precision on a financial value in the browser.

export interface ConfigResponse {
  readonly pooledWalletPubkey: string;
  readonly assetCapUsdMicros: string;
  readonly dustThresholdUsdMicros: string;
  readonly maxSplAssetsPerClient: string;
}

export interface AllowlistEntry {
  readonly rank: number;
  readonly symbol: string;
  readonly name: string;
  readonly mint: string;
  readonly decimals: number;
  readonly token_program: "SPL_TOKEN" | "TOKEN_2022";
  readonly market_cap_usd: number;
  readonly verification_status: string;
  readonly evidence: string;
  readonly allowlist_version: string;
  readonly snapshot_at: string;
}

export interface AllowlistResponse {
  readonly sol: "SOL";
  readonly splTokens: readonly AllowlistEntry[];
}

export interface HeldAsset {
  readonly assetKey: string;
  readonly nativeAmount: string;
  readonly usdValueMicros: string;
}

export interface SelectedSplAsset extends HeldAsset {
  readonly entry: AllowlistEntry;
}

export interface ScanResponse {
  readonly solEligible: boolean;
  readonly solHeldLamports: string;
  readonly solUsdValueMicros: string;
  readonly selectedSplAssets: readonly SelectedSplAsset[];
}

export type AuthorizationStatus = "ACTIVE" | "REVOKED";
export type DepositStatus = "PENDING" | "CONFIRMED" | "FINALIZED" | "FAILED";

export interface DashboardTransfer {
  readonly txSignature: string;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly nativeAmount: string;
  readonly usdValueMicros: string;
  readonly status: DepositStatus;
  readonly confirmedAt: string | null;
  readonly finalizedAt: string | null;
  readonly createdAt: string;
}

export interface DashboardAsset {
  readonly assetKey: string;
  readonly symbol: string;
  readonly status: AuthorizationStatus;
  readonly authorizedTokenAccount: string;
  readonly originalAuthorizedNativeAmount: string;
  readonly cumulativeCreditedUsdMicros: string;
  readonly assetCapUsdMicros: string;
  readonly remainingHeadroomUsdMicros: string;
  readonly authorizedAt: string;
  // Real, backend-computed sweep-eligibility timing -- render this
  // directly, never run a local countdown from an arbitrary start point.
  readonly sweepEligibleAt: string;
  readonly sweepEligible: boolean;
  readonly transfers: readonly DashboardTransfer[];
}

export interface DashboardResponse {
  readonly walletPubkey: string;
  readonly clientId: string;
  readonly assets: readonly DashboardAsset[];
  readonly totalCreditedUsdMicros: string;
}

export type TokenProgram = "SPL_TOKEN" | "TOKEN_2022" | "NATIVE_SOL";

export interface AuthorizeRequest {
  readonly walletPubkey: string;
  readonly assetKey: string;
  readonly tokenProgram: TokenProgram;
  readonly authorizedTokenAccount: string;
  readonly txSignature: string;
}

export interface RevokeRequest {
  readonly walletPubkey: string;
  readonly assetKey: string;
  readonly authorizedTokenAccount: string;
  readonly txSignature: string;
}

export type ProcessResult =
  | { readonly outcome: "RECORDED"; readonly authorizationId: string }
  | { readonly outcome: "ALREADY_PROCESSED"; readonly authorizationId: string }
  | { readonly outcome: "REJECTED"; readonly reason: string };
