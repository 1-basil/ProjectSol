import { TokenIcon, COIN_LOGOS } from "../ui/TokenIcon";

const SYMBOLS = Object.keys(COIN_LOGOS);

// Pure-CSS transform marquee: compositor-only, no JS per frame.
export function CoinMarquee() {
  const row = [...SYMBOLS, ...SYMBOLS];
  return (
    <section className="border-y border-white/10 py-10" aria-label="Supported assets">
      <p className="mb-6 text-center text-[13px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
        Built for the assets you hold
      </p>
      <div
        className="overflow-hidden"
        style={{ maskImage: "linear-gradient(90deg, transparent, black 12%, black 88%, transparent)", WebkitMaskImage: "linear-gradient(90deg, transparent, black 12%, black 88%, transparent)" }}
      >
        <div className="coin-track flex w-max items-center gap-12 px-6">
          {row.map((symbol, i) => (
            <div key={`${symbol}-${i}`} className="flex items-center gap-3 opacity-80">
              <TokenIcon symbol={symbol} seed={symbol} size={40} />
              <span className="text-lg font-semibold tracking-tight text-ink">{symbol}</span>
            </div>
          ))}
        </div>
      </div>
      <style>{`
        .coin-track { animation: coin-scroll 40s linear infinite; will-change: transform; }
        @keyframes coin-scroll { to { transform: translateX(-50%); } }
      `}</style>
    </section>
  );
}
