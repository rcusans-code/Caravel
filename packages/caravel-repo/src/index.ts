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
    contractId: "CDI4BTHNLRFYGOUPBI2ZZNOYVD7XUYIY67FOZ37JR6GSCPFJVCSDTSL3",
  }
} as const


/**
 * A live or settled repo, created when a borrower takes an offer or a
 * lender fills a borrow request.
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
  /**
 * The offer taken; 0 for a repo born from a borrow request (offer ids
 * start at 1), which carries `request_id` instead.
 */
offer_id: u64;
  principal: i128;
  /**
 * The borrow request filled (`fill_request`); `None` for an offer-born
 * repo. Nothing else differs: both settle the same way.
 */
request_id: Option<u64>;
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
 * Loan token lent (`Config.usdc`: USDC, or EURC in a EUR market),
 * 7-decimal units.
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
 * Blocks `create_offer`, `take_offer`, `create_request` and
 * `fill_request`, like `AssetConfig.enabled = false` (an alias).
 * `cancel_offer` and `cancel_request` still work.
 */
no_new_repos: boolean;
  /**
 * Blocks `default` (except an auto-repay settle) and `liquidate`. The
 * default clock keeps running; seizure waits until this clears.
 */
no_seize: boolean;
}


/**
 * The role holders in force (the same as `config().admin` /
 * `config().guardian`) and any handover in flight (Raven R6).
 */
export interface Roles {
  admin: string;
  guardian: string;
  /**
 * `transfer_admin`'s nominee and the last ledger it can accept on.
 */
pending_admin: Option<string>;
  pending_admin_live_until: Option<u32>;
  /**
 * `propose_guardian`'s nominee and its `eta`.
 */
pending_guardian: Option<string>;
  pending_guardian_eta: Option<u64>;
}


/**
 * Protocol parameters, set at deploy. Stored in instance storage. Only
 * `admin` (`transfer_admin` + `accept_admin`) and `guardian`
 * (`propose_guardian` + `execute_guardian`) can change later (Raven R6).
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
 * set pause switches, cancel a pending proposal (once per change, Raven
 * R6). It can never loosen anything. The admin rotates it with
 * `propose_guardian` / `execute_guardian`, which it cannot cancel.
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
 * Currency the loan token is worth one unit of: `USD` (USDC market) or
 * `EUR` (EURC market), DECISIONS.md #52. The constructor requires the
 * feed's `base()` to be `Other(quote)`, so collateral is priced in the
 * loan currency. An admin assertion: the contract cannot check that
 * `usdc` really is that currency.
 */
quote: string;
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
 * Loan token: Circle USDC, or EURC in a EUR market (DECISIONS.md #52).
 * Every principal, interest, fee and proceeds amount moves in it. The
 * name stays `usdc` so app, keeper and bindings need no rename.
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
 * Settle time for a real NAV move past the band (nav-review side
 * band-real-move): a latest NAV outside the `max_nav_move_bps` window is
 * still accepted once it has stood this many seconds of ledger time, as
 * measured by the repo's own `note_nav` clock ([`BandCandidate`]), never
 * by feed timestamps. Production 86_400 (24 h), demo 1_200. Raising it
 * is a tightening (instant); lowering it waits out the timelock (#33).
 * `u64::MAX` turns the settle path off (window roll only). Must be > 0.
 */
band_settle_secs: u64;
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
 * Exposure cap (DECISIONS.md #32): total debt (principal + interest, loan
 * token 7 decimals: USDC, or EURC in a EUR market) of live repos on this
 * asset, in this repo contract only (a second market listing the same
 * token has its own cap, #52). `take_offer` fails with
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
 * The NAV level the repo has watched stand, per oracle asset (nav-review
 * side band-real-move). `note_nav` sets it to the latest NAV with
 * `since` = ledger now, and restarts it whenever the latest NAV, or any
 * feed record stamped at or after `since`, is more than
 * `max_nav_move_bps` away from `price`. Stored apart from `AssetConfig`
 * so `set_asset` never restarts the clock.
 */
export interface BandCandidate {
  /**
 * NAV in the feed's own scale.
 */
price: i128;
  /**
 * Ledger timestamp when the repo first saw this level.
 */
since: u64;
}


/**
 * A borrower's standing request (borrow requests, the mirror of [`Offer`]):
 * "lend me `principal` USDC for `term_secs` at `apr_bps`, here is my
 * collateral". The whole `collateral_amount` is escrowed in the contract
 * from `create_request` until it is filled (it becomes the repo's
 * collateral) or cancelled (it goes back to the borrower). No NAV check at
 * posting; `fill_request` checks it against the asset's haircut.
 */
export interface BorrowRequest {
  apr_bps: u32;
  borrower: string;
  /**
 * Collateral escrowed, in the token's own units (DECISIONS.md #28).
 */
collateral_amount: i128;
  /**
 * Collateral token escrowed (e.g. tBENJI SAC, tSAFO).
 */
collateral_asset: string;
  created_at: u64;
  id: u64;
  /**
 * USDC asked for, 7-decimal units.
 */
principal: i128;
  term_secs: u64;
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
  24: {message:"NothingToClaim"},
  /**
   * `claim_in_kind` while the NAV is fresh, or stale for no longer than
   * `inkind::NAV_OUTAGE_DAYS` demo/real days: use `liquidate` or wait.
   */
  25: {message:"NoNavOutage"},
  /**
   * `execute_*` after the proposal's window closed (`eta + timelock_secs`):
   * propose it again (#33, issue #41).
   */
  26: {message:"ProposalExpired"},
  /**
   * The guardian already cancelled (or superseded) this exact change
   * once; the admin's re-proposal of it can only be cancelled by the
   * admin (Raven R6, UA-02).
   */
  27: {message:"VetoSpent"},
  /**
   * No borrow request with this id: never posted, cancelled or filled.
   */
  28: {message:"RequestNotFound"},
  /**
   * `fill_request` with the lender's or the borrower's USDC frozen by
   * the issuer (Raven AS-03): the payment leg cannot move.
   */
  29: {message:"UsdcFrozen"}
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
   * Construct and simulate a roles transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin and guardian in force (always equal to `config()`'s) and any
   * handover in flight: `transfer_admin` waiting for `accept_admin`, a
   * `propose_guardian` waiting out the timelock (Raven R6).
   */
  roles: (options?: MethodOptions) => Promise<AssembledTransaction<Roles>>

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
   * Construct and simulate a request transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * An open borrow request; `RequestNotFound` once filled or cancelled.
   */
  request: ({request_id}: {request_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BorrowRequest>>>

  /**
   * Construct and simulate a note_nav transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Starts or keeps the band settle clock for collateral `asset`. Anyone
   * can call it; keeper and nav-keeper call it every tick. If the latest
   * NAV (or a feed record since the clock started) has moved more than
   * `max_nav_move_bps` from the stored level, the level restarts at the
   * latest NAV with `since` = ledger now (`NavLevelNoted`); else nothing
   * changes. A latest NAV outside the #31 window is then accepted by
   * `take_offer`, `check_margin`, `default`, `liquidate` and `top_up`
   * once the level has stood `band_settle_secs`. Returns the level in
   * force. Errors: `AssetNotSupported`, `NoPrice`.
   */
  note_nav: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BandCandidate>>>

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
   * 
   * A stale NAV stays blocking however long the outage lasts; the lender's
   * way out of a long outage is `claim_in_kind`.
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
   * the NAV band, raise `band_settle_secs`). Requires
   * `band_settle_secs > 0`. Anything
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
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The pending admin takes the role (it signs). `NoProposal` if no
   * handover is pending or it lapsed; `InvalidConfig` if it has become
   * the guardian meanwhile. Emits `AdminSet`.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Drops the pending asset change. The admin any time. The guardian
   * once per change (Raven R6, UA-02): if the admin proposes the change
   * it cancelled again, unchanged, the guardian gets `VetoSpent` and the
   * change executes after the timelock unless the admin drops it. So
   * the guardian can delay a change by one timelock, never block it for
   * good. Cancelling a proposal whose window closed spends nothing.
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
   * Drops the pending pause change: the admin any time, the guardian
   * once per change, as in `cancel_asset` (Raven R6, UA-02).
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
   * Construct and simulate a fill_request transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Lender's atomic DvP on a borrow request: the lender's USDC goes to
   * the borrower and the escrowed collateral backs the new repo, in one
   * tx. Returns the repo id. Debt = principal + full-term interest (#15);
   * the escrow must cover `required_collateral(debt, nav, dec, haircut)`
   * at a fresh, in-band NAV (#6, #31), else `InsufficientCollateral` and
   * the request stays posted. All of the escrow becomes the repo's
   * collateral. Rejects a frozen USDC account on either side
   * (`UsdcFrozen`), a disabled asset (#23), `no_new_repos` (#30) and an
   * exposure past the cap (`CapExceeded`, #32). The haircut is
   * snapshotted (#19), `auto_repay` starts off (`set_auto_repay` turns it
   * on) and `offer_id` is 0 with `request_id` set. From here the repo is
   * the same as an offer-born one.
   */
  fill_request: ({lender, request_id}: {lender: string, request_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a claim_in_kind transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The lender takes a Defaulted repo's whole collateral in kind once the
   * asset's NAV has been stale for more than `inkind::NAV_OUTAGE_DAYS`
   * days (`day_secs` each) past `max_nav_age_secs`; `liquidate` stays
   * blocked on a stale NAV. No sale: no fee, no borrower surplus, the
   * whole debt leaves `open_debt` and the repo is `Liquidated`
   * (`ClaimedInKind` event). If the token refuses the push to the lender
   * (permissioned token, frozen trustline) the collateral is parked for
   * `claim_collateral` and the claim still lands. Returns the collateral
   * amount. Lender signs.
   * 
   * `InvalidStatus` unless Defaulted, `Paused` under `no_seize` (#30),
   * `NoNavOutage` while the NAV is fresh or not stale long enough. A feed
   * with no usable timestamp (no price, a price `<= 0`, or one dated more
   * than `oracle::MAX_FUTURE_SKEW_SECS` ahead) starts the same clock at
   * `maturity_ts + grace_secs` instead (`inkind::nav_outage`). Until the
   * claim lands the borrower can still `repay`, which needs no NAV.
   */
  claim_in_kind: ({repo_id}: {repo_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a execute_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Applies the pending asset change from its `eta` until
   * `eta + timelock_secs` (`TimelockNotDone` before, `ProposalExpired`
   * after).
   */
  execute_asset: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Applies the pending pause change in the same window as `execute_asset`.
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
   * returned `eta` (now + `timelock_secs`) until `eta + timelock_secs`,
   * then it expires. A new proposal replaces the pending one (with a
   * `ProposalCancelled` for it) and restarts the clock.
   */
  propose_asset: ({asset, config}: {asset: string, config: AssetConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a propose_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Queues pause switches for `asset` (typically clearing one);
   * `execute_pause` applies them from the returned `eta` until
   * `eta + timelock_secs`. Replacing a pending one works as in
   * `propose_asset`.
   */
  propose_pause: ({asset, pause}: {asset: string, pause: Pause}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a band_candidate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The NAV level the repo has watched stand for `asset`'s oracle asset
   * and since when (side band-real-move), if `note_nav` ever ran.
   */
  band_candidate: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Option<BandCandidate>>>>

  /**
   * Construct and simulate a cancel_request transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the escrowed collateral to the borrower. Only the borrower
   * can cancel, and only while the request is unfilled. No pause switch
   * blocks it (#30).
   */
  cancel_request: ({request_id}: {request_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_request transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Posts a borrow request: escrows `collateral_amount` of
   * `collateral_asset` from the borrower and asks for `principal` USDC
   * for `term_secs` at `apr_bps`. Returns the request id (its own
   * counter, apart from offers). Same guards as `create_offer`:
   * `InvalidAmount` for a non-positive amount or zero term,
   * `AssetNotSupported` for a missing or disabled asset (#22), `Paused`
   * under `no_new_repos` (#30), `MathOverflow` if the terms overflow the
   * debt math. No NAV is read: `fill_request` checks the collateral.
   */
  create_request: ({borrower, collateral_asset, collateral_amount, principal, apr_bps, term_secs}: {borrower: string, collateral_asset: string, collateral_amount: i128, principal: i128, apr_bps: u32, term_secs: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a set_auto_repay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Turns auto-repay on or off for a live repo (#27). On approves this
   * contract to pull the debt in USDC from maturity; off takes that
   * approval back. Borrower only; setting the current value is a no-op.
   */
  set_auto_repay: ({repo_id, enabled}: {repo_id: u64, enabled: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_liquidator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Removes `liquidator` from the whitelist at once and drops a pending
   * addition for it (`LiquidatorSet { allowed: false }`). Adding is
   * timelocked (Raven UA-03): `allowed = true` fails with `Loosens` (20)
   * unless `liquidator` is already whitelisted (then a no-op); use
   * `propose_liquidator` + `execute_liquidator`. The signature is kept for
   * existing clients, so that error is raised as a contract panic.
   */
  set_liquidator: ({liquidator, allowed}: {liquidator: string, allowed: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a transfer_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Starts handing the admin role to `new_admin`, who must call
   * `accept_admin` by ledger `live_until_ledger` (Raven UA-06; pending
   * entry in temporary storage, as OpenZeppelin's Ownable does). A new
   * call replaces the pending handover; `live_until_ledger = 0` cancels
   * it (`NoProposal` if none). `InvalidConfig` if `new_admin` is the
   * guardian or the ledger is in the past or beyond the max TTL.
   */
  transfer_admin: ({new_admin, live_until_ledger}: {new_admin: string, live_until_ledger: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_guardian transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Drops the pending guardian rotation. Admin only.
   */
  cancel_guardian: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_collateral transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sends `who`'s whole parked balance of collateral `asset` to `to` and
   * returns the amount. `who` signs; `to` may differ, so a lender a
   * permissioned token never admits can route it to an admitted custody
   * account. `NothingToClaim` if nothing is parked; if the token still
   * refuses `to`, the call reverts and the balance stays parked.
   */
  claim_collateral: ({who, asset, to}: {who: string, asset: string, to: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a execute_guardian transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Makes the proposed guardian current, in the same window as
   * `execute_asset`. Emits `GuardianSet`.
   */
  execute_guardian: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a propose_guardian transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Queues a new guardian behind the timelock (Raven UA-02). Only the
   * admin can cancel it (`cancel_guardian`), so a lost or hostile
   * guardian is replaced after one timelock. A re-proposal replaces the
   * pending one. `InvalidConfig` if `guardian` is the admin.
   */
  propose_guardian: ({guardian}: {guardian: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a cancel_liquidator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Drops a pending liquidator addition. The admin any time; the
   * guardian once per address (`VetoSpent` on a re-proposal of one it
   * already cancelled; Raven R6).
   */
  cancel_liquidator: ({caller, liquidator}: {caller: string, liquidator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_liquidator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds the proposed liquidator from its `eta` until
   * `eta + timelock_secs` (`TimelockNotDone` before, `ProposalExpired`
   * after). Emits `LiquidatorSet { allowed: true }`.
   */
  execute_liquidator: ({liquidator}: {liquidator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a guardian_set_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The guardian's instant `set_asset` on a listed asset: disable it,
   * raise the haircut or the margin trigger, lower the NAV age or the cap,
   * narrow the NAV band, raise `band_settle_secs`. Fails with
   * `Loosens` if any field adds risk, `AssetNotSupported` if unlisted.
   * A real change drops a pending admin proposal for the asset, but
   * only once per proposed change (it spends the guardian's veto, see
   * `cancel_asset`); re-sending the current config drops nothing (Raven
   * R6, UA-02).
   */
  guardian_set_asset: ({asset, config}: {asset: string, config: AssetConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a guardian_set_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The guardian's instant `set_pause`: can switch on, never off. Drops
   * a pending pause proposal like `guardian_set_asset`: never on a
   * no-op re-assert, once per proposed change otherwise.
   */
  guardian_set_pause: ({asset, pause}: {asset: string, pause: Pause}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pending_liquidator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The `eta` of a liquidator addition waiting out the timelock, if any
   * (Raven UA-03).
   */
  pending_liquidator: ({who}: {who: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a propose_liquidator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Queues `liquidator` for the whitelist; `execute_liquidator` adds it
   * in the same window as `execute_asset` (Raven UA-03). A re-proposal
   * replaces the pending one and restarts the clock.
   */
  propose_liquidator: ({liquidator}: {liquidator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a claimable_collateral transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Collateral of `asset` parked for `who` because an in-kind claim could
   * not push it (permissioned token refused, frozen trustline);
   * `claim_collateral` pays it out. 0 if none.
   */
  claimable_collateral: ({who, asset}: {who: string, asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

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
        "AAAAAAAAAL1BZG1pbiBhbmQgZ3VhcmRpYW4gaW4gZm9yY2UgKGFsd2F5cyBlcXVhbCB0byBgY29uZmlnKClgJ3MpIGFuZCBhbnkKaGFuZG92ZXIgaW4gZmxpZ2h0OiBgdHJhbnNmZXJfYWRtaW5gIHdhaXRpbmcgZm9yIGBhY2NlcHRfYWRtaW5gLCBhCmBwcm9wb3NlX2d1YXJkaWFuYCB3YWl0aW5nIG91dCB0aGUgdGltZWxvY2sgKFJhdmVuIFI2KS4AAAAAAAAFcm9sZXMAAAAAAAAAAAAAAQAAB9AAAAAFUm9sZXMAAAA=",
        "AAAAAAAAAAAAAAAGY29uZmlnAAAAAAAAAAAAAQAAB9AAAAAGQ29uZmlnAAA=",
        "AAAAAAAAAStBZGRzIGNvbGxhdGVyYWwuIENsZWFycyBhIG1hcmdpbiBjYWxsIG9uY2UKYGx0dl9vayhkZWJ0LCBjb2xsYXRlcmFsLCBuYXYsIGRlYywgcmVwby5oYWlyY3V0X2JwcylgIGhvbGRzLCBpLmUuIHRoZQppbml0aWFsIG1hcmdpbiBpcyByZXN0b3JlZCAoVHJhZEZpIGNvbnZlbnRpb24pLiBXb3JrcyB3aXRoIHN0YWxlIE5BVgphbmQgd2l0aCBOQVYgb3V0c2lkZSB0aGUgc2FuaXR5IGJhbmQ7IGFuIG91dC1vZi1iYW5kIE5BViBuZXZlciBjbGVhcnMKYSBjYWxsICgjMzEpLiBObyBwYXVzZSBzd2l0Y2ggYmxvY2tzIGl0ICgjMzApLgAAAAAGdG9wX3VwAAAAAAACAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAABABNb3ZlcyBhIHJlcG8gdG8gYERlZmF1bHRlZGAgb25jZSBpdCBpcyBwYXN0IG1hdHVyaXR5ICsgZ3JhY2UsIG9yIGluCmBNYXJnaW5DYWxsYCBwYXN0IGl0cyBgbWFyZ2luX2NhbGxfZGVhZGxpbmVgIChzZXQgYnkgYGNoZWNrX21hcmdpbmApLgpBbnlvbmUgY2FuIGNhbGwgaXQgKCM3KTsgYSBtYXR1cml0eSBkZWZhdWx0IG5lZWRzIG5vIE5BViAoIzE3KS4gQm90aApkZWFkbGluZXMgYXJlIHN0cmljdDogYXQgdGhlIGV4YWN0IHNlY29uZCB0aGUgYm9ycm93ZXIgY2FuIHN0aWxsIHJlcGF5Cm9yIHRvcCB1cC4KCkEgbWlzc2VkIGNhbGwgZmlyc3QgcmUtY2hlY2tzIHRoZSBicmVhY2ggYXQgYSBmcmVzaCwgaW4tYmFuZCBOQVYKKCMyMCk6IG5vIGxvbmdlciBwYXN0IHRoZSB0cmlnZ2VyLCBpdCByZXR1cm5zIHRvIGBPcGVuYCBhbmQgZW1pdHMKYE1hcmdpbkNsZWFyZWRgLiBTdGlsbCBwYXN0IGl0LCBpdCBkZWZhdWx0cy4gV2l0aCBubyBwcmljZSwgYSBzdGFsZQpOQVYgb3Igb25lIG91dHNpZGUgdGhlIHNhbml0eSBiYW5kIGl0IHJldHVybnMgYE5vUHJpY2VgIC8gYFN0YWxlTmF2YCAvCmBOYXZPdXRPZkJhbmRgIGFuZCB3YWl0czogYSBtaXNzZWQgY2FsbCBkZWZhdWx0cyBvbmx5IG9uIGEgZnJlc2gsCmluLWJhbmQgTkFWIHRoYXQgY29uZmlybXMgdGhlIGJyZWFjaC4gTWF0dXJpdHkgZGVmYXVsdHMgbmV2ZXIgcmVhZCB0aGUKTkFWLgoKQW4gb3B0ZWQtaW4gcmVwbyB0cmllcyBhdXRvLXJlcGF5IGZpcnN0ICgjMjcpIGFuZCBzZXR0bGVzIGFzIGBSZXBhaWRgCndoZW4gdGhlIHB1bGwgc3VjY2VlZHMgYW5kIHRoZSBjb2xsYXRlcmFsIGNhbiBiZSByZXR1cm5lZDsgb3RoZXJ3aXNlCnRoZSBwdWxsIGlzIHJlZnVuZGVkIGFuZCB0aGUgcmVwbyBkZWZhdWx0cy4gUmV0dXJucyB0aGUgcmVzdWx0aW5nCnN0YXR1cy4KCldoaWxlIHRoZSBhc3NldCdzIGBub19zZWl6ZWAgc3dpdGNoIGlzIG9uICgjMzApIGEgcmVwbyB0aGF0IHdvdWxkCmRlZmF1bHQgcmV0dXJucyBgUGF1c2VkYCBhbmQgc3RheXMgYE9wZW5gAAAAB2RlZmF1bHQAAAAAAQAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAA+kAAAfQAAAABlN0YXR1cwAAAAAAAw==",
        "AAAAAAAAAENBbiBvcGVuIGJvcnJvdyByZXF1ZXN0OyBgUmVxdWVzdE5vdEZvdW5kYCBvbmNlIGZpbGxlZCBvciBjYW5jZWxsZWQuAAAAAAdyZXF1ZXN0AAAAAAEAAAAAAAAACnJlcXVlc3RfaWQAAAAAAAYAAAABAAAD6QAAB9AAAAANQm9ycm93UmVxdWVzdAAAAAAAAAM=",
        "AAAAAAAAAklTdGFydHMgb3Iga2VlcHMgdGhlIGJhbmQgc2V0dGxlIGNsb2NrIGZvciBjb2xsYXRlcmFsIGBhc3NldGAuIEFueW9uZQpjYW4gY2FsbCBpdDsga2VlcGVyIGFuZCBuYXYta2VlcGVyIGNhbGwgaXQgZXZlcnkgdGljay4gSWYgdGhlIGxhdGVzdApOQVYgKG9yIGEgZmVlZCByZWNvcmQgc2luY2UgdGhlIGNsb2NrIHN0YXJ0ZWQpIGhhcyBtb3ZlZCBtb3JlIHRoYW4KYG1heF9uYXZfbW92ZV9icHNgIGZyb20gdGhlIHN0b3JlZCBsZXZlbCwgdGhlIGxldmVsIHJlc3RhcnRzIGF0IHRoZQpsYXRlc3QgTkFWIHdpdGggYHNpbmNlYCA9IGxlZGdlciBub3cgKGBOYXZMZXZlbE5vdGVkYCk7IGVsc2Ugbm90aGluZwpjaGFuZ2VzLiBBIGxhdGVzdCBOQVYgb3V0c2lkZSB0aGUgIzMxIHdpbmRvdyBpcyB0aGVuIGFjY2VwdGVkIGJ5CmB0YWtlX29mZmVyYCwgYGNoZWNrX21hcmdpbmAsIGBkZWZhdWx0YCwgYGxpcXVpZGF0ZWAgYW5kIGB0b3BfdXBgCm9uY2UgdGhlIGxldmVsIGhhcyBzdG9vZCBgYmFuZF9zZXR0bGVfc2Vjc2AuIFJldHVybnMgdGhlIGxldmVsIGluCmZvcmNlLiBFcnJvcnM6IGBBc3NldE5vdFN1cHBvcnRlZGAsIGBOb1ByaWNlYC4AAAAAAAAIbm90ZV9uYXYAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6QAAB9AAAAANQmFuZENhbmRpZGF0ZQAAAAAAAAM=",
        "AAAAAAAAAHdVU0RDIHBhcmtlZCBmb3IgYHdob2AgYmVjYXVzZSBhIHBheW91dCB0byBpdCBmYWlsZWQgKGZyb3plbiBhY2NvdW50LApjbG9zZWQgdHJ1c3RsaW5lKTsgYGNsYWltYCBwYXlzIGl0IG91dC4gMCBpZiBub25lLgAAAAAJY2xhaW1hYmxlAAAAAAAAAQAAAAAAAAADd2hvAAAAABMAAAABAAAACw==",
        "AAAAAAAAA01BIHdoaXRlbGlzdGVkIGxpcXVpZGF0b3IgYnV5cyBhIGRlZmF1bHRlZCByZXBvJ3MgY29sbGF0ZXJhbCBhdApOQVYgw5cgKDEg4oiSIGRpc2NvdW50KSwgcm91bmRlZCB1cC4gVGhlIFVTREMgZ29lcyBsZW5kZXIgZmlyc3QgKGNhcHBlZCBhdApwcmluY2lwYWwgKyBpbnRlcmVzdCDiiJIgZmVlKSwgdGhlbiB0aGUgZmVlLCB0aGVuIHRoZSBib3Jyb3dlciAoIzMsICM0KS4KSWYgcHJvY2VlZHMgZmFsbCBzaG9ydCBvZiB3aGF0IHRoZSBsZW5kZXIgaXMgb3dlZCwgdGhlIGxlbmRlciB0YWtlcwpldmVyeXRoaW5nIGFuZCBgU2hvcnRmYWxsYCBpcyBlbWl0dGVkLiBTdGFsZSBOQVYgcmV0dXJucyBgU3RhbGVOYXZgICgjNiksCk5BViBvdXRzaWRlIHRoZSBhc3NldCdzIHNhbml0eSBiYW5kIGBOYXZPdXRPZkJhbmRgICgjMzEpLiBUaGUgYXNzZXQncwpgbm9fc2VpemVgIHN3aXRjaCByZXR1cm5zIGBQYXVzZWRgICgjMzApLiBUaGUgcmVwbydzIG93biBib3Jyb3dlciBpcwpuZXZlciBhIGxpcXVpZGF0b3Igb2YgaXQgKGBOb3RMaXF1aWRhdG9yYCksIHdoaXRlbGlzdGVkIG9yIG5vdC4gVGhlCmxpcXVpZGF0b3IgcGF5cyB0aGUgcHJvY2VlZHMgaW50byB0aGUgY29udHJhY3Q7IGEgbGVuZGVyLCB0cmVhc3VyeSBvcgpib3Jyb3dlciBwYXlvdXQgdGhhdCBmYWlscyAoZnJvemVuIGFjY291bnQpIGlzIHBhcmtlZCBmb3IgYGNsYWltYCBhbmQKdGhlIGxpcXVpZGF0aW9uIHN0aWxsIGxhbmRzLgoKQSBzdGFsZSBOQVYgc3RheXMgYmxvY2tpbmcgaG93ZXZlciBsb25nIHRoZSBvdXRhZ2UgbGFzdHM7IHRoZSBsZW5kZXIncwp3YXkgb3V0IG9mIGEgbG9uZyBvdXRhZ2UgaXMgYGNsYWltX2luX2tpbmRgLgAAAAAAAAlsaXF1aWRhdGUAAAAAAAACAAAAAAAAAApsaXF1aWRhdG9yAAAAAAATAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAItEZWJ0IChwcmluY2lwYWwgKyBpbnRlcmVzdCkgb2YgbGl2ZSByZXBvcyBvbiBgYXNzZXRgLCB0aGUgYW1vdW50CmNvdW50ZWQgYWdhaW5zdCBgQXNzZXRDb25maWcubWF4X29wZW5fZGVidGAgKCMzMikuIDAgZm9yIGFuIHVua25vd24gYXNzZXQuAAAAAAlvcGVuX2RlYnQAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAACw==",
        "AAAAAAAAA9VBZGRzIG9yIHJlLXRpZXJzIGEgY29sbGF0ZXJhbCBhc3NldCAoREVDSVNJT05TLm1kICMxMykuIFJlcXVpcmVzCmBsaXF1aWRhdGlvbl9kaXNjb3VudF9icHMg4omkIG1hcmdpbl90cmlnZ2VyX2JwcyA8IGhhaXJjdXRfYnBzIDwgMTBfMDAwYAooIzI2KTogYSB0YWtlIGF0IG1heCBMVFYgb3BlbnMgc3RyaWN0bHkgYmVsb3cgdGhlIG1hcmdpbiB0cmlnZ2VyLCBhbmQgYQpsaXF1aWRhdGlvbiBhdCB0aGUgdHJpZ2dlciBsaW5lIHN0aWxsIGNvdmVycyB0aGUgZGVidC4KUmVxdWlyZXMgYG1heF9uYXZfYWdlX3NlY3MgPiAwYCAoc3RhbGVuZXNzIGlzIHBlciBhc3NldCwgIzI1KSwgYQp2YWxpZCBOQVYgc2FuaXR5IGJhbmQgKCMzMSk6IGBtYXhfbmF2X21vdmVfYnBzID4gMGAsIGVhY2ggYm91bmQgPiAwIGlmCnNldCwgYW5kIGBuYXZfZmxvb3IgPD0gbmF2X2NlaWxpbmdgLCBhbmQgYG1heF9vcGVuX2RlYnQg4omlIDBgICgjMzIpLgpSZS1zZXR0aW5nIGFuIGFzc2V0IGtlZXBzIGl0cyBvcGVuIGRlYnQ7IGEgY2FwIGJlbG93IGl0IG9ubHkgc3RvcHMgbmV3CnRha2VzLgoKSW5zdGFudCBvbmx5IGZvciBhIGZpcnN0IGxpc3RpbmcgKG5vIG9mZmVyIGNhbiBleGlzdCBvbiBhbiB1bmxpc3RlZAphc3NldCkgb3IgYSBjaGFuZ2UgdGhhdCBvbmx5IHRpZ2h0ZW5zICgjMzM6IGRpc2FibGUsIHJhaXNlIHRoZQpoYWlyY3V0IG9yIHRoZSBtYXJnaW4gdHJpZ2dlciwgbG93ZXIgdGhlIE5BViBhZ2Ugb3IgdGhlIGNhcCwgbmFycm93CnRoZSBOQVYgYmFuZCwgcmFpc2UgYGJhbmRfc2V0dGxlX3NlY3NgKS4gUmVxdWlyZXMKYGJhbmRfc2V0dGxlX3NlY3MgPiAwYC4gQW55dGhpbmcKdGhhdCBsb29zZW5zIGZhaWxzIHdpdGggYExvb3NlbnNgOiB1c2UgYHByb3Bvc2VfYXNzZXRgLiBBbiBpbnN0YW50CmNoYW5nZSBkcm9wcyBhIHBlbmRpbmcgcHJvcG9zYWwgZm9yIHRoZSBhc3NldCwgc28gaXQgY2Fubm90IHVuZG8gdGhlCmNoYW5nZSBsYXRlci4AAAAAAAAJc2V0X2Fzc2V0AAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAZjb25maWcAAAAAB9AAAAALQXNzZXRDb25maWcAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAXtTZXRzIGFuIGFzc2V0J3MgcGF1c2Ugc3dpdGNoZXMgKERFQ0lTSU9OUy5tZCAjMzApLiBFYWNoIG9uZSBzdG9wcyBvbmUKYWN0aW9uOiBgbm9fbmV3X3JlcG9zYCBibG9ja3MgYGNyZWF0ZV9vZmZlcmAgLyBgdGFrZV9vZmZlcmAsCmBub19zZWl6ZWAgYmxvY2tzIGBkZWZhdWx0YCBhbmQgYGxpcXVpZGF0ZWAuIE5vdGhpbmcgcGF1c2VzIGByZXBheWAKb3IgYHRvcF91cGAuIFN0b3JlZCBhcGFydCBmcm9tIGBBc3NldENvbmZpZ2AsIHNvIGBzZXRfYXNzZXRgIG5ldmVyCmNsZWFycyBhIHBhdXNlLiBJbnN0YW50IG9ubHkgZm9yIHN3aXRjaGluZyBvbiAoIzMzKTsgY2xlYXJpbmcgYQpzd2l0Y2ggZmFpbHMgd2l0aCBgTG9vc2Vuc2A6IHVzZSBgcHJvcG9zZV9wYXVzZWAuAAAAAAlzZXRfcGF1c2UAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABXBhdXNlAAAAAAAH0AAAAAVQYXVzZQAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAYxSZXBheXMgYW4gb3B0ZWQtaW4gcmVwbyBmcm9tIHRoZSBib3Jyb3dlcidzIFVTREMgYWxsb3dhbmNlICgjMjcpLgpBbnlvbmUgY2FuIGNhbGwgaXQgZnJvbSBtYXR1cml0eSwgb3Igb25jZSBhIG1hcmdpbiBjYWxsJ3MgZGVhZGxpbmUgaGFzCnBhc3NlZC4gT24gc3VjY2VzcyB0aGUgcmVwbyBpcyBgUmVwYWlkYCBleGFjdGx5IGFzIGlmIHRoZSBib3Jyb3dlciBoYWQKY2FsbGVkIGByZXBheWAuIElmIHRoZSBwdWxsIGZhaWxzLCBvciB0aGUgY29sbGF0ZXJhbCBjYW5ub3QgYmUgcmV0dXJuZWQKdG8gdGhlIGJvcnJvd2VyLCB0aGUgcmVwbyBpcyB1bnRvdWNoZWQgYW5kIHRoZSBjYWxsIHJldHVybnMKYEF1dG9SZXBheUZhaWxlZGA7IHRoZSBib3Jyb3dlciBjYW4gc3RpbGwgcmVwYXkgYnkgaGFuZC4AAAAKYXV0b19yZXBheQAAAAAAAQAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAA2xBdG9taWMgRHZQOiBjb2xsYXRlcmFsIGluLCBlc2Nyb3dlZCBVU0RDIG91dC4gUmV0dXJucyB0aGUgcmVwbyBpZC4KRnVsbCB0YWtlcyBvbmx5IChERUNJU0lPTlMubWQgIzE2KTogdGhlIGNvbnRyYWN0IGNvbXB1dGVzCmBjb2xsYXRlcmFsID0gcmVxdWlyZWRfY29sbGF0ZXJhbChkZWJ0LCBuYXYsIGRlYywgaGFpcmN1dClgLCByb3VuZGVkIHVwLAphbmQgZml4ZXMgZGVidCA9IHByaW5jaXBhbCArIGZ1bGwtdGVybSBpbnRlcmVzdCAoIzE1KS4gVGhlIGJvcnJvd2VyJ3MKYXV0aCBvbiB0aGUgU0FDIHRyYW5zZmVyIHBpbnMgdGhlIGV4YWN0IGFtb3VudCwgc28gaWYgTkFWIG1vdmVzIGJldHdlZW4Kc2ltdWxhdGUgYW5kIHN1Ym1pdCB0aGUgdHggZmFpbHMgaW5zdGVhZCBvZiBvdmVyY2hhcmdpbmcgKCMyMSkuCgpSZWplY3RzIHN0YWxlIE5BViAoIzYpLCBOQVYgb3V0c2lkZSB0aGUgYXNzZXQncyBzYW5pdHkgYmFuZCAoIzMxKSwgYW4KYXNzZXQgZGlzYWJsZWQgc2luY2UgdGhlIG9mZmVyIHdhcyBwb3N0ZWQgKCMyMykgYW5kIGFuIGFzc2V0IHBhdXNlZAp3aXRoIGBub19uZXdfcmVwb3NgICgjMzApLiBUaGUgaGFpcmN1dCBpcyBzbmFwc2hvdHRlZCBvbiB0aGUgcmVwbyAoIzE5KS4KUmVqZWN0cyB3aXRoIGBDYXBFeGNlZWRlZGAgaWYgdGhlIGFzc2V0J3Mgb3BlbiBkZWJ0IHBsdXMgdGhpcyBkZWJ0CndvdWxkIHBhc3MgYG1heF9vcGVuX2RlYnRgICgjMzIpOyB0aGUgb2ZmZXIgc3RheXMgb24gdGhlIGJvYXJkLgoKYGF1dG9fcmVwYXlgIG9wdHMgaW4gdG8gYXV0by1yZXBheSAoIzI3KTogdGhlIHNhbWUgc2lnbmF0dXJlIGFsc28KYXBwcm92ZXMgdGhpcyBjb250cmFjdCB0byBwdWxsIHRoZSBkZWJ0IGluIFVTREMgZnJvbSBtYXR1cml0eS4AAAAKdGFrZV9vZmZlcgAAAAAAAwAAAAAAAAAIYm9ycm93ZXIAAAATAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAAAAAAACmF1dG9fcmVwYXkAAAAAAAEAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAKxUaGUgcGVuZGluZyBhZG1pbiB0YWtlcyB0aGUgcm9sZSAoaXQgc2lnbnMpLiBgTm9Qcm9wb3NhbGAgaWYgbm8KaGFuZG92ZXIgaXMgcGVuZGluZyBvciBpdCBsYXBzZWQ7IGBJbnZhbGlkQ29uZmlnYCBpZiBpdCBoYXMgYmVjb21lCnRoZSBndWFyZGlhbiBtZWFud2hpbGUuIEVtaXRzIGBBZG1pblNldGAuAAAADGFjY2VwdF9hZG1pbgAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAY5Ecm9wcyB0aGUgcGVuZGluZyBhc3NldCBjaGFuZ2UuIFRoZSBhZG1pbiBhbnkgdGltZS4gVGhlIGd1YXJkaWFuCm9uY2UgcGVyIGNoYW5nZSAoUmF2ZW4gUjYsIFVBLTAyKTogaWYgdGhlIGFkbWluIHByb3Bvc2VzIHRoZSBjaGFuZ2UKaXQgY2FuY2VsbGVkIGFnYWluLCB1bmNoYW5nZWQsIHRoZSBndWFyZGlhbiBnZXRzIGBWZXRvU3BlbnRgIGFuZCB0aGUKY2hhbmdlIGV4ZWN1dGVzIGFmdGVyIHRoZSB0aW1lbG9jayB1bmxlc3MgdGhlIGFkbWluIGRyb3BzIGl0LiBTbwp0aGUgZ3VhcmRpYW4gY2FuIGRlbGF5IGEgY2hhbmdlIGJ5IG9uZSB0aW1lbG9jaywgbmV2ZXIgYmxvY2sgaXQgZm9yCmdvb2QuIENhbmNlbGxpbmcgYSBwcm9wb3NhbCB3aG9zZSB3aW5kb3cgY2xvc2VkIHNwZW5kcyBub3RoaW5nLgAAAAAADGNhbmNlbF9hc3NldAAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAH1SZXR1cm5zIHRoZSBlc2Nyb3dlZCBVU0RDIHRvIHRoZSBsZW5kZXIuIE9ubHkgdGhlIGxlbmRlciBjYW4gY2FuY2VsLAphbmQgb25seSB3aGlsZSB0aGUgb2ZmZXIgaXMgdW50YWtlbiAoYSB0YWtlIHJlbW92ZXMgaXQpLgAAAAAAAAxjYW5jZWxfb2ZmZXIAAAABAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAHlEcm9wcyB0aGUgcGVuZGluZyBwYXVzZSBjaGFuZ2U6IHRoZSBhZG1pbiBhbnkgdGltZSwgdGhlIGd1YXJkaWFuCm9uY2UgcGVyIGNoYW5nZSwgYXMgaW4gYGNhbmNlbF9hc3NldGAgKFJhdmVuIFI2LCBVQS0wMikuAAAAAAAADGNhbmNlbF9wYXVzZQAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAALpTZXRzIGBtYXJnaW5fY2FsbF9kZWFkbGluZWAgb24gdGhlIGZpcnN0IGBtYXJnaW5fYnJlYWNoZWRgLiBSZXR1cm5zIHRoZQpzdGF0dXMuIFN0YWxlIE5BViByZXR1cm5zIGBTdGFsZU5hdmAgKERFQ0lTSU9OUy5tZCAjMTcpLCBOQVYgb3V0c2lkZQp0aGUgYXNzZXQncyBzYW5pdHkgYmFuZCBgTmF2T3V0T2ZCYW5kYCAoIzMxKS4AAAAAAAxjaGVja19tYXJnaW4AAAABAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAB9AAAAAGU3RhdHVzAAAAAAAD",
        "AAAAAAAAAQdFc2Nyb3dzIGBwcmluY2lwYWxgIFVTREMgZnJvbSB0aGUgbGVuZGVyLiBSZXR1cm5zIHRoZSBvZmZlciBpZC4KVGhlIGhhaXJjdXQgY29tZXMgZnJvbSB0aGUgYXNzZXQncyBgQXNzZXRDb25maWdgLCBub3QgdGhlIGxlbmRlci4KUmVqZWN0cyBhIG1pc3Npbmcgb3IgZGlzYWJsZWQgYXNzZXQgd2l0aCBgQXNzZXROb3RTdXBwb3J0ZWRgICgjMjIpLAphbmQgYFBhdXNlZGAgd2hpbGUgdGhlIGFzc2V0J3MgYG5vX25ld19yZXBvc2Agc3dpdGNoIGlzIG9uICgjMzApLgAAAAAMY3JlYXRlX29mZmVyAAAABQAAAAAAAAAGbGVuZGVyAAAAAAATAAAAAAAAABBjb2xsYXRlcmFsX2Fzc2V0AAAAEwAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAHYXByX2JwcwAAAAAEAAAAAAAAAAl0ZXJtX3NlY3MAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAvdMZW5kZXIncyBhdG9taWMgRHZQIG9uIGEgYm9ycm93IHJlcXVlc3Q6IHRoZSBsZW5kZXIncyBVU0RDIGdvZXMgdG8KdGhlIGJvcnJvd2VyIGFuZCB0aGUgZXNjcm93ZWQgY29sbGF0ZXJhbCBiYWNrcyB0aGUgbmV3IHJlcG8sIGluIG9uZQp0eC4gUmV0dXJucyB0aGUgcmVwbyBpZC4gRGVidCA9IHByaW5jaXBhbCArIGZ1bGwtdGVybSBpbnRlcmVzdCAoIzE1KTsKdGhlIGVzY3JvdyBtdXN0IGNvdmVyIGByZXF1aXJlZF9jb2xsYXRlcmFsKGRlYnQsIG5hdiwgZGVjLCBoYWlyY3V0KWAKYXQgYSBmcmVzaCwgaW4tYmFuZCBOQVYgKCM2LCAjMzEpLCBlbHNlIGBJbnN1ZmZpY2llbnRDb2xsYXRlcmFsYCBhbmQKdGhlIHJlcXVlc3Qgc3RheXMgcG9zdGVkLiBBbGwgb2YgdGhlIGVzY3JvdyBiZWNvbWVzIHRoZSByZXBvJ3MKY29sbGF0ZXJhbC4gUmVqZWN0cyBhIGZyb3plbiBVU0RDIGFjY291bnQgb24gZWl0aGVyIHNpZGUKKGBVc2RjRnJvemVuYCksIGEgZGlzYWJsZWQgYXNzZXQgKCMyMyksIGBub19uZXdfcmVwb3NgICgjMzApIGFuZCBhbgpleHBvc3VyZSBwYXN0IHRoZSBjYXAgKGBDYXBFeGNlZWRlZGAsICMzMikuIFRoZSBoYWlyY3V0IGlzCnNuYXBzaG90dGVkICgjMTkpLCBgYXV0b19yZXBheWAgc3RhcnRzIG9mZiAoYHNldF9hdXRvX3JlcGF5YCB0dXJucyBpdApvbikgYW5kIGBvZmZlcl9pZGAgaXMgMCB3aXRoIGByZXF1ZXN0X2lkYCBzZXQuIEZyb20gaGVyZSB0aGUgcmVwbyBpcwp0aGUgc2FtZSBhcyBhbiBvZmZlci1ib3JuIG9uZS4AAAAADGZpbGxfcmVxdWVzdAAAAAIAAAAAAAAABmxlbmRlcgAAAAAAEwAAAAAAAAAKcmVxdWVzdF9pZAAAAAAABgAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAPpTdG9yZXMgYGNvbmZpZ2Agb25jZS4gYEludmFsaWRDb25maWdgIHVubGVzcyBgdmFsaWRhdGVfY29uZmlnYCBob2xkcywKYHF1b3RlYCBpcyBgVVNEYCBvciBgRVVSYCBhbmQgdGhlIGZlZWQgcXVvdGVzIGluIGl0CihgYmFzZSgpID09IE90aGVyKHF1b3RlKWAsIFJhdmVuIFNURC0wMSwgREVDSVNJT05TLm1kICM1MikgYW5kCmB1c2RjLmRlY2ltYWxzKCkgPT0gN2AsIHRoZSBzY2FsZSBhbGwgdmFsdWUgbWF0aCBhc3N1bWVzIChDUy0wNykuAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAEAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAZDb25maWcAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAA8RUaGUgbGVuZGVyIHRha2VzIGEgRGVmYXVsdGVkIHJlcG8ncyB3aG9sZSBjb2xsYXRlcmFsIGluIGtpbmQgb25jZSB0aGUKYXNzZXQncyBOQVYgaGFzIGJlZW4gc3RhbGUgZm9yIG1vcmUgdGhhbiBgaW5raW5kOjpOQVZfT1VUQUdFX0RBWVNgCmRheXMgKGBkYXlfc2Vjc2AgZWFjaCkgcGFzdCBgbWF4X25hdl9hZ2Vfc2Vjc2A7IGBsaXF1aWRhdGVgIHN0YXlzCmJsb2NrZWQgb24gYSBzdGFsZSBOQVYuIE5vIHNhbGU6IG5vIGZlZSwgbm8gYm9ycm93ZXIgc3VycGx1cywgdGhlCndob2xlIGRlYnQgbGVhdmVzIGBvcGVuX2RlYnRgIGFuZCB0aGUgcmVwbyBpcyBgTGlxdWlkYXRlZGAKKGBDbGFpbWVkSW5LaW5kYCBldmVudCkuIElmIHRoZSB0b2tlbiByZWZ1c2VzIHRoZSBwdXNoIHRvIHRoZSBsZW5kZXIKKHBlcm1pc3Npb25lZCB0b2tlbiwgZnJvemVuIHRydXN0bGluZSkgdGhlIGNvbGxhdGVyYWwgaXMgcGFya2VkIGZvcgpgY2xhaW1fY29sbGF0ZXJhbGAgYW5kIHRoZSBjbGFpbSBzdGlsbCBsYW5kcy4gUmV0dXJucyB0aGUgY29sbGF0ZXJhbAphbW91bnQuIExlbmRlciBzaWducy4KCmBJbnZhbGlkU3RhdHVzYCB1bmxlc3MgRGVmYXVsdGVkLCBgUGF1c2VkYCB1bmRlciBgbm9fc2VpemVgICgjMzApLApgTm9OYXZPdXRhZ2VgIHdoaWxlIHRoZSBOQVYgaXMgZnJlc2ggb3Igbm90IHN0YWxlIGxvbmcgZW5vdWdoLiBBIGZlZWQKd2l0aCBubyB1c2FibGUgdGltZXN0YW1wIChubyBwcmljZSwgYSBwcmljZSBgPD0gMGAsIG9yIG9uZSBkYXRlZCBtb3JlCnRoYW4gYG9yYWNsZTo6TUFYX0ZVVFVSRV9TS0VXX1NFQ1NgIGFoZWFkKSBzdGFydHMgdGhlIHNhbWUgY2xvY2sgYXQKYG1hdHVyaXR5X3RzICsgZ3JhY2Vfc2Vjc2AgaW5zdGVhZCAoYGlua2luZDo6bmF2X291dGFnZWApLiBVbnRpbCB0aGUKY2xhaW0gbGFuZHMgdGhlIGJvcnJvd2VyIGNhbiBzdGlsbCBgcmVwYXlgLCB3aGljaCBuZWVkcyBubyBOQVYuAAAADWNsYWltX2luX2tpbmQAAAAAAAABAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAIBBcHBsaWVzIHRoZSBwZW5kaW5nIGFzc2V0IGNoYW5nZSBmcm9tIGl0cyBgZXRhYCB1bnRpbApgZXRhICsgdGltZWxvY2tfc2Vjc2AgKGBUaW1lbG9ja05vdERvbmVgIGJlZm9yZSwgYFByb3Bvc2FsRXhwaXJlZGAKYWZ0ZXIpLgAAAA1leGVjdXRlX2Fzc2V0AAAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAEdBcHBsaWVzIHRoZSBwZW5kaW5nIHBhdXNlIGNoYW5nZSBpbiB0aGUgc2FtZSB3aW5kb3cgYXMgYGV4ZWN1dGVfYXNzZXRgLgAAAAANZXhlY3V0ZV9wYXVzZQAAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANaXNfbGlxdWlkYXRvcgAAAAAAAAEAAAAAAAAAA3dobwAAAAATAAAAAQAAAAE=",
        "AAAAAAAAAD5UaGUgYWRtaW4gYXNzZXQgY2hhbmdlIHdhaXRpbmcgb3V0IHRoZSB0aW1lbG9jaywgaWYgYW55ICgjMzMpLgAAAAAADXBlbmRpbmdfYXNzZXQAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAB9AAAAAMUGVuZGluZ0Fzc2V0",
        "AAAAAAAAAD5UaGUgYWRtaW4gcGF1c2UgY2hhbmdlIHdhaXRpbmcgb3V0IHRoZSB0aW1lbG9jaywgaWYgYW55ICgjMzMpLgAAAAAADXBlbmRpbmdfcGF1c2UAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAB9AAAAAMUGVuZGluZ1BhdXNl",
        "AAAAAAAAAPlRdWV1ZXMgYGNvbmZpZ2AgZm9yIGBhc3NldGA7IGBleGVjdXRlX2Fzc2V0YCBhcHBsaWVzIGl0IGZyb20gdGhlCnJldHVybmVkIGBldGFgIChub3cgKyBgdGltZWxvY2tfc2Vjc2ApIHVudGlsIGBldGEgKyB0aW1lbG9ja19zZWNzYCwKdGhlbiBpdCBleHBpcmVzLiBBIG5ldyBwcm9wb3NhbCByZXBsYWNlcyB0aGUgcGVuZGluZyBvbmUgKHdpdGggYQpgUHJvcG9zYWxDYW5jZWxsZWRgIGZvciBpdCkgYW5kIHJlc3RhcnRzIHRoZSBjbG9jay4AAAAAAAANcHJvcG9zZV9hc3NldAAAAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAGY29uZmlnAAAAAAfQAAAAC0Fzc2V0Q29uZmlnAAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAMJRdWV1ZXMgcGF1c2Ugc3dpdGNoZXMgZm9yIGBhc3NldGAgKHR5cGljYWxseSBjbGVhcmluZyBvbmUpOwpgZXhlY3V0ZV9wYXVzZWAgYXBwbGllcyB0aGVtIGZyb20gdGhlIHJldHVybmVkIGBldGFgIHVudGlsCmBldGEgKyB0aW1lbG9ja19zZWNzYC4gUmVwbGFjaW5nIGEgcGVuZGluZyBvbmUgd29ya3MgYXMgaW4KYHByb3Bvc2VfYXNzZXRgLgAAAAAADXByb3Bvc2VfcGF1c2UAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABXBhdXNlAAAAAAAH0AAAAAVQYXVzZQAAAAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAIFUaGUgTkFWIGxldmVsIHRoZSByZXBvIGhhcyB3YXRjaGVkIHN0YW5kIGZvciBgYXNzZXRgJ3Mgb3JhY2xlIGFzc2V0CmFuZCBzaW5jZSB3aGVuIChzaWRlIGJhbmQtcmVhbC1tb3ZlKSwgaWYgYG5vdGVfbmF2YCBldmVyIHJhbi4AAAAAAAAOYmFuZF9jYW5kaWRhdGUAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAD6AAAB9AAAAANQmFuZENhbmRpZGF0ZQAAAAAAAAM=",
        "AAAAAAAAAJdSZXR1cm5zIHRoZSBlc2Nyb3dlZCBjb2xsYXRlcmFsIHRvIHRoZSBib3Jyb3dlci4gT25seSB0aGUgYm9ycm93ZXIKY2FuIGNhbmNlbCwgYW5kIG9ubHkgd2hpbGUgdGhlIHJlcXVlc3QgaXMgdW5maWxsZWQuIE5vIHBhdXNlIHN3aXRjaApibG9ja3MgaXQgKCMzMCkuAAAAAA5jYW5jZWxfcmVxdWVzdAAAAAAAAQAAAAAAAAAKcmVxdWVzdF9pZAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAfVQb3N0cyBhIGJvcnJvdyByZXF1ZXN0OiBlc2Nyb3dzIGBjb2xsYXRlcmFsX2Ftb3VudGAgb2YKYGNvbGxhdGVyYWxfYXNzZXRgIGZyb20gdGhlIGJvcnJvd2VyIGFuZCBhc2tzIGZvciBgcHJpbmNpcGFsYCBVU0RDCmZvciBgdGVybV9zZWNzYCBhdCBgYXByX2Jwc2AuIFJldHVybnMgdGhlIHJlcXVlc3QgaWQgKGl0cyBvd24KY291bnRlciwgYXBhcnQgZnJvbSBvZmZlcnMpLiBTYW1lIGd1YXJkcyBhcyBgY3JlYXRlX29mZmVyYDoKYEludmFsaWRBbW91bnRgIGZvciBhIG5vbi1wb3NpdGl2ZSBhbW91bnQgb3IgemVybyB0ZXJtLApgQXNzZXROb3RTdXBwb3J0ZWRgIGZvciBhIG1pc3Npbmcgb3IgZGlzYWJsZWQgYXNzZXQgKCMyMiksIGBQYXVzZWRgCnVuZGVyIGBub19uZXdfcmVwb3NgICgjMzApLCBgTWF0aE92ZXJmbG93YCBpZiB0aGUgdGVybXMgb3ZlcmZsb3cgdGhlCmRlYnQgbWF0aC4gTm8gTkFWIGlzIHJlYWQ6IGBmaWxsX3JlcXVlc3RgIGNoZWNrcyB0aGUgY29sbGF0ZXJhbC4AAAAAAAAOY3JlYXRlX3JlcXVlc3QAAAAAAAYAAAAAAAAACGJvcnJvd2VyAAAAEwAAAAAAAAAQY29sbGF0ZXJhbF9hc3NldAAAABMAAAAAAAAAEWNvbGxhdGVyYWxfYW1vdW50AAAAAAAACwAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAHYXByX2JwcwAAAAAEAAAAAAAAAAl0ZXJtX3NlY3MAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAMZUdXJucyBhdXRvLXJlcGF5IG9uIG9yIG9mZiBmb3IgYSBsaXZlIHJlcG8gKCMyNykuIE9uIGFwcHJvdmVzIHRoaXMKY29udHJhY3QgdG8gcHVsbCB0aGUgZGVidCBpbiBVU0RDIGZyb20gbWF0dXJpdHk7IG9mZiB0YWtlcyB0aGF0CmFwcHJvdmFsIGJhY2suIEJvcnJvd2VyIG9ubHk7IHNldHRpbmcgdGhlIGN1cnJlbnQgdmFsdWUgaXMgYSBuby1vcC4AAAAAAA5zZXRfYXV0b19yZXBheQAAAAAAAgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAAAAAAdlbmFibGVkAAAAAAEAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAY1SZW1vdmVzIGBsaXF1aWRhdG9yYCBmcm9tIHRoZSB3aGl0ZWxpc3QgYXQgb25jZSBhbmQgZHJvcHMgYSBwZW5kaW5nCmFkZGl0aW9uIGZvciBpdCAoYExpcXVpZGF0b3JTZXQgeyBhbGxvd2VkOiBmYWxzZSB9YCkuIEFkZGluZyBpcwp0aW1lbG9ja2VkIChSYXZlbiBVQS0wMyk6IGBhbGxvd2VkID0gdHJ1ZWAgZmFpbHMgd2l0aCBgTG9vc2Vuc2AgKDIwKQp1bmxlc3MgYGxpcXVpZGF0b3JgIGlzIGFscmVhZHkgd2hpdGVsaXN0ZWQgKHRoZW4gYSBuby1vcCk7IHVzZQpgcHJvcG9zZV9saXF1aWRhdG9yYCArIGBleGVjdXRlX2xpcXVpZGF0b3JgLiBUaGUgc2lnbmF0dXJlIGlzIGtlcHQgZm9yCmV4aXN0aW5nIGNsaWVudHMsIHNvIHRoYXQgZXJyb3IgaXMgcmFpc2VkIGFzIGEgY29udHJhY3QgcGFuaWMuAAAAAAAADnNldF9saXF1aWRhdG9yAAAAAAACAAAAAAAAAApsaXF1aWRhdG9yAAAAAAATAAAAAAAAAAdhbGxvd2VkAAAAAAEAAAAA",
        "AAAAAAAAAYNTdGFydHMgaGFuZGluZyB0aGUgYWRtaW4gcm9sZSB0byBgbmV3X2FkbWluYCwgd2hvIG11c3QgY2FsbApgYWNjZXB0X2FkbWluYCBieSBsZWRnZXIgYGxpdmVfdW50aWxfbGVkZ2VyYCAoUmF2ZW4gVUEtMDY7IHBlbmRpbmcKZW50cnkgaW4gdGVtcG9yYXJ5IHN0b3JhZ2UsIGFzIE9wZW5aZXBwZWxpbidzIE93bmFibGUgZG9lcykuIEEgbmV3CmNhbGwgcmVwbGFjZXMgdGhlIHBlbmRpbmcgaGFuZG92ZXI7IGBsaXZlX3VudGlsX2xlZGdlciA9IDBgIGNhbmNlbHMKaXQgKGBOb1Byb3Bvc2FsYCBpZiBub25lKS4gYEludmFsaWRDb25maWdgIGlmIGBuZXdfYWRtaW5gIGlzIHRoZQpndWFyZGlhbiBvciB0aGUgbGVkZ2VyIGlzIGluIHRoZSBwYXN0IG9yIGJleW9uZCB0aGUgbWF4IFRUTC4AAAAADnRyYW5zZmVyX2FkbWluAAAAAAACAAAAAAAAAAluZXdfYWRtaW4AAAAAAAATAAAAAAAAABFsaXZlX3VudGlsX2xlZGdlcgAAAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAADBEcm9wcyB0aGUgcGVuZGluZyBndWFyZGlhbiByb3RhdGlvbi4gQWRtaW4gb25seS4AAAAPY2FuY2VsX2d1YXJkaWFuAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAUhTZW5kcyBgd2hvYCdzIHdob2xlIHBhcmtlZCBiYWxhbmNlIG9mIGNvbGxhdGVyYWwgYGFzc2V0YCB0byBgdG9gIGFuZApyZXR1cm5zIHRoZSBhbW91bnQuIGB3aG9gIHNpZ25zOyBgdG9gIG1heSBkaWZmZXIsIHNvIGEgbGVuZGVyIGEKcGVybWlzc2lvbmVkIHRva2VuIG5ldmVyIGFkbWl0cyBjYW4gcm91dGUgaXQgdG8gYW4gYWRtaXR0ZWQgY3VzdG9keQphY2NvdW50LiBgTm90aGluZ1RvQ2xhaW1gIGlmIG5vdGhpbmcgaXMgcGFya2VkOyBpZiB0aGUgdG9rZW4gc3RpbGwKcmVmdXNlcyBgdG9gLCB0aGUgY2FsbCByZXZlcnRzIGFuZCB0aGUgYmFsYW5jZSBzdGF5cyBwYXJrZWQuAAAAEGNsYWltX2NvbGxhdGVyYWwAAAADAAAAAAAAAAN3aG8AAAAAEwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAJ0bwAAAAAAEwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAGBNYWtlcyB0aGUgcHJvcG9zZWQgZ3VhcmRpYW4gY3VycmVudCwgaW4gdGhlIHNhbWUgd2luZG93IGFzCmBleGVjdXRlX2Fzc2V0YC4gRW1pdHMgYEd1YXJkaWFuU2V0YC4AAAAQZXhlY3V0ZV9ndWFyZGlhbgAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAPxRdWV1ZXMgYSBuZXcgZ3VhcmRpYW4gYmVoaW5kIHRoZSB0aW1lbG9jayAoUmF2ZW4gVUEtMDIpLiBPbmx5IHRoZQphZG1pbiBjYW4gY2FuY2VsIGl0IChgY2FuY2VsX2d1YXJkaWFuYCksIHNvIGEgbG9zdCBvciBob3N0aWxlCmd1YXJkaWFuIGlzIHJlcGxhY2VkIGFmdGVyIG9uZSB0aW1lbG9jay4gQSByZS1wcm9wb3NhbCByZXBsYWNlcyB0aGUKcGVuZGluZyBvbmUuIGBJbnZhbGlkQ29uZmlnYCBpZiBgZ3VhcmRpYW5gIGlzIHRoZSBhZG1pbi4AAAAQcHJvcG9zZV9ndWFyZGlhbgAAAAEAAAAAAAAACGd1YXJkaWFuAAAAEwAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAJxEcm9wcyBhIHBlbmRpbmcgbGlxdWlkYXRvciBhZGRpdGlvbi4gVGhlIGFkbWluIGFueSB0aW1lOyB0aGUKZ3VhcmRpYW4gb25jZSBwZXIgYWRkcmVzcyAoYFZldG9TcGVudGAgb24gYSByZS1wcm9wb3NhbCBvZiBvbmUgaXQKYWxyZWFkeSBjYW5jZWxsZWQ7IFJhdmVuIFI2KS4AAAARY2FuY2VsX2xpcXVpZGF0b3IAAAAAAAACAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAACmxpcXVpZGF0b3IAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAKVBZGRzIHRoZSBwcm9wb3NlZCBsaXF1aWRhdG9yIGZyb20gaXRzIGBldGFgIHVudGlsCmBldGEgKyB0aW1lbG9ja19zZWNzYCAoYFRpbWVsb2NrTm90RG9uZWAgYmVmb3JlLCBgUHJvcG9zYWxFeHBpcmVkYAphZnRlcikuIEVtaXRzIGBMaXF1aWRhdG9yU2V0IHsgYWxsb3dlZDogdHJ1ZSB9YC4AAAAAAAASZXhlY3V0ZV9saXF1aWRhdG9yAAAAAAABAAAAAAAAAApsaXF1aWRhdG9yAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAddUaGUgZ3VhcmRpYW4ncyBpbnN0YW50IGBzZXRfYXNzZXRgIG9uIGEgbGlzdGVkIGFzc2V0OiBkaXNhYmxlIGl0LApyYWlzZSB0aGUgaGFpcmN1dCBvciB0aGUgbWFyZ2luIHRyaWdnZXIsIGxvd2VyIHRoZSBOQVYgYWdlIG9yIHRoZSBjYXAsCm5hcnJvdyB0aGUgTkFWIGJhbmQsIHJhaXNlIGBiYW5kX3NldHRsZV9zZWNzYC4gRmFpbHMgd2l0aApgTG9vc2Vuc2AgaWYgYW55IGZpZWxkIGFkZHMgcmlzaywgYEFzc2V0Tm90U3VwcG9ydGVkYCBpZiB1bmxpc3RlZC4KQSByZWFsIGNoYW5nZSBkcm9wcyBhIHBlbmRpbmcgYWRtaW4gcHJvcG9zYWwgZm9yIHRoZSBhc3NldCwgYnV0Cm9ubHkgb25jZSBwZXIgcHJvcG9zZWQgY2hhbmdlIChpdCBzcGVuZHMgdGhlIGd1YXJkaWFuJ3MgdmV0bywgc2VlCmBjYW5jZWxfYXNzZXRgKTsgcmUtc2VuZGluZyB0aGUgY3VycmVudCBjb25maWcgZHJvcHMgbm90aGluZyAoUmF2ZW4KUjYsIFVBLTAyKS4AAAAAEmd1YXJkaWFuX3NldF9hc3NldAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAZjb25maWcAAAAAB9AAAAALQXNzZXRDb25maWcAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAALdUaGUgZ3VhcmRpYW4ncyBpbnN0YW50IGBzZXRfcGF1c2VgOiBjYW4gc3dpdGNoIG9uLCBuZXZlciBvZmYuIERyb3BzCmEgcGVuZGluZyBwYXVzZSBwcm9wb3NhbCBsaWtlIGBndWFyZGlhbl9zZXRfYXNzZXRgOiBuZXZlciBvbiBhCm5vLW9wIHJlLWFzc2VydCwgb25jZSBwZXIgcHJvcG9zZWQgY2hhbmdlIG90aGVyd2lzZS4AAAAAEmd1YXJkaWFuX3NldF9wYXVzZQAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAVwYXVzZQAAAAAAB9AAAAAFUGF1c2UAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAFJUaGUgYGV0YWAgb2YgYSBsaXF1aWRhdG9yIGFkZGl0aW9uIHdhaXRpbmcgb3V0IHRoZSB0aW1lbG9jaywgaWYgYW55CihSYXZlbiBVQS0wMykuAAAAAAAScGVuZGluZ19saXF1aWRhdG9yAAAAAAABAAAAAAAAAAN3aG8AAAAAEwAAAAEAAAPoAAAABg==",
        "AAAAAAAAALdRdWV1ZXMgYGxpcXVpZGF0b3JgIGZvciB0aGUgd2hpdGVsaXN0OyBgZXhlY3V0ZV9saXF1aWRhdG9yYCBhZGRzIGl0CmluIHRoZSBzYW1lIHdpbmRvdyBhcyBgZXhlY3V0ZV9hc3NldGAgKFJhdmVuIFVBLTAzKS4gQSByZS1wcm9wb3NhbApyZXBsYWNlcyB0aGUgcGVuZGluZyBvbmUgYW5kIHJlc3RhcnRzIHRoZSBjbG9jay4AAAAAEnByb3Bvc2VfbGlxdWlkYXRvcgAAAAAAAQAAAAAAAAAKbGlxdWlkYXRvcgAAAAAAEwAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAKxDb2xsYXRlcmFsIG9mIGBhc3NldGAgcGFya2VkIGZvciBgd2hvYCBiZWNhdXNlIGFuIGluLWtpbmQgY2xhaW0gY291bGQKbm90IHB1c2ggaXQgKHBlcm1pc3Npb25lZCB0b2tlbiByZWZ1c2VkLCBmcm96ZW4gdHJ1c3RsaW5lKTsKYGNsYWltX2NvbGxhdGVyYWxgIHBheXMgaXQgb3V0LiAwIGlmIG5vbmUuAAAAFGNsYWltYWJsZV9jb2xsYXRlcmFsAAAAAgAAAAAAAAADd2hvAAAAABMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAL",
        "AAAAAQAAAGJBIGxpdmUgb3Igc2V0dGxlZCByZXBvLCBjcmVhdGVkIHdoZW4gYSBib3Jyb3dlciB0YWtlcyBhbiBvZmZlciBvciBhCmxlbmRlciBmaWxscyBhIGJvcnJvdyByZXF1ZXN0LgAAAAAAAAAAAARSZXBvAAAADwAAAIVCb3Jyb3dlciBvcHRlZCBpbiB0byBhdXRvLXJlcGF5IChERUNJU0lPTlMubWQgIzI3KTogZnJvbSBtYXR1cml0eSB0aGUKZGVidCBpcyBwdWxsZWQgZnJvbSB0aGVpciBVU0RDIGFsbG93YW5jZSBpbnN0ZWFkIG9mIGRlZmF1bHRpbmcuAAAAAAAACmF1dG9fcmVwYXkAAAAAAAEAAAAAAAAACGJvcnJvd2VyAAAAEwAAAIFDb2xsYXRlcmFsIGhlbGQgYnkgdGhlIGNvbnRyYWN0LCBpbiB0aGUgdG9rZW4ncyBvd24gdW5pdHMgKGl0cwpgZGVjaW1hbHMoKWA6IDcgZm9yIHRCRU5KSSwgNSBmb3IgU3Bpa28gdG9rZW5zOyBERUNJU0lPTlMubWQgIzI4KS4AAAAAAAARY29sbGF0ZXJhbF9hbW91bnQAAAAAAAALAAAAAAAAABBjb2xsYXRlcmFsX2Fzc2V0AAAAEwAAAH5TbmFwc2hvdCBvZiB0aGUgYXNzZXQgaGFpcmN1dCBhdCB0YWtlIHRpbWUuIFRoZSB0b3AtdXAgdGFyZ2V0OiBhCm1hcmdpbiBjYWxsIGNsZWFycyBvbmNlIGBsdHZfb2tgIGhvbGRzIGF0IHRoaXMgaGFpcmN1dCBhZ2Fpbi4AAAAAAAtoYWlyY3V0X2JwcwAAAAAEAAAAAAAAAAJpZAAAAAAABgAAAHdGdWxsLXRlcm0gaW50ZXJlc3QsIGZpeGVkIGF0IHRha2UgdGltZS4gRGVidCA9IHByaW5jaXBhbCArIGludGVyZXN0LAp0aGUgc2FtZSBhbW91bnQgb24gZWFybHkgcmVwYXkgKERFQ0lTSU9OUy5tZCAjMTUpLgAAAAAIaW50ZXJlc3QAAAALAAAAAAAAAAZsZW5kZXIAAAAAABMAAABBU2V0IG9uY2Ugb24gdGhlIGZpcnN0IG1hcmdpbiBicmVhY2g7IGNsZWFyZWQgYnkgYSBoZWFsdGh5IHRvcC11cC4AAAAAAAAUbWFyZ2luX2NhbGxfZGVhZGxpbmUAAAPoAAAABgAAAAAAAAALbWF0dXJpdHlfdHMAAAAABgAAAHRUaGUgb2ZmZXIgdGFrZW47IDAgZm9yIGEgcmVwbyBib3JuIGZyb20gYSBib3Jyb3cgcmVxdWVzdCAob2ZmZXIgaWRzCnN0YXJ0IGF0IDEpLCB3aGljaCBjYXJyaWVzIGByZXF1ZXN0X2lkYCBpbnN0ZWFkLgAAAAhvZmZlcl9pZAAAAAYAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAB6VGhlIGJvcnJvdyByZXF1ZXN0IGZpbGxlZCAoYGZpbGxfcmVxdWVzdGApOyBgTm9uZWAgZm9yIGFuIG9mZmVyLWJvcm4KcmVwby4gTm90aGluZyBlbHNlIGRpZmZlcnM6IGJvdGggc2V0dGxlIHRoZSBzYW1lIHdheS4AAAAAAApyZXF1ZXN0X2lkAAAAAAPoAAAABgAAAAAAAAAIc3RhcnRfdHMAAAAGAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAGU3RhdHVzAAA=",
        "AAAAAgAAAGpTRVAtNDAgYXNzZXQgaWRlbnRpZmllciwgc2FtZSBzaGFwZSBhcyBSZWZsZWN0b3Incywgc28gdGhlIG1vY2sgb3JhY2xlIGFuZApsaXZlIGZlZWRzIGFjY2VwdCBpdCB1bmNoYW5nZWQuAAAAAAAAAAAABUFzc2V0AAAAAAAAAgAAAAEAAAAAAAAAB1N0ZWxsYXIAAAAAAQAAABMAAAABAAAAAAAAAAVPdGhlcgAAAAAAAAEAAAAR",
        "AAAAAQAAAN9BIGxlbmRlcidzIHN0YW5kaW5nIG9mZmVyLiBUaGUgbGVuZGVyIHNldHMgb25seSBhc3NldCwgcHJpbmNpcGFsLCBBUFIgYW5kCnRlcm07IHRoZSBoYWlyY3V0IGNvbWVzIGZyb20gdGhlIGFzc2V0J3MgYEFzc2V0Q29uZmlnYC4gVGhlIHByaW5jaXBhbCBpcyBlc2Nyb3dlZCBpbiB0aGUgY29udHJhY3QKZnJvbSBgY3JlYXRlX29mZmVyYCB1bnRpbCBpdCBpcyB0YWtlbiBvciBjYW5jZWxsZWQuAAAAAAAAAAAFT2ZmZXIAAAAAAAAHAAAAAAAAAAdhcHJfYnBzAAAAAAQAAAA2Q29sbGF0ZXJhbCB0b2tlbiB0aGUgbGVuZGVyIGFjY2VwdHMgKGUuZy4gdEJFTkpJIFNBQykuAAAAAAAQY29sbGF0ZXJhbF9hc3NldAAAABMAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAAAmlkAAAAAAAGAAAAAAAAAAZsZW5kZXIAAAAAABMAAABQTG9hbiB0b2tlbiBsZW50IChgQ29uZmlnLnVzZGNgOiBVU0RDLCBvciBFVVJDIGluIGEgRVVSIG1hcmtldCksCjctZGVjaW1hbCB1bml0cy4AAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAJdGVybV9zZWNzAAAAAAAABg==",
        "AAAAAQAAANFQZXItYXNzZXQgZW1lcmdlbmN5IHN3aXRjaGVzIChERUNJU0lPTlMubWQgIzMwKSwgc3RvcmVkIGFwYXJ0IGZyb20KYEFzc2V0Q29uZmlnYCBzbyByZS10aWVyaW5nIGFuIGFzc2V0IG5ldmVyIGNsZWFycyBhIHBhdXNlLiBFYWNoIHN3aXRjaApzdG9wcyBvbmUgYWN0aW9uIGFuZCBub3RoaW5nIGVsc2U7IGByZXBheWAgYW5kIGB0b3BfdXBgIGhhdmUgbm8gc3dpdGNoLgAAAAAAAAAAAAAFUGF1c2UAAAAAAAACAAAAqEJsb2NrcyBgY3JlYXRlX29mZmVyYCwgYHRha2Vfb2ZmZXJgLCBgY3JlYXRlX3JlcXVlc3RgIGFuZApgZmlsbF9yZXF1ZXN0YCwgbGlrZSBgQXNzZXRDb25maWcuZW5hYmxlZCA9IGZhbHNlYCAoYW4gYWxpYXMpLgpgY2FuY2VsX29mZmVyYCBhbmQgYGNhbmNlbF9yZXF1ZXN0YCBzdGlsbCB3b3JrLgAAAAxub19uZXdfcmVwb3MAAAABAAAAgUJsb2NrcyBgZGVmYXVsdGAgKGV4Y2VwdCBhbiBhdXRvLXJlcGF5IHNldHRsZSkgYW5kIGBsaXF1aWRhdGVgLiBUaGUKZGVmYXVsdCBjbG9jayBrZWVwcyBydW5uaW5nOyBzZWl6dXJlIHdhaXRzIHVudGlsIHRoaXMgY2xlYXJzLgAAAAAAAAhub19zZWl6ZQAAAAE=",
        "AAAAAQAAAHVUaGUgcm9sZSBob2xkZXJzIGluIGZvcmNlICh0aGUgc2FtZSBhcyBgY29uZmlnKCkuYWRtaW5gIC8KYGNvbmZpZygpLmd1YXJkaWFuYCkgYW5kIGFueSBoYW5kb3ZlciBpbiBmbGlnaHQgKFJhdmVuIFI2KS4AAAAAAAAAAAAABVJvbGVzAAAAAAAABgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAhndWFyZGlhbgAAABMAAABAYHRyYW5zZmVyX2FkbWluYCdzIG5vbWluZWUgYW5kIHRoZSBsYXN0IGxlZGdlciBpdCBjYW4gYWNjZXB0IG9uLgAAAA1wZW5kaW5nX2FkbWluAAAAAAAD6AAAABMAAAAAAAAAGHBlbmRpbmdfYWRtaW5fbGl2ZV91bnRpbAAAA+gAAAAEAAAAK2Bwcm9wb3NlX2d1YXJkaWFuYCdzIG5vbWluZWUgYW5kIGl0cyBgZXRhYC4AAAAAEHBlbmRpbmdfZ3VhcmRpYW4AAAPoAAAAEwAAAAAAAAAUcGVuZGluZ19ndWFyZGlhbl9ldGEAAAPoAAAABg==",
        "AAAAAQAAATFQcm90b2NvbCBwYXJhbWV0ZXJzLCBzZXQgYXQgZGVwbG95LiBTdG9yZWQgaW4gaW5zdGFuY2Ugc3RvcmFnZS4gT25seQpgYWRtaW5gIChgdHJhbnNmZXJfYWRtaW5gICsgYGFjY2VwdF9hZG1pbmApIGFuZCBgZ3VhcmRpYW5gCihgcHJvcG9zZV9ndWFyZGlhbmAgKyBgZXhlY3V0ZV9ndWFyZGlhbmApIGNhbiBjaGFuZ2UgbGF0ZXIgKFJhdmVuIFI2KS4KCkFsbCBkdXJhdGlvbnMgYXJlIGNvbmZpZyBzbyB0aGUgZGVtbyBjYW4gY29tcHJlc3MgdGltZSB3aXRob3V0IHRvdWNoaW5nCmNvbnRyYWN0IGxvZ2ljIChERUNJU0lPTlMubWQgIzUpLgAAAAAAAAAAAAAGQ29uZmlnAAAAAAAMAAAAAAAAAAVhZG1pbgAAAAAAABMAAAByTGVuZ3RoIG9mIG9uZSAiZGF5IiBpbiBzZWNvbmRzLiA4Nl80MDAgaW4gcHJvZHVjdGlvbiwgNjAgaW4gdGhlIGRlbW8uCkludGVyZXN0IHVzZXMgYSAzNjUtZGF5IHllYXIgb2YgdGhpcyBsZW5ndGguAAAAAAAIZGF5X3NlY3MAAAAGAAAAPlByb3RvY29sIGZlZSBhcyBhIHNoYXJlIG9mIGludGVyZXN0LCBpbiBicHMgKERFQ0lTSU9OUy5tZCAjMykuAAAAAAAHZmVlX2JwcwAAAAAEAAAAO1RpbWUgYWZ0ZXIgbWF0dXJpdHkgYmVmb3JlIGFuIHVucGFpZCByZXBvIGNhbiBiZSBkZWZhdWx0ZWQuAAAAAApncmFjZV9zZWNzAAAAAAAGAAABTUNhbiBvbmx5IG1ha2UgdGhpbmdzIHNhZmVyLCBpbnN0YW50bHkgKERFQ0lTSU9OUy5tZCAjMzMpOiBkaXNhYmxlIGFuCmFzc2V0LCByYWlzZSBhIGhhaXJjdXQsIGxvd2VyIGEgY2FwIG9yIE5BViBhZ2UsIG5hcnJvdyB0aGUgTkFWIGJhbmQsCnNldCBwYXVzZSBzd2l0Y2hlcywgY2FuY2VsIGEgcGVuZGluZyBwcm9wb3NhbCAob25jZSBwZXIgY2hhbmdlLCBSYXZlbgpSNikuIEl0IGNhbiBuZXZlciBsb29zZW4gYW55dGhpbmcuIFRoZSBhZG1pbiByb3RhdGVzIGl0IHdpdGgKYHByb3Bvc2VfZ3VhcmRpYW5gIC8gYGV4ZWN1dGVfZ3VhcmRpYW5gLCB3aGljaCBpdCBjYW5ub3QgY2FuY2VsLgAAAAAAAAhndWFyZGlhbgAAABMAAABATGlxdWlkYXRvciBidXlzIGNvbGxhdGVyYWwgYXQgTkFWIMOXICgxIOKIkiBkaXNjb3VudCkuIDIwMCA9IDIlLgAAABhsaXF1aWRhdGlvbl9kaXNjb3VudF9icHMAAAAEAAAAMlRpbWUgYSBib3Jyb3dlciBoYXMgdG8gdG9wIHVwIGFmdGVyIGEgbWFyZ2luIGNhbGwuAAAAAAASbWFyZ2luX3dpbmRvd19zZWNzAAAAAAAGAAAAJVNFUC00MCBwcmljZSBmZWVkIGZvciBjb2xsYXRlcmFsIE5BVi4AAAAAAAAGb3JhY2xlAAAAAAATAAABL0N1cnJlbmN5IHRoZSBsb2FuIHRva2VuIGlzIHdvcnRoIG9uZSB1bml0IG9mOiBgVVNEYCAoVVNEQyBtYXJrZXQpIG9yCmBFVVJgIChFVVJDIG1hcmtldCksIERFQ0lTSU9OUy5tZCAjNTIuIFRoZSBjb25zdHJ1Y3RvciByZXF1aXJlcyB0aGUKZmVlZCdzIGBiYXNlKClgIHRvIGJlIGBPdGhlcihxdW90ZSlgLCBzbyBjb2xsYXRlcmFsIGlzIHByaWNlZCBpbiB0aGUKbG9hbiBjdXJyZW5jeS4gQW4gYWRtaW4gYXNzZXJ0aW9uOiB0aGUgY29udHJhY3QgY2Fubm90IGNoZWNrIHRoYXQKYHVzZGNgIHJlYWxseSBpcyB0aGF0IGN1cnJlbmN5LgAAAAAFcXVvdGUAAAAAAAARAAAAokRlbGF5IGJldHdlZW4gYHByb3Bvc2VfKmAgYW5kIGBleGVjdXRlXypgIGZvciBldmVyeSBjaGFuZ2UgdGhhdCBhZGRzCnJpc2sgKERFQ0lTSU9OUy5tZCAjMzMpLiAxNzJfODAwICgyIGRheXMpIGluIHByb2R1Y3Rpb24sIDEyMCBpbiB0aGUKZGVtbyAoIzUpLiBNdXN0IGJlID49IDYwLgAAAAAADXRpbWVsb2NrX3NlY3MAAAAAAAAGAAAAGlJlY2VpdmVzIHRoZSBwcm90b2NvbCBmZWUuAAAAAAAIdHJlYXN1cnkAAAATAAAAxkxvYW4gdG9rZW46IENpcmNsZSBVU0RDLCBvciBFVVJDIGluIGEgRVVSIG1hcmtldCAoREVDSVNJT05TLm1kICM1MikuCkV2ZXJ5IHByaW5jaXBhbCwgaW50ZXJlc3QsIGZlZSBhbmQgcHJvY2VlZHMgYW1vdW50IG1vdmVzIGluIGl0LiBUaGUKbmFtZSBzdGF5cyBgdXNkY2Agc28gYXBwLCBrZWVwZXIgYW5kIGJpbmRpbmdzIG5lZWQgbm8gcmVuYW1lLgAAAAAABHVzZGMAAAAT",
        "AAAAAgAAAAAAAAAAAAAABlN0YXR1cwAAAAAABQAAAAAAAAAAAAAABE9wZW4AAAAAAAAAAAAAAApNYXJnaW5DYWxsAAAAAAAAAAAAAAAAAAZSZXBhaWQAAAAAAAAAAAAAAAAACURlZmF1bHRlZAAAAAAAAAAAAAAAAAAACkxpcXVpZGF0ZWQAAA==",
        "AAAAAQAAAJRQZXItY29sbGF0ZXJhbC1hc3NldCByaXNrIHBhcmFtZXRlcnMsIGFkbWluLXVwZGF0YWJsZSB3aXRob3V0IGEgcmVkZXBsb3kKKERFQ0lTSU9OUy5tZCAjMTMpLiBTdG9yZWQgaW4gaW5zdGFuY2Ugc3RvcmFnZSwga2V5ZWQgYnkgdGhlIHRva2VuIGFkZHJlc3MuAAAAAAAAAAtBc3NldENvbmZpZwAAAAAKAAAB4lNldHRsZSB0aW1lIGZvciBhIHJlYWwgTkFWIG1vdmUgcGFzdCB0aGUgYmFuZCAobmF2LXJldmlldyBzaWRlCmJhbmQtcmVhbC1tb3ZlKTogYSBsYXRlc3QgTkFWIG91dHNpZGUgdGhlIGBtYXhfbmF2X21vdmVfYnBzYCB3aW5kb3cgaXMKc3RpbGwgYWNjZXB0ZWQgb25jZSBpdCBoYXMgc3Rvb2QgdGhpcyBtYW55IHNlY29uZHMgb2YgbGVkZ2VyIHRpbWUsIGFzCm1lYXN1cmVkIGJ5IHRoZSByZXBvJ3Mgb3duIGBub3RlX25hdmAgY2xvY2sgKFtgQmFuZENhbmRpZGF0ZWBdKSwgbmV2ZXIKYnkgZmVlZCB0aW1lc3RhbXBzLiBQcm9kdWN0aW9uIDg2XzQwMCAoMjQgaCksIGRlbW8gMV8yMDAuIFJhaXNpbmcgaXQKaXMgYSB0aWdodGVuaW5nIChpbnN0YW50KTsgbG93ZXJpbmcgaXQgd2FpdHMgb3V0IHRoZSB0aW1lbG9jayAoIzMzKS4KYHU2NDo6TUFYYCB0dXJucyB0aGUgc2V0dGxlIHBhdGggb2ZmICh3aW5kb3cgcm9sbCBvbmx5KS4gTXVzdCBiZSA+IDAuAAAAAAAQYmFuZF9zZXR0bGVfc2VjcwAAAAYAAAA9RGlzYWJsZWQgYXNzZXRzIHJlamVjdCBuZXcgb2ZmZXJzOyBsaXZlIHJlcG9zIGFyZSB1bmFmZmVjdGVkLgAAAAAAAAdlbmFibGVkAAAAAAEAAACGSW5pdGlhbCBMVFY6IGBkZWJ0IOKJpCB2YWx1ZSDDlyAoMSDiiJIgaGFpcmN1dClgLiBBbHdheXMgYWJvdmUKYG1hcmdpbl90cmlnZ2VyX2Jwc2AsIHNvIGEgbWF4LUxUViB0YWtlIG9wZW5zIGJlbG93IHRoZSBtYXJnaW4gdHJpZ2dlci4AAAAAAAtoYWlyY3V0X2JwcwAAAAAEAAABz01hcmdpbiB0cmlnZ2VyIChERUNJU0lPTlMubWQgIzE0LCAjMjYpOiBhIG1hcmdpbiBjYWxsIGZpcmVzIG9uY2UKYGRlYnQgPiB2YWx1ZSDDlyAoMSDiiJIgbWFyZ2luX3RyaWdnZXJfYnBzKWAuIE11c3Qgc2F0aXNmeQpgQ29uZmlnLmxpcXVpZGF0aW9uX2Rpc2NvdW50X2JwcyDiiaQgbWFyZ2luX3RyaWdnZXJfYnBzIDwgaGFpcmN1dF9icHNgLgpBYm92ZSB0aGUgZGlzY291bnQsIGEgbGlxdWlkYXRpb24gYXQgdGhlIGNhbGwgbGluZSBzdGlsbCBwYXlzIHRoZQpsZW5kZXIgYCgxIOKIkiBkaXNjb3VudCkgLyAoMSDiiJIgdHJpZ2dlcikg4oiSIDFgIG92ZXIgdGhlIGRlYnQgKDI1MCB2cyAyMDA6CjAuNTElKSwgYSBidWZmZXIgZm9yIHRoZSBOQVYgbW92ZSBkdXJpbmcgdGhlIG1hcmdpbiB3aW5kb3cuIEFwcGxpZXMgdG8KbGl2ZSByZXBvcyBhdCBvbmNlOyByYWlzaW5nIGl0IGlzIGEgdGlnaHRlbmluZyAoIzMzKS4AAAAAEm1hcmdpbl90cmlnZ2VyX2JwcwAAAAAABAAAATxBIE5BViBvbGRlciB0aGFuIHRoaXMgYmxvY2tzIGB0YWtlX29mZmVyYCwgYGNoZWNrX21hcmdpbmAgYW5kCmBsaXF1aWRhdGVgIGZvciB0aGlzIGFzc2V0IChERUNJU0lPTlMubWQgIzYsICMxNywgIzI1KS4gTmV2ZXIgYmxvY2tzCmByZXBheWAgb3IgYHRvcF91cGAuIFBlciBhc3NldCBiZWNhdXNlIHB1YmxpY2F0aW9uIHNjaGVkdWxlcyBkaWZmZXI6CmEgZnVuZCB0aGF0IHByaW50cyBOQVYgb25seSBvbiBidXNpbmVzcyBkYXlzIG5lZWRzIH45NiBoIHRvIGNvdmVyIGEKd2Vla2VuZCwgYSBkYWlseS1wcmljZWQgdG9rZW4gbGVzcy4gTXVzdCBiZSA+IDAuAAAAEG1heF9uYXZfYWdlX3NlY3MAAAAGAAABo05BViBzYW5pdHkgYmFuZCAoREVDSVNJT05TLm1kICMzMSk6IHRoZSBsYXRlc3QgTkFWIG1heSBkaWZmZXIgZnJvbQpldmVyeSBvbmUgb2YgdGhlIG9yYWNsZSdzIGxhc3QgYG9yYWNsZTo6TkFWX0JBTkRfUkVDT1JEU2AgcmVjb3JkcyBieQphdCBtb3N0IHRoaXMgbWFueSBicHMsIGVsc2UgYE5hdk91dE9mQmFuZGAuIE1lYXN1cmluZyBhZ2FpbnN0IHRoZQp3aG9sZSB3aW5kb3csIG5vdCBqdXN0IHRoZSBwcmV2aW91cyByZWNvcmQsIG1lYW5zIHJlLXBvc3RzIG9mIGEgYmFkCnByaWNlIGNhbm5vdCBoaWRlIHRoZSBqdW1wLiBCbG9ja3MgYHRha2Vfb2ZmZXJgLCBgY2hlY2tfbWFyZ2luYCBhbmQKYGxpcXVpZGF0ZWAsIHRoZSBzYW1lIHNldCBhcyBhIHN0YWxlIE5BVjsgbmV2ZXIgYHJlcGF5YCBvciBgdG9wX3VwYC4KTXVzdCBiZSA+IDAuAAAAABBtYXhfbmF2X21vdmVfYnBzAAAABAAAAclFeHBvc3VyZSBjYXAgKERFQ0lTSU9OUy5tZCAjMzIpOiB0b3RhbCBkZWJ0IChwcmluY2lwYWwgKyBpbnRlcmVzdCwgbG9hbgp0b2tlbiA3IGRlY2ltYWxzOiBVU0RDLCBvciBFVVJDIGluIGEgRVVSIG1hcmtldCkgb2YgbGl2ZSByZXBvcyBvbiB0aGlzCmFzc2V0LCBpbiB0aGlzIHJlcG8gY29udHJhY3Qgb25seSAoYSBzZWNvbmQgbWFya2V0IGxpc3RpbmcgdGhlIHNhbWUKdG9rZW4gaGFzIGl0cyBvd24gY2FwLCAjNTIpLiBgdGFrZV9vZmZlcmAgZmFpbHMgd2l0aApgQ2FwRXhjZWVkZWRgIHBhc3QgaXQ7IDAgbWVhbnMgbm8gbmV3IHJlcG9zLiBFeGl0cyAocmVwYXksIGF1dG8tcmVwYXksCnRvcC11cCwgbGlxdWlkYXRlKSBhcmUgbmV2ZXIgYmxvY2tlZCwgYW5kIGxvd2VyaW5nIHRoZSBjYXAgYmVsb3cgdGhlCm9wZW4gZGVidCBsZWF2ZXMgbGl2ZSByZXBvcyB1bnRvdWNoZWQuIE11c3QgYmUg4omlIDAuAAAAAAAADW1heF9vcGVuX2RlYnQAAAAAAAALAAAAAAAAAAtuYXZfY2VpbGluZwAAAAPoAAAACwAAALJPcHRpb25hbCBoYXJkIGJvdW5kcyBvbiB0aGUgbGF0ZXN0IE5BViwgaW4gdGhlIGZlZWQncyBvd24gc2NhbGUKKGBkZWNpbWFscygpYCksIGluY2x1c2l2ZS4gU2FtZSBlZmZlY3QgYXMgdGhlIG1vdmUgbGltaXQuIElmIHNldCwKZWFjaCBtdXN0IGJlID4gMCBhbmQgYG5hdl9mbG9vciA8PSBuYXZfY2VpbGluZ2AuAAAAAAAJbmF2X2Zsb29yAAAAAAAD6AAAAAsAAAAgSG93IHRoZSBvcmFjbGUgbmFtZXMgdGhpcyBhc3NldC4AAAAMb3JhY2xlX2Fzc2V0AAAH0AAAAAVBc3NldAAAAA==",
        "AAAAAQAAAEpBbiBhZG1pbiBgQXNzZXRDb25maWdgIGNoYW5nZSB3YWl0aW5nIG91dCB0aGUgdGltZWxvY2sgKERFQ0lTSU9OUy5tZCAjMzMpLgAAAAAAAAAAAAxQZW5kaW5nQXNzZXQAAAACAAAAAAAAAAZjb25maWcAAAAAB9AAAAALQXNzZXRDb25maWcAAAAANGBleGVjdXRlX2Fzc2V0YCB3b3JrcyBmcm9tIHRoaXMgbGVkZ2VyIHRpbWVzdGFtcCBvbi4AAAADZXRhAAAAAAY=",
        "AAAAAQAAAERBbiBhZG1pbiBgUGF1c2VgIGNoYW5nZSB3YWl0aW5nIG91dCB0aGUgdGltZWxvY2sgKERFQ0lTSU9OUy5tZCAjMzMpLgAAAAAAAAAMUGVuZGluZ1BhdXNlAAAAAgAAADRgZXhlY3V0ZV9wYXVzZWAgd29ya3MgZnJvbSB0aGlzIGxlZGdlciB0aW1lc3RhbXAgb24uAAAAA2V0YQAAAAAGAAAAAAAAAAVwYXVzZQAAAAAAB9AAAAAFUGF1c2UAAAA=",
        "AAAAAQAAAXFUaGUgTkFWIGxldmVsIHRoZSByZXBvIGhhcyB3YXRjaGVkIHN0YW5kLCBwZXIgb3JhY2xlIGFzc2V0IChuYXYtcmV2aWV3CnNpZGUgYmFuZC1yZWFsLW1vdmUpLiBgbm90ZV9uYXZgIHNldHMgaXQgdG8gdGhlIGxhdGVzdCBOQVYgd2l0aApgc2luY2VgID0gbGVkZ2VyIG5vdywgYW5kIHJlc3RhcnRzIGl0IHdoZW5ldmVyIHRoZSBsYXRlc3QgTkFWLCBvciBhbnkKZmVlZCByZWNvcmQgc3RhbXBlZCBhdCBvciBhZnRlciBgc2luY2VgLCBpcyBtb3JlIHRoYW4KYG1heF9uYXZfbW92ZV9icHNgIGF3YXkgZnJvbSBgcHJpY2VgLiBTdG9yZWQgYXBhcnQgZnJvbSBgQXNzZXRDb25maWdgCnNvIGBzZXRfYXNzZXRgIG5ldmVyIHJlc3RhcnRzIHRoZSBjbG9jay4AAAAAAAAAAAAADUJhbmRDYW5kaWRhdGUAAAAAAAACAAAAHE5BViBpbiB0aGUgZmVlZCdzIG93biBzY2FsZS4AAAAFcHJpY2UAAAAAAAALAAAANExlZGdlciB0aW1lc3RhbXAgd2hlbiB0aGUgcmVwbyBmaXJzdCBzYXcgdGhpcyBsZXZlbC4AAAAFc2luY2UAAAAAAAAG",
        "AAAAAQAAAZtBIGJvcnJvd2VyJ3Mgc3RhbmRpbmcgcmVxdWVzdCAoYm9ycm93IHJlcXVlc3RzLCB0aGUgbWlycm9yIG9mIFtgT2ZmZXJgXSk6CiJsZW5kIG1lIGBwcmluY2lwYWxgIFVTREMgZm9yIGB0ZXJtX3NlY3NgIGF0IGBhcHJfYnBzYCwgaGVyZSBpcyBteQpjb2xsYXRlcmFsIi4gVGhlIHdob2xlIGBjb2xsYXRlcmFsX2Ftb3VudGAgaXMgZXNjcm93ZWQgaW4gdGhlIGNvbnRyYWN0CmZyb20gYGNyZWF0ZV9yZXF1ZXN0YCB1bnRpbCBpdCBpcyBmaWxsZWQgKGl0IGJlY29tZXMgdGhlIHJlcG8ncwpjb2xsYXRlcmFsKSBvciBjYW5jZWxsZWQgKGl0IGdvZXMgYmFjayB0byB0aGUgYm9ycm93ZXIpLiBObyBOQVYgY2hlY2sgYXQKcG9zdGluZzsgYGZpbGxfcmVxdWVzdGAgY2hlY2tzIGl0IGFnYWluc3QgdGhlIGFzc2V0J3MgaGFpcmN1dC4AAAAAAAAAAA1Cb3Jyb3dSZXF1ZXN0AAAAAAAACAAAAAAAAAAHYXByX2JwcwAAAAAEAAAAAAAAAAhib3Jyb3dlcgAAABMAAABBQ29sbGF0ZXJhbCBlc2Nyb3dlZCwgaW4gdGhlIHRva2VuJ3Mgb3duIHVuaXRzIChERUNJU0lPTlMubWQgIzI4KS4AAAAAAAARY29sbGF0ZXJhbF9hbW91bnQAAAAAAAALAAAAM0NvbGxhdGVyYWwgdG9rZW4gZXNjcm93ZWQgKGUuZy4gdEJFTkpJIFNBQywgdFNBRk8pLgAAAAAQY29sbGF0ZXJhbF9hc3NldAAAABMAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAAAmlkAAAAAAAGAAAAIFVTREMgYXNrZWQgZm9yLCA3LWRlY2ltYWwgdW5pdHMuAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAACXRlcm1fc2VjcwAAAAAAAAY=",
        "AAAAAgAAAE1XaHkgYGRlZmF1bHRgIG1vdmVkIGEgcmVwbyB0byBgRGVmYXVsdGVkYCAoY2FycmllZCBieSB0aGUgYERlZmF1bHRlZGAgZXZlbnQpLgAAAAAAAAAAAAANRGVmYXVsdFJlYXNvbgAAAAAAAAIAAAAAAAAAHVVucGFpZCBwYXN0IG1hdHVyaXR5ICsgZ3JhY2UuAAAAAAAACE1hdHVyaXR5AAAAAAAAAGBNYXJnaW4gY2FsbCBtaXNzZWQ6IHBhc3QgYG1hcmdpbl9jYWxsX2RlYWRsaW5lYCwgc3RpbGwgaW4gYnJlYWNoIG9yCndpdGhvdXQgYSBmcmVzaCBpbi1iYW5kIE5BVi4AAAAKTWFyZ2luQ2FsbAAA",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAHQAAAAAAAAAOTm90SW1wbGVtZW50ZWQAAAAAAAEAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAACAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAwAAAAAAAAAMTWF0aE92ZXJmbG93AAAABAAAAAAAAAANT2ZmZXJOb3RGb3VuZAAAAAAAAAUAAAAAAAAADFJlcG9Ob3RGb3VuZAAAAAYAAAAAAAAADUludmFsaWRTdGF0dXMAAAAAAAAHAAAAOUNvbGxhdGVyYWwgYXNzZXQgaGFzIG5vIGBBc3NldENvbmZpZ2AsIG9yIGl0IGlzIGRpc2FibGVkLgAAAAAAABFBc3NldE5vdFN1cHBvcnRlZAAAAAAAAAgAAAAAAAAACFN0YWxlTmF2AAAACQAAAAAAAAAWSW5zdWZmaWNpZW50Q29sbGF0ZXJhbAAAAAAACgAAAAAAAAANTm90TGlxdWlkYXRvcgAAAAAAAAsAAAAAAAAADk5vdERlZmF1bHRhYmxlAAAAAAAMAAAAOU9yYWNsZSBoYXMgbm8gcHJpY2UgZm9yIHRoZSBhc3NldCwgb3IgaXQgaXMgbm90IHBvc2l0aXZlLgAAAAAAAAdOb1ByaWNlAAAAAA0AAAArYGF1dG9fcmVwYXlgIG9uIGEgcmVwbyB0aGF0IGRpZCBub3Qgb3B0IGluLgAAAAAMQXV0b1JlcGF5T2ZmAAAADgAAADlgYXV0b19yZXBheWAgYmVmb3JlIG1hdHVyaXR5IChhbmQgbm8gbWlzc2VkIG1hcmdpbiBjYWxsKS4AAAAAAAAGTm90RHVlAAAAAAAPAAAAflRoZSBVU0RDIHB1bGwgZmFpbGVkIChzaG9ydCBiYWxhbmNlLCBhbGxvd2FuY2UgdG9vIHNtYWxsIG9yIGV4cGlyZWQpLApvciB0aGUgY29sbGF0ZXJhbCBjb3VsZCBub3QgYmUgcmV0dXJuZWQgdG8gdGhlIGJvcnJvd2VyLgAAAAAAD0F1dG9SZXBheUZhaWxlZAAAAAAQAAAAR1RoZSBhc3NldCdzIGBub19uZXdfcmVwb3NgIG9yIGBub19zZWl6ZWAgc3dpdGNoIGJsb2NrcyB0aGlzIGNhbGwgKCMzMCkuAAAAAAZQYXVzZWQAAAAAABEAAACLTkFWIG91dHNpZGUgdGhlIGFzc2V0J3Mgc2FuaXR5IGJhbmQ6IGJleW9uZCBgbmF2X2Zsb29yYCAvIGBuYXZfY2VpbGluZ2AsCm9yIG1vcmUgdGhhbiBgbWF4X25hdl9tb3ZlX2Jwc2AgZnJvbSBhIHJlY2VudCBvcmFjbGUgcmVjb3JkICgjMzEpLgAAAAAMTmF2T3V0T2ZCYW5kAAAAEgAAAElgdGFrZV9vZmZlcmAgd291bGQgcHVzaCB0aGUgYXNzZXQncyBvcGVuIGRlYnQgcGFzdCBgbWF4X29wZW5fZGVidGAgKCMzMikuAAAAAAAAC0NhcEV4Y2VlZGVkAAAAABMAAABqVGhlIGNoYW5nZSBsb29zZW5zIHJpc2s6IGl0IG11c3QgZ28gdGhyb3VnaCBgcHJvcG9zZV8qYCwgd2FpdCBvdXQKYHRpbWVsb2NrX3NlY3NgLCB0aGVuIGBleGVjdXRlXypgICgjMzMpLgAAAAAAB0xvb3NlbnMAAAAAFAAAAChgZXhlY3V0ZV8qYCBiZWZvcmUgdGhlIHByb3Bvc2FsJ3MgYGV0YWAuAAAAD1RpbWVsb2NrTm90RG9uZQAAAAAVAAAAQWBleGVjdXRlXypgIG9yIGBjYW5jZWxfKmAgd2l0aCBubyBwZW5kaW5nIHByb3Bvc2FsIGZvciB0aGUgYXNzZXQuAAAAAAAACk5vUHJvcG9zYWwAAAAAABYAAAA4YGNhbmNlbF8qYCBieSBzb21lb25lIHdobyBpcyBuZWl0aGVyIGFkbWluIG5vciBndWFyZGlhbi4AAAASTm90QWRtaW5Pckd1YXJkaWFuAAAAAAAXAAAAMWBjbGFpbWAgYnkgYW4gYWRkcmVzcyB3aXRoIG5vIHBhcmtlZCBVU0RDIHBheW91dC4AAAAAAAAOTm90aGluZ1RvQ2xhaW0AAAAAABgAAACGYGNsYWltX2luX2tpbmRgIHdoaWxlIHRoZSBOQVYgaXMgZnJlc2gsIG9yIHN0YWxlIGZvciBubyBsb25nZXIgdGhhbgpgaW5raW5kOjpOQVZfT1VUQUdFX0RBWVNgIGRlbW8vcmVhbCBkYXlzOiB1c2UgYGxpcXVpZGF0ZWAgb3Igd2FpdC4AAAAAAAtOb05hdk91dGFnZQAAAAAZAAAAamBleGVjdXRlXypgIGFmdGVyIHRoZSBwcm9wb3NhbCdzIHdpbmRvdyBjbG9zZWQgKGBldGEgKyB0aW1lbG9ja19zZWNzYCk6CnByb3Bvc2UgaXQgYWdhaW4gKCMzMywgaXNzdWUgIzQxKS4AAAAAAA9Qcm9wb3NhbEV4cGlyZWQAAAAAGgAAAJpUaGUgZ3VhcmRpYW4gYWxyZWFkeSBjYW5jZWxsZWQgKG9yIHN1cGVyc2VkZWQpIHRoaXMgZXhhY3QgY2hhbmdlCm9uY2U7IHRoZSBhZG1pbidzIHJlLXByb3Bvc2FsIG9mIGl0IGNhbiBvbmx5IGJlIGNhbmNlbGxlZCBieSB0aGUKYWRtaW4gKFJhdmVuIFI2LCBVQS0wMikuAAAAAAAJVmV0b1NwZW50AAAAAAAAGwAAAEJObyBib3Jyb3cgcmVxdWVzdCB3aXRoIHRoaXMgaWQ6IG5ldmVyIHBvc3RlZCwgY2FuY2VsbGVkIG9yIGZpbGxlZC4AAAAAAA9SZXF1ZXN0Tm90Rm91bmQAAAAAHAAAAHhgZmlsbF9yZXF1ZXN0YCB3aXRoIHRoZSBsZW5kZXIncyBvciB0aGUgYm9ycm93ZXIncyBVU0RDIGZyb3plbiBieQp0aGUgaXNzdWVyIChSYXZlbiBBUy0wMyk6IHRoZSBwYXltZW50IGxlZyBjYW5ub3QgbW92ZS4AAAAKVXNkY0Zyb3plbgAAAAAAHQ==",
        "AAAABQAAAAAAAAAAAAAABlJlcGFpZAAAAAAAAQAAAAZyZXBhaWQAAAAAAAQAAAAAAAAAB3JlcG9faWQAAAAABgAAAAEAAAAAAAAADWxlbmRlcl9hbW91bnQAAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAARlRydWUgd2hlbiB0aGUgZGVidCB3YXMgcHVsbGVkIGJ5IGF1dG8tcmVwYXksIG5vdCBwYWlkIGJ5IHRoZSBib3Jyb3dlci4AAAAAAAlhdXRvbWF0aWMAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAChgd2hvYCBjb2xsZWN0ZWQgaXRzIHBhcmtlZCBVU0RDIHBheW91dHMuAAAAAAAAAAdDbGFpbWVkAAAAAAEAAAAHY2xhaW1lZAAAAAACAAAAAAAAAAN3aG8AAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAADFUaGUgYWRtaW4gcm9sZSBtb3ZlZCB0byBgYWRtaW5gIChgYWNjZXB0X2FkbWluYCkuAAAAAAAAAAAAAAhBZG1pblNldAAAAAEAAAAJYWRtaW5fc2V0AAAAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAAAAAAAAIcHJldmlvdXMAAAATAAAAAAAAAAI=",
        "AAAABQAAADdBZG1pbiBzZXQgYW4gYXNzZXQncyBwYXVzZSBzd2l0Y2hlcyAoREVDSVNJT05TLm1kICMzMCkuAAAAAAAAAAAIUGF1c2VTZXQAAAABAAAACXBhdXNlX3NldAAAAAAAAAMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAADG5vX25ld19yZXBvcwAAAAEAAAAAAAAAAAAAAAhub19zZWl6ZQAAAAEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACFRvcHBlZFVwAAAAAQAAAAl0b3BwZWRfdXAAAAAAAAAEAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAABFjb2xsYXRlcmFsX2Ftb3VudAAAAAAAAAsAAAAAAAAARVRydWUgd2hlbiB0aGUgdG9wLXVwIG1hZGUgdGhlIHJlcG8gaGVhbHRoeSBhbmQgY2xlYXJlZCBhIG1hcmdpbiBjYWxsLgAAAAAAAAdjbGVhcmVkAAAAAAEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACURlZmF1bHRlZAAAAAAAAAEAAAAJZGVmYXVsdGVkAAAAAAAAAgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAAAAAAAAGcmVhc29uAAAAAAfQAAAADURlZmF1bHRSZWFzb24AAAAAAAAAAAAAAg==",
        "AAAABQAAAHdMaXF1aWRhdGlvbiBwcm9jZWVkcyBkaWQgbm90IGNvdmVyIHdoYXQgdGhlIGxlbmRlciB3YXMgb3dlZAooREVDSVNJT05TLm1kICM0KS4gYGFtb3VudGAgaXMgdGhlIGxlbmRlcidzIHVucGFpZCBiYWxhbmNlLgAAAAAAAAAACVNob3J0ZmFsbAAAAAAAAAEAAAAJc2hvcnRmYWxsAAAAAAAAAgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAACkxpcXVpZGF0ZWQAAAAAAAEAAAAKbGlxdWlkYXRlZAAAAAAACAAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAAAAAAAAKbGlxdWlkYXRvcgAAAAAAEwAAAAEAAAAAAAAACHByb2NlZWRzAAAACwAAAAAAAAAAAAAADWxlbmRlcl9hbW91bnQAAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAAAAAAA9ib3Jyb3dlcl9hbW91bnQAAAAACwAAAAAAAABkTkFWIHRoZSBwcm9jZWVkcyB3ZXJlIHByaWNlZCBhdCwgc2NhbGVkIGZvciB0aGUgY29sbGF0ZXJhbCB0b2tlbgooYG5hdl9kZWNpbWFsc2AsIERFQ0lTSU9OUy5tZCAjMjgpLgAAAANuYXYAAAAACwAAAAAAAAAAAAAADG5hdl9kZWNpbWFscwAAAAQAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACk1hcmdpbkNhbGwAAAAAAAEAAAALbWFyZ2luX2NhbGwAAAAABAAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAAAAAF9OQVYgdGhhdCBzaG93ZWQgdGhlIGJyZWFjaCwgc2NhbGVkIGZvciB0aGUgY29sbGF0ZXJhbCB0b2tlbgooYG5hdl9kZWNpbWFsc2AsIERFQ0lTSU9OUy5tZCAjMjgpLgAAAAADbmF2AAAAAAsAAAAAAAAAAAAAAAxuYXZfZGVjaW1hbHMAAAAEAAAAAAAAAAI=",
        "AAAABQAAAIlFbWl0dGVkIGJ5IGB0YWtlX29mZmVyYCBhbmQgYGZpbGxfcmVxdWVzdGA6IHRoZSBEdlAgbGVnIHRoYXQgb3BlbnMgYQpyZXBvLiBgb2ZmZXJfaWRgIGlzIDAgZm9yIGEgcmVxdWVzdC1ib3JuIHJlcG8gKHNlZSBgUmVxdWVzdEZpbGxlZGApLgAAAAAAAAAAAAAKUmVwb09wZW5lZAAAAAAAAQAAAAtyZXBvX29wZW5lZAAAAAALAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAAAAAAAAZsZW5kZXIAAAAAABMAAAAAAAAAAAAAAAhib3Jyb3dlcgAAABMAAAAAAAAAAAAAABBjb2xsYXRlcmFsX2Fzc2V0AAAAEwAAAAAAAAAAAAAAEWNvbGxhdGVyYWxfYW1vdW50AAAAAAAACwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAAAAAAhpbnRlcmVzdAAAAAsAAAAAAAAAJ0Fzc2V0IGhhaXJjdXQgc25hcHNob3R0ZWQgYXQgdGFrZSB0aW1lLgAAAAALaGFpcmN1dF9icHMAAAAABAAAAAAAAAAAAAAAC21hdHVyaXR5X3RzAAAAAAYAAAAAAAAAAAAAAAphdXRvX3JlcGF5AAAAAAABAAAAAAAAAAI=",
        "AAAABQAAADtUaGUgZ3VhcmRpYW4gcm9sZSBtb3ZlZCB0byBgZ3VhcmRpYW5gIChgZXhlY3V0ZV9ndWFyZGlhbmApLgAAAAAAAAAAC0d1YXJkaWFuU2V0AAAAAAEAAAAMZ3VhcmRpYW5fc2V0AAAAAgAAAAAAAAAIZ3VhcmRpYW4AAAATAAAAAQAAAAAAAAAIcHJldmlvdXMAAAATAAAAAAAAAAI=",
        "AAAABQAAADtCb3Jyb3dlciB0dXJuZWQgYXV0by1yZXBheSBvbiBvciBvZmYgZm9yIGEgbGl2ZSByZXBvICgjMjcpLgAAAAAAAAAADEF1dG9SZXBheVNldAAAAAEAAAAOYXV0b19yZXBheV9zZXQAAAAAAAIAAAAAAAAAB3JlcG9faWQAAAAABgAAAAEAAAAAAAAAB2VuYWJsZWQAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADE9mZmVyQ3JlYXRlZAAAAAEAAAANb2ZmZXJfY3JlYXRlZAAAAAAAAAYAAAAAAAAACG9mZmVyX2lkAAAABgAAAAEAAAAAAAAABmxlbmRlcgAAAAAAEwAAAAEAAAAAAAAAEGNvbGxhdGVyYWxfYXNzZXQAAAATAAAAAAAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAAAAAAB2Fwcl9icHMAAAAABAAAAAAAAAAAAAAACXRlcm1fc2VjcwAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAJNBIFVTREMgcGF5b3V0IHRvIGB0b2AgZmFpbGVkIChmcm96ZW4gYWNjb3VudCwgY2xvc2VkIHRydXN0bGluZSksIHNvIHRoZQpjb250cmFjdCBrZXB0IGl0OiBgdG9gIGNvbGxlY3RzIGl0IHdpdGggYGNsYWltYC4gVGhlIHNldHRsZW1lbnQgd2VudCBhaGVhZC4AAAAAAAAAAAxQYXlvdXRQYXJrZWQAAAABAAAADXBheW91dF9wYXJrZWQAAAAAAAADAAAAAAAAAAdyZXBvX2lkAAAAAAYAAAABAAAAAAAAAAJ0bwAAAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAeROQVYgb3V0YWdlIGZhbGxiYWNrOiB0aGUgbGVuZGVyIHRvb2sgYSBEZWZhdWx0ZWQgcmVwbydzIGNvbGxhdGVyYWwgaW4Ka2luZCAobm8gc2FsZSwgbm8gZmVlLCBubyBib3Jyb3dlciBzdXJwbHVzKS4gVGhlIHJlcG8gaXMgYExpcXVpZGF0ZWRgLgpgcGFya2VkYCA9IHRoZSB0b2tlbiByZWZ1c2VkIHRoZSBwdXNoIHRvIHRoZSBsZW5kZXIgKHBlcm1pc3Npb25lZCB0b2tlbiwKZnJvemVuIHRydXN0bGluZSk7IGl0IHdhaXRzIGZvciBgY2xhaW1fY29sbGF0ZXJhbGAuIGBuYXZfdGltZXN0YW1wYCBpcwp0aGUgdGltZSB0aGUgb3V0YWdlIHdhcyBtZWFzdXJlZCBmcm9tOiB0aGUgc3RhbGUgTkFWJ3MgdGltZXN0YW1wLCBvciB0aGUKcmVwbydzIGBtYXR1cml0eV90cyArIGdyYWNlX3NlY3NgIHdoZW4gdGhlIGZlZWQgZ2F2ZSBubyB1c2FibGUgb25lIChubwpwcmljZSwgb3IgZGF0ZWQgYmV5b25kIGBvcmFjbGU6Ok1BWF9GVVRVUkVfU0tFV19TRUNTYCkuAAAAAAAAAA1DbGFpbWVkSW5LaW5kAAAAAAAAAQAAAA9jbGFpbWVkX2luX2tpbmQAAAAABgAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAAAAAAAAGbGVuZGVyAAAAAAATAAAAAQAAAAAAAAAQY29sbGF0ZXJhbF9hc3NldAAAABMAAAAAAAAAAAAAABFjb2xsYXRlcmFsX2Ftb3VudAAAAAAAAAsAAAAAAAAAAAAAAAZwYXJrZWQAAAAAAAEAAAAAAAAAAAAAAA1uYXZfdGltZXN0YW1wAAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAJZUaGUgbGlxdWlkYXRvciB3aGl0ZWxpc3QgY2hhbmdlZCAoUmF2ZW4gU1RELTAzIC8gT1otMDMpOiBgYWxsb3dlZGAgdHJ1ZQp3aGVuIGBleGVjdXRlX2xpcXVpZGF0b3JgIGFkZGVkIGB3aG9gLCBmYWxzZSB3aGVuIGBzZXRfbGlxdWlkYXRvcmAKcmVtb3ZlZCBpdC4AAAAAAAAAAAANTGlxdWlkYXRvclNldAAAAAAAAAEAAAAObGlxdWlkYXRvcl9zZXQAAAAAAAIAAAAAAAAAA3dobwAAAAATAAAAAQAAAAAAAAAHYWxsb3dlZAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAJJgZGVmYXVsdGAgb24gYSBtaXNzZWQgbWFyZ2luIGNhbGwgZm91bmQgdGhlIGxvYW4gb3V0IG9mIGJyZWFjaCBhdCBhIGZyZXNoCk5BViBhbmQgY2xlYXJlZCB0aGUgY2FsbCBpbnN0ZWFkIChERUNJU0lPTlMubWQgIzIwKS4gVGhlIHJlcG8gaXMgYE9wZW5gLgAAAAAAAAAAAA1NYXJnaW5DbGVhcmVkAAAAAAAAAQAAAA5tYXJnaW5fY2xlYXJlZAAAAAAAAQAAAAAAAAAHcmVwb19pZAAAAAAGAAAAAQAAAAI=",
        "AAAABQAAARVgbm90ZV9uYXZgIHN0YXJ0ZWQgdGhlIGJhbmQgc2V0dGxlIGNsb2NrIG9uIGEgbmV3IE5BViBsZXZlbCAoc2lkZQpiYW5kLXJlYWwtbW92ZSkuIFVubGVzcyB0aGUgbGV2ZWwgbW92ZXMgYWdhaW4sIGEgcHJpY2Ugd2l0aGluIHRoZSBiYW5kIG9mCmBwcmljZWAgaXMgYWNjZXB0ZWQgZnJvbSBgc2luY2UgKyBiYW5kX3NldHRsZV9zZWNzYCBldmVuIGlmIHRoZSBmZWVkJ3MKd2luZG93IHN0aWxsIGRpc2FncmVlczogdGhlIGd1YXJkaWFuJ3Mgd2luZG93IHRvIHBhdXNlIGEgYmFkIHB1c2guAAAAAAAAAAAAAA1OYXZMZXZlbE5vdGVkAAAAAAAAAQAAAA9uYXZfbGV2ZWxfbm90ZWQAAAAAAwAAAAAAAAAMb3JhY2xlX2Fzc2V0AAAH0AAAAAVBc3NldAAAAAAAAAEAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAAAAAABXNpbmNlAAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAG9BIGxlbmRlciBmaWxsZWQgYSBib3Jyb3cgcmVxdWVzdDsgdGhlIGBSZXBvT3BlbmVkYCBmb3IgYHJlcG9faWRgCih3aXRoIGBvZmZlcl9pZGAgMCkgaXMgZW1pdHRlZCBqdXN0IGJlZm9yZSBpdC4AAAAAAAAAAA1SZXF1ZXN0RmlsbGVkAAAAAAAAAQAAAA5yZXF1ZXN0X2ZpbGxlZAAAAAAABAAAAAAAAAAKcmVxdWVzdF9pZAAAAAAABgAAAAEAAAAAAAAAB3JlcG9faWQAAAAABgAAAAEAAAAAAAAABmxlbmRlcgAAAAAAEwAAAAAAAAAAAAAACGJvcnJvd2VyAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADk9mZmVyQ2FuY2VsbGVkAAAAAAABAAAAD29mZmVyX2NhbmNlbGxlZAAAAAADAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAAAAAAAAZsZW5kZXIAAAAAABMAAAABAAAAHFVTREMgcmV0dXJuZWQgdG8gdGhlIGxlbmRlci4AAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAD9BIGJvcnJvd2VyIHBvc3RlZCBhIGJvcnJvdyByZXF1ZXN0IGFuZCBlc2Nyb3dlZCBpdHMgY29sbGF0ZXJhbC4AAAAAAAAAAA5SZXF1ZXN0Q3JlYXRlZAAAAAAAAQAAAA9yZXF1ZXN0X2NyZWF0ZWQAAAAABwAAAAAAAAAKcmVxdWVzdF9pZAAAAAAABgAAAAEAAAAAAAAACGJvcnJvd2VyAAAAEwAAAAEAAAAAAAAAEGNvbGxhdGVyYWxfYXNzZXQAAAATAAAAAAAAAAAAAAARY29sbGF0ZXJhbF9hbW91bnQAAAAAAAALAAAAAAAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAAAAAAB2Fwcl9icHMAAAAABAAAAAAAAAAAAAAACXRlcm1fc2VjcwAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAD9BZG1pbiBhZGRlZCBvciByZS10aWVyZWQgYSBjb2xsYXRlcmFsIGFzc2V0IChERUNJU0lPTlMubWQgIzEzKS4AAAAAAAAAAA9Bc3NldENvbmZpZ3VyZWQAAAAAAQAAABBhc3NldF9jb25maWd1cmVkAAAACgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAALaGFpcmN1dF9icHMAAAAABAAAAAAAAAAAAAAAEm1hcmdpbl90cmlnZ2VyX2JwcwAAAAAABAAAAAAAAAAAAAAAB2VuYWJsZWQAAAAAAQAAAAAAAAAAAAAAEG1heF9uYXZfYWdlX3NlY3MAAAAGAAAAAAAAAAAAAAAQbWF4X25hdl9tb3ZlX2JwcwAAAAQAAAAAAAAAAAAAAAluYXZfZmxvb3IAAAAAAAPoAAAACwAAAAAAAAAAAAAAC25hdl9jZWlsaW5nAAAAA+gAAAALAAAAAAAAAAAAAAANbWF4X29wZW5fZGVidAAAAAAAAAsAAAAAAAAAAAAAABBiYW5kX3NldHRsZV9zZWNzAAAABgAAAAAAAAAC",
        "AAAABQAAAGpBIHByb3Bvc2FsIHRvb2sgZWZmZWN0LiBga2luZGAgaXMgYGFzc2V0YCBvciBgcGF1c2VgOyB0aGUgbWF0Y2hpbmcKYEFzc2V0Q29uZmlndXJlZGAgLyBgUGF1c2VTZXRgIGZvbGxvd3MuAAAAAAAAAAAAEFByb3Bvc2FsRXhlY3V0ZWQAAAABAAAAEXByb3Bvc2FsX2V4ZWN1dGVkAAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAEa2luZAAAABEAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEFJlcXVlc3RDYW5jZWxsZWQAAAABAAAAEXJlcXVlc3RfY2FuY2VsbGVkAAAAAAAAAwAAAAAAAAAKcmVxdWVzdF9pZAAAAAAABgAAAAEAAAAAAAAACGJvcnJvd2VyAAAAEwAAAAEAAAAkQ29sbGF0ZXJhbCByZXR1cm5lZCB0byB0aGUgYm9ycm93ZXIuAAAAEWNvbGxhdGVyYWxfYW1vdW50AAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAEpgd2hvYCBjb2xsZWN0ZWQgaXRzIHBhcmtlZCBjb2xsYXRlcmFsIG9mIGBjb2xsYXRlcmFsX2Fzc2V0YCwgc2VudCB0byBgdG9gLgAAAAAAAAAAABFDb2xsYXRlcmFsQ2xhaW1lZAAAAAAAAAEAAAASY29sbGF0ZXJhbF9jbGFpbWVkAAAAAAAEAAAAAAAAAAN3aG8AAAAAEwAAAAEAAAAAAAAAEGNvbGxhdGVyYWxfYXNzZXQAAAATAAAAAQAAAAAAAAACdG8AAAAAABMAAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAMxBIHByb3Bvc2FsIHdhcyBkcm9wcGVkOiBjYW5jZWxsZWQgYnkgYWRtaW4gb3IgZ3VhcmRpYW4sIHJlcGxhY2VkIGJ5IGEKbmV3IHByb3Bvc2FsIG9mIHRoZSBzYW1lIGtpbmQgKGBieWAgPSBhZG1pbiwgaXNzdWUgIzQxKSwgb3Igc3VwZXJzZWRlZApieSBhbiBpbnN0YW50IGNoYW5nZSB0byB0aGUgc2FtZSBhc3NldCAoYGJ5YCBtYWRlIHRoYXQgY2hhbmdlKS4AAAAAAAAAEVByb3Bvc2FsQ2FuY2VsbGVkAAAAAAAAAQAAABJwcm9wb3NhbF9jYW5jZWxsZWQAAAAAAAMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABGtpbmQAAAARAAAAAQAAAAAAAAACYnkAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAEVBZG1pbiBxdWV1ZWQgYSBsaXF1aWRhdG9yIGFkZGl0aW9uIGJlaGluZCB0aGUgdGltZWxvY2sgKFJhdmVuIFVBLTAzKS4AAAAAAAAAAAAAEkxpcXVpZGF0b3JQcm9wb3NlZAAAAAAAAQAAABNsaXF1aWRhdG9yX3Byb3Bvc2VkAAAAAAIAAAAAAAAAA3dobwAAAAATAAAAAQAAAAAAAAADZXRhAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAERBZG1pbiBxdWV1ZWQgYW4gYXNzZXQgY2hhbmdlIGJlaGluZCB0aGUgdGltZWxvY2sgKERFQ0lTSU9OUy5tZCAjMzMpLgAAAAAAAAATQXNzZXRDaGFuZ2VQcm9wb3NlZAAAAAABAAAAFWFzc2V0X2NoYW5nZV9wcm9wb3NlZAAAAAAAAAsAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAAA2V0YQAAAAAGAAAAAAAAAAAAAAALaGFpcmN1dF9icHMAAAAABAAAAAAAAAAAAAAAEm1hcmdpbl90cmlnZ2VyX2JwcwAAAAAABAAAAAAAAAAAAAAAB2VuYWJsZWQAAAAAAQAAAAAAAAAAAAAAEG1heF9uYXZfYWdlX3NlY3MAAAAGAAAAAAAAAAAAAAAQbWF4X25hdl9tb3ZlX2JwcwAAAAQAAAAAAAAAAAAAAAluYXZfZmxvb3IAAAAAAAPoAAAACwAAAAAAAAAAAAAAC25hdl9jZWlsaW5nAAAAA+gAAAALAAAAAAAAAAAAAAANbWF4X29wZW5fZGVidAAAAAAAAAsAAAAAAAAAAAAAABBiYW5kX3NldHRsZV9zZWNzAAAABgAAAAAAAAAC",
        "AAAABQAAAENBZG1pbiBxdWV1ZWQgYSBwYXVzZSBjaGFuZ2UgYmVoaW5kIHRoZSB0aW1lbG9jayAoREVDSVNJT05TLm1kICMzMykuAAAAAAAAAAATUGF1c2VDaGFuZ2VQcm9wb3NlZAAAAAABAAAAFXBhdXNlX2NoYW5nZV9wcm9wb3NlZAAAAAAAAAQAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAAA2V0YQAAAAAGAAAAAAAAAAAAAAAMbm9fbmV3X3JlcG9zAAAAAQAAAAAAAAAAAAAACG5vX3NlaXplAAAAAQAAAAAAAAAC",
        "AAAABQAAAIVBZG1pbiBzdGFydGVkIGEgaGFuZG92ZXIgdG8gYG5ld19hZG1pbmAsIHZhbGlkIHRocm91Z2gKYGxpdmVfdW50aWxfbGVkZ2VyYDsgMCBtZWFucyB0aGUgcGVuZGluZyBoYW5kb3ZlciB3YXMgY2FuY2VsbGVkIChSYXZlbgpVQS0wNikuAAAAAAAAAAAAABRBZG1pblRyYW5zZmVyU3RhcnRlZAAAAAEAAAAWYWRtaW5fdHJhbnNmZXJfc3RhcnRlZAAAAAAAAgAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAAAAAAAEWxpdmVfdW50aWxfbGVkZ2VyAAAAAAAABAAAAAAAAAAC",
        "AAAABQAAAENBZG1pbiBxdWV1ZWQgYSBndWFyZGlhbiByb3RhdGlvbiBiZWhpbmQgdGhlIHRpbWVsb2NrIChSYXZlbiBVQS0wMikuAAAAAAAAAAAWR3VhcmRpYW5DaGFuZ2VQcm9wb3NlZAAAAAAAAQAAABhndWFyZGlhbl9jaGFuZ2VfcHJvcG9zZWQAAAACAAAAAAAAAAhndWFyZGlhbgAAABMAAAABAAAAAAAAAANldGEAAAAABgAAAAAAAAAC",
        "AAAABQAAAEFBZG1pbiBkcm9wcGVkIGl0cyBwZW5kaW5nIGd1YXJkaWFuIHJvdGF0aW9uIChvbmx5IHRoZSBhZG1pbiBjYW4pLgAAAAAAAAAAAAAXR3VhcmRpYW5DaGFuZ2VDYW5jZWxsZWQAAAAAAQAAABlndWFyZGlhbl9jaGFuZ2VfY2FuY2VsbGVkAAAAAAAAAQAAAAAAAAAIZ3VhcmRpYW4AAAATAAAAAQAAAAI=",
        "AAAABQAAAIVBIHBlbmRpbmcgbGlxdWlkYXRvciBhZGRpdGlvbiB3YXMgZHJvcHBlZDogY2FuY2VsbGVkIGJ5IGFkbWluIG9yCmd1YXJkaWFuLCByZXBsYWNlZCBieSBhIHJlLXByb3Bvc2FsLCBvciBieSBhIHJlbW92YWwgKGBieWAgPSBhZG1pbikuAAAAAAAAAAAAABtMaXF1aWRhdG9yUHJvcG9zYWxDYW5jZWxsZWQAAAAAAQAAAB1saXF1aWRhdG9yX3Byb3Bvc2FsX2NhbmNlbGxlZAAAAAAAAAIAAAAAAAAAA3dobwAAAAATAAAAAQAAAAAAAAACYnkAAAAAABMAAAAAAAAAAg==" ]),
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
        roles: this.txFromJSON<Roles>,
        config: this.txFromJSON<Config>,
        top_up: this.txFromJSON<Result<void>>,
        default: this.txFromJSON<Result<Status>>,
        request: this.txFromJSON<Result<BorrowRequest>>,
        note_nav: this.txFromJSON<Result<BandCandidate>>,
        claimable: this.txFromJSON<i128>,
        liquidate: this.txFromJSON<Result<void>>,
        open_debt: this.txFromJSON<i128>,
        set_asset: this.txFromJSON<Result<void>>,
        set_pause: this.txFromJSON<Result<void>>,
        auto_repay: this.txFromJSON<Result<void>>,
        take_offer: this.txFromJSON<Result<u64>>,
        accept_admin: this.txFromJSON<Result<void>>,
        cancel_asset: this.txFromJSON<Result<void>>,
        cancel_offer: this.txFromJSON<Result<void>>,
        cancel_pause: this.txFromJSON<Result<void>>,
        check_margin: this.txFromJSON<Result<Status>>,
        create_offer: this.txFromJSON<Result<u64>>,
        fill_request: this.txFromJSON<Result<u64>>,
        claim_in_kind: this.txFromJSON<Result<i128>>,
        execute_asset: this.txFromJSON<Result<void>>,
        execute_pause: this.txFromJSON<Result<void>>,
        is_liquidator: this.txFromJSON<boolean>,
        pending_asset: this.txFromJSON<Option<PendingAsset>>,
        pending_pause: this.txFromJSON<Option<PendingPause>>,
        propose_asset: this.txFromJSON<Result<u64>>,
        propose_pause: this.txFromJSON<Result<u64>>,
        band_candidate: this.txFromJSON<Result<Option<BandCandidate>>>,
        cancel_request: this.txFromJSON<Result<void>>,
        create_request: this.txFromJSON<Result<u64>>,
        set_auto_repay: this.txFromJSON<Result<void>>,
        set_liquidator: this.txFromJSON<null>,
        transfer_admin: this.txFromJSON<Result<void>>,
        cancel_guardian: this.txFromJSON<Result<void>>,
        claim_collateral: this.txFromJSON<Result<i128>>,
        execute_guardian: this.txFromJSON<Result<void>>,
        propose_guardian: this.txFromJSON<Result<u64>>,
        cancel_liquidator: this.txFromJSON<Result<void>>,
        execute_liquidator: this.txFromJSON<Result<void>>,
        guardian_set_asset: this.txFromJSON<Result<void>>,
        guardian_set_pause: this.txFromJSON<Result<void>>,
        pending_liquidator: this.txFromJSON<Option<u64>>,
        propose_liquidator: this.txFromJSON<Result<u64>>,
        claimable_collateral: this.txFromJSON<i128>
  }
}