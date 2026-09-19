"use client";

// A slow, ambient visualization of the actual product flow -- wallet,
// authorization, the assets it covers, automated processing, and
// ProjectSol's custody -- rendered as light traveling along fixed paths.
// Pure CSS `offset-path` animation: GPU-composited, no per-frame JS, and
// automatically stilled by the global prefers-reduced-motion rule.

const NODES = [
  { label: "Wallet", sub: "Your Solana wallet" },
  { label: "Authorization", sub: "One signature" },
  { label: "SOL + Assets", sub: "Up to 8 approved" },
  { label: "Processing", sub: "Automated" },
  { label: "ProjectSol", sub: "Custody" },
];

const PATH = "M 0 60 C 90 60, 90 60, 180 60 S 360 60, 450 60 S 630 60, 720 60";

export function HeroFlow() {
  return (
    <div className="glass relative w-full overflow-hidden rounded-3xl p-8 sm:p-10">
      <div className="pointer-events-none absolute inset-0 bg-grid-fade opacity-60" aria-hidden />

      <svg viewBox="0 0 720 120" className="w-full" aria-hidden focusable="false">
        <defs>
          <linearGradient id="pathGradient" x1="0" x2="1">
            <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity="0.05" />
            <stop offset="50%" stopColor="rgb(var(--accent))" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(var(--accent-2))" stopOpacity="0.05" />
          </linearGradient>
          <radialGradient id="dotGlow">
            <stop offset="0%" stopColor="white" stopOpacity="1" />
            <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity="0" />
          </radialGradient>
        </defs>

        <path d={PATH} fill="none" stroke="url(#pathGradient)" strokeWidth="1.5" />

        {[0, 1, 2].map((i) => (
          <circle key={i} r="3.5" fill="url(#dotGlow)" className="flow-dot" style={{ animationDelay: `${i * 1.6}s` }} />
        ))}

        {NODES.map((node, i) => {
          const x = (720 / (NODES.length - 1)) * i;
          return (
            <g key={node.label} transform={`translate(${x}, 60)`}>
              <circle r="5" fill="rgb(var(--surface-2))" stroke="rgb(var(--accent))" strokeWidth="1.25" />
              <circle r="10" fill="none" stroke="rgb(var(--accent))" strokeOpacity="0.18" strokeWidth="1" />
            </g>
          );
        })}
      </svg>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-5">
        {NODES.map((node) => (
          <div key={node.label} className="text-center">
            <p className="text-[13px] font-medium text-ink">{node.label}</p>
            <p className="mt-0.5 text-[11px] text-ink-faint">{node.sub}</p>
          </div>
        ))}
      </div>

      <style jsx>{`
        .flow-dot {
          offset-path: path("${PATH}");
          offset-rotate: 0deg;
          animation: travel 4.8s linear infinite;
        }
        @keyframes travel {
          from {
            offset-distance: 0%;
            opacity: 0;
          }
          8% {
            opacity: 1;
          }
          92% {
            opacity: 1;
          }
          to {
            offset-distance: 100%;
            opacity: 0;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .flow-dot {
            animation: none;
            offset-distance: 50%;
            opacity: 0.6;
          }
        }
      `}</style>
    </div>
  );
}
