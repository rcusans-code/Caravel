//! Storage layout: instance = config, counters, asset configs and per-asset
//! open debt (few entries, they share the instance TTL), persistent = offers,
//! repos, the liquidator whitelist, auto-repay allowance expiries and parked
//! USDC payouts (claimable balances). Every read or write of a persistent
//! entry bumps its TTL, so live positions never get archived mid-term.

use soroban_sdk::{contracttype, Address, Env, IntoVal, TryFromVal, Val};

use crate::types::{
    Asset, AssetConfig, BandCandidate, Config, Offer, Pause, PendingAdmin, PendingAsset,
    PendingGuardian, PendingPause, Repo,
};

const DAY_IN_LEDGERS: u32 = 17_280; // ~5 s per ledger

/// Testnet instance TTL. Extending the instance also extends the contract
/// code entry. On testnet, pushing this contract's code past its fresh ~7-day
/// TTL costs ~240 XLM per extra day (a 30-day bump at deploy quoted 5,512
/// XLM). 6 days stays inside the TTL a fresh upload/deploy already has, so
/// deploy pays no code rent.
///
/// PRODUCTION: set this to [`PROD_INSTANCE_BUMP`].
const INSTANCE_BUMP: u32 = 6 * DAY_IN_LEDGERS;
/// Production instance TTL: 30 days, matching persistent entries, so config,
/// asset settings and open-debt counters cannot lapse while repos live.
#[allow(dead_code)]
const PROD_INSTANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;
const PERSISTENT_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const PERSISTENT_THRESHOLD: u32 = PERSISTENT_BUMP - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    // instance
    Config,
    NextOfferId,
    NextRepoId,
    Asset(Address),
    /// Per-asset pause switches (#30). Absent = nothing paused.
    Pause(Address),
    /// Debt of live repos on this collateral asset (#32). Kept apart from
    /// `Asset` so `set_asset` never resets it.
    OpenDebt(Address),
    /// Admin change waiting out the timelock (#33). At most one per asset.
    PendingAsset(Address),
    PendingPause(Address),
    /// NAV level `note_nav` watched stand, per oracle asset (side
    /// band-real-move). Kept apart from `Asset` so `set_asset` never resets it.
    BandCandidate(Asset),
    // persistent
    Offer(u64),
    Repo(u64),
    Liquidator(Address),
    /// Last ledger of the borrower's USDC allowance to this contract (#27).
    AllowanceUntil(Address),
    /// USDC a payout could not push to this address (frozen account, closed
    /// trustline). Paid out by `claim`.
    Claimable(Address),
    /// Collateral (holder, token) an in-kind claim could not push to the
    /// lender (permissioned token refused it, frozen trustline). Paid out by
    /// `claim_collateral`.
    ClaimableCollateral(Address, Address),
    // --- Raven R6 governance (appended; instance unless noted) ---
    /// Admin guardian rotation waiting out the timelock.
    PendingGuardian,
    /// Temporary: admin handover waiting for `accept_admin`.
    PendingAdmin,
    /// Liquidator addition waiting out the timelock: its `eta`.
    PendingLiquidator(Address),
    /// The last change of each kind the guardian cancelled or superseded:
    /// re-proposed unchanged, only the admin can cancel it.
    VetoedAsset(Address),
    VetoedPause(Address),
    VetoedLiquidator(Address),
}

pub fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

fn extend_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
}

// --- config ---------------------------------------------------------------

pub fn read_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .expect("config set in constructor")
}

pub fn write_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

// --- assets ---------------------------------------------------------------

pub fn read_asset(env: &Env, asset: &Address) -> Option<AssetConfig> {
    env.storage().instance().get(&DataKey::Asset(asset.clone()))
}

pub fn write_asset(env: &Env, asset: &Address, config: &AssetConfig) {
    env.storage()
        .instance()
        .set(&DataKey::Asset(asset.clone()), config);
}

pub fn read_pause(env: &Env, asset: &Address) -> Pause {
    env.storage()
        .instance()
        .get(&DataKey::Pause(asset.clone()))
        .unwrap_or_default()
}

pub fn write_pause(env: &Env, asset: &Address, pause: &Pause) {
    let key = DataKey::Pause(asset.clone());
    if *pause == Pause::default() {
        env.storage().instance().remove(&key);
    } else {
        env.storage().instance().set(&key, pause);
    }
}

// --- timelocked proposals (#33) ---------------------------------------------

pub fn read_pending_asset(env: &Env, asset: &Address) -> Option<PendingAsset> {
    env.storage()
        .instance()
        .get(&DataKey::PendingAsset(asset.clone()))
}

pub fn write_pending_asset(env: &Env, asset: &Address, pending: &PendingAsset) {
    env.storage()
        .instance()
        .set(&DataKey::PendingAsset(asset.clone()), pending);
}

pub fn remove_pending_asset(env: &Env, asset: &Address) {
    env.storage()
        .instance()
        .remove(&DataKey::PendingAsset(asset.clone()));
}

pub fn read_pending_pause(env: &Env, asset: &Address) -> Option<PendingPause> {
    env.storage()
        .instance()
        .get(&DataKey::PendingPause(asset.clone()))
}

pub fn write_pending_pause(env: &Env, asset: &Address, pending: &PendingPause) {
    env.storage()
        .instance()
        .set(&DataKey::PendingPause(asset.clone()), pending);
}

pub fn remove_pending_pause(env: &Env, asset: &Address) {
    env.storage()
        .instance()
        .remove(&DataKey::PendingPause(asset.clone()));
}

// --- NAV band settle clock (side band-real-move) -----------------------------

pub fn read_band_candidate(env: &Env, asset: &Asset) -> Option<BandCandidate> {
    env.storage()
        .instance()
        .get(&DataKey::BandCandidate(asset.clone()))
}

pub fn write_band_candidate(env: &Env, asset: &Asset, candidate: &BandCandidate) {
    env.storage()
        .instance()
        .set(&DataKey::BandCandidate(asset.clone()), candidate);
}

// --- exposure (#32) ---------------------------------------------------------

pub fn read_open_debt(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::OpenDebt(asset.clone()))
        .unwrap_or(0)
}

pub fn write_open_debt(env: &Env, asset: &Address, amount: i128) {
    env.storage()
        .instance()
        .set(&DataKey::OpenDebt(asset.clone()), &amount);
}

/// A repo left the book (repaid, auto-repaid or liquidated, shortfall or not):
/// frees its whole debt. Floors at 0 and never errors, so the counter can
/// never block an exit.
pub fn release_open_debt(env: &Env, asset: &Address, debt: i128) {
    let left = read_open_debt(env, asset).saturating_sub(debt).max(0);
    write_open_debt(env, asset, left);
}

// --- ids ------------------------------------------------------------------

fn next_id(env: &Env, key: &DataKey) -> u64 {
    let id: u64 = env.storage().instance().get(key).unwrap_or(1);
    env.storage().instance().set(key, &(id + 1));
    id
}

pub fn next_offer_id(env: &Env) -> u64 {
    next_id(env, &DataKey::NextOfferId)
}

pub fn next_repo_id(env: &Env) -> u64 {
    next_id(env, &DataKey::NextRepoId)
}

// --- offers ---------------------------------------------------------------

pub fn read_offer(env: &Env, id: u64) -> Option<Offer> {
    let key = DataKey::Offer(id);
    let offer = env.storage().persistent().get(&key);
    if offer.is_some() {
        extend_persistent(env, &key);
    }
    offer
}

pub fn write_offer(env: &Env, offer: &Offer) {
    let key = DataKey::Offer(offer.id);
    env.storage().persistent().set(&key, offer);
    extend_persistent(env, &key);
}

pub fn remove_offer(env: &Env, id: u64) {
    env.storage().persistent().remove(&DataKey::Offer(id));
}

// --- repos ----------------------------------------------------------------

pub fn read_repo(env: &Env, id: u64) -> Option<Repo> {
    let key = DataKey::Repo(id);
    let repo = env.storage().persistent().get(&key);
    if repo.is_some() {
        extend_persistent(env, &key);
    }
    repo
}

pub fn write_repo(env: &Env, repo: &Repo) {
    let key = DataKey::Repo(repo.id);
    env.storage().persistent().set(&key, repo);
    extend_persistent(env, &key);
}

// --- liquidators ----------------------------------------------------------

pub fn is_liquidator(env: &Env, who: &Address) -> bool {
    let key = DataKey::Liquidator(who.clone());
    let allowed = env.storage().persistent().get(&key).unwrap_or(false);
    if allowed {
        extend_persistent(env, &key);
    }
    allowed
}

pub fn set_liquidator(env: &Env, who: &Address, allowed: bool) {
    let key = DataKey::Liquidator(who.clone());
    if allowed {
        env.storage().persistent().set(&key, &true);
        extend_persistent(env, &key);
    } else {
        env.storage().persistent().remove(&key);
    }
}

// --- auto-repay allowances --------------------------------------------------

pub fn read_allowance_until(env: &Env, borrower: &Address) -> Option<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::AllowanceUntil(borrower.clone()))
}

pub fn write_allowance_until(env: &Env, borrower: &Address, ledger: u32) {
    let key = DataKey::AllowanceUntil(borrower.clone());
    env.storage().persistent().set(&key, &ledger);
    extend_persistent(env, &key);
}

pub fn remove_allowance_until(env: &Env, borrower: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::AllowanceUntil(borrower.clone()));
}

// --- parked payouts ---------------------------------------------------------

pub fn read_claimable(env: &Env, who: &Address) -> i128 {
    let key = DataKey::Claimable(who.clone());
    let amount = env.storage().persistent().get(&key).unwrap_or(0);
    if amount > 0 {
        extend_persistent(env, &key);
    }
    amount
}

/// Adds `amount` to `who`'s parked balance. Saturates: the USDC is already
/// in the contract, so the counter can never block an exit.
pub fn add_claimable(env: &Env, who: &Address, amount: i128) {
    let key = DataKey::Claimable(who.clone());
    let total = read_claimable(env, who).saturating_add(amount);
    env.storage().persistent().set(&key, &total);
    extend_persistent(env, &key);
}

pub fn remove_claimable(env: &Env, who: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Claimable(who.clone()));
}

// --- parked collateral (in-kind claims) -------------------------------------

pub fn read_claimable_collateral(env: &Env, who: &Address, token: &Address) -> i128 {
    let key = DataKey::ClaimableCollateral(who.clone(), token.clone());
    let amount = env.storage().persistent().get(&key).unwrap_or(0);
    if amount > 0 {
        extend_persistent(env, &key);
    }
    amount
}

/// Adds `amount` of `token` to `who`'s parked collateral. Saturates, like
/// [`add_claimable`]: the tokens are already in the contract.
pub fn add_claimable_collateral(env: &Env, who: &Address, token: &Address, amount: i128) {
    let key = DataKey::ClaimableCollateral(who.clone(), token.clone());
    let total = read_claimable_collateral(env, who, token).saturating_add(amount);
    env.storage().persistent().set(&key, &total);
    extend_persistent(env, &key);
}

pub fn remove_claimable_collateral(env: &Env, who: &Address, token: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::ClaimableCollateral(who.clone(), token.clone()));
}

// --- role rotation and the liquidator timelock (Raven R6) -------------------

pub fn read_pending_guardian(env: &Env) -> Option<PendingGuardian> {
    env.storage().instance().get(&DataKey::PendingGuardian)
}

pub fn write_pending_guardian(env: &Env, pending: &PendingGuardian) {
    env.storage()
        .instance()
        .set(&DataKey::PendingGuardian, pending);
}

pub fn remove_pending_guardian(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingGuardian);
}

/// The admin handover in flight, if any and not past its
/// `live_until_ledger` (the temporary entry may outlive it by a ledger or
/// two, so the ledger is checked here too).
pub fn read_pending_admin(env: &Env) -> Option<PendingAdmin> {
    let pending: PendingAdmin = env.storage().temporary().get(&DataKey::PendingAdmin)?;
    (env.ledger().sequence() <= pending.live_until_ledger).then_some(pending)
}

/// Stores the handover in temporary storage, alive through
/// `pending.live_until_ledger` (the caller checked it is in range).
pub fn write_pending_admin(env: &Env, pending: &PendingAdmin) {
    let key = DataKey::PendingAdmin;
    let ttl = pending
        .live_until_ledger
        .saturating_sub(env.ledger().sequence());
    env.storage().temporary().set(&key, pending);
    env.storage().temporary().extend_ttl(&key, ttl, ttl);
}

pub fn remove_pending_admin(env: &Env) {
    env.storage().temporary().remove(&DataKey::PendingAdmin);
}

pub fn read_pending_liquidator(env: &Env, who: &Address) -> Option<u64> {
    env.storage()
        .instance()
        .get(&DataKey::PendingLiquidator(who.clone()))
}

pub fn write_pending_liquidator(env: &Env, who: &Address, eta: u64) {
    env.storage()
        .instance()
        .set(&DataKey::PendingLiquidator(who.clone()), &eta);
}

pub fn remove_pending_liquidator(env: &Env, who: &Address) {
    env.storage()
        .instance()
        .remove(&DataKey::PendingLiquidator(who.clone()));
}

/// The change the guardian last cancelled under `key` (a `Vetoed*` key).
pub fn read_vetoed<V: TryFromVal<Env, Val>>(env: &Env, key: &DataKey) -> Option<V> {
    env.storage().instance().get(key)
}

pub fn write_vetoed<V: IntoVal<Env, Val>>(env: &Env, key: &DataKey, change: &V) {
    env.storage().instance().set(key, change);
}

pub fn remove_vetoed(env: &Env, key: &DataKey) {
    env.storage().instance().remove(key);
}
