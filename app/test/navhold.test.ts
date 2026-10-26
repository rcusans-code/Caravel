// Side nav-ux (NAV review 2026-10-26): the app must not say "Live" or offer
// Take while the contract would refuse the price with NavOutOfBand (#18).
// Run: npm test (plain node --test, no bundler).
import { test } from "node:test";
import assert from "node:assert/strict";
import { navBadge, navHealth, takeNavBlock } from "../src/gates.ts";

const DEC = 14; // mock feed decimals
const ONE = 10n ** 14n;
const NOW = 1_000_000;
// Testnet launch values (deployments/testnet.json tbenjiAsset): 180 s, 25% band.
const ASSET = { max_nav_age_secs: 180n, max_nav_move_bps: 2500n, nav_floor: null, nav_ceiling: null };

/** Oracle `prices(asset, 20)`: newest first, one record a minute. */
const history = (newest: bigint, older: bigint, n = 20) =>
  Array.from({ length: n }, (_, i) => ({ price: i === 0 ? newest : older, timestamp: BigInt(NOW - 10 - 60 * i) }));

test("out-of-band push (1.00 -> 0.70, band 25%): status is not Live and Take is blocked", () => {
  const h = history((ONE * 70n) / 100n, ONE);
  const nav = { price: h[0].price, decimals: DEC, timestamp: h[0].timestamp };
  const health = navHealth(nav, h, ASSET, NOW);
  const badge = navBadge(health);
  const block = takeNavBlock("tBENJI", health, ASSET);
  console.log(`  out-of-band: badge=${JSON.stringify(badge.word)} take_block=${block === null ? "none (Take enabled)" : "set"}`);
  assert.notEqual(badge.word, "Live");
  assert.equal(badge.word, "Price on hold");
  assert.ok(block, "Take must be blocked");
  assert.match(block!, /on hold/);
});

test("in-band move (1.00 -> 0.80, band 25%): Live and Take open", () => {
  const h = history((ONE * 80n) / 100n, ONE);
  const nav = { price: h[0].price, decimals: DEC, timestamp: h[0].timestamp };
  const health = navHealth(nav, h, ASSET, NOW);
  assert.equal(navBadge(health).word, "Live");
  assert.equal(takeNavBlock("tBENJI", health, ASSET), null);
});
