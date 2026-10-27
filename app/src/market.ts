// Which loan market the app shows: the USDC market (deployments/testnet.json) or
// the EURC market (deployments/testnet-eur.json, DECISIONS #52), picked once per
// page load from `?market=eur`. Switching reloads the page, so every config.ts
// constant stays a constant. Pure on purpose (no config.ts import):
// app/test/market.test.ts runs it under plain `node --test`.

export type MarketId = "usd" | "eur";
export type Quote = "USD" | "EUR";

/** The fields of a deployments/*.json file the app reads (scripts/deploy.sh writes both). */
export interface Deployment {
  network: string;
  rpcUrl?: string;
  horizonUrl?: string;
  deployedAt: string;
  /** EUR market only: the loan token's symbol, quote and issuer. */
  loan?: { symbol?: string; quote?: string; decimals?: number; issuer?: string };
  /** `usdc` is the loan token's SAC in either market (tEURC in the EUR market). */
  contracts: { repo: string; oracle: string; usdc: string; tbenji?: string; tsafo?: string };
  /** `usdc` is the loan token as CODE:ISSUER (tEURC:G… in the EUR market); no tbenji in the EUR market. */
  assets: { usdc: string; tbenji?: string };
  accounts: Record<string, string>;
  tsafo?: { symbol?: string; decimals?: number };
  oracle: { base: { Other?: string; Stellar?: string }; decimals: number; resolution?: number };
}

/** `eur` only for `?market=eur` when the build carries the EUR deployment; anything else is the USDC market. */
export function pickMarket(search: string, eurAvailable: boolean): MarketId {
  return eurAvailable && new URLSearchParams(search).get("market") === "eur" ? "eur" : "usd";
}

/** The switch link: same page, the other market, the current tab hash kept. */
export function marketHref(id: MarketId, hash: string): string {
  return `?market=${id}${hash}`;
}

/** The loan token (code, issuer, SAC) of a deployment. */
export function loanToken(dep: Deployment): { code: string; issuer: string; sac: string; decimals: number } {
  const [code, issuer] = dep.assets.usdc.split(":");
  return { code, issuer, sac: dep.contracts.usdc, decimals: dep.loan?.decimals ?? 7 };
}

/** The currency the oracle quotes NAV in, which is the loan currency (the contract checks they match). */
export function quoteOf(dep: Deployment): Quote {
  const base = dep.oracle.base.Other;
  if (base === "USD" || base === "EUR") return base;
  throw new Error(`deployment oracle base ${JSON.stringify(dep.oracle.base)}: expected Other USD or EUR`);
}

/** The symbol shown before a NAV or a collateral value. */
export const quoteSign = (q: Quote): string => (q === "EUR" ? "€" : "$");
