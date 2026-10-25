// Caravel keeper: polls every repo, fires check_margin and default with nobody
// touching anything.
//
//   npm run keeper                   # every 10 s
//   npm run keeper -- --refresh-nav  # also re-post the last NAV every ~120 s
//
// Signs with KEEPER_SECRET from .env (falls back to LIQUIDATOR_SECRET).
// --refresh-nav signs set_price with ADMIN_SECRET (the oracle admin).
// Covers every collateral asset: tBENJI, and tSAFO when TSAFO_ID is set.
import { ContractError, Err, env, invoke, keypair, log, stellarAsset, txLink, u64, view } from "./chain.js";
import { setNav } from "./set-nav.js";

type Status = "Open" | "MarginCall" | "Repaid" | "Defaulted" | "Liquidated";
interface Repo {
  id: bigint;
  status: Status;
  collateral_asset: string;
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
// Collateral tokens the keeper prices and labels (decimals read on-chain at start).
const ASSETS = [
  { label: "tBENJI", id: env("TBENJI_SAC"), decimals: 7 },
  ...(process.env.TSAFO_ID ? [{ label: "tSAFO", id: env("TSAFO_ID"), decimals: 5 }] : []),
];
const assetOf = (id: string) => ASSETS.find((a) => a.id === id) ?? { label: id.slice(0, 6) + "…", id, decimals: 7 };
const signer = process.env.KEEPER_SECRET ? keypair("KEEPER") : keypair("LIQUIDATOR");

const LIVE: Status[] = ["Open", "MarginCall"];
const settled = new Set<bigint>(); // Repaid / Defaulted / Liquidated: never polled again
let lastSeen = new Map<bigint, string>(); // id -> last logged state, to log on change only

const statusOf = (s: unknown): Status => (Array.isArray(s) ? s[0] : s) as Status;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const fmt = (units: bigint, dec = 7) => (Number(units) / 10 ** dec).toFixed(2);

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

async function tick(cfg: { discountBps: bigint; graceSecs: bigint; decimals: number; maxAge: bigint }) {
  const t = now();
  const navs = new Map<string, PriceData | null>();
  for (const a of ASSETS) {
    const last = await view<PriceData | null>(ORACLE_ID, "lastprice", [stellarAsset(a.id)]).catch(() => null);
    navs.set(a.id, last);
    const age = last ? t - last.timestamp : null;
    if (REFRESH_NAV && last && age !== null && age >= BigInt(REFRESH_SECS)) {
      try {
        const { hash } = await setNav(last.price, a.id);
        log(`refresh-nav  re-posted ${a.label} ${fmt(last.price, cfg.decimals)} (was ${age}s old)  ${txLink(hash)}`);
      } catch (e) {
        log(`refresh-nav  ${a.label} FAILED: ${(e as Error).message}`);
      }
    }
  }

  const repos = await liveRepos();
  const next = new Map<bigint, string>();
  for (const r of repos) {
    const asset = assetOf(r.collateral_asset);
    const last = navs.get(r.collateral_asset) ?? null;
    const navAge = last ? t - last.timestamp : null;
    const debt = r.principal + r.interest;
    const deadline = r.margin_call_deadline ?? null;
    const matured = t > r.maturity_ts + cfg.graceSecs;
    const marginMissed = r.status === "MarginCall" && deadline !== null && t > deadline;
    // Value in USDC: amount (token decimals) × NAV (oracle decimals), DECISIONS.md #24.
    const value = last ? (Number(r.collateral_amount) / 10 ** asset.decimals) * (Number(last.price) / 10 ** cfg.decimals) : NaN;
    const ltv = Number(debt) / 1e7 / value;
    const desc = `repo ${r.id} ${r.status} debt ${fmt(debt)} coll ${fmt(r.collateral_amount, asset.decimals)} ${asset.label} ltv ${(ltv * 100).toFixed(2)}%`;

    // 1. default: margin window missed, or past maturity + grace. Needs no NAV.
    if (matured || marginMissed) {
      try {
        const { hash } = await invoke(signer, REPO_ID, "default", [u64(r.id)]);
        log(`DEFAULT      ${desc} (${marginMissed ? "margin window missed" : "matured + grace"})  ${txLink(hash)}`);
        settled.add(r.id);
      } catch (e) {
        // Ledger time lags wall clock by a few seconds: NotDefaultable means "not yet".
        if (e instanceof ContractError && e.code === Err.NotDefaultable) note(next, r.id, "pending", `default      repo ${r.id} not yet defaultable on-chain (ledger clock lag), retrying`);
        else log(`default      repo ${r.id} FAILED: ${(e as Error).message}`);
      }
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

async function main() {
  const config = await view<Record<string, bigint>>(REPO_ID, "config");
  const decimals = await view<number>(ORACLE_ID, "decimals");
  for (const a of ASSETS) a.decimals = await view<number>(a.id, "decimals");
  const cfg = {
    discountBps: BigInt(config.liquidation_discount_bps),
    graceSecs: BigInt(config.grace_secs),
    maxAge: BigInt(config.max_nav_age_secs),
    decimals,
  };
  log(
    `keeper ${signer.publicKey()} repo ${REPO_ID} every ${INTERVAL_MS / 1000}s, assets ${ASSETS.map((a) => a.label).join(", ")}` +
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
