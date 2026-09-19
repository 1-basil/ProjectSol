# ProjectSol Prototype — Eligibility, Procedure & Usage Guide

Covers the system as it actually runs today: `apps/web` (frontend) +
`apps/prototype-server` (backend) + `packages/accounting`. This is the one
place that documents asset eligibility rules, the full authorize→sweep
procedure, and day-to-day usage/operator tasks together — the rest of
`docs/` (architecture.md, custody-map.md, the `PHASE-*` files, `specs/`)
describes a separate, earlier on-chain Anchor program design track that is
**not** part of this running system (see the root `README.md`'s note on
`programs/trading-vault`).

Everything below reflects the code as of this writing — every config value,
env var, and endpoint listed was read directly from source, not from memory.

---

## Part 1 — Asset eligibility criteria

### SOL

SOL is eligible if, and only if:

1. Its live USD value (`heldLamports × live SOL price`) is **≥ the dust
   threshold**.
2. The SOL price is fresh (fetched within `oracle_max_staleness_secs`).

SOL never competes with SPL tokens for a slot and is never valued at a
guessed/invented price — a stale or failed price fetch makes SOL ineligible
for that scan, not priced at zero or skipped silently.

Source: `src/scan/selectAssets.ts` (`isSolEligible`), `src/scan/scanWallet.ts`.

### SPL / Token-2022 tokens

A held token is eligible only if **all** of the following hold:

| # | Criterion | Detail |
|---|---|---|
| 1 | **On the allowlist** | Must match one of the 395 mints in `data/allowlist/v2-2026-09-11.json` by mint address — symbol/ticker is never used for matching. Not listed → never eligible, full stop. |
| 2 | **Actually held** | Non-zero balance in a legacy SPL_TOKEN or Token-2022 account owned by the wallet. |
| 3 | **Live, fresh price** | A CoinGecko price fetched within the last `oracle_max_staleness_secs`. A price-fetch failure or missing listing excludes just that asset — never crashes the scan, never values it at $0. |
| 4 | **Above the dust threshold** | USD value held ≥ `dust_threshold_usd_micros`. |
| 5 | **Not already authorized** | Assets already in an ACTIVE authorization for this client are excluded from re-selection. |

Eligible holdings are then **ranked by current USD value held, descending**
(not allowlist rank), ties broken by mint address for determinism, and only
the top `remainingSlots = max_spl_assets_per_client − alreadyAuthorizedCount`
are selected.

Source: `src/scan/selectAssets.ts` (`selectSplAssets`), `src/scan/scanWallet.ts`.

#### Allowlist composition

`data/allowlist/v2-2026-09-11.json`, 395 entries, two disclosed tiers (never
conflated):

- **`VERIFIED_NATIVE`** (ranks 2–161, 160 entries) — individually
  hand-researched; each entry's `evidence` field cites issuer documentation
  or equivalent primary-source confirmation of native (non-bridged) Solana
  issuance.
- **`VERIFIED_NATIVE_HEURISTIC`** (ranks 162–396, 235 entries) — tool-assisted:
  real market-cap/organic-trading-score data (Jupiter token API, organic
  score ≥ 50, no bridged/wrapped naming pattern) plus a manual content-safety
  pass. Native issuance is *inferred*, not individually confirmed — a
  genuinely lower assurance tier.

Rank 1 is reserved for SOL and intentionally does not appear in this file —
SOL is handled by its own wSOL path, never as an SPL allowlist entry.

**Known gap, live-verified**: as of the most recent full verification pass
(all 395 entries checked against `fetchTokenPriceByMint`), **360/395** have a
working live CoinGecko price; **35** do not (CoinGecko has no `usd` field at
all for that mint — not a bug, not rate-limiting, confirmed genuine on
repeat retry). A client holding only one of those 35 will see it silently
excluded from their proposed authorization set by criterion 3 above, exactly
like any other unpriced asset. The full list of the 35 is in the session
history; consider pruning them from the allowlist if this matters to you.

### Current live config values

Read directly from the running backend's own `/api/config` and
`platform_config` table (mainnet, at time of writing):

| Key | Value | Meaning |
|---|---|---|
| `dust_threshold_usd_micros` | `1000000` ($1.00) | Minimum USD value to count as "held" for either SOL or SPL |
| `max_spl_assets_per_client` | `7` | Max SPL slots per client (SOL is separate, never counted against this) |
| `asset_cap_usd_micros` | `1000000000000` ($1,000,000) | Per-asset authorization/sweep ceiling — the cap enforced at sweep time, independent of eligibility |
| `oracle_max_staleness_secs` | `60` | Max age of a cached price before it's treated as stale |
| `oracle_max_confidence_bps` | `100` | Reserved for an on-chain-oracle confidence check; CoinGecko carries no confidence interval, so this is currently unused in practice |
| `sweep_delay_secs` | `12` | Minimum time between authorization confirmation and sweep eligibility (see Part 2) |

---

## Part 2 — Full procedure (connect → sweep → revoke)

1. **Connect wallet** (`apps/web`, `WalletModal.tsx`). Phantom is explicitly
   registered; Solflare and any other Wallet Standard wallet self-register.
   A 1.5s settle window after page load avoids clicking before a wallet
   extension's Wallet Standard registration has finished; clicking a wallet
   that's already the persisted selection connects directly rather than
   going through a no-op re-selection.

2. **Scan** (`POST /api/scan`, `scanWallet.ts`). Backend reads the wallet's
   real on-chain SOL balance and SPL/Token-2022 holdings, prices everything
   against the allowlist, and returns the eligible SOL + top-7 SPL set per
   Part 1's rules. Nothing is recorded yet — this is read-only.

3. **Review & select**. The user picks which of the eligible assets to
   authorize (up to all of them) in the UI.

4. **Authorize — ONE on-chain signature** (`lib/solana/authorization.ts`
   client-side, `processAuthorizationSubmission` server-side). A single
   combined transaction contains, per selected asset:
   - **SPL/Token-2022 assets**: exactly one `Approve` instruction, delegating
     to the pooled wallet.
   - **SOL**: wrap the chosen amount into the client's own wSOL ATA (a
     **self-transfer only** — client → client's own account, never to the
     pooled or company wallet), a `SyncNative`, then `Approve`.

   This transaction contains **zero transfer-to-pooled/company-wallet
   instructions** — authorization only delegates spending authority, it
   never moves funds. Verified by `test/transactionAudit.test.ts` by
   decoding the actual instruction discriminators.

   The backend independently re-verifies the transaction is confirmed
   on-chain, the token account exists, and its delegate is *exactly* the
   configured pooled wallet (never a client-supplied value) before recording
   an ACTIVE `client_asset_authorizations` row. A claimed-but-unconfirmed or
   wrong-delegate submission is rejected, never recorded.

5. **Sweep delay — 12 seconds** (`sweep_delay_secs`, `sweepTiming.ts`).
   Authorization and sweep are deliberately two separate events. A sweep for
   a given authorization is not attempted until `sweep_delay_secs` have
   elapsed since that authorization's persisted `authorized_at` timestamp —
   a pure function of that timestamp vs. the current time, re-checked on
   every indexer pass. No client-side timer, no second client signature; a
   backend restart mid-window simply recomputes the same comparison against
   the same persisted value next pass.

6. **Sweep** (`sweep/sweepAsset.ts`, run by the indexer every
   `INDEXER_INTERVAL_MS`, default 4s):
   - Reconcile any PENDING deposit left from a prior attempt first (see
     restart-safety below).
   - Re-check the delay has elapsed.
   - SOL only: refresh the wSOL balance via `SyncNative`; an ambiguous/timed
     -out confirmation here is non-fatal (idempotent, self-corrects next
     pass) — a genuine on-chain error still fails the sweep with
     `SYNC_NATIVE_FAILED`.
   - Re-verify the on-chain delegate is still the pooled wallet.
   - Re-check cap headroom (`asset_cap_usd_micros` minus cumulative credited).
   - Re-verify price freshness independently (never trusts a caller-supplied
     price).
   - Compute the sweep amount, then `TransferChecked` the funds to the
     **company receiving wallet's** token account for that asset — signed
     entirely by the pooled wallet, no client involvement at all.

7. **Restart-safety & reconciliation**. A PENDING deposit row is written
   *before* broadcast, under a locally-computed signature, guarded by a DB
   unique index (`idx_one_pending_deposit_per_authorization`) so two
   concurrent sweep attempts for the same authorization can never both
   broadcast. Every pass reconciles any existing PENDING row via a plain
   HTTP `getSignatureStatus` call — **no WebSocket subscription is used or
   needed anywhere in this codebase** for this to work; a crash between
   broadcast and confirmation is recovered on the very next pass, never
   double-swept, never silently lost.

8. **Dashboard** (`GET /api/dashboard?wallet=...`, `dashboardData.ts`).
   Real-time, backend-computed view per authorized asset: status,
   cumulative credited, remaining headroom, sweep-eligible-at timestamp and
   boolean, and every transfer's status. The frontend never runs its own
   countdown logic — it renders these values directly.

9. **Revoke** (`POST /api/revoke`, `processRevocationSubmission`). The
   client can revoke any ACTIVE authorization at any time via an on-chain
   `Revoke` instruction; the backend verifies the delegate is actually gone
   on-chain before marking the authorization REVOKED. A revoked
   authorization is never swept, even if it was already past its delay
   window.

---

## Part 3 — Usage

### Running it

```
# from repo root
npm install
```

**Backend** (`apps/prototype-server`):

```
cd apps/prototype-server
cp .env.example .env    # fill in the variables below
node --env-file=.env src/server.ts
```

On startup the server verifies the RPC's live genesis hash matches
`EXPECTED_SOLANA_NETWORK` and refuses to start on a mismatch, and verifies
the company receiving wallet and pooled wallet are distinct addresses.

**Frontend** (`apps/web`):

```
cd apps/web
cp .env.local.example .env.local   # if not already present; fill in below
npm run dev
```

**Tests**: `cd apps/prototype-server && npm test` — currently **146/146
passing**, no network or funded keypair required (an in-memory/temp SQLite
DB and a simulated Solana connection). `cd apps/web && npm run typecheck &&
npm run build` for the frontend (no unit test suite there yet).

### Backend environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | RPC endpoint (HTTP) |
| `EXPECTED_SOLANA_NETWORK` | `devnet` | Must match the RPC's live genesis hash or startup fails closed |
| `DB_PATH` | `./prototype.db` | SQLite file path |
| `POOLED_WALLET_KEYPAIR_PATH` | — | Path to the pooled/delegate signing keypair JSON. This wallet needs the **full keypair** (it signs sweep transactions), not just a public address |
| `COMPANY_RECEIVING_WALLET_ADDRESS` | a hardcoded fallback | Destination for swept funds — a **public address only**, never a keypair; must differ from the pooled wallet |
| `PORT` | `8787` | HTTP listen port |
| `INDEXER_INTERVAL_MS` | `4000` | Sweep-pass polling interval |
| `DISABLE_INDEXER` | unset | Set to `"true"` to run the HTTP API only, no background sweeping (tooling/tests) |
| `ALLOWLIST_VERSION_OVERRIDE` | unset | **Devnet-only** — points the allowlist at a disposable test fixture instead of the real mainnet mint list. Refused outright (hard error) if `EXPECTED_SOLANA_NETWORK` is `mainnet-beta`. |

### Frontend environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8787` | Base URL of the backend above |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://api.devnet.solana.com` | RPC used by the browser's own wallet-connection layer (separate `Connection` instance from the backend's) |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` | Display-only — which cluster "View on Explorer" links point at |
| `NEXT_PUBLIC_DEMO_MODE` | unset | `"true"` shows a persistent DEMO MODE banner. Never set this against real wallets/mainnet |

### API reference (`apps/prototype-server`, all under the backend's base URL)

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| GET | `/api/config` | — | Pooled wallet pubkey, asset cap, dust threshold, max SPL slots |
| GET | `/api/allowlist` | — | Full 395-entry allowlist + the SOL asset key |
| GET | `/api/dashboard` | `?wallet=<pubkey>` | Per-client dashboard view (404 if no client record yet) |
| POST | `/api/scan` | `{ wallet }` | Runs eligibility (Part 1) against live holdings |
| POST | `/api/authorize` | `{ walletPubkey, assetKey, tokenProgram, authorizedTokenAccount, txSignature }` | Verifies and records one authorization |
| POST | `/api/revoke` | `{ walletPubkey, assetKey, authorizedTokenAccount, txSignature }` | Verifies and records one revocation |

`/api/scan`, `/api/authorize`, and `/api/revoke` are rate-limited per
(client IP, route): 20 requests / 60s window. There is no authentication
layer beyond that — these routes are either public data or already gated by
requiring a real, independently-verified on-chain signature.

### Operator tasks

- **Changing a `platform_config` value** (dust threshold, cap, delay, etc.):
  there is no admin API or UI for this — values are seeded once via
  `INSERT OR IGNORE` on first DB creation (`db/client.ts`). To change one on
  an existing database, update the row directly, e.g.:
  ```
  sqlite3 prototype-mainnet.db "UPDATE platform_config SET value = '2000000' WHERE key = 'dust_threshold_usd_micros';"
  ```
  (No backend restart required — every read goes through `getConfig`, which
  queries the table live on each call.)

- **Swapping the pooled wallet or company receiving wallet**: both are
  mainnet-money-affecting. Always (a) derive/verify the new address directly
  from the actual keypair file or a live `/api/config` response — never from
  memory — and (b) get explicit confirmation the intended owner actually
  controls the new address before it goes live. The pooled wallet needs a
  full keypair file (it signs sweeps); the company receiving wallet needs
  only a public address (env var `COMPANY_RECEIVING_WALLET_ADDRESS`).
  Startup will refuse to run if the two addresses coincide.

- **Verifying the allowlist's live prices**: there's no committed script for
  this (it was done as ad-hoc scratch tooling calling the real
  `fetchTokenPriceByMint` for every allowlist entry, rate-limited to
  CoinGecko's free tier). Re-run it before any final mainnet test if you
  suspect allowlist/price drift.

### Known, currently open items

- **35 of 395 allowlist mints have no CoinGecko listing** (see Part 1) —
  silently excluded from selection, not broken, but worth pruning or
  flagging in the UI if it matters for your launch.
- **A stale SOL authorization from an earlier test session** repeatedly
  fails its `SyncNative` refresh every indexer pass (its delegate no longer
  matches the current pooled wallet) — burns a small real transaction fee
  each attempt. Not yet cleaned up; needs either a manual DB fix or a
  "delegate mismatch → mark inactive" backstop.
- **No real browser-wallet end-to-end test against live devnet/mainnet
  has been run outside manual testing** — automated coverage is the
  simulated (`FakeConnection`) test suite plus a small set of manual devnet
  scripts under `scripts/devnet-e2e/`.
