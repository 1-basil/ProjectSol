// Display-only formatting helpers. Every value here comes from the backend
// (or from live on-chain reads) as an exact bigint/string; converting to a
// JS number happens ONLY at the last step, for rendering, and is never fed
// back into any authorization/amount decision.

const USD_MICROS_PER_UNIT = 1_000_000n;

/** "1000000" (1e6 = $1.00) -> "$1.00" / "$1,234.56" */
export function formatUsdMicros(usdMicros: string | bigint, opts?: { compact?: boolean }): string {
  const value = typeof usdMicros === "string" ? BigInt(usdMicros) : usdMicros;
  const dollars = Number(value) / Number(USD_MICROS_PER_UNIT);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: opts?.compact ? "compact" : "standard",
    maximumFractionDigits: opts?.compact ? 2 : 2,
    minimumFractionDigits: opts?.compact ? 0 : 2,
  }).format(dollars);
}

/** Native integer amount + decimals -> a clean human quantity string, e.g. (5000000n, 6) -> "5.00" */
export function formatNativeAmount(native: string | bigint, decimals: number, maxFractionDigits = 4): string {
  const value = typeof native === "string" ? BigInt(native) : native;
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = value % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFractionDigits).replace(/0+$/, "");
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
}

export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso.endsWith("Z") ? iso : `${iso}Z`).getTime();
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
