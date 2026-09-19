// The HTTP request-handling logic, extracted from server.ts as a pure,
// side-effect-free factory so it can be exercised directly in tests against
// a FakeConnection -- server.ts previously did all of its real startup
// (opening the real DB, the real RPC connection, the real pooled wallet,
// a live network-identity check) at module top level, which made it
// impossible to import in a test without those real side effects. This
// file contains no top-level side effects at all; server.ts is now a thin
// composition of "do the real startup" + "hand createHttpHandler its deps."
// Behavior is unchanged -- this is an extraction, not a redesign.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connection, Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { DatabaseSync } from "node:sqlite";
import { getConfig } from "./db/client.ts";
import { scanWallet } from "./scan/scanWallet.ts";
import { getDashboardView } from "./dashboard/dashboardData.ts";
import { listActiveAuthorizations } from "./authorization/authorizationStore.ts";
import { processAuthorizationSubmission, processRevocationSubmission } from "./authorization/processAuthorization.ts";
import { tokenProgramIdFor } from "./authorization/splAuthorization.ts";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./solana/connection.ts";
import { SOL_ASSET_KEY, loadAllowlist } from "./allowlist/loadAllowlist.ts";

export interface HttpHandlerDeps {
  readonly connection: Connection;
  readonly db: DatabaseSync;
  readonly pooledWallet: Keypair;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(text);
}

// Every real request body this API ever needs is a handful of short fields
// (pubkeys, a signature, an asset key) -- a few hundred bytes at most. This
// is deliberately generous while still ruling out unbounded buffering of a
// malicious or broken client's request body.
const MAX_REQUEST_BODY_BYTES = 16 * 1024;

export class RequestBodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      // Stop retaining bytes (memory stays bounded regardless of how much
      // more the client sends) but keep draining the stream rather than
      // destroying the socket -- destroying it here races with the client
      // still writing and tends to surface as a broken connection instead
      // of a clean 413 response.
      tooLarge = true;
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  if (tooLarge) {
    throw new RequestBodyTooLargeError(`request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// Basic, dependency-light, per-process in-memory rate limiting -- fixed
// window per (client IP, route). Not a substitute for authentication (none
// is added here, by design: the routes this guards are either public data
// or already gated by requiring a real on-chain signature) -- this exists
// only to stop unauthenticated callers from using this server as a free,
// unlimited amplifier against its own RPC and CoinGecko quota.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMITED_ROUTES = new Set(["/api/scan", "/api/authorize", "/api/revoke"]);

function createRateLimiter(): (key: string) => boolean {
  const hits = new Map<string, { count: number; windowStart: number }>();
  return function isRateLimited(key: string): boolean {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      hits.set(key, { count: 1, windowStart: now });
      return false;
    }
    entry.count += 1;
    return entry.count > RATE_LIMIT_MAX_REQUESTS;
  };
}

export function createHttpHandler(deps: HttpHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { connection, db, pooledWallet } = deps;
  const isRateLimited = createRateLimiter();

  return async function handleRequest(req, res) {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");

      if (RATE_LIMITED_ROUTES.has(url.pathname)) {
        const clientKey = `${req.socket.remoteAddress ?? "unknown"}:${url.pathname}`;
        if (isRateLimited(clientKey)) {
          json(res, 429, { error: "rate limit exceeded, try again later" });
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        json(res, 200, {
          pooledWalletPubkey: pooledWallet.publicKey.toBase58(),
          assetCapUsdMicros: getConfig(db, "asset_cap_usd_micros"),
          dustThresholdUsdMicros: getConfig(db, "dust_threshold_usd_micros"),
          maxSplAssetsPerClient: getConfig(db, "max_spl_assets_per_client"),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/allowlist") {
        json(res, 200, { sol: SOL_ASSET_KEY, splTokens: loadAllowlist() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/dashboard") {
        const wallet = url.searchParams.get("wallet");
        if (!wallet) return json(res, 400, { error: "missing ?wallet" });
        const view = getDashboardView(db, wallet);
        if (!view) return json(res, 404, { error: "no client record for this wallet yet" });
        json(res, 200, view);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/scan") {
        const body = await readJsonBody(req);
        const wallet = new PublicKey(body.wallet);
        const clientRow = db.prepare("SELECT id FROM clients WHERE wallet_pubkey = ?").get(wallet.toBase58()) as
          | { id: string }
          | undefined;
        const alreadyAuthorized = clientRow
          ? new Set(listActiveAuthorizations(db, clientRow.id).map((a) => a.assetKey))
          : new Set<string>();
        const result = await scanWallet(connection, db, wallet, alreadyAuthorized);
        json(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/authorize") {
        const body = await readJsonBody(req);
        // wSOL (tokenProgram "NATIVE_SOL" in our own vocabulary) is itself a
        // legacy-Token-Program mint on-chain — only an actual Token-2022
        // asset needs the other program ID here.
        const programId = body.tokenProgram === "TOKEN_2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        const result = await processAuthorizationSubmission({
          connection,
          db,
          walletPubkey: body.walletPubkey,
          assetKey: body.assetKey,
          tokenProgram: body.tokenProgram,
          authorizedTokenAccount: body.authorizedTokenAccount,
          // Never taken from the request body: the only delegate this
          // system ever authorizes is its own configured pooled wallet. A
          // client (or an attacker) supplying this value would make the
          // delegate check inside processAuthorizationSubmission
          // tautological -- see the HTTP regression test that pins this.
          expectedDelegate: pooledWallet.publicKey.toBase58(),
          txSignature: body.txSignature,
          programId,
        });
        json(res, result.outcome === "REJECTED" ? 400 : 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/revoke") {
        const body = await readJsonBody(req);
        const allowlistEntry = loadAllowlist().find((e) => e.mint === body.assetKey);
        const programId = allowlistEntry ? tokenProgramIdFor(allowlistEntry) : TOKEN_PROGRAM_ID;
        const result = await processRevocationSubmission({
          connection,
          db,
          walletPubkey: body.walletPubkey,
          assetKey: body.assetKey,
          authorizedTokenAccount: body.authorizedTokenAccount,
          txSignature: body.txSignature,
          programId,
        });
        json(res, result.outcome === "REJECTED" ? 400 : 200, result);
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, 413, { error: err.message });
        return;
      }
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
