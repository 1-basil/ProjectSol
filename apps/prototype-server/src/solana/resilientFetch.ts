// A custom `fetch` implementation wired into every Connection this backend
// constructs (see connection.ts), replacing @solana/web3.js's silent
// reliance on the platform default fetch with no timeout and no retry
// policy of our own. Addresses the reliability gap behind real observed
// symptoms this session (e.g. "TransactionExpiredTimeoutError: not
// confirmed in 30.00 seconds" against a real mainnet RPC): every HTTP
// request now has an explicit, bounded per-attempt timeout, and transient
// failures (network errors, 429, 5xx) are retried a bounded number of
// times with exponential backoff + jitter -- never an unbounded retry
// loop, and never a request that can hang forever.
//
// This changes ONLY how HTTP requests to the RPC are transported. It does
// not touch authorization semantics, the sweep delay, the allowlist, the
// SOL/wSOL or SPL authorization model, the company receiving wallet, or
// sweep accounting -- those all continue to call the same Connection
// methods exactly as before.

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 300;
const MAX_DELAY_MS = 5_000;
const PER_ATTEMPT_TIMEOUT_MS = 15_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Full jitter: a random delay between 0 and the exponential ceiling for this attempt -- avoids every retrying client synchronizing on the same retry instant. */
function backoffWithJitter(attempt: number): number {
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.floor(Math.random() * ceiling);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a fetch function suitable for @solana/web3.js's
 * `ConnectionConfig.fetch`. Every individual HTTP attempt is bounded by
 * PER_ATTEMPT_TIMEOUT_MS (via AbortSignal.timeout) so a stalled RPC
 * provider can never block a caller indefinitely. A network-level failure,
 * a 429, or a 5xx is retried up to MAX_ATTEMPTS times total, with
 * exponential backoff + full jitter between attempts -- bounded, never
 * infinite. Any other HTTP status (a real 4xx, or a successful response)
 * is returned immediately, unmodified, exactly as the caller would expect
 * from a normal fetch.
 */
export function createResilientFetch(): typeof fetch {
  return async function resilientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(backoffWithJitter(attempt - 1));
      try {
        const res = await fetch(input, { ...init, signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS) });
        if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS - 1) {
          lastError = new Error(`resilientFetch: RPC responded HTTP ${res.status}`);
          continue;
        }
        return res;
      } catch (e) {
        lastError = e;
        if (attempt < MAX_ATTEMPTS - 1) continue;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`resilientFetch: request failed: ${String(lastError)}`);
  };
}
