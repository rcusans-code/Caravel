// Deployment facts come from the public deployments/testnet.json that
// scripts/deploy.sh writes; nothing here is hand-copied.
import deployment from "../../deployments/testnet.json";

export const NETWORK = deployment.network; // "testnet"
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const RPC_URL = deployment.rpcUrl || "https://soroban-testnet.stellar.org";
export const HORIZON_URL = deployment.horizonUrl || "https://horizon-testnet.stellar.org";
export const EXPLORER = "https://stellar.expert/explorer/testnet";

export const REPO_ID = deployment.contracts.repo;
export const ORACLE_ID = deployment.contracts.oracle;
export const USDC_SAC = deployment.contracts.usdc;
export const TBENJI_SAC = deployment.contracts.tbenji;
export const DEPLOYED_AT = deployment.deployedAt;

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

const [usdcCode, usdcIssuer] = deployment.assets.usdc.split(":");
const [tbenjiCode, tbenjiIssuer] = deployment.assets.tbenji.split(":");
export const USDC: Token = { code: usdcCode, issuer: usdcIssuer, sac: USDC_SAC, decimals: 7, kind: "sac" };
export const TBENJI: Token = { code: tbenjiCode, issuer: tbenjiIssuer, sac: TBENJI_SAC, decimals: 7, kind: "sac" };

// Collateral #2 (issue #20). Present once scripts/deploy.sh has deployed tSAFO.
const dep = deployment as typeof deployment & {
  contracts: { tsafo?: string };
  tsafo?: { symbol?: string; decimals?: number };
};
export const TSAFO: Token | null = dep.contracts.tsafo
  ? { code: dep.tsafo?.symbol ?? "tSAFO", issuer: "", sac: dep.contracts.tsafo, decimals: dep.tsafo?.decimals ?? 5, kind: "spiko" }
  : null;

/** Collateral assets the UI offers. Haircut and enabled flag are read on-chain. */
export const COLLATERAL: Token[] = [TBENJI, ...(TSAFO ? [TSAFO] : [])];
export const assetBySac = (sac: string): Token =>
  [USDC, ...COLLATERAL].find((a) => a.sac === sac) ?? { code: sac.slice(0, 4) + "…", issuer: "", sac, decimals: 7, kind: "sac" };

export const ACCOUNTS = deployment.accounts;
export const ORACLE_DECIMALS = deployment.oracle.decimals;

export type DemoRole = "lender" | "borrower" | "liquidator" | "admin";
export const DEMO_ROLES: DemoRole[] = ["lender", "borrower", "liquidator", "admin"];

declare const __DEMO_KEYS__: Record<DemoRole, string> | null;
/** Testnet burner secrets, present only when built with VITE_DEMO_SIGNER=1. */
export const DEMO_KEYS: Record<DemoRole, string> | null = __DEMO_KEYS__;
export const DEMO_ENABLED = NETWORK === "testnet" && !!DEMO_KEYS;

export const roleOf = (address: string): DemoRole | null =>
  (DEMO_ROLES.find((r) => ACCOUNTS[r] === address) as DemoRole | undefined) ?? null;
