#![no_std]

//! Caravel mock SEP-40 price feed.
//!
//! Implements the full SEP-40 read interface with Reflector's exact types
//! (`Asset`, `PriceData`), so the repo contract's oracle client can point at
//! this mock or at a live Reflector/RedStone feed by changing only the
//! contract ID (DECISIONS.md #2, #22).
//!
//! Two ways to record a price, chosen per asset by the admin
//! (`set_source_timed`):
//!
//! - **Ledger-timed** (default, testnet demo feed): `set_price` stamps the
//!   ledger time, so the history cannot be backdated, future-dated or
//!   rewritten. One record per `resolution` slot (`timestamp / resolution`,
//!   like Reflector's periods): a second push in the same slot replaces only
//!   the newest record, so the last [`MAX_HISTORY`] records always span more
//!   than `(MAX_HISTORY - 2) × resolution` seconds of ledger time. That is
//!   what makes the repo's NAV band window (DECISIONS.md #31) a time window
//!   the feeder key cannot flush faster (nav-review 2026-10-26, side
//!   feed-rewrite).
//! - **Source-timed** (a production-shaped NAV feed, DECISIONS.md #39):
//!   `set_price_at` stamps the issuer's publication time, so the repo's
//!   staleness rules measure the NAV's age, not the feeder's liveness. It
//!   never rewrites: the timestamp must be no later than the ledger time,
//!   strictly newer than the newest record and on a later UTC day (one
//!   record per NAV day), and each write must land in a later `resolution`
//!   slot of ledger time than the one before. So the window cannot be
//!   flushed faster than the ledger-timed one either, and only as fast as
//!   real days pass once it is current. `set_price` is refused on such an
//!   asset, so a re-posting keeper cannot overwrite the source time.
//!
//! Decimals are set in the constructor. The deploy script uses 14, the same
//! as Reflector, so NAV math is identical against the mock and a live feed.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, Symbol, Vec,
};

#[cfg(test)]
mod test;

/// Records kept per asset for `prices()` / `price()`.
pub const MAX_HISTORY: u32 = 20;

/// One source-timed record per UTC day of source time.
pub const SOURCE_DAY_SECS: u64 = 86_400;

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
/// unix seconds: ledger time for a ledger-timed asset, the source's
/// publication time for a source-timed one.
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
    /// `accept_admin` with no handover pending (Raven R6, UA-06).
    NoPendingAdmin = 3,
    /// `set_price` on a source-timed asset: use `set_price_at`.
    SourceTimed = 4,
    /// `set_price_at` on a ledger-timed asset: use `set_price`.
    NotSourceTimed = 5,
    /// `set_price_at` with a timestamp after the ledger time.
    FutureTimestamp = 6,
    /// `set_price_at` with a timestamp not after the newest record's.
    NotNewer = 7,
    /// `set_price_at` on the same UTC day as the newest record.
    SameDay = 8,
    /// `set_price_at` in the same ledger `resolution` slot as the previous
    /// source-timed write.
    TooSoon = 9,
}

/// A price record was written (Raven R6): every `set_price` and
/// `set_price_at`, so indexers and the repo's monitors see each push,
/// including in-slot replacements. `timestamp` is the record's.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSet {
    #[topic]
    pub asset: Asset,
    pub price: i128,
    pub timestamp: u64,
}

/// The admin switched how `asset`'s records are stamped
/// (`set_source_timed`).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceTimedSet {
    #[topic]
    pub asset: Asset,
    pub source_timed: bool,
}

/// The current admin named `pending` as its successor (`set_admin`); it
/// takes over only on `accept_admin`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposed {
    #[topic]
    pub pending: Address,
}

/// The admin role moved to `admin` (`accept_admin`).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminSet {
    #[topic]
    pub admin: Address,
    pub previous: Address,
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
    /// Admin named by `set_admin`, waiting for `accept_admin`.
    PendingAdmin,
    /// Instance: present (`true`) when the asset is source-timed.
    SourceTimed(Asset),
    /// Persistent: ledger time of the asset's last `set_price_at`.
    Written(Asset),
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

    /// Update interval in seconds: the history keeps at most one record per
    /// `resolution` slot of ledger time.
    pub fn resolution(env: Env) -> u32 {
        extend_instance(&env);
        read_resolution(&env)
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

    /// Record `price` for `asset` at the current ledger time. Within the
    /// newest record's `resolution` slot it replaces that record (price and
    /// timestamp); in a later slot it appends a record. Older records are
    /// never touched, so re-posting cannot flush the history faster than one
    /// record per `resolution` seconds. `SourceTimed` if the asset is
    /// source-timed.
    pub fn set_price(env: Env, asset: Asset, price: i128) -> Result<(), Error> {
        read_admin(&env).require_auth();
        if is_source_timed(&env, &asset) {
            return Err(Error::SourceTimed);
        }
        let mut history = load_for_write(&env, &asset, price)?;
        let timestamp = env.ledger().timestamp();
        let resolution = u64::from(read_resolution(&env));
        let rec = PriceData { price, timestamp };
        match history.last() {
            Some(newest) if newest.timestamp / resolution >= timestamp / resolution => {
                history.set(history.len() - 1, rec);
            }
            _ => history.push_back(rec),
        }
        store(&env, &asset, history, price, timestamp);
        Ok(())
    }

    /// Record `price` for a source-timed `asset`, stamped with `timestamp`,
    /// the source's publication time (unix seconds; DECISIONS.md #39).
    /// Always appends, never replaces. Errors, in this order:
    /// `NotSourceTimed` (use `set_price`), `InvalidPrice` (`<= 0`),
    /// `FutureTimestamp` (after the ledger time), `NotNewer` (not after the
    /// newest record), `SameDay` (same UTC day as the newest record: one
    /// record per NAV day), `TooSoon` (same ledger `resolution` slot as the
    /// previous `set_price_at`).
    pub fn set_price_at(env: Env, asset: Asset, price: i128, timestamp: u64) -> Result<(), Error> {
        read_admin(&env).require_auth();
        if !is_source_timed(&env, &asset) {
            return Err(Error::NotSourceTimed);
        }
        let mut history = load_for_write(&env, &asset, price)?;
        let now = env.ledger().timestamp();
        if timestamp > now {
            return Err(Error::FutureTimestamp);
        }
        if let Some(newest) = history.last() {
            if timestamp <= newest.timestamp {
                return Err(Error::NotNewer);
            }
            if timestamp / SOURCE_DAY_SECS <= newest.timestamp / SOURCE_DAY_SECS {
                return Err(Error::SameDay);
            }
        }
        let resolution = u64::from(read_resolution(&env));
        let p = env.storage().persistent();
        let written_key = DataKey::Written(asset.clone());
        if let Some(written) = p.get::<_, u64>(&written_key) {
            if written / resolution >= now / resolution {
                return Err(Error::TooSoon);
            }
        }
        p.set(&written_key, &now);
        p.extend_ttl(&written_key, TTL_THRESHOLD, TTL_EXTEND_TO);
        history.push_back(PriceData { price, timestamp });
        store(&env, &asset, history, price, timestamp);
        Ok(())
    }

    /// Admin: make `asset` source-timed (`true`: only `set_price_at`) or
    /// ledger-timed (`false`: only `set_price`, the default). Existing
    /// records stay. Emits `SourceTimedSet`.
    pub fn set_source_timed(env: Env, asset: Asset, source_timed: bool) {
        read_admin(&env).require_auth();
        let s = env.storage().instance();
        let key = DataKey::SourceTimed(asset.clone());
        if source_timed {
            s.set(&key, &true);
        } else {
            s.remove(&key);
        }
        extend_instance(&env);
        SourceTimedSet {
            asset,
            source_timed,
        }
        .publish(&env);
    }

    /// True when `asset`'s records carry the source's publication time
    /// (`set_price_at`), false when they carry ledger time (`set_price`).
    pub fn source_timed(env: Env, asset: Asset) -> bool {
        extend_instance(&env);
        is_source_timed(&env, &asset)
    }

    pub fn admin(env: Env) -> Address {
        extend_instance(&env);
        read_admin(&env)
    }

    /// The admin named by `set_admin` and not yet accepted, if any.
    pub fn pending_admin(env: Env) -> Option<Address> {
        extend_instance(&env);
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    /// Step 1 of 2 (Raven R6, UA-06): the current admin names `new_admin`,
    /// which takes over only when it calls `accept_admin`, so a mistyped
    /// address cannot lose the feed. Replaces any pending name; naming the
    /// current admin cancels the handover. Emits `AdminProposed`.
    pub fn set_admin(env: Env, new_admin: Address) {
        let admin = read_admin(&env);
        admin.require_auth();
        let s = env.storage().instance();
        if new_admin == admin {
            s.remove(&DataKey::PendingAdmin);
        } else {
            s.set(&DataKey::PendingAdmin, &new_admin);
        }
        extend_instance(&env);
        AdminProposed { pending: new_admin }.publish(&env);
    }

    /// Step 2 of 2: the pending admin (it signs) becomes the admin. Emits
    /// `AdminSet`. `NoPendingAdmin` if `set_admin` named nobody.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let s = env.storage().instance();
        let pending: Address = s.get(&DataKey::PendingAdmin).ok_or(Error::NoPendingAdmin)?;
        pending.require_auth();
        let previous = read_admin(&env);
        s.set(&DataKey::Admin, &pending);
        s.remove(&DataKey::PendingAdmin);
        extend_instance(&env);
        AdminSet {
            admin: pending,
            previous,
        }
        .publish(&env);
        Ok(())
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

fn read_resolution(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::Resolution).unwrap()
}

fn is_source_timed(env: &Env, asset: &Asset) -> bool {
    env.storage()
        .instance()
        .has(&DataKey::SourceTimed(asset.clone()))
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

/// Shared write checks (the caller already required admin auth): a
/// positive price, then the asset's history, empty for a first price (the
/// asset is then listed in `assets()`).
fn load_for_write(env: &Env, asset: &Asset, price: i128) -> Result<Vec<PriceData>, Error> {
    if price <= 0 {
        return Err(Error::InvalidPrice);
    }
    let key = DataKey::History(asset.clone());
    Ok(match env.storage().persistent().get(&key) {
        Some(h) => h,
        None => {
            let mut assets = read_assets(env);
            assets.push_back(asset.clone());
            env.storage().instance().set(&DataKey::Assets, &assets);
            Vec::new(env)
        }
    })
}

/// Trims to [`MAX_HISTORY`], stores, bumps TTLs and emits `PriceSet`.
fn store(env: &Env, asset: &Asset, mut history: Vec<PriceData>, price: i128, timestamp: u64) {
    while history.len() > MAX_HISTORY {
        history.pop_front();
    }
    let key = DataKey::History(asset.clone());
    let p = env.storage().persistent();
    p.set(&key, &history);
    p.extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    extend_instance(env);
    PriceSet {
        asset: asset.clone(),
        price,
        timestamp,
    }
    .publish(env);
}
