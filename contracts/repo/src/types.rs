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
    /// `Config.liquidation_discount_bps`, so a max-LTV take opens below the
    /// margin trigger.
    pub haircut_bps: u32,
    /// Disabled assets reject new offers; live repos are unaffected.
    pub enabled: bool,
    /// A NAV older than this blocks `take_offer`, `check_margin` and
    /// `liquidate` for this asset (DECISIONS.md #6, #17, #25). Never blocks
    /// `repay` or `top_up`. Per asset because publication schedules differ:
    /// a fund that prints NAV only on business days needs ~96 h to cover a
    /// weekend, a daily-priced token less. Must be > 0.
    pub max_nav_age_secs: u64,
    /// Exposure cap (DECISIONS.md #31): total debt (principal + interest, USDC
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
