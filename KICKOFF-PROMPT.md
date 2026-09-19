# Kickoff prompt — paste this as your first message in Claude Code

> Save `CLAUDE-CODE-SPEC.md` to the repo root first, then paste the text below.

---

Read `SPEC.md` in full before doing anything else. It is the authoritative spec for
this project — where my instructions and SPEC.md conflict, raise the conflict rather
than silently picking one.

We are building a custodial Solana managed trading platform: ~100 clients deposit
funds into platform vaults, authorized experts emit BUY/SELL signals with explicit
position sizing, an autonomous engine executes against pooled capital while clients
are offline, and per-client ownership is tracked in a unitized ledger.

**This is Phase 1 only. Do not write application code yet.**

Phase 1 deliverables, in this order:

1. `docs/architecture.md` — component diagram, data flows, trust boundaries, and
   which process owns which piece of state.
2. `docs/custody-map.md` — every point in the system where custody exists, who or
   what can move funds there, and what constrains them.
3. `docs/on-chain-invariants.md` — the explicit list of what the Anchor program
   enforces vs. what is backend-only. Be honest about the boundary; do not list a
   backend check as an on-chain guarantee.
4. `docs/accounting.md` — the unitized NAV model, worked through the example in
   SPEC.md §5.2, plus fee accrual and the invariants.
5. `docs/db-schema.md` — full Postgres schema with constraints, especially the
   uniqueness constraints that provide idempotency.
6. `docs/threat-model.md` — first draft, per SPEC.md §15.
7. `docs/open-decisions.md` — everything from SPEC.md §19 plus anything else you
   need from me, each with your recommended default and the reasoning.
8. `docs/compliance-questions.md` — the questions counsel must answer before
   production. List them; do not attempt to answer them.

Constraints while you work:

- Ask me about anything in §19 rather than inventing a value.
- Where you disagree with the spec on engineering grounds, say so with reasoning.
  I would rather argue in Phase 1 than refactor in Phase 9.
- Flag anywhere the spec is internally inconsistent or underspecified.
- No code, no scaffolding, no `npm init` yet. Documents first.

When all eight documents are done, stop and summarise: the three riskiest design
decisions, and what you need from me to start Phase 2.
