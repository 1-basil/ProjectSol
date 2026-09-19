# Pyth Oracle Adapter — Design

Written from the actual `pyth-solana-receiver-sdk` v2.0.0 source (downloaded
and read at `~/.cargo/registry/src/.../pyth-solana-receiver-sdk-2.0.0/`,
alongside `pythnet-sdk` v3.0.0 for the wire-format message type), not from
memory. Confirmed compiling alongside this program's existing
`anchor-lang`/`anchor-spl` 1.2.0 dependencies (`cargo check`, clean).

## 1. Pyth account type being consumed

`pyth_solana_receiver_sdk::price_update::PriceUpdateV2` — an Anchor
`#[account]` struct:

```rust
pub struct PriceUpdateV2 {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel, // Partial { num_signatures: u8 } | Full
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}
```

Typing the account as `Account<'info, PriceUpdateV2>` (rather than
`UncheckedAccount`) means Anchor's own deserialization enforces, before this
program's code runs at all:

- the account is owned by `pyth_solana_receiver_sdk::ID`
  (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`, read from that crate's
  `declare_id!` — not guessed), and
- the account's discriminator matches `PriceUpdateV2`'s.

This is the "fail closed on malformed/unrecognized accounts" requirement,
satisfied structurally rather than by a runtime check this program writes:
an account that isn't a genuine, Receiver-program-owned `PriceUpdateV2`
cannot be deserialized into this type, full stop.

**Scope limitation, stated rather than papered over.** Pyth publishes two
kinds of on-chain price accounts with this same data shape: one-off
accounts created by calling the Receiver program's `post_update`/
`post_update_atomic` (owner = `pyth_solana_receiver_sdk::ID`, verified
above), and a separate hosted, continuously-updated "push oracle" account
per feed at a deterministic address owned by a *different* program
(`PYTH_PUSH_ORACLE_ID` = `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`, also
present in the SDK's `lib.rs`). This adapter accepts **only** the first
kind. I did not find that second program's PDA-seed derivation in any
source available in this environment (`pyth-solana-receiver-sdk` exposes
PDA helpers only for its own `config`/`treasury` accounts, and no
`pyth-push-oracle` crate exists on crates.io to check against) — implementing
support for it would mean guessing a seed formula I cannot verify, which is
exactly what this task ruled out. A deposit's client must therefore include
a `post_update`/`post_update_atomic` call (permissionless) in or before
their transaction. This is not a lesser option forced by the gap: requiring
the price to come from the same transaction is arguably the more
conservative of the two patterns anyway, since it cannot be stale relative
to a hosted account nobody in this transaction refreshed.

## 2. Price representation and exponent

`price_message: PriceFeedMessage` (from `pythnet_sdk::messages`, field
order and types read from source):

```rust
pub struct PriceFeedMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
}
```

Per the SDK's own doc comment on its `Price` type: **actual price =
`(price ± conf) * 10^exponent`**. For real USD-denominated feeds `exponent`
is negative (typically -5 to -9) — e.g. `price = 6_000_000_000_000,
exponent = -8` means $60,000.00000000.

This program's existing valuation formula
(`allocation::valuation::OraclePrice`) was written against the convention
`actual_price = price_scaled / 10^price_exponent_abs`, i.e. it assumes a
**non-negative** exponent magnitude and always divides. That convention is
only correct when Pyth's `exponent` is `<= 0`. **A positive `exponent` is
rejected outright** (`VaultError::OracleExponentUnsupported`) rather than
silently handled by the wrong branch — real USD feeds never have one, so
this costs nothing in practice and removes a real mishandling risk.

`feed_id` is Pyth's per-trading-pair identifier (e.g. SOL/USD), not tied to
a specific account address. Since one mint must always be priced against
the same feed, `pyth_feed_id: [u8; 32]` is added to `AllowlistedMint`
(Treasury-attested at `add_allowlisted_mint`, alongside the existing
Token-2022 extension flags — same trust model, same instruction). The
adapter asserts `price_message.feed_id == allowlisted_mint.pyth_feed_id`;
a mismatch is `VaultError::OraclePriceFeedMismatch`. Without this, a client
could pass a genuine, fresh, fully-verified Pyth price for the *wrong*
asset.

## 3. Conversion into the existing monetary representation

Widening only, never narrowing, and every widening is exact:

| Pyth field | Type | Converts to |
|---|---|---|
| `price` | `i64`, must be `> 0` | `u128` (`price as u128`, safe once positive is checked) |
| `conf` | `u64` | `u128` (`conf as u128`, always safe) |
| `exponent` | `i32`, must be `<= 0` | `price_exponent_abs: u32` (`(-exponent) as u32`) |
| `publish_time` | `i64` | passed through unchanged to the existing `PriceSnapshot.published_at` |

The result is exactly `deposit_engine::oracle::PriceSnapshot`, the same
struct the existing pure `validate_price_snapshot` already takes — **no
change to that function or its tests.** The new code is only the
conversion *into* a `PriceSnapshot`, kept as its own pure function
(`convert_price_message`) operating on plain field values, not on an
`Account`, so it is unit-testable exactly like everything else in this
program's decision layer.

`VerificationLevel::Full` is required, not configurable. The SDK's own doc
comment: "Using partially verified price updates is dangerous, as it lowers
the threshold of guardians that need to collude." There is no legitimate
reason for this program to accept less than full Wormhole guardian
verification for a number that sizes unit issuance.

## 4. Freshness / confidence rules

Unchanged from the existing pure layer: staleness is
`now - published_at <= max_staleness_secs`, confidence is
`conf * 10_000 <= price * max_confidence_bps`. **What changes in this pass**
is where the two thresholds come from. The previous commit took them as
direct `deposit` instruction arguments — caller-supplied. That is a real
gap being fixed here, not carried forward: a compromised or buggy backend
could otherwise pass an arbitrarily loose band on any single call and force
acceptance of a stale or uncertain price. `max_price_staleness_secs` and
`max_price_confidence_bps` move to `Config`, set at `initialize_config`
with no built-in default, changeable only through the existing Treasury
timelock — the same pattern already used for `cap_basis`.

## 5. On-chain vs. off-chain

**Enforced trustlessly on-chain**, in addition to everything the previous
`deposit` design already listed:

- The price update is genuinely Pyth's: owner-and-discriminator checked by
  Anchor's account typing.
- Full Wormhole guardian verification, not partial.
- The feed matches the mint being deposited.
- Staleness and confidence, against a threshold only Treasury can change.
- Exponent sign (rejects a representation this program doesn't support).
- Price positivity.

**Necessarily off-chain / not attempted:**

- The price's correctness — the chain can check Pyth said X and X passed
  the freshness/confidence/verification bar; it cannot know the true price.
- Which Pyth feed corresponds to which mint — Treasury-attested at
  allowlist time, same as the extension flags.
- Getting a fresh Receiver-posted update onto the chain at all — that's the
  permissionless `post_update`/`post_update_atomic` call itself, which this
  program does not invoke (the client's transaction includes it, or a
  preceding one did).
- Support for the hosted push-oracle accounts — not implemented, per §1.

Nothing here touches OD-1, OD-31, or OD-32.
