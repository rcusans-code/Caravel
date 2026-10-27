// Tab in the URL hash (issue #37): parse, canonical hash, admin fallback, demo roles,
// and the landing CTA rewrite (Lend -> /app/#lend).
// Run: npm test (plain node --test, no bundler).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { demoTab, parseHash, shownTab, toHash, type Route } from "../src/route.ts";
import { rewriteCtas } from "../scripts/landing-ctas.mjs";

test("parseHash: the five tabs, empty hash = Offers", () => {
  assert.deepEqual(parseHash(""), { route: { tab: "offers" }, known: true });
  assert.deepEqual(parseHash("#"), { route: { tab: "offers" }, known: true });
  for (const t of ["offers", "lend", "request", "positions", "admin"] as const) assert.deepEqual(parseHash(`#${t}`), { route: { tab: t }, known: true });
  assert.deepEqual(parseHash("#LEND"), { route: { tab: "lend" }, known: true });
  assert.deepEqual(parseHash("#/positions"), { route: { tab: "positions" }, known: true });
});

test("parseHash: #offer/<id> and #repo/<id>", () => {
  assert.deepEqual(parseHash("#offer/3"), { route: { tab: "offers", offer: 3n }, known: true });
  assert.deepEqual(parseHash("#repo/12"), { route: { tab: "positions", repo: 12n }, known: true });
  assert.deepEqual(parseHash("#offer/18446744073709551615"), { route: { tab: "offers", offer: 18446744073709551615n }, known: true });
});

test("parseHash: unknown hashes fall back to #offers and are flagged", () => {
  for (const h of ["#launch", "#offer/", "#offer/x", "#offer/-1", "#repo/1/2", "#lend/3", "#borrow", "#offers?x"]) {
    assert.deepEqual(parseHash(h), { route: { tab: "offers" }, known: false }, h);
  }
});

test("toHash round-trips through parseHash", () => {
  const routes: Route[] = [
    { tab: "offers" },
    { tab: "lend" },
    { tab: "request" },
    { tab: "positions" },
    { tab: "admin" },
    { tab: "offers", offer: 7n },
    { tab: "positions", repo: 42n },
  ];
  for (const r of routes) assert.deepEqual(parseHash(toHash(r)).route, r);
  assert.equal(toHash({ tab: "offers", offer: 3n }), "#offer/3");
  assert.equal(toHash({ tab: "positions", repo: 9n }), "#repo/9");
});

test("shownTab: #admin shows Offers to a non-admin, Admin to the admin", () => {
  assert.equal(shownTab({ tab: "admin" }, false), "offers");
  assert.equal(shownTab({ tab: "admin" }, true), "admin");
  assert.equal(shownTab({ tab: "lend" }, false), "lend");
});

test("demoTab: each demo role lands on its tab", () => {
  assert.equal(demoTab("lender"), "lend");
  assert.equal(demoTab("borrower"), "offers");
  assert.equal(demoTab("admin"), "admin");
  assert.equal(demoTab("liquidator"), "positions");
});

test("landing CTAs: Lend at a fixed rate -> /app/#lend, the other demo links -> /app/", () => {
  const site = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
  const { html, hits } = rewriteCtas(site, "/app/");
  assert.equal(hits["Lend at a fixed rate"], 1);
  assert.match(html, /<a href="\/app\/#lend"[^>]*>Lend at a fixed rate<\/a>/);
  assert.match(html, /<a href="\/app\/"[^>]*>Borrow against fund shares<\/a>/);
  assert.match(html, /<a href="\/app\/"[^>]*>Try the demo<\/a>/);
  const total = Object.values(hits).reduce((a, b) => a + b, 0);
  assert.equal((html.match(/href="\/app\/"/g) ?? []).length, total - 1);
  // Non-CTA anchors such as "Mainnet pilot" keep their in-page hash.
  assert.match(html, /<a href="#launch">Mainnet pilot<\/a>/);
});
