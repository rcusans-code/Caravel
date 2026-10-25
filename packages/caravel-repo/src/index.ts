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
    contractId: "CDMLJAW5C6L5S66TMBHOOMJBR5PVWNJ7VABEMMOYSKH2ZJ7Y4AFZ5JEX",
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
 * Can only make things safer, instantly (DECISIONS.md #33): disable an
 * asset, raise a haircut, lower a cap or NAV age, narrow the NAV band,
 * set pause switches, cancel a pending proposal. It can never loosen anything.
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
 * risk (DECISIONS.md #33). 172_800 (2 days) in production, 120 in the
 * demo (#5). Must be >= 60.
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
 * `margin_trigger_bps`, so a max-LTV take opens below the margin trigger.
 */
haircut_bps: u32;
  /**
 * Margin trigger (DECISIONS.md #14, #26): a margin call fires once
 * `debt > value × (1 − margin_trigger_bps)`. Must satisfy
 * `Config.liquidation_discount_bps ≤ margin_trigger_bps < haircut_bps`.
 * Above the discount, a liquidation at the call line still pays the
 * lender `(1 − discount) / (1 − trigger) − 1` over the debt (250 vs 200:
 * 0.51%), a buffer for the NAV move during the margin window. Applies to
 * live repos at once; raising it is a tightening (#33).
 */
margin_trigger_bps: u32;
  /**
 * A NAV older than this blocks `take_offer`, `check_margin` and
 * `liquidate` for this asset (DECISIONS.md #6, #17, #25). Never blocks
 * `repay` or `top_up`. Per asset because publication schedules differ:
 * a fund that prints NAV only on business days needs ~96 h to cover a
 * weekend, a daily-priced token less. Must be > 0.
 */
max_nav_age_secs: u64;
  /**
 * NAV sanity band (DECISIONS.md #31): the latest NAV may differ from
 * every one of the oracle's last `oracle::NAV_BAND_RECORDS` records by
 * at most this many bps, else `NavOutOfBand`. Measuring against the
 * whole window, not just the previous record, means re-posts of a bad
 * price cannot hide the jump. Blocks `take_offer`, `check_margin` and
 * `liquidate`, the same set as a stale NAV; never `repay` or `top_up`.
 * Must be > 0.
 */
max_nav_move_bps: u32;
  /**
 * Exposure cap (DECISIONS.md #32): total debt (principal + interest, USDC
 * 7 decimals) of live repos on this asset. `take_offer` fails with
 * `CapExceeded` past it; 0 means no new repos. Exits (repay, auto-repay,
 * top-up, liquidate) are never blocked, and lowering the cap below the
 * open debt leaves live repos untouched. Must be ≥ 0.
 */
max_open_debt: i128;
  nav_ceiling: Option<i128>;
  /**
 * Optional hard bounds on the latest NAV, in the feed's own scale
 * (`decimals()`), inclusive. Same effect as the move limit. If set,
 * each must be > 0 and `nav_floor <= nav_ceiling`.
 */
nav_floor: Option<i128>;
  /**
 * How the oracle names this asset.
 */
oracle_asset: Asset;
}


/**
 * An admin `AssetConfig` change waiting out the timelock (DECISIONS.md #33).
 */
export interface PendingAsset {
  config: AssetConfig;
  /**
 * `execute_asset` works from this ledger timestamp on.
 */
eta: u64;
}


/**
 * An admin `Pause` change waiting out the timelock (DECISIONS.md #33).
 */
export interface PendingPause {
  /**
 * `execute_pause` works from this ledger timestamp on.
 */
eta: u64;
  pause: Pause;
}

/**
 * Why `default` moved a repo to `Defaulted` (carried by the `Defaulted` event).
 */
export type DefaultReason = {tag: "Maturity", values: void} | {tag: "MarginCall", values: void};

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
   * The USDC pull failed (short balance, allowance too small or expired),
   * or the collateral could not be returned to the borrower.
   */
  16: {message:"AutoRepayFailed"},
  /**
   * The asset's `no_new_repos` or `no_seize` switch blocks this call (#30).
   */
  17: {message:"Paused"},
  /**
   * NAV outside the asset's sanity band: beyond `nav_floor` / `nav_ceiling`,
   * or more than `max_nav_move_bps` from a recent oracle record (#31).
   */
  18: {message:"NavOutOfBand"},
  /**
   * `take_offer` would push the asset's open debt past `max_open_debt` (#32).
   */
  19: {message:"CapExceeded"},
  /**
   * The change loosens risk: it must go through `propose_*`, wait out
   * `timelock_secs`, then `execute_*` (#33).
   */
  20: {message:"Loosens"},
  /**
   * `execute_*` before the proposal's `eta`.
   */
  21: {message:"TimelockNotDone"},
  /**
   * `execute_*` or `cancel_*` with no pending proposal for the asset.
   */
  22: {message:"NoProposal"},
  /**
   * `cancel_*` by someone who is neither admin nor guardian.
   */
  23: {message:"NotAdminOrGuardian"},
  /**
   * `claim` by an address with no parked USDC payout.
   */
  24: {message:"NothingToClaim"}
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
   * Construct and simulate a claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pays `who` its whole parked USDC balance and returns the amount.
   * `who` signs. Fails with `NothingToClaim` if nothing is parked; if the
   * transfer still fails (account still frozen) the call reverts and the
   * balance stays parked.
   */
  claim: ({who}: {who: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

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
   * treasury the fee (#3). Works from `Open`, `MarginCall` or `Defaulted`,
   * before or after maturity until a liquidation lands, at the same fixed
   * debt, and needs no NAV (#6). No pause switch blocks it (#30). The
   * borrower pays the debt into the contract; a lender or treasury payout
   * that fails (frozen account) is parked for `claim` and the repay still
   * lands.
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
   * initial margin is restored (TradFi convention). Works with stale NAV
   * and with NAV outside the sanity band; an out-of-band NAV never clears
   * a call (#31). No pause switch blocks it (#30).
   */
  top_up: ({repo_id, amount}: {repo_id: u64, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a default transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Moves a repo to `Defaulted` once it is past maturity + grace, or in
   * `MarginCall` past its `margin_call_deadline` (set by `check_margin`).
   * Anyone can call it (#7); a maturity default needs no NAV (#17). Both
   * deadlines are strict: at the exact second the borrower can still repay
   * or top up.
   * 
   * A missed call first re-checks the breach at a fresh, in-band NAV
   * (#20): no longer past the trigger, it returns to `Open` and emits
   * `MarginCleared`. Still past it, it defaults. With no price, a stale
   * NAV or one outside the sanity band it returns `NoPrice` / `StaleNav` /
   * `NavOutOfBand` and waits: a missed call defaults only on a fresh,
   * in-band NAV that confirms the breach. Maturity defaults never read the
   * NAV.
   * 
   * An opted-in repo tries auto-repay first (#27) and settles as `Repaid`
   * when the pull succeeds and the collateral can be returned; otherwise
   * the pull is refunded and the repo defaults. Returns the resulting
   * status.
   * 
   * While the asset's `no_seize` switch is on (#30) a repo that would
   * default returns `Paused` and stays `Open`
   */
  default: ({repo_id}: {repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Status>>>

  /**
   * Construct and simulate a claimable transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * USDC parked for `who` because a payout to it failed (frozen account,
   * closed trustline); `claim` pays it out. 0 if none.
   */
  claimable: ({who}: {who: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a liquidate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A whitelisted liquidator buys a defaulted repo's collateral at
   * NAV × (1 − discount), rounded up. The USDC goes lender first (capped at
   * principal + interest − fee), then the fee, then the borrower (#3, #4).
   * If proceeds fall short of what the lender is owed, the lender takes
   * everything and `Shortfall` is emitted. Stale NAV returns `StaleNav` (#6),
   * NAV outside the asset's sanity band `NavOutOfBand` (#31). The asset's
   * `no_seize` switch returns `Paused` (#30). The repo's own borrower is
   * never a liquidator of it (`NotLiquidator`), whitelisted or not. The
   * liquidator pays the proceeds into the contract; a lender, treasury or
   * borrower payout that fails (frozen account) is parked for `claim` and
   * the liquidation still lands.
   */
  liquidate: ({liquidator, repo_id}: {liquidator: string, repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a open_debt transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Debt (principal + interest) of live repos on `asset`, the amount
   * counted against `AssetConfig.max_open_debt` (#32). 0 for an unknown asset.
   */
  open_debt: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a set_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds or re-tiers a collateral asset (DECISIONS.md #13). Requires
   * `liquidation_discount_bps ≤ margin_trigger_bps < haircut_bps < 10_000`
   * (#26): a take at max LTV opens strictly below the margin trigger, and a
   * liquidation at the trigger line still covers the debt.
   * Requires `max_nav_age_secs > 0` (staleness is per asset, #25), a
   * valid NAV sanity band (#31): `max_nav_move_bps > 0`, each bound > 0 if
   * set, and `nav_floor <= nav_ceiling`, and `max_open_debt ≥ 0` (#32).
   * Re-setting an asset keeps its open debt; a cap below it only stops new
   * takes.
   * 
   * Instant only for a first listing (no offer can exist on an unlisted
   * asset) or a change that only tightens (#33: disable, raise the
   * haircut or the margin trigger, lower the NAV age or the cap, narrow
   * the NAV band). Anything
   * that loosens fails with `Loosens`: use `propose_asset`. An instant
   * change drops a pending proposal for the asset, so it cannot undo the
   * change later.
   */
  set_asset: ({asset, config}: {asset: string, config: AssetConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets an asset's pause switches (DECISIONS.md #30). Each one stops one
   * action: `no_new_repos` blocks `create_offer` / `take_offer`,
   * `no_seize` blocks `default` and `liquidate`. Nothing pauses `repay`
   * or `top_up`. Stored apart from `AssetConfig`, so `set_asset` never
   * clears a pause. Instant only for switching on (#33); clearing a
   * switch fails with `Loosens`: use `propose_pause`.
   */
  set_pause: ({asset, pause}: {asset: string, pause: Pause}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a auto_repay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Repays an opted-in repo from the borrower's USDC allowance (#27).
   * Anyone can call it from maturity, or once a margin call's deadline has
   * passed. On success the repo is `Repaid` exactly as if the borrower had
   * called `repay`. If the pull fails, or the collateral cannot be returned
   * to the borrower, the repo is untouched and the call returns
   * `AutoRepayFailed`; the borrower can still repay by hand.
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
   * Rejects stale NAV (#6), NAV outside the asset's sanity band (#31), an
   * asset disabled since the offer was posted (#23) and an asset paused
   * with `no_new_repos` (#30). The haircut is snapshotted on the repo (#19).
   * Rejects with `CapExceeded` if the asset's open debt plus this debt
   * would pass `max_open_debt` (#32); the offer stays on the board.
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
   * status. Stale NAV returns `StaleNav` (DECISIONS.md #17), NAV outside
   * the asset's sanity band `NavOutOfBand` (#31).
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
   * The admin asset change waiting out the timelock, if any (#33).
   */
  pending_asset: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingAsset>>>

  /**
   * Construct and simulate a pending_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The admin pause change waiting out the timelock, if any (#33).
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
   * raise the haircut or the margin trigger, lower the NAV age or the cap,
   * narrow the NAV band. Fails with
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
        "AAAAAAAAAOFQYXlzIGB3aG9gIGl0cyB3aG9sZSBwYXJrZWQgVVNEQyBiYWxhbmNlIGFuZCByZXR1cm5zIHRoZSBhbW91bnQuCmB3aG9gIHNpZ25zLiBGYWlscyB3aXRoIGBOb3RoaW5nVG9DbGFpbWAgaWYgbm90aGluZyBpcyBwYXJrZWQ7IGlmIHRoZQp0cmFuc2ZlciBzdGlsbCBmYWlscyAoYWNjb3VudCBzdGlsbCBmcm96ZW4pIHRoZSBjYWxsIHJldmVydHMgYW5kIHRoZQpiYWxhbmNlIHN0YXlzIHBhcmtlZC4AAAAAAAAFY2xhaW0AAAAAAAABAAAAAAAAAAN3aG8AAAAAEwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAFb2ZmZXIAAAAAAAABAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAD6QAAB9AAAAAFT2ZmZXIAAAAAAAAD",
        "AAAAAAAAAERUaGUgYXNzZXQncyBwYXVzZSBzd2l0Y2hlczsgYWxsIG9mZiBmb3IgYW4gYXNzZXQgbmV2ZXIgcGF1c2VkICgjMzApLgAAAAVwYXVzZQAAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAfQAAAABVBhdXNlAAAA",
        "AAAAAAAAAexCb3Jyb3dlciBwYXlzIHByaW5jaXBhbCArIGZ1bGwtdGVybSBpbnRlcmVzdCBhbmQgZ2V0cyB0aGUgY29sbGF0ZXJhbApiYWNrLiBUaGUgbGVuZGVyIHJlY2VpdmVzIGV4YWN0bHkgYHByaW5jaXBhbCArIGludGVyZXN0IOKIkiBmZWVgLCB0aGUKdHJlYXN1cnkgdGhlIGZlZSAoIzMpLiBXb3JrcyBmcm9tIGBPcGVuYCwgYE1hcmdpbkNhbGxgIG9yIGBEZWZhdWx0ZWRgLApiZWZvcmUgb3IgYWZ0ZXIgbWF0dXJpdHkgdW50aWwgYSBsaXF1aWRhdGlvbiBsYW5kcywgYXQgdGhlIHNhbWUgZml4ZWQKZGVidCwgYW5kIG5lZWRzIG5vIE5BViAoIzYpLiBObyBwYXVzZSBzd2l0Y2ggYmxvY2tzIGl0ICgjMzApLiBUaGUKYm9ycm93ZXIgcGF5cyB0aGUgZGVidCBpbnRvIHRoZSBjb250cmFjdDsgYSBsZW5kZXIgb3IgdHJlYXN1cnkgcGF5b3V0CnRoYXQgZmFpbHMgKGZyb3plbiBhY2NvdW50KSBpcyBwYXJrZWQgZm9yIGBjbGFpbWAgYW5kIHRoZSByZXBheSBzdGlsbApsYW5kcy4AAAAFcmVwYXkAAAAAAAABAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAGY29uZmlnAAAAAAAAAAAAAQAAB9AAAAAGQ29uZmlnAAA=",
        "AAAAAAAAAStBZGRzIGNvbGxhdGVyYWwuIENsZWFycyBhIG1hcmdpbiBjYWxsIG9uY2UKYGx0dl9vayhkZWJ0LCBjb2xsYXRlcmFsLCBuYXYsIGRlYywgcmVwby5oYWlyY3V0X2JwcylgIGhvbGRzLCBpLmUuIHRoZQppbml0aWFsIG1hcmdpbiBpcyByZXN0b3JlZCAoVHJhZEZpIGNvbnZlbnRpb24pLiBXb3JrcyB3aXRoIHN0YWxlIE5BVgphbmQgd2l0aCBOQVYgb3V0c2lkZSB0aGUgc2FuaXR5IGJhbmQ7IGFuIG91dC1vZi1iYW5kIE5BViBuZXZlciBjbGVhcnMKYSBjYWxsICgjMzEpLiBObyBwYXVzZSBzd2l0Y2ggYmxvY2tzIGl0ICgjMzApLgAAAAAGdG9wX3VwAAAAAAACAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAABABNb3ZlcyBhIHJlcG8gdG8gYERlZmF1bHRlZGAgb25jZSBpdCBpcyBwYXN0IG1hdHVyaXR5ICsgZ3JhY2UsIG9yIGluCmBNYXJnaW5DYWxsYCBwYXN0IGl0cyBgbWFyZ2luX2NhbGxfZGVhZGxpbmVgIChzZXQgYnkgYGNoZWNrX21hcmdpbmApLgpBbnlvbmUgY2FuIGNhbGwgaXQgKCM3KTsgYSBtYXR1cml0eSBkZWZhdWx0IG5lZWRzIG5vIE5BViAoIzE3KS4gQm90aApkZWFkbGluZXMgYXJlIHN0cmljdDogYXQgdGhlIGV4YWN0IHNlY29uZCB0aGUgYm9ycm93ZXIgY2FuIHN0aWxsIHJlcGF5Cm9yIHRvcCB1cC4KCkEgbWlzc2VkIGNhbGwgZmlyc3QgcmUtY2hlY2tzIHRoZSBicmVhY2ggYXQgYSBmcmVzaCwgaW4tYmFuZCBOQVYKKCMyMCk6IG5vIGxvbmdlciBwYXN0IHRoZSB0cmlnZ2VyLCBpdCByZXR1cm5zIHRvIGBPcGVuYCBhbmQgZW1pdHMKYE1hcmdpbkNsZWFyZWRgLiBTdGlsbCBwYXN0IGl0LCBpdCBkZWZhdWx0cy4gV2l0aCBubyBwcmljZSwgYSBzdGFsZQpOQVYgb3Igb25lIG91dHNpZGUgdGhlIHNhbml0eSBiYW5kIGl0IHJldHVybnMgYE5vUHJpY2VgIC8gYFN0YWxlTmF2YCAvCmBOYXZPdXRPZkJhbmRgIGFuZCB3YWl0czogYSBtaXNzZWQgY2FsbCBkZWZhdWx0cyBvbmx5IG9uIGEgZnJlc2gsCmluLWJhbmQgTkFWIHRoYXQgY29uZmlybXMgdGhlIGJyZWFjaC4gTWF0dXJpdHkgZGVmYXVsdHMgbmV2ZXIgcmVhZCB0aGUKTkFWLgoKQW4gb3B0ZWQtaW4gcmVwbyB0cmllcyBhdXRvLXJlcGF5IGZpcnN0ICgjMjcpIGFuZCBzZXR0bGVzIGFzIGBSZXBhaWRgCndoZW4gdGhlIHB1bGwgc3VjY2VlZHMgYW5kIHRoZSBjb2xsYXRlcmFsIGNhbiBiZSByZXR1cm5lZDsgb3RoZXJ3aXNlCnRoZSBwdWxsIGlzIHJlZnVuZGVkIGFuZCB0aGUgcmVwbyBkZWZhdWx0cy4gUmV0dXJucyB0aGUgcmVzdWx0aW5nCnN0YXR1cy4KCldoaWxlIHRoZSBhc3NldCdzIGBub19zZWl6ZWAgc3dpdGNoIGlzIG9uICgjMzApIGEgcmVwbyB0aGF0IHdvdWxkCmRlZmF1bHQgcmV0dXJucyBgUGF1c2VkYCBhbmQgc3RheXMgYE9wZW5gAAAAB2RlZmF1bHQAAAAAAQAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAA+kAAAfQAAAABlN0YXR1cwAAAAAAAw==",
        "AAAAAAAAAHdVU0RDIHBhcmtlZCBmb3IgYHdob2AgYmVjYXVzZSBhIHBheW91dCB0byBpdCBmYWlsZWQgKGZyb3plbiBhY2NvdW50LApjbG9zZWQgdHJ1c3RsaW5lKTsgYGNsYWltYCBwYXlzIGl0IG91dC4gMCBpZiBub25lLgAAAAAJY2xhaW1hYmxlAAAAAAAAAQAAAAAAAAADd2hvAAAAABMAAAABAAAACw==",
        "AAAAAAAAAthBIHdoaXRlbGlzdGVkIGxpcXVpZGF0b3IgYnV5cyBhIGRlZmF1bHRlZCByZXBvJ3MgY29sbGF0ZXJhbCBhdApOQVYgw5cgKDEg4oiSIGRpc2NvdW50KSwgcm91bmRlZCB1cC4gVGhlIFVTREMgZ29lcyBsZW5kZXIgZmlyc3QgKGNhcHBlZCBhdApwcmluY2lwYWwgKyBpbnRlcmVzdCDiiJIgZmVlKSwgdGhlbiB0aGUgZmVlLCB0aGVuIHRoZSBib3Jyb3dlciAoIzMsICM0KS4KSWYgcHJvY2VlZHMgZmFsbCBzaG9ydCBvZiB3aGF0IHRoZSBsZW5kZXIgaXMgb3dlZCwgdGhlIGxlbmRlciB0YWtlcwpldmVyeXRoaW5nIGFuZCBgU2hvcnRmYWxsYCBpcyBlbWl0dGVkLiBTdGFsZSBOQVYgcmV0dXJucyBgU3RhbGVOYXZgICgjNiksCk5BViBvdXRzaWRlIHRoZSBhc3NldCdzIHNhbml0eSBiYW5kIGBOYXZPdXRPZkJhbmRgICgjMzEpLiBUaGUgYXNzZXQncwpgbm9fc2VpemVgIHN3aXRjaCByZXR1cm5zIGBQYXVzZWRgICgjMzApLiBUaGUgcmVwbydzIG93biBib3Jyb3dlciBpcwpuZXZlciBhIGxpcXVpZGF0b3Igb2YgaXQgKGBOb3RMaXF1aWRhdG9yYCksIHdoaXRlbGlzdGVkIG9yIG5vdC4gVGhlCmxpcXVpZGF0b3IgcGF5cyB0aGUgcHJvY2VlZHMgaW50byB0aGUgY29udHJhY3Q7IGEgbGVuZGVyLCB0cmVhc3VyeSBvcgpib3Jyb3dlciBwYXlvdXQgdGhhdCBmYWlscyAoZnJvemVuIGFjY291bnQpIGlzIHBhcmtlZCBmb3IgYGNsYWltYCBhbmQKdGhlIGxpcXVpZGF0aW9uIHN0aWxsIGxhbmRzLgAAAAlsaXF1aWRhdGUAAAAAAAACAAAAAAAAAApsaXF1aWRhdG9yAAAAAAATAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAItEZWJ0IChwcmluY2lwYWwgKyBpbnRlcmVzdCkgb2YgbGl2ZSByZXBvcyBvbiBgYXNzZXRgLCB0aGUgYW1vdW50CmNvdW50ZWQgYWdhaW5zdCBgQXNzZXRDb25maWcubWF4X29wZW5fZGVidGAgKCMzMikuIDAgZm9yIGFuIHVua25vd24gYXNzZXQuAAAAAAlvcGVuX2RlYnQAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAACw==",
        "AAAAAAAAA5pBZGRzIG9yIHJlLXRpZXJzIGEgY29sbGF0ZXJhbCBhc3NldCAoREVDSVNJT05TLm1kICMxMykuIFJlcXVpcmVzCmBsaXF1aWRhdGlvbl9kaXNjb3VudF9icHMg4omkIG1hcmdpbl90cmlnZ2VyX2JwcyA8IGhhaXJjdXRfYnBzIDwgMTBfMDAwYAooIzI2KTogYSB0YWtlIGF0IG1heCBMVFYgb3BlbnMgc3RyaWN0bHkgYmVsb3cgdGhlIG1hcmdpbiB0cmlnZ2VyLCBhbmQgYQpsaXF1aWRhdGlvbiBhdCB0aGUgdHJpZ2dlciBsaW5lIHN0aWxsIGNvdmVycyB0aGUgZGVidC4KUmVxdWlyZXMgYG1heF9uYXZfYWdlX3NlY3MgPiAwYCAoc3RhbGVuZXNzIGlzIHBlciBhc3NldCwgIzI1KSwgYQp2YWxpZCBOQVYgc2FuaXR5IGJhbmQgKCMzMSk6IGBtYXhfbmF2X21vdmVfYnBzID4gMGAsIGVhY2ggYm91bmQgPiAwIGlmCnNldCwgYW5kIGBuYXZfZmxvb3IgPD0gbmF2X2NlaWxpbmdgLCBhbmQgYG1heF9vcGVuX2RlYnQg4omlIDBgICgjMzIpLgpSZS1zZXR0aW5nIGFuIGFzc2V0IGtlZXBzIGl0cyBvcGVuIGRlYnQ7IGEgY2FwIGJlbG93IGl0IG9ubHkgc3RvcHMgbmV3CnRha2VzLgoKSW5zdGFudCBvbmx5IGZvciBhIGZpcnN0IGxpc3RpbmcgKG5vIG9mZmVyIGNhbiBleGlzdCBvbiBhbiB1bmxpc3RlZAphc3NldCkgb3IgYSBjaGFuZ2UgdGhhdCBvbmx5IHRpZ2h0ZW5zICgjMzM6IGRpc2FibGUsIHJhaXNlIHRoZQpoYWlyY3V0IG9yIHRoZSBtYXJnaW4gdHJpZ2dlciwgbG93ZXIgdGhlIE5BViBhZ2Ugb3IgdGhlIGNhcCwgbmFycm93CnRoZSBOQVYgYmFuZCkuIEFueXRoaW5nCnRoYXQgbG9vc2VucyBmYWlscyB3aXRoIGBMb29zZW5zYDogdXNlIGBwcm9wb3NlX2Fzc2V0YC4gQW4gaW5zdGFudApjaGFuZ2UgZHJvcHMgYSBwZW5kaW5nIHByb3Bvc2FsIGZvciB0aGUgYXNzZXQsIHNvIGl0IGNhbm5vdCB1bmRvIHRoZQpjaGFuZ2UgbGF0ZXIuAAAAAAAJc2V0X2Fzc2V0AAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAZjb25maWcAAAAAB9AAAAALQXNzZXRDb25maWcAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAXtTZXRzIGFuIGFzc2V0J3MgcGF1c2Ugc3dpdGNoZXMgKERFQ0lTSU9OUy5tZCAjMzApLiBFYWNoIG9uZSBzdG9wcyBvbmUKYWN0aW9uOiBgbm9fbmV3X3JlcG9zYCBibG9ja3MgYGNyZWF0ZV9vZmZlcmAgLyBgdGFrZV9vZmZlcmAsCmBub19zZWl6ZWAgYmxvY2tzIGBkZWZhdWx0YCBhbmQgYGxpcXVpZGF0ZWAuIE5vdGhpbmcgcGF1c2VzIGByZXBheWAKb3IgYHRvcF91cGAuIFN0b3JlZCBhcGFydCBmcm9tIGBBc3NldENvbmZpZ2AsIHNvIGBzZXRfYXNzZXRgIG5ldmVyCmNsZWFycyBhIHBhdXNlLiBJbnN0YW50IG9ubHkgZm9yIHN3aXRjaGluZyBvbiAoIzMzKTsgY2xlYXJpbmcgYQpzd2l0Y2ggZmFpbHMgd2l0aCBgTG9vc2Vuc2A6IHVzZSBgcHJvcG9zZV9wYXVzZWAuAAAAAAlzZXRfcGF1c2UAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABXBhdXNlAAAAAAAH0AAAAAVQYXVzZQAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAYxSZXBheXMgYW4gb3B0ZWQtaW4gcmVwbyBmcm9tIHRoZSBib3Jyb3dlcidzIFVTREMgYWxsb3dhbmNlICgjMjcpLgpBbnlvbmUgY2FuIGNhbGwgaXQgZnJvbSBtYXR1cml0eSwgb3Igb25jZSBhIG1hcmdpbiBjYWxsJ3MgZGVhZGxpbmUgaGFzCnBhc3NlZC4gT24gc3VjY2VzcyB0aGUgcmVwbyBpcyBgUmVwYWlkYCBleGFjdGx5IGFzIGlmIHRoZSBib3Jyb3dlciBoYWQKY2FsbGVkIGByZXBheWAuIElmIHRoZSBwdWxsIGZhaWxzLCBvciB0aGUgY29sbGF0ZXJhbCBjYW5ub3QgYmUgcmV0dXJuZWQKdG8gdGhlIGJvcnJvd2VyLCB0aGUgcmVwbyBpcyB1bnRvdWNoZWQgYW5kIHRoZSBjYWxsIHJldHVybnMKYEF1dG9SZXBheUZhaWxlZGA7IHRoZSBib3Jyb3dlciBjYW4gc3RpbGwgcmVwYXkgYnkgaGFuZC4AAAAKYXV0b19yZXBheQAAAAAAAQAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAA2xBdG9taWMgRHZQOiBjb2xsYXRlcmFsIGluLCBlc2Nyb3dlZCBVU0RDIG91dC4gUmV0dXJucyB0aGUgcmVwbyBpZC4KRnVsbCB0YWtlcyBvbmx5IChERUNJU0lPTlMubWQgIzE2KTogdGhlIGNvbnRyYWN0IGNvbXB1dGVzCmBjb2xsYXRlcmFsID0gcmVxdWlyZWRfY29sbGF0ZXJhbChkZWJ0LCBuYXYsIGRlYywgaGFpcmN1dClgLCByb3VuZGVkIHVwLAphbmQgZml4ZXMgZGVidCA9IHByaW5jaXBhbCArIGZ1bGwtdGVybSBpbnRlcmVzdCAoIzE1KS4gVGhlIGJvcnJvd2VyJ3MKYXV0aCBvbiB0aGUgU0FDIHRyYW5zZmVyIHBpbnMgdGhlIGV4YWN0IGFtb3VudCwgc28gaWYgTkFWIG1vdmVzIGJldHdlZW4Kc2ltdWxhdGUgYW5kIHN1Ym1pdCB0aGUgdHggZmFpbHMgaW5zdGVhZCBvZiBvdmVyY2hhcmdpbmcgKCMyMSkuCgpSZWplY3RzIHN0YWxlIE5BViAoIzYpLCBOQVYgb3V0c2lkZSB0aGUgYXNzZXQncyBzYW5pdHkgYmFuZCAoIzMxKSwgYW4KYXNzZXQgZGlzYWJsZWQgc2luY2UgdGhlIG9mZmVyIHdhcyBwb3N0ZWQgKCMyMykgYW5kIGFuIGFzc2V0IHBhdXNlZAp3aXRoIGBub19uZXdfcmVwb3NgICgjMzApLiBUaGUgaGFpcmN1dCBpcyBzbmFwc2hvdHRlZCBvbiB0aGUgcmVwbyAoIzE5KS4KUmVqZWN0cyB3aXRoIGBDYXBFeGNlZWRlZGAgaWYgdGhlIGFzc2V0J3Mgb3BlbiBkZWJ0IHBsdXMgdGhpcyBkZWJ0CndvdWxkIHBhc3MgYG1heF9vcGVuX2RlYnRgICgjMzIpOyB0aGUgb2ZmZXIgc3RheXMgb24gdGhlIGJvYXJkLgoKYGF1dG9fcmVwYXlgIG9wdHMgaW4gdG8gYXV0by1yZXBheSAoIzI3KTogdGhlIHNhbWUgc2lnbmF0dXJlIGFsc28KYXBwcm92ZXMgdGhpcyBjb250cmFjdCB0byBwdWxsIHRoZSBkZWJ0IGluIFVTREMgZnJvbSBtYXR1cml0eS4AAAAKdGFrZV9vZmZlcgAAAAAAAwAAAAAAAAAIYm9ycm93ZXIAAAATAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAAAAAAACmF1dG9fcmVwYXkAAAAAAAEAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAADxEcm9wcyB0aGUgcGVuZGluZyBhc3NldCBjaGFuZ2UuIEFkbWluIG9yIGd1YXJkaWFuLCBhbnkgdGltZS4AAAAMY2FuY2VsX2Fzc2V0AAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAH1SZXR1cm5zIHRoZSBlc2Nyb3dlZCBVU0RDIHRvIHRoZSBsZW5kZXIuIE9ubHkgdGhlIGxlbmRlciBjYW4gY2FuY2VsLAphbmQgb25seSB3aGlsZSB0aGUgb2ZmZXIgaXMgdW50YWtlbiAoYSB0YWtlIHJlbW92ZXMgaXQpLgAAAAAAAAxjYW5jZWxfb2ZmZXIAAAABAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAADxEcm9wcyB0aGUgcGVuZGluZyBwYXVzZSBjaGFuZ2UuIEFkbWluIG9yIGd1YXJkaWFuLCBhbnkgdGltZS4AAAAMY2FuY2VsX3BhdXNlAAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAALpTZXRzIGBtYXJnaW5fY2FsbF9kZWFkbGluZWAgb24gdGhlIGZpcnN0IGBtYXJnaW5fYnJlYWNoZWRgLiBSZXR1cm5zIHRoZQpzdGF0dXMuIFN0YWxlIE5BViByZXR1cm5zIGBTdGFsZU5hdmAgKERFQ0lTSU9OUy5tZCAjMTcpLCBOQVYgb3V0c2lkZQp0aGUgYXNzZXQncyBzYW5pdHkgYmFuZCBgTmF2T3V0T2ZCYW5kYCAoIzMxKS4AAAAAAAxjaGVja19tYXJnaW4AAAABAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAB9AAAAAGU3RhdHVzAAAAAAAD",
        "AAAAAAAAAQdFc2Nyb3dzIGBwcmluY2lwYWxgIFVTREMgZnJvbSB0aGUgbGVuZGVyLiBSZXR1cm5zIHRoZSBvZmZlciBpZC4KVGhlIGhhaXJjdXQgY29tZXMgZnJvbSB0aGUgYXNzZXQncyBgQXNzZXRDb25maWdgLCBub3QgdGhlIGxlbmRlci4KUmVqZWN0cyBhIG1pc3Npbmcgb3IgZGlzYWJsZWQgYXNzZXQgd2l0aCBgQXNzZXROb3RTdXBwb3J0ZWRgICgjMjIpLAphbmQgYFBhdXNlZGAgd2hpbGUgdGhlIGFzc2V0J3MgYG5vX25ld19yZXBvc2Agc3dpdGNoIGlzIG9uICgjMzApLgAAAAAMY3JlYXRlX29mZmVyAAAABQAAAAAAAAAGbGVuZGVyAAAAAAATAAAAAAAAABBjb2xsYXRlcmFsX2Fzc2V0AAAAEwAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAHYXByX2JwcwAAAAAEAAAAAAAAAAl0ZXJtX3NlY3MAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAEAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAZDb25maWcAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAADtBcHBsaWVzIHRoZSBwZW5kaW5nIGFzc2V0IGNoYW5nZSBvbmNlIGl0cyBgZXRhYCBoYXMgcGFzc2VkLgAAAAANZXhlY3V0ZV9hc3NldAAAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAADtBcHBsaWVzIHRoZSBwZW5kaW5nIHBhdXNlIGNoYW5nZSBvbmNlIGl0cyBgZXRhYCBoYXMgcGFzc2VkLgAAAAANZXhlY3V0ZV9wYXVzZQAAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANaXNfbGlxdWlkYXRvcgAAAAAAAAEAAAAAAAAAA3dobwAAAAATAAAAAQAAAAE=",
        "AAAAAAAAAD5UaGUgYWRtaW4gYXNzZXQgY2hhbmdlIHdhaXRpbmcgb3V0IHRoZSB0aW1lbG9jaywgaWYgYW55ICgjMzMpLgAAAAAADXBlbmRpbmdfYXNzZXQAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAB9AAAAAMUGVuZGluZ0Fzc2V0",
        "AAAAAAAAAD5UaGUgYWRtaW4gcGF1c2UgY2hhbmdlIHdhaXRpbmcgb3V0IHRoZSB0aW1lbG9jaywgaWYgYW55ICgjMzMpLgAAAAAADXBlbmRpbmdfcGF1c2UAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAB9AAAAAMUGVuZGluZ1BhdXNl",
        "AAAAAAAAAKhRdWV1ZXMgYGNvbmZpZ2AgZm9yIGBhc3NldGA7IGBleGVjdXRlX2Fzc2V0YCBhcHBsaWVzIGl0IGZyb20gdGhlCnJldHVybmVkIGBldGFgIChub3cgKyBgdGltZWxvY2tfc2Vjc2ApLiBBIG5ldyBwcm9wb3NhbCByZXBsYWNlcyB0aGUKcGVuZGluZyBvbmUgYW5kIHJlc3RhcnRzIHRoZSBjbG9jay4AAAANcHJvcG9zZV9hc3NldAAAAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAGY29uZmlnAAAAAAfQAAAAC0Fzc2V0Q29uZmlnAAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAHFRdWV1ZXMgcGF1c2Ugc3dpdGNoZXMgZm9yIGBhc3NldGAgKHR5cGljYWxseSBjbGVhcmluZyBvbmUpOwpgZXhlY3V0ZV9wYXVzZWAgYXBwbGllcyB0aGVtIGZyb20gdGhlIHJldHVybmVkIGBldGFgLgAAAAAAAA1wcm9wb3NlX3BhdXNlAAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAVwYXVzZQAAAAAAB9AAAAAFUGF1c2UAAAAAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAMZUdXJucyBhdXRvLXJlcGF5IG9uIG9yIG9mZiBmb3IgYSBsaXZlIHJlcG8gKCMyNykuIE9uIGFwcHJvdmVzIHRoaXMKY29udHJhY3QgdG8gcHVsbCB0aGUgZGVidCBpbiBVU0RDIGZyb20gbWF0dXJpdHk7IG9mZiB0YWtlcyB0aGF0CmFwcHJvdmFsIGJhY2suIEJvcnJvd2VyIG9ubHk7IHNldHRpbmcgdGhlIGN1cnJlbnQgdmFsdWUgaXMgYSBuby1vcC4AAAAAAA5zZXRfYXV0b19yZXBheQAAAAAAAgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAAAAAAdlbmFibGVkAAAAAAEAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAOc2V0X2xpcXVpZGF0b3IAAAAAAAIAAAAAAAAACmxpcXVpZGF0b3IAAAAAABMAAAAAAAAAB2FsbG93ZWQAAAAAAQAAAAA=",
        "AAAAAAAAAOtUaGUgZ3VhcmRpYW4ncyBpbnN0YW50IGBzZXRfYXNzZXRgIG9uIGEgbGlzdGVkIGFzc2V0OiBkaXNhYmxlIGl0LApyYWlzZSB0aGUgaGFpcmN1dCBvciB0aGUgbWFyZ2luIHRyaWdnZXIsIGxvd2VyIHRoZSBOQVYgYWdlIG9yIHRoZSBjYXAsCm5hcnJvdyB0aGUgTkFWIGJhbmQuIEZhaWxzIHdpdGgKYExvb3NlbnNgIGlmIGFueSBmaWVsZCBhZGRzIHJpc2ssIGBBc3NldE5vdFN1cHBvcnRlZGAgaWYgdW5saXN0ZWQuAAAAABJndWFyZGlhbl9zZXRfYXNzZXQAAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAGY29uZmlnAAAAAAfQAAAAC0Fzc2V0Q29uZmlnAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAD1UaGUgZ3VhcmRpYW4ncyBpbnN0YW50IGBzZXRfcGF1c2VgOiBjYW4gc3dpdGNoIG9uLCBuZXZlciBvZmYuAAAAAAAAEmd1YXJkaWFuX3NldF9wYXVzZQAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAVwYXVzZQAAAAAAB9AAAAAFUGF1c2UAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAQAAAD9BIGxpdmUgb3Igc2V0dGxlZCByZXBvLCBjcmVhdGVkIHdoZW4gYSBib3Jyb3dlciB0YWtlcyBhbiBvZmZlci4AAAAAAAAAAARSZXBvAAAADgAAAIVCb3Jyb3dlciBvcHRlZCBpbiB0byBhdXRvLXJlcGF5IChERUNJU0lPTlMubWQgIzI3KTogZnJvbSBtYXR1cml0eSB0aGUKZGVidCBpcyBwdWxsZWQgZnJvbSB0aGVpciBVU0RDIGFsbG93YW5jZSBpbnN0ZWFkIG9mIGRlZmF1bHRpbmcuAAAAAAAACmF1dG9fcmVwYXkAAAAAAAEAAAAAAAAACGJvcnJvd2VyAAAAEwAAAIFDb2xsYXRlcmFsIGhlbGQgYnkgdGhlIGNvbnRyYWN0LCBpbiB0aGUgdG9rZW4ncyBvd24gdW5pdHMgKGl0cwpgZGVjaW1hbHMoKWA6IDcgZm9yIHRCRU5KSSwgNSBmb3IgU3Bpa28gdG9rZW5zOyBERUNJU0lPTlMubWQgIzI4KS4AAAAAAAARY29sbGF0ZXJhbF9hbW91bnQAAAAAAAALAAAAAAAAABBjb2xsYXRlcmFsX2Fzc2V0AAAAEwAAAH5TbmFwc2hvdCBvZiB0aGUgYXNzZXQgaGFpcmN1dCBhdCB0YWtlIHRpbWUuIFRoZSB0b3AtdXAgdGFyZ2V0OiBhCm1hcmdpbiBjYWxsIGNsZWFycyBvbmNlIGBsdHZfb2tgIGhvbGRzIGF0IHRoaXMgaGFpcmN1dCBhZ2Fpbi4AAAAAAAtoYWlyY3V0X2JwcwAAAAAEAAAAAAAAAAJpZAAAAAAABgAAAHdGdWxsLXRlcm0gaW50ZXJlc3QsIGZpeGVkIGF0IHRha2UgdGltZS4gRGVidCA9IHByaW5jaXBhbCArIGludGVyZXN0LAp0aGUgc2FtZSBhbW91bnQgb24gZWFybHkgcmVwYXkgKERFQ0lTSU9OUy5tZCAjMTUpLgAAAAAIaW50ZXJlc3QAAAALAAAAAAAAAAZsZW5kZXIAAAAAABMAAABBU2V0IG9uY2Ugb24gdGhlIGZpcnN0IG1hcmdpbiBicmVhY2g7IGNsZWFyZWQgYnkgYSBoZWFsdGh5IHRvcC11cC4AAAAAAAAUbWFyZ2luX2NhbGxfZGVhZGxpbmUAAAPoAAAABgAAAAAAAAALbWF0dXJpdHlfdHMAAAAABgAAAAAAAAAIb2ZmZXJfaWQAAAAGAAAAAAAAAAlwcmluY2lwYWwAAAAAAAALAAAAAAAAAAhzdGFydF90cwAAAAYAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAZTdGF0dXMAAA==",
        "AAAAAgAAAGpTRVAtNDAgYXNzZXQgaWRlbnRpZmllciwgc2FtZSBzaGFwZSBhcyBSZWZsZWN0b3Incywgc28gdGhlIG1vY2sgb3JhY2xlIGFuZApsaXZlIGZlZWRzIGFjY2VwdCBpdCB1bmNoYW5nZWQuAAAAAAAAAAAABUFzc2V0AAAAAAAAAgAAAAEAAAAAAAAAB1N0ZWxsYXIAAAAAAQAAABMAAAABAAAAAAAAAAVPdGhlcgAAAAAAAAEAAAAR",
        "AAAAAQAAAN9BIGxlbmRlcidzIHN0YW5kaW5nIG9mZmVyLiBUaGUgbGVuZGVyIHNldHMgb25seSBhc3NldCwgcHJpbmNpcGFsLCBBUFIgYW5kCnRlcm07IHRoZSBoYWlyY3V0IGNvbWVzIGZyb20gdGhlIGFzc2V0J3MgYEFzc2V0Q29uZmlnYC4gVGhlIHByaW5jaXBhbCBpcyBlc2Nyb3dlZCBpbiB0aGUgY29udHJhY3QKZnJvbSBgY3JlYXRlX29mZmVyYCB1bnRpbCBpdCBpcyB0YWtlbiBvciBjYW5jZWxsZWQuAAAAAAAAAAAFT2ZmZXIAAAAAAAAHAAAAAAAAAAdhcHJfYnBzAAAAAAQAAAA2Q29sbGF0ZXJhbCB0b2tlbiB0aGUgbGVuZGVyIGFjY2VwdHMgKGUuZy4gdEJFTkpJIFNBQykuAAAAAAAQY29sbGF0ZXJhbF9hc3NldAAAABMAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAAAmlkAAAAAAAGAAAAAAAAAAZsZW5kZXIAAAAAABMAAAAbVVNEQyBsZW50LCA3LWRlY2ltYWwgdW5pdHMuAAAAAAlwcmluY2lwYWwAAAAAAAALAAAAAAAAAAl0ZXJtX3NlY3MAAAAAAAAG",
        "AAAAAQAAANFQZXItYXNzZXQgZW1lcmdlbmN5IHN3aXRjaGVzIChERUNJU0lPTlMubWQgIzMwKSwgc3RvcmVkIGFwYXJ0IGZyb20KYEFzc2V0Q29uZmlnYCBzbyByZS10aWVyaW5nIGFuIGFzc2V0IG5ldmVyIGNsZWFycyBhIHBhdXNlLiBFYWNoIHN3aXRjaApzdG9wcyBvbmUgYWN0aW9uIGFuZCBub3RoaW5nIGVsc2U7IGByZXBheWAgYW5kIGB0b3BfdXBgIGhhdmUgbm8gc3dpdGNoLgAAAAAAAAAAAAAFUGF1c2UAAAAAAAACAAAAckJsb2NrcyBgY3JlYXRlX29mZmVyYCBhbmQgYHRha2Vfb2ZmZXJgLCBsaWtlIGBBc3NldENvbmZpZy5lbmFibGVkID0KZmFsc2VgIChhbiBhbGlhcykuIGBjYW5jZWxfb2ZmZXJgIHN0aWxsIHdvcmtzLgAAAAAADG5vX25ld19yZXBvcwAAAAEAAACBQmxvY2tzIGBkZWZhdWx0YCAoZXhjZXB0IGFuIGF1dG8tcmVwYXkgc2V0dGxlKSBhbmQgYGxpcXVpZGF0ZWAuIFRoZQpkZWZhdWx0IGNsb2NrIGtlZXBzIHJ1bm5pbmc7IHNlaXp1cmUgd2FpdHMgdW50aWwgdGhpcyBjbGVhcnMuAAAAAAAACG5vX3NlaXplAAAAAQ==",
        "AAAAAQAAAK9Qcm90b2NvbCBwYXJhbWV0ZXJzLCBzZXQgb25jZSBhdCBkZXBsb3kuIFN0b3JlZCBpbiBpbnN0YW5jZSBzdG9yYWdlLgoKQWxsIGR1cmF0aW9ucyBhcmUgY29uZmlnIHNvIHRoZSBkZW1vIGNhbiBjb21wcmVzcyB0aW1lIHdpdGhvdXQgdG91Y2hpbmcKY29udHJhY3QgbG9naWMgKERFQ0lTSU9OUy5tZCAjNSkuAAAAAAAAAAAGQ29uZmlnAAAAAAALAAAAAAAAAAVhZG1pbgAAAAAAABMAAAByTGVuZ3RoIG9mIG9uZSAiZGF5IiBpbiBzZWNvbmRzLiA4Nl80MDAgaW4gcHJvZHVjdGlvbiwgNjAgaW4gdGhlIGRlbW8uCkludGVyZXN0IHVzZXMgYSAzNjUtZGF5IHllYXIgb2YgdGhpcyBsZW5ndGguAAAAAAAIZGF5X3NlY3MAAAAGAAAAPlByb3RvY29sIGZlZSBhcyBhIHNoYXJlIG9mIGludGVyZXN0LCBpbiBicHMgKERFQ0lTSU9OUy5tZCAjMykuAAAAAAAHZmVlX2JwcwAAAAAEAAAAO1RpbWUgYWZ0ZXIgbWF0dXJpdHkgYmVmb3JlIGFuIHVucGFpZCByZXBvIGNhbiBiZSBkZWZhdWx0ZWQuAAAAAApncmFjZV9zZWNzAAAAAAAGAAAA1kNhbiBvbmx5IG1ha2UgdGhpbmdzIHNhZmVyLCBpbnN0YW50bHkgKERFQ0lTSU9OUy5tZCAjMzMpOiBkaXNhYmxlIGFuCmFzc2V0LCByYWlzZSBhIGhhaXJjdXQsIGxvd2VyIGEgY2FwIG9yIE5BViBhZ2UsIG5hcnJvdyB0aGUgTkFWIGJhbmQsCnNldCBwYXVzZSBzd2l0Y2hlcywgY2FuY2VsIGEgcGVuZGluZyBwcm9wb3NhbC4gSXQgY2FuIG5ldmVyIGxvb3NlbiBhbnl0aGluZy4AAAAAAAhndWFyZGlhbgAAABMAAABATGlxdWlkYXRvciBidXlzIGNvbGxhdGVyYWwgYXQgTkFWIMOXICgxIOKIkiBkaXNjb3VudCkuIDIwMCA9IDIlLgAAABhsaXF1aWRhdGlvbl9kaXNjb3VudF9icHMAAAAEAAAAMlRpbWUgYSBib3Jyb3dlciBoYXMgdG8gdG9wIHVwIGFmdGVyIGEgbWFyZ2luIGNhbGwuAAAAAAASbWFyZ2luX3dpbmRvd19zZWNzAAAAAAAGAAAAJVNFUC00MCBwcmljZSBmZWVkIGZvciBjb2xsYXRlcmFsIE5BVi4AAAAAAAAGb3JhY2xlAAAAAAATAAAAokRlbGF5IGJldHdlZW4gYHByb3Bvc2VfKmAgYW5kIGBleGVjdXRlXypgIGZvciBldmVyeSBjaGFuZ2UgdGhhdCBhZGRzCnJpc2sgKERFQ0lTSU9OUy5tZCAjMzMpLiAxNzJfODAwICgyIGRheXMpIGluIHByb2R1Y3Rpb24sIDEyMCBpbiB0aGUKZGVtbyAoIzUpLiBNdXN0IGJlID49IDYwLgAAAAAADXRpbWVsb2NrX3NlY3MAAAAAAAAGAAAAGlJlY2VpdmVzIHRoZSBwcm90b2NvbCBmZWUuAAAAAAAIdHJlYXN1cnkAAAATAAAAGENpcmNsZSB0ZXN0bmV0IFVTREMgU0FDLgAAAAR1c2RjAAAAEw==",
        "AAAAAgAAAAAAAAAAAAAABlN0YXR1cwAAAAAABQAAAAAAAAAAAAAABE9wZW4AAAAAAAAAAAAAAApNYXJnaW5DYWxsAAAAAAAAAAAAAAAAAAZSZXBhaWQAAAAAAAAAAAAAAAAACURlZmF1bHRlZAAAAAAAAAAAAAAAAAAACkxpcXVpZGF0ZWQAAA==",
        "AAAAAQAAAJRQZXItY29sbGF0ZXJhbC1hc3NldCByaXNrIHBhcmFtZXRlcnMsIGFkbWluLXVwZGF0YWJsZSB3aXRob3V0IGEgcmVkZXBsb3kKKERFQ0lTSU9OUy5tZCAjMTMpLiBTdG9yZWQgaW4gaW5zdGFuY2Ugc3RvcmFnZSwga2V5ZWQgYnkgdGhlIHRva2VuIGFkZHJlc3MuAAAAAAAAAAtBc3NldENvbmZpZwAAAAAJAAAAPURpc2FibGVkIGFzc2V0cyByZWplY3QgbmV3IG9mZmVyczsgbGl2ZSByZXBvcyBhcmUgdW5hZmZlY3RlZC4AAAAAAAAHZW5hYmxlZAAAAAABAAAAhkluaXRpYWwgTFRWOiBgZGVidCDiiaQgdmFsdWUgw5cgKDEg4oiSIGhhaXJjdXQpYC4gQWx3YXlzIGFib3ZlCmBtYXJnaW5fdHJpZ2dlcl9icHNgLCBzbyBhIG1heC1MVFYgdGFrZSBvcGVucyBiZWxvdyB0aGUgbWFyZ2luIHRyaWdnZXIuAAAAAAALaGFpcmN1dF9icHMAAAAABAAAAc9NYXJnaW4gdHJpZ2dlciAoREVDSVNJT05TLm1kICMxNCwgIzI2KTogYSBtYXJnaW4gY2FsbCBmaXJlcyBvbmNlCmBkZWJ0ID4gdmFsdWUgw5cgKDEg4oiSIG1hcmdpbl90cmlnZ2VyX2JwcylgLiBNdXN0IHNhdGlzZnkKYENvbmZpZy5saXF1aWRhdGlvbl9kaXNjb3VudF9icHMg4omkIG1hcmdpbl90cmlnZ2VyX2JwcyA8IGhhaXJjdXRfYnBzYC4KQWJvdmUgdGhlIGRpc2NvdW50LCBhIGxpcXVpZGF0aW9uIGF0IHRoZSBjYWxsIGxpbmUgc3RpbGwgcGF5cyB0aGUKbGVuZGVyIGAoMSDiiJIgZGlzY291bnQpIC8gKDEg4oiSIHRyaWdnZXIpIOKIkiAxYCBvdmVyIHRoZSBkZWJ0ICgyNTAgdnMgMjAwOgowLjUxJSksIGEgYnVmZmVyIGZvciB0aGUgTkFWIG1vdmUgZHVyaW5nIHRoZSBtYXJnaW4gd2luZG93LiBBcHBsaWVzIHRvCmxpdmUgcmVwb3MgYXQgb25jZTsgcmFpc2luZyBpdCBpcyBhIHRpZ2h0ZW5pbmcgKCMzMykuAAAAABJtYXJnaW5fdHJpZ2dlcl9icHMAAAAAAAQAAAE8QSBOQVYgb2xkZXIgdGhhbiB0aGlzIGJsb2NrcyBgdGFrZV9vZmZlcmAsIGBjaGVja19tYXJnaW5gIGFuZApgbGlxdWlkYXRlYCBmb3IgdGhpcyBhc3NldCAoREVDSVNJT05TLm1kICM2LCAjMTcsICMyNSkuIE5ldmVyIGJsb2NrcwpgcmVwYXlgIG9yIGB0b3BfdXBgLiBQZXIgYXNzZXQgYmVjYXVzZSBwdWJsaWNhdGlvbiBzY2hlZHVsZXMgZGlmZmVyOgphIGZ1bmQgdGhhdCBwcmludHMgTkFWIG9ubHkgb24gYnVzaW5lc3MgZGF5cyBuZWVkcyB+OTYgaCB0byBjb3ZlciBhCndlZWtlbmQsIGEgZGFpbHktcHJpY2VkIHRva2VuIGxlc3MuIE11c3QgYmUgPiAwLgAAABBtYXhfbmF2X2FnZV9zZWNzAAAABgAAAaNOQVYgc2FuaXR5IGJhbmQgKERFQ0lTSU9OUy5tZCAjMzEpOiB0aGUgbGF0ZXN0IE5BViBtYXkgZGlmZmVyIGZyb20KZXZlcnkgb25lIG9mIHRoZSBvcmFjbGUncyBsYXN0IGBvcmFjbGU6Ok5BVl9CQU5EX1JFQ09SRFNgIHJlY29yZHMgYnkKYXQgbW9zdCB0aGlzIG1hbnkgYnBzLCBlbHNlIGBOYXZPdXRPZkJhbmRgLiBNZWFzdXJpbmcgYWdhaW5zdCB0aGUKd2hvbGUgd2luZG93LCBub3QganVzdCB0aGUgcHJldmlvdXMgcmVjb3JkLCBtZWFucyByZS1wb3N0cyBvZiBhIGJhZApwcmljZSBjYW5ub3QgaGlkZSB0aGUganVtcC4gQmxvY2tzIGB0YWtlX29mZmVyYCwgYGNoZWNrX21hcmdpbmAgYW5kCmBsaXF1aWRhdGVgLCB0aGUgc2FtZSBzZXQgYXMgYSBzdGFsZSBOQVY7IG5ldmVyIGByZXBheWAgb3IgYHRvcF91cGAuCk11c3QgYmUgPiAwLgAAAAAQbWF4X25hdl9tb3ZlX2JwcwAAAAQAAAFKRXhwb3N1cmUgY2FwIChERUNJU0lPTlMubWQgIzMyKTogdG90YWwgZGVidCAocHJpbmNpcGFsICsgaW50ZXJlc3QsIFVTREMKNyBkZWNpbWFscykgb2YgbGl2ZSByZXBvcyBvbiB0aGlzIGFzc2V0LiBgdGFrZV9vZmZlcmAgZmFpbHMgd2l0aApgQ2FwRXhjZWVkZWRgIHBhc3QgaXQ7IDAgbWVhbnMgbm8gbmV3IHJlcG9zLiBFeGl0cyAocmVwYXksIGF1dG8tcmVwYXksCnRvcC11cCwgbGlxdWlkYXRlKSBhcmUgbmV2ZXIgYmxvY2tlZCwgYW5kIGxvd2VyaW5nIHRoZSBjYXAgYmVsb3cgdGhlCm9wZW4gZGVidCBsZWF2ZXMgbGl2ZSByZXBvcyB1bnRvdWNoZWQuIE11c3QgYmUg4omlIDAuAAAAAAANbWF4X29wZW5fZGVidAAAAAAAAAsAAAAAAAAAC25hdl9jZWlsaW5nAAAAA+gAAAALAAAAsk9wdGlvbmFsIGhhcmQgYm91bmRzIG9uIHRoZSBsYXRlc3QgTkFWLCBpbiB0aGUgZmVlZCdzIG93biBzY2FsZQooYGRlY2ltYWxzKClgKSwgaW5jbHVzaXZlLiBTYW1lIGVmZmVjdCBhcyB0aGUgbW92ZSBsaW1pdC4gSWYgc2V0LAplYWNoIG11c3QgYmUgPiAwIGFuZCBgbmF2X2Zsb29yIDw9IG5hdl9jZWlsaW5nYC4AAAAAAAluYXZfZmxvb3IAAAAAAAPoAAAACwAAACBIb3cgdGhlIG9yYWNsZSBuYW1lcyB0aGlzIGFzc2V0LgAAAAxvcmFjbGVfYXNzZXQAAAfQAAAABUFzc2V0AAAA",
        "AAAAAQAAAEpBbiBhZG1pbiBgQXNzZXRDb25maWdgIGNoYW5nZSB3YWl0aW5nIG91dCB0aGUgdGltZWxvY2sgKERFQ0lTSU9OUy5tZCAjMzMpLgAAAAAAAAAAAAxQZW5kaW5nQXNzZXQAAAACAAAAAAAAAAZjb25maWcAAAAAB9AAAAALQXNzZXRDb25maWcAAAAANGBleGVjdXRlX2Fzc2V0YCB3b3JrcyBmcm9tIHRoaXMgbGVkZ2VyIHRpbWVzdGFtcCBvbi4AAAADZXRhAAAAAAY=",
        "AAAAAQAAAERBbiBhZG1pbiBgUGF1c2VgIGNoYW5nZSB3YWl0aW5nIG91dCB0aGUgdGltZWxvY2sgKERFQ0lTSU9OUy5tZCAjMzMpLgAAAAAAAAAMUGVuZGluZ1BhdXNlAAAAAgAAADRgZXhlY3V0ZV9wYXVzZWAgd29ya3MgZnJvbSB0aGlzIGxlZGdlciB0aW1lc3RhbXAgb24uAAAAA2V0YQAAAAAGAAAAAAAAAAVwYXVzZQAAAAAAB9AAAAAFUGF1c2UAAAA=",
        "AAAAAgAAAE1XaHkgYGRlZmF1bHRgIG1vdmVkIGEgcmVwbyB0byBgRGVmYXVsdGVkYCAoY2FycmllZCBieSB0aGUgYERlZmF1bHRlZGAgZXZlbnQpLgAAAAAAAAAAAAANRGVmYXVsdFJlYXNvbgAAAAAAAAIAAAAAAAAAHVVucGFpZCBwYXN0IG1hdHVyaXR5ICsgZ3JhY2UuAAAAAAAACE1hdHVyaXR5AAAAAAAAAGBNYXJnaW4gY2FsbCBtaXNzZWQ6IHBhc3QgYG1hcmdpbl9jYWxsX2RlYWRsaW5lYCwgc3RpbGwgaW4gYnJlYWNoIG9yCndpdGhvdXQgYSBmcmVzaCBpbi1iYW5kIE5BVi4AAAAKTWFyZ2luQ2FsbAAA",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAGAAAAAAAAAAOTm90SW1wbGVtZW50ZWQAAAAAAAEAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAACAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAwAAAAAAAAAMTWF0aE92ZXJmbG93AAAABAAAAAAAAAANT2ZmZXJOb3RGb3VuZAAAAAAAAAUAAAAAAAAADFJlcG9Ob3RGb3VuZAAAAAYAAAAAAAAADUludmFsaWRTdGF0dXMAAAAAAAAHAAAAOUNvbGxhdGVyYWwgYXNzZXQgaGFzIG5vIGBBc3NldENvbmZpZ2AsIG9yIGl0IGlzIGRpc2FibGVkLgAAAAAAABFBc3NldE5vdFN1cHBvcnRlZAAAAAAAAAgAAAAAAAAACFN0YWxlTmF2AAAACQAAAAAAAAAWSW5zdWZmaWNpZW50Q29sbGF0ZXJhbAAAAAAACgAAAAAAAAANTm90TGlxdWlkYXRvcgAAAAAAAAsAAAAAAAAADk5vdERlZmF1bHRhYmxlAAAAAAAMAAAAOU9yYWNsZSBoYXMgbm8gcHJpY2UgZm9yIHRoZSBhc3NldCwgb3IgaXQgaXMgbm90IHBvc2l0aXZlLgAAAAAAAAdOb1ByaWNlAAAAAA0AAAArYGF1dG9fcmVwYXlgIG9uIGEgcmVwbyB0aGF0IGRpZCBub3Qgb3B0IGluLgAAAAAMQXV0b1JlcGF5T2ZmAAAADgAAADlgYXV0b19yZXBheWAgYmVmb3JlIG1hdHVyaXR5IChhbmQgbm8gbWlzc2VkIG1hcmdpbiBjYWxsKS4AAAAAAAAGTm90RHVlAAAAAAAPAAAAflRoZSBVU0RDIHB1bGwgZmFpbGVkIChzaG9ydCBiYWxhbmNlLCBhbGxvd2FuY2UgdG9vIHNtYWxsIG9yIGV4cGlyZWQpLApvciB0aGUgY29sbGF0ZXJhbCBjb3VsZCBub3QgYmUgcmV0dXJuZWQgdG8gdGhlIGJvcnJvd2VyLgAAAAAAD0F1dG9SZXBheUZhaWxlZAAAAAAQAAAAR1RoZSBhc3NldCdzIGBub19uZXdfcmVwb3NgIG9yIGBub19zZWl6ZWAgc3dpdGNoIGJsb2NrcyB0aGlzIGNhbGwgKCMzMCkuAAAAAAZQYXVzZWQAAAAAABEAAACLTkFWIG91dHNpZGUgdGhlIGFzc2V0J3Mgc2FuaXR5IGJhbmQ6IGJleW9uZCBgbmF2X2Zsb29yYCAvIGBuYXZfY2VpbGluZ2AsCm9yIG1vcmUgdGhhbiBgbWF4X25hdl9tb3ZlX2Jwc2AgZnJvbSBhIHJlY2VudCBvcmFjbGUgcmVjb3JkICgjMzEpLgAAAAAMTmF2T3V0T2ZCYW5kAAAAEgAAAElgdGFrZV9vZmZlcmAgd291bGQgcHVzaCB0aGUgYXNzZXQncyBvcGVuIGRlYnQgcGFzdCBgbWF4X29wZW5fZGVidGAgKCMzMikuAAAAAAAAC0NhcEV4Y2VlZGVkAAAAABMAAABqVGhlIGNoYW5nZSBsb29zZW5zIHJpc2s6IGl0IG11c3QgZ28gdGhyb3VnaCBgcHJvcG9zZV8qYCwgd2FpdCBvdXQKYHRpbWVsb2NrX3NlY3NgLCB0aGVuIGBleGVjdXRlXypgICgjMzMpLgAAAAAAB0xvb3NlbnMAAAAAFAAAAChgZXhlY3V0ZV8qYCBiZWZvcmUgdGhlIHByb3Bvc2FsJ3MgYGV0YWAuAAAAD1RpbWVsb2NrTm90RG9uZQAAAAAVAAAAQWBleGVjdXRlXypgIG9yIGBjYW5jZWxfKmAgd2l0aCBubyBwZW5kaW5nIHByb3Bvc2FsIGZvciB0aGUgYXNzZXQuAAAAAAAACk5vUHJvcG9zYWwAAAAAABYAAAA4YGNhbmNlbF8qYCBieSBzb21lb25lIHdobyBpcyBuZWl0aGVyIGFkbWluIG5vciBndWFyZGlhbi4AAAASTm90QWRtaW5Pckd1YXJkaWFuAAAAAAAXAAAAMWBjbGFpbWAgYnkgYW4gYWRkcmVzcyB3aXRoIG5vIHBhcmtlZCBVU0RDIHBheW91dC4AAAAAAAAOTm90aGluZ1RvQ2xhaW0AAAAAABg=",
        "AAAABQAAAAAAAAAAAAAABlJlcGFpZAAAAAAAAQAAAAZyZXBhaWQAAAAAAAQAAAAAAAAAB3JlcG9faWQAAAAABgAAAAEAAAAAAAAADWxlbmRlcl9hbW91bnQAAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAARlRydWUgd2hlbiB0aGUgZGVidCB3YXMgcHVsbGVkIGJ5IGF1dG8tcmVwYXksIG5vdCBwYWlkIGJ5IHRoZSBib3Jyb3dlci4AAAAAAAlhdXRvbWF0aWMAAAAAAAABAAAAAAAAAAI=",
        "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",
        "AAAABQAAAAAAAAAAAAAADk9mZmVyQ2FuY2VsbGVkAAAAAAABAAAAD29mZmVyX2NhbmNlbGxlZAAAAAADAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAAAAAAAAZsZW5kZXIAAAAAABMAAAABAAAAHFVTREMgcmV0dXJuZWQgdG8gdGhlIGxlbmRlci4AAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAD9BZG1pbiBhZGRlZCBvciByZS10aWVyZWQgYSBjb2xsYXRlcmFsIGFzc2V0IChERUNJU0lPTlMubWQgIzEzKS4AAAAAAAAAAA9Bc3NldENvbmZpZ3VyZWQAAAAAAQAAABBhc3NldF9jb25maWd1cmVkAAAACQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAALaGFpcmN1dF9icHMAAAAABAAAAAAAAAAAAAAAEm1hcmdpbl90cmlnZ2VyX2JwcwAAAAAABAAAAAAAAAAAAAAAB2VuYWJsZWQAAAAAAQAAAAAAAAAAAAAAEG1heF9uYXZfYWdlX3NlY3MAAAAGAAAAAAAAAAAAAAAQbWF4X25hdl9tb3ZlX2JwcwAAAAQAAAAAAAAAAAAAAAluYXZfZmxvb3IAAAAAAAPoAAAACwAAAAAAAAAAAAAAC25hdl9jZWlsaW5nAAAAA+gAAAALAAAAAAAAAAAAAAANbWF4X29wZW5fZGVidAAAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAGpBIHByb3Bvc2FsIHRvb2sgZWZmZWN0LiBga2luZGAgaXMgYGFzc2V0YCBvciBgcGF1c2VgOyB0aGUgbWF0Y2hpbmcKYEFzc2V0Q29uZmlndXJlZGAgLyBgUGF1c2VTZXRgIGZvbGxvd3MuAAAAAAAAAAAAEFByb3Bvc2FsRXhlY3V0ZWQAAAABAAAAEXByb3Bvc2FsX2V4ZWN1dGVkAAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAEa2luZAAAABEAAAABAAAAAg==",
        "AAAABQAAAIVBIHByb3Bvc2FsIHdhcyBkcm9wcGVkOiBjYW5jZWxsZWQgYnkgYWRtaW4gb3IgZ3VhcmRpYW4sIG9yIHN1cGVyc2VkZWQKYnkgYW4gaW5zdGFudCBjaGFuZ2UgdG8gdGhlIHNhbWUgYXNzZXQgKGBieWAgbWFkZSB0aGF0IGNoYW5nZSkuAAAAAAAAAAAAABFQcm9wb3NhbENhbmNlbGxlZAAAAAAAAAEAAAAScHJvcG9zYWxfY2FuY2VsbGVkAAAAAAADAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAARraW5kAAAAEQAAAAEAAAAAAAAAAmJ5AAAAAAATAAAAAAAAAAI=",
        "AAAABQAAAERBZG1pbiBxdWV1ZWQgYW4gYXNzZXQgY2hhbmdlIGJlaGluZCB0aGUgdGltZWxvY2sgKERFQ0lTSU9OUy5tZCAjMzMpLgAAAAAAAAATQXNzZXRDaGFuZ2VQcm9wb3NlZAAAAAABAAAAFWFzc2V0X2NoYW5nZV9wcm9wb3NlZAAAAAAAAAoAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAAA2V0YQAAAAAGAAAAAAAAAAAAAAALaGFpcmN1dF9icHMAAAAABAAAAAAAAAAAAAAAEm1hcmdpbl90cmlnZ2VyX2JwcwAAAAAABAAAAAAAAAAAAAAAB2VuYWJsZWQAAAAAAQAAAAAAAAAAAAAAEG1heF9uYXZfYWdlX3NlY3MAAAAGAAAAAAAAAAAAAAAQbWF4X25hdl9tb3ZlX2JwcwAAAAQAAAAAAAAAAAAAAAluYXZfZmxvb3IAAAAAAAPoAAAACwAAAAAAAAAAAAAAC25hdl9jZWlsaW5nAAAAA+gAAAALAAAAAAAAAAAAAAANbWF4X29wZW5fZGVidAAAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAENBZG1pbiBxdWV1ZWQgYSBwYXVzZSBjaGFuZ2UgYmVoaW5kIHRoZSB0aW1lbG9jayAoREVDSVNJT05TLm1kICMzMykuAAAAAAAAAAATUGF1c2VDaGFuZ2VQcm9wb3NlZAAAAAABAAAAFXBhdXNlX2NoYW5nZV9wcm9wb3NlZAAAAAAAAAQAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAAA2V0YQAAAAAGAAAAAAAAAAAAAAAMbm9fbmV3X3JlcG9zAAAAAQAAAAAAAAAAAAAACG5vX3NlaXplAAAAAQAAAAAAAAAC" ]),
      options
    )
  }
  public readonly fromJSON = {
    repo: this.txFromJSON<Result<Repo>>,
        asset: this.txFromJSON<Result<AssetConfig>>,
        claim: this.txFromJSON<Result<i128>>,
        offer: this.txFromJSON<Result<Offer>>,
        pause: this.txFromJSON<Pause>,
        repay: this.txFromJSON<Result<void>>,
        config: this.txFromJSON<Config>,
        top_up: this.txFromJSON<Result<void>>,
        default: this.txFromJSON<Result<Status>>,
        claimable: this.txFromJSON<i128>,
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