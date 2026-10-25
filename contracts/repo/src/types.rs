use soroban_sdk::{contracttype, Address, Symbol};

/// Protocol parameters, set once at deploy. Stored in instance storage.
///
/// All durations are config so the demo can compress time without touching
/// contract logic (DECISIONS.md #5).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    /// Circle testnet USDC SAC.
    pub usdc: Address,
    /// SEP-40 price feed for collateral NAV.
    pub oracle: Address,
    /// Receives the protocol fee.
    pub treasury: Address,
    /// Protocol fee as a share of interest, in bps (DECISIONS.md #3).
    pub fee_bps: u32,
    /// Liquidator buys collateral at NAV × (1 − discount). 200 = 2%.
    pub liquidation_discount_bps: u32,
    /// Length of one "day" in seconds. 86_400 in production, 60 in the demo.
    /// Interest uses a 365-day year of this length.
    pub day_secs: u64,
    /// Time a borrower has to top up after a margin call.
    pub margin_window_secs: u64,
    /// Time after maturity before an unpaid repo can be defaulted.
    pub grace_secs: u64,
    /// Can only make things safer, instantly (DECISIONS.md #33): disable an
    /// asset, raise a haircut, lower a cap or NAV age, narrow the NAV band,
    /// set pause switches, cancel a pending proposal. It can never loosen anything.
    pub guardian: Address,
    /// Delay between `propose_*` and `execute_*` for every change that adds
    /// risk (DECISIONS.md #33). 172_800 (2 days) in production, 120 in the
    /// demo (#5). Must be > 0.
    pub timelock_secs: u64,
}

/// SEP-40 asset identifier, same shape as Reflector's, so the mock oracle and
/// live feeds accept it unchanged.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// Per-collateral-asset risk parameters, admin-updatable without a redeploy
/// (DECISIONS.md #13). Stored in instance storage, keyed by the token address.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetConfig {
    /// How the oracle names this asset.
    pub oracle_asset: Asset,
    /// Initial LTV: `debt ≤ value × (1 − haircut)`. Always above
    /// `margin_trigger_bps`, so a max-LTV take opens below the margin trigger.
    pub haircut_bps: u32,
    /// Margin trigger (DECISIONS.md #14, #26): a margin call fires once
    /// `debt > value × (1 − margin_trigger_bps)`. Must satisfy
    /// `Config.liquidation_discount_bps ≤ margin_trigger_bps < haircut_bps`.
    /// Above the discount, a liquidation at the call line still pays the
    /// lender `(1 − discount) / (1 − trigger) − 1` over the debt (250 vs 200:
    /// 0.51%), a buffer for the NAV move during the margin window. Applies to
    /// live repos at once; raising it is a tightening (#33).
    pub margin_trigger_bps: u32,
    /// Disabled assets reject new offers; live repos are unaffected.
    pub enabled: bool,
    /// A NAV older than this blocks `take_offer`, `check_margin` and
    /// `liquidate` for this asset (DECISIONS.md #6, #17, #25). Never blocks
    /// `repay` or `top_up`. Per asset because publication schedules differ:
    /// a fund that prints NAV only on business days needs ~96 h to cover a
    /// weekend, a daily-priced token less. Must be > 0.
    pub max_nav_age_secs: u64,
    /// NAV sanity band (DECISIONS.md #31): the latest NAV may differ from
    /// every one of the oracle's last `oracle::NAV_BAND_RECORDS` records by
    /// at most this many bps, else `NavOutOfBand`. Measuring against the
    /// whole window, not just the previous record, means re-posts of a bad
    /// price cannot hide the jump. Blocks `take_offer`, `check_margin` and
    /// `liquidate`, the same set as a stale NAV; never `repay` or `top_up`.
    /// Must be > 0.
    pub max_nav_move_bps: u32,
    /// Optional hard bounds on the latest NAV, in the feed's own scale
    /// (`decimals()`), inclusive. Same effect as the move limit. If set,
    /// each must be > 0 and `nav_floor <= nav_ceiling`.
    pub nav_floor: Option<i128>,
    pub nav_ceiling: Option<i128>,
    /// Exposure cap (DECISIONS.md #32): total debt (principal + interest, USDC
    /// 7 decimals) of live repos on this asset. `take_offer` fails with
    /// `CapExceeded` past it; 0 means no new repos. Exits (repay, auto-repay,
    /// top-up, liquidate) are never blocked, and lowering the cap below the
    /// open debt leaves live repos untouched. Must be ≥ 0.
    pub max_open_debt: i128,
}

/// Per-asset emergency switches (DECISIONS.md #30), stored apart from
/// `AssetConfig` so re-tiering an asset never clears a pause. Each switch
/// stops one action and nothing else; `repay` and `top_up` have no switch.
#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Pause {
    /// Blocks `create_offer` and `take_offer`, like `AssetConfig.enabled =
    /// false` (an alias). `cancel_offer` still works.
    pub no_new_repos: bool,
    /// Blocks `default` (except an auto-repay settle) and `liquidate`. The
    /// default clock keeps running; seizure waits until this clears.
    pub no_seize: bool,
}

/// An admin `AssetConfig` change waiting out the timelock (DECISIONS.md #33).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAsset {
    pub config: AssetConfig,
    /// `execute_asset` works from this ledger timestamp on.
    pub eta: u64,
}

/// An admin `Pause` change waiting out the timelock (DECISIONS.md #33).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingPause {
    pub pause: Pause,
    /// `execute_pause` works from this ledger timestamp on.
    pub eta: u64,
}

/// A lender's standing offer. The lender sets only asset, principal, APR and
/// term; the haircut comes from the asset's `AssetConfig`. The principal is escrowed in the contract
/// from `create_offer` until it is taken or cancelled.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Offer {
    pub id: u64,
    pub lender: Address,
    /// Collateral token the lender accepts (e.g. tBENJI SAC).
    pub collateral_asset: Address,
    /// USDC lent, 7-decimal units.
    pub principal: i128,
    pub apr_bps: u32,
    pub term_secs: u64,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Open,
    MarginCall,
    Repaid,
    Defaulted,
    Liquidated,
}

/// A live or settled repo, created when a borrower takes an offer.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Repo {
    pub id: u64,
    pub offer_id: u64,
    pub lender: Address,
    pub borrower: Address,
    pub collateral_asset: Address,
    /// Collateral held by the contract, in the token's own units (its
    /// `decimals()`: 7 for tBENJI, 5 for Spiko tokens; DECISIONS.md #28).
    pub collateral_amount: i128,
    pub principal: i128,
    /// Full-term interest, fixed at take time. Debt = principal + interest,
    /// the same amount on early repay (DECISIONS.md #15).
    pub interest: i128,
    /// Snapshot of the asset haircut at take time. The top-up target: a
    /// margin call clears once `ltv_ok` holds at this haircut again.
    pub haircut_bps: u32,
    pub start_ts: u64,
    pub maturity_ts: u64,
    /// Set once on the first margin breach; cleared by a healthy top-up.
    pub margin_call_deadline: Option<u64>,
    pub status: Status,
    /// Borrower opted in to auto-repay (DECISIONS.md #27): from maturity the
    /// debt is pulled from their USDC allowance instead of defaulting.
    pub auto_repay: bool,
}
