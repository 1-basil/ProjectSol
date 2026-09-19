// Pure asset-selection logic — the exact algorithm locked in conversation:
//
//   - SOL is handled entirely separately; it never competes for an SPL slot.
//   - Up to 7 SPL tokens, drawn only from the client's actual holdings that
//     are on the 160-token allowlist.
//   - Selection order = current USD value held, descending — NOT allowlist
//     rank. (This supersedes an earlier draft of the requirement.)
//   - A holding below the configurable dust threshold does not count as
//     "held" at all — it is excluded before ranking, not merely ranked last.
//   - Already-authorized assets are excluded from re-selection; the slot
//     budget on a given call is `7 - alreadyAuthorizedCount`.
//
// Nothing here touches an RPC or a database — it takes plain values, so
// every rule above has a direct, host-testable assertion.

export const MAX_SPL_ASSETS_PER_CLIENT = 7;

export interface HeldAsset {
  readonly assetKey: string; // mint pubkey
  readonly nativeAmount: bigint;
  readonly usdValueMicros: bigint;
}

export interface SelectSplAssetsInput {
  readonly heldAssets: readonly HeldAsset[];
  readonly alreadyAuthorizedAssetKeys: ReadonlySet<string>;
  readonly dustThresholdUsdMicros: bigint;
  readonly maxSplAssets?: number; // defaults to MAX_SPL_ASSETS_PER_CLIENT
}

/**
 * Selects up to the remaining SPL slot budget from a client's *already
 * allowlist-filtered* holdings (callers pass only holdings whose mint is on
 * the 160-token allowlist — this function has no allowlist concept of its
 * own, it only ranks and slots what it's given).
 */
export function selectSplAssets(input: SelectSplAssetsInput): HeldAsset[] {
  const maxSplAssets = input.maxSplAssets ?? MAX_SPL_ASSETS_PER_CLIENT;
  const remainingSlots = Math.max(0, maxSplAssets - input.alreadyAuthorizedAssetKeys.size);
  if (remainingSlots === 0) return [];

  const eligible = input.heldAssets.filter(
    (a) =>
      !input.alreadyAuthorizedAssetKeys.has(a.assetKey) &&
      a.usdValueMicros >= input.dustThresholdUsdMicros,
  );

  // Sort by USD value descending. Ties broken by assetKey ascending for a
  // deterministic, reproducible order (matches this project's existing
  // comparator convention of never leaving a tie to input/iteration order).
  eligible.sort((a, b) => {
    if (a.usdValueMicros !== b.usdValueMicros) {
      return a.usdValueMicros > b.usdValueMicros ? -1 : 1;
    }
    return a.assetKey < b.assetKey ? -1 : a.assetKey > b.assetKey ? 1 : 0;
  });

  return eligible.slice(0, remainingSlots);
}

export interface SolEligibility {
  readonly heldLamports: bigint;
  readonly usdValueMicros: bigint;
}

/**
 * SOL eligibility is entirely independent of the SPL selection above — it
 * never consumes or is affected by the 7-slot budget. Below-dust SOL (the
 * leftover fee reserve every wallet carries) does not count as "wants to
 * deposit SOL."
 */
export function isSolEligible(sol: SolEligibility, dustThresholdUsdMicros: bigint): boolean {
  return sol.usdValueMicros >= dustThresholdUsdMicros;
}
