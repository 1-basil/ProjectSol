import { test } from "node:test";
import assert from "node:assert/strict";
import { decimalStringToScaled, normalizeScientificNotation, fetchTokenPriceByMint } from "../src/solana/pricing.ts";

test("converts a whole-number price exactly", () => {
  assert.equal(decimalStringToScaled("105", 8), 10_500_000_000n);
});

test("converts a decimal price exactly", () => {
  assert.equal(decimalStringToScaled("0.999952", 8), 99_995_200n);
});

test("pads a short fractional part", () => {
  assert.equal(decimalStringToScaled("1.5", 8), 150_000_000n);
});

test("truncates (floors) a fractional part longer than the target exponent, rather than rounding", () => {
  // 8-decimal target, price has 10 fractional digits — the extra precision
  // is dropped, never rounded, matching this project's floor-only convention.
  assert.equal(decimalStringToScaled("1.2345678999", 8), 123_456_789n);
});

test("rejects a value that is not a plain non-negative decimal (defends against a malformed or adversarial API response)", () => {
  assert.throws(() => decimalStringToScaled("-1.5", 8));
  assert.throws(() => decimalStringToScaled("1e10", 8));
  assert.throws(() => decimalStringToScaled("NaN", 8));
  assert.throws(() => decimalStringToScaled("", 8));
});

test("a value whose nearest float64 neighbor would differ still converts exactly", () => {
  // 0.1 + 0.2 style precision hazard: 100.11 is not exactly representable
  // in binary floating point. The string-based conversion must still be exact.
  assert.equal(decimalStringToScaled("100.11", 8), 10_011_000_000n);
});

// ---------------------------------------------------------------------------
// Regression coverage for the real Mainnet bug: CoinGecko returns very
// low-priced tokens' "usd" field in scientific notation (verified against
// BONK's real API response: "usd":2.76e-06), which the original
// plain-decimal-only regex/parser silently failed on -- excluding any
// sufficiently low-priced allowlisted asset from every scan, with no error
// ever surfacing to the client (see the per-asset isolation in
// scanWallet.ts, which correctly swallowed the resulting throw).
// ---------------------------------------------------------------------------

test("normalizeScientificNotation: BONK's exact real negative-exponent case", () => {
  assert.equal(normalizeScientificNotation("2.76e-06"), "0.00000276");
});

test("normalizeScientificNotation: negative exponent with no fractional part in the mantissa", () => {
  assert.equal(normalizeScientificNotation("5e-3"), "0.005");
});

test("normalizeScientificNotation: positive exponent", () => {
  assert.equal(normalizeScientificNotation("1.5e+10"), "15000000000");
});

test("normalizeScientificNotation: positive exponent, integer mantissa", () => {
  assert.equal(normalizeScientificNotation("123e5"), "12300000");
});

test("normalizeScientificNotation: no exponent at all passes through unchanged (whole number)", () => {
  assert.equal(normalizeScientificNotation("105"), "105");
});

test("normalizeScientificNotation: no exponent at all passes through unchanged (decimal)", () => {
  assert.equal(normalizeScientificNotation("0.999952"), "0.999952");
});

test("normalizeScientificNotation: exponent exactly consumes the mantissa digits (boundary case)", () => {
  assert.equal(normalizeScientificNotation("5e-1"), "0.5");
  assert.equal(normalizeScientificNotation("5e1"), "50");
});

test("normalizeScientificNotation: rejects malformed input", () => {
  assert.throws(() => normalizeScientificNotation("not-a-number"));
  assert.throws(() => normalizeScientificNotation("-1.5e-6"));
});

test("normalizeScientificNotation output is always accepted by decimalStringToScaled, and round-trips to the exact expected scaled value (BONK's real price, 8-decimal exponent)", () => {
  const normalized = normalizeScientificNotation("2.76e-06");
  assert.equal(decimalStringToScaled(normalized, 8), 276n);
});

test("fetchTokenPriceByMint parses CoinGecko's real scientific-notation response shape end-to-end (BONK's actual mainnet API response, captured verbatim)", async (t) => {
  const realBonkResponseText = '{"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263":{"usd":2.76e-06,"last_updated_at":1789404280}}';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(realBonkResponseText, { status: 200 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const quote = await fetchTokenPriceByMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
  assert.equal(quote.price.priceScaled, 276n);
  assert.equal(quote.price.priceExponentAbs, 8);
});
