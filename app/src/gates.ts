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

/** One oracle record, as `prices(asset, n)` returns it (newest first). */
export interface PricePoint {
  price: bigint;
  timestamp: bigint;
}

export type NavState = "none" | "stale" | "live";

export interface NavHealth {
  state: NavState;
  /** Seconds since the NAV's timestamp; null without a price. */
  age: number | null;
}

/** NAV state for one collateral asset at time `now` (seconds). */
export function navHealth(
  nav: Nav | null,
  _history: PricePoint[] | null,
  asset: Pick<AssetConfig, "max_nav_age_secs"> | null,
  now: number,
): NavHealth {
  if (!nav) return { state: "none", age: null };
  const age = now - Number(nav.timestamp);
  return { state: asset && age > Number(asset.max_nav_age_secs) ? "stale" : "live", age };
}

/** The status-bar badge for a NAV state. */
export function navBadge(h: NavHealth): { state: "on" | "stale" | "off"; word: string; meta: string } {
  if (h.state === "none") return { state: "off", word: "No price", meta: "push one from Admin" };
  if (h.state === "stale") return { state: "stale", word: "Delayed", meta: "new loans paused" };
  return { state: "on", word: "Live", meta: "fresh NAV" };
}

/** Why Take is blocked by the NAV, or null. */
export function takeNavBlock(code: string, h: NavHealth, asset: Pick<AssetConfig, "max_nav_age_secs">): string | null {
  if (h.state === "none") return `The oracle has no ${code} price yet.`;
  if (h.state === "stale")
    return `The ${code} price is more than ${fmtDuration(asset.max_nav_age_secs)} old. Wait for the next update (or push one from Admin), then try again.`;
  return null;
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
