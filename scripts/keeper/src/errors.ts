// Contract error codes the keeper reacts to (contracts/repo/src/errors.rs)
// and how it treats each one, plus readable names for log lines. Pure: no
// .env, no RPC, so tests import it.
import { xdr } from "@stellar/stellar-sdk";

/** Every repo contract error code, same names as contracts/repo/src/errors.rs. */
export const Err = {
  NotImplemented: 1,
  InvalidConfig: 2,
  InvalidAmount: 3,
  MathOverflow: 4,
  OfferNotFound: 5,
  RepoNotFound: 6,
  InvalidStatus: 7,
  AssetNotSupported: 8,
  StaleNav: 9,
  InsufficientCollateral: 10,
  NotLiquidator: 11,
  NotDefaultable: 12,
  NoPrice: 13,
  AutoRepayOff: 14,
  NotDue: 15, // auto_repay a few seconds early: ledger time lags the wall clock
  AutoRepayFailed: 16,
  Paused: 17, // asset no_seize switch on: default / liquidate refused (#28)
  NavOutOfBand: 18, // NAV outside the asset's sanity band (#31)
  CapExceeded: 19,
  Loosens: 20,
  TimelockNotDone: 21,
  NoProposal: 22,
  NotAdminOrGuardian: 23,
  NothingToClaim: 24,
} as const;

const ERR_NAME = new Map<number, string>(Object.entries(Err).map(([name, code]) => [code, name]));

/**
 * The repo contract's name for an error code, e.g. 7 -> "InvalidStatus";
 * "" when unknown. A token contract's own code (#100 NotWhitelisted) is not
 * in the table and reads "".
 */
export function errName(code: number | null | undefined): string {
  return code == null ? "" : (ERR_NAME.get(code) ?? "");
}

/**
 * Why a landed transaction failed, from its TransactionResult (base64 XDR or
 * decoded): the outer result code, plus the operation's own result for a
 * one-op txFailed, e.g. "txFailed/invokeHostFunctionResourceLimitExceeded".
 * "" for a successful or unreadable result.
 */
export function txFailReason(result: string | xdr.TransactionResult | null | undefined): string {
  if (!result) return "";
  try {
    const r = typeof result === "string" ? xdr.TransactionResult.fromXDR(result, "base64") : result;
    const outer = r.result();
    const name = outer.switch().name;
    if (name === "txSuccess" || name === "txFeeBumpInnerSuccess") return "";
    if (name !== "txFailed") return name;
    const ops = outer.results();
    if (ops.length !== 1) return name;
    const op = ops[0];
    // opInner carries the operation's own result union; anything else (opBadAuth, ...) is the reason.
    if (op.switch().name !== "opInner") return `${name}/${op.switch().name}`;
    const inner = op.tr().value() as { switch(): { name: string } };
    return `${name}/${inner.switch().name}`;
  } catch {
    return "";
  }
}

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
