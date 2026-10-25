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

const [usdcCode, usdcIssuer] = deployment.assets.usdc.split(":");
const [tbenjiCode, tbenjiIssuer] = deployment.assets.tbenji.split(":");
export const USDC = { code: usdcCode, issuer: usdcIssuer, sac: USDC_SAC };
export const TBENJI = { code: tbenjiCode, issuer: tbenjiIssuer, sac: TBENJI_SAC };

/** Collateral assets the UI offers. Haircut and enabled flag are read on-chain. */
export const COLLATERAL = [TBENJI];
export const assetBySac = (sac: string) =>
  [USDC, TBENJI].find((a) => a.sac === sac) ?? { code: sac.slice(0, 4) + "…", issuer: "", sac };

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
