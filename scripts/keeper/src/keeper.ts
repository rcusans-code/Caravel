// Caravel keeper: polls every repo, fires auto_repay, check_margin, default
// and liquidate with nobody touching anything, so a lender is paid even if
// the borrower never repays, and an opted-in borrower who holds the USDC is
// repaid instead of defaulted.
//
//   npm run keeper                   # every 10 s
//   npm run keeper -- --refresh-nav  # also re-post the last NAV every ~120 s
//   npm run keeper -- --once         # one tick, then exit
//   npm run keeper -- --once --dry-run  # same, simulate only: never sends a tx
//
// Signs check_margin / default with KEEPER_SECRET from .env (falls back to
// LIQUIDATOR_SECRET); liquidate with LIQUIDATOR_SECRET (whitelisted, pays the
// USDC). --refresh-nav signs set_price with ADMIN_SECRET (the oracle admin).
// Covers every collateral asset: tBENJI, and tSAFO when TSAFO_ID is set.
// A NAV that just jumped holds check_margin, missed-margin default and
// liquidate (navguard.ts; NAV_JUMP_* in scripts/README.md).
// A state that blocks a payout (liquidator short of USDC, NAV stale or out of
// band at liquidation, issuer pause, contract or liquidator off the token
// allowlist) fails and sends an ALERT once it lasts > 2 ticks (alert.ts); so
// does an auto_repay / default / check_margin that fails 3 ticks in a row.
import { readFileSync } from "node:fs";
import { Address, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { parse as parseEnv } from "dotenv";
import { alertDue, sendAlert, StuckTracker, stuckFails } from "./alert.js";
import { ContractError, ENV_FILE, Err, env, invoke, keypair, log, outcomeOf, stellarAsset, txLink, u64, view } from "./chain.js";
import { describeHold, navHold, type PriceData } from "./navguard.js";
import { emptyNavState, loadNavState, navStatePath, saveNavState, serializeNavState, type NavState } from "./navstate.js";
import { onceExitCode } from "./once.js";
import { setNav } from "./set-nav.js";

type Status = "Open" | "MarginCall" | "Repaid" | "Defaulted" | "Liquidated";
interface Repo {
  id: bigint;
  lender: string;
  status: Status;
  collateral_asset: string;
  principal: bigint;
  interest: bigint;
  collateral_amount: bigint;
  maturity_ts: bigint;
  margin_call_deadline?: bigint | null;
  auto_repay?: boolean;
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
const ONCE = flag("--once");
const DRY = flag("--dry-run");
// A stuck ALERT repeats every ALERT_REPEAT_SECS (default 30 min) while it lasts.
const ALERT_REPEAT_TICKS = Math.round((Number(process.env.ALERT_REPEAT_SECS || 1800) * 1000) / INTERVAL_MS);

const REPO_ID = env("REPO_ID");
const ORACLE_ID = env("ORACLE_ID");
const USDC_SAC = env("USDC_SAC");
// Collateral tokens the keeper prices and labels (decimals and per-asset NAV
// max age, DECISIONS.md #25, read on-chain at start).
/** `triggerBps`: the asset's margin trigger (DECISIONS.md #26), read from `asset()` at start. */
type Collateral = { label: string; id: string; decimals: number; maxAge: bigint; triggerBps: bigint };
const ASSETS: Collateral[] = [
  { label: "tBENJI", id: env("TBENJI_SAC"), decimals: 7, maxAge: 0n, triggerBps: 0n },
  ...(process.env.TSAFO_ID ? [{ label: "tSAFO", id: env("TSAFO_ID"), decimals: 5, maxAge: 0n, triggerBps: 0n }] : []),
];
const assetOf = (id: string): Collateral =>
  ASSETS.find((a) => a.id === id) ?? { label: id.slice(0, 6) + "…", id, decimals: 7, maxAge: ASSETS[0].maxAge, triggerBps: ASSETS[0].triggerBps };
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

// NAV jump hold (navguard.ts): a price that jumped > NAV_JUMP_BPS from the
// last price that stood holds check_margin, missed-margin default and
// liquidate until it stood NAV_JUMP_HOLD_SECS; > NAV_JUMP_ACK_BPS holds until
// NAV_JUMP_ACK in .env lists the exact price (re-read each tick, no restart).
const NAV_JUMP_BPS = BigInt(process.env.NAV_JUMP_BPS || 200);
const NAV_JUMP_ACK_BPS = BigInt(process.env.NAV_JUMP_ACK_BPS || 1000);
const PRICE_HISTORY = 20; // oracle MAX_HISTORY: ~19 min at 60 s re-posts
// Latch + last released price per asset, persisted (navstate.ts) so a restart
// after nav-keeper re-posted a bad price 20 times still holds it.
const NAV_STATE_FILE = navStatePath(ORACLE_ID);
let navState: NavState = emptyNavState();
let navStateSaved = "";
const navSeen = new Map<string, string>(); // asset id -> last logged guard state

/** NAV_JUMP_ACK from the .env file (falls back to process.env): exact oracle price integers. */
const navAcks = (): Set<bigint> => {
  let raw = process.env.NAV_JUMP_ACK ?? "";
  try {
    raw = parseEnv(readFileSync(ENV_FILE)).NAV_JUMP_ACK ?? raw;
  } catch {
    /* keep process.env */
  }
  const out = new Set<bigint>();
  for (const s of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    try {
      out.add(BigInt(s));
    } catch {
      log(`nav-jump     NAV_JUMP_ACK entry "${s}" is not an integer price, ignored`);
    }
  }
  return out;
};

/** NAV jump state of one asset this tick: why NAV-driven actions are held, or null. */
type Guard = { why: string; kind: string; needsHuman?: boolean } | null;

/** Read prices(asset, 20) and decide the hold; a failed read holds (fail closed). */
async function navGuard(a: Collateral, t: bigint, cfg: Cfg, acks: Set<bigint>): Promise<Guard> {
  let g: Guard = null;
  let state: string;
  try {
    const hist = (await view<PriceData[] | null>(ORACLE_ID, "prices", [stellarAsset(a.id), nativeToScVal(PRICE_HISTORY, { type: "u32" })])) ?? [];
    const trusted = navState.trusted.get(a.id);
    const h = navHold(hist, t, { asset: a.id, jumpBps: NAV_JUMP_BPS, ackBps: NAV_JUMP_ACK_BPS, holdSecs: cfg.holdSecs, acks, trusted }, navState.latch);
    state = `${h.reason} ${h.current}`;
    if (h.hold) {
      const ack = h.needsAck ? `, set NAV_JUMP_ACK=${h.current} in .env to release` : "";
      g = { kind: state, why: describeHold(h, cfg.holdSecs, cfg.decimals) + ack, needsHuman: h.needsAck || h.reason === "future-dated" };
    } else {
      if (h.current !== null) navState.trusted.set(a.id, h.current);
      if (h.reason === "acked" && navSeen.get(a.id) !== state) {
        log(`nav-jump     ${a.label} ${describeHold(h, cfg.holdSecs, cfg.decimals)} released by NAV_JUMP_ACK=${h.current}`);
      }
    }
  } catch (e) {
    state = "read-failed";
    g = { kind: state, why: `prices read FAILED (${(e as Error).message}), holding this tick` };
    if (navSeen.get(a.id) !== state) log(`nav-jump     ${a.label} ${g.why}`);
  }
  navSeen.set(a.id, state);
  return g;
}

/** Write the guard state when it changed (never under --dry-run); a failed write is logged once. */
let navStateWriteFailed = false;
function persistNavState() {
  if (DRY) return;
  const body = serializeNavState(ORACLE_ID, navState);
  if (body === navStateSaved) return;
  try {
    saveNavState(NAV_STATE_FILE, body);
    navStateSaved = body;
    navStateWriteFailed = false;
  } catch (e) {
    if (!navStateWriteFailed) log(`nav-jump     state write to ${NAV_STATE_FILE} FAILED (${(e as Error).message}): a restart would forget the latch`);
    navStateWriteFailed = true;
  }
}

/** --dry-run: the tx the keeper would have sent, not sent. */
class DryRun extends Error {}

/** invoke(), or under --dry-run a log line and a DryRun throw (callers skip on it). */
const send: typeof invoke = DRY
  ? async (_signer, _contract, method, a = []) => {
      log(`dry-run      would send ${method}(${a.length ? "repo " + String(scValToNative(a[a.length - 1])) : ""})`);
      throw new DryRun(method);
    }
  : invoke;

/** Consecutive ticks per repo / issuer check in a stuck state. */
const tracker = new StuckTracker();
/** ALERT_CMD runs still going; --once waits for them before exiting. */
const pendingAlerts: Promise<void>[] = [];

/**
 * A state that blocks a payout. Logs `line` on the first tick (repos log
 * through `note` instead and pass none); after more than 2 ticks in a row, or
 * at once with --once, counts a failure and sends `alert` (journal ALERT line
 * + ALERT_CMD), repeated every ALERT_REPEAT_SECS.
 */
function stuck(key: string, state: string, alert: string, line?: string) {
  const ticks = tracker.see(key, state);
  if (ticks === 1 && line) log(line);
  if (stuckFails(ticks, ONCE)) failures++;
  if (alertDue(ticks, ONCE, ALERT_REPEAT_TICKS)) {
    const msg = `${alert} (${ONCE ? "keeper --once" : `stuck ${ticks} ticks, ~${Math.round((ticks * INTERVAL_MS) / 1000)}s`})`;
    log(`ALERT        ${msg}`);
    pendingAlerts.push(sendAlert(`caravel-keeper ${REPO_ID.slice(0, 6)}…: ${msg}`, log));
  }
}

/** Log a held action once per state change and skip it. */
function held(next: Map<bigint, string>, r: Repo, action: string, g: NonNullable<Guard>) {
  note(next, r.id, `hold ${action} ${g.kind}`, `hold         repo ${r.id} ${action}: ${g.why}`);
}

/**
 * Issuer-side blocks the contract cannot prevent (CMP-02/03/04, #24): the
 * token paused (tSAFO `paused()`), the repo contract or the liquidator off
 * the token's allowlist (tSAFO `is_whitelisted`, tBENJI `authorized`). Each
 * is a stuck state: logged once, ALERT after 2 ticks, with the runbook to run
 * (scripts/README.md "Issuer pause or de-allowlist"). A failed read is skipped.
 */
async function issuerWatch() {
  const repoAddr = new Address(REPO_ID).toScVal();
  const liqAddr = new Address(liquidator.publicKey()).toScVal();
  for (const a of ASSETS) {
    const spiko = a.id === process.env.TSAFO_ID;
    const holderOk = (who: ReturnType<Address["toScVal"]>) =>
      view<boolean>(a.id, spiko ? "is_whitelisted" : "authorized", [who]).catch(() => null);
    const [paused, repoOk, liqOk, pause] = await Promise.all([
      spiko ? view<boolean>(a.id, "paused").catch(() => null) : Promise.resolve(false),
      holderOk(repoAddr),
      holderOk(liqAddr),
      view<{ no_seize: boolean }>(REPO_ID, "pause", [new Address(a.id).toScVal()]).catch(() => null),
    ]);
    const runbook = `guardian: guardian_set_pause ${a.label} {no_new_repos,no_seize} + guardian_set_asset enabled:false (scripts/README.md "Issuer pause or de-allowlist")`;
    if (paused && !pause?.no_seize) {
      const why = `issuer paused ${a.label}: top_up / repay fail, defaults would seize at the discount; ${runbook}`;
      stuck(`issuer:${a.label}:paused`, "paused", why, `issuer       ${why}`);
    }
    if (repoOk === false) {
      const why = `repo contract is off the ${a.label} ${spiko ? "allowlist" : "authorization"}: repay / top_up / liquidate fail; ${runbook}`;
      stuck(`issuer:${a.label}:repo`, "off", why, `issuer       ${why}`);
    }
    if (liqOk === false) {
      const why = `liquidator ${liquidator.publicKey().slice(0, 6)}… is off the ${a.label} ${spiko ? "allowlist" : "authorization"}: ${a.label} liquidations fail (scripts/README.md "Liquidator checklist")`;
      stuck(`issuer:${a.label}:liquidator`, "off", why, `issuer       ${why}`);
    }
  }
}

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

type Cfg = { discountBps: bigint; graceSecs: bigint; decimals: number; holdSecs: bigint };

async function tick(cfg: Cfg) {
  const changed = fileRepoId();
  if (startRepoId && changed && changed !== startRepoId) {
    // Redeploy (deploy.sh / seed --reset wrote new IDs): exit and let systemd
    // (Restart=always) start a fresh keeper on the new contracts.
    log(`REPO_ID in ${ENV_FILE} changed ${startRepoId.slice(0, 6)}… -> ${changed.slice(0, 6)}…, exiting to reload`);
    process.exit(0);
  }

  const t = now();
  // NAV jump hold per asset, read once per tick (before refresh-nav: a price
  // that needs a human is not re-stamped as fresh).
  const acks = navAcks();
  const guards = new Map<string, Guard>();
  for (const a of ASSETS) guards.set(a.id, await navGuard(a, t, cfg, acks));
  persistNavState();

  const navs = new Map<string, PriceData | null>();
  for (const a of ASSETS) {
    const last = await view<PriceData | null>(ORACLE_ID, "lastprice", [stellarAsset(a.id)]).catch(() => null);
    navs.set(a.id, last);
    const age = last ? t - last.timestamp : null;
    const due = REFRESH_NAV && last && age !== null && age >= BigInt(REFRESH_SECS);
    const g = guards.get(a.id);
    if (due && g?.needsHuman) {
      // Re-posting would launder it: 20 re-posts fill the contract's band
      // window and the pre-jump price leaves the history (keeper-launder).
      const why = `refresh-nav  ${a.label} not re-posted: ${g.why}`;
      stuck(`refresh:${a.id}`, g.kind, why, why);
    } else if (due && DRY) {
      log(`dry-run      would re-post ${a.label} ${fmt(last.price, cfg.decimals)} (was ${age}s old)`);
    } else if (due) {
      try {
        const { hash } = await setNav(last.price, a.id);
        log(`refresh-nav  re-posted ${a.label} ${fmt(last.price, cfg.decimals)} (was ${age}s old)  ${txLink(hash)}`);
      } catch (e) {
        fail(`refresh-nav  ${a.label} FAILED: ${(e as Error).message}`);
      }
    }
  }

  await issuerWatch();

  const repos = await liveRepos();
  const next = new Map<bigint, string>();
  for (const r of repos) {
    const asset = assetOf(r.collateral_asset);
    const last = navs.get(r.collateral_asset) ?? null;
    const navAge = last ? t - last.timestamp : null;
    // An asset the keeper does not price (not in ASSETS) is held: fail closed.
    const guard: Guard = guards.has(r.collateral_asset)
      ? guards.get(r.collateral_asset)!
      : { kind: "unknown-asset", why: `collateral ${asset.label} is not a keeper asset, NAV jump unchecked` };
    const nav = { last, navAge, guard };
    const debt = r.principal + r.interest;
    const deadline = r.margin_call_deadline ?? null;
    const matured = t > r.maturity_ts + cfg.graceSecs;
    const marginMissed = r.status === "MarginCall" && deadline !== null && t > deadline;
    // Value in USDC: amount (token decimals) × NAV (oracle decimals), DECISIONS.md #28.
    const value = last ? (Number(r.collateral_amount) / 10 ** asset.decimals) * (Number(last.price) / 10 ** cfg.decimals) : NaN;
    const ltv = Number(debt) / 1e7 / value;
    const desc = `repo ${r.id} ${r.status} debt ${fmt(debt)} coll ${fmt(r.collateral_amount, asset.decimals)} ${asset.label} ltv ${(ltv * 100).toFixed(2)}%`;

    // 0. Defaulted (by us last tick, or by anyone): liquidate pays the lender.
    if (r.status === "Defaulted") {
      await liquidateRepo(r, asset, cfg, nav, next);
      continue;
    }

    // 1. auto-repay (DECISIONS.md #27): opted in and at maturity. A failed
    //    pull leaves the repo live; the borrower can still repay by hand and
    //    `default` below tries once more. A missed margin call goes straight
    //    to `default`, which first clears it if the NAV has recovered (#20)
    //    and only then tries auto-repay itself.
    if (r.auto_repay && !matured && !marginMissed && t >= r.maturity_ts) {
      try {
        const { hash } = await send(signer, REPO_ID, "auto_repay", [u64(r.id)]);
        log(`AUTO-REPAID  ${desc}  ${txLink(hash)}`);
        settled.add(r.id);
        continue;
      } catch (e) {
        if (e instanceof DryRun) continue;
        const out = e instanceof ContractError ? outcomeOf(e.code) : "fail";
        if (out === "short") {
          note(next, r.id, "short", `auto-repay   ${desc}: borrower USDC or allowance short of the debt, waiting for grace`);
          continue;
        } else if (out === "pending") {
          // NotDue: ledger time lags the wall clock by a few seconds.
          note(next, r.id, "pending", `auto-repay   repo ${r.id} not yet due on-chain (ledger clock lag), retrying`);
          continue;
        } else actionFailed(r.id, "auto_repay", e as Error, "lender unpaid until it repays or default runs");
      }
    }

    // 2. default: margin window missed, or past maturity + grace. A maturity
    //    default needs no NAV. On a missed margin call the contract re-checks
    //    the breach at a fresh NAV and returns Open when the loan recovered
    //    (#20): the call is cleared, nothing to liquidate.
    //    An opted-in repo that can pay settles as Repaid here instead;
    //    otherwise liquidate in the same tick. A missed margin call is held
    //    on a NAV jump, so a call from a bad price can still be topped up
    //    after the correction; a maturity default is not (liquidate is).
    if (marginMissed && !matured && guard) {
      held(next, r, "default", guard);
      continue;
    }
    if (matured || marginMissed) {
      try {
        const { hash, result } = await send(signer, REPO_ID, "default", [u64(r.id)]);
        const st = statusOf(result);
        if (st === "Open") {
          log(`CLEARED      ${desc} (margin call cleared at default: fresh NAV back above the trigger, #20)  ${txLink(hash)}`);
          next.set(r.id, "cleared");
          continue;
        }
        if (st === "Repaid") {
          log(`AUTO-REPAID  ${desc} (at default, ${marginMissed ? "margin window missed" : "matured + grace"})  ${txLink(hash)}`);
          settled.add(r.id);
          continue;
        }
        log(`DEFAULT      ${desc} (${marginMissed ? "margin window missed" : "matured + grace"})  ${txLink(hash)}`);
      } catch (e) {
        if (e instanceof DryRun) continue;
        // Ledger time lags wall clock by a few seconds: NotDefaultable means "not yet".
        const out = e instanceof ContractError ? outcomeOf(e.code) : "fail";
        if (out === "pending") note(next, r.id, "pending", `default      repo ${r.id} not yet defaultable on-chain (ledger clock lag), retrying`);
        else if (out === "paused") note(next, r.id, "paused-default", `skip         repo ${r.id} default: asset paused (no_seize), skipping until cleared`);
        // A missed-call default re-checks the NAV (#20): stale or out of band waits for a good price.
        else if (out === "stale") note(next, r.id, "stale-default", `skip         repo ${r.id} default: StaleNav (NAV ${navAge}s old > ${asset.maxAge}s), retrying`);
        else if (out === "out-of-band") note(next, r.id, "band-default", `skip         repo ${r.id} default: NavOutOfBand (NAV outside the ${asset.label} sanity band, #31), retrying`);
        // A missed margin call defaults only on a fresh, in-band NAV that confirms the breach (A4).
        else if (e instanceof ContractError && e.code === Err.NoPrice) note(next, r.id, "pending", `default      repo ${r.id} missed margin call waits for a fresh NAV (NoPrice), retrying`);
        else actionFailed(r.id, "default", e as Error, "lender unpaid");
        continue;
      }
      await liquidateRepo({ ...r, status: "Defaulted" }, asset, cfg, { last, navAge: last ? now() - last.timestamp : null, guard }, next);
      continue;
    }

    // 3. MarginCall already set: wait for top-up / repay or the deadline.
    if (r.status === "MarginCall") {
      note(next, r.id, "waiting", `waiting      ${desc}, default possible in ${deadline! - t + 1n}s`);
      continue;
    }

    // 4. Open: simulate check_margin; only send a tx when it would breach,
    //    and not while the NAV just jumped (fix #3).
    try {
      const st = statusOf(await view(REPO_ID, "check_margin", [u64(r.id)], signer.publicKey()));
      if (st === "MarginCall" && guard) {
        held(next, r, "check_margin", guard);
      } else if (st === "MarginCall") {
        const { hash } = await send(signer, REPO_ID, "check_margin", [u64(r.id)]);
        log(`MARGIN CALL  ${desc} (trigger ${(100 - Number(asset.triggerBps) / 100).toFixed(2)}%)  ${txLink(hash)}`);
        next.set(r.id, "called");
      } else {
        note(next, r.id, "healthy", `healthy      ${desc}`);
      }
    } catch (e) {
      const out = e instanceof ContractError ? outcomeOf(e.code) : "fail";
      if (e instanceof DryRun) {
        next.set(r.id, "dry-run");
      } else if (out === "stale") {
        note(next, r.id, "stale", `skip         repo ${r.id} check_margin: StaleNav (NAV ${navAge}s old > ${asset.maxAge}s)`);
      } else if (out === "out-of-band") {
        note(next, r.id, "out-of-band", `skip         repo ${r.id} check_margin: NavOutOfBand (NAV outside the ${asset.label} sanity band, #31)`);
      } else if (out === "no-margin") {
        // Contract deployed before the margin code: margin calls cannot fire,
        // maturity default + liquidate still do.
        note(next, r.id, "no-margin", `skip         repo ${r.id} check_margin: NotImplemented on the deployed contract (redeploy from main); maturity default still runs`);
      } else {
        actionFailed(r.id, "check_margin", e as Error, "margin call not raised");
      }
    }
  }
  lastSeen = next;
}

/** Failed actions (tx or simulation errors) caught inside the current tick; --once exits 1 if any. */
let failures = 0;

/** Log a failed action and count it for the --once exit code. */
function fail(line: string) {
  failures++;
  log(line);
}

/**
 * A repo action (auto_repay, default, check_margin) failed with a real error:
 * log it like any failure, and track it as a stuck state so a failure that
 * repeats every tick ALERTs after STUCK_TICKS ticks (a one-tick race, e.g. an
 * InvalidStatus after someone else defaulted the repo, never does). The state
 * is the constant "fail", never the message: the tx hash differs each tick.
 * Daemon mode only: under --once the fail() line and the exit code report it.
 */
function actionFailed(id: bigint, action: string, err: Error, impact: string) {
  fail(`${action.padEnd(12)} repo ${id} FAILED: ${err.message}`);
  if (!ONCE) stuck(`repo:${id}:${action}`, "fail", `${action} repo ${id} failing every tick: ${err.message}; ${impact}`);
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
async function liquidateRepo(
  r: Repo,
  asset: Collateral,
  cfg: Cfg,
  nav: { last: PriceData | null; navAge: bigint | null; guard: Guard },
  next: Map<bigint, string>,
) {
  const { last, navAge, guard } = nav;
  if (guard) return held(next, r, "liquidate", guard); // fix #2
  if (!last || navAge === null || navAge > asset.maxAge) {
    const why = last ? `NAV ${navAge}s old > ${asset.maxAge}s` : "no NAV";
    note(next, r.id, "liq-stale", `skip         repo ${r.id} liquidate: ${why}, retrying each tick`);
    return stuck(`repo:${r.id}`, "liq-stale", `repo ${r.id} Defaulted, liquidate blocked: ${asset.label} ${why} (check caravel-nav-keeper)`);
  }
  // Same rounding as math::liquidation_proceeds (ceil), with the token's
  // decimals folded into the NAV scale like oracle::scale_for_token (#28).
  const scale = 10n ** BigInt(cfg.decimals + asset.decimals - 7);
  const proceeds = ceilDiv(r.collateral_amount * last.price * (BPS - cfg.discountBps), scale * BPS);
  const who = liquidator.publicKey();
  const have = await view<bigint>(USDC_SAC, "balance", [new Address(who).toScVal()]);
  if (have < proceeds) {
    const topUp = `scripts/buy-usdc.sh ${Math.ceil(Number(proceeds - have) / 1e7) + 1} ${who}`;
    note(next, r.id, "liq-usdc", `skip         repo ${r.id} liquidate: liquidator USDC ${fmt(have)} < proceeds ${fmt(proceeds)} (top up: ${topUp}), retrying each tick`);
    return stuck(`repo:${r.id}`, "liq-usdc", `repo ${r.id} Defaulted, liquidator USDC ${fmt(have)} < proceeds ${fmt(proceeds)}: lender unpaid; top up: ${topUp}`);
  }
  try {
    const { hash } = await send(liquidator, REPO_ID, "liquidate", [new Address(who).toScVal(), u64(r.id)]);
    log(`LIQUIDATE    repo ${r.id} Defaulted debt ${fmt(r.principal + r.interest)} coll ${fmt(r.collateral_amount, asset.decimals)} ${asset.label} proceeds ${fmt(proceeds)} USDC -> lender ${r.lender.slice(0, 6)}…  ${txLink(hash)}`);
    settled.add(r.id);
    next.delete(r.id);
  } catch (e) {
    if (e instanceof DryRun) return;
    const out = e instanceof ContractError ? outcomeOf(e.code) : "fail";
    if (out === "stale") {
      note(next, r.id, "liq-stale", `skip         repo ${r.id} liquidate: StaleNav on-chain, retrying each tick`);
      stuck(`repo:${r.id}`, "liq-stale", `repo ${r.id} Defaulted, liquidate blocked: StaleNav on-chain (check caravel-nav-keeper)`);
    } else if (out === "out-of-band") {
      note(next, r.id, "liq-band", `skip         repo ${r.id} liquidate: NavOutOfBand on-chain (#31), retrying each tick`);
      stuck(`repo:${r.id}`, "liq-band", `repo ${r.id} Defaulted, liquidate blocked: ${asset.label} NAV outside the sanity band (#31); check the oracle price`);
    } else if (out === "paused") {
      note(next, r.id, "paused-liquidate", `skip         repo ${r.id} liquidate: asset paused (no_seize), skipping until cleared`);
    } else {
      note(next, r.id, `liq-fail ${(e as Error).message}`, `liquidate    repo ${r.id} FAILED: ${(e as Error).message}, retrying each tick`);
      failures++;
    }
  }
}

async function main() {
  const config = await view<Record<string, bigint>>(REPO_ID, "config");
  const decimals = await view<number>(ORACLE_ID, "decimals");
  for (const a of ASSETS) {
    a.decimals = await view<number>(a.id, "decimals");
    // NAV staleness is per asset (DECISIONS.md #25); a contract deployed before
    // #25 still carries it in config().
    // An asset the contract does not know yet (tSAFO before the redeploy) reads null.
    const ac = await view<Record<string, bigint> | null>(REPO_ID, "asset", [new Address(a.id).toScVal()]).catch(() => null);
    a.maxAge = BigInt(ac?.max_nav_age_secs ?? config.max_nav_age_secs ?? 0n);
    // A contract deployed before #26 triggers on the liquidation discount.
    a.triggerBps = BigInt(ac?.margin_trigger_bps ?? config.liquidation_discount_bps);
  }
  const cfg = {
    discountBps: BigInt(config.liquidation_discount_bps),
    graceSecs: BigInt(config.grace_secs),
    decimals,
    // A jumped price must outlast a margin window plus a minute before it can
    // margin-call, default or liquidate (180 s on the demo).
    holdSecs: BigInt(process.env.NAV_JUMP_HOLD_SECS || BigInt(config.margin_window_secs ?? 120n) + 60n),
  };
  const whitelisted = await view<boolean>(REPO_ID, "is_liquidator", [new Address(liquidator.publicKey()).toScVal()]);
  const loaded = loadNavState(NAV_STATE_FILE, ORACLE_ID);
  navState = loaded.state;
  navStateSaved = loaded.error ? "" : serializeNavState(ORACLE_ID, navState);
  if (loaded.error) {
    const msg = `nav-jump state unreadable (${loaded.error}), starting with no latch: a bad NAV re-posted 20 times while the keeper was down is not held`;
    log(`ALERT        ${msg}`);
    pendingAlerts.push(sendAlert(`caravel-keeper ${REPO_ID.slice(0, 6)}…: ${msg}`, log));
  }
  const latched = [...navState.latch.keys()].map((id) => assetOf(id).label);
  log(
    `keeper ${signer.publicKey()} liquidator ${liquidator.publicKey()}${whitelisted ? "" : " (NOT whitelisted: liquidate will fail)"} repo ${REPO_ID} env ${ENV_FILE} ${ONCE ? "once" : `every ${INTERVAL_MS / 1000}s`}${DRY ? " DRY-RUN (no tx sent)" : ""}, assets ${ASSETS.map((a) => a.label).join(", ")}` +
      (REFRESH_NAV ? `, refresh-nav every ${REFRESH_SECS}s` : "") +
      ` (margin window ${config.margin_window_secs}s, grace ${config.grace_secs}s, max NAV age ${ASSETS.map((a) => `${a.label} ${a.maxAge}s`).join(", ")}, margin trigger ${ASSETS.map((a) => `${a.label} ${a.triggerBps}bps`).join(", ")})` +
      `, nav-jump hold ${NAV_JUMP_BPS}bps/${cfg.holdSecs}s, ack >${NAV_JUMP_ACK_BPS}bps` +
      `, nav state ${NAV_STATE_FILE}${latched.length ? ` (latched: ${latched.join(", ")})` : ""}` +
      `, alerts ${process.env.ALERT_CMD ? `via ${process.env.ALERT_CMD}` : "journal only (no ALERT_CMD)"}`,
  );
  for (;;) {
    let failed = false;
    failures = 0;
    try {
      await tick(cfg);
      tracker.end();
    } catch (e) {
      failed = true;
      tracker.skipTick(); // a failed read is not a recovery: keep the stuck counts
      log(`tick failed: ${(e as Error).message}`);
    }
    if (ONCE) {
      await Promise.all(pendingAlerts);
      process.exit(onceExitCode(failed, failures));
    }
    pendingAlerts.length = 0;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
