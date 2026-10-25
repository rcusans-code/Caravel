// Collateral cover vs the asset's margin trigger (DECISIONS.md #26), the
// figure on the position card and the landing hero. Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collateralValue, coverPct } from "../src/format.ts";

// Max-LTV take at a 3% haircut: debt 970.9301370 USDC, 1000.9589042 tBENJI.
const DEBT = 9_709_301_370n;
const COLL = 10_009_589_042n;
const NAV_DEC = 14; // mock feed decimals; tBENJI has 7, like USDC
const nav = (x: number) => BigInt(Math.round(x * 1e8)) * 1_000_000n;
const cover = (x: number, trigger: bigint) => coverPct(collateralValue(COLL, nav(x), NAV_DEC), DEBT, trigger)!;

test("trigger 250: cover crosses 100% at NAV 0.994872, as check_margin does", () => {
  assert.ok(cover(1.0, 250n) > 100);
  assert.ok(cover(0.994872, 250n) >= 100);
  assert.ok(cover(0.994871, 250n) < 100);
});

test("trigger on the discount line (pre-#26) crosses at NAV 0.989796", () => {
  assert.ok(cover(0.994871, 200n) >= 100);
  assert.ok(cover(0.989795, 200n) < 100);
});

test("no debt: no cover figure", () => {
  assert.equal(coverPct(1n, 0n, 250n), null);
});
