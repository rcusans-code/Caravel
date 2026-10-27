// npm test: the Spiko NAV feeder (spiko.ts) on recorded Spiko Public API
// responses (fixtures/spiko/, fetched 27 Oct 2026). Covers the price and
// source timestamp it posts, the no-re-post rule, a weekend, a NAV day
// with no same-day EUR/USD rate (own fund vs fallback fund), API errors
// (nothing posted) and the jump hold (#37).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  feederTick,
  fetchSpiko,
  oraclePrice,
  parseFx,
  parseNav,
  planPost,
  SpikoApiError,
  type FetchLike,
  type OnChainRecord,
  type PlanOpts,
  type SpikoReading,
  type TickDeps,
} from "./spiko.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/spiko");
const fx = (name: string) => JSON.parse(readFileSync(path.join(FIX, name), "utf8"));

const DEC = 14;
const SAFO_FUND = "59c2c924-ebf8-492d-a4b0-72d72ebf61e6";
const USTBL_FUND = "3133596a-3e13-4a7f-ba6e-34d3744a9a7f";
// Mon 26 Oct 2026: NAV 1.015785 EUR published 17:48:20.045Z, EUR/USD 1.1204 published 17:43:16.865Z.
const MON_TS = Date.parse("2026-10-26T17:43:16Z") / 1000;
const MON_PRICE = 113_808_551_400_000n; // 1.015785 x 1.1204 = 1.138085514 exactly
// Fri 23 Oct 2026: NAV 1.015707 and rate 1.1204 both published 15:45:57.833Z.
const FRI_TS = Date.parse("2026-10-23T15:45:57Z") / 1000;
const FRI_PRICE = 113_799_812_280_000n;

const opts = (now: number, acks: bigint[] = []): PlanOpts => ({ decimals: DEC, now, jumpAckBps: 1000n, acks: new Set(acks) });
const reading = (navFile: string, fxFile: string | null, fxFallback = false): SpikoReading => ({
  symbol: "eurSAFO",
  fundId: SAFO_FUND,
  nav: parseNav(fx(navFile)),
  fx: fxFile ? parseFx(fx(fxFile)) : null,
  fxFallback,
});
const rec = (price: bigint, ts: number): OnChainRecord => ({ price, timestamp: BigInt(ts) });

/** A fetch that answers from fixtures by URL path; anything else 404s, `fail` paths answer 503. */
function fakeFetch(routes: Record<string, string>, fail: string[] = []): { f: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    const p = url.replace("https://public-api.spiko.io/v0", "");
    calls.push(p);
    if (fail.some((x) => p.startsWith(x))) return { ok: false, status: 503, json: async () => ({}) };
    const file = routes[p];
    if (!file) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => fx(file) };
  };
  return { f, calls };
}
const fxPath = (fund: string) => `/exchange-rates/latest?fundId=${fund}&baseCurrency=EUR&quoteCurrency=USD`;
const MONDAY_ROUTES = {
  "/share-classes/eurSAFO": "share-class-eurSAFO.json",
  "/net-asset-values/eurSAFO/latest": "nav-latest-2026-10-26.json",
  [fxPath(SAFO_FUND)]: "fx-latest-2026-10-26.json",
  "/funds/": "funds.json",
};

test("price = NAV x same-day EUR/USD, floored to 14 decimals, exact", () => {
  assert.equal(oraclePrice("1.015785", "1.1204", DEC), MON_PRICE);
  assert.equal(oraclePrice("1.015707", "1.1204", DEC), FRI_PRICE);
  // A USD class needs no rate; floors, never rounds up.
  assert.equal(oraclePrice("1.0000000000000099", null, DEC), 100_000_000_000_000n);
  // Spiko's USD/EUR rates come with long tails and exponents.
  assert.equal(oraclePrice("1", "8.926977325477593286913e-1", DEC), 89_269_773_254_775n);
  assert.equal(oraclePrice("2", "5e0", 2), 1000n);
});

test("parse rejects bodies that are not a NAV or a rate", () => {
  assert.throws(() => parseNav({ day: "2026-10-26", amount: { value: "abc", currency: "EUR" }, updatedAt: "2026-10-26T17:48:20Z" }));
  assert.throws(() => parseNav({ day: "2026-10-26", amount: { value: "0", currency: "EUR" }, updatedAt: "2026-10-26T17:48:20Z" }));
  assert.throws(() => parseNav({ day: "2026-10-26", amount: { value: "1.01", currency: "EUR" }, updatedAt: "yesterday" }));
  assert.throws(() => parseFx({ _tag: "HttpApiDecodeError" }));
  assert.throws(() => parseNav(null));
});

test("Monday: posts NAV x rate stamped with the older Spiko publication time, not now", () => {
  const p = planPost(reading("nav-latest-2026-10-26.json", "fx-latest-2026-10-26.json"), rec(FRI_PRICE, FRI_TS), opts(MON_TS + 3600 * 16));
  assert.equal(p.kind, "post");
  assert.equal(p.kind === "post" && p.price, MON_PRICE);
  // FX 17:43:16 is older than NAV 17:48:20: the record carries 17:43:16.
  assert.equal(p.kind === "post" && p.timestamp, MON_TS);
  assert.equal(p.day, "2026-10-26");
});

test("no re-post: once the oracle holds the NAV day, every later tick is a no-op", () => {
  const r = reading("nav-latest-2026-10-26.json", "fx-latest-2026-10-26.json");
  for (const now of [MON_TS + 60, MON_TS + 86_400, MON_TS + 3 * 86_400]) {
    assert.equal(planPost(r, rec(MON_PRICE, MON_TS), opts(now)).kind, "current");
  }
  // A later re-publication of the same NAV day (Spiko corrects it at 23:00)
  // is still the same UTC day: the oracle would refuse it (SameDay), so the
  // feeder does not try.
  const corrected = { ...r, nav: { ...r.nav, updatedAt: MON_TS + 5 * 3600 } };
  assert.equal(planPost(corrected, rec(MON_PRICE, MON_TS), opts(MON_TS + 6 * 3600)).kind, "current");
});

test("weekend: Saturday and Sunday Spiko still serves Friday, nothing is posted, the record stays under 96 h old", () => {
  const fri = reading("nav-2026-10-23.json", "fx-2026-10-23.json");
  const onChain = rec(FRI_PRICE, FRI_TS);
  const sat = Date.parse("2026-10-24T12:00:00Z") / 1000;
  const monMorning = Date.parse("2026-10-26T09:00:00Z") / 1000;
  for (const now of [sat, sat + 86_400, monMorning]) {
    const p = planPost(fri, onChain, opts(now));
    assert.equal(p.kind, "current");
    assert.ok(now - FRI_TS < 96 * 3600, "Friday's print is still fresh on Monday morning");
  }
  // Monday's print then posts.
  assert.equal(planPost(reading("nav-latest-2026-10-26.json", "fx-latest-2026-10-26.json"), onChain, opts(MON_TS + 600)).kind, "post");
});

test("no rate dated the NAV day: waits instead of pricing at a stale rate", () => {
  // 17 Jun 2026: the SAFO fund's newest EUR/USD rate was 15 Jun's.
  const stale = planPost(reading("nav-2026-06-17.json", "fx-safo-stale-2026-06-15.json"), null, opts(Date.parse("2026-06-17T18:00:00Z") / 1000));
  assert.equal(stale.kind, "wait");
  assert.match(stale.why, /dated the NAV day 2026-06-17.*2026-06-15/);
  // USTBL's rate was dated 17 Jun: that one prices it.
  const ok = planPost(reading("nav-2026-06-17.json", "fx-ustbl-2026-06-17.json", true), null, opts(Date.parse("2026-06-17T18:00:00Z") / 1000));
  assert.equal(ok.kind, "post");
  assert.equal(ok.kind === "post" && ok.price, oraclePrice("1.006345", "1.1605", DEC));
  // Older of NAV 12:36:05 and FX 13:45:16.
  assert.equal(ok.kind === "post" && ok.timestamp, Date.parse("2026-06-17T12:36:05Z") / 1000);
});

test("a publication time ahead of this clock waits (the oracle would refuse it)", () => {
  const p = planPost(reading("nav-latest-2026-10-26.json", "fx-latest-2026-10-26.json"), null, opts(MON_TS - 1));
  assert.equal(p.kind, "wait");
});

test("jump hold (#37): a print more than 10% from the last record is not posted until acked", () => {
  const r = reading("nav-latest-2026-10-26.json", "fx-latest-2026-10-26.json");
  const low = (FRI_PRICE * 85n) / 100n;
  const held = planPost(r, rec(low, FRI_TS), opts(MON_TS + 60));
  assert.equal(held.kind, "hold");
  assert.equal(planPost(r, rec(low, FRI_TS), opts(MON_TS + 60, [MON_PRICE])).kind, "post");
});

test("fetchSpiko: own fund's rate when dated the NAV day, no fallback calls", async () => {
  const { f, calls } = fakeFetch(MONDAY_ROUTES);
  const r = await fetchSpiko("eurSAFO", { fetch: f });
  assert.equal(r.nav.value, "1.015785");
  assert.equal(r.fx?.rate, "1.1204");
  assert.equal(r.fxFallback, false);
  assert.deepEqual(calls, ["/share-classes/eurSAFO", "/net-asset-values/eurSAFO/latest", fxPath(SAFO_FUND)]);
});

test("fetchSpiko: falls back to another Spiko fund's rate dated the NAV day (404s skipped)", async () => {
  const { f } = fakeFetch({
    "/share-classes/eurSAFO": "share-class-eurSAFO.json",
    "/net-asset-values/eurSAFO/latest": "nav-2026-06-17.json",
    [fxPath(SAFO_FUND)]: "fx-safo-stale-2026-06-15.json",
    "/funds/": "funds.json",
    [fxPath(USTBL_FUND)]: "fx-ustbl-2026-06-17.json",
  });
  const r = await fetchSpiko("eurSAFO", { fetch: f });
  assert.equal(r.fx?.fundId, USTBL_FUND);
  assert.equal(r.fx?.day, "2026-06-17");
  assert.equal(r.fxFallback, true);
});

test("fetchSpiko: HTTP errors, timeouts and junk bodies throw SpikoApiError", async () => {
  await assert.rejects(fetchSpiko("eurSAFO", { fetch: fakeFetch(MONDAY_ROUTES, ["/net-asset-values"]).f }), (e: unknown) => {
    assert.ok(e instanceof SpikoApiError);
    assert.equal(e.status, 503);
    return true;
  });
  const hang: FetchLike = (_url, init) =>
    new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("The operation was aborted due to timeout"))));
  await assert.rejects(fetchSpiko("eurSAFO", { fetch: hang, timeoutMs: 20 }), /timeout/);
  const junk: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ fundId: SAFO_FUND, day: "x" }) });
  await assert.rejects(fetchSpiko("eurSAFO", { fetch: junk }), SpikoApiError);
});

/** feederTick with fakes: records posts, log lines and alerts. */
function deps(over: Partial<TickDeps> & { now: number; last: OnChainRecord | null; read: TickDeps["read"] }) {
  const posts: Array<[bigint, number]> = [];
  const lines: string[] = [];
  const alerts: string[] = [];
  const d: TickDeps = {
    symbol: "eurSAFO",
    lastRecord: async () => over.last,
    post: async (p, t) => {
      posts.push([p, t]);
      return "tx";
    },
    log: (l) => lines.push(l),
    alert: (_k, m) => alerts.push(m),
    opts: opts(over.now),
    dryRun: false,
    staleAfterSecs: 345_600,
    ...over,
  };
  return { d, posts, lines, alerts };
}

test("tick: Monday posts exactly once with Spiko's timestamp; the next tick sends nothing", async () => {
  const read = () => fetchSpiko("eurSAFO", { fetch: fakeFetch(MONDAY_ROUTES).f });
  const a = deps({ now: MON_TS + 900, last: rec(FRI_PRICE, FRI_TS), read });
  assert.equal((await feederTick(a.d)).outcome, "posted");
  assert.deepEqual(a.posts, [[MON_PRICE, MON_TS]]);
  const b = deps({ now: MON_TS + 1200, last: rec(MON_PRICE, MON_TS), read });
  assert.equal((await feederTick(b.d)).outcome, "current");
  assert.deepEqual(b.posts, []);
});

test("tick: an API error posts nothing and reports an error (the CLI alerts)", async () => {
  const t = deps({ now: MON_TS + 900, last: rec(FRI_PRICE, FRI_TS), read: () => fetchSpiko("eurSAFO", { fetch: fakeFetch(MONDAY_ROUTES, ["/exchange-rates"]).f }) });
  const r = await feederTick(t.d);
  assert.equal(r.outcome, "error");
  assert.match(r.error ?? "", /HTTP 503/);
  assert.deepEqual(t.posts, []);
  assert.match(t.lines[0], /read FAILED, nothing posted/);
});

test("tick: an RPC error reading the oracle posts nothing", async () => {
  const t = deps({ now: MON_TS + 900, last: null, read: () => fetchSpiko("eurSAFO", { fetch: fakeFetch(MONDAY_ROUTES).f }) });
  t.d.lastRecord = async () => {
    throw new Error("RPC timeout");
  };
  assert.equal((await feederTick(t.d)).outcome, "error");
  assert.deepEqual(t.posts, []);
});

test("tick: a failed set_price_at is an error, not a success", async () => {
  const t = deps({ now: MON_TS + 900, last: rec(FRI_PRICE, FRI_TS), read: () => fetchSpiko("eurSAFO", { fetch: fakeFetch(MONDAY_ROUTES).f }) });
  t.d.post = async () => {
    throw new Error("contract error #8");
  };
  const r = await feederTick(t.d);
  assert.equal(r.outcome, "error");
  assert.match(r.error ?? "", /#8/);
});

test("tick: dry-run prints the price and timestamp it would post and sends nothing", async () => {
  const t = deps({ now: MON_TS + 900, last: null, dryRun: true, read: () => fetchSpiko("eurSAFO", { fetch: fakeFetch(MONDAY_ROUTES).f }) });
  assert.equal((await feederTick(t.d)).outcome, "post");
  assert.deepEqual(t.posts, []);
  assert.match(t.lines[0], /1\.13808551400000 USD \(113808551400000\) @ 1793036596 \(2026-10-26T17:43:16Z\).*would post/);
});

test("tick: a record older than the asset's max NAV age alerts (Spiko silent past 96 h)", async () => {
  // Easter-like gap: Spiko still serves Thursday's NAV on Tuesday morning.
  const t = deps({ now: FRI_TS + 97 * 3600, last: rec(FRI_PRICE, FRI_TS), read: async () => reading("nav-2026-10-23.json", "fx-2026-10-23.json") });
  assert.equal((await feederTick(t.d)).outcome, "current");
  assert.equal(t.alerts.length, 1);
  assert.match(t.alerts[0], /StaleNav/);
  assert.deepEqual(t.posts, []);
});

test("tick: a held jump alerts and posts nothing", async () => {
  const t = deps({ now: MON_TS + 900, last: rec((FRI_PRICE * 85n) / 100n, FRI_TS), read: () => fetchSpiko("eurSAFO", { fetch: fakeFetch(MONDAY_ROUTES).f }) });
  assert.equal((await feederTick(t.d)).outcome, "hold");
  assert.deepEqual(t.posts, []);
  assert.match(t.alerts[0], /jumped/);
});

// --- EUR market (DECISIONS #52): the oracle quotes in EUR, the NAV is EUR ---

// Mon 26 Oct 2026 NAV 1.015785 EUR as-is, at the NAV's own publication time 17:48:20.
const MON_NAV_TS = Date.parse("2026-10-26T17:48:20Z") / 1000;
const MON_EUR_PRICE = 101_578_500_000_000n;
const eurOpts = (now: number): PlanOpts => ({ ...opts(now), quote: "EUR" });

test("EUR oracle: posts the EUR NAV unconverted at the NAV publication time, with no FX fetch", async () => {
  const { f, calls } = fakeFetch(MONDAY_ROUTES);
  const r = await fetchSpiko("eurSAFO", { fetch: f, quote: "EUR" });
  assert.equal(r.fx, null);
  assert.deepEqual(calls, ["/share-classes/eurSAFO", "/net-asset-values/eurSAFO/latest"]);
  const p = planPost(r, rec(oraclePrice("1.015707", null, DEC), FRI_TS), eurOpts(MON_TS + 3600));
  assert.equal(p.kind, "post");
  assert.equal(p.kind === "post" && p.price, MON_EUR_PRICE);
  assert.equal(p.kind === "post" && p.timestamp, MON_NAV_TS);
});

test("EUR oracle tick posts 1.015785 EUR; the USD oracle still posts NAV x 1.1204", async () => {
  const eur = deps({ now: MON_TS + 900, last: null, read: () => fetchSpiko("eurSAFO", { fetch: fakeFetch(MONDAY_ROUTES).f, quote: "EUR" }) });
  eur.d.opts = eurOpts(MON_TS + 900);
  assert.equal((await feederTick(eur.d)).outcome, "posted");
  assert.deepEqual(eur.posts, [[MON_EUR_PRICE, MON_NAV_TS]]);
  assert.match(eur.lines[0], /-> 1\.01578500000000 EUR \(101578500000000\)/);
  const usd = deps({ now: MON_TS + 900, last: null, read: () => fetchSpiko("eurSAFO", { fetch: fakeFetch(MONDAY_ROUTES).f }) });
  assert.equal((await feederTick(usd.d)).outcome, "posted");
  assert.deepEqual(usd.posts, [[MON_PRICE, MON_TS]]);
});

test("EUR oracle: a NAV in another currency waits (only X/USD rates are converted)", () => {
  const usdNav = { ...reading("nav-latest-2026-10-26.json", null), nav: { ...parseNav(fx("nav-latest-2026-10-26.json")), currency: "USD" } };
  const p = planPost(usdNav, null, eurOpts(MON_TS + 3600));
  assert.equal(p.kind, "wait");
  assert.match(p.why, /no USD\/EUR rate/);
});
