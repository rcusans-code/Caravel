import type { AssetConfig, Balances, Nav, ProtocolConfig } from "./chain";
import { DEMO_ENABLED } from "./config";
import type { Leg, Stamp, TxState } from "./ui";
import type { Signer } from "./wallet";

export type Flash = { tone: "info" | "error" | "margin"; title: string; body: string } | null;
export type Receipt = { left: Leg; right: Leg; sentence: string; hash: string; stamp?: Stamp } | null;
export const CONNECT = DEMO_ENABLED ? "Connect a wallet or pick a demo account" : "Connect a wallet";

export interface Ctx {
  signer: Signer | null;
  /** Connected and approved by the issuer of at least one collateral asset. */
  approved: boolean;
  /** Connected and allowed to hold this collateral (tBENJI authorized / tSAFO allowlisted). */
  canHold: (sac: string) => boolean;
  config: ProtocolConfig | null;
  /** Asset config per collateral token id; null = not registered with set_asset. */
  assets: Record<string, AssetConfig | null>;
  navs: Record<string, Nav | null>;
  /** Debt of live repos per collateral token (#32); null = contract has no open_debt(). */
  openDebt: Record<string, bigint | null>;
  /** NAV for this collateral is older than max_nav_age_secs. */
  stale: (sac: string) => boolean;
  balances: Balances | null;
  busy: string | null;
  /** Live transaction steps for the action with this key (TxProgress). */
  tx: TxState | null;
  now: number;
  run: <T>(key: string, title: string, fn: () => Promise<T>) => Promise<T | null>;
  setFlash: (f: Flash) => void;
  refreshAll: () => Promise<unknown>;
}
