// Access gates and copy that depend on chain parameters. Pure on purpose
// (type-only imports): app/test/gates.test.ts runs it under plain node --test.
import type { AssetConfig, Balances, Nav } from "./chain";
import type { Token } from "./config";

/** Hackathon access line, appended to every issuer-permission block. */
export const ACCESS_LIMITED =
  "Access is limited to approved team wallets during the hackathon: send your address to the team.";

/** 180 → "3 minutes", 90 → "90 s", 7200 → "2 hours". */
export function fmtDuration(secs: number | bigint): string {
  const s = Math.max(0, Number(secs));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (s >= 3600 && s % 3600 === 0) return plural(s / 3600, "hour");
  if (s >= 60 && s % 60 === 0) return plural(s / 60, "minute");
  return `${s} s`;
}

/**
 * Why this wallet cannot hold `token` as collateral, or null when it can. The
 * gate is per collateral asset: tBENJI needs an issuer-authorized trustline,
 * tSAFO needs the issuer allowlist. Lending needs neither (USDC only).
 */
export function collateralBlock(b: Balances | null, token: Pick<Token, "code" | "kind">): string | null {
  if (!b || !b.exists) return null; // the friendbot / trustline checks say what to do
  if (token.kind === "spiko")
    return b.tsafoAllowed ? null : `Your account is not on the ${token.code} allowlist. The issuer must allowlist it first. ${ACCESS_LIMITED}`;
  if (b.tbenji === null) return `Add the ${token.code} trustline, then the issuer must authorize it. ${ACCESS_LIMITED}`;
  return b.tbenjiAuthorized ? null : `Your account is not authorized to hold ${token.code}. The issuer must authorize it first. ${ACCESS_LIMITED}`;
}

export const USDC_FROZEN =
  "USDC frozen by its issuer: this account cannot send or receive USDC, so lending, borrowing, repaying and claiming are off until the issuer unfreezes it.";

/**
 * USDC trustline present but not authorized (Raven AS-04): Circle froze it. Every
 * write that moves USDC to or from the account (lend, take, repay, claim) would fail
 * with SAC error #11, so the buttons are disabled with this text instead. Null = fine,
 * or no line yet (the trustline prompt covers that).
 */
export function usdcBlock(b: Balances | null): string | null {
  return b?.exists && b.usdc !== null && !b.usdcAuthorized ? USDC_FROZEN : null;
}

/** Contract error 9 (StaleNav), built from each asset's max_nav_age_secs. */
export function staleNavText(ages: { code: string; secs: number | bigint }[]): string {
  const tail = "Wait for the next update (or push one from Admin), then try again.";
  const uniq = [...new Set(ages.map((a) => Number(a.secs)))];
  if (uniq.length === 0) return `NAV is older than this asset's maximum age. ${tail}`;
  if (uniq.length === 1) return `NAV is older than ${fmtDuration(uniq[0])}. ${tail}`;
  const list = ages.map((a) => `${a.code} ${fmtDuration(a.secs)}`).join(", ");
  return `NAV is older than this asset's maximum age (${list}). ${tail}`;
}

// --- NAV state as the contract sees it ------------------------------------------
// Mirrors contracts/repo/src/oracle.rs `fresh_nav` + `check_band` (DECISIONS.md
// #6, #17, #25, #31) so the app never says "Live" for a price the contract
// refuses. `now` must be ledger time (see ledgerNow), not the browser clock.

/** One oracle record, as `prices(asset, n)` returns it (newest first). */
export interface PricePoint {
  price: bigint;
  timestamp: bigint;
}

/** Records `check_band` reads back (oracle.rs NAV_BAND_RECORDS). */
export const NAV_BAND_RECORDS = 20;
/** Future timestamp skew `fresh_nav` still treats as fresh (oracle.rs MAX_FUTURE_SKEW_SECS). */
export const MAX_FUTURE_SKEW_SECS = 60;

/** none: no price (NoPrice) · future: dated ahead of the ledger (NoPrice) · stale: StaleNav · hold: NavOutOfBand · live: the contract accepts it. */
export type NavState = "none" | "future" | "stale" | "hold" | "live";

type BandAsset = Pick<AssetConfig, "max_nav_age_secs" | "max_nav_move_bps" | "nav_floor" | "nav_ceiling">;

export interface Band {
  ok: boolean;
  /** Which rule failed. */
  why: "floor" | "ceiling" | "move" | null;
  /** Largest move against a record in the window, in bps (display only). */
  moveBps: bigint;
}

/**
 * `check_band` for `price` against `history` (newest first, as `prices`
 * returns it). Floor and ceiling are inclusive; every positive record in the
 * window must be within `max_nav_move_bps` (`|p − r| × 10 000 ≤ r × bps`).
 * A contract without the band (#31, `max_nav_move_bps` null) always passes.
 */
export function checkBand(price: bigint, history: PricePoint[] | null, asset: Omit<BandAsset, "max_nav_age_secs">): Band {
  let moveBps = 0n;
  const window = (history ?? []).slice(0, NAV_BAND_RECORDS).filter((r) => r.price > 0n);
  for (const r of window) {
    const diff = price > r.price ? price - r.price : r.price - price;
    const bps = (diff * 10_000n) / r.price;
    if (bps > moveBps) moveBps = bps;
  }
  if (asset.max_nav_move_bps === null) return { ok: true, why: null, moveBps };
  if (asset.nav_floor !== null && price < asset.nav_floor) return { ok: false, why: "floor", moveBps };
  if (asset.nav_ceiling !== null && price > asset.nav_ceiling) return { ok: false, why: "ceiling", moveBps };
  const bps = asset.max_nav_move_bps;
  for (const r of window) {
    const diff = price > r.price ? price - r.price : r.price - price;
    if (diff * 10_000n > r.price * bps) return { ok: false, why: "move", moveBps };
  }
  return { ok: true, why: null, moveBps };
}

export interface NavHealth {
  state: NavState;
  /** Seconds since the NAV's timestamp; null without a price. */
  age: number | null;
  /**
   * Band result on the last price, ignoring staleness: what `top_up` uses to
   * decide whether a margin call clears (#6, #31). null = no price / no asset config.
   */
  band: Band | null;
}

/** NAV state for one collateral asset at ledger time `now` (seconds), checked in `fresh_nav`'s order. */
export function navHealth(nav: Nav | null, history: PricePoint[] | null, asset: BandAsset | null, now: number): NavHealth {
  if (!nav || nav.price <= 0n) return { state: "none", age: null, band: null };
  const age = now - Number(nav.timestamp);
  if (!asset) return { state: "live", age, band: null };
  const band = checkBand(nav.price, history, asset);
  if (Number(nav.timestamp) > now + MAX_FUTURE_SKEW_SECS) return { state: "future", age, band };
  if (age > Number(asset.max_nav_age_secs)) return { state: "stale", age, band };
  return { state: band.ok ? "live" : "hold", age, band };
}

/**
 * Ledger time now, from the latest ledger close time sampled at browser time
 * `at`: close time + browser seconds elapsed since. A skewed browser clock
 * then cannot make a stale NAV look fresh (or the reverse).
 */
export function ledgerNow(browserNow: number, sample: { closeTime: number; at: number } | null): number {
  return sample ? sample.closeTime + Math.max(0, browserNow - sample.at) : browserNow;
}

const fmtBps = (bps: bigint) => `${(Number(bps) / 100).toFixed(1).replace(/\.0$/, "")}%`;

/** The status-bar badge for a NAV state. */
export function navBadge(h: NavHealth): { state: "on" | "stale" | "off"; word: string; meta: string } {
  if (h.state === "none") return { state: "off", word: "No price", meta: "push one from Admin" };
  if (h.state === "stale") return { state: "stale", word: "Delayed", meta: "new loans paused" };
  if (h.state === "hold") return { state: "stale", word: "Price on hold", meta: "outside the NAV band" };
  if (h.state === "future") return { state: "stale", word: "Price on hold", meta: "dated ahead of the ledger" };
  return { state: "on", word: "Live", meta: "fresh NAV" };
}

const PAUSED = "new loans, margin checks and liquidations are paused. Repay and top-up still work.";

/** Why the price is on hold (state hold / future), or null. */
export function navHoldText(code: string, h: NavHealth, asset: Pick<AssetConfig, "max_nav_move_bps"> | null): string | null {
  if (h.state === "future") return `The ${code} price is dated ahead of the ledger clock, so ${PAUSED}`;
  if (h.state !== "hold" || !h.band) return null;
  if (h.band.why === "floor") return `The ${code} NAV is below its floor, so ${PAUSED}`;
  if (h.band.why === "ceiling") return `The ${code} NAV is above its ceiling, so ${PAUSED}`;
  const band = asset?.max_nav_move_bps != null ? ` ${fmtBps(asset.max_nav_move_bps)}` : "";
  return (
    `Price on hold: the ${code} NAV moved ${fmtBps(h.band.moveBps)} against one of its last ${NAV_BAND_RECORDS} prices, ` +
    `more than its${band} sanity band, so ${PAUSED} It clears once the older prices roll out of that window or the band is widened.`
  );
}

/**
 * Why the contract would refuse a NAV-gated call (take_offer, check_margin,
 * liquidate, default on a missed margin call), or null when it would accept it.
 */
export function navBlock(code: string, h: NavHealth, asset: BandAsset | null): string | null {
  if (h.state === "none") return `The oracle has no ${code} price yet.`;
  if (h.state === "stale")
    return `The ${code} price is more than ${asset ? fmtDuration(asset.max_nav_age_secs) : "its maximum age"} old. Wait for the next update (or push one from Admin), then try again.`;
  return navHoldText(code, h, asset);
}

/** Why Take is blocked by the NAV, or null. */
export const takeNavBlock = (code: string, h: NavHealth, asset: BandAsset | null) => navBlock(code, h, asset);

/**
 * For a borrower in MarginCall: why a top-up will not clear the call right
 * now (top_up clears only on a priced, in-band NAV; staleness does not
 * matter, #6, #31), or null when it can.
 */
export function topUpHoldText(code: string, h: NavHealth): string | null {
  if (h.state === "none")
    return `There is no ${code} price, so a top-up is accepted but does not clear the margin call until a price is posted.`;
  if (!h.band || h.band.ok) return null;
  return (
    `The ${code} price is on hold, so a top-up now is accepted but does not clear the margin call. ` +
    `It clears on a top-up once the price is back inside the band. Repay always works.`
  );
}

/** The auto-repay toggle hint on Take: what is approved, until when, and that grace still applies. */
export function autoRepayHint(o: {
  on: boolean;
  /** Formatted debt, e.g. "100.96". */
  debt: string;
  code: string;
  graceSecs: number | bigint;
  /** Formatted liquidation discount, e.g. "2.0%". */
  discount: string;
}): string {
  const grace = fmtDuration(o.graceSecs);
  if (!o.on)
    return `Repay ${o.debt} USDC yourself by maturity (plus ${grace} grace), or your ${o.code} is sold at a ${o.discount} discount.`;
  return (
    `Taking the offer also approves the contract to pull ${o.debt} USDC from this wallet; the approval expires about 1 day after maturity plus grace. ` +
    `At maturity it takes the USDC and gives your ${o.code} back. ` +
    `If the USDC is not there, the ${grace} grace still applies: repay by hand before it ends, or the loan defaults and your ${o.code} is sold at a ${o.discount} discount.`
  );
}
