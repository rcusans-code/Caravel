// npm test: liquidator funding floor (funding.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MARGIN_BPS, liquidatorFloor, marginFromEnv, proceedsCap, topUpWhole } from "./funding.js";

const USDC = 10_000_000n; // 7 decimals
const DISCOUNT = 200n; // demo liquidation discount, 2%

test("tBENJI (haircut 3%): floor = 0.98 / 0.97 = 1.0103 × debt", () => {
  // 100 USDC × 0.98 / 0.97 = 101.0309278…, rounded up to the stroop
  assert.equal(proceedsCap(100n * USDC, 300n, DISCOUNT, 0n), 1_010_309_279n);
});

test("tSAFO (haircut 30%): floor = 0.98 / 0.70 = 1.40 × debt, not 1.02", () => {
  assert.equal(proceedsCap(100n * USDC, 3000n, DISCOUNT, 0n), 1_400_000_000n);
  // live repo 8 (QA): ~100.12 USDC debt needed 140.17 USDC of proceeds
  assert.ok(proceedsCap(1_001_200_000n, 3000n, DISCOUNT, 0n) >= 1_401_680_000n);
});

test("margin applies on top: 10% default", () => {
  assert.equal(DEFAULT_MARGIN_BPS, 1000n);
  assert.equal(proceedsCap(100n * USDC, 3000n, DISCOUNT, 1000n), 1_540_000_000n);
});

test("floor sums per asset over every live repo", () => {
  const f = liquidatorFloor(
    [
      { asset: "TBENJI", debt: 100n * USDC, haircutBps: 300 },
      { asset: "TSAFO", debt: 100n * USDC, haircutBps: 3000 },
      { asset: "TSAFO", debt: 100n * USDC, haircutBps: 3000 },
    ],
    DISCOUNT,
    0n,
  );
  assert.deepEqual(f.perAsset.get("TBENJI"), { debt: 100n * USDC, floor: 1_010_309_279n });
  assert.deepEqual(f.perAsset.get("TSAFO"), { debt: 200n * USDC, floor: 2_800_000_000n });
  assert.equal(f.total, 3_810_309_279n);
  // The live state the critique found: 207.29 USDC vs two tSAFO defaults (~280 USDC) is short.
  assert.ok(2_072_945_190n < f.perAsset.get("TSAFO")!.floor);
});

test("no live repos: floor 0", () => {
  assert.equal(liquidatorFloor([], DISCOUNT).total, 0n);
});

test("top-up in whole USDC, 0 when funded", () => {
  assert.equal(topUpWhole(1_540_000_000n, 1_540_000_000n), 0);
  assert.equal(topUpWhole(2_072_945_190n, 3_810_309_279n), 175); // 173.7 short → ceil + 1
});

test("haircut ≥ 100% is rejected", () => {
  assert.throws(() => proceedsCap(USDC, 10_000n, DISCOUNT, 0n));
});

test("LIQ_FLOOR_MARGIN_BPS override", () => {
  assert.equal(marginFromEnv(undefined), 1000n);
  assert.equal(marginFromEnv(""), 1000n);
  assert.equal(marginFromEnv("250"), 250n);
});
