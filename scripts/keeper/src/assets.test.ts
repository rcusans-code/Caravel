// npm test: the keeper's collateral list per market (assets.ts). The EUR
// market's .env (DECISIONS #52) has no tBENJI: the keeper must start on
// tSAFO alone instead of throwing on a missing TBENJI_SAC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketAssets } from "./assets.js";

const TBENJI = "CBENJIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TSAFO = "CTSAFOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("USD market: tBENJI and tSAFO", () => {
  assert.deepEqual(
    marketAssets({ TBENJI_SAC: TBENJI, TSAFO_ID: TSAFO }).map((a) => [a.label, a.id, a.decimals]),
    [
      ["tBENJI", TBENJI, 7],
      ["tSAFO", TSAFO, 5],
    ],
  );
});

test("EUR market: no TBENJI_SAC (unset or empty) builds a tSAFO-only list without throwing", () => {
  for (const env of [{ TSAFO_ID: TSAFO }, { TBENJI_SAC: "", TSAFO_ID: TSAFO }]) {
    const list = marketAssets(env);
    assert.deepEqual(
      list.map((a) => a.label),
      ["tSAFO"],
    );
    assert.equal(list[0].decimals, 5);
  }
});

test("no collateral at all is a startup error, not an empty keeper", () => {
  assert.throws(() => marketAssets({}), /no collateral asset/);
});
