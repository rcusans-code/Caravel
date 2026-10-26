// Live SEP-40 reference feed: asset parsing from .env, reading normalisation
// and the price scaling the NAV strip shows. Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assetLabel, parseAsset, toReading } from "../src/sep40.ts";
import { fmtNav } from "../src/format.ts";

test("parseAsset: .env forms and the CLI JSON form", () => {
  assert.deepEqual(parseAsset("Other:USDC"), { Other: "USDC" });
  assert.deepEqual(parseAsset(" Stellar:CABC "), { Stellar: "CABC" });
  assert.deepEqual(parseAsset('{"Other":"XLM"}'), { Other: "XLM" });
  assert.throws(() => parseAsset("USDC"), /bad SEP-40 asset/);
  assert.throws(() => parseAsset("Other:"), /bad SEP-40 asset/);
  assert.equal(assetLabel({ Other: "USDC" }), "USDC");
});

test("toReading: Option<PriceData> + decimals, None = no price", () => {
  // Shape scValToNative returns for Reflector testnet lastprice(Other(USDC)).
  const r = toReading({ price: 100124792737995n, timestamp: 1792995600n }, 14);
  assert.deepEqual(r, { price: 100124792737995n, decimals: 14, timestamp: 1792995600 });
  assert.equal(toReading(null, 14), null);
  assert.equal(toReading(undefined, 14), null);
});

test("fmtNav scales by the feed's decimals, half-up at 4 dp", () => {
  assert.equal(fmtNav(100124792737995n, 14), "1.0012"); // live Reflector USDC, 14 decimals
  assert.equal(fmtNav(100_000_000_000_000n, 14), "1.0000"); // mock NAV 1.00
  assert.equal(fmtNav(99_995_000_000_000n, 14), "1.0000"); // rounds half up
  assert.equal(fmtNav(99_994_999_999_999n, 14), "0.9999");
  assert.equal(fmtNav(1_0012479n, 7), "1.0012"); // 7-decimal feed
  assert.equal(fmtNav(5n, 14), "0.0000");
});

test("fmtNav handles a feed with fewer decimals than shown", () => {
  assert.equal(fmtNav(100n, 2), "1.0000");
  assert.equal(fmtNav(7n, 0), "7.0000");
  assert.equal(fmtNav(-150n, 2), "-1.5000");
});
