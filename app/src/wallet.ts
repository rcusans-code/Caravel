import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { Networks, type SwkAppTheme } from "@creit.tech/stellar-wallets-kit/types";
import { DEMO_KEYS, NETWORK_PASSPHRASE, type DemoRole } from "./config";

export type SignTx = (
  xdr: string,
  opts?: { networkPassphrase?: string; address?: string; path?: string },
) => Promise<{ signedTxXdr: string; signerAddress?: string }>;

export interface Signer {
  address: string;
  kind: "wallet" | "demo";
  /** Wallet name, or the demo role. */
  label: string;
  role?: DemoRole;
  signTransaction: SignTx;
}

// --- Stellar Wallets Kit (Freighter, xBull, Albedo, Lobstr, Rabet, Hana …) -----

// Kit modal styled with the Caravel role tokens (square corners, paper and ink).
const theme: SwkAppTheme = {
  background: "var(--surface)",
  "background-secondary": "var(--surface-sunken)",
  "foreground-strong": "var(--ink)",
  foreground: "var(--ink)",
  "foreground-secondary": "var(--ink-muted)",
  primary: "var(--primary)",
  "primary-foreground": "var(--on-primary)",
  transparent: "rgba(0,0,0,0)",
  lighter: "var(--surface)",
  light: "var(--surface-sunken)",
  "light-gray": "var(--line)",
  gray: "var(--ink-subtle)",
  danger: "var(--defaulted)",
  border: "var(--line-strong)",
  shadow: "var(--shadow-card)",
  "border-radius": "0px",
  "font-family": "var(--font-sans)",
};

let kitReady = false;
function kit() {
  if (!kitReady) {
    StellarWalletsKit.init({ modules: defaultModules(), network: Networks.TESTNET, theme });
    kitReady = true;
  }
  return StellarWalletsKit;
}

export class WrongNetworkError extends Error {}

/** Opens the kit's wallet picker, then checks the wallet is on testnet. */
export async function connectWallet(): Promise<Signer> {
  const k = kit();
  const { address } = await k.authModal();
  try {
    const net = await k.getNetwork();
    if (net?.networkPassphrase && net.networkPassphrase !== NETWORK_PASSPHRASE) {
      throw new WrongNetworkError(
        "Your wallet is not on Testnet. Switch it to Testnet, then connect again.",
      );
    }
  } catch (e) {
    if (e instanceof WrongNetworkError) throw e;
    // Some wallets (Albedo, xBull PWA) cannot report their network; signing pins it anyway.
  }
  const label = (() => {
    try {
      return k.selectedModule?.productName ?? "Wallet";
    } catch {
      return "Wallet";
    }
  })();
  return {
    address,
    kind: "wallet",
    label,
    signTransaction: (xdr, opts) =>
      k.signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE, address, ...opts }),
  };
}

export async function disconnectWallet() {
  if (kitReady) await StellarWalletsKit.disconnect().catch(() => undefined);
}

// --- Demo signer (testnet burner keys from the repo .env, VITE_DEMO_SIGNER=1) ---

export function demoSigner(role: DemoRole): Signer {
  if (!DEMO_KEYS?.[role]) throw new Error("Demo signer is off. Start the app with VITE_DEMO_SIGNER=1.");
  const kp = Keypair.fromSecret(DEMO_KEYS[role]);
  const s = basicNodeSigner(kp, NETWORK_PASSPHRASE);
  return {
    address: kp.publicKey(),
    kind: "demo",
    label: role,
    role,
    signTransaction: async (xdr, opts) => {
      if (opts?.networkPassphrase && opts.networkPassphrase !== NETWORK_PASSPHRASE)
        throw new Error("Demo signer only signs for testnet.");
      return s.signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE });
    },
  };
}
