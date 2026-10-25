// Liquidator funding floor. A liquidation sells the whole collateral at
// NAV × (1 − discount), and a max-LTV take locks collateral worth
// debt / (1 − haircut), so per repo the liquidator fronts up to
//   debt × (1 − discount) / (1 − haircut)
// USDC: 1.0103 × debt for tBENJI (haircut 3%), 1.40 × debt for tSAFO (30%).
// The floor is that sum over every live repo plus a margin for a NAV above
// the take price. Pure: no .env, no RPC.

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Default margin over the floor: 10%, room for the demo slider up to NAV 1.10. */
export const DEFAULT_MARGIN_BPS = 1000n;

/** Debt of one live repo (principal + interest, USDC 7 decimals) and its haircut at take. */
export interface Exposure {
  asset: string;
  debt: bigint;
  haircutBps: bigint | number;
}

export interface Floor {
  /** USDC (7 decimals) the liquidator should hold per collateral asset. */
  perAsset: Map<string, { debt: bigint; floor: bigint }>;
  total: bigint;
}

/** USDC one liquidation of `debt` can cost: debt × (1 − discount) / (1 − haircut) × (1 + margin), rounded up. */
export function proceedsCap(debt: bigint, haircutBps: bigint, discountBps: bigint, marginBps: bigint): bigint {
  if (haircutBps >= BPS) throw new Error(`haircut ${haircutBps} bps >= 100%`);
  return ceilDiv(debt * (BPS - discountBps) * (BPS + marginBps), (BPS - haircutBps) * BPS);
}

/** Liquidator funding floor over `exposures`, per asset and in total. */
export function liquidatorFloor(exposures: Exposure[], discountBps: bigint, marginBps = DEFAULT_MARGIN_BPS): Floor {
  const perAsset = new Map<string, { debt: bigint; floor: bigint }>();
  let total = 0n;
  for (const e of exposures) {
    const f = proceedsCap(e.debt, BigInt(e.haircutBps), discountBps, marginBps);
    const cur = perAsset.get(e.asset) ?? { debt: 0n, floor: 0n };
    perAsset.set(e.asset, { debt: cur.debt + e.debt, floor: cur.floor + f });
    total += f;
  }
  return { perAsset, total };
}

/** Whole USDC to buy so `have` reaches `floor` (0 when funded), +1 for rounding. */
export function topUpWhole(have: bigint, floor: bigint): number {
  return have >= floor ? 0 : Math.ceil(Number(floor - have) / 1e7) + 1;
}

/** Margin from LIQ_FLOOR_MARGIN_BPS (whole bps), else the default. */
export function marginFromEnv(raw: string | undefined): bigint {
  return raw ? BigInt(raw) : DEFAULT_MARGIN_BPS;
}

/** Repos the floor counts: every status that can still end in a liquidation (#32 counts Defaulted). */
export const FLOOR_STATUSES = ["Open", "MarginCall", "Defaulted"];
