//! Events the frontend and keeper index. Ids are topics so they can be
//! filtered; amounts go in the data map.

use soroban_sdk::{contractevent, Address, Symbol};

use crate::types::DefaultReason;

/// Admin added or re-tiered a collateral asset (DECISIONS.md #13).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetConfigured {
    #[topic]
    pub asset: Address,
    pub haircut_bps: u32,
    pub margin_trigger_bps: u32,
    pub enabled: bool,
    pub max_nav_age_secs: u64,
    pub max_nav_move_bps: u32,
    pub nav_floor: Option<i128>,
    pub nav_ceiling: Option<i128>,
    pub max_open_debt: i128,
}

/// Admin set an asset's pause switches (DECISIONS.md #30).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseSet {
    #[topic]
    pub asset: Address,
    pub no_new_repos: bool,
    pub no_seize: bool,
}

/// Admin queued an asset change behind the timelock (DECISIONS.md #33).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetChangeProposed {
    #[topic]
    pub asset: Address,
    pub eta: u64,
    pub haircut_bps: u32,
    pub margin_trigger_bps: u32,
    pub enabled: bool,
    pub max_nav_age_secs: u64,
    pub max_nav_move_bps: u32,
    pub nav_floor: Option<i128>,
    pub nav_ceiling: Option<i128>,
    pub max_open_debt: i128,
}

/// Admin queued a pause change behind the timelock (DECISIONS.md #33).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseChangeProposed {
    #[topic]
    pub asset: Address,
    pub eta: u64,
    pub no_new_repos: bool,
    pub no_seize: bool,
}

/// A proposal took effect. `kind` is `asset` or `pause`; the matching
/// `AssetConfigured` / `PauseSet` follows.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecuted {
    #[topic]
    pub asset: Address,
    #[topic]
    pub kind: Symbol,
}

/// A proposal was dropped: cancelled by admin or guardian, or superseded
/// by an instant change to the same asset (`by` made that change).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCancelled {
    #[topic]
    pub asset: Address,
    #[topic]
    pub kind: Symbol,
    pub by: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferCreated {
    #[topic]
    pub offer_id: u64,
    #[topic]
    pub lender: Address,
    pub collateral_asset: Address,
    pub principal: i128,
    pub apr_bps: u32,
    pub term_secs: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferCancelled {
    #[topic]
    pub offer_id: u64,
    #[topic]
    pub lender: Address,
    /// USDC returned to the lender.
    pub principal: i128,
}

/// Emitted by `take_offer`: the DvP leg that opens a repo.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoOpened {
    #[topic]
    pub repo_id: u64,
    #[topic]
    pub offer_id: u64,
    pub lender: Address,
    pub borrower: Address,
    pub collateral_asset: Address,
    pub collateral_amount: i128,
    pub principal: i128,
    pub interest: i128,
    /// Asset haircut snapshotted at take time.
    pub haircut_bps: u32,
    pub maturity_ts: u64,
    pub auto_repay: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarginCall {
    #[topic]
    pub repo_id: u64,
    pub deadline: u64,
    /// NAV that showed the breach, scaled for the collateral token
    /// (`nav_decimals`, DECISIONS.md #28).
    pub nav: i128,
    pub nav_decimals: u32,
}

/// `default` on a missed margin call found the loan out of breach at a fresh
/// NAV and cleared the call instead (DECISIONS.md #20). The repo is `Open`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarginCleared {
    #[topic]
    pub repo_id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToppedUp {
    #[topic]
    pub repo_id: u64,
    pub amount: i128,
    pub collateral_amount: i128,
    /// True when the top-up made the repo healthy and cleared a margin call.
    pub cleared: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Repaid {
    #[topic]
    pub repo_id: u64,
    pub lender_amount: i128,
    pub fee: i128,
    /// True when the debt was pulled by auto-repay, not paid by the borrower.
    pub automatic: bool,
}

/// Borrower turned auto-repay on or off for a live repo (#27).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AutoRepaySet {
    #[topic]
    pub repo_id: u64,
    pub enabled: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Defaulted {
    #[topic]
    pub repo_id: u64,
    pub reason: DefaultReason,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Liquidated {
    #[topic]
    pub repo_id: u64,
    #[topic]
    pub liquidator: Address,
    pub proceeds: i128,
    pub lender_amount: i128,
    pub fee: i128,
    pub borrower_amount: i128,
    /// NAV the proceeds were priced at, scaled for the collateral token
    /// (`nav_decimals`, DECISIONS.md #28).
    pub nav: i128,
    pub nav_decimals: u32,
}

/// Liquidation proceeds did not cover what the lender was owed
/// (DECISIONS.md #4). `amount` is the lender's unpaid balance.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Shortfall {
    #[topic]
    pub repo_id: u64,
    pub amount: i128,
}
