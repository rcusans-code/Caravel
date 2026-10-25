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
 * Per-asset emergency switches (DECISIONS.md #30), stored apart from
 * `AssetConfig` so re-tiering an asset never clears a pause. Each switch
 * stops one action and nothing else; `repay` and `top_up` have no switch.
 */
export interface Pause {
  /**
 * Blocks `create_offer` and `take_offer`, like `AssetConfig.enabled =
 * false` (an alias). `cancel_offer` still works.
 */
no_new_repos: boolean;
  /**
 * Blocks `default` (except an auto-repay settle) and `liquidate`. The
 * default clock keeps running; seizure waits until this clears.
 */
no_seize: boolean;
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
 * Can only make things safer, instantly (DECISIONS.md #32): disable an
 * asset, raise a haircut, lower a cap or NAV age, set pause switches,
 * cancel a pending proposal. It can never loosen anything.
 */
guardian: string;
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
 * Delay between `propose_*` and `execute_*` for every change that adds
 * risk (DECISIONS.md #32). 172_800 (2 days) in production, 120 in the
 * demo (#5). Must be > 0.
 */
timelock_secs: u64;
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
 * Exposure cap (DECISIONS.md #31): total debt (principal + interest, USDC
 * 7 decimals) of live repos on this asset. `take_offer` fails with
 * `CapExceeded` past it; 0 means no new repos. Exits (repay, auto-repay,
 * top-up, liquidate) are never blocked, and lowering the cap below the
 * open debt leaves live repos untouched. Must be ≥ 0.
 */
max_open_debt: i128;
  /**
 * How the oracle names this asset.
 */
oracle_asset: Asset;
}


/**
 * An admin `AssetConfig` change waiting out the timelock (DECISIONS.md #32).
 */
export interface PendingAsset {
  config: AssetConfig;
  /**
 * `execute_asset` works from this ledger timestamp on.
 */
eta: u64;
}


/**
 * An admin `Pause` change waiting out the timelock (DECISIONS.md #32).
 */
export interface PendingPause {
  /**
 * `execute_pause` works from this ledger timestamp on.
 */
eta: u64;
  pause: Pause;
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
  16: {message:"AutoRepayFailed"},
  /**
   * The asset's `no_new_repos` or `no_seize` switch blocks this call (#30).
   */
  17: {message:"Paused"},
  /**
   * `take_offer` would push the asset's open debt past `max_open_debt`.
   */
  18: {message:"CapExceeded"},
  /**
   * The change loosens risk: it must go through `propose_*`, wait out
   * `timelock_secs`, then `execute_*` (#32).
   */
  19: {message:"Loosens"},
  /**
   * `execute_*` before the proposal's `eta`.
   */
  20: {message:"TimelockNotDone"},
  /**
   * `execute_*` or `cancel_*` with no pending proposal for the asset.
   */
  21: {message:"NoProposal"},
  /**
   * `cancel_*` by someone who is neither admin nor guardian.
   */
  22: {message:"NotAdminOrGuardian"}
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
   * Construct and simulate a pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The asset's pause switches; all off for an asset never paused (#30).
   */
  pause: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Pause>>

  /**
   * Construct and simulate a repay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Borrower pays principal + full-term interest and gets the collateral
   * back. The lender receives exactly `principal + interest − fee`, the
   * treasury the fee (#3). Works from `Open` or `MarginCall`, before or
   * after maturity until someone calls `default`, and needs no NAV (#6).
   * No pause switch blocks it (#30).
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
   * No pause switch blocks it (#30).
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
   * 
   * While the asset's `no_seize` switch is on (#30) a repo that would
   * default returns `Paused` and stays `Open` / `MarginCall`, so the
   * borrower can still repay or top up. The clock is not extended: once the
   * switch clears, anyone can default it at once. Auto-repay still settles
   * under the switch: it is a repayment, not a seizure.
   */
  default: ({repo_id}: {repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Status>>>

  /**
   * Construct and simulate a liquidate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A whitelisted liquidator buys a defaulted repo's collateral at
   * NAV × (1 − discount), rounded up. The USDC goes lender first (capped at
   * principal + interest − fee), then the fee, then the borrower (#3, #4).
   * If proceeds fall short of what the lender is owed, the lender takes
   * everything and `Shortfall` is emitted. Stale NAV returns `StaleNav` (#6).
   * The asset's `no_seize` switch returns `Paused` (#30).
   */
  liquidate: ({liquidator, repo_id}: {liquidator: string, repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a open_debt transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Debt (principal + interest) of live repos on `asset`, the amount
   * counted against `AssetConfig.max_open_debt` (#31). 0 for an unknown asset.
   */
  open_debt: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a set_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds or re-tiers a collateral asset (DECISIONS.md #13). Requires
   * `liquidation_discount_bps < haircut_bps < 10_000`: a strictly larger
   * haircut means a take at max LTV opens strictly below the margin trigger.
   * Requires `max_nav_age_secs > 0` (staleness is per asset, #25) and
   * `max_open_debt ≥ 0` (#31). Re-setting an asset keeps its open debt;
   * a cap below it only stops new takes.
   * 
   * Instant only for a first listing (no offer can exist on an unlisted
   * asset) or a change that only tightens (#32: disable, raise the
   * haircut, lower the NAV age or the cap). Anything that loosens fails
   * with `Loosens`: use `propose_asset`. An instant change drops a
   * pending proposal for the asset, so it cannot undo the change later.
   */
  set_asset: ({asset, config}: {asset: string, config: AssetConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets an asset's pause switches (DECISIONS.md #30). Each one stops one
   * action: `no_new_repos` blocks `create_offer` / `take_offer`,
   * `no_seize` blocks `default` and `liquidate`. Nothing pauses `repay`
   * or `top_up`. Stored apart from `AssetConfig`, so `set_asset` never
   * clears a pause. Instant only for switching on (#32); clearing a
   * switch fails with `Loosens`: use `propose_pause`.
   */
  set_pause: ({asset, pause}: {asset: string, pause: Pause}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Rejects stale NAV (#6), an asset disabled since the offer was
   * posted (#23) and an asset paused with `no_new_repos` (#30). The
   * haircut is snapshotted on the repo (#19). Rejects with `CapExceeded`
   * if the asset's open debt plus this debt would pass `max_open_debt`
   * (#31); the offer stays on the board.
   * 
   * `auto_repay` opts in to auto-repay (#27): the same signature also
   * approves this contract to pull the debt in USDC from maturity.
   */
  take_offer: ({borrower, offer_id, auto_repay}: {borrower: string, offer_id: u64, auto_repay: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a cancel_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Drops the pending asset change. Admin or guardian, any time.
   */
  cancel_asset: ({caller, asset}: {caller: string, asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_offer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the escrowed USDC to the lender. Only the lender can cancel,
   * and only while the offer is untaken (a take removes it).
   */
  cancel_offer: ({offer_id}: {offer_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Drops the pending pause change. Admin or guardian, any time.
   */
  cancel_pause: ({caller, asset}: {caller: string, asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Rejects a missing or disabled asset with `AssetNotSupported` (#22),
   * and `Paused` while the asset's `no_new_repos` switch is on (#30).
   */
  create_offer: ({lender, collateral_asset, principal, apr_bps, term_secs}: {lender: string, collateral_asset: string, principal: i128, apr_bps: u32, term_secs: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a execute_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Applies the pending asset change once its `eta` has passed.
   */
  execute_asset: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Applies the pending pause change once its `eta` has passed.
   */
  execute_pause: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a is_liquidator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_liquidator: ({who}: {who: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a pending_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The admin asset change waiting out the timelock, if any (#32).
   */
  pending_asset: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingAsset>>>

  /**
   * Construct and simulate a pending_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The admin pause change waiting out the timelock, if any (#32).
   */
  pending_pause: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingPause>>>

  /**
   * Construct and simulate a propose_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Queues `config` for `asset`; `execute_asset` applies it from the
   * returned `eta` (now + `timelock_secs`). A new proposal replaces the
   * pending one and restarts the clock.
   */
  propose_asset: ({asset, config}: {asset: string, config: AssetConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a propose_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Queues pause switches for `asset` (typically clearing one);
   * `execute_pause` applies them from the returned `eta`.
   */
  propose_pause: ({asset, pause}: {asset: string, pause: Pause}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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

  /**
   * Construct and simulate a guardian_set_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The guardian's instant `set_asset` on a listed asset: disable it,
   * raise the haircut, lower the NAV age or the cap. Fails with
   * `Loosens` if any field adds risk, `AssetNotSupported` if unlisted.
   */
  guardian_set_asset: ({asset, config}: {asset: string, config: AssetConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a guardian_set_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The guardian's instant `set_pause`: can switch on, never off.
   */
  guardian_set_pause: ({asset, pause}: {asset: string, pause: Pause}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
        "AAAAAAAAAERUaGUgYXNzZXQncyBwYXVzZSBzd2l0Y2hlczsgYWxsIG9mZiBmb3IgYW4gYXNzZXQgbmV2ZXIgcGF1c2VkICgjMzApLgAAAAVwYXVzZQAAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAfQAAAABVBhdXNlAAAA",
        "AAAAAAAAATRCb3Jyb3dlciBwYXlzIHByaW5jaXBhbCArIGZ1bGwtdGVybSBpbnRlcmVzdCBhbmQgZ2V0cyB0aGUgY29sbGF0ZXJhbApiYWNrLiBUaGUgbGVuZGVyIHJlY2VpdmVzIGV4YWN0bHkgYHByaW5jaXBhbCArIGludGVyZXN0IOKIkiBmZWVgLCB0aGUKdHJlYXN1cnkgdGhlIGZlZSAoIzMpLiBXb3JrcyBmcm9tIGBPcGVuYCBvciBgTWFyZ2luQ2FsbGAsIGJlZm9yZSBvcgphZnRlciBtYXR1cml0eSB1bnRpbCBzb21lb25lIGNhbGxzIGBkZWZhdWx0YCwgYW5kIG5lZWRzIG5vIE5BViAoIzYpLgpObyBwYXVzZSBzd2l0Y2ggYmxvY2tzIGl0ICgjMzApLgAAAAVyZXBheQAAAAAAAAEAAAAAAAAAB3JlcG9faWQAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAGY29uZmlnAAAAAAAAAAAAAQAAB9AAAAAGQ29uZmlnAAA=",
        "AAAAAAAAANhBZGRzIGNvbGxhdGVyYWwuIENsZWFycyBhIG1hcmdpbiBjYWxsIG9uY2UKYGx0dl9vayhkZWJ0LCBjb2xsYXRlcmFsLCBuYXYsIGRlYywgcmVwby5oYWlyY3V0X2JwcylgIGhvbGRzLCBpLmUuIHRoZQppbml0aWFsIG1hcmdpbiBpcyByZXN0b3JlZCAoVHJhZEZpIGNvbnZlbnRpb24pLiBXb3JrcyB3aXRoIHN0YWxlIE5BVi4KTm8gcGF1c2Ugc3dpdGNoIGJsb2NrcyBpdCAoIzMwKS4AAAAGdG9wX3VwAAAAAAACAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAtRNb3ZlcyBhIHJlcG8gdG8gYERlZmF1bHRlZGAgb25jZSBpdCBpcyBwYXN0IG1hdHVyaXR5ICsgZ3JhY2UsIG9yIGluCmBNYXJnaW5DYWxsYCBwYXN0IGl0cyBgbWFyZ2luX2NhbGxfZGVhZGxpbmVgIChzZXQgYnkgYGNoZWNrX21hcmdpbmApLgpBbnlvbmUgY2FuIGNhbGwgaXQgKCM3KTsgaXQgbmVlZHMgbm8gTkFWICgjMTcpLiBCb3RoIGRlYWRsaW5lcyBhcmUKc3RyaWN0OiBhdCB0aGUgZXhhY3Qgc2Vjb25kIHRoZSBib3Jyb3dlciBjYW4gc3RpbGwgcmVwYXkgb3IgdG9wIHVwLgoKQW4gb3B0ZWQtaW4gcmVwbyB0cmllcyBhdXRvLXJlcGF5IGZpcnN0ICgjMjcpIGFuZCBzZXR0bGVzIGFzIGBSZXBhaWRgCndoZW4gdGhlIHB1bGwgc3VjY2VlZHMuIFJldHVybnMgdGhlIHJlc3VsdGluZyBzdGF0dXMuCgpXaGlsZSB0aGUgYXNzZXQncyBgbm9fc2VpemVgIHN3aXRjaCBpcyBvbiAoIzMwKSBhIHJlcG8gdGhhdCB3b3VsZApkZWZhdWx0IHJldHVybnMgYFBhdXNlZGAgYW5kIHN0YXlzIGBPcGVuYCAvIGBNYXJnaW5DYWxsYCwgc28gdGhlCmJvcnJvd2VyIGNhbiBzdGlsbCByZXBheSBvciB0b3AgdXAuIFRoZSBjbG9jayBpcyBub3QgZXh0ZW5kZWQ6IG9uY2UgdGhlCnN3aXRjaCBjbGVhcnMsIGFueW9uZSBjYW4gZGVmYXVsdCBpdCBhdCBvbmNlLiBBdXRvLXJlcGF5IHN0aWxsIHNldHRsZXMKdW5kZXIgdGhlIHN3aXRjaDogaXQgaXMgYSByZXBheW1lbnQsIG5vdCBhIHNlaXp1cmUuAAAAB2RlZmF1bHQAAAAAAQAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAA+kAAAfQAAAABlN0YXR1cwAAAAAAAw==",
        "AAAAAAAAAZZBIHdoaXRlbGlzdGVkIGxpcXVpZGF0b3IgYnV5cyBhIGRlZmF1bHRlZCByZXBvJ3MgY29sbGF0ZXJhbCBhdApOQVYgw5cgKDEg4oiSIGRpc2NvdW50KSwgcm91bmRlZCB1cC4gVGhlIFVTREMgZ29lcyBsZW5kZXIgZmlyc3QgKGNhcHBlZCBhdApwcmluY2lwYWwgKyBpbnRlcmVzdCDiiJIgZmVlKSwgdGhlbiB0aGUgZmVlLCB0aGVuIHRoZSBib3Jyb3dlciAoIzMsICM0KS4KSWYgcHJvY2VlZHMgZmFsbCBzaG9ydCBvZiB3aGF0IHRoZSBsZW5kZXIgaXMgb3dlZCwgdGhlIGxlbmRlciB0YWtlcwpldmVyeXRoaW5nIGFuZCBgU2hvcnRmYWxsYCBpcyBlbWl0dGVkLiBTdGFsZSBOQVYgcmV0dXJucyBgU3RhbGVOYXZgICgjNikuClRoZSBhc3NldCdzIGBub19zZWl6ZWAgc3dpdGNoIHJldHVybnMgYFBhdXNlZGAgKCMzMCkuAAAAAAAJbGlxdWlkYXRlAAAAAAAAAgAAAAAAAAAKbGlxdWlkYXRvcgAAAAAAEwAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAItEZWJ0IChwcmluY2lwYWwgKyBpbnRlcmVzdCkgb2YgbGl2ZSByZXBvcyBvbiBgYXNzZXRgLCB0aGUgYW1vdW50CmNvdW50ZWQgYWdhaW5zdCBgQXNzZXRDb25maWcubWF4X29wZW5fZGVidGAgKCMzMSkuIDAgZm9yIGFuIHVua25vd24gYXNzZXQuAAAAAAlvcGVuX2RlYnQAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAACw==",
        "AAAAAAAAAsZBZGRzIG9yIHJlLXRpZXJzIGEgY29sbGF0ZXJhbCBhc3NldCAoREVDSVNJT05TLm1kICMxMykuIFJlcXVpcmVzCmBsaXF1aWRhdGlvbl9kaXNjb3VudF9icHMgPCBoYWlyY3V0X2JwcyA8IDEwXzAwMGA6IGEgc3RyaWN0bHkgbGFyZ2VyCmhhaXJjdXQgbWVhbnMgYSB0YWtlIGF0IG1heCBMVFYgb3BlbnMgc3RyaWN0bHkgYmVsb3cgdGhlIG1hcmdpbiB0cmlnZ2VyLgpSZXF1aXJlcyBgbWF4X25hdl9hZ2Vfc2VjcyA+IDBgIChzdGFsZW5lc3MgaXMgcGVyIGFzc2V0LCAjMjUpIGFuZApgbWF4X29wZW5fZGVidCDiiaUgMGAgKCMzMSkuIFJlLXNldHRpbmcgYW4gYXNzZXQga2VlcHMgaXRzIG9wZW4gZGVidDsKYSBjYXAgYmVsb3cgaXQgb25seSBzdG9wcyBuZXcgdGFrZXMuCgpJbnN0YW50IG9ubHkgZm9yIGEgZmlyc3QgbGlzdGluZyAobm8gb2ZmZXIgY2FuIGV4aXN0IG9uIGFuIHVubGlzdGVkCmFzc2V0KSBvciBhIGNoYW5nZSB0aGF0IG9ubHkgdGlnaHRlbnMgKCMzMjogZGlzYWJsZSwgcmFpc2UgdGhlCmhhaXJjdXQsIGxvd2VyIHRoZSBOQVYgYWdlIG9yIHRoZSBjYXApLiBBbnl0aGluZyB0aGF0IGxvb3NlbnMgZmFpbHMKd2l0aCBgTG9vc2Vuc2A6IHVzZSBgcHJvcG9zZV9hc3NldGAuIEFuIGluc3RhbnQgY2hhbmdlIGRyb3BzIGEKcGVuZGluZyBwcm9wb3NhbCBmb3IgdGhlIGFzc2V0LCBzbyBpdCBjYW5ub3QgdW5kbyB0aGUgY2hhbmdlIGxhdGVyLgAAAAAACXNldF9hc3NldAAAAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAGY29uZmlnAAAAAAfQAAAAC0Fzc2V0Q29uZmlnAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAXtTZXRzIGFuIGFzc2V0J3MgcGF1c2Ugc3dpdGNoZXMgKERFQ0lTSU9OUy5tZCAjMzApLiBFYWNoIG9uZSBzdG9wcyBvbmUKYWN0aW9uOiBgbm9fbmV3X3JlcG9zYCBibG9ja3MgYGNyZWF0ZV9vZmZlcmAgLyBgdGFrZV9vZmZlcmAsCmBub19zZWl6ZWAgYmxvY2tzIGBkZWZhdWx0YCBhbmQgYGxpcXVpZGF0ZWAuIE5vdGhpbmcgcGF1c2VzIGByZXBheWAKb3IgYHRvcF91cGAuIFN0b3JlZCBhcGFydCBmcm9tIGBBc3NldENvbmZpZ2AsIHNvIGBzZXRfYXNzZXRgIG5ldmVyCmNsZWFycyBhIHBhdXNlLiBJbnN0YW50IG9ubHkgZm9yIHN3aXRjaGluZyBvbiAoIzMyKTsgY2xlYXJpbmcgYQpzd2l0Y2ggZmFpbHMgd2l0aCBgTG9vc2Vuc2A6IHVzZSBgcHJvcG9zZV9wYXVzZWAuAAAAAAlzZXRfcGF1c2UAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABXBhdXNlAAAAAAAH0AAAAAVQYXVzZQAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAVVSZXBheXMgYW4gb3B0ZWQtaW4gcmVwbyBmcm9tIHRoZSBib3Jyb3dlcidzIFVTREMgYWxsb3dhbmNlICgjMjcpLgpBbnlvbmUgY2FuIGNhbGwgaXQgZnJvbSBtYXR1cml0eSwgb3Igb25jZSBhIG1hcmdpbiBjYWxsJ3MgZGVhZGxpbmUgaGFzCnBhc3NlZC4gT24gc3VjY2VzcyB0aGUgcmVwbyBpcyBgUmVwYWlkYCBleGFjdGx5IGFzIGlmIHRoZSBib3Jyb3dlciBoYWQKY2FsbGVkIGByZXBheWAuIElmIHRoZSBwdWxsIGZhaWxzIHRoZSByZXBvIGlzIHVudG91Y2hlZCBhbmQgdGhlIGNhbGwKcmV0dXJucyBgQXV0b1JlcGF5RmFpbGVkYDsgdGhlIGJvcnJvd2VyIGNhbiBzdGlsbCByZXBheSBieSBoYW5kLgAAAAAAAAphdXRvX3JlcGF5AAAAAAABAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAA0FBdG9taWMgRHZQOiBjb2xsYXRlcmFsIGluLCBlc2Nyb3dlZCBVU0RDIG91dC4gUmV0dXJucyB0aGUgcmVwbyBpZC4KRnVsbCB0YWtlcyBvbmx5IChERUNJU0lPTlMubWQgIzE2KTogdGhlIGNvbnRyYWN0IGNvbXB1dGVzCmBjb2xsYXRlcmFsID0gcmVxdWlyZWRfY29sbGF0ZXJhbChkZWJ0LCBuYXYsIGRlYywgaGFpcmN1dClgLCByb3VuZGVkIHVwLAphbmQgZml4ZXMgZGVidCA9IHByaW5jaXBhbCArIGZ1bGwtdGVybSBpbnRlcmVzdCAoIzE1KS4gVGhlIGJvcnJvd2VyJ3MKYXV0aCBvbiB0aGUgU0FDIHRyYW5zZmVyIHBpbnMgdGhlIGV4YWN0IGFtb3VudCwgc28gaWYgTkFWIG1vdmVzIGJldHdlZW4Kc2ltdWxhdGUgYW5kIHN1Ym1pdCB0aGUgdHggZmFpbHMgaW5zdGVhZCBvZiBvdmVyY2hhcmdpbmcgKCMyMSkuCgpSZWplY3RzIHN0YWxlIE5BViAoIzYpLCBhbiBhc3NldCBkaXNhYmxlZCBzaW5jZSB0aGUgb2ZmZXIgd2FzCnBvc3RlZCAoIzIzKSBhbmQgYW4gYXNzZXQgcGF1c2VkIHdpdGggYG5vX25ld19yZXBvc2AgKCMzMCkuIFRoZQpoYWlyY3V0IGlzIHNuYXBzaG90dGVkIG9uIHRoZSByZXBvICgjMTkpLiBSZWplY3RzIHdpdGggYENhcEV4Y2VlZGVkYAppZiB0aGUgYXNzZXQncyBvcGVuIGRlYnQgcGx1cyB0aGlzIGRlYnQgd291bGQgcGFzcyBgbWF4X29wZW5fZGVidGAKKCMzMSk7IHRoZSBvZmZlciBzdGF5cyBvbiB0aGUgYm9hcmQuCgpgYXV0b19yZXBheWAgb3B0cyBpbiB0byBhdXRvLXJlcGF5ICgjMjcpOiB0aGUgc2FtZSBzaWduYXR1cmUgYWxzbwphcHByb3ZlcyB0aGlzIGNvbnRyYWN0IHRvIHB1bGwgdGhlIGRlYnQgaW4gVVNEQyBmcm9tIG1hdHVyaXR5LgAAAAAAAAp0YWtlX29mZmVyAAAAAAADAAAAAAAAAAhib3Jyb3dlcgAAABMAAAAAAAAACG9mZmVyX2lkAAAABgAAAAAAAAAKYXV0b19yZXBheQAAAAAAAQAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAADxEcm9wcyB0aGUgcGVuZGluZyBhc3NldCBjaGFuZ2UuIEFkbWluIG9yIGd1YXJkaWFuLCBhbnkgdGltZS4AAAAMY2FuY2VsX2Fzc2V0AAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAH1SZXR1cm5zIHRoZSBlc2Nyb3dlZCBVU0RDIHRvIHRoZSBsZW5kZXIuIE9ubHkgdGhlIGxlbmRlciBjYW4gY2FuY2VsLAphbmQgb25seSB3aGlsZSB0aGUgb2ZmZXIgaXMgdW50YWtlbiAoYSB0YWtlIHJlbW92ZXMgaXQpLgAAAAAAAAxjYW5jZWxfb2ZmZXIAAAABAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAADxEcm9wcyB0aGUgcGVuZGluZyBwYXVzZSBjaGFuZ2UuIEFkbWluIG9yIGd1YXJkaWFuLCBhbnkgdGltZS4AAAAMY2FuY2VsX3BhdXNlAAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAIBTZXRzIGBtYXJnaW5fY2FsbF9kZWFkbGluZWAgb24gdGhlIGZpcnN0IGBtYXJnaW5fYnJlYWNoZWRgLiBSZXR1cm5zIHRoZQpzdGF0dXMuIFN0YWxlIE5BViByZXR1cm5zIGBTdGFsZU5hdmAgKERFQ0lTSU9OUy5tZCAjMTcpLgAAAAxjaGVja19tYXJnaW4AAAABAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAB9AAAAAGU3RhdHVzAAAAAAAD",
        "AAAAAAAAAQdFc2Nyb3dzIGBwcmluY2lwYWxgIFVTREMgZnJvbSB0aGUgbGVuZGVyLiBSZXR1cm5zIHRoZSBvZmZlciBpZC4KVGhlIGhhaXJjdXQgY29tZXMgZnJvbSB0aGUgYXNzZXQncyBgQXNzZXRDb25maWdgLCBub3QgdGhlIGxlbmRlci4KUmVqZWN0cyBhIG1pc3Npbmcgb3IgZGlzYWJsZWQgYXNzZXQgd2l0aCBgQXNzZXROb3RTdXBwb3J0ZWRgICgjMjIpLAphbmQgYFBhdXNlZGAgd2hpbGUgdGhlIGFzc2V0J3MgYG5vX25ld19yZXBvc2Agc3dpdGNoIGlzIG9uICgjMzApLgAAAAAMY3JlYXRlX29mZmVyAAAABQAAAAAAAAAGbGVuZGVyAAAAAAATAAAAAAAAABBjb2xsYXRlcmFsX2Fzc2V0AAAAEwAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAHYXByX2JwcwAAAAAEAAAAAAAAAAl0ZXJtX3NlY3MAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAEAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAZDb25maWcAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAADtBcHBsaWVzIHRoZSBwZW5kaW5nIGFzc2V0IGNoYW5nZSBvbmNlIGl0cyBgZXRhYCBoYXMgcGFzc2VkLgAAAAANZXhlY3V0ZV9hc3NldAAAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAADtBcHBsaWVzIHRoZSBwZW5kaW5nIHBhdXNlIGNoYW5nZSBvbmNlIGl0cyBgZXRhYCBoYXMgcGFzc2VkLgAAAAANZXhlY3V0ZV9wYXVzZQAAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANaXNfbGlxdWlkYXRvcgAAAAAAAAEAAAAAAAAAA3dobwAAAAATAAAAAQAAAAE=",
        "AAAAAAAAAD5UaGUgYWRtaW4gYXNzZXQgY2hhbmdlIHdhaXRpbmcgb3V0IHRoZSB0aW1lbG9jaywgaWYgYW55ICgjMzIpLgAAAAAADXBlbmRpbmdfYXNzZXQAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAB9AAAAAMUGVuZGluZ0Fzc2V0",
        "AAAAAAAAAD5UaGUgYWRtaW4gcGF1c2UgY2hhbmdlIHdhaXRpbmcgb3V0IHRoZSB0aW1lbG9jaywgaWYgYW55ICgjMzIpLgAAAAAADXBlbmRpbmdfcGF1c2UAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAB9AAAAAMUGVuZGluZ1BhdXNl",
        "AAAAAAAAAKhRdWV1ZXMgYGNvbmZpZ2AgZm9yIGBhc3NldGA7IGBleGVjdXRlX2Fzc2V0YCBhcHBsaWVzIGl0IGZyb20gdGhlCnJldHVybmVkIGBldGFgIChub3cgKyBgdGltZWxvY2tfc2Vjc2ApLiBBIG5ldyBwcm9wb3NhbCByZXBsYWNlcyB0aGUKcGVuZGluZyBvbmUgYW5kIHJlc3RhcnRzIHRoZSBjbG9jay4AAAANcHJvcG9zZV9hc3NldAAAAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAGY29uZmlnAAAAAAfQAAAAC0Fzc2V0Q29uZmlnAAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAHFRdWV1ZXMgcGF1c2Ugc3dpdGNoZXMgZm9yIGBhc3NldGAgKHR5cGljYWxseSBjbGVhcmluZyBvbmUpOwpgZXhlY3V0ZV9wYXVzZWAgYXBwbGllcyB0aGVtIGZyb20gdGhlIHJldHVybmVkIGBldGFgLgAAAAAAAA1wcm9wb3NlX3BhdXNlAAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAVwYXVzZQAAAAAAB9AAAAAFUGF1c2UAAAAAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAMZUdXJucyBhdXRvLXJlcGF5IG9uIG9yIG9mZiBmb3IgYSBsaXZlIHJlcG8gKCMyNykuIE9uIGFwcHJvdmVzIHRoaXMKY29udHJhY3QgdG8gcHVsbCB0aGUgZGVidCBpbiBVU0RDIGZyb20gbWF0dXJpdHk7IG9mZiB0YWtlcyB0aGF0CmFwcHJvdmFsIGJhY2suIEJvcnJvd2VyIG9ubHk7IHNldHRpbmcgdGhlIGN1cnJlbnQgdmFsdWUgaXMgYSBuby1vcC4AAAAAAA5zZXRfYXV0b19yZXBheQAAAAAAAgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAAAAAAdlbmFibGVkAAAAAAEAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAOc2V0X2xpcXVpZGF0b3IAAAAAAAIAAAAAAAAACmxpcXVpZGF0b3IAAAAAABMAAAAAAAAAB2FsbG93ZWQAAAAAAQAAAAA=",
        "AAAAAAAAAMBUaGUgZ3VhcmRpYW4ncyBpbnN0YW50IGBzZXRfYXNzZXRgIG9uIGEgbGlzdGVkIGFzc2V0OiBkaXNhYmxlIGl0LApyYWlzZSB0aGUgaGFpcmN1dCwgbG93ZXIgdGhlIE5BViBhZ2Ugb3IgdGhlIGNhcC4gRmFpbHMgd2l0aApgTG9vc2Vuc2AgaWYgYW55IGZpZWxkIGFkZHMgcmlzaywgYEFzc2V0Tm90U3VwcG9ydGVkYCBpZiB1bmxpc3RlZC4AAAASZ3VhcmRpYW5fc2V0X2Fzc2V0AAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAtBc3NldENvbmZpZwAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAD1UaGUgZ3VhcmRpYW4ncyBpbnN0YW50IGBzZXRfcGF1c2VgOiBjYW4gc3dpdGNoIG9uLCBuZXZlciBvZmYuAAAAAAAAEmd1YXJkaWFuX3NldF9wYXVzZQAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAVwYXVzZQAAAAAAB9AAAAAFUGF1c2UAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAQAAAD9BIGxpdmUgb3Igc2V0dGxlZCByZXBvLCBjcmVhdGVkIHdoZW4gYSBib3Jyb3dlciB0YWtlcyBhbiBvZmZlci4AAAAAAAAAAARSZXBvAAAADgAAAIVCb3Jyb3dlciBvcHRlZCBpbiB0byBhdXRvLXJlcGF5IChERUNJU0lPTlMubWQgIzI3KTogZnJvbSBtYXR1cml0eSB0aGUKZGVidCBpcyBwdWxsZWQgZnJvbSB0aGVpciBVU0RDIGFsbG93YW5jZSBpbnN0ZWFkIG9mIGRlZmF1bHRpbmcuAAAAAAAACmF1dG9fcmVwYXkAAAAAAAEAAAAAAAAACGJvcnJvd2VyAAAAEwAAAIFDb2xsYXRlcmFsIGhlbGQgYnkgdGhlIGNvbnRyYWN0LCBpbiB0aGUgdG9rZW4ncyBvd24gdW5pdHMgKGl0cwpgZGVjaW1hbHMoKWA6IDcgZm9yIHRCRU5KSSwgNSBmb3IgU3Bpa28gdG9rZW5zOyBERUNJU0lPTlMubWQgIzI4KS4AAAAAAAARY29sbGF0ZXJhbF9hbW91bnQAAAAAAAALAAAAAAAAABBjb2xsYXRlcmFsX2Fzc2V0AAAAEwAAAH5TbmFwc2hvdCBvZiB0aGUgYXNzZXQgaGFpcmN1dCBhdCB0YWtlIHRpbWUuIFRoZSB0b3AtdXAgdGFyZ2V0OiBhCm1hcmdpbiBjYWxsIGNsZWFycyBvbmNlIGBsdHZfb2tgIGhvbGRzIGF0IHRoaXMgaGFpcmN1dCBhZ2Fpbi4AAAAAAAtoYWlyY3V0X2JwcwAAAAAEAAAAAAAAAAJpZAAAAAAABgAAAHdGdWxsLXRlcm0gaW50ZXJlc3QsIGZpeGVkIGF0IHRha2UgdGltZS4gRGVidCA9IHByaW5jaXBhbCArIGludGVyZXN0LAp0aGUgc2FtZSBhbW91bnQgb24gZWFybHkgcmVwYXkgKERFQ0lTSU9OUy5tZCAjMTUpLgAAAAAIaW50ZXJlc3QAAAALAAAAAAAAAAZsZW5kZXIAAAAAABMAAABBU2V0IG9uY2Ugb24gdGhlIGZpcnN0IG1hcmdpbiBicmVhY2g7IGNsZWFyZWQgYnkgYSBoZWFsdGh5IHRvcC11cC4AAAAAAAAUbWFyZ2luX2NhbGxfZGVhZGxpbmUAAAPoAAAABgAAAAAAAAALbWF0dXJpdHlfdHMAAAAABgAAAAAAAAAIb2ZmZXJfaWQAAAAGAAAAAAAAAAlwcmluY2lwYWwAAAAAAAALAAAAAAAAAAhzdGFydF90cwAAAAYAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAZTdGF0dXMAAA==",
        "AAAAAgAAAGpTRVAtNDAgYXNzZXQgaWRlbnRpZmllciwgc2FtZSBzaGFwZSBhcyBSZWZsZWN0b3Incywgc28gdGhlIG1vY2sgb3JhY2xlIGFuZApsaXZlIGZlZWRzIGFjY2VwdCBpdCB1bmNoYW5nZWQuAAAAAAAAAAAABUFzc2V0AAAAAAAAAgAAAAEAAAAAAAAAB1N0ZWxsYXIAAAAAAQAAABMAAAABAAAAAAAAAAVPdGhlcgAAAAAAAAEAAAAR",
        "AAAAAQAAAN9BIGxlbmRlcidzIHN0YW5kaW5nIG9mZmVyLiBUaGUgbGVuZGVyIHNldHMgb25seSBhc3NldCwgcHJpbmNpcGFsLCBBUFIgYW5kCnRlcm07IHRoZSBoYWlyY3V0IGNvbWVzIGZyb20gdGhlIGFzc2V0J3MgYEFzc2V0Q29uZmlnYC4gVGhlIHByaW5jaXBhbCBpcyBlc2Nyb3dlZCBpbiB0aGUgY29udHJhY3QKZnJvbSBgY3JlYXRlX29mZmVyYCB1bnRpbCBpdCBpcyB0YWtlbiBvciBjYW5jZWxsZWQuAAAAAAAAAAAFT2ZmZXIAAAAAAAAHAAAAAAAAAAdhcHJfYnBzAAAAAAQAAAA2Q29sbGF0ZXJhbCB0b2tlbiB0aGUgbGVuZGVyIGFjY2VwdHMgKGUuZy4gdEJFTkpJIFNBQykuAAAAAAAQY29sbGF0ZXJhbF9hc3NldAAAABMAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAAAmlkAAAAAAAGAAAAAAAAAAZsZW5kZXIAAAAAABMAAAAbVVNEQyBsZW50LCA3LWRlY2ltYWwgdW5pdHMuAAAAAAlwcmluY2lwYWwAAAAAAAALAAAAAAAAAAl0ZXJtX3NlY3MAAAAAAAAG",
        "AAAAAQAAANFQZXItYXNzZXQgZW1lcmdlbmN5IHN3aXRjaGVzIChERUNJU0lPTlMubWQgIzMwKSwgc3RvcmVkIGFwYXJ0IGZyb20KYEFzc2V0Q29uZmlnYCBzbyByZS10aWVyaW5nIGFuIGFzc2V0IG5ldmVyIGNsZWFycyBhIHBhdXNlLiBFYWNoIHN3aXRjaApzdG9wcyBvbmUgYWN0aW9uIGFuZCBub3RoaW5nIGVsc2U7IGByZXBheWAgYW5kIGB0b3BfdXBgIGhhdmUgbm8gc3dpdGNoLgAAAAAAAAAAAAAFUGF1c2UAAAAAAAACAAAAckJsb2NrcyBgY3JlYXRlX29mZmVyYCBhbmQgYHRha2Vfb2ZmZXJgLCBsaWtlIGBBc3NldENvbmZpZy5lbmFibGVkID0KZmFsc2VgIChhbiBhbGlhcykuIGBjYW5jZWxfb2ZmZXJgIHN0aWxsIHdvcmtzLgAAAAAADG5vX25ld19yZXBvcwAAAAEAAACBQmxvY2tzIGBkZWZhdWx0YCAoZXhjZXB0IGFuIGF1dG8tcmVwYXkgc2V0dGxlKSBhbmQgYGxpcXVpZGF0ZWAuIFRoZQpkZWZhdWx0IGNsb2NrIGtlZXBzIHJ1bm5pbmc7IHNlaXp1cmUgd2FpdHMgdW50aWwgdGhpcyBjbGVhcnMuAAAAAAAACG5vX3NlaXplAAAAAQ==",
        "AAAAAQAAAK9Qcm90b2NvbCBwYXJhbWV0ZXJzLCBzZXQgb25jZSBhdCBkZXBsb3kuIFN0b3JlZCBpbiBpbnN0YW5jZSBzdG9yYWdlLgoKQWxsIGR1cmF0aW9ucyBhcmUgY29uZmlnIHNvIHRoZSBkZW1vIGNhbiBjb21wcmVzcyB0aW1lIHdpdGhvdXQgdG91Y2hpbmcKY29udHJhY3QgbG9naWMgKERFQ0lTSU9OUy5tZCAjNSkuAAAAAAAAAAAGQ29uZmlnAAAAAAALAAAAAAAAAAVhZG1pbgAAAAAAABMAAAByTGVuZ3RoIG9mIG9uZSAiZGF5IiBpbiBzZWNvbmRzLiA4Nl80MDAgaW4gcHJvZHVjdGlvbiwgNjAgaW4gdGhlIGRlbW8uCkludGVyZXN0IHVzZXMgYSAzNjUtZGF5IHllYXIgb2YgdGhpcyBsZW5ndGguAAAAAAAIZGF5X3NlY3MAAAAGAAAAPlByb3RvY29sIGZlZSBhcyBhIHNoYXJlIG9mIGludGVyZXN0LCBpbiBicHMgKERFQ0lTSU9OUy5tZCAjMykuAAAAAAAHZmVlX2JwcwAAAAAEAAAAO1RpbWUgYWZ0ZXIgbWF0dXJpdHkgYmVmb3JlIGFuIHVucGFpZCByZXBvIGNhbiBiZSBkZWZhdWx0ZWQuAAAAAApncmFjZV9zZWNzAAAAAAAGAAAAwUNhbiBvbmx5IG1ha2UgdGhpbmdzIHNhZmVyLCBpbnN0YW50bHkgKERFQ0lTSU9OUy5tZCAjMzIpOiBkaXNhYmxlIGFuCmFzc2V0LCByYWlzZSBhIGhhaXJjdXQsIGxvd2VyIGEgY2FwIG9yIE5BViBhZ2UsIHNldCBwYXVzZSBzd2l0Y2hlcywKY2FuY2VsIGEgcGVuZGluZyBwcm9wb3NhbC4gSXQgY2FuIG5ldmVyIGxvb3NlbiBhbnl0aGluZy4AAAAAAAAIZ3VhcmRpYW4AAAATAAAAQExpcXVpZGF0b3IgYnV5cyBjb2xsYXRlcmFsIGF0IE5BViDDlyAoMSDiiJIgZGlzY291bnQpLiAyMDAgPSAyJS4AAAAYbGlxdWlkYXRpb25fZGlzY291bnRfYnBzAAAABAAAADJUaW1lIGEgYm9ycm93ZXIgaGFzIHRvIHRvcCB1cCBhZnRlciBhIG1hcmdpbiBjYWxsLgAAAAAAEm1hcmdpbl93aW5kb3dfc2VjcwAAAAAABgAAACVTRVAtNDAgcHJpY2UgZmVlZCBmb3IgY29sbGF0ZXJhbCBOQVYuAAAAAAAABm9yYWNsZQAAAAAAEwAAAKBEZWxheSBiZXR3ZWVuIGBwcm9wb3NlXypgIGFuZCBgZXhlY3V0ZV8qYCBmb3IgZXZlcnkgY2hhbmdlIHRoYXQgYWRkcwpyaXNrIChERUNJU0lPTlMubWQgIzMyKS4gMTcyXzgwMCAoMiBkYXlzKSBpbiBwcm9kdWN0aW9uLCAxMjAgaW4gdGhlCmRlbW8gKCM1KS4gTXVzdCBiZSA+IDAuAAAADXRpbWVsb2NrX3NlY3MAAAAAAAAGAAAAGlJlY2VpdmVzIHRoZSBwcm90b2NvbCBmZWUuAAAAAAAIdHJlYXN1cnkAAAATAAAAGENpcmNsZSB0ZXN0bmV0IFVTREMgU0FDLgAAAAR1c2RjAAAAEw==",
        "AAAAAgAAAAAAAAAAAAAABlN0YXR1cwAAAAAABQAAAAAAAAAAAAAABE9wZW4AAAAAAAAAAAAAAApNYXJnaW5DYWxsAAAAAAAAAAAAAAAAAAZSZXBhaWQAAAAAAAAAAAAAAAAACURlZmF1bHRlZAAAAAAAAAAAAAAAAAAACkxpcXVpZGF0ZWQAAA==",
        "AAAAAQAAAJRQZXItY29sbGF0ZXJhbC1hc3NldCByaXNrIHBhcmFtZXRlcnMsIGFkbWluLXVwZGF0YWJsZSB3aXRob3V0IGEgcmVkZXBsb3kKKERFQ0lTSU9OUy5tZCAjMTMpLiBTdG9yZWQgaW4gaW5zdGFuY2Ugc3RvcmFnZSwga2V5ZWQgYnkgdGhlIHRva2VuIGFkZHJlc3MuAAAAAAAAAAtBc3NldENvbmZpZwAAAAAFAAAAPURpc2FibGVkIGFzc2V0cyByZWplY3QgbmV3IG9mZmVyczsgbGl2ZSByZXBvcyBhcmUgdW5hZmZlY3RlZC4AAAAAAAAHZW5hYmxlZAAAAAABAAAAk0luaXRpYWwgTFRWOiBgZGVidCDiiaQgdmFsdWUgw5cgKDEg4oiSIGhhaXJjdXQpYC4gQWx3YXlzIGFib3ZlCmBDb25maWcubGlxdWlkYXRpb25fZGlzY291bnRfYnBzYCwgc28gYSBtYXgtTFRWIHRha2Ugb3BlbnMgYmVsb3cgdGhlCm1hcmdpbiB0cmlnZ2VyLgAAAAALaGFpcmN1dF9icHMAAAAABAAAATxBIE5BViBvbGRlciB0aGFuIHRoaXMgYmxvY2tzIGB0YWtlX29mZmVyYCwgYGNoZWNrX21hcmdpbmAgYW5kCmBsaXF1aWRhdGVgIGZvciB0aGlzIGFzc2V0IChERUNJU0lPTlMubWQgIzYsICMxNywgIzI1KS4gTmV2ZXIgYmxvY2tzCmByZXBheWAgb3IgYHRvcF91cGAuIFBlciBhc3NldCBiZWNhdXNlIHB1YmxpY2F0aW9uIHNjaGVkdWxlcyBkaWZmZXI6CmEgZnVuZCB0aGF0IHByaW50cyBOQVYgb25seSBvbiBidXNpbmVzcyBkYXlzIG5lZWRzIH45NiBoIHRvIGNvdmVyIGEKd2Vla2VuZCwgYSBkYWlseS1wcmljZWQgdG9rZW4gbGVzcy4gTXVzdCBiZSA+IDAuAAAAEG1heF9uYXZfYWdlX3NlY3MAAAAGAAABSkV4cG9zdXJlIGNhcCAoREVDSVNJT05TLm1kICMzMSk6IHRvdGFsIGRlYnQgKHByaW5jaXBhbCArIGludGVyZXN0LCBVU0RDCjcgZGVjaW1hbHMpIG9mIGxpdmUgcmVwb3Mgb24gdGhpcyBhc3NldC4gYHRha2Vfb2ZmZXJgIGZhaWxzIHdpdGgKYENhcEV4Y2VlZGVkYCBwYXN0IGl0OyAwIG1lYW5zIG5vIG5ldyByZXBvcy4gRXhpdHMgKHJlcGF5LCBhdXRvLXJlcGF5LAp0b3AtdXAsIGxpcXVpZGF0ZSkgYXJlIG5ldmVyIGJsb2NrZWQsIGFuZCBsb3dlcmluZyB0aGUgY2FwIGJlbG93IHRoZQpvcGVuIGRlYnQgbGVhdmVzIGxpdmUgcmVwb3MgdW50b3VjaGVkLiBNdXN0IGJlIOKJpSAwLgAAAAAADW1heF9vcGVuX2RlYnQAAAAAAAALAAAAIEhvdyB0aGUgb3JhY2xlIG5hbWVzIHRoaXMgYXNzZXQuAAAADG9yYWNsZV9hc3NldAAAB9AAAAAFQXNzZXQAAAA=",
        "AAAAAQAAAEpBbiBhZG1pbiBgQXNzZXRDb25maWdgIGNoYW5nZSB3YWl0aW5nIG91dCB0aGUgdGltZWxvY2sgKERFQ0lTSU9OUy5tZCAjMzIpLgAAAAAAAAAAAAxQZW5kaW5nQXNzZXQAAAACAAAAAAAAAAZjb25maWcAAAAAB9AAAAALQXNzZXRDb25maWcAAAAANGBleGVjdXRlX2Fzc2V0YCB3b3JrcyBmcm9tIHRoaXMgbGVkZ2VyIHRpbWVzdGFtcCBvbi4AAAADZXRhAAAAAAY=",
        "AAAAAQAAAERBbiBhZG1pbiBgUGF1c2VgIGNoYW5nZSB3YWl0aW5nIG91dCB0aGUgdGltZWxvY2sgKERFQ0lTSU9OUy5tZCAjMzIpLgAAAAAAAAAMUGVuZGluZ1BhdXNlAAAAAgAAADRgZXhlY3V0ZV9wYXVzZWAgd29ya3MgZnJvbSB0aGlzIGxlZGdlciB0aW1lc3RhbXAgb24uAAAAA2V0YQAAAAAGAAAAAAAAAAVwYXVzZQAAAAAAB9AAAAAFUGF1c2UAAAA=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAFgAAAAAAAAAOTm90SW1wbGVtZW50ZWQAAAAAAAEAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAACAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAwAAAAAAAAAMTWF0aE92ZXJmbG93AAAABAAAAAAAAAANT2ZmZXJOb3RGb3VuZAAAAAAAAAUAAAAAAAAADFJlcG9Ob3RGb3VuZAAAAAYAAAAAAAAADUludmFsaWRTdGF0dXMAAAAAAAAHAAAAOUNvbGxhdGVyYWwgYXNzZXQgaGFzIG5vIGBBc3NldENvbmZpZ2AsIG9yIGl0IGlzIGRpc2FibGVkLgAAAAAAABFBc3NldE5vdFN1cHBvcnRlZAAAAAAAAAgAAAAAAAAACFN0YWxlTmF2AAAACQAAAAAAAAAWSW5zdWZmaWNpZW50Q29sbGF0ZXJhbAAAAAAACgAAAAAAAAANTm90TGlxdWlkYXRvcgAAAAAAAAsAAAAAAAAADk5vdERlZmF1bHRhYmxlAAAAAAAMAAAAOU9yYWNsZSBoYXMgbm8gcHJpY2UgZm9yIHRoZSBhc3NldCwgb3IgaXQgaXMgbm90IHBvc2l0aXZlLgAAAAAAAAdOb1ByaWNlAAAAAA0AAAArYGF1dG9fcmVwYXlgIG9uIGEgcmVwbyB0aGF0IGRpZCBub3Qgb3B0IGluLgAAAAAMQXV0b1JlcGF5T2ZmAAAADgAAADlgYXV0b19yZXBheWAgYmVmb3JlIG1hdHVyaXR5IChhbmQgbm8gbWlzc2VkIG1hcmdpbiBjYWxsKS4AAAAAAAAGTm90RHVlAAAAAAAPAAAARFRoZSBVU0RDIHB1bGwgZmFpbGVkOiBzaG9ydCBiYWxhbmNlLCBhbGxvd2FuY2UgdG9vIHNtYWxsIG9yIGV4cGlyZWQuAAAAD0F1dG9SZXBheUZhaWxlZAAAAAAQAAAAR1RoZSBhc3NldCdzIGBub19uZXdfcmVwb3NgIG9yIGBub19zZWl6ZWAgc3dpdGNoIGJsb2NrcyB0aGlzIGNhbGwgKCMzMCkuAAAAAAZQYXVzZWQAAAAAABEAAABDYHRha2Vfb2ZmZXJgIHdvdWxkIHB1c2ggdGhlIGFzc2V0J3Mgb3BlbiBkZWJ0IHBhc3QgYG1heF9vcGVuX2RlYnRgLgAAAAALQ2FwRXhjZWVkZWQAAAAAEgAAAGpUaGUgY2hhbmdlIGxvb3NlbnMgcmlzazogaXQgbXVzdCBnbyB0aHJvdWdoIGBwcm9wb3NlXypgLCB3YWl0IG91dApgdGltZWxvY2tfc2Vjc2AsIHRoZW4gYGV4ZWN1dGVfKmAgKCMzMikuAAAAAAAHTG9vc2VucwAAAAATAAAAKGBleGVjdXRlXypgIGJlZm9yZSB0aGUgcHJvcG9zYWwncyBgZXRhYC4AAAAPVGltZWxvY2tOb3REb25lAAAAABQAAABBYGV4ZWN1dGVfKmAgb3IgYGNhbmNlbF8qYCB3aXRoIG5vIHBlbmRpbmcgcHJvcG9zYWwgZm9yIHRoZSBhc3NldC4AAAAAAAAKTm9Qcm9wb3NhbAAAAAAAFQAAADhgY2FuY2VsXypgIGJ5IHNvbWVvbmUgd2hvIGlzIG5laXRoZXIgYWRtaW4gbm9yIGd1YXJkaWFuLgAAABJOb3RBZG1pbk9yR3VhcmRpYW4AAAAAABY=",
        "AAAABQAAAAAAAAAAAAAABlJlcGFpZAAAAAAAAQAAAAZyZXBhaWQAAAAAAAQAAAAAAAAAB3JlcG9faWQAAAAABgAAAAEAAAAAAAAADWxlbmRlcl9hbW91bnQAAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAARlRydWUgd2hlbiB0aGUgZGVidCB3YXMgcHVsbGVkIGJ5IGF1dG8tcmVwYXksIG5vdCBwYWlkIGJ5IHRoZSBib3Jyb3dlci4AAAAAAAlhdXRvbWF0aWMAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAADdBZG1pbiBzZXQgYW4gYXNzZXQncyBwYXVzZSBzd2l0Y2hlcyAoREVDSVNJT05TLm1kICMzMCkuAAAAAAAAAAAIUGF1c2VTZXQAAAABAAAACXBhdXNlX3NldAAAAAAAAAMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAADG5vX25ld19yZXBvcwAAAAEAAAAAAAAAAAAAAAhub19zZWl6ZQAAAAEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACFRvcHBlZFVwAAAAAQAAAAl0b3BwZWRfdXAAAAAAAAAEAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAABFjb2xsYXRlcmFsX2Ftb3VudAAAAAAAAAsAAAAAAAAARVRydWUgd2hlbiB0aGUgdG9wLXVwIG1hZGUgdGhlIHJlcG8gaGVhbHRoeSBhbmQgY2xlYXJlZCBhIG1hcmdpbiBjYWxsLgAAAAAAAAdjbGVhcmVkAAAAAAEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACURlZmF1bHRlZAAAAAAAAAEAAAAJZGVmYXVsdGVkAAAAAAAAAQAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAAAI=",
        "AAAABQAAAHdMaXF1aWRhdGlvbiBwcm9jZWVkcyBkaWQgbm90IGNvdmVyIHdoYXQgdGhlIGxlbmRlciB3YXMgb3dlZAooREVDSVNJT05TLm1kICM0KS4gYGFtb3VudGAgaXMgdGhlIGxlbmRlcidzIHVucGFpZCBiYWxhbmNlLgAAAAAAAAAACVNob3J0ZmFsbAAAAAAAAAEAAAAJc2hvcnRmYWxsAAAAAAAAAgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAACkxpcXVpZGF0ZWQAAAAAAAEAAAAKbGlxdWlkYXRlZAAAAAAABgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAAAAAAAAKbGlxdWlkYXRvcgAAAAAAEwAAAAEAAAAAAAAACHByb2NlZWRzAAAACwAAAAAAAAAAAAAADWxlbmRlcl9hbW91bnQAAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAAAAAAA9ib3Jyb3dlcl9hbW91bnQAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACk1hcmdpbkNhbGwAAAAAAAEAAAALbWFyZ2luX2NhbGwAAAAAAgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAAAAAAI=",
        "AAAABQAAADdFbWl0dGVkIGJ5IGB0YWtlX29mZmVyYDogdGhlIER2UCBsZWcgdGhhdCBvcGVucyBhIHJlcG8uAAAAAAAAAAAKUmVwb09wZW5lZAAAAAAAAQAAAAtyZXBvX29wZW5lZAAAAAALAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAAAAAAAAZsZW5kZXIAAAAAABMAAAAAAAAAAAAAAAhib3Jyb3dlcgAAABMAAAAAAAAAAAAAABBjb2xsYXRlcmFsX2Fzc2V0AAAAEwAAAAAAAAAAAAAAEWNvbGxhdGVyYWxfYW1vdW50AAAAAAAACwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAAAAAAhpbnRlcmVzdAAAAAsAAAAAAAAAJ0Fzc2V0IGhhaXJjdXQgc25hcHNob3R0ZWQgYXQgdGFrZSB0aW1lLgAAAAALaGFpcmN1dF9icHMAAAAABAAAAAAAAAAAAAAAC21hdHVyaXR5X3RzAAAAAAYAAAAAAAAAAAAAAAphdXRvX3JlcGF5AAAAAAABAAAAAAAAAAI=",
        "AAAABQAAADtCb3Jyb3dlciB0dXJuZWQgYXV0by1yZXBheSBvbiBvciBvZmYgZm9yIGEgbGl2ZSByZXBvICgjMjcpLgAAAAAAAAAADEF1dG9SZXBheVNldAAAAAEAAAAOYXV0b19yZXBheV9zZXQAAAAAAAIAAAAAAAAAB3JlcG9faWQAAAAABgAAAAEAAAAAAAAAB2VuYWJsZWQAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADE9mZmVyQ3JlYXRlZAAAAAEAAAANb2ZmZXJfY3JlYXRlZAAAAAAAAAYAAAAAAAAACG9mZmVyX2lkAAAABgAAAAEAAAAAAAAABmxlbmRlcgAAAAAAEwAAAAEAAAAAAAAAEGNvbGxhdGVyYWxfYXNzZXQAAAATAAAAAAAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAAAAAAB2Fwcl9icHMAAAAABAAAAAAAAAAAAAAACXRlcm1fc2VjcwAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADk9mZmVyQ2FuY2VsbGVkAAAAAAABAAAAD29mZmVyX2NhbmNlbGxlZAAAAAADAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAAAAAAAAZsZW5kZXIAAAAAABMAAAABAAAAHFVTREMgcmV0dXJuZWQgdG8gdGhlIGxlbmRlci4AAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAD9BZG1pbiBhZGRlZCBvciByZS10aWVyZWQgYSBjb2xsYXRlcmFsIGFzc2V0IChERUNJU0lPTlMubWQgIzEzKS4AAAAAAAAAAA9Bc3NldENvbmZpZ3VyZWQAAAAAAQAAABBhc3NldF9jb25maWd1cmVkAAAABQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAALaGFpcmN1dF9icHMAAAAABAAAAAAAAAAAAAAAB2VuYWJsZWQAAAAAAQAAAAAAAAAAAAAAEG1heF9uYXZfYWdlX3NlY3MAAAAGAAAAAAAAAAAAAAANbWF4X29wZW5fZGVidAAAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAGpBIHByb3Bvc2FsIHRvb2sgZWZmZWN0LiBga2luZGAgaXMgYGFzc2V0YCBvciBgcGF1c2VgOyB0aGUgbWF0Y2hpbmcKYEFzc2V0Q29uZmlndXJlZGAgLyBgUGF1c2VTZXRgIGZvbGxvd3MuAAAAAAAAAAAAEFByb3Bvc2FsRXhlY3V0ZWQAAAABAAAAEXByb3Bvc2FsX2V4ZWN1dGVkAAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAEa2luZAAAABEAAAABAAAAAg==",
        "AAAABQAAAIVBIHByb3Bvc2FsIHdhcyBkcm9wcGVkOiBjYW5jZWxsZWQgYnkgYWRtaW4gb3IgZ3VhcmRpYW4sIG9yIHN1cGVyc2VkZWQKYnkgYW4gaW5zdGFudCBjaGFuZ2UgdG8gdGhlIHNhbWUgYXNzZXQgKGBieWAgbWFkZSB0aGF0IGNoYW5nZSkuAAAAAAAAAAAAABFQcm9wb3NhbENhbmNlbGxlZAAAAAAAAAEAAAAScHJvcG9zYWxfY2FuY2VsbGVkAAAAAAADAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAARraW5kAAAAEQAAAAEAAAAAAAAAAmJ5AAAAAAATAAAAAAAAAAI=",
        "AAAABQAAAERBZG1pbiBxdWV1ZWQgYW4gYXNzZXQgY2hhbmdlIGJlaGluZCB0aGUgdGltZWxvY2sgKERFQ0lTSU9OUy5tZCAjMzIpLgAAAAAAAAATQXNzZXRDaGFuZ2VQcm9wb3NlZAAAAAABAAAAFWFzc2V0X2NoYW5nZV9wcm9wb3NlZAAAAAAAAAYAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAAA2V0YQAAAAAGAAAAAAAAAAAAAAALaGFpcmN1dF9icHMAAAAABAAAAAAAAAAAAAAAB2VuYWJsZWQAAAAAAQAAAAAAAAAAAAAAEG1heF9uYXZfYWdlX3NlY3MAAAAGAAAAAAAAAAAAAAANbWF4X29wZW5fZGVidAAAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAENBZG1pbiBxdWV1ZWQgYSBwYXVzZSBjaGFuZ2UgYmVoaW5kIHRoZSB0aW1lbG9jayAoREVDSVNJT05TLm1kICMzMikuAAAAAAAAAAATUGF1c2VDaGFuZ2VQcm9wb3NlZAAAAAABAAAAFXBhdXNlX2NoYW5nZV9wcm9wb3NlZAAAAAAAAAQAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAAA2V0YQAAAAAGAAAAAAAAAAAAAAAMbm9fbmV3X3JlcG9zAAAAAQAAAAAAAAAAAAAACG5vX3NlaXplAAAAAQAAAAAAAAAC" ]),
      options
    )
  }
  public readonly fromJSON = {
    repo: this.txFromJSON<Result<Repo>>,
        asset: this.txFromJSON<Result<AssetConfig>>,
        offer: this.txFromJSON<Result<Offer>>,
        pause: this.txFromJSON<Pause>,
        repay: this.txFromJSON<Result<void>>,
        config: this.txFromJSON<Config>,
        top_up: this.txFromJSON<Result<void>>,
        default: this.txFromJSON<Result<Status>>,
        liquidate: this.txFromJSON<Result<void>>,
        open_debt: this.txFromJSON<i128>,
        set_asset: this.txFromJSON<Result<void>>,
        set_pause: this.txFromJSON<Result<void>>,
        auto_repay: this.txFromJSON<Result<void>>,
        take_offer: this.txFromJSON<Result<u64>>,
        cancel_asset: this.txFromJSON<Result<void>>,
        cancel_offer: this.txFromJSON<Result<void>>,
        cancel_pause: this.txFromJSON<Result<void>>,
        check_margin: this.txFromJSON<Result<Status>>,
        create_offer: this.txFromJSON<Result<u64>>,
        execute_asset: this.txFromJSON<Result<void>>,
        execute_pause: this.txFromJSON<Result<void>>,
        is_liquidator: this.txFromJSON<boolean>,
        pending_asset: this.txFromJSON<Option<PendingAsset>>,
        pending_pause: this.txFromJSON<Option<PendingPause>>,
        propose_asset: this.txFromJSON<Result<u64>>,
        propose_pause: this.txFromJSON<Result<u64>>,
        set_auto_repay: this.txFromJSON<Result<void>>,
        set_liquidator: this.txFromJSON<null>,
        guardian_set_asset: this.txFromJSON<Result<void>>,
        guardian_set_pause: this.txFromJSON<Result<void>>
  }
}