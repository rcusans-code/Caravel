// NAV outage fallback window (DECISIONS.md #38), mirroring inkind.rs `nav_outage`:
// claim_in_kind fails with NoNavOutage while now <= ts + max_nav_age_secs + 7 × day_secs.
// Run: npm test (plain node --test, no bundler).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAV_OUTAGE_DAYS, inKindWindow } from "../src/gates.ts";

const nav = (timestamp: number, price = 100_000_000_000_000n) => ({ price, decimals: 14, timestamp: BigInt(timestamp) });
const asset = { max_nav_age_secs: 180n };
const DAY = 60n; // demo profile

test("demo profile: closed at the edge second, open one second later (contract test t=1600 / 1601)", () => {
  assert.equal(NAV_OUTAGE_DAYS, 7);
  assert.deepEqual(inKindWindow(nav(1000), asset, DAY, 1600), { state: "waiting", opensAt: 1601 });
  assert.deepEqual(inKindWindow(nav(1000), asset, DAY, 1601), { state: "open", opensAt: 1601 });
});

test("fresh NAV: the sale is the exit, the claim is closed", () => {
  assert.equal(inKindWindow(nav(1000), asset, DAY, 1180).state, "fresh");
  assert.equal(inKindWindow(nav(1000), asset, DAY, 1181).state, "waiting");
});

test("future-dated price counts as fresh, never open", () => {
  assert.equal(inKindWindow(nav(5000), asset, DAY, 1000).state, "fresh");
});

test("no price or price <= 0: NoPrice, the window never opens", () => {
  assert.deepEqual(inKindWindow(null, asset, DAY, 10_000), { state: "none", opensAt: null });
  assert.equal(inKindWindow(nav(1000, 0n), asset, DAY, 10_000).state, "none");
  assert.equal(inKindWindow(nav(1000), null, DAY, 10_000).state, "none");
});

test("production profile: 96 h age + 7 days = 11 days after the last print", () => {
  const w = inKindWindow(nav(0), { max_nav_age_secs: 96n * 3600n }, 86_400n, 11 * 86_400);
  assert.equal(w.state, "waiting");
  assert.equal(w.opensAt, 11 * 86_400 + 1);
});
