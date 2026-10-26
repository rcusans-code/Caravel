// Minimal SEP-40 feed reading for the live reference feed (DECISIONS.md #2),
// ported from scripts/keeper/src/sep40.ts. Pure on purpose (no runtime
// imports): app/test/sep40.test.ts runs it under plain node --test. The RPC
// call itself (lastprice + decimals via simulation) is chain.ts getLiveFeed.

/** SEP-40 `Asset`: `Stellar(Address)` or `Other(Symbol)`. */
export type Asset = { Stellar: string } | { Other: string };

/** `Stellar:C…` (a token contract) or `Other:USDC` (a ticker), as in .env LIVE_ORACLE_ASSET. Also the CLI JSON form. */
export function parseAsset(spec: string): Asset {
  const s = spec.trim();
  if (s.startsWith("{")) return JSON.parse(s) as Asset;
  const [kind, value] = s.split(/:(.*)/s);
  if (kind === "Stellar" && value) return { Stellar: value };
  if (kind === "Other" && value) return { Other: value };
  throw new Error(`bad SEP-40 asset "${spec}": use Stellar:<C… address> or Other:<SYMBOL>`);
}

/** Short display name: the ticker, or the first chars of the token contract. */
export const assetLabel = (a: Asset) => ("Stellar" in a ? `${a.Stellar.slice(0, 4)}…` : a.Other);

export interface FeedReading {
  /** Raw `PriceData.price`, scaled by `decimals`. */
  price: bigint;
  decimals: number;
  /** Unix seconds of the feed's last record. */
  timestamp: number;
}

/** `lastprice()` result (`Option<PriceData>`, decoded) + `decimals()` → a reading; null when the feed has no price. */
export function toReading(last: { price: unknown; timestamp: unknown } | null | undefined, decimals: unknown): FeedReading | null {
  if (!last) return null;
  return { price: BigInt(last.price as bigint), decimals: Number(decimals), timestamp: Number(last.timestamp) };
}
