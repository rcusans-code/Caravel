#![no_std]

//! Caravel mock SEP-40 price feed.
//!
//! Implements the full SEP-40 read interface with Reflector's exact types
//! (`Asset`, `PriceData`), so the repo contract's oracle client can point at
//! this mock or at a live Reflector/RedStone feed by changing only the
//! contract ID (DECISIONS.md #2, #22).
//!
//! Prices are pushed by the admin with `set_price` (stamped with the ledger
//! time) or `set_price_at` (explicit timestamp, for staleness demos).
//!
//! Decimals are set in the constructor. The deploy script uses 14, the same
//! as Reflector, so NAV math is identical against the mock and a live feed.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Symbol,
    Vec,
};

#[cfg(test)]
mod test;

/// Records kept per asset for `prices()` / `price()`.
pub const MAX_HISTORY: u32 = 20;

const DAY_LEDGERS: u32 = 17_280; // ~5 s ledgers
const TTL_THRESHOLD: u32 = 7 * DAY_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_LEDGERS;

/// SEP-40 asset identifier. Same name and shape as Reflector's and as
/// `caravel_repo::Asset`, so the XDR is identical.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// SEP-40 price record. `price` is scaled by `decimals()`; `timestamp` is
/// unix seconds.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidPrice = 1,
    InvalidConfig = 2,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Base,
    Decimals,
    Resolution,
    Assets,
    /// Persistent: `Vec<PriceData>` for one asset, oldest first.
    History(Asset),
}

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn __constructor(env: Env, admin: Address, base: Asset, decimals: u32, resolution: u32) {
        // 10^38 overflows i128; resolution 0 is meaningless.
        if decimals > 38 || resolution == 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Base, &base);
        s.set(&DataKey::Decimals, &decimals);
        s.set(&DataKey::Resolution, &resolution);
        s.set(&DataKey::Assets, &Vec::<Asset>::new(&env));
        extend_instance(&env);
    }

    // --- SEP-40 -----------------------------------------------------------

    /// Asset that prices are quoted in (e.g. `Other("USD")`).
    pub fn base(env: Env) -> Asset {
        extend_instance(&env);
        env.storage().instance().get(&DataKey::Base).unwrap()
    }

    /// Every asset that has ever had a price set, in first-set order.
    pub fn assets(env: Env) -> Vec<Asset> {
        extend_instance(&env);
        read_assets(&env)
    }

    pub fn decimals(env: Env) -> u32 {
        extend_instance(&env);
        env.storage().instance().get(&DataKey::Decimals).unwrap()
    }

    /// Nominal update interval in seconds (informational for the mock).
    pub fn resolution(env: Env) -> u32 {
        extend_instance(&env);
        env.storage().instance().get(&DataKey::Resolution).unwrap()
    }

    /// Price in effect at `timestamp`: the newest record with
    /// `record.timestamp <= timestamp`. `None` if no record is that old.
    pub fn price(env: Env, asset: Asset, timestamp: u64) -> Option<PriceData> {
        extend_instance(&env);
        let history = read_history(&env, &asset)?;
        let mut i = history.len();
        while i > 0 {
            i -= 1;
            let rec = history.get_unchecked(i);
            if rec.timestamp <= timestamp {
                return Some(rec);
            }
        }
        None
    }

    /// Up to `records` most recent prices, newest first (Reflector order).
    /// `None` if the asset has no prices or `records == 0`.
    pub fn prices(env: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        extend_instance(&env);
        if records == 0 {
            return None;
        }
        let history = read_history(&env, &asset)?;
        let mut out = Vec::new(&env);
        let mut i = history.len();
        while i > 0 && out.len() < records {
            i -= 1;
            out.push_back(history.get_unchecked(i));
        }
        Some(out)
    }

    /// Most recent price, or `None` if the asset was never priced.
    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        extend_instance(&env);
        read_history(&env, &asset)?.last()
    }

    // --- admin ------------------------------------------------------------

    /// Record `price` for `asset` at the current ledger time.
    pub fn set_price(env: Env, asset: Asset, price: i128) -> Result<(), Error> {
        let ts = env.ledger().timestamp();
        write_price(&env, asset, price, ts)
    }

    /// Record `price` for `asset` at an explicit `timestamp`, e.g. an old
    /// one to demo a stale NAV. Kept sorted; an equal timestamp overwrites.
    pub fn set_price_at(env: Env, asset: Asset, price: i128, timestamp: u64) -> Result<(), Error> {
        write_price(&env, asset, price, timestamp)
    }

    pub fn admin(env: Env) -> Address {
        extend_instance(&env);
        read_admin(&env)
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        read_admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        extend_instance(&env);
    }
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_assets(env: &Env) -> Vec<Asset> {
    env.storage()
        .instance()
        .get(&DataKey::Assets)
        .unwrap_or_else(|| Vec::new(env))
}

fn read_history(env: &Env, asset: &Asset) -> Option<Vec<PriceData>> {
    let key = DataKey::History(asset.clone());
    let p = env.storage().persistent();
    let history: Vec<PriceData> = p.get(&key)?;
    p.extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    Some(history)
}

fn write_price(env: &Env, asset: Asset, price: i128, timestamp: u64) -> Result<(), Error> {
    read_admin(env).require_auth();
    if price <= 0 {
        return Err(Error::InvalidPrice);
    }

    let key = DataKey::History(asset.clone());
    let p = env.storage().persistent();
    let mut history: Vec<PriceData> = match p.get(&key) {
        Some(h) => h,
        None => {
            let mut assets = read_assets(env);
            assets.push_back(asset.clone());
            env.storage().instance().set(&DataKey::Assets, &assets);
            Vec::new(env)
        }
    };

    // Insert keeping oldest-first order; equal timestamp replaces.
    let rec = PriceData { price, timestamp };
    let mut idx = history.len();
    while idx > 0 && history.get_unchecked(idx - 1).timestamp > timestamp {
        idx -= 1;
    }
    if idx > 0 && history.get_unchecked(idx - 1).timestamp == timestamp {
        history.set(idx - 1, rec);
    } else {
        history.insert(idx, rec);
    }
    while history.len() > MAX_HISTORY {
        history.pop_front();
    }

    p.set(&key, &history);
    p.extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    extend_instance(env);
    Ok(())
}
