import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CCFP3L7TZ6BLCN7FYHFVYF3JXJDZ47QKSIAKMXV6AYVBDFWJNZJ3DP53",
  }
} as const


/**
 * A live or settled repo, created when a borrower takes an offer.
 */
export interface Repo {
  /**
 * Borrower opted in to auto-repay (DECISIONS.md #27): from maturity the
 * debt is pulled from their USDC allowance instead of defaulting.
 */
auto_repay: boolean;
  borrower: string;
  /**
 * Collateral held by the contract, in the token's own units (its
 * `decimals()`: 7 for tBENJI, 5 for Spiko tokens; DECISIONS.md #28).
 */
collateral_amount: i128;
  collateral_asset: string;
  /**
 * Snapshot of the asset haircut at take time. The top-up target: a
 * margin call clears once `ltv_ok` holds at this haircut again.
 */
haircut_bps: u32;
  id: u64;
  /**
 * Full-term interest, fixed at take time. Debt = principal + interest,
 * the same amount on early repay (DECISIONS.md #15).
 */
interest: i128;
  lender: string;
  /**
 * Set once on the first margin breach; cleared by a healthy top-up.
 */
margin_call_deadline: Option<u64>;
  maturity_ts: u64;
  offer_id: u64;
  principal: i128;
  start_ts: u64;
  status: Status;
}

/**
 * SEP-40 asset identifier, same shape as Reflector's, so the mock oracle and
 * live feeds accept it unchanged.
 */
export type Asset = {tag: "Stellar", values: readonly [string]} | {tag: "Other", values: readonly [string]};


/**
 * A lender's standing offer. The lender sets only asset, principal, APR and
 * term; the haircut comes from the asset's `AssetConfig`. The principal is escrowed in the contract
 * from `create_offer` until it is taken or cancelled.
 */
export interface Offer {
  apr_bps: u32;
  /**
 * Collateral token the lender accepts (e.g. tBENJI SAC).
 */
collateral_asset: string;
  created_at: u64;
  id: u64;
  lender: string;
  /**
 * USDC lent, 7-decimal units.
 */
principal: i128;
  term_secs: u64;
}


/**
 * Protocol parameters, set once at deploy. Stored in instance storage.
 * 
 * All durations are config so the demo can compress time without touching
 * contract logic (DECISIONS.md #5).
 */
export interface Config {
  admin: string;
  /**
 * Length of one "day" in seconds. 86_400 in production, 60 in the demo.
 * Interest uses a 365-day year of this length.
 */
day_secs: u64;
  /**
 * Protocol fee as a share of interest, in bps (DECISIONS.md #3).
 */
fee_bps: u32;
  /**
 * Time after maturity before an unpaid repo can be defaulted.
 */
grace_secs: u64;
  /**
 * Liquidator buys collateral at NAV × (1 − discount). 200 = 2%.
 */
liquidation_discount_bps: u32;
  /**
 * Time a borrower has to top up after a margin call.
 */
margin_window_secs: u64;
  /**
 * SEP-40 price feed for collateral NAV.
 */
oracle: string;
  /**
 * Receives the protocol fee.
 */
treasury: string;
  /**
 * Circle testnet USDC SAC.
 */
usdc: string;
}

export type Status = {tag: "Open", values: void} | {tag: "MarginCall", values: void} | {tag: "Repaid", values: void} | {tag: "Defaulted", values: void} | {tag: "Liquidated", values: void};


/**
 * Per-collateral-asset risk parameters, admin-updatable without a redeploy
 * (DECISIONS.md #13). Stored in instance storage, keyed by the token address.
 */
export interface AssetConfig {
  /**
 * Disabled assets reject new offers; live repos are unaffected.
 */
enabled: boolean;
  /**
 * Initial LTV: `debt ≤ value × (1 − haircut)`. Always above
 * `Config.liquidation_discount_bps`, so a max-LTV take opens below the
 * margin trigger.
 */
haircut_bps: u32;
  /**
 * A NAV older than this blocks `take_offer`, `check_margin` and
 * `liquidate` for this asset (DECISIONS.md #6, #17, #25). Never blocks
 * `repay` or `top_up`. Per asset because publication schedules differ:
 * a fund that prints NAV only on business days needs ~96 h to cover a
 * weekend, a daily-priced token less. Must be > 0.
 */
max_nav_age_secs: u64;
  /**
 * How the oracle names this asset.
 */
oracle_asset: Asset;
}

export const Errors = {
  1: {message:"NotImplemented"},
  2: {message:"InvalidConfig"},
  3: {message:"InvalidAmount"},
  4: {message:"MathOverflow"},
  5: {message:"OfferNotFound"},
  6: {message:"RepoNotFound"},
  7: {message:"InvalidStatus"},
  /**
   * Collateral asset has no `AssetConfig`, or it is disabled.
   */
  8: {message:"AssetNotSupported"},
  9: {message:"StaleNav"},
  10: {message:"InsufficientCollateral"},
  11: {message:"NotLiquidator"},
  12: {message:"NotDefaultable"},
  /**
   * Oracle has no price for the asset, or it is not positive.
   */
  13: {message:"NoPrice"},
  /**
   * `auto_repay` on a repo that did not opt in.
   */
  14: {message:"AutoRepayOff"},
  /**
   * `auto_repay` before maturity (and no missed margin call).
   */
  15: {message:"NotDue"},
  /**
   * The USDC pull failed: short balance, allowance too small or expired.
   */
  16: {message:"AutoRepayFailed"}
}












export interface Client {
  /**
   * Construct and simulate a repo transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  repo: ({repo_id}: {repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Repo>>>

  /**
   * Construct and simulate a asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  asset: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<AssetConfig>>>

  /**
   * Construct and simulate a offer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  offer: ({offer_id}: {offer_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Offer>>>

  /**
   * Construct and simulate a repay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Borrower pays principal + full-term interest and gets the collateral
   * back. The lender receives exactly `principal + interest − fee`, the
   * treasury the fee (#3). Works from `Open` or `MarginCall`, before or
   * after maturity until someone calls `default`, and needs no NAV (#6).
   */
  repay: ({repo_id}: {repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  config: (options?: MethodOptions) => Promise<AssembledTransaction<Config>>

  /**
   * Construct and simulate a top_up transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds collateral. Clears a margin call once
   * `ltv_ok(debt, collateral, nav, dec, repo.haircut_bps)` holds, i.e. the
   * initial margin is restored (TradFi convention). Works with stale NAV.
   */
  top_up: ({repo_id, amount}: {repo_id: u64, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a default transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Moves a repo to `Defaulted` once it is past maturity + grace, or in
   * `MarginCall` past its `margin_call_deadline` (set by `check_margin`).
   * Anyone can call it (#7); it needs no NAV (#17). Both deadlines are
   * strict: at the exact second the borrower can still repay or top up.
   * 
   * An opted-in repo tries auto-repay first (#27) and settles as `Repaid`
   * when the pull succeeds. Returns the resulting status.
   */
  default: ({repo_id}: {repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Status>>>

  /**
   * Construct and simulate a liquidate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A whitelisted liquidator buys a defaulted repo's collateral at
   * NAV × (1 − discount), rounded up. The USDC goes lender first (capped at
   * principal + interest − fee), then the fee, then the borrower (#3, #4).
   * If proceeds fall short of what the lender is owed, the lender takes
   * everything and `Shortfall` is emitted. Stale NAV returns `StaleNav` (#6).
   */
  liquidate: ({liquidator, repo_id}: {liquidator: string, repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds or re-tiers a collateral asset (DECISIONS.md #13). Requires
   * `liquidation_discount_bps < haircut_bps < 10_000`: a strictly larger
   * haircut means a take at max LTV opens strictly below the margin trigger.
   * Requires `max_nav_age_secs > 0` (staleness is per asset, #25).
   */
  set_asset: ({asset, config}: {asset: string, config: AssetConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a auto_repay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Repays an opted-in repo from the borrower's USDC allowance (#27).
   * Anyone can call it from maturity, or once a margin call's deadline has
   * passed. On success the repo is `Repaid` exactly as if the borrower had
   * called `repay`. If the pull fails the repo is untouched and the call
   * returns `AutoRepayFailed`; the borrower can still repay by hand.
   */
  auto_repay: ({repo_id}: {repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a take_offer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Atomic DvP: collateral in, escrowed USDC out. Returns the repo id.
   * Full takes only (DECISIONS.md #16): the contract computes
   * `collateral = required_collateral(debt, nav, dec, haircut)`, rounded up,
   * and fixes debt = principal + full-term interest (#15). The borrower's
   * auth on the SAC transfer pins the exact amount, so if NAV moves between
   * simulate and submit the tx fails instead of overcharging (#21).
   * 
   * Rejects stale NAV (#6) and an asset disabled since the offer was
   * posted (#23). The haircut is snapshotted on the repo (#19).
   * 
   * `auto_repay` opts in to auto-repay (#27): the same signature also
   * approves this contract to pull the debt in USDC from maturity.
   */
  take_offer: ({borrower, offer_id, auto_repay}: {borrower: string, offer_id: u64, auto_repay: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a cancel_offer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the escrowed USDC to the lender. Only the lender can cancel,
   * and only while the offer is untaken (a take removes it).
   */
  cancel_offer: ({offer_id}: {offer_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a check_margin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets `margin_call_deadline` on the first `margin_breached`. Returns the
   * status. Stale NAV returns `StaleNav` (DECISIONS.md #17).
   */
  check_margin: ({repo_id}: {repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Status>>>

  /**
   * Construct and simulate a create_offer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Escrows `principal` USDC from the lender. Returns the offer id.
   * The haircut comes from the asset's `AssetConfig`, not the lender.
   * Rejects a missing or disabled asset with `AssetNotSupported` (#22).
   */
  create_offer: ({lender, collateral_asset, principal, apr_bps, term_secs}: {lender: string, collateral_asset: string, principal: i128, apr_bps: u32, term_secs: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a is_liquidator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_liquidator: ({who}: {who: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a set_auto_repay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Turns auto-repay on or off for a live repo (#27). On approves this
   * contract to pull the debt in USDC from maturity; off takes that
   * approval back. Borrower only; setting the current value is a no-op.
   */
  set_auto_repay: ({repo_id, enabled}: {repo_id: u64, enabled: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_liquidator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_liquidator: ({liquidator, allowed}: {liquidator: string, allowed: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {config}: {config: Config},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({config}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAAAAAAAEcmVwbwAAAAEAAAAAAAAAB3JlcG9faWQAAAAABgAAAAEAAAPpAAAH0AAAAARSZXBvAAAAAw==",
        "AAAAAAAAAAAAAAAFYXNzZXQAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6QAAB9AAAAALQXNzZXRDb25maWcAAAAAAw==",
        "AAAAAAAAAAAAAAAFb2ZmZXIAAAAAAAABAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAD6QAAB9AAAAAFT2ZmZXIAAAAAAAAD",
        "AAAAAAAAARNCb3Jyb3dlciBwYXlzIHByaW5jaXBhbCArIGZ1bGwtdGVybSBpbnRlcmVzdCBhbmQgZ2V0cyB0aGUgY29sbGF0ZXJhbApiYWNrLiBUaGUgbGVuZGVyIHJlY2VpdmVzIGV4YWN0bHkgYHByaW5jaXBhbCArIGludGVyZXN0IOKIkiBmZWVgLCB0aGUKdHJlYXN1cnkgdGhlIGZlZSAoIzMpLiBXb3JrcyBmcm9tIGBPcGVuYCBvciBgTWFyZ2luQ2FsbGAsIGJlZm9yZSBvcgphZnRlciBtYXR1cml0eSB1bnRpbCBzb21lb25lIGNhbGxzIGBkZWZhdWx0YCwgYW5kIG5lZWRzIG5vIE5BViAoIzYpLgAAAAAFcmVwYXkAAAAAAAABAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAGY29uZmlnAAAAAAAAAAAAAQAAB9AAAAAGQ29uZmlnAAA=",
        "AAAAAAAAALdBZGRzIGNvbGxhdGVyYWwuIENsZWFycyBhIG1hcmdpbiBjYWxsIG9uY2UKYGx0dl9vayhkZWJ0LCBjb2xsYXRlcmFsLCBuYXYsIGRlYywgcmVwby5oYWlyY3V0X2JwcylgIGhvbGRzLCBpLmUuIHRoZQppbml0aWFsIG1hcmdpbiBpcyByZXN0b3JlZCAoVHJhZEZpIGNvbnZlbnRpb24pLiBXb3JrcyB3aXRoIHN0YWxlIE5BVi4AAAAABnRvcF91cAAAAAAAAgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAY1Nb3ZlcyBhIHJlcG8gdG8gYERlZmF1bHRlZGAgb25jZSBpdCBpcyBwYXN0IG1hdHVyaXR5ICsgZ3JhY2UsIG9yIGluCmBNYXJnaW5DYWxsYCBwYXN0IGl0cyBgbWFyZ2luX2NhbGxfZGVhZGxpbmVgIChzZXQgYnkgYGNoZWNrX21hcmdpbmApLgpBbnlvbmUgY2FuIGNhbGwgaXQgKCM3KTsgaXQgbmVlZHMgbm8gTkFWICgjMTcpLiBCb3RoIGRlYWRsaW5lcyBhcmUKc3RyaWN0OiBhdCB0aGUgZXhhY3Qgc2Vjb25kIHRoZSBib3Jyb3dlciBjYW4gc3RpbGwgcmVwYXkgb3IgdG9wIHVwLgoKQW4gb3B0ZWQtaW4gcmVwbyB0cmllcyBhdXRvLXJlcGF5IGZpcnN0ICgjMjcpIGFuZCBzZXR0bGVzIGFzIGBSZXBhaWRgCndoZW4gdGhlIHB1bGwgc3VjY2VlZHMuIFJldHVybnMgdGhlIHJlc3VsdGluZyBzdGF0dXMuAAAAAAAAB2RlZmF1bHQAAAAAAQAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAA+kAAAfQAAAABlN0YXR1cwAAAAAAAw==",
        "AAAAAAAAAWBBIHdoaXRlbGlzdGVkIGxpcXVpZGF0b3IgYnV5cyBhIGRlZmF1bHRlZCByZXBvJ3MgY29sbGF0ZXJhbCBhdApOQVYgw5cgKDEg4oiSIGRpc2NvdW50KSwgcm91bmRlZCB1cC4gVGhlIFVTREMgZ29lcyBsZW5kZXIgZmlyc3QgKGNhcHBlZCBhdApwcmluY2lwYWwgKyBpbnRlcmVzdCDiiJIgZmVlKSwgdGhlbiB0aGUgZmVlLCB0aGVuIHRoZSBib3Jyb3dlciAoIzMsICM0KS4KSWYgcHJvY2VlZHMgZmFsbCBzaG9ydCBvZiB3aGF0IHRoZSBsZW5kZXIgaXMgb3dlZCwgdGhlIGxlbmRlciB0YWtlcwpldmVyeXRoaW5nIGFuZCBgU2hvcnRmYWxsYCBpcyBlbWl0dGVkLiBTdGFsZSBOQVYgcmV0dXJucyBgU3RhbGVOYXZgICgjNikuAAAACWxpcXVpZGF0ZQAAAAAAAAIAAAAAAAAACmxpcXVpZGF0b3IAAAAAABMAAAAAAAAAB3JlcG9faWQAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAQ1BZGRzIG9yIHJlLXRpZXJzIGEgY29sbGF0ZXJhbCBhc3NldCAoREVDSVNJT05TLm1kICMxMykuIFJlcXVpcmVzCmBsaXF1aWRhdGlvbl9kaXNjb3VudF9icHMgPCBoYWlyY3V0X2JwcyA8IDEwXzAwMGA6IGEgc3RyaWN0bHkgbGFyZ2VyCmhhaXJjdXQgbWVhbnMgYSB0YWtlIGF0IG1heCBMVFYgb3BlbnMgc3RyaWN0bHkgYmVsb3cgdGhlIG1hcmdpbiB0cmlnZ2VyLgpSZXF1aXJlcyBgbWF4X25hdl9hZ2Vfc2VjcyA+IDBgIChzdGFsZW5lc3MgaXMgcGVyIGFzc2V0LCAjMjUpLgAAAAAAAAlzZXRfYXNzZXQAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAtBc3NldENvbmZpZwAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAVVSZXBheXMgYW4gb3B0ZWQtaW4gcmVwbyBmcm9tIHRoZSBib3Jyb3dlcidzIFVTREMgYWxsb3dhbmNlICgjMjcpLgpBbnlvbmUgY2FuIGNhbGwgaXQgZnJvbSBtYXR1cml0eSwgb3Igb25jZSBhIG1hcmdpbiBjYWxsJ3MgZGVhZGxpbmUgaGFzCnBhc3NlZC4gT24gc3VjY2VzcyB0aGUgcmVwbyBpcyBgUmVwYWlkYCBleGFjdGx5IGFzIGlmIHRoZSBib3Jyb3dlciBoYWQKY2FsbGVkIGByZXBheWAuIElmIHRoZSBwdWxsIGZhaWxzIHRoZSByZXBvIGlzIHVudG91Y2hlZCBhbmQgdGhlIGNhbGwKcmV0dXJucyBgQXV0b1JlcGF5RmFpbGVkYDsgdGhlIGJvcnJvd2VyIGNhbiBzdGlsbCByZXBheSBieSBoYW5kLgAAAAAAAAphdXRvX3JlcGF5AAAAAAABAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAApNBdG9taWMgRHZQOiBjb2xsYXRlcmFsIGluLCBlc2Nyb3dlZCBVU0RDIG91dC4gUmV0dXJucyB0aGUgcmVwbyBpZC4KRnVsbCB0YWtlcyBvbmx5IChERUNJU0lPTlMubWQgIzE2KTogdGhlIGNvbnRyYWN0IGNvbXB1dGVzCmBjb2xsYXRlcmFsID0gcmVxdWlyZWRfY29sbGF0ZXJhbChkZWJ0LCBuYXYsIGRlYywgaGFpcmN1dClgLCByb3VuZGVkIHVwLAphbmQgZml4ZXMgZGVidCA9IHByaW5jaXBhbCArIGZ1bGwtdGVybSBpbnRlcmVzdCAoIzE1KS4gVGhlIGJvcnJvd2VyJ3MKYXV0aCBvbiB0aGUgU0FDIHRyYW5zZmVyIHBpbnMgdGhlIGV4YWN0IGFtb3VudCwgc28gaWYgTkFWIG1vdmVzIGJldHdlZW4Kc2ltdWxhdGUgYW5kIHN1Ym1pdCB0aGUgdHggZmFpbHMgaW5zdGVhZCBvZiBvdmVyY2hhcmdpbmcgKCMyMSkuCgpSZWplY3RzIHN0YWxlIE5BViAoIzYpIGFuZCBhbiBhc3NldCBkaXNhYmxlZCBzaW5jZSB0aGUgb2ZmZXIgd2FzCnBvc3RlZCAoIzIzKS4gVGhlIGhhaXJjdXQgaXMgc25hcHNob3R0ZWQgb24gdGhlIHJlcG8gKCMxOSkuCgpgYXV0b19yZXBheWAgb3B0cyBpbiB0byBhdXRvLXJlcGF5ICgjMjcpOiB0aGUgc2FtZSBzaWduYXR1cmUgYWxzbwphcHByb3ZlcyB0aGlzIGNvbnRyYWN0IHRvIHB1bGwgdGhlIGRlYnQgaW4gVVNEQyBmcm9tIG1hdHVyaXR5LgAAAAAKdGFrZV9vZmZlcgAAAAAAAwAAAAAAAAAIYm9ycm93ZXIAAAATAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAAAAAAACmF1dG9fcmVwYXkAAAAAAAEAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAH1SZXR1cm5zIHRoZSBlc2Nyb3dlZCBVU0RDIHRvIHRoZSBsZW5kZXIuIE9ubHkgdGhlIGxlbmRlciBjYW4gY2FuY2VsLAphbmQgb25seSB3aGlsZSB0aGUgb2ZmZXIgaXMgdW50YWtlbiAoYSB0YWtlIHJlbW92ZXMgaXQpLgAAAAAAAAxjYW5jZWxfb2ZmZXIAAAABAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAIBTZXRzIGBtYXJnaW5fY2FsbF9kZWFkbGluZWAgb24gdGhlIGZpcnN0IGBtYXJnaW5fYnJlYWNoZWRgLiBSZXR1cm5zIHRoZQpzdGF0dXMuIFN0YWxlIE5BViByZXR1cm5zIGBTdGFsZU5hdmAgKERFQ0lTSU9OUy5tZCAjMTcpLgAAAAxjaGVja19tYXJnaW4AAAABAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAB9AAAAAGU3RhdHVzAAAAAAAD",
        "AAAAAAAAAMVFc2Nyb3dzIGBwcmluY2lwYWxgIFVTREMgZnJvbSB0aGUgbGVuZGVyLiBSZXR1cm5zIHRoZSBvZmZlciBpZC4KVGhlIGhhaXJjdXQgY29tZXMgZnJvbSB0aGUgYXNzZXQncyBgQXNzZXRDb25maWdgLCBub3QgdGhlIGxlbmRlci4KUmVqZWN0cyBhIG1pc3Npbmcgb3IgZGlzYWJsZWQgYXNzZXQgd2l0aCBgQXNzZXROb3RTdXBwb3J0ZWRgICgjMjIpLgAAAAAAAAxjcmVhdGVfb2ZmZXIAAAAFAAAAAAAAAAZsZW5kZXIAAAAAABMAAAAAAAAAEGNvbGxhdGVyYWxfYXNzZXQAAAATAAAAAAAAAAlwcmluY2lwYWwAAAAAAAALAAAAAAAAAAdhcHJfYnBzAAAAAAQAAAAAAAAACXRlcm1fc2VjcwAAAAAAAAYAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAEAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAZDb25maWcAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANaXNfbGlxdWlkYXRvcgAAAAAAAAEAAAAAAAAAA3dobwAAAAATAAAAAQAAAAE=",
        "AAAAAAAAAMZUdXJucyBhdXRvLXJlcGF5IG9uIG9yIG9mZiBmb3IgYSBsaXZlIHJlcG8gKCMyNykuIE9uIGFwcHJvdmVzIHRoaXMKY29udHJhY3QgdG8gcHVsbCB0aGUgZGVidCBpbiBVU0RDIGZyb20gbWF0dXJpdHk7IG9mZiB0YWtlcyB0aGF0CmFwcHJvdmFsIGJhY2suIEJvcnJvd2VyIG9ubHk7IHNldHRpbmcgdGhlIGN1cnJlbnQgdmFsdWUgaXMgYSBuby1vcC4AAAAAAA5zZXRfYXV0b19yZXBheQAAAAAAAgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAAAAAAdlbmFibGVkAAAAAAEAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAOc2V0X2xpcXVpZGF0b3IAAAAAAAIAAAAAAAAACmxpcXVpZGF0b3IAAAAAABMAAAAAAAAAB2FsbG93ZWQAAAAAAQAAAAA=",
        "AAAAAQAAAD9BIGxpdmUgb3Igc2V0dGxlZCByZXBvLCBjcmVhdGVkIHdoZW4gYSBib3Jyb3dlciB0YWtlcyBhbiBvZmZlci4AAAAAAAAAAARSZXBvAAAADgAAAIVCb3Jyb3dlciBvcHRlZCBpbiB0byBhdXRvLXJlcGF5IChERUNJU0lPTlMubWQgIzI3KTogZnJvbSBtYXR1cml0eSB0aGUKZGVidCBpcyBwdWxsZWQgZnJvbSB0aGVpciBVU0RDIGFsbG93YW5jZSBpbnN0ZWFkIG9mIGRlZmF1bHRpbmcuAAAAAAAACmF1dG9fcmVwYXkAAAAAAAEAAAAAAAAACGJvcnJvd2VyAAAAEwAAAIFDb2xsYXRlcmFsIGhlbGQgYnkgdGhlIGNvbnRyYWN0LCBpbiB0aGUgdG9rZW4ncyBvd24gdW5pdHMgKGl0cwpgZGVjaW1hbHMoKWA6IDcgZm9yIHRCRU5KSSwgNSBmb3IgU3Bpa28gdG9rZW5zOyBERUNJU0lPTlMubWQgIzI4KS4AAAAAAAARY29sbGF0ZXJhbF9hbW91bnQAAAAAAAALAAAAAAAAABBjb2xsYXRlcmFsX2Fzc2V0AAAAEwAAAH5TbmFwc2hvdCBvZiB0aGUgYXNzZXQgaGFpcmN1dCBhdCB0YWtlIHRpbWUuIFRoZSB0b3AtdXAgdGFyZ2V0OiBhCm1hcmdpbiBjYWxsIGNsZWFycyBvbmNlIGBsdHZfb2tgIGhvbGRzIGF0IHRoaXMgaGFpcmN1dCBhZ2Fpbi4AAAAAAAtoYWlyY3V0X2JwcwAAAAAEAAAAAAAAAAJpZAAAAAAABgAAAHdGdWxsLXRlcm0gaW50ZXJlc3QsIGZpeGVkIGF0IHRha2UgdGltZS4gRGVidCA9IHByaW5jaXBhbCArIGludGVyZXN0LAp0aGUgc2FtZSBhbW91bnQgb24gZWFybHkgcmVwYXkgKERFQ0lTSU9OUy5tZCAjMTUpLgAAAAAIaW50ZXJlc3QAAAALAAAAAAAAAAZsZW5kZXIAAAAAABMAAABBU2V0IG9uY2Ugb24gdGhlIGZpcnN0IG1hcmdpbiBicmVhY2g7IGNsZWFyZWQgYnkgYSBoZWFsdGh5IHRvcC11cC4AAAAAAAAUbWFyZ2luX2NhbGxfZGVhZGxpbmUAAAPoAAAABgAAAAAAAAALbWF0dXJpdHlfdHMAAAAABgAAAAAAAAAIb2ZmZXJfaWQAAAAGAAAAAAAAAAlwcmluY2lwYWwAAAAAAAALAAAAAAAAAAhzdGFydF90cwAAAAYAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAZTdGF0dXMAAA==",
        "AAAAAgAAAGpTRVAtNDAgYXNzZXQgaWRlbnRpZmllciwgc2FtZSBzaGFwZSBhcyBSZWZsZWN0b3Incywgc28gdGhlIG1vY2sgb3JhY2xlIGFuZApsaXZlIGZlZWRzIGFjY2VwdCBpdCB1bmNoYW5nZWQuAAAAAAAAAAAABUFzc2V0AAAAAAAAAgAAAAEAAAAAAAAAB1N0ZWxsYXIAAAAAAQAAABMAAAABAAAAAAAAAAVPdGhlcgAAAAAAAAEAAAAR",
        "AAAAAQAAAN9BIGxlbmRlcidzIHN0YW5kaW5nIG9mZmVyLiBUaGUgbGVuZGVyIHNldHMgb25seSBhc3NldCwgcHJpbmNpcGFsLCBBUFIgYW5kCnRlcm07IHRoZSBoYWlyY3V0IGNvbWVzIGZyb20gdGhlIGFzc2V0J3MgYEFzc2V0Q29uZmlnYC4gVGhlIHByaW5jaXBhbCBpcyBlc2Nyb3dlZCBpbiB0aGUgY29udHJhY3QKZnJvbSBgY3JlYXRlX29mZmVyYCB1bnRpbCBpdCBpcyB0YWtlbiBvciBjYW5jZWxsZWQuAAAAAAAAAAAFT2ZmZXIAAAAAAAAHAAAAAAAAAAdhcHJfYnBzAAAAAAQAAAA2Q29sbGF0ZXJhbCB0b2tlbiB0aGUgbGVuZGVyIGFjY2VwdHMgKGUuZy4gdEJFTkpJIFNBQykuAAAAAAAQY29sbGF0ZXJhbF9hc3NldAAAABMAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAAAmlkAAAAAAAGAAAAAAAAAAZsZW5kZXIAAAAAABMAAAAbVVNEQyBsZW50LCA3LWRlY2ltYWwgdW5pdHMuAAAAAAlwcmluY2lwYWwAAAAAAAALAAAAAAAAAAl0ZXJtX3NlY3MAAAAAAAAG",
        "AAAAAQAAAK9Qcm90b2NvbCBwYXJhbWV0ZXJzLCBzZXQgb25jZSBhdCBkZXBsb3kuIFN0b3JlZCBpbiBpbnN0YW5jZSBzdG9yYWdlLgoKQWxsIGR1cmF0aW9ucyBhcmUgY29uZmlnIHNvIHRoZSBkZW1vIGNhbiBjb21wcmVzcyB0aW1lIHdpdGhvdXQgdG91Y2hpbmcKY29udHJhY3QgbG9naWMgKERFQ0lTSU9OUy5tZCAjNSkuAAAAAAAAAAAGQ29uZmlnAAAAAAAJAAAAAAAAAAVhZG1pbgAAAAAAABMAAAByTGVuZ3RoIG9mIG9uZSAiZGF5IiBpbiBzZWNvbmRzLiA4Nl80MDAgaW4gcHJvZHVjdGlvbiwgNjAgaW4gdGhlIGRlbW8uCkludGVyZXN0IHVzZXMgYSAzNjUtZGF5IHllYXIgb2YgdGhpcyBsZW5ndGguAAAAAAAIZGF5X3NlY3MAAAAGAAAAPlByb3RvY29sIGZlZSBhcyBhIHNoYXJlIG9mIGludGVyZXN0LCBpbiBicHMgKERFQ0lTSU9OUy5tZCAjMykuAAAAAAAHZmVlX2JwcwAAAAAEAAAAO1RpbWUgYWZ0ZXIgbWF0dXJpdHkgYmVmb3JlIGFuIHVucGFpZCByZXBvIGNhbiBiZSBkZWZhdWx0ZWQuAAAAAApncmFjZV9zZWNzAAAAAAAGAAAAQExpcXVpZGF0b3IgYnV5cyBjb2xsYXRlcmFsIGF0IE5BViDDlyAoMSDiiJIgZGlzY291bnQpLiAyMDAgPSAyJS4AAAAYbGlxdWlkYXRpb25fZGlzY291bnRfYnBzAAAABAAAADJUaW1lIGEgYm9ycm93ZXIgaGFzIHRvIHRvcCB1cCBhZnRlciBhIG1hcmdpbiBjYWxsLgAAAAAAEm1hcmdpbl93aW5kb3dfc2VjcwAAAAAABgAAACVTRVAtNDAgcHJpY2UgZmVlZCBmb3IgY29sbGF0ZXJhbCBOQVYuAAAAAAAABm9yYWNsZQAAAAAAEwAAABpSZWNlaXZlcyB0aGUgcHJvdG9jb2wgZmVlLgAAAAAACHRyZWFzdXJ5AAAAEwAAABhDaXJjbGUgdGVzdG5ldCBVU0RDIFNBQy4AAAAEdXNkYwAAABM=",
        "AAAAAgAAAAAAAAAAAAAABlN0YXR1cwAAAAAABQAAAAAAAAAAAAAABE9wZW4AAAAAAAAAAAAAAApNYXJnaW5DYWxsAAAAAAAAAAAAAAAAAAZSZXBhaWQAAAAAAAAAAAAAAAAACURlZmF1bHRlZAAAAAAAAAAAAAAAAAAACkxpcXVpZGF0ZWQAAA==",
        "AAAAAQAAAJRQZXItY29sbGF0ZXJhbC1hc3NldCByaXNrIHBhcmFtZXRlcnMsIGFkbWluLXVwZGF0YWJsZSB3aXRob3V0IGEgcmVkZXBsb3kKKERFQ0lTSU9OUy5tZCAjMTMpLiBTdG9yZWQgaW4gaW5zdGFuY2Ugc3RvcmFnZSwga2V5ZWQgYnkgdGhlIHRva2VuIGFkZHJlc3MuAAAAAAAAAAtBc3NldENvbmZpZwAAAAAEAAAAPURpc2FibGVkIGFzc2V0cyByZWplY3QgbmV3IG9mZmVyczsgbGl2ZSByZXBvcyBhcmUgdW5hZmZlY3RlZC4AAAAAAAAHZW5hYmxlZAAAAAABAAAAk0luaXRpYWwgTFRWOiBgZGVidCDiiaQgdmFsdWUgw5cgKDEg4oiSIGhhaXJjdXQpYC4gQWx3YXlzIGFib3ZlCmBDb25maWcubGlxdWlkYXRpb25fZGlzY291bnRfYnBzYCwgc28gYSBtYXgtTFRWIHRha2Ugb3BlbnMgYmVsb3cgdGhlCm1hcmdpbiB0cmlnZ2VyLgAAAAALaGFpcmN1dF9icHMAAAAABAAAATxBIE5BViBvbGRlciB0aGFuIHRoaXMgYmxvY2tzIGB0YWtlX29mZmVyYCwgYGNoZWNrX21hcmdpbmAgYW5kCmBsaXF1aWRhdGVgIGZvciB0aGlzIGFzc2V0IChERUNJU0lPTlMubWQgIzYsICMxNywgIzI1KS4gTmV2ZXIgYmxvY2tzCmByZXBheWAgb3IgYHRvcF91cGAuIFBlciBhc3NldCBiZWNhdXNlIHB1YmxpY2F0aW9uIHNjaGVkdWxlcyBkaWZmZXI6CmEgZnVuZCB0aGF0IHByaW50cyBOQVYgb25seSBvbiBidXNpbmVzcyBkYXlzIG5lZWRzIH45NiBoIHRvIGNvdmVyIGEKd2Vla2VuZCwgYSBkYWlseS1wcmljZWQgdG9rZW4gbGVzcy4gTXVzdCBiZSA+IDAuAAAAEG1heF9uYXZfYWdlX3NlY3MAAAAGAAAAIEhvdyB0aGUgb3JhY2xlIG5hbWVzIHRoaXMgYXNzZXQuAAAADG9yYWNsZV9hc3NldAAAB9AAAAAFQXNzZXQAAAA=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAEAAAAAAAAAAOTm90SW1wbGVtZW50ZWQAAAAAAAEAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAACAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAwAAAAAAAAAMTWF0aE92ZXJmbG93AAAABAAAAAAAAAANT2ZmZXJOb3RGb3VuZAAAAAAAAAUAAAAAAAAADFJlcG9Ob3RGb3VuZAAAAAYAAAAAAAAADUludmFsaWRTdGF0dXMAAAAAAAAHAAAAOUNvbGxhdGVyYWwgYXNzZXQgaGFzIG5vIGBBc3NldENvbmZpZ2AsIG9yIGl0IGlzIGRpc2FibGVkLgAAAAAAABFBc3NldE5vdFN1cHBvcnRlZAAAAAAAAAgAAAAAAAAACFN0YWxlTmF2AAAACQAAAAAAAAAWSW5zdWZmaWNpZW50Q29sbGF0ZXJhbAAAAAAACgAAAAAAAAANTm90TGlxdWlkYXRvcgAAAAAAAAsAAAAAAAAADk5vdERlZmF1bHRhYmxlAAAAAAAMAAAAOU9yYWNsZSBoYXMgbm8gcHJpY2UgZm9yIHRoZSBhc3NldCwgb3IgaXQgaXMgbm90IHBvc2l0aXZlLgAAAAAAAAdOb1ByaWNlAAAAAA0AAAArYGF1dG9fcmVwYXlgIG9uIGEgcmVwbyB0aGF0IGRpZCBub3Qgb3B0IGluLgAAAAAMQXV0b1JlcGF5T2ZmAAAADgAAADlgYXV0b19yZXBheWAgYmVmb3JlIG1hdHVyaXR5IChhbmQgbm8gbWlzc2VkIG1hcmdpbiBjYWxsKS4AAAAAAAAGTm90RHVlAAAAAAAPAAAARFRoZSBVU0RDIHB1bGwgZmFpbGVkOiBzaG9ydCBiYWxhbmNlLCBhbGxvd2FuY2UgdG9vIHNtYWxsIG9yIGV4cGlyZWQuAAAAD0F1dG9SZXBheUZhaWxlZAAAAAAQ",
        "AAAABQAAAAAAAAAAAAAABlJlcGFpZAAAAAAAAQAAAAZyZXBhaWQAAAAAAAQAAAAAAAAAB3JlcG9faWQAAAAABgAAAAEAAAAAAAAADWxlbmRlcl9hbW91bnQAAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAARlRydWUgd2hlbiB0aGUgZGVidCB3YXMgcHVsbGVkIGJ5IGF1dG8tcmVwYXksIG5vdCBwYWlkIGJ5IHRoZSBib3Jyb3dlci4AAAAAAAlhdXRvbWF0aWMAAAAAAAABAAAAAAAAAAI=",
        "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" ]),
      options
    )
  }
  public readonly fromJSON = {
    repo: this.txFromJSON<Result<Repo>>,
        asset: this.txFromJSON<Result<AssetConfig>>,
        offer: this.txFromJSON<Result<Offer>>,
        repay: this.txFromJSON<Result<void>>,
        config: this.txFromJSON<Config>,
        top_up: this.txFromJSON<Result<void>>,
        default: this.txFromJSON<Result<Status>>,
        liquidate: this.txFromJSON<Result<void>>,
        set_asset: this.txFromJSON<Result<void>>,
        auto_repay: this.txFromJSON<Result<void>>,
        take_offer: this.txFromJSON<Result<u64>>,
        cancel_offer: this.txFromJSON<Result<void>>,
        check_margin: this.txFromJSON<Result<Status>>,
        create_offer: this.txFromJSON<Result<u64>>,
        is_liquidator: this.txFromJSON<boolean>,
        set_auto_repay: this.txFromJSON<Result<void>>,
        set_liquidator: this.txFromJSON<null>
  }
}