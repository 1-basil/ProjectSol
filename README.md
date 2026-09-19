# ProjectSol

A Solana custodial-deposit prototype: clients connect a wallet, review eligible
SOL + SPL assets, grant one on-chain authorization signature, and a backend
indexer automatically sweeps authorized assets (up to a fixed per-asset USD
cap) to a company receiving wallet. Authorizations are revocable at any time.

This repo contains two runnable pieces:

- **`apps/web`** — the Next.js 14 frontend (landing page + the full
  connect → scan → review → authorize → process → dashboard → revoke flow).
- **`apps/prototype-server`** — the Node.js backend: wallet scanning,
  one-signature authorization verification, the sweep indexer, the revoke
  flow, and the dashboard API.
- **`packages/accounting`** — a shared pure-math workspace package
  (`@platform/accounting`) some backend accounting logic depends on.

> This monorepo also contains a separate, unrelated on-chain Anchor program
> (`programs/trading-vault`, `Anchor.toml`, `Cargo.*`) from a different,
> earlier design track. It is **not** part of ProjectSol's frontend/backend
> above and is intentionally excluded from this export.

## Requirements

- Node.js >= 22 (this repo relies on Node's native TypeScript support to run
  `.ts` source files directly, with no separate build/transpile step for the
  backend)
- npm 9+ (npm workspaces)

## Install

From the repo root:

```
npm install
```

This installs all three workspaces (`apps/web`, `apps/prototype-server`,
`packages/accounting`) in one pass.

## Running the backend (`apps/prototype-server`)

1. Copy the env example and fill it in:
   ```
   cd apps/prototype-server
   cp .env.example .env
   ```
2. Generate a **disposable devnet-only** keypair for the pooled/delegate
   signing wallet (this is the one private key the server ever holds; it is
   never derived from or related to any client's key):
   ```
   solana-keygen new --outfile ./pooled-wallet.json --no-bip39-passphrase
   ```
   Point `POOLED_WALLET_KEYPAIR_PATH` in `.env` at that file. Fund it with
   devnet SOL (`solana airdrop 2 <pubkey> --url devnet`) before authorizing
   anything against it.
3. Start the server (the `npm start` script in this package currently points
   at a stale `src/index.ts` that does not exist — start the real entry
   point directly instead):
   ```
   node --env-file=.env src/server.ts
   ```
   On startup the server verifies the RPC's live genesis hash actually
   matches `EXPECTED_SOLANA_NETWORK` and refuses to start otherwise.

Run the backend's test suite (no network/keypair required — DB and chain
interactions are exercised against an in-memory/temp SQLite DB and simulated
Solana state):

```
cd apps/prototype-server
npm test
```

As of this export: **108/108 tests passing**.

### Devnet end-to-end scripts (`scripts/devnet-e2e/`)

`run.ts`, `eightAssetsOneSignature.ts`, and `revokeAndTopUp.ts` are manual,
real-devnet harnesses (they submit real devnet transactions). They
self-generate disposable keypairs into `scripts/devnet-e2e/keys/` on first
run (via `Keypair.generate()`) if that directory is empty — **no keypairs are
included in this export**; the scripts will create fresh ones for you. Never
point any of these at a mainnet RPC or a funded/production key.

## Running the frontend (`apps/web`)

```
cd apps/web
cp .env.local.example .env.local
npm run dev
```

Point `NEXT_PUBLIC_API_BASE_URL` in `.env.local` at your running backend
(defaults to `http://localhost:8787`, matching the backend's default `PORT`).

Other commands:

```
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
npm run build       # production build
```

As of this export: typecheck, lint, and production build all pass cleanly.

**Note on scope of verification**: real browser-wallet (Phantom/Solflare)
end-to-end testing against a live devnet backend has **not** been performed
as part of this export — only static verification (typecheck/lint/build,
server-rendered HTML) and the backend's automated test suite were run.

## Repository layout

```
ProjectSol/
├── apps/
│   ├── web/                 Next.js frontend
│   └── prototype-server/    Node backend (indexer, authorization, sweep, revoke, API)
├── packages/
│   └── accounting/          shared pure-math workspace package
├── docs/                    architecture/design/spec documentation
├── package.json             workspace root
└── package-lock.json
```

## Security notes

- The backend never accepts a client's private key, seed phrase, or signed
  transaction it did not itself verify on-chain.
- The company receiving wallet is a fixed public address, distinct from the
  pooled/delegate signing wallet; no private key for it is ever held by this
  codebase.
- No secrets (keypairs, `.env` files with real values, API keys) are included
  in this export — see each `.env*.example` file for the variables you need
  to supply yourself.
