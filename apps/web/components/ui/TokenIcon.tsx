"use client";

import Image from "next/image";

// Real logos (cropped from popular-cryptocurrency-logos-set) for the coins we
// have artwork for. Anything else falls back to the monogram below.
export const COIN_LOGOS: Record<string, string> = {
  BTC: "/coins/btc.png",
  ETH: "/coins/eth.png",
  SOL: "/coins/sol.png",
  USDT: "/coins/usdt.png",
  USDC: "/coins/usdc.png",
  XRP: "/coins/xrp.png",
  AVAX: "/coins/avax.png",
  BNB: "/coins/bnb.png",
  ADA: "/coins/ada.png",
  SHIB: "/coins/shib.png",
  DOT: "/coins/dot.png",
  DOGE: "/coins/doge.png",
  LUNA: "/coins/luna.png",
  LTC: "/coins/ltc.png",
};

// The backend's allowlist doesn't carry logo URIs, and we never fabricate
// brand assets we don't actually have -- so each token gets a clean,
// deterministic monogram instead of a placeholder/broken image. The color
// is derived from the mint address itself, so a given token always renders
// identically.

function hashToHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

// A ticker alone is not identity -- anyone can mint a token called "USDC". A
// logo is only shown when the seed is the real mint (or the native "SOL" key),
// or when the seed equals the symbol (decorative marketing use, no mint claimed).
const TRUSTED_SEEDS: Record<string, string[]> = {
  SOL: ["SOL"],
  USDC: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  USDT: ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"],
};

function logoFor(symbol: string, seed: string): string | undefined {
  const key = symbol.toUpperCase();
  const logo = COIN_LOGOS[key];
  if (!logo) return undefined;
  if (seed === symbol) return logo;
  return TRUSTED_SEEDS[key]?.includes(seed) ? logo : undefined;
}

export function TokenIcon({ symbol, seed, size = 40 }: { symbol: string; seed: string; size?: number }) {
  const logo = logoFor(symbol, seed);
  if (logo) {
    return (
      <Image
        src={logo}
        alt=""
        width={size}
        height={size}
        unoptimized
        className="shrink-0 rounded-full"
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  const hue = hashToHue(seed);
  const initials = symbol.slice(0, symbol === "SOL" ? 3 : 2).toUpperCase();

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tracking-tight text-white/90 ring-1 ring-inset ring-white/10"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${hue} 70% 42%), hsl(${(hue + 40) % 360} 70% 30%))`,
        fontSize: size * 0.32,
      }}
      aria-hidden
    >
      {initials}
    </div>
  );
}
