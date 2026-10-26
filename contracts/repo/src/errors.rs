use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotImplemented = 1,
    InvalidConfig = 2,
    InvalidAmount = 3,
    MathOverflow = 4,
    OfferNotFound = 5,
    RepoNotFound = 6,
    InvalidStatus = 7,
    /// Collateral asset has no `AssetConfig`, or it is disabled.
    AssetNotSupported = 8,
    StaleNav = 9,
    InsufficientCollateral = 10,
    NotLiquidator = 11,
    NotDefaultable = 12,
    /// Oracle has no price for the asset, or it is not positive.
    NoPrice = 13,
    /// `auto_repay` on a repo that did not opt in.
    AutoRepayOff = 14,
    /// `auto_repay` before maturity (and no missed margin call).
    NotDue = 15,
    /// The USDC pull failed (short balance, allowance too small or expired),
    /// or the collateral could not be returned to the borrower.
    AutoRepayFailed = 16,
    /// The asset's `no_new_repos` or `no_seize` switch blocks this call (#30).
    Paused = 17,
    /// NAV outside the asset's sanity band: beyond `nav_floor` / `nav_ceiling`,
    /// or more than `max_nav_move_bps` from a recent oracle record (#31).
    NavOutOfBand = 18,
    /// `take_offer` would push the asset's open debt past `max_open_debt` (#32).
    CapExceeded = 19,
    /// The change loosens risk: it must go through `propose_*`, wait out
    /// `timelock_secs`, then `execute_*` (#33).
    Loosens = 20,
    /// `execute_*` before the proposal's `eta`.
    TimelockNotDone = 21,
    /// `execute_*` or `cancel_*` with no pending proposal for the asset.
    NoProposal = 22,
    /// `cancel_*` by someone who is neither admin nor guardian.
    NotAdminOrGuardian = 23,
    /// `claim` by an address with no parked USDC payout.
    NothingToClaim = 24,
    /// `claim_in_kind` while the NAV is fresh, or stale for no longer than
    /// `inkind::NAV_OUTAGE_DAYS` demo/real days: use `liquidate` or wait.
    NoNavOutage = 25,
    /// `execute_*` after the proposal's window closed (`eta + timelock_secs`):
    /// propose it again (#33, issue #41).
    ProposalExpired = 26,
}
