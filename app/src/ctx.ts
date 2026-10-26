import { DEMO_ENABLED } from "./config";
import type { AssetConfig, Balances, InKindClaim, Nav, ProtocolConfig } from "./chain";
import type { Leg, Stamp, TxState } from "./ui";
import type { BandCandidate, NavHealth, PricePoint } from "./gates";
import type { Signer } from "./wallet";

/**
 * Page-top message. `hash`: the tx it is about, linked under the text (Raven DW-02/DW-03).
 * `read`: a failed chain read; it gets a Retry button and clears itself on the next good read.
 * Write errors render under their own button instead (ui.tsx TxSlot) wherever a slot is on screen.
 */
export type Flash = { tone: "info" | "error" | "margin"; title: string; body: string; hash?: string | null; read?: boolean } | null;
/** `link`: where the result now lives ("View Agreement #001 →"), in the receipt foot. */
export type Receipt = { left: Leg; right: Leg; sentence: string; hash: string; stamp?: Stamp; link?: { href: string; label: string } } | null;
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
  /** Clears a failed write's progress and error (TxSlot Dismiss). */
  dismissTx: () => void;
  refreshAll: () => Promise<unknown>;
  /** The last market read failed and nothing has loaded yet: views show a Retry row instead of skeletons. */
  readError: boolean;
  /** Re-reads the market now (the 10 s interval also retries). */
  retry: () => void;
  /** ClaimedInKind events by repo id (#38); null until read. */
  inKind: Map<string, InKindClaim> | null;
}
