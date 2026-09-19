// "ProjectSol" with the Solana mark standing in for the letter S.
function SolanaS({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 397.7 311.7" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id="wordmark-sol" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="rgb(var(--accent))" />
          <stop offset="100%" stopColor="rgb(var(--accent-2))" />
        </linearGradient>
      </defs>
      <g fill="url(#wordmark-sol)">
        <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
        <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
        <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
      </g>
    </svg>
  );
}

export function Wordmark({ className = "text-[15px]" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center font-semibold tracking-tight text-ink ${className}`} aria-label="ProjectSol">
      <span aria-hidden>Project</span>
      <SolanaS className="mx-[0.04em] h-[0.78em] w-auto" />
      <span aria-hidden>ol</span>
    </span>
  );
}
