// set-nav <price> [tbenji|tsafo]: admin posts a collateral NAV to the mock oracle.
//   npm run set-nav -- 0.97          # tBENJI
//   npm run set-nav -- 1.02 tsafo    # tSAFO (TSAFO_ID in .env)
import { Err, env, i128, invoke, keypair, log, stellarAsset, txLink, view } from "./chain.js";

/** "0.97" -> 0.97 × 10^decimals as an exact bigint (no float rounding). */
export function toUnits(nav: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(nav.trim());
  if (!m) throw new Error(`bad NAV "${nav}", expected e.g. 0.97`);
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) throw new Error(`NAV has more than ${decimals} decimals`);
  return BigInt(m[1] + frac);
}

/** Token contract for a collateral label: tbenji -> TBENJI_SAC, tsafo -> TSAFO_ID. */
export const collateralId = (label = "tbenji") =>
  label.toLowerCase() === "tsafo" ? env("TSAFO_ID") : env("TBENJI_SAC");

export async function setNav(price: bigint, token = env("TBENJI_SAC")) {
  return invoke(keypair("ADMIN"), env("ORACLE_ID"), "set_price", [stellarAsset(token), i128(price)]);
}

async function main() {
  const nav = process.argv[2];
  const label = process.argv[3] ?? "tbenji";
  if (!nav) {
    console.error("usage: npm run set-nav -- <nav> [tbenji|tsafo]   e.g. 0.97");
    process.exit(2);
  }
  const decimals = await view<number>(env("ORACLE_ID"), "decimals");
  const price = toUnits(nav, decimals);
  const { hash } = await setNav(price, collateralId(label));
  log(`set_price ${label} = ${nav} (${price}, ${decimals} dec)  ${txLink(hash)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`set-nav failed: ${e.message}${e.code === Err.NoPrice ? " (NoPrice)" : ""}`);
    process.exit(1);
  });
}
