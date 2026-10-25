// Contract error codes the keeper reacts to (contracts/repo/src/errors.rs)
// and how it treats each one. Pure: no .env, no RPC, so tests import it.

export const Err = {
  NotImplemented: 1,
  RepoNotFound: 6,
  InvalidStatus: 7,
  StaleNav: 9,
  NotDefaultable: 12,
  NoPrice: 13,
  NotDue: 15, // auto_repay a few seconds early: ledger time lags the wall clock
  AutoRepayFailed: 16,
  Paused: 17, // asset no_seize switch on: default / liquidate refused (#28)
  NavOutOfBand: 18, // NAV outside the asset's sanity band (#31)
} as const;

/**
 * What a contract error means for the keeper:
 * - `pending`: not yet on-chain (ledger clock lag), retry next tick;
 * - `stale`: the NAV is older than the asset's max age;
 * - `out-of-band`: the NAV is outside the asset's sanity band (#31);
 * - `paused`: the asset's no_seize switch is on;
 * - `short`: auto-repay could not pull the borrower's USDC;
 * - `no-margin`: contract deployed before the margin code;
 * - `fail`: anything else, a real failure (`--once` exits 1).
 */
export type Outcome = "pending" | "stale" | "out-of-band" | "paused" | "short" | "no-margin" | "fail";

export function outcomeOf(code: number | null | undefined): Outcome {
  switch (code) {
    case Err.NotDefaultable:
    case Err.NotDue:
      return "pending";
    case Err.StaleNav:
      return "stale";
    case Err.NavOutOfBand:
      return "out-of-band";
    case Err.Paused:
      return "paused";
    case Err.AutoRepayFailed:
      return "short";
    case Err.NotImplemented:
      return "no-margin";
    default:
      return "fail";
  }
}
