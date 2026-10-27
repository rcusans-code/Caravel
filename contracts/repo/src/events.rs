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
    pub band_settle_secs: u64,
}

/// `note_nav` started the band settle clock on a new NAV level (side
/// band-real-move). Unless the level moves again, a price within the band of
/// `price` is accepted from `since + band_settle_secs` even if the feed's
/// window still disagrees: the guardian's window to pause a bad push.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NavLevelNoted {
    #[topic]
    pub oracle_asset: crate::types::Asset,
    pub price: i128,
    pub since: u64,
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
    pub band_settle_secs: u64,
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

/// A proposal was dropped: cancelled by admin or guardian, replaced by a
/// new proposal of the same kind (`by` = admin, issue #41), or superseded
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

/// A borrower posted a borrow request and escrowed its collateral.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestCreated {
    #[topic]
    pub request_id: u64,
    #[topic]
    pub borrower: Address,
    pub collateral_asset: Address,
    pub collateral_amount: i128,
    pub principal: i128,
    pub apr_bps: u32,
    pub term_secs: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestCancelled {
    #[topic]
    pub request_id: u64,
    #[topic]
    pub borrower: Address,
    /// Collateral returned to the borrower.
    pub collateral_amount: i128,
}

/// A lender filled a borrow request; the `RepoOpened` for `repo_id`
/// (with `offer_id` 0) is emitted just before it.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestFilled {
    #[topic]
    pub request_id: u64,
    #[topic]
    pub repo_id: u64,
    pub lender: Address,
    pub borrower: Address,
}

/// Emitted by `take_offer` and `fill_request`: the DvP leg that opens a
/// repo. `offer_id` is 0 for a request-born repo (see `RequestFilled`).
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

/// A USDC payout to `to` failed (frozen account, closed trustline), so the
/// contract kept it: `to` collects it with `claim`. The settlement went ahead.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutParked {
    #[topic]
    pub repo_id: u64,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

/// `who` collected its parked USDC payouts.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimed {
    #[topic]
    pub who: Address,
    pub amount: i128,
}

/// NAV outage fallback: the lender took a Defaulted repo's collateral in
/// kind (no sale, no fee, no borrower surplus). The repo is `Liquidated`.
/// `parked` = the token refused the push to the lender (permissioned token,
/// frozen trustline); it waits for `claim_collateral`. `nav_timestamp` is
/// the time the outage was measured from: the stale NAV's timestamp, or the
/// repo's `maturity_ts + grace_secs` when the feed gave no usable one (no
/// price, or dated beyond `oracle::MAX_FUTURE_SKEW_SECS`).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimedInKind {
    #[topic]
    pub repo_id: u64,
    #[topic]
    pub lender: Address,
    pub collateral_asset: Address,
    pub collateral_amount: i128,
    pub parked: bool,
    pub nav_timestamp: u64,
}

/// `who` collected its parked collateral of `collateral_asset`, sent to `to`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralClaimed {
    #[topic]
    pub who: Address,
    #[topic]
    pub collateral_asset: Address,
    pub to: Address,
    pub amount: i128,
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

// --- governance (Raven R6) ----------------------------------------------------

/// The liquidator whitelist changed (Raven STD-03 / OZ-03): `allowed` true
/// when `execute_liquidator` added `who`, false when `set_liquidator`
/// removed it.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidatorSet {
    #[topic]
    pub who: Address,
    pub allowed: bool,
}

/// Admin queued a liquidator addition behind the timelock (Raven UA-03).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidatorProposed {
    #[topic]
    pub who: Address,
    pub eta: u64,
}

/// A pending liquidator addition was dropped: cancelled by admin or
/// guardian, replaced by a re-proposal, or by a removal (`by` = admin).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidatorProposalCancelled {
    #[topic]
    pub who: Address,
    pub by: Address,
}

/// Admin queued a guardian rotation behind the timelock (Raven UA-02).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardianChangeProposed {
    #[topic]
    pub guardian: Address,
    pub eta: u64,
}

/// Admin dropped its pending guardian rotation (only the admin can).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardianChangeCancelled {
    #[topic]
    pub guardian: Address,
}

/// The guardian role moved to `guardian` (`execute_guardian`).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardianSet {
    #[topic]
    pub guardian: Address,
    pub previous: Address,
}

/// Admin started a handover to `new_admin`, valid through
/// `live_until_ledger`; 0 means the pending handover was cancelled (Raven
/// UA-06).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferStarted {
    #[topic]
    pub new_admin: Address,
    pub live_until_ledger: u32,
}

/// The admin role moved to `admin` (`accept_admin`).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminSet {
    #[topic]
    pub admin: Address,
    pub previous: Address,
}
