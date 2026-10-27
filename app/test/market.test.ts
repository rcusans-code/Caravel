// USDC / EURC market switch (DECISIONS #52): which deployment the page uses, the
// switch link, and the loan token + quote read from each deployments/*.json.
// Run: npm test (plain node --test, no bundler). test/fixtures/testnet-eur.json is
// a generated file in the shape `LOAN_ASSET=EURC scripts/deploy.sh` writes
// (deployments/testnet-eur.json); its repo/oracle/tEURC ids are placeholders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loanToken, marketHref, pickMarket, quoteOf, quoteSign, type Deployment } from "../src/market.ts";
import { loanFrozenText, usdcBlock } from "../src/gates.ts";

const read = (rel: string): Deployment => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const eur = read("./fixtures/testnet-eur.json");
const usd = read("../../deployments/testnet.json");

test("pickMarket: eur only for ?market=eur when the EUR deployment is built in", () => {
  assert.equal(pickMarket("?market=eur", true), "eur");
  assert.equal(pickMarket("?market=eur", false), "usd");
  assert.equal(pickMarket("", true), "usd");
  assert.equal(pickMarket("?market=EUR2", true), "usd");
  assert.equal(pickMarket("?foo=eur", true), "usd");
  assert.equal(pickMarket("?market=usd", true), "usd");
});

test("marketHref keeps the tab hash", () => {
  assert.equal(marketHref("eur", "#lend"), "?market=eur#lend");
  assert.equal(marketHref("usd", ""), "?market=usd");
});

test("loanToken / quoteOf: tEURC in EUR on the EUR file, USDC in USD on testnet.json", () => {
  const e = loanToken(eur);
  assert.equal(e.code, "tEURC");
  assert.equal(e.sac, eur.contracts.usdc);
  assert.match(e.issuer, /^G[A-Z2-7]{55}$/);
  assert.equal(e.decimals, 7);
  assert.equal(quoteOf(eur), "EUR");
  assert.equal(quoteSign(quoteOf(eur)), "€");
  // The EUR market lists tSAFO only (DECISIONS #52): no tBENJI keys.
  assert.equal(eur.contracts.tbenji, undefined);
  assert.equal(eur.assets.tbenji, undefined);

  const u = loanToken(usd);
  assert.equal(u.code, "USDC");
  assert.equal(u.sac, usd.contracts.usdc);
  assert.equal(quoteOf(usd), "USD");
  assert.equal(quoteSign(quoteOf(usd)), "$");
});

test("quoteOf rejects an oracle base that is neither USD nor EUR", () => {
  assert.throws(() => quoteOf({ ...usd, oracle: { ...usd.oracle, base: { Other: "GBP" } } }), /expected Other USD or EUR/);
});

test("a frozen loan-token line names the market's token", () => {
  const b = { exists: true, xlm: 0n, usdc: 5n, usdcAuthorized: false, tbenji: null, tbenjiAuthorized: false, tsafo: null, tsafoAllowed: false };
  assert.equal(usdcBlock(b, "tEURC"), loanFrozenText("tEURC"));
  assert.match(loanFrozenText("tEURC"), /^tEURC frozen by its issuer: this account cannot send or receive tEURC/);
});
