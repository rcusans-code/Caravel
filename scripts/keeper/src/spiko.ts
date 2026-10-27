// Spiko NAV feed logic (DECISIONS #39 draft): read a share class's latest NAV
// and the EUR/USD rate Spiko dated the same day from the Spiko Public API
// (no auth), and decide whether the oracle needs a new source-timed record.
// Pure apart from `fetchSpiko`, which takes the fetch function, so every
// branch is tested with recorded API JSON (spiko.test.ts). The CLI that signs
// and sends is spiko-nav.ts.
//
// What gets posted, once per NAV day, never re-posted:
//   price     = NAV x the EUR/USD rate dated the NAV's day, floored to the
//               oracle's decimals (a USD share class needs no rate)
//   timestamp = the older of the two `updatedAt` publication times, so the
//               repo's staleness rules measure the older input's age
// The rate is the fund's own when it is dated the NAV's day, else another
// Spiko fund's rate dated that day (the SAFO fund published none from 16 to
// 30 Jun 2026, USTBL did), else nothing is posted until one appears.

export const SPIKO_API = "https://public-api.spiko.io/v0";
const DAY_SECS = 86_400;

export interface SpikoNav {
  /** NAV day, `YYYY-MM-DD` (Spiko's `day` at 00:00Z). */
  day: string;
  /** Decimal string, e.g. "1.015785". */
  value: string;
  currency: string;
  /** Publication time, unix seconds. */
  updatedAt: number;
}

export interface SpikoFx {
  day: string;
  base: string;
  quote: string;
  rate: string;
  /** "indicative" or "execution" (Spiko's `kind`). */
  kind: string;
  fundId: string;
  updatedAt: number;
}

export interface SpikoReading {
  symbol: string;
  fundId: string;
  nav: SpikoNav;
  /** Null for a USD share class (no conversion). */
  fx: SpikoFx | null;
  /** True when `fx` came from another Spiko fund (the share class's own fund had no rate dated the NAV day). */
  fxFallback: boolean;
}

/** An oracle record as `lastprice` returns it. */
export interface OnChainRecord {
  price: bigint;
  timestamp: bigint;
}

export class SpikoApiError extends Error {
  constructor(
    public path: string,
    public status: number | null,
    message: string,
  ) {
    super(message);
  }
}

const isoDay = (s: unknown, what: string): string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error(`${what}: bad day ${JSON.stringify(s)}`);
  return s.slice(0, 10);
};

const unixSecs = (s: unknown, what: string): number => {
  const ms = typeof s === "string" ? Date.parse(s) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`${what}: bad timestamp ${JSON.stringify(s)}`);
  return Math.floor(ms / 1000);
};

const DECIMAL = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

const positiveDecimal = (s: unknown, what: string): string => {
  if (typeof s !== "string" || !DECIMAL.test(s.trim())) throw new Error(`${what}: bad decimal ${JSON.stringify(s)}`);
  if (!/[1-9]/.test(s.replace(/[eE].*$/, ""))) throw new Error(`${what}: not positive (${s})`);
  return s.trim();
};

/** `GET /net-asset-values/{symbol}/latest` body -> SpikoNav. Throws on any unexpected shape. */
export function parseNav(json: unknown): SpikoNav {
  const j = json as { day?: unknown; amount?: { value?: unknown; currency?: unknown }; updatedAt?: unknown } | null;
  if (!j || typeof j !== "object" || !j.amount || typeof j.amount !== "object") throw new Error("NAV: unexpected body");
  if (typeof j.amount.currency !== "string" || !/^[A-Z]{3}$/.test(j.amount.currency)) throw new Error("NAV: bad currency");
  return {
    day: isoDay(j.day, "NAV"),
    value: positiveDecimal(j.amount.value, "NAV"),
    currency: j.amount.currency,
    updatedAt: unixSecs(j.updatedAt, "NAV"),
  };
}

/** `GET /exchange-rates/latest` body -> SpikoFx. Throws on any unexpected shape. */
export function parseFx(json: unknown): SpikoFx {
  const j = json as Record<string, unknown> | null;
  if (!j || typeof j !== "object") throw new Error("FX: unexpected body");
  if (typeof j.baseCurrency !== "string" || typeof j.quoteCurrency !== "string") throw new Error("FX: bad currencies");
  if (typeof j.fundId !== "string") throw new Error("FX: no fundId");
  return {
    day: isoDay(j.day, "FX"),
    base: j.baseCurrency,
    quote: j.quoteCurrency,
    rate: positiveDecimal(j.fxRate, "FX"),
    kind: typeof j.kind === "string" ? j.kind : "unknown",
    fundId: j.fundId,
    updatedAt: unixSecs(j.updatedAt, "FX"),
  };
}

/** Exact decimal string (plain or with an exponent) -> {digits, scale}: value = digits / 10^scale. */
function toRational(s: string): { digits: bigint; scale: number } {
  const m = DECIMAL.exec(s.trim());
  if (!m) throw new Error(`bad decimal "${s}"`);
  const frac = m[2] ?? "";
  let scale = frac.length - Number(m[3] ?? 0);
  let digits = BigInt(m[1] + frac);
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { digits, scale };
}

/** NAV (x rate, when given) in oracle units at `decimals`, floored: the lower value, the lender's side. */
export function oraclePrice(nav: string, rate: string | null, decimals: number): bigint {
  const a = toRational(nav);
  const b = rate === null ? { digits: 1n, scale: 0 } : toRational(rate);
  const num = a.digits * b.digits * 10n ** BigInt(decimals);
  return num / 10n ** BigInt(a.scale + b.scale);
}

/** |a - b| in bps of b, floored (b > 0). */
export const moveBps = (a: bigint, b: bigint) => ((a > b ? a - b : b - a) * 10_000n) / b;

export const utcDay = (secs: number | bigint) => BigInt(secs) / BigInt(DAY_SECS);
export const isoAt = (secs: number | bigint) => new Date(Number(secs) * 1000).toISOString().replace(".000Z", "Z");

export type Plan =
  /** Post `set_price_at(asset, price, timestamp)`. */
  | { kind: "post"; price: bigint; timestamp: number; day: string; why: string }
  /** The oracle already holds this NAV day (or a newer one): nothing to send. */
  | { kind: "current"; price: bigint; timestamp: number; day: string; why: string }
  /** Not postable yet (no rate dated the NAV day, a publication time ahead of us): retry next tick. */
  | { kind: "wait"; why: string; price?: bigint; timestamp?: number; day: string }
  /** A jump past `jumpAckBps` from the last record: never posted without a human ack (DECISIONS #37). */
  | { kind: "hold"; price: bigint; timestamp: number; day: string; why: string; bps: bigint };

export interface PlanOpts {
  /** Oracle `decimals()`. */
  decimals: number;
  /** Wall-clock unix seconds (the oracle rejects a timestamp after ledger time). */
  now: number;
  /** Largest move from the last record posted without an ack (NAV_JUMP_ACK_BPS, default 1000). */
  jumpAckBps: bigint;
  /** Exact oracle prices a human acknowledged (NAV_JUMP_ACK). */
  acks: Set<bigint>;
}

/**
 * What to do with Spiko's latest reading given the oracle's newest record.
 * Posts only when Spiko has a NAV day the oracle does not hold yet; never
 * re-posts (DECISIONS #39); never posts a jump past `jumpAckBps` (#37).
 */
export function planPost(r: SpikoReading, last: OnChainRecord | null, o: PlanOpts): Plan {
  const day = r.nav.day;
  let rate: string | null = null;
  let timestamp = r.nav.updatedAt;
  if (r.nav.currency !== "USD") {
    const fx = r.fx;
    if (!fx || fx.base !== r.nav.currency || fx.quote !== "USD") {
      return { kind: "wait", day, why: `no ${r.nav.currency}/USD rate from Spiko` };
    }
    if (fx.day !== day) {
      return { kind: "wait", day, why: `no ${r.nav.currency}/USD rate dated the NAV day ${day} yet (newest rate is dated ${fx.day})` };
    }
    rate = fx.rate;
    timestamp = Math.min(timestamp, fx.updatedAt);
  }
  const price = oraclePrice(r.nav.value, rate, o.decimals);
  if (timestamp > o.now) {
    return { kind: "wait", day, price, timestamp, why: `publication time ${isoAt(timestamp)} is ahead of this clock` };
  }
  if (last && (BigInt(timestamp) <= last.timestamp || utcDay(timestamp) <= utcDay(last.timestamp))) {
    return { kind: "current", day, price, timestamp, why: `oracle already holds ${isoAt(last.timestamp)} (NAV day ${day} or newer)` };
  }
  if (last && last.price > 0n) {
    const bps = moveBps(price, last.price);
    if (bps > o.jumpAckBps && !o.acks.has(price)) {
      return { kind: "hold", day, price, timestamp, bps, why: `${bps} bps from the last record ${last.price} (> ${o.jumpAckBps}); add ${price} to NAV_JUMP_ACK if it is real` };
    }
  }
  return { kind: "post", day, price, timestamp, why: last ? `new NAV day ${day} (oracle holds ${isoAt(last.timestamp)})` : `first record, NAV day ${day}` };
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface SpikoClientOpts {
  api?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const HEADERS = { Accept: "application/json", "User-Agent": "caravel-spiko-nav/1.0 (+https://github.com/rcusans-code/Caravel)" };

async function getJson(path: string, o: SpikoClientOpts): Promise<unknown> {
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  let res;
  try {
    res = await f(`${o.api ?? SPIKO_API}${path}`, { signal: AbortSignal.timeout(o.timeoutMs ?? 10_000), headers: HEADERS });
  } catch (e) {
    throw new SpikoApiError(path, null, `Spiko API ${path}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new SpikoApiError(path, res.status, `Spiko API ${path}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new SpikoApiError(path, res.status, `Spiko API ${path}: bad JSON (${(e as Error).message})`);
  }
}

/** Throws SpikoApiError (with the path) when the body does not parse. */
function parsed<T>(path: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new SpikoApiError(path, 200, `Spiko API ${path}: ${(e as Error).message}`);
  }
}

/**
 * Latest NAV of `symbol` and, for a non-USD class, the rate dated the same
 * day: its own fund's first, else each other Spiko fund's. Any HTTP error,
 * timeout or unexpected body throws SpikoApiError; a missing rate (404) on
 * a fallback fund is skipped.
 */
export async function fetchSpiko(symbol: string, o: SpikoClientOpts = {}): Promise<SpikoReading> {
  const scPath = `/share-classes/${encodeURIComponent(symbol)}`;
  const sc = (await getJson(scPath, o)) as { fundId?: unknown; currency?: unknown; symbol?: unknown };
  const fundId = parsed(scPath, () => {
    if (typeof sc?.fundId !== "string") throw new Error("no fundId");
    return sc.fundId;
  });
  const navPath = `/net-asset-values/${encodeURIComponent(symbol)}/latest`;
  const navJson = await getJson(navPath, o);
  const nav = parsed(navPath, () => parseNav(navJson));
  if (nav.currency === "USD") return { symbol, fundId, nav, fx: null, fxFallback: false };

  const fxPath = (fid: string) => `/exchange-rates/latest?fundId=${fid}&baseCurrency=${nav.currency}&quoteCurrency=USD`;
  const ownPath = fxPath(fundId);
  const ownJson = await getJson(ownPath, o).catch((e: SpikoApiError) => {
    if (e.status === 404) return null;
    throw e;
  });
  const own = ownJson === null ? null : parsed(ownPath, () => parseFx(ownJson));
  if (own && own.day === nav.day) return { symbol, fundId, nav, fx: own, fxFallback: false };

  const funds = (await getJson("/funds/", o)) as Array<{ id?: unknown }>;
  const others = parsed("/funds/", () => {
    if (!Array.isArray(funds)) throw new Error("not a list");
    return funds.map((f) => f?.id).filter((id): id is string => typeof id === "string" && id !== fundId);
  });
  for (const fid of others) {
    const p = fxPath(fid);
    const j = await getJson(p, o).catch((e: SpikoApiError) => {
      if (e.status === 404) return null;
      throw e;
    });
    if (j === null) continue;
    const fx = parsed(p, () => parseFx(j));
    if (fx.day === nav.day) return { symbol, fundId, nav, fx, fxFallback: true };
  }
  return { symbol, fundId, nav, fx: own, fxFallback: false };
}

/** What one feeder tick needs from the outside world (injected, so ticks are testable). */
export interface TickDeps {
  symbol: string;
  read: () => Promise<SpikoReading>;
  lastRecord: () => Promise<OnChainRecord | null>;
  /** Sends set_price_at; returns a tx link or hash for the log. */
  post: (price: bigint, timestamp: number) => Promise<string>;
  log: (line: string) => void;
  /** ALERT `msg`; `key` names the condition so the caller can rate-limit repeats. */
  alert: (key: "stale" | "hold", msg: string) => void;
  opts: PlanOpts;
  dryRun: boolean;
  /** On-chain age past which the feeder ALERTs that the NAV is stale (the asset's max_nav_age_secs). */
  staleAfterSecs: number;
}

export interface TickResult {
  /** "error" = the API or the chain failed: nothing was posted. */
  outcome: Plan["kind"] | "error" | "posted";
  plan?: Plan;
  error?: string;
}

export const fmtPrice = (p: bigint, decimals: number) => {
  const s = p.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
};

/**
 * One feeder tick: read Spiko, read the oracle, plan, then post (or log what
 * would be posted under dry-run). An API or chain error posts nothing and
 * returns `error`; the caller counts consecutive errors and alerts.
 */
export async function feederTick(d: TickDeps): Promise<TickResult> {
  let reading: SpikoReading;
  let last: OnChainRecord | null;
  try {
    [reading, last] = await Promise.all([d.read(), d.lastRecord()]);
  } catch (e) {
    const error = (e as Error).message;
    d.log(`${d.symbol} read FAILED, nothing posted: ${error}`);
    return { outcome: "error", error };
  }
  const plan = planPost(reading, last, d.opts);
  const fx = reading.fx
    ? ` x ${reading.fx.base}/USD ${reading.fx.rate} (${reading.fx.kind}${reading.fxFallback ? `, fund ${reading.fx.fundId.slice(0, 8)}` : ""}, ${isoAt(reading.fx.updatedAt)})`
    : "";
  const src = `Spiko ${d.symbol} NAV ${reading.nav.value} ${reading.nav.currency} day ${reading.nav.day} (${isoAt(reading.nav.updatedAt)})${fx}`;
  const priced = "price" in plan && plan.price !== undefined ? ` -> ${fmtPrice(plan.price, d.opts.decimals)} USD (${plan.price})` : "";
  const at = "timestamp" in plan && plan.timestamp !== undefined ? ` @ ${plan.timestamp} (${isoAt(plan.timestamp)})` : "";
  if (last) {
    const age = BigInt(d.opts.now) - last.timestamp;
    if (age > BigInt(d.staleAfterSecs) && plan.kind !== "post") {
      d.alert("stale", `${d.symbol} NAV on-chain is ${age}s old (> ${d.staleAfterSecs}s): takes, margin calls and liquidations wait on StaleNav; ${plan.why}`);
    }
  }
  switch (plan.kind) {
    case "current":
      d.log(`${src}${priced}${at}: up to date, ${plan.why}`);
      return { outcome: "current", plan };
    case "wait":
      d.log(`${src}${priced}${at}: waiting, ${plan.why}`);
      return { outcome: "wait", plan };
    case "hold":
      d.log(`${src}${priced}${at}: NOT posted, ${plan.why}`);
      d.alert("hold", `${d.symbol} NAV ${fmtPrice(plan.price, d.opts.decimals)} jumped ${plan.bps} bps, not posted: ${plan.why}`);
      return { outcome: "hold", plan };
    case "post":
      if (d.dryRun) {
        d.log(`${src}${priced}${at}: dry-run, would post set_price_at(price ${plan.price}, timestamp ${plan.timestamp}): ${plan.why}`);
        return { outcome: "post", plan };
      }
      try {
        const tx = await d.post(plan.price, plan.timestamp);
        d.log(`${src}${priced}${at}: posted set_price_at, ${plan.why}  ${tx}`);
        return { outcome: "posted", plan };
      } catch (e) {
        const error = (e as Error).message;
        d.log(`${src}${priced}${at}: set_price_at FAILED: ${error}`);
        return { outcome: "error", plan, error };
      }
  }
}
