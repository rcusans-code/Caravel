// Generic SEP-40 price feed reader (DECISIONS.md #2). Knows nothing about which
// feed it talks to: the mock oracle and a live Reflector feed go through the
// same calls, so switching feeds is a contract ID + asset in .env.
import { Address, xdr } from "@stellar/stellar-sdk";
import { view } from "./chain.js";

/** SEP-40 `Asset`: `Stellar(Address)` or `Other(Symbol)`. Same XDR in the repo contract, the mock and Reflector. */
export type Asset = { Stellar: string } | { Other: string };

/**
 * Parse an asset from .env: `Stellar:C…` (a token contract) or `Other:USDC`
 * (a ticker). Also accepts the stellar CLI JSON form `{"Other":"USDC"}`.
 */
export function parseAsset(spec: string): Asset {
  const s = spec.trim();
  if (s.startsWith("{")) return JSON.parse(s) as Asset;
  const [kind, value] = s.split(/:(.*)/s);
  if (kind === "Stellar" && value) return { Stellar: value };
  if (kind === "Other" && value) return { Other: value };
  throw new Error(`bad SEP-40 asset "${spec}": use Stellar:<C… address> or Other:<SYMBOL>`);
}

export const assetLabel = (a: Asset) => ("Stellar" in a ? `Stellar(${a.Stellar.slice(0, 6)}…)` : `Other(${a.Other})`);

export function assetToScVal(a: Asset): xdr.ScVal {
  return "Stellar" in a
    ? xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), new Address(a.Stellar).toScVal()])
    : xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(a.Other)]);
}

export interface FeedReading {
  oracle: string;
  asset: Asset;
  base: string;
  decimals: number;
  resolution: number;
  /** Raw `PriceData.price`, scaled by `decimals`. Null if the feed has no price. */
  raw: bigint | null;
  /** `raw / 10^decimals`, for display only (do math on `raw`). */
  price: number | null;
  timestamp: number | null;
}

/** `lastprice(asset)` + `decimals()` (+ `base`, `resolution` for context): the calls the repo contract makes. */
export async function readFeed(oracle: string, asset: Asset): Promise<FeedReading> {
  const [last, decimals, base, resolution] = await Promise.all([
    view<{ price: bigint; timestamp: bigint } | null>(oracle, "lastprice", [assetToScVal(asset)]),
    view<number>(oracle, "decimals"),
    view<unknown>(oracle, "base"),
    view<number>(oracle, "resolution"),
  ]);
  const b = Array.isArray(base) ? base : [];
  return {
    oracle,
    asset,
    base: b[0] === "Other" ? String(b[1]) : JSON.stringify(base),
    decimals: Number(decimals),
    resolution: Number(resolution),
    raw: last ? last.price : null,
    price: last ? Number(last.price) / 10 ** Number(decimals) : null,
    timestamp: last ? Number(last.timestamp) : null,
  };
}
