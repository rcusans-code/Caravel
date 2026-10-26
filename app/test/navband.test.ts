// The app's NAV band / staleness mirror vs contracts/repo/src/oracle.rs
// (`fresh_nav`, `check_band`): same cases as the oracle.rs band tests, plus
// the top-up and desk copy and the ledger clock. Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBand, ledgerNow, navBlock, navHealth, topUpHoldText, type PricePoint } from "../src/gates.ts";

const ONE = 10n ** 14n; // 1.0 at the mock feed's 14 decimals
const FIFTY_BPS = ONE / 200n;
const NOW = 1_000_000;
const band = (bps: bigint | null, floor: bigint | null = null, ceiling: bigint | null = null) => ({
  max_nav_age_secs: 180n,
  max_nav_move_bps: bps,
  nav_floor: floor,
  nav_ceiling: ceiling,
});
/** Records oldest first (as posted) -> `prices` order (newest first). */
const posted = (...p: [bigint, number][]): PricePoint[] => p.map(([price, ts]) => ({ price, timestamp: BigInt(ts) })).reverse();
const health = (h: PricePoint[], asset = band(50n), now = NOW) =>
  navHealth({ price: h[0].price, decimals: 14, timestamp: h[0].timestamp }, h, asset, now);

test("band edge is inclusive (oracle.rs band_edge_is_inclusive)", () => {
  assert.equal(health(posted([ONE, NOW - 60], [ONE + FIFTY_BPS, NOW])).state, "live");
  assert.equal(health(posted([ONE, NOW - 60], [ONE + FIFTY_BPS + 1n, NOW])).state, "hold");
  assert.equal(health(posted([ONE, NOW - 60], [ONE - FIFTY_BPS - 1n, NOW])).state, "hold");
});

test("every record in the window counts (band_checks_every_record_in_the_window)", () => {
  const h = posted([ONE, NOW - 120], [ONE + (ONE * 4n) / 1000n, NOW - 60], [ONE + (ONE * 8n) / 1000n, NOW]);
  assert.equal(health(h).state, "hold");
});

test("re-posts of a bad price cannot hide the good record behind them", () => {
  const h = posted([ONE, NOW - 125], [ONE / 2n, NOW - 65], [ONE / 2n, NOW - 5]);
  assert.equal(health(h).state, "hold");
  // ...until the good record leaves the 20-record window.
  const rolled = posted(...Array.from({ length: 20 }, (_, i): [bigint, number] => [ONE / 2n, NOW - 60 * (19 - i)]));
  assert.equal(health([...rolled, { price: ONE, timestamp: BigInt(NOW - 1260) }]).state, "live");
});

test("non-positive records are skipped (band_skips_non_positive_records)", () => {
  assert.equal(health(posted([0n, NOW - 60], [ONE, NOW])).state, "live");
});

test("floor and ceiling are inclusive (band_floor_and_ceiling_are_inclusive)", () => {
  const h = posted([ONE, NOW]);
  assert.equal(health(h, band(50n, ONE, ONE)).state, "live");
  assert.equal(health(h, band(50n, ONE + 1n)).state, "hold");
  assert.equal(health(h, band(50n, null, ONE - 1n)).state, "hold");
  assert.match(navBlock("tBENJI", health(h, band(50n, ONE + 1n)), band(50n, ONE + 1n))!, /below its floor/);
});

test("staleness is checked before the band (staleness_is_checked_before_the_band)", () => {
  const h = posted([ONE, NOW - 180 - 61], [ONE / 2n, NOW - 180 - 1]);
  const s = health(h);
  assert.equal(s.state, "stale");
  assert.equal(s.band?.ok, false, "band result is still reported for top_up");
});

test("future timestamps: up to 60 s is fresh, further is refused (MAX_FUTURE_SKEW_SECS)", () => {
  assert.equal(health(posted([ONE, NOW + 60])).state, "live");
  assert.equal(health(posted([ONE, NOW + 61])).state, "future");
  assert.match(navBlock("tBENJI", health(posted([ONE, NOW + 61])), band(50n))!, /ahead of the ledger/);
});

test("a contract without the band (#31) never holds", () => {
  assert.equal(checkBand(ONE / 2n, posted([ONE, NOW - 60]), band(null)).ok, true);
});

test("desk reason names the move and the band", () => {
  const h = health(posted([ONE, NOW - 60], [(ONE * 70n) / 100n, NOW]), band(2500n), NOW);
  assert.equal(h.state, "hold");
  const why = navBlock("tBENJI", h, band(2500n))!;
  assert.match(why, /moved 30% against one of its last 20 prices, more than its 25% sanity band/);
  assert.match(why, /Repay and top-up still work/);
});

test("MarginCall top-up: told it will not clear while on hold, even if the NAV is also stale", () => {
  const hold = health(posted([ONE, NOW - 60], [ONE / 2n, NOW]));
  assert.match(topUpHoldText("tBENJI", hold)!, /does not clear the margin call/);
  const staleButInBand = health(posted([ONE, NOW - 400]));
  assert.equal(staleButInBand.state, "stale");
  assert.equal(topUpHoldText("tBENJI", staleButInBand), null, "top_up clears on a stale in-band NAV (#6)");
  assert.match(topUpHoldText("tBENJI", navHealth(null, null, band(50n), NOW))!, /no tBENJI price/);
});

test("staleness uses ledger time, not a skewed browser clock", () => {
  // Browser clock 10 min fast: the ledger closed at NOW, read at browser NOW+600.
  const sample = { closeTime: NOW, at: NOW + 600 };
  const browser = NOW + 605;
  const h = posted([ONE, NOW - 100]);
  assert.equal(health(h, band(50n), browser).state, "stale", "browser clock alone: wrongly stale");
  assert.equal(ledgerNow(browser, sample), NOW + 5);
  assert.equal(health(h, band(50n), ledgerNow(browser, sample)).state, "live");
  // Browser clock 10 min slow: a stale price must not look fresh.
  const slow = { closeTime: NOW, at: NOW - 600 };
  const old = posted([ONE, NOW - 200]);
  assert.notEqual(health(old, band(50n), NOW - 600).state, "stale", "browser clock alone: misses the stale price");
  assert.equal(health(old, band(50n), ledgerNow(NOW - 600, slow)).state, "stale");
  assert.equal(ledgerNow(123, null), 123, "no sample yet: browser clock");
});

// --- band settle path (oracle.rs `settled` / `level_holds`, side band-real-move) ---
const SETTLE = 1_200;
const settleBand = (bps: bigint, settle: bigint | null = BigInt(SETTLE)) => ({ ...band(bps), band_settle_secs: settle });
// A real move of +1% against a 0.5% band: the window (old ONE records) refuses it.
const LEVEL = ONE + ONE / 100n;
const SINCE = NOW - SETTLE;
const moved = posted([ONE, SINCE - 120], [ONE, SINCE - 60], [LEVEL, SINCE], [LEVEL, NOW - 60], [LEVEL, NOW]);
const settleHealth = (h: PricePoint[], cand: { price: bigint; since: bigint } | null, asset = settleBand(50n), now = NOW) =>
  navHealth({ price: h[0].price, decimals: 14, timestamp: h[0].timestamp }, h, asset, now, cand);

test("settled level passes once it has stood band_settle_secs", () => {
  const cand = { price: LEVEL, since: BigInt(SINCE) };
  const h = settleHealth(moved, cand);
  assert.equal(h.state, "live");
  assert.equal(h.band?.settled, true);
  assert.equal(topUpHoldText("tBENJI", h), null, "top_up clears on a settled level");
});

test("unsettled level holds (one second short of band_settle_secs)", () => {
  const cand = { price: LEVEL, since: BigInt(SINCE + 1) };
  const h = settleHealth(moved, cand);
  assert.equal(h.state, "hold");
  assert.match(navBlock("tBENJI", h, settleBand(50n))!, /once the new level has held for 20 minutes/);
});

test("a record since `since` outside the band of the level holds", () => {
  const cand = { price: LEVEL, since: BigInt(SINCE) };
  // A spike after `since`, far from the candidate: level_holds fails.
  const spiked = posted([ONE, SINCE - 60], [LEVEL, SINCE], [LEVEL * 2n, NOW - 60], [LEVEL, NOW]);
  assert.equal(settleHealth(spiked, cand).state, "hold");
  // The same spike before `since` does not count against the level.
  const before = posted([LEVEL * 2n, SINCE - 60], [LEVEL, SINCE], [LEVEL, NOW]);
  assert.equal(settleHealth(before, cand).state, "live");
});

test("latest within the band of the level but ~2x band from a record since `since` holds", () => {
  // Level L, record at L(1+band), then a push to L(1-band): each within the
  // band of L, but 2x band from the record (settled's last loop).
  const cand = { price: LEVEL, since: BigInt(SINCE) };
  const high = LEVEL + (LEVEL * 50n) / 10_000n;
  const low = LEVEL - (LEVEL * 50n) / 10_000n;
  assert.equal(settleHealth(posted([ONE, SINCE - 60], [LEVEL, SINCE], [high, NOW - 60], [low, NOW]), cand).state, "hold");
  assert.equal(settleHealth(posted([ONE, SINCE - 60], [LEVEL, SINCE], [high, NOW - 60], [high, NOW]), cand).state, "live");
});

test("latest outside the band of the level holds, and floor/ceiling still apply first", () => {
  const cand = { price: LEVEL, since: BigInt(SINCE) };
  const far = LEVEL + (LEVEL * 51n) / 10_000n;
  assert.equal(settleHealth(posted([ONE, SINCE - 60], [LEVEL, SINCE], [far, NOW]), cand).state, "hold");
  const ceiling = { ...settleBand(50n), nav_ceiling: ONE };
  assert.equal(settleHealth(moved, cand, ceiling).band?.why, "ceiling");
});

test("no candidate, a contract without the view (null), or without band_settle_secs: window roll only, as before", () => {
  assert.equal(settleHealth(moved, null).state, "hold");
  const cand = { price: LEVEL, since: BigInt(SINCE) };
  assert.equal(settleHealth(moved, cand, settleBand(50n, null)).state, "hold");
  assert.equal(health(moved, band(50n)).state, "hold", "old navHealth call without a candidate");
  assert.equal(checkBand(LEVEL, moved, band(50n)).ok, false, "old checkBand call without settle");
  // u64::MAX turns the settle path off and drops it from the copy.
  const off = settleBand(50n, (1n << 64n) - 1n);
  assert.equal(settleHealth(moved, cand, off).state, "hold");
  assert.doesNotMatch(navBlock("tBENJI", settleHealth(moved, cand, off), off)!, /new level/);
});

test("QA variant: a zero record since `since` is skipped, and a candidate dated ahead of the ledger never settles", () => {
  // oracle.rs level_holds / settled skip records <= 0, as the window does.
  const cand = { price: LEVEL, since: BigInt(SINCE) };
  const zero = posted([ONE, SINCE - 60], [LEVEL, SINCE], [0n, NOW - 60], [LEVEL, NOW]);
  assert.equal(settleHealth(zero, cand).state, "live");
  // `since` after ledger now: saturating_sub gives 0 < band_settle_secs, so it holds.
  assert.equal(settleHealth(moved, { price: LEVEL, since: BigInt(NOW + 10) }).state, "hold");
});
