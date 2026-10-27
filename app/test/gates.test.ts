// Per-asset access gate, auto-repay hint and error-9 copy (A6 / APP-01..03).
// Run: npm test (plain node --test, no bundler).
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoRepayDetail, autoRepayHint, collateralBlock, fmtDuration, pauseBlock, staleNavText } from "../src/gates.ts";

type Balances = NonNullable<Parameters<typeof collateralBlock>[0]>;

const TBENJI = { code: "tBENJI", kind: "sac" as const };
const TSAFO = { code: "tSAFO", kind: "spiko" as const };

const wallet = (over: Partial<Balances> = {}): Balances => ({
  exists: true,
  xlm: 10_000_0000000n,
  usdc: 0n,
  usdcAuthorized: true,
  tbenji: null,
  tbenjiAuthorized: false,
  tsafo: 0n,
  tsafoAllowed: false,
  ...over,
});

test("tSAFO-allowlisted wallet without tBENJI can use tSAFO, not tBENJI", () => {
  const b = wallet({ tsafoAllowed: true });
  assert.equal(collateralBlock(b, TSAFO), null);
  assert.match(collateralBlock(b, TBENJI)!, /Add the tBENJI trustline/);
});

test("tBENJI-authorized wallet off the tSAFO allowlist reaches the tSAFO message", () => {
  const b = wallet({ tbenji: 0n, tbenjiAuthorized: true });
  assert.equal(collateralBlock(b, TBENJI), null);
  assert.match(collateralBlock(b, TSAFO)!, /not on the tSAFO allowlist/);
});

test("tBENJI trustline without issuer authorization gets the not-authorized message", () => {
  assert.match(collateralBlock(wallet({ tbenji: 0n }), TBENJI)!, /not authorized to hold tBENJI/);
});

test("no gate before the account exists (friendbot check handles it)", () => {
  assert.equal(collateralBlock(null, TBENJI), null);
  assert.equal(collateralBlock(wallet({ exists: false }), TSAFO), null);
});

test("error 9 is worded from max_nav_age_secs", () => {
  assert.match(staleNavText([{ code: "tBENJI", secs: 180n }, { code: "tSAFO", secs: 180n }]), /^NAV is older than 3 minutes\./);
  assert.match(staleNavText([{ code: "tBENJI", secs: 600 }]), /older than 10 minutes/);
  assert.match(staleNavText([{ code: "tBENJI", secs: 90 }]), /older than 90 s/);
  const mixed = staleNavText([{ code: "tBENJI", secs: 180 }, { code: "tSAFO", secs: 3600 }]);
  assert.match(mixed, /tBENJI 3 minutes, tSAFO 1 hour/);
  assert.doesNotMatch(staleNavText([]), /3 minutes/);
});

test("fmtDuration", () => {
  assert.equal(fmtDuration(60), "1 minute");
  assert.equal(fmtDuration(7200n), "2 hours");
  assert.equal(fmtDuration(45), "45 s");
});

test("auto-repay hint is one sentence; its tip states the approve amount, expiry and that grace still applies", () => {
  const hint = autoRepayHint({ on: true, debt: "100.96", loan: "USDC", code: "tBENJI", graceSecs: 60, discount: "2.0%" });
  assert.equal(hint, "At maturity we pull 100.96 USDC and return your tBENJI.");
  const on = autoRepayDetail({ on: true, debt: "100.96", loan: "USDC", code: "tBENJI", graceSecs: 60, discount: "2.0%" })!;
  assert.match(on, /approves the contract to pull 100\.96 USDC/);
  assert.match(on, /expires about 1 day after maturity plus grace/);
  assert.match(on, /1 minute grace still applies/);
  assert.doesNotMatch(on, /the loan defaults\.$/);
  const off = autoRepayHint({ on: false, debt: "100.96", loan: "USDC", code: "tBENJI", graceSecs: 60, discount: "2.0%" });
  assert.match(off, /Repay 100\.96 USDC yourself by maturity \(plus 1 minute grace\)/);
  assert.equal(autoRepayDetail({ on: false, debt: "100.96", loan: "USDC", code: "tBENJI", graceSecs: 60, discount: "2.0%" }), null);
});

test("no_new_repos pause blocks Post and Take before the wallet opens; repay and top-up still work", () => {
  assert.equal(pauseBlock("tBENJI", { no_new_repos: true }), "New tBENJI loans are paused by the admin. Repay and top-up still work.");
  assert.equal(pauseBlock("tBENJI", { no_new_repos: false }), null);
  assert.equal(pauseBlock("tBENJI", null), null);
});
