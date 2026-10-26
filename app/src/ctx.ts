import { DEMO_ENABLED } from "./config";
import type { AssetConfig, Balances, InKindClaim, Nav, ProtocolConfig } from "./chain";
import type { Leg, Stamp, TxState } from "./ui";
import type { BandCandidate, NavHealth, PricePoint } from "./gates";
import type { Signer } from "./wallet";

/** `hash`: the tx this flash is about, linked under the text (Raven DW-02/DW-03), on success and on failure. */
export type Flash = { tone: "info" | "error" | "margin"; title: string; body: string; hash?: string | null } | null;
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
  /** Oracle `prices(asset, 20)` per collateral, newest first; null = not read. */
  histories: Record<string, PricePoint[] | null>;
  /** Repo `band_candidate` per collateral (band settle path); null = none. */
  candidates: Record<string, BandCandidate | null>;
  /** Debt of live repos per collateral token (#32); null = contract has no open_debt(). */
  openDebt: Record<string, bigint | null>;
  /** NAV state for this collateral as the contract would see it. */
  health: (sac: string) => NavHealth;
  balances: Balances | null;
  busy: string | null;
  /** Live transaction steps for the action with this key (TxProgress). */
  tx: TxState | null;
  now: number;
  run: <T>(key: string, title: string, fn: () => Promise<T>) => Promise<T | null>;
  setFlash: (f: Flash) => void;
  refreshAll: () => Promise<unknown>;
  /** ClaimedInKind events by repo id (#38); null until read. */
  inKind: Map<string, InKindClaim> | null;
}
