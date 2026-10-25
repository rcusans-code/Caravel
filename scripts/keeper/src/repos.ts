// List every repo on the deployed contract: status, maturity, lender, debt,
// plus each lender's and the liquidator's USDC balance.
//
//   npm run repos
import { Address } from "@stellar/stellar-sdk";
import { ContractError, Err, env, keypair, u64, view } from "./chain.js";

interface Repo {
  status: unknown;
  lender: string;
  borrower: string;
  principal: bigint;
  interest: bigint;
  collateral_asset: string;
  collateral_amount: bigint;
  maturity_ts: bigint;
}

const REPO_ID = env("REPO_ID");
const USDC = env("USDC_SAC");
const cfg = await view<{ grace_secs: bigint }>(REPO_ID, "config");
const now = BigInt(Math.floor(Date.now() / 1000));
const fmt = (u: bigint) => (Number(u) / 1e7).toFixed(4);
// Collateral in the token's own decimals (tSAFO 5, DECISIONS #27).
const coll = (r: Repo) =>
  r.collateral_asset === process.env.TSAFO_ID
    ? `${(Number(r.collateral_amount) / 1e5).toFixed(4)} tSAFO`
    : `${fmt(r.collateral_amount)} tBENJI`;
const usdc = async (a: string) => fmt(await view<bigint>(USDC, "balance", [new Address(a).toScVal()]));
const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString().slice(0, 19) + "Z";

console.log(`repo contract ${REPO_ID}`);
const lenders = new Set<string>();
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
  console.log(
    `repo ${String(id).padStart(2)}  ${status.padEnd(10)}  maturity ${iso(r.maturity_ts)} (${when})  ` +
      `lender ${r.lender}  debt ${fmt(r.principal + r.interest)}  coll ${coll(r)}`,
  );
}
for (const l of lenders) console.log(`lender     ${l}  USDC ${await usdc(l)}`);
const liq = keypair("LIQUIDATOR").publicKey();
console.log(`liquidator ${liq}  USDC ${await usdc(liq)}`);
