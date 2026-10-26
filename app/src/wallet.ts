import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { Networks, type SwkAppTheme } from "@creit.tech/stellar-wallets-kit/types";
import { DEMO_KEYS, NETWORK_PASSPHRASE, type DemoRole } from "./config";
import { WrongNetworkError, onOtherNetwork, restoreWallet } from "./session";

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

const DEMO_ROLE_KEY = "caravel.demoRole";

let kitReady = false;
function kit() {
  if (!kitReady) {
    StellarWalletsKit.init({ modules: defaultModules(), network: Networks.TESTNET, theme });
    kitReady = true;
  }
  return StellarWalletsKit;
}

export { WrongNetworkError };

/** Opens the kit's wallet picker, then checks the wallet is on testnet. */
export async function connectWallet(): Promise<Signer> {
  const k = kit();
  const { address } = await k.authModal();
  // Some wallets (Albedo, xBull PWA) cannot report their network; signing pins it anyway.
  if (await onOtherNetwork(() => k.getNetwork(), NETWORK_PASSPHRASE)) {
    await k.disconnect().catch(() => undefined); // don't restore a rejected wallet on reload
    throw new WrongNetworkError("Your wallet is not on Testnet. Switch it to Testnet, then connect again.");
  }
  localStorage.removeItem(DEMO_ROLE_KEY);
  return walletSigner(address);
}

function walletSigner(address: string): Signer {
  const k = kit();
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

/**
 * Restores the last session after a page reload without opening any wallet popup.
 * The kit keeps the picked wallet and address in localStorage; the demo role is ours.
 * A wallet now on another network is disconnected and WrongNetworkError is thrown
 * (the same check as connect).
 */
export async function restoreSession(): Promise<Signer | null> {
  const role = localStorage.getItem(DEMO_ROLE_KEY) as DemoRole | null;
  if (role) {
    try {
      return demoSigner(role);
    } catch {
      localStorage.removeItem(DEMO_ROLE_KEY);
      return null;
    }
  }
  const k = kit();
  try {
    k.selectedModule; // throws when no wallet was picked before
  } catch {
    return null;
  }
  try {
    // getAddress reads the stored address (no prompt); getNetwork asks the wallet.
    return walletSigner(await restoreWallet(k, NETWORK_PASSPHRASE));
  } catch (e) {
    if (e instanceof WrongNetworkError) throw e;
    return null;
  }
}

export async function disconnectWallet() {
  localStorage.removeItem(DEMO_ROLE_KEY);
  // Always clear the kit too: a wallet picked before a demo session must not come back on reload.
  await kit().disconnect().catch(() => undefined);
}

// --- Demo signer (testnet burner keys from the repo .env, VITE_DEMO_SIGNER=1) ---

export function demoSigner(role: DemoRole): Signer {
  if (!DEMO_KEYS?.[role]) throw new Error("Demo signer is off. Start the app with VITE_DEMO_SIGNER=1.");
  const kp = Keypair.fromSecret(DEMO_KEYS[role]);
  localStorage.setItem(DEMO_ROLE_KEY, role);
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
