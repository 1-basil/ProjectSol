import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAllowlist, findAllowlistEntryByMint } from "../src/allowlist/loadAllowlist.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORIGINAL_160_PATH = join(__dirname, "..", "data", "allowlist", "v1-2026-09-06.json");

test("the active allowlist has exactly 395 entries", () => {
  assert.equal(loadAllowlist().length, 395);
});

test("every entry has a unique mint address", () => {
  const mints = loadAllowlist().map((e) => e.mint);
  assert.equal(new Set(mints).size, mints.length);
});

test("every entry carries a recognized verification_status and non-empty evidence", () => {
  for (const entry of loadAllowlist()) {
    assert.ok(
      entry.verification_status === "VERIFIED_NATIVE" || entry.verification_status === "VERIFIED_NATIVE_HEURISTIC",
      `${entry.symbol} has unrecognized verification_status ${entry.verification_status}`,
    );
    assert.ok(entry.evidence.length > 0, `${entry.symbol} has no recorded evidence`);
  }
});

test("the original 160 hand-researched entries remain included, unmodified, and still individually VERIFIED_NATIVE", () => {
  const original160 = JSON.parse(readFileSync(ORIGINAL_160_PATH, "utf8")) as { mint: string; symbol: string; evidence: string }[];
  assert.equal(original160.length, 160);

  const current = loadAllowlist();
  const currentByMint = new Map(current.map((e) => [e.mint, e]));

  for (const original of original160) {
    const now = currentByMint.get(original.mint);
    assert.ok(now, `original entry ${original.symbol} (${original.mint}) is missing from the current allowlist`);
    assert.equal(now!.verification_status, "VERIFIED_NATIVE", `${original.symbol} must remain VERIFIED_NATIVE, never weakened`);
    assert.equal(now!.evidence, original.evidence, `${original.symbol}'s hand-researched evidence must be unchanged`);
  }

  const strictCount = current.filter((e) => e.verification_status === "VERIFIED_NATIVE").length;
  assert.equal(strictCount, 160, "exactly the original 160 entries carry the hand-researched VERIFIED_NATIVE tier — none added, none removed");
});

test("ranks 162-396 are the disclosed lower-assurance VERIFIED_NATIVE_HEURISTIC tier, filling the allowlist out to 395 total", () => {
  const current = loadAllowlist();
  const heuristic = current.filter((e) => e.verification_status === "VERIFIED_NATIVE_HEURISTIC");
  assert.equal(heuristic.length, 235);
  for (const entry of heuristic) {
    assert.ok(entry.rank >= 162 && entry.rank <= 396, `${entry.symbol} has rank ${entry.rank} outside the expected 162-396 range`);
  }
});

test("every entry's token_program is a real, recognized program", () => {
  for (const entry of loadAllowlist()) {
    assert.ok(["SPL_TOKEN", "TOKEN_2022"].includes(entry.token_program));
  }
});

test("a mint can be looked up, and an unknown mint returns undefined rather than throwing", () => {
  const [first] = loadAllowlist();
  assert.equal(findAllowlistEntryByMint(first.mint)?.symbol, first.symbol);
  assert.equal(findAllowlistEntryByMint("not-a-real-mint-address"), undefined);
});

test("ticker/symbol alone cannot be used to find an entry — mint address is the only identity", () => {
  // findAllowlistEntryByMint takes a mint; passing a symbol string must not
  // accidentally match anything, proving symbol is never treated as identity.
  const bySymbolLookingString = findAllowlistEntryByMint("USDC");
  assert.equal(bySymbolLookingString, undefined);
});
