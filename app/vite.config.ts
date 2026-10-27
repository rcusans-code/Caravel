import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "..");

/**
 * The generated bindings in ../packages ship their own node_modules. Resolve
 * their `@stellar/stellar-sdk` and `buffer` imports from the app instead, so
 * the bundle carries one SDK copy and `instanceof` checks agree.
 */
function bindingsUseAppSdk(): Plugin {
  const anchor = path.join(appDir, "src", "main.tsx");
  return {
    name: "caravel-bindings-use-app-sdk",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !importer.includes(`${path.sep}packages${path.sep}caravel-`)) return null;
      if (!/^(@stellar\/stellar-sdk|buffer)(\/|$)/.test(source)) return null;
      return this.resolve(source, anchor, { ...options, skipSelf: true });
    },
  };
}

export default defineConfig(({ command, mode, isPreview }) => {
  // Repo-root .env holds the committed TESTNET burner keys (see ../.gitignore).
  const rootEnv = loadEnv(mode, repoRoot, "");
  const appEnv = loadEnv(mode, appDir, "VITE_");
  const demoFlag = process.env.VITE_DEMO_SIGNER ?? appEnv.VITE_DEMO_SIGNER ?? "";
  const network = rootEnv.NETWORK ?? "testnet";
  const demoEnabled = demoFlag === "1" && network === "testnet";
  // Only injected when VITE_DEMO_SIGNER=1 and the network is testnet.
  const demoKeys = demoEnabled
    ? {
        lender: rootEnv.LENDER_SECRET,
        borrower: rootEnv.BORROWER_SECRET,
        liquidator: rootEnv.LIQUIDATOR_SECRET,
        admin: rootEnv.ADMIN_SECRET,
      }
    : null;
  // Live SEP-40 feed shown next to the mock NAV, reference only (public ids).
  // Same LIVE_ORACLE_ID / LIVE_ORACLE_ASSET the keeper's `npm run feeds` reads
  // from the repo-root .env; a shell variable overrides it for one build.
  const liveOracle = process.env.LIVE_ORACLE_ID ?? rootEnv.LIVE_ORACLE_ID ?? "";
  const liveAsset = process.env.LIVE_ORACLE_ASSET ?? rootEnv.LIVE_ORACLE_ASSET ?? "";
  const liveFeed = liveOracle && liveAsset ? { oracle: liveOracle, asset: liveAsset } : null;
  // EURC market (DECISIONS #52): the public deployments/testnet-eur.json that
  // `LOAN_ASSET=EURC scripts/deploy.sh` writes. Present = the app shows the
  // market switch (?market=eur); missing = USDC market only. Path relative to app/.
  const eurFile = path.resolve(appDir, process.env.CARAVEL_EUR_DEPLOYMENT ?? "../deployments/testnet-eur.json");
  const eurDeployment = fs.existsSync(eurFile) ? JSON.parse(fs.readFileSync(eurFile, "utf8")) : null;

  return {
    // The public site serves the landing (site/) at / and the app under /app/ (see scripts/build-pages.mjs).
    // The dev server stays at / so local URLs do not change.
    base: command === "build" || isPreview ? "/app/" : "/",
    plugins: [bindingsUseAppSdk(), react()],
    define: {
      __DEMO_KEYS__: JSON.stringify(demoKeys),
      __LIVE_FEED__: JSON.stringify(liveFeed),
      __EUR_DEPLOYMENT__: JSON.stringify(eurDeployment),
      global: "globalThis",
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: false,
      allowedHosts: true,
      fs: { allow: [repoRoot] },
    },
    preview: { host: "0.0.0.0", allowedHosts: true },
    build: { chunkSizeWarningLimit: 4096 },
  };
});
