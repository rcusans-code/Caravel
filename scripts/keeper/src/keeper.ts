// Caravel keeper: polls every repo, fires check_margin, default and liquidate
// with nobody touching anything, so a lender is paid even if the borrower
// never repays.
//
//   npm run keeper                   # every 10 s
//   npm run keeper -- --refresh-nav  # also re-post the last NAV every ~120 s
//
// Signs check_margin / default with KEEPER_SECRET from .env (falls back to
// LIQUIDATOR_SECRET); liquidate with LIQUIDATOR_SECRET (whitelisted, pays the
// USDC). --refresh-nav signs set_price with ADMIN_SECRET (the oracle admin).
import { readFileSync } from "node:fs";
import { Address } from "@stellar/stellar-sdk";
import { parse as parseEnv } from "dotenv";
import { ContractError, ENV_FILE, Err, env, invoke, keypair, log, stellarAsset, txLink, u64, view } from "./chain.js";
import { setNav } from "./set-nav.js";

type Status = "Open" | "MarginCall" | "Repaid" | "Defaulted" | "Liquidated";
interface Repo {
  id: bigint;
  lender: string;
  status: Status;
  principal: bigint;
  interest: bigint;
  collateral_amount: bigint;
  maturity_ts: bigint;
  margin_call_deadline?: bigint | null;
}
interface PriceData {
  price: bigint;
  timestamp: bigint;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, dflt: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};

const INTERVAL_MS = opt("--interval", 10) * 1000;
const REFRESH_NAV = flag("--refresh-nav");
const REFRESH_SECS = opt("--refresh-secs", 120);

const REPO_ID = env("REPO_ID");
const ORACLE_ID = env("ORACLE_ID");
const USDC_SAC = env("USDC_SAC");
const TBENJI = stellarAsset(env("TBENJI_SAC"));
const signer = process.env.KEEPER_SECRET ? keypair("KEEPER") : keypair("LIQUIDATOR");
const liquidator = keypair("LIQUIDATOR");

// Defaulted stays live: it still needs `liquidate` before the lender is paid.
const LIVE: Status[] = ["Open", "MarginCall", "Defaulted"];
const settled = new Set<bigint>(); // Repaid / Liquidated only: never polled again
let lastSeen = new Map<bigint, string>(); // id -> last logged state, to log on change only

const statusOf = (s: unknown): Status => (Array.isArray(s) ? s[0] : s) as Status;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const fmt = (units: bigint, dec = 7) => (Number(units) / 10 ** dec).toFixed(2);
const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** REPO_ID as written in the .env file (not process.env), to spot a redeploy. */
const fileRepoId = () => {
  try {
    return parseEnv(readFileSync(ENV_FILE)).REPO_ID ?? null;
  } catch {
    return null;
  }
};
const startRepoId = fileRepoId();

async function readRepo(id: bigint): Promise<Repo | null> {
  try {
    const r = await view<Repo>(REPO_ID, "repo", [u64(id)]);
    return { ...r, status: statusOf(r.status) };
  } catch (e) {
    if (e instanceof ContractError && e.code === Err.RepoNotFound) return null;
    throw e;
  }
}

/** All live repos: re-read known live ids, then probe new ids until not found. */
async function liveRepos(): Promise<Repo[]> {
  const out: Repo[] = [];
  for (let id = 1n; ; id++) {
    if (settled.has(id)) continue;
    const r = await readRepo(id);
    if (!r) break;
    if (LIVE.includes(r.status)) out.push(r);
    else settled.add(id);
  }
  return out;
}

type Cfg = { discountBps: bigint; graceSecs: bigint; decimals: number; maxAge: bigint };

async function tick(cfg: Cfg) {
  const changed = fileRepoId();
  if (startRepoId && changed && changed !== startRepoId) {
    // Redeploy (deploy.sh / seed --reset wrote new IDs): exit and let systemd
    // (Restart=always) start a fresh keeper on the new contracts.
    log(`REPO_ID in ${ENV_FILE} changed ${startRepoId.slice(0, 6)}… -> ${changed.slice(0, 6)}…, exiting to reload`);
    process.exit(0);
  }

  const t = now();
  const last = await view<PriceData | null>(ORACLE_ID, "lastprice", [TBENJI]).catch(() => null);
  const navAge = last ? t - last.timestamp : null;

  if (REFRESH_NAV && last && navAge !== null && navAge >= BigInt(REFRESH_SECS)) {
    try {
      const { hash } = await setNav(last.price);
      log(`refresh-nav  re-posted ${fmt(last.price, cfg.decimals)} (was ${navAge}s old)  ${txLink(hash)}`);
    } catch (e) {
      log(`refresh-nav  FAILED: ${(e as Error).message}`);
    }
  }

  const repos = await liveRepos();
  const next = new Map<bigint, string>();
  const nav = { last, navAge };
  for (const r of repos) {
    const debt = r.principal + r.interest;
    const deadline = r.margin_call_deadline ?? null;
    const matured = t > r.maturity_ts + cfg.graceSecs;
    const marginMissed = r.status === "MarginCall" && deadline !== null && t > deadline;
    const ltv = last ? Number(debt) / ((Number(r.collateral_amount) * Number(last.price)) / 10 ** cfg.decimals) : NaN;
    const desc = `repo ${r.id} ${r.status} debt ${fmt(debt)} coll ${fmt(r.collateral_amount)} ltv ${(ltv * 100).toFixed(2)}%`;

    // 0. Defaulted (by us last tick, or by anyone): liquidate pays the lender.
    if (r.status === "Defaulted") {
      await liquidateRepo(r, cfg, nav, next);
      continue;
    }

    // 1. default: margin window missed, or past maturity + grace. Needs no NAV.
    //    Then liquidate in the same tick.
    if (matured || marginMissed) {
      try {
        const { hash } = await invoke(signer, REPO_ID, "default", [u64(r.id)]);
        log(`DEFAULT      ${desc} (${marginMissed ? "margin window missed" : "matured + grace"})  ${txLink(hash)}`);
      } catch (e) {
        // Ledger time lags wall clock by a few seconds: NotDefaultable means "not yet".
        if (e instanceof ContractError && e.code === Err.NotDefaultable) note(next, r.id, "pending", `default      repo ${r.id} not yet defaultable on-chain (ledger clock lag), retrying`);
        else log(`default      repo ${r.id} FAILED: ${(e as Error).message}`);
        continue;
      }
      await liquidateRepo({ ...r, status: "Defaulted" }, cfg, { last, navAge: last ? now() - last.timestamp : null }, next);
      continue;
    }

    // 2. MarginCall already set: wait for top-up / repay or the deadline.
    if (r.status === "MarginCall") {
      note(next, r.id, "waiting", `waiting      ${desc}, default possible in ${deadline! - t + 1n}s`);
      continue;
    }

    // 3. Open: simulate check_margin; only send a tx when it would breach.
    try {
      const st = statusOf(await view(REPO_ID, "check_margin", [u64(r.id)], signer.publicKey()));
      if (st === "MarginCall") {
        const { hash } = await invoke(signer, REPO_ID, "check_margin", [u64(r.id)]);
        log(`MARGIN CALL  ${desc} (trigger ${(100 - Number(cfg.discountBps) / 100).toFixed(2)}%)  ${txLink(hash)}`);
        next.set(r.id, "called");
      } else {
        note(next, r.id, "healthy", `healthy      ${desc}`);
      }
    } catch (e) {
      if (e instanceof ContractError && e.code === Err.StaleNav) {
        note(next, r.id, "stale", `skip         repo ${r.id} check_margin: StaleNav (NAV ${navAge}s old > ${cfg.maxAge}s)`);
      } else if (e instanceof ContractError && e.code === Err.NotImplemented) {
        // Contract deployed before the margin code: margin calls cannot fire,
        // maturity default + liquidate still do.
        note(next, r.id, "no-margin", `skip         repo ${r.id} check_margin: NotImplemented on the deployed contract (redeploy from main); maturity default still runs`);
      } else {
        log(`check_margin repo ${r.id} FAILED: ${(e as Error).message}`);
      }
    }
  }
  lastSeen = next;
}

/** Record a repo's state; log the line only when the state changed since the last tick. */
function note(next: Map<bigint, string>, id: bigint, state: string, line: string) {
  next.set(id, state);
  if (lastSeen.get(id) !== state) log(line);
}

/**
 * liquidate(LIQUIDATOR, id) on a Defaulted repo: the liquidator pays
 * NAV × (1 − discount) × collateral in USDC, the lender gets principal +
 * interest − fee first. Stale NAV or too little liquidator USDC: one line,
 * retried next tick.
 */
async function liquidateRepo(r: Repo, cfg: Cfg, nav: { last: PriceData | null; navAge: bigint | null }, next: Map<bigint, string>) {
  const { last, navAge } = nav;
  if (!last || navAge === null || navAge > cfg.maxAge) {
    const why = last ? `NAV ${navAge}s old > ${cfg.maxAge}s` : "no NAV";
    return note(next, r.id, "liq-stale", `skip         repo ${r.id} liquidate: ${why}, retrying each tick`);
  }
  // Same rounding as math::liquidation_proceeds (ceil).
  const proceeds = ceilDiv(r.collateral_amount * last.price * (BPS - cfg.discountBps), 10n ** BigInt(cfg.decimals) * BPS);
  const who = liquidator.publicKey();
  const have = await view<bigint>(USDC_SAC, "balance", [new Address(who).toScVal()]);
  if (have < proceeds) {
    return note(
      next,
      r.id,
      "liq-usdc",
      `skip         repo ${r.id} liquidate: liquidator USDC ${fmt(have)} < proceeds ${fmt(proceeds)} (top up: scripts/buy-usdc.sh ${Math.ceil(Number(proceeds - have) / 1e7) + 1} ${who}), retrying each tick`,
    );
  }
  try {
    const { hash } = await invoke(liquidator, REPO_ID, "liquidate", [new Address(who).toScVal(), u64(r.id)]);
    log(`LIQUIDATE    repo ${r.id} Defaulted debt ${fmt(r.principal + r.interest)} coll ${fmt(r.collateral_amount)} proceeds ${fmt(proceeds)} USDC -> lender ${r.lender.slice(0, 6)}…  ${txLink(hash)}`);
    settled.add(r.id);
    next.delete(r.id);
  } catch (e) {
    if (e instanceof ContractError && e.code === Err.StaleNav) note(next, r.id, "liq-stale", `skip         repo ${r.id} liquidate: StaleNav on-chain, retrying each tick`);
    else note(next, r.id, `liq-fail ${(e as Error).message}`, `liquidate    repo ${r.id} FAILED: ${(e as Error).message}, retrying each tick`);
  }
}

async function main() {
  const config = await view<Record<string, bigint>>(REPO_ID, "config");
  const decimals = await view<number>(ORACLE_ID, "decimals");
  const cfg = {
    discountBps: BigInt(config.liquidation_discount_bps),
    graceSecs: BigInt(config.grace_secs),
    maxAge: BigInt(config.max_nav_age_secs),
    decimals,
  };
  const whitelisted = await view<boolean>(REPO_ID, "is_liquidator", [new Address(liquidator.publicKey()).toScVal()]);
  log(
    `keeper ${signer.publicKey()} liquidator ${liquidator.publicKey()}${whitelisted ? "" : " (NOT whitelisted: liquidate will fail)"} repo ${REPO_ID} every ${INTERVAL_MS / 1000}s` +
      (REFRESH_NAV ? `, refresh-nav every ${REFRESH_SECS}s` : "") +
      ` (margin window ${config.margin_window_secs}s, grace ${config.grace_secs}s, max NAV age ${config.max_nav_age_secs}s)`,
  );
  for (;;) {
    try {
      await tick(cfg);
    } catch (e) {
      log(`tick failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
