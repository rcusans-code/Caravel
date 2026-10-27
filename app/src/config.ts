// Deployment facts come from the public deployments/*.json files that
// scripts/deploy.sh writes; nothing here is hand-copied. The USDC market is
// deployments/testnet.json; the EURC market (DECISIONS #52) is
// deployments/testnet-eur.json, injected at build time when present and picked
// with ?market=eur (market.ts). The market is fixed for the page load.
import usdDeployment from "../../deployments/testnet.json";
import { loanToken, pickMarket, quoteOf, quoteSign, type Deployment, type MarketId, type Quote } from "./market";
import { parseAsset, type Asset } from "./sep40";

declare const __EUR_DEPLOYMENT__: Deployment | null;
// typeof guard: a bundle built without the define (none today) still loads, USDC market only.
const eurDeployment: Deployment | null = typeof __EUR_DEPLOYMENT__ !== "undefined" ? __EUR_DEPLOYMENT__ : null;

/** Markets this build can show; the header switch appears only when there are two. */
export const MARKETS_AVAILABLE: MarketId[] = eurDeployment ? ["usd", "eur"] : ["usd"];
export const MARKET: MarketId = pickMarket(typeof location !== "undefined" ? location.search : "", !!eurDeployment);
const deployment: Deployment = MARKET === "eur" && eurDeployment ? eurDeployment : usdDeployment;

export const NETWORK = deployment.network; // "testnet"
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const RPC_URL = deployment.rpcUrl || "https://soroban-testnet.stellar.org";
export const HORIZON_URL = deployment.horizonUrl || "https://horizon-testnet.stellar.org";
export const EXPLORER = "https://stellar.expert/explorer/testnet";

export const REPO_ID = deployment.contracts.repo;
export const ORACLE_ID = deployment.contracts.oracle;
export const TBENJI_SAC: string | null = deployment.contracts.tbenji ?? null;
export const DEPLOYED_AT = deployment.deployedAt;

/** Currency the oracle prices NAV in, which is the loan currency (the contract checks they match). */
export const QUOTE: Quote = quoteOf(deployment);
/** "$" or "€", shown before a NAV. */
export const QUOTE_SIGN = quoteSign(QUOTE);

/**
 * A token the UI shows. `sac`: classic asset SAC (balance + authorization via
 * Horizon trustlines). `spiko`: custom Soroban token with an allowlist and no
 * trustline (tSAFO, contracts/spiko-mock; balance read from the contract).
 */
export interface Token {
  code: string;
  issuer: string;
  sac: string;
  decimals: number;
  kind: "sac" | "spiko";
}

const loan = loanToken(deployment);
/** The loan token: USDC, or tEURC in the EURC market. Every amount the app shows is in it. */
export const LOAN: Token = { ...loan, kind: "sac" };
/** tBENJI, the USDC market's classic collateral; null in the EURC market (tSAFO only). */
export const TBENJI: Token | null =
  TBENJI_SAC && deployment.assets.tbenji
    ? (() => {
        const [code, issuer] = deployment.assets.tbenji.split(":");
        return { code, issuer, sac: TBENJI_SAC, decimals: 7, kind: "sac" as const };
      })()
    : null;
/** Classic assets this market needs trustlines for: [loan token, classic collateral?] (trustline.ts). */
export const TRUST_CODES: string[] = [LOAN.code, ...(TBENJI ? [TBENJI.code] : [])];

// Collateral #2 (issue #20). Present once scripts/deploy.sh has deployed tSAFO.
export const TSAFO: Token | null = deployment.contracts.tsafo
  ? {
      code: deployment.tsafo?.symbol ?? "tSAFO",
      issuer: "",
      sac: deployment.contracts.tsafo,
      decimals: deployment.tsafo?.decimals ?? 5,
      kind: "spiko",
    }
  : null;

/** Collateral assets the UI offers. Haircut and enabled flag are read on-chain. */
export const COLLATERAL: Token[] = [...(TBENJI ? [TBENJI] : []), ...(TSAFO ? [TSAFO] : [])];
export const assetBySac = (sac: string): Token =>
  [LOAN, ...COLLATERAL].find((a) => a.sac === sac) ?? { code: sac.slice(0, 4) + "…", issuer: "", sac, decimals: 7, kind: "sac" };

export const ACCOUNTS = deployment.accounts;
export const ORACLE_DECIMALS = deployment.oracle.decimals;

/**
 * Live SEP-40 feed shown next to the mock NAV, for reference only: the repo
 * contract never reads it. Public ids, injected at build time from the repo-root
 * .env LIVE_ORACLE_ID / LIVE_ORACLE_ASSET (the keeper's `npm run feeds` reads
 * the same two). null when unset or unparseable; the UI then says unavailable.
 */
declare const __LIVE_FEED__: { oracle: string; asset: string } | null;
export const LIVE_FEED: { oracle: string; asset: Asset } | null = (() => {
  try {
    return __LIVE_FEED__ ? { oracle: __LIVE_FEED__.oracle, asset: parseAsset(__LIVE_FEED__.asset) } : null;
  } catch {
    return null;
  }
})();

export type DemoRole = "lender" | "borrower" | "liquidator" | "admin";
export const DEMO_ROLES: DemoRole[] = ["lender", "borrower", "liquidator", "admin"];

declare const __DEMO_KEYS__: Record<DemoRole, string> | null;
/** Testnet burner secrets, present only when built with VITE_DEMO_SIGNER=1. */
export const DEMO_KEYS: Record<DemoRole, string> | null = __DEMO_KEYS__;
export const DEMO_ENABLED = NETWORK === "testnet" && !!DEMO_KEYS;

export const roleOf = (address: string): DemoRole | null =>
  (DEMO_ROLES.find((r) => ACCOUNTS[r] === address) as DemoRole | undefined) ?? null;
