//! Events the frontend and keeper index. Ids are topics so they can be
//! filtered; amounts go in the data map.

use soroban_sdk::{contractevent, Address};

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
    pub haircut_bps: u32,
    pub term_secs: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferCancelled {
    #[topic]
    pub offer_id: u64,
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
    pub collateral_amount: i128,
    pub principal: i128,
    pub interest: i128,
    pub maturity_ts: u64,
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
