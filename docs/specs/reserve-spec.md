# SOL Reserve Specification (Normative)

Status: **Normative implementation spec.** Phase 2 input. Pins down EXACTLY
HOW the client-wallet SOL reserve and the vault's own operational SOL reserve
are computed. The WHY (client must always be able to afford their own future
transactions) is summarized in `accounting.md` §5; this document is the exact
formula, worked cases, and derivation.

This is a client-wallet-usability control computed fresh at every quote —
**never cached** — and it is a **ceiling** on what can be offered for
deposit, never a target the suggested allocation aims for.

## 1. Client-wallet SOL reserve formula

```
pct_reserve      = 0.10 * eligible_sol
absolute_reserve = min_sol_reserve                       -- config, §3 below
reserve_applied  = max(pct_reserve, absolute_reserve)    -- the MORE conservative of the two always wins
offered_sol      = max(eligible_sol - reserve_applied, 0)
```

Neither rule is sufficient alone: the 10% rule under-reserves small balances
(10% of 0.2 SOL is 0.02 SOL — nowhere near enough for a future transaction),
and the absolute floor under-reserves large balances (a fixed 0.05 SOL floor
does nothing to size a reserve proportionally as a wallet's activity level
scales up). Both are evaluated every time; the larger one governs.

**Worked cases** (using the illustrative `min_sol_reserve` = 0.05 SOL derived
in §3):

| Case | `eligible_sol` | `pct_reserve` (10%) | `absolute_reserve` | Governs | `offered_sol` |
|---|---|---|---|---|---|
| Small balance | 0.20 SOL | 0.020 | 0.050 | absolute floor | 0.15 SOL |
| Large balance | 500.00 SOL | 50.000 | 0.050 | 10% rule | 450.00 SOL |
| Below reserve | 0.03 SOL | 0.003 | 0.050 | absolute floor | 0 → **SOL excluded entirely**, not shown as a zero-quantity row |

## 2. What the reserve is and isn't

The reserved amount is never transferred, never enters the vault, never
appears in NAV, never issues units, and is never counted toward the
$1,000,000 headroom computation — it simply never becomes part of the
deposit's `total_deposit_usd_scaled` (`accounting.md` §5), because it was
never part of the offered/selectable amount in the first place.

**If a client's post-deposit wallet SOL balance ever falls below
`min_sol_reserve`, that is a system failure, not a client outcome to
accept** — it means the reserve calculation was wrong (a stale
eligible-SOL snapshot, config drift, or a fee spike the estimate didn't
account for) and should page, not just log. The whole point of the reserve
is that a client can always afford to act on their own funds, including
signing a withdrawal.

`docs/specs/deposit-spec.md` §5 covers the corresponding backend requirement:
reject, don't clamp, any client-selected SOL quantity above `offered_sol`,
including a request crafted outside the normal UI.

## 3. Illustrative derivation of `min_sol_reserve` (default 0.05 SOL — not final)

Shown here, rather than left as a magic constant, specifically so it can be
re-derived when network fee/rent conditions change. See `open-decisions.md`
OD-25 — this default is explicitly not final.

```
rent-exempt minimum, existing accounts to preserve (assume up to 2)  0.00203928 × 2  = 0.00407856 SOL
ATA creation for one future full-redemption payout                   0.00203928 × 1  = 0.00203928 SOL
N=5 future transactions at a p95 priority-fee assumption
  (~0.000005 base + ~0.0005 priority per tx, illustrative)            0.000505 × 5   = 0.002525   SOL
                                                                                        ────────────
subtotal                                                                               ≈ 0.00864   SOL
safety multiple (×5, for fee-market/rent-parameter drift)                              ≈ 0.0432    SOL
rounded                                                                                → 0.05       SOL
```

The rent-exempt figure and the priority-fee assumption are both network
conditions that drift; this arithmetic — not the resulting constant — is what
should be re-run periodically (and certainly before mainnet) rather than
carrying `0.05` forward as received wisdom.

## 4. Vault operational SOL reserve (separate control)

The vault itself needs its own native-SOL operational reserve, independent of
any client-wallet reserve above, so that the platform's own signers can
always pay for trade execution, redemption settlement, and ATA creation
performed on a client's behalf. This is an operator-funded balance
(`vault_state_mirror.sol_reserve_lamports`, `db-schema.md`), monitored
against a configured target and minimum
(`platform_config['vault_sol_reserve_target_lamports']` /
`['vault_sol_reserve_min_lamports']`), with an alert — not an auto-pause of
client-facing functions — when it drops toward the minimum, since running out
mid-operation would strand in-flight trades or redemptions rather than merely
degrade UX. Replenishment cadence and funding source are operational
decisions, not specified further here (see `open-decisions.md` OD-28 for the
target/minimum threshold values, which are not decidable yet).
