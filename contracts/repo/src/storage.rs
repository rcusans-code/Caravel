//! Storage layout: instance = config, counters and asset configs (few
//! entries, they share the instance TTL), persistent = offers,
//! repos, the liquidator whitelist and auto-repay allowance expiries. Every read or write of a persistent
//! entry bumps its TTL, so live positions never get archived mid-term.

use soroban_sdk::{contracttype, Address, Env};

use crate::types::{AssetConfig, Config, Offer, Repo};

const DAY_IN_LEDGERS: u32 = 17_280; // ~5 s per ledger
// Extending the instance also extends the contract code entry. On testnet,
// pushing this contract's code past its fresh ~7-day TTL costs ~240 XLM per
// extra day (a 30-day bump at deploy quoted 5,512 XLM). 6 days stays inside
// the TTL a fresh upload/deploy already has, so deploy pays no code rent.
const INSTANCE_BUMP: u32 = 6 * DAY_IN_LEDGERS;
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
    // persistent
    Offer(u64),
    Repo(u64),
    Liquidator(Address),
    /// Last ledger of the borrower's USDC allowance to this contract (#27).
    AllowanceUntil(Address),
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
