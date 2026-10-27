// List every repo on the deployed contract: status, maturity, lender, debt,
// plus each lender's and the liquidator's USDC balance, and the liquidator
// funding floor (funding.ts): Σ debt × (1 − discount) / (1 − haircut) over the
// live repos, per collateral asset, plus LIQ_FLOOR_MARGIN_BPS (default 10%).
//
//   npm run repos
import { Address } from "@stellar/stellar-sdk";
import { ContractError, Err, env, keypair, u64, view } from "./chain.js";
import { type Exposure, FLOOR_STATUSES, liquidatorFloor, marginFromEnv, topUpWhole } from "./funding.js";

interface Repo {
  status: unknown;
  lender: string;
  borrower: string;
  principal: bigint;
  interest: bigint;
  collateral_asset: string;
  collateral_amount: bigint;
  haircut_bps: number;
  maturity_ts: bigint;
  /** Set when a lender funded a borrow request (offer_id is then 0). */
  request_id?: bigint | null;
}

const REPO_ID = env("REPO_ID");
const USDC = env("USDC_SAC");
const cfg = await view<{ grace_secs: bigint; liquidation_discount_bps: number }>(REPO_ID, "config");
const now = BigInt(Math.floor(Date.now() / 1000));
const fmt = (u: bigint) => (Number(u) / 1e7).toFixed(4);
const label = (asset: string) =>
  asset === process.env.TSAFO_ID ? "tSAFO" : asset === process.env.TBENJI_SAC ? "tBENJI" : asset.slice(0, 6) + "…";
// Collateral in the token's own decimals (tSAFO 5, DECISIONS #28).
const coll = (r: Repo) =>
  r.collateral_asset === process.env.TSAFO_ID
    ? `${(Number(r.collateral_amount) / 1e5).toFixed(4)} tSAFO`
    : `${fmt(r.collateral_amount)} tBENJI`;
const balance = (a: string) => view<bigint>(USDC, "balance", [new Address(a).toScVal()]);
const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString().slice(0, 19) + "Z";

console.log(`repo contract ${REPO_ID}`);
const lenders = new Set<string>();
const live: Exposure[] = [];
for (let id = 1n; ; id++) {
  let r: Repo;
  try {
    r = await view<Repo>(REPO_ID, "repo", [u64(id)]);
  } catch (e) {
    if (e instanceof ContractError && e.code === Err.RepoNotFound) break;
    throw e;
  }
  const status = String(Array.isArray(r.status) ? r.status[0] : r.status);
  const due = r.maturity_ts + cfg.grace_secs;
  const when = now > due ? `past maturity+grace by ${now - due}s` : `defaultable in ${due - now + 1n}s`;
  lenders.add(r.lender);
  if (FLOOR_STATUSES.includes(status)) {
    live.push({ asset: r.collateral_asset, debt: r.principal + r.interest, haircutBps: r.haircut_bps });
  }
  console.log(
    `repo ${String(id).padStart(2)}  ${status.padEnd(10)}  maturity ${iso(r.maturity_ts)} (${when})  ` +
      `lender ${r.lender}  debt ${fmt(r.principal + r.interest)}  coll ${coll(r)}` +
      (r.request_id != null ? `  from request ${r.request_id}` : ""),
  );
}
for (const l of lenders) console.log(`lender     ${l}  USDC ${fmt(await balance(l))}`);
const liq = keypair("LIQUIDATOR").publicKey();
const have = await balance(liq);
const margin = marginFromEnv(process.env.LIQ_FLOOR_MARGIN_BPS);
const floor = liquidatorFloor(live, BigInt(cfg.liquidation_discount_bps), margin);
const parts = [...floor.perAsset].map(([a, f]) => `${label(a)} ${fmt(f.floor)} on ${fmt(f.debt)} open debt`).join(", ");
const short = topUpWhole(have, floor.total);
console.log(
  `liquidator ${liq}  USDC ${fmt(have)}  floor ${fmt(floor.total)}` +
    (parts ? ` (${parts}; +${Number(margin) / 100}% margin)` : " (no live repos)") +
    (short ? `  SHORT by ${fmt(floor.total - have)}: scripts/buy-usdc.sh ${short} ${liq}` : "  OK"),
);
