// Collateral reconciliation (Raven AS-02 interim, D5). Every repo's collateral
// sits in one pooled token balance of the repo contract, and repay /
// liquidate push the repo's full `collateral_amount` out of it. If the issuer
// claws back (or burns) part of that balance, the first repos to settle are
// still paid in full and the last one cannot repay or be liquidated. The
// contract keeps no per-asset total (clawback-safe accounting is roadmap R11),
// so the keeper compares, each tick, `balance(REPO_ID)` per collateral token
// with the sum of `collateral_amount` over live repos and ALERTs on a deficit.
//
// A lower bound: collateral parked for a holder whose push was refused
// (`claimable_collateral`) is in the balance but not in any live repo, so it
// shows as surplus, and a clawback smaller than the parked amount is not seen.

export type LiveCollateral = { collateral_asset: string; collateral_amount: bigint };

export type Shortfall = { asset: string; held: bigint; owed: bigint; short: bigint; repos: number };

/** Live collateral owed per asset: sum of `collateral_amount` and repo count. */
export function owedByAsset(repos: LiveCollateral[]): Map<string, { owed: bigint; repos: number }> {
  const out = new Map<string, { owed: bigint; repos: number }>();
  for (const r of repos) {
    const cur = out.get(r.collateral_asset) ?? { owed: 0n, repos: 0 };
    out.set(r.collateral_asset, { owed: cur.owed + r.collateral_amount, repos: cur.repos + 1 });
  }
  return out;
}

/**
 * Assets whose contract balance is below the live collateral owed. A balance
 * of `null` (read failed) or an asset with no live repo is skipped.
 */
export function collateralShortfalls(repos: LiveCollateral[], balances: Map<string, bigint | null>): Shortfall[] {
  const out: Shortfall[] = [];
  for (const [asset, { owed, repos: n }] of owedByAsset(repos)) {
    const held = balances.get(asset);
    if (held === undefined || held === null) continue;
    if (held < owed) out.push({ asset, held, owed, short: owed - held, repos: n });
  }
  return out;
}
