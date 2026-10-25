// Units (DECISIONS.md #8): token amounts are i128 with 7 decimals; NAV is
// scaled by the oracle's decimals(). All math here is bigint, mirroring
// contracts/repo/src/math.rs rounding (interest and collateral round up).

export const TOKEN_DECIMALS = 7;
const UNIT = 10n ** 7n;
export const BPS = 10_000n;
const DAYS_PER_YEAR = 365n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** "1,000.00" style, `dp` decimals, rounded half-up for display only. */
export function fmtAmount(v: bigint, dp = 2): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(TOKEN_DECIMALS - dp);
  const rounded = (abs + scale / 2n) / scale;
  const s = rounded.toString().padStart(dp + 1, "0");
  const int = s.slice(0, s.length - dp);
  const frac = s.slice(s.length - dp);
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (dp ? "." + frac : "");
}

/** Parses "1,000.50" into 7-decimal units. Returns null when not a number. */
export function parseAmount(input: string): bigint | null {
  const s = input.replace(/[,\s_]/g, "");
  if (!/^\d+(\.\d{0,7})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return BigInt(i) * UNIT + BigInt(f.padEnd(TOKEN_DECIMALS, "0"));
}

/** Horizon balance string ("12.3400000") to units. */
export const horizonToUnits = (b: string) => parseAmount(b) ?? 0n;

export function fmtNav(price: bigint, decimals: number, dp = 4): string {
  const scale = 10n ** BigInt(decimals - dp);
  const r = (price + scale / 2n) / scale;
  const s = r.toString().padStart(dp + 1, "0");
  return s.slice(0, s.length - dp) + "." + s.slice(s.length - dp);
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

export const short = (s: string, n = 4) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

// --- contract math (math.rs) -------------------------------------------------

export function interest(principal: bigint, aprBps: bigint, termSecs: bigint, daySecs: bigint): bigint {
  return ceilDiv(principal * aprBps * termSecs, BPS * DAYS_PER_YEAR * daySecs);
}

export function requiredCollateral(debt: bigint, nav: bigint, navDecimals: number, haircutBps: bigint): bigint {
  const valueNeeded = ceilDiv(debt * BPS, BPS - haircutBps);
  return ceilDiv(valueNeeded * 10n ** BigInt(navDecimals), nav);
}

export function collateralValue(amount: bigint, nav: bigint, navDecimals: number): bigint {
  return (amount * nav) / 10n ** BigInt(navDecimals);
}

export const protocolFee = (interestAmt: bigint, feeBps: bigint) => (interestAmt * feeBps) / BPS;
