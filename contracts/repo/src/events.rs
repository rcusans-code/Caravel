//! Events the frontend and keeper index. Ids are topics so they can be
//! filtered; amounts go in the data map.

use soroban_sdk::{contractevent, Address};

/// Admin added or re-tiered a collateral asset (DECISIONS.md #13).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetConfigured {
    #[topic]
    pub asset: Address,
    pub haircut_bps: u32,
    pub enabled: bool,
    pub max_nav_age_secs: u64,
    pub max_open_debt: i128,
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
