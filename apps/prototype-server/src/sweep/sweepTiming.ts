// Pure timing logic for the authorization -> delayed-sweep gate. Deliberately
// separate from sweepAsset.ts's fund-movement logic -- this module answers
// exactly one question ("has the delay elapsed for this authorization?") as
// a stateless function of a persisted timestamp, never as a stored countdown
// or in-memory timer. That's what makes it restart-safe for free: there is
// no timer object to lose when the process dies, only a comparison against
// client_asset_authorizations.authorized_at, which the database already
// persists durably at the exact moment recordAuthorization() confirms a
// genuinely new authorization (see authorizationStore.ts -- retried/
// already-processed submissions never touch authorized_at, only a real new
// APPROVED or RE_APPROVED event does).
//
// This intentionally never reads process start time, request time, or any
// other clock anchor except authorized_at + now. "12 seconds since
// confirmation" means exactly that, computed fresh every time it's asked,
// whether that's 3 seconds after a restart or 3 days after one.

// authorized_at is always written as new Date().toISOString() by the real
// production write path (recordAuthorization) -- unambiguous UTC. Some
// hand-crafted test fixtures insert it via raw SQL as SQLite's own
// datetime('now') instead, which is ALSO UTC but carries no 'Z'/offset
// marker, and JS's Date.parse falls back to interpreting an unmarked
// "YYYY-MM-DD HH:MM:SS" string as LOCAL time -- the exact same class of bug
// sweepAsset.ts's isPriceFreshForSweep already works around for
// price_cache.fetched_at. Normalized the same way here, so this is correct
// under either format rather than silently timezone-dependent.
function parseAsUtcMs(timestamp: string): number {
  const hasTimezoneMarker = /Z$|[+-]\d\d:\d\d$/.test(timestamp);
  const normalized = hasTimezoneMarker ? timestamp : `${timestamp.replace(" ", "T")}Z`;
  return Date.parse(normalized);
}

/**
 * True once at least `delaySecs` seconds have passed since `authorizedAtIso`
 * was recorded. If more time has passed than the delay (including across a
 * server restart), this is true immediately -- there is no "missed window"
 * state, only "not yet" or "yes."
 */
export function isSweepDelayElapsed(authorizedAtIso: string, delaySecs: number, nowMs: number = Date.now()): boolean {
  return millisUntilSweepEligible(authorizedAtIso, delaySecs, nowMs) <= 0;
}

/**
 * Milliseconds remaining until this authorization's sweep becomes eligible.
 * Zero or negative means eligible now. Used both for the eligibility gate
 * (via isSweepDelayElapsed) and to give the frontend a real, backend-sourced
 * remaining-time value to render -- never a value the frontend invents or
 * counts down on its own.
 */
export function millisUntilSweepEligible(authorizedAtIso: string, delaySecs: number, nowMs: number = Date.now()): number {
  const authorizedAtMs = parseAsUtcMs(authorizedAtIso);
  const eligibleAtMs = authorizedAtMs + delaySecs * 1000;
  return eligibleAtMs - nowMs;
}

/** The ISO timestamp at which this authorization's sweep becomes eligible — for display/API purposes only, never re-derived by the frontend. */
export function sweepEligibleAtIso(authorizedAtIso: string, delaySecs: number): string {
  const authorizedAtMs = parseAsUtcMs(authorizedAtIso);
  return new Date(authorizedAtMs + delaySecs * 1000).toISOString();
}
