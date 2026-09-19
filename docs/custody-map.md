# Custody Map

Status: Phase 1 draft. Every place funds, unit-issuance authority, or
rule-changing authority exists, in one place, so that "what can move money" is
never answered by reading five files.

Convention: "custody" here means *any* of (a) can cause tokens to move, (b) can
cause units to be minted/burned, or (c) can change the rules that govern (a) and
(b). (c) is included deliberately — control over the rules is a superset of
control over the funds, and treating it as out-of-scope is how upgrade keys
become the real attack surface.

## 1. Custody inventory

| # | Custody point | Asset form | Who/what can move it | Constraint | If compromised |
|---|---|---|---|---|---|
| C1 | Client's own wallet, pre-deposit | SPL tokens / SOL | Client only | Not platform custody at all — included only to mark the boundary | Not the platform's problem by construction (hard prohibition, spec §1.2) |
| C2 | Per-client deposit PDA (secondary deposit path) | SPL tokens in transit | Nobody can *spend* from it except the program's sweep instruction into the vault; it is one-directional | Program-derived, no private key exists for it | An attacker cannot extract funds from it directly; worst case is a mis-sweep, mitigated by the unattributed-bucket fallback |
| C3 | Vault token accounts (main custody) | Pooled SPL tokens | Only the program, via PDA signing, and only through instructions whose account constraints name this vault | `execute_trade` may only move value into an allowlisted DEX program and must receive value back into a vault-owned account (spec §4.4 step 7); withdrawal-shaped instructions require Treasury + registered address | This is the crown jewel. See on-chain-invariants.md — this is why the post-balance assertion in `execute_trade` exists |
| C4 | Trader hot key (Signer service / KMS) | Signing authority, not funds directly | Whoever controls the Signer service and its KMS policy | Program-side: can only sign transactions the program will accept as `execute_trade`, which cannot withdraw. Backend-side: independent policy re-check per architecture.md §5.3 | **Cannot** remove value from the vault per the program's design. **Can** destroy value by repeatedly trading into an allowlisted-but-illiquid mint at max slippage (spec §3.1's honestly-stated residual risk). Mitigations: per-trade/per-day notional caps, tight allowlist, slippage-realized anomaly alerting, guardian auto-pause |
| C5 | Treasury multisig (m-of-n, e.g. Squads) | Approval authority: redemption settlement, config/allowlist edits, program upgrade (via timelock), unpause | The m-of-n holder set | Cold, geographically separated holders per spec §3.1; program-enforced quorum | Can approve fraudulent redemptions to non-client addresses **only if it also controls or coerces enough holders to alter the registered withdrawal address first** (see C7) — a single compromised Treasury signer alone cannot act; blast radius scales with how many signers are actually compromised, which is the point of m-of-n |
| C6 | Guardian key | Pause authority only | A single low-ceremony key holder | Can pause; cannot unpause, trade, or move funds (deliberate asymmetry, spec §3.1) | Worst case is a nuisance halt — explicitly designed to be the *safe* failure mode |
| C7 | Registered withdrawal address (per `ClientAccount`) | Not an asset itself — it's the destination allowlist entry that gates C3's only legitimate exit for that client | Client-initiated change request, but only takes effect after `withdrawal_addr_effective_at` timelock (24-48h min, spec §4.3) and client notification | The timelock window is the control — it exists specifically so a client can catch and reverse a socially-engineered change before it becomes exploitable | If an attacker both phishes a client's request-signing path *and* the client fails to notice the notification within the timelock, the attacker can redirect that client's future redemptions. Blast radius is bounded to one client's balance, not the pool, because the change is per-`ClientAccount` |
| C8 | `RedemptionRequest` PDA between STRUCK and CLAIMABLE | Struck unit price + pending payout | Treasury (`settle_redemption`), then the client (`claim_redemption`) | Payout still resolves only to the registered address (C7), even post-settlement | Compromise here can delay or block a specific client's redemption but cannot redirect it without also compromising C7 |
| C9 | `UNMANAGED_EXCESS` bucket (deposits above the $1M cap) | SPL tokens held, not traded | Program/vault holds it; presumably returnable to the client or later creditable if cap policy changes | Never silently managed (spec §6.2) | Same blast radius as C3 in the worst case (it sits in a vault-controlled account) but is explicitly excluded from trading exposure, so a trading-side compromise (C4) cannot touch it through `execute_trade`'s mint allowlist unless the excess happens to be in an allowlisted mint — **note:** this means C9 needs its own segregation (a separate token account or explicit flag) from tradable vault balance, not just a ledger-level label, or a compromised Trader key *could* trade it. Flagged as a design requirement for Phase 2, not just a bookkeeping distinction |
| C10 | `UNATTRIBUTED` ledger bucket (unmatched inbound transfers) | SPL tokens / SOL received but not attributed to any client | Nobody has a credit path from here except a manual, reviewed operator action | Never auto-credited, never traded (spec §6.1) | Compromise of the reviewing operator's account could misattribute funds, but this requires a human-in-the-loop action, not a code path — treat operator review tooling as part of C11 |
| C11 | Admin/operator accounts (dashboards, ops tooling) | No direct asset custody, but can trigger dual-authorized ledger adjustments, review unattributed deposits, view PII | Whoever holds valid admin credentials | Dual control + reason-coded, immutable audit log on any balance-adjacent action (spec §7.2) | Cannot unilaterally move funds (no single admin action reaches C3-C8 without a second authorizer), but can cause reputational/compliance damage via data access. This is the component most likely to be the actual initial compromise vector in practice — treat it accordingly in threat-model.md |
| C12 | Program upgrade authority | Not funds — the rules themselves | Treasury multisig + timelock (spec §3.2) | Timelock publication is what gives clients advance warning of a rule change | The single highest-blast-radius item on this list: a malicious upgrade can rewrite every other row in this table. This is why it sits behind the same multisig as Treasury *plus* a timelock, and why a published path to eventually freezing the program (spec §3.2) matters — see open-decisions.md OD-11 |
| C13 | Oracle price feed (Pyth or equivalent) | Not funds — the input that determines NAV and trade sizing | Whoever operates the oracle (external to the platform) | Staleness + confidence-interval checks on-chain and off-chain (spec §11); NAV sanity band (spec §4.5) bounds how much a bad price can move unit price in one publish | A manipulated or stale oracle read inside `execute_trade` could mis-size a trade or approve a bad cap check; inside `publish_nav` it could mis-price every client's units simultaneously — highest-leverage *external* dependency in the system. See threat-model.md "oracle manipulation" |
| C14 | Signal/expert account | No custody, but expert-originated data drives what C4 signs | Whoever holds valid expert credentials | Signals are size-relative and mint-address-only (spec §8.1); validated before queueing | A compromised expert account can direct real capital into an allowlisted-but-bad mint (same blast radius ceiling as C4's residual risk) — cannot exceed allowlist/cap bounds, cannot withdraw |

## 2. Reading this table

Rows C3, C5, and C12 are the only points whose compromise has pool-wide (not
single-client) blast radius. Everything else is bounded to a single client, a
single trade's notional cap, or a nuisance-level halt. That asymmetry — most
compromises are small and recoverable, a few are catastrophic — is exactly what
should drive where engineering and operational effort goes disproportionately:
multisig ceremony and upgrade-timelock discipline for C5/C12, and the layered
on-chain checks in `execute_trade` for C3.

## 3. Open gap surfaced while building this map

C9 (`UNMANAGED_EXCESS`) needs a custody mechanism, not just a database flag,
or a compromised Trader key could trade funds that were supposed to be
quarantined above the cap. This should be resolved in Phase 2's account design
(e.g., a separate token account per client for excess, not commingled with the
tradable vault balance) — noted here and in open-decisions.md.
