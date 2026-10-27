// Collateral tokens one market's keeper prices and labels, from its .env.
// The USD market lists tBENJI and tSAFO; the EUR market (DECISIONS #52)
// lists tSAFO only, so its .env leaves TBENJI_SAC empty and nothing on the
// tBENJI paths runs. Pure (no chain calls), so assets.test.ts covers it.

/**
 * `triggerBps`: the asset's margin trigger (DECISIONS.md #26), read from `asset()` at start.
 * `sourceTimed`: the oracle stamps this asset with the source's publication time
 * (`source_timed`, the Spiko feed, spiko-nav.ts); --refresh-nav never re-posts it.
 */
export type Collateral = { label: string; id: string; decimals: number; maxAge: bigint; triggerBps: bigint; sourceTimed?: boolean };

/** tBENJI when TBENJI_SAC is set, tSAFO when TSAFO_ID is set; at least one, else throws. */
export function marketAssets(e: Record<string, string | undefined>): Collateral[] {
  const list: Collateral[] = [];
  if (e.TBENJI_SAC) list.push({ label: "tBENJI", id: e.TBENJI_SAC, decimals: 7, maxAge: 0n, triggerBps: 0n });
  if (e.TSAFO_ID) list.push({ label: "tSAFO", id: e.TSAFO_ID, decimals: 5, maxAge: 0n, triggerBps: 0n });
  if (!list.length) throw new Error("no collateral asset: set TBENJI_SAC and/or TSAFO_ID in the keeper's .env");
  return list;
}
