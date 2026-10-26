// Units (DECISIONS.md #8, #28): USDC amounts are i128 with 7 decimals;
// collateral amounts use the token's own decimals (tBENJI 7, tSAFO 5); NAV is
// scaled by the oracle's decimals(). All math here is bigint, mirroring
// contracts/repo/src/math.rs rounding (interest and collateral round up).

export const TOKEN_DECIMALS = 7;
export const BPS = 10_000n;
const DAYS_PER_YEAR = 365n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** "1,000.00" style, `dp` decimals, rounded half-up for display only. `decimals` = the token's. */
export function fmtAmount(v: bigint, dp = 2, decimals = TOKEN_DECIMALS): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(Math.max(0, decimals - dp));
  const rounded = (abs + scale / 2n) / scale;
  const s = rounded.toString().padStart(dp + 1, "0");
  const int = s.slice(0, s.length - dp);
  const frac = s.slice(s.length - dp);
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (dp ? "." + frac : "");
}

/** Parses "1,000.50" into units of `decimals` (default 7). Returns null when not a number. */
export function parseAmount(input: string, decimals = TOKEN_DECIMALS): bigint | null {
  const s = input.replace(/[,\s_]/g, "");
  if (!new RegExp(`^\\d+(\\.\\d{0,${decimals}})?$`).test(s)) return null;
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}

/** Horizon balance string ("12.3400000") to units. */
export const horizonToUnits = (b: string) => parseAmount(b) ?? 0n;

/** Feed price scaled by `decimals` → "1.0012" (`dp` places, half-up). Works for any feed scale, including decimals < dp. */
export function fmtNav(price: bigint, decimals: number, dp = 4): string {
  const neg = price < 0n;
  const abs = neg ? -price : price;
  const r = decimals >= dp ? (abs + 10n ** BigInt(decimals - dp) / 2n) / 10n ** BigInt(decimals - dp) : abs * 10n ** BigInt(dp - decimals);
  const s = r.toString().padStart(dp + 1, "0");
  return (neg ? "-" : "") + s.slice(0, s.length - dp) + (dp ? "." + s.slice(s.length - dp) : "");
}

export const fmtPct = (bps: number | bigint, dp = 2) => (Number(bps) / 100).toFixed(dp) + "%";

/** Term in demo days. 1 day = `daySecs` seconds (60 s in the demo profile, #5). */
export function fmtTerm(termSecs: bigint, daySecs: bigint): string {
  const days = Number(termSecs) / Number(daySecs);
  const d = Number.isInteger(days) ? String(days) : days.toFixed(2);
  return `${d} ${days === 1 ? "day" : "days"}`;
}

export function fmtCountdown(secs: number, daySecs: number): string {
  if (secs <= 0) return "00:00";
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  if (daySecs >= 86_400 && secs >= 86_400) {
    const d = Math.floor(secs / 86_400);
    const rest = secs % 86_400;
    return `${d}d ${pad(rest / 3600)}:${pad((rest % 3600) / 60)}:${pad(rest % 60)}`;
  }
  if (secs >= 3600) return `${pad(secs / 3600)}:${pad((secs % 3600) / 60)}:${pad(secs % 60)}`;
  return `${pad(secs / 60)}:${pad(secs % 60)}`;
}

/** One id format for offers and agreements, app and landing: #003. */
export const idRef = (id: bigint | number) => `#${String(id).padStart(3, "0")}`;

/** An amount owed: 4 dp when the interest in it is under 0.01 USDC, so a small loan's interest never rounds away. */
export const fmtOwed = (v: bigint, interestAmt: bigint) => fmtAmount(v, interestAmt < 100_000n ? 4 : 2);

export const short = (s: string, n = 4) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

// --- contract math (math.rs) -------------------------------------------------

export function interest(principal: bigint, aprBps: bigint, termSecs: bigint, daySecs: bigint): bigint {
  return ceilDiv(principal * aprBps * termSecs, BPS * DAYS_PER_YEAR * daySecs);
}

/**
 * NAV scale for collateral math on a token with `tokenDecimals` (oracle.rs
 * `scale_for_token`, DECISIONS.md #28): amount × nav / 10^d is 7-decimal USDC.
 */
export const collateralDecimals = (navDecimals: number, tokenDecimals: number) =>
  navDecimals + tokenDecimals - TOKEN_DECIMALS;

export function requiredCollateral(debt: bigint, nav: bigint, navDecimals: number, haircutBps: bigint): bigint {
  const valueNeeded = ceilDiv(debt * BPS, BPS - haircutBps);
  return ceilDiv(valueNeeded * 10n ** BigInt(navDecimals), nav);
}

export function collateralValue(amount: bigint, nav: bigint, navDecimals: number): bigint {
  return (amount * nav) / 10n ** BigInt(navDecimals);
}

/**
 * Cover vs the margin-call line (DECISIONS.md #14, #26): value × (1 − margin
 * trigger) ÷ debt, in %. 100% is where check_margin fires (math.rs
 * margin_breached); a max-LTV take opens just above it.
 */
export function coverPct(value: bigint, debt: bigint, triggerBps: bigint): number | null {
  if (debt <= 0n) return null;
  return Number((value * (BPS - triggerBps) * 10_000n) / (debt * BPS)) / 100;
}

/**
 * The trigger a live repo is checked at (margin.rs `effective_trigger`, Raven
 * UA-01): the asset's current trigger, clamped below the repo's own
 * snapshotted haircut, so a later haircut + trigger raise never shows a
 * healthy repo as past its line.
 */
export function effectiveTriggerBps(assetTriggerBps: bigint, repoHaircutBps: bigint | number): bigint {
  const haircut = BigInt(repoHaircutBps);
  const cap = haircut > 0n ? haircut - 1n : 0n;
  return assetTriggerBps < cap ? assetTriggerBps : cap;
}

export const protocolFee = (interestAmt: bigint, feeBps: bigint) => (interestAmt * feeBps) / BPS;
