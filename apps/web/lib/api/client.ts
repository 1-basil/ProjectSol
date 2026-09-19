// Thin, typed client for the existing ProjectSol backend. This file
// contains no business logic of its own -- it only shapes HTTP calls and
// surfaces errors; every authorization/cap/allowlist/state decision is
// made by the backend and reflected here as-is, never recomputed.

import { API_BASE_URL } from "../env";
import type {
  AllowlistResponse,
  AuthorizeRequest,
  ConfigResponse,
  DashboardResponse,
  ProcessResult,
  RevokeRequest,
  ScanResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    // A network-level failure (backend down, DNS, offline) -- never
    // surfaced as a stack trace to the user; callers map this to a
    // polished "temporarily unavailable" state.
    throw new ApiError("ProjectSol backend is unreachable", 0);
  }

  const text = await res.text();
  const body = text ? safeJsonParse(text) : undefined;

  if (!res.ok) {
    const message = (body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null) ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }

  return body as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const api = {
  getConfig: () => request<ConfigResponse>("/api/config"),

  getAllowlist: () => request<AllowlistResponse>("/api/allowlist"),

  getDashboard: async (wallet: string): Promise<DashboardResponse | null> => {
    try {
      return await request<DashboardResponse>(`/api/dashboard?wallet=${encodeURIComponent(wallet)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },

  scan: (wallet: string) =>
    request<ScanResponse>("/api/scan", {
      method: "POST",
      body: JSON.stringify({ wallet }),
    }),

  authorize: (input: AuthorizeRequest) =>
    request<ProcessResult>("/api/authorize", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  revoke: (input: RevokeRequest) =>
    request<ProcessResult>("/api/revoke", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
