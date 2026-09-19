# Excess Handling and Return Specification (Normative)

Status: **Normative implementation spec.** Phase 2 input. Pins down EXACTLY
WHAT counts as deposit "excess," which assets absorb it, how it's segregated,
and how a client gets it back. The WHY (the $1,000,000 managed-capital cap
exists, and deposits above it are held, not silently managed) is in spec §6.2
and `accounting.md` §1; this document is the implementation-level detail.

## 1. What "excess" is

Three distinct situations all produce the same on-ledger outcome (zero units
issued, excluded from NAV), and this document treats them uniformly rather
than as separate mechanisms:

```
total_deposit_usd_scaled = Σ_i (quantity_i × oracle_price_i)    -- single timestamp for all i
creditable_usd_scaled    = min(total_deposit_usd_scaled, headroom_usd_scaled)
units_issued             = floor(creditable_usd_scaled / unit_price_scaled)
excess_usd_scaled        = total_deposit_usd_scaled − creditable_usd_scaled
```

1. **Cap excess** — the client's total selection genuinely exceeds their
   remaining $1,000,000 headroom (the normal, expected case when a client's
   wallet is worth more than their remaining capacity).
2. **Headroom-race shortfall** — on-chain headroom shrank between quote and
   execution (a concurrent deposit, or NAV movement) — see
   `docs/specs/deposit-spec.md` §6 on why execution-time on-chain state, not
   the quote, is authoritative for `headroom_usd_scaled` in the formula above.
3. **Boundary-rounding remainder** — the sub-unit remainder from rounding a
   boundary asset's native quantity down to its mint's decimals
   (`docs/specs/allocation-spec.md` §3).

All three land in the same place: zero units, excluded from NAV, held as
`UNMANAGED_EXCESS`.

## 2. Which specific assets end up in excess

Determined entirely by `docs/specs/allocation-spec.md`'s ranking: excess is
whatever doesn't fit under headroom after allocating down the ranked list,
starting from the lowest-ranked (lowest-`usd_value`) asset. There is no
separate "excess allocation" policy — it is the direct, deterministic tail of
the same ranking used to build the suggestion, which is what makes it
disclosable and auditable rather than an artifact of instruction-account
ordering.

## 3. Custody segregation requirement

`UNMANAGED_EXCESS` **has** been transferred into the vault (unlike a filtered
asset, which never leaves the client's wallet — see
`docs/specs/deposit-spec.md` §4) and must be held in a way a compromised
Trader key cannot reach through `execute_trade`'s mint-allowlist path — a
separate token account per client, not a commingled balance distinguished
only by a database label. This was flagged in `custody-map.md` §3 (item C9)
as a gap in the spec's original account sketch (§4.2), and it is a Phase 2
account-design requirement, not an open decision — see `open-decisions.md`
OD-14.

## 4. Return / reclaim mechanism

Filtered assets (per `docs/specs/deposit-spec.md` §4) never need a return
path — they were never offered, so nothing needs reclaiming. `UNMANAGED_EXCESS`
does need one, since real value sits in the vault.

**Recommended default:** a self-service on-chain withdrawal path for
`UNMANAGED_EXCESS` specifically, distinct from the standard redemption cycle
(this capital was never unitized or invested, so it shouldn't be subject to
strike/settlement timing), resolving to the client's registered withdrawal
address like every other outbound path (per the hard prohibition in spec
§1.2 — no destination other than the registered address).

**Not yet decided:** whether self-service is acceptable or whether excess
return should route through support/manual review instead. See
`open-decisions.md` OD-24.
