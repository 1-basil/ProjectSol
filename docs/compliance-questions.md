# Compliance Questions for Counsel

Status: Phase 1 draft, per spec §1.3/§16. This document lists the questions
counsel must answer before Phase 16 (production) with real client money. It
does **not** attempt to answer them — doing so is legal advice this document is
not qualified to give, and the spec is explicit that building the software is
fine while operating it without these answers is where the exposure lives.

## 1. Regulatory classification

- Does pooling client capital under third-party discretionary management,
  combined with profit sharing, constitute a collective investment scheme,
  fund, or similar regulated vehicle under the law of each relevant
  jurisdiction (see §5 below)?
- Does the platform's activity (accepting deposits, executing discretionary
  trades on clients' behalf, charging management/performance fees) constitute
  investment-adviser or portfolio-management activity requiring licensing?
- Does custody of client assets (even without commingling client funds with
  operator funds) trigger money-transmission, custodian, or virtual-asset-
  service-provider (VASP) licensing requirements?
- Does the $1,000,000 per-client cap, or the ~100-client scale, change the
  applicable regulatory threshold or exemption availability in any relevant
  jurisdiction (e.g., accredited/sophisticated-investor exemptions, small-
  offering exemptions)?
- Are "experts" who emit trading signals themselves engaging in regulated
  investment-advice activity, separate from the platform's own licensing
  question?
- **What obligation is the $1,000,000 per-client managed-capital cap actually
  satisfying, and does it attach to the natural person or to the
  account/client record?** This is the same classification conversation as
  the vault-structure question above, not a separate inquiry, and it
  determines two concrete engineering questions currently blocked on it
  (`open-decisions.md` OD-31/OD-32): whether one person can lawfully be
  permitted to register more than one client record (i.e., whether
  cross-account identity deduplication is a compliance requirement, not just
  a good idea), and whether a client's managed value growing past
  $1,000,000 through trading performance (as opposed to a new deposit) needs
  any action, or whether the cap is understood to govern contributed capital
  only.

## 2. Client jurisdiction and eligibility

- In which jurisdictions is the platform permitted to onboard clients at all,
  given current and planned regulatory posture?
- Are there jurisdictions that must be explicitly excluded (geofenced) at
  onboarding, and what is the compliant mechanism for doing so (self-
  attestation, IP-based screening, documentary proof)?
- Does client eligibility need to be restricted to accredited/qualified/
  professional investors in any jurisdiction, and if so, what verification
  standard applies?
- What is the compliant treatment of a client who relocates to a
  restricted jurisdiction after onboarding?

## 3. KYC / AML / sanctions

- What KYC tier (identity verification depth) is required at what deposit/
  balance threshold, given the $1,000,000 cap?
- What ongoing (not just onboarding) AML monitoring obligations apply, and at
  what transaction/behavior thresholds must a suspicious-activity report be
  considered?
- What sanctions-screening obligations apply (OFAC, EU, UN, or others), and how
  frequently must the client base be re-screened against updated lists?
- What is the required KYC/AML posture for the "experts" who receive signal-
  based compensation, if any, separate from client-side KYC?
- What are the record-retention requirements for KYC/AML records, and for how
  long?

## 4. Custody, licensing, and asset segregation

- Does holding client assets in platform-controlled on-chain vaults, even
  under the non-negotiable technical constraints in spec §1.2 (no seed phrases,
  no wallet-level authority over external client wallets), qualify as
  regulated custody requiring a specific license or registration?
- What legal segregation (as opposed to technical/on-chain segregation) is
  required between client assets and any operator-owned assets, and does the
  `UNMANAGED_EXCESS` bucket (deposits above the $1,000,000 cap, held but not
  traded) have distinct legal treatment from managed capital?
- Is a qualified custodian arrangement required in any relevant jurisdiction,
  and if so, is a self-custodied on-chain vault (even with the multisig/
  timelock/pause structure described in the architecture) sufficient, or is a
  third-party qualified custodian mandatory?
- What insurance or bonding, if any, is required or advisable against custody
  loss, operational failure, or key compromise?

## 5. Fund structure and offering

- Is a formal fund vehicle (e.g., an LP, LLC, or offshore fund structure)
  required to lawfully pool client capital, rather than operating the pool
  directly as described in the technical architecture?
- What offering documents (subscription agreement, private placement
  memorandum, risk disclosures) are legally required before a client can
  deposit, and do they need to be jurisdiction-specific?
- Does the platform's marketing (including any expert track record,
  performance figures, or dashboard-displayed P&L) trigger securities-
  marketing or advertising restrictions in any relevant jurisdiction?
- What disclosures are legally required regarding the redemption-cycle
  liquidity model (spec §7.1's honest "instantaneous full withdrawal is
  impossible" framing) and the pro-rata gating policy, and must they appear in
  a specific legal document before first use, not just the client-facing UI?

## 6. Fees and compensation

- Are there legal constraints on the structure or disclosure of management and
  performance fees (e.g., high-water-mark requirements, fulcrum-fee rules,
  performance-fee eligibility restrictions by investor sophistication) in
  relevant jurisdictions?
- What compensation structure for "experts" is compliant, given that they
  direct trades but never hold funds or signing authority — does their
  compensation model itself require registration or disclosure?
- Are there restrictions on charging performance fees to retail/non-qualified
  clients specifically?

## 7. Tax

- What tax reporting obligations does the platform have toward clients (e.g.,
  realized-gain statements, cost-basis tracking) and toward tax authorities in
  relevant jurisdictions?
- Does the unitized/NAV structure have a specific tax characterization (fund
  interest vs. direct asset ownership) that affects client tax treatment, and
  does that characterization vary meaningfully by jurisdiction?
- What withholding obligations, if any, apply to distributions or redemptions
  paid to clients in different jurisdictions?

## 8. Data protection and privacy

- What data-protection regime(s) apply to client PII collected during KYC
  (e.g., GDPR, CCPA, or others depending on client jurisdiction), and what
  does that require of data storage, retention, and cross-border transfer
  (relevant given cloud KMS/infrastructure provider selection)?
- What is the legally required data-retention and data-deletion policy,
  and does it conflict with the audit/record-retention requirements in §3 and
  §9?

## 9. Conflicts of interest and governance

- Is there a legally required framework for disclosing or managing conflicts
  of interest — e.g., an expert trading a mint they hold personally, or an
  operator/Treasury holder with a financial interest adverse to clients?
- What governance/disclosure obligations apply to changes in the mint/program
  allowlist, risk limits, or fee structure after clients have already
  deposited — is client consent or notice legally required, and with what
  notice period?
- What legal liability, if any, attaches to the "dead-man's switch" scenario
  (spec §4.6) where the operator becomes unresponsive and clients self-
  withdraw pro-rata via `emergency_in_kind_redeem` — does this need to be
  addressed explicitly in the client agreement as a defined event?

## 10. Liability and dispute resolution

- What liability does the platform bear for losses arising from: an expert's
  trading decisions within their granted parameters; a smart-contract bug; an
  oracle failure; a third-party DEX/router failure; and how should each be
  allocated in the client agreement?
- What dispute-resolution mechanism (arbitration, jurisdictional courts,
  on-chain-evidence admissibility) should govern client disputes, and is it
  enforceable in each relevant client jurisdiction?
- What is the legally appropriate treatment of the withdrawal-address timelock
  window (spec §4.3) if a client disputes a change they claim they didn't
  authorize after it has already taken effect?

## 11. Program upgrade and operational continuity

- What legal disclosure obligations, if any, attach to the program-upgrade
  authority structure (Treasury multisig + timelock, spec §3.2) and to any
  eventual decision to freeze the program permanently?
- What legal process is required (if any) to wind down the platform, return
  remaining client capital, and terminate the client agreement in an orderly
  fashion, distinct from the dead-man's-switch emergency path?

---

**This list is not exhaustive as a matter of law** — it is the set of questions
this Phase 1 engineering pass could identify from the technical design.
Counsel may identify additional jurisdiction- or structure-specific questions
once client jurisdictions (open-decisions.md OD-11) are known.
