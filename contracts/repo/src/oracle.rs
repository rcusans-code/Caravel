//! NAV client: reads collateral prices from a SEP-40 feed (DECISIONS.md #2, #22).
//!
//! Flows read NAV only through [`fresh_nav`] (or [`nav`] where staleness must
//! not block, e.g. `repay` / `top_up`, DECISIONS.md #6). Never call the oracle
//! directly from `lib.rs`.

use soroban_sdk::{contractclient, contracttype, Env};

use crate::{
    errors::Error,
    types::{Asset, AssetConfig, Config},
};

/// One price point, same shape as Reflector's, so the mock and live feeds
/// are interchangeable.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    /// Price of the asset in the feed's base, scaled by `decimals()`.
    pub price: i128,
    /// Ledger timestamp (seconds) of the price.
    pub timestamp: u64,
}

/// The subset of the SEP-40 interface Caravel uses.
#[allow(dead_code)]
#[contractclient(name = "PriceFeedClient")]
pub trait PriceFeed {
    /// Latest price for `asset`, or `None` if the feed has none.
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
    /// Decimals the feed's prices are scaled by.
    fn decimals(env: Env) -> u32;
    /// Base asset prices are quoted in.
    fn base(env: Env) -> Asset;
    /// Update interval of the feed, in seconds.
    fn resolution(env: Env) -> u32;
}

/// Latest NAV for `asset` with no staleness check: `(price, decimals, timestamp)`.
///
/// For display and for paths that must never be blocked by an old price
/// (`repay`, `top_up`, DECISIONS.md #6).
///
/// Errors: `NoPrice` if the feed has no price for the asset or it is `<= 0`.
pub fn nav(env: &Env, cfg: &Config, asset: &AssetConfig) -> Result<(i128, u32, u64), Error> {
    let feed = PriceFeedClient::new(env, &cfg.oracle);
    let data = feed.lastprice(&asset.oracle_asset).ok_or(Error::NoPrice)?;
    if data.price <= 0 {
        return Err(Error::NoPrice);
    }
    Ok((data.price, feed.decimals(), data.timestamp))
}

/// Latest NAV for `asset` as `(price, decimals)`, rejecting old prices.
///
/// Used by `take_offer`, `check_margin` and `liquidate` (DECISIONS.md #6, #17).
///
/// - `StaleNav` if `now - timestamp > cfg.max_nav_age_secs`. A price exactly
///   `max_nav_age_secs` old is still fresh.
/// - A timestamp in the future (`timestamp > now`) is treated as age 0, i.e.
///   fresh. The feed is trusted; this only absorbs clock skew between the
///   feed's timestamp and the ledger close time.
/// - `NoPrice` if the feed has no price for the asset or it is `<= 0`.
pub fn fresh_nav(env: &Env, cfg: &Config, asset: &AssetConfig) -> Result<(i128, u32), Error> {
    let (price, decimals, timestamp) = nav(env, cfg, asset)?;
    let age = env.ledger().timestamp().saturating_sub(timestamp);
    if age > cfg.max_nav_age_secs {
        return Err(Error::StaleNav);
    }
    Ok((price, decimals))
}

/// Test-only SEP-40 mock with an admin-free `set_price`.
///
/// ```ignore
/// let oracle = oracle::mock::setup_mock_oracle(&env);
/// oracle::mock::MockOracleClient::new(&env, &oracle)
///     .set_price(&Asset::Stellar(token), &100_000_000_000_000, &env.ledger().timestamp());
/// // put `oracle` in Config.oracle, then call fresh_nav.
/// ```
#[cfg(test)]
pub mod mock {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

    use super::PriceData;
    use crate::types::Asset;

    /// Same as Reflector.
    pub const MOCK_DECIMALS: u32 = 14;
    /// 1.0 at `MOCK_DECIMALS`.
    pub const ONE: i128 = 100_000_000_000_000;

    #[contracttype]
    enum Key {
        Price(Asset),
    }

    #[contract]
    pub struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        pub fn set_price(env: Env, asset: Asset, price: i128, timestamp: u64) {
            env.storage()
                .instance()
                .set(&Key::Price(asset), &PriceData { price, timestamp });
        }

        pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
            env.storage().instance().get(&Key::Price(asset))
        }

        pub fn decimals(_env: Env) -> u32 {
            MOCK_DECIMALS
        }

        pub fn base(env: Env) -> Asset {
            Asset::Other(Symbol::new(&env, "USD"))
        }

        pub fn resolution(_env: Env) -> u32 {
            300
        }
    }

    /// Registers a fresh mock feed and returns its address (use as `Config.oracle`).
    pub fn setup_mock_oracle(env: &Env) -> Address {
        env.register(MockOracle, ())
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        Address, Env, Symbol,
    };

    use super::{
        fresh_nav,
        mock::{setup_mock_oracle, MockOracleClient, MOCK_DECIMALS, ONE},
        nav, PriceFeedClient,
    };
    use crate::{
        errors::Error,
        types::{Asset, AssetConfig, Config},
        CaravelRepo,
    };

    const NOW: u64 = 1_000_000;
    const MAX_AGE: u64 = 180;

    struct Setup {
        env: Env,
        repo: Address,
        cfg: Config,
        asset: AssetConfig,
        oracle: Address,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.ledger().set_timestamp(NOW);
        let oracle = setup_mock_oracle(&env);
        let cfg = Config {
            admin: Address::generate(&env),
            usdc: Address::generate(&env),
            oracle: oracle.clone(),
            treasury: Address::generate(&env),
            fee_bps: 1_000,
            liquidation_discount_bps: 200,
            day_secs: 60,
            margin_window_secs: 120,
            grace_secs: 60,
            max_nav_age_secs: MAX_AGE,
        };
        let repo = env.register(CaravelRepo, (cfg.clone(),));
        let asset = AssetConfig {
            oracle_asset: Asset::Stellar(Address::generate(&env)),
            haircut_bps: 300,
            enabled: true,
        };
        Setup {
            env,
            repo,
            cfg,
            asset,
            oracle,
        }
    }

    impl Setup {
        fn set_price(&self, price: i128, timestamp: u64) {
            MockOracleClient::new(&self.env, &self.oracle).set_price(
                &self.asset.oracle_asset,
                &price,
                &timestamp,
            );
        }

        fn fresh(&self) -> Result<(i128, u32), Error> {
            self.env
                .as_contract(&self.repo, || fresh_nav(&self.env, &self.cfg, &self.asset))
        }
    }

    #[test]
    fn mock_speaks_sep40() {
        let s = setup();
        s.set_price(ONE, NOW);
        let feed = PriceFeedClient::new(&s.env, &s.oracle);
        assert_eq!(feed.decimals(), MOCK_DECIMALS);
        assert_eq!(feed.resolution(), 300);
        assert_eq!(feed.base(), Asset::Other(Symbol::new(&s.env, "USD")));
        let data = feed.lastprice(&s.asset.oracle_asset).unwrap();
        assert_eq!((data.price, data.timestamp), (ONE, NOW));
    }

    #[test]
    fn fresh_price_ok() {
        let s = setup();
        s.set_price(ONE, NOW - 10);
        assert_eq!(s.fresh(), Ok((ONE, MOCK_DECIMALS)));
    }

    #[test]
    fn price_at_max_age_is_fresh() {
        let s = setup();
        s.set_price(ONE, NOW - MAX_AGE);
        assert_eq!(s.fresh(), Ok((ONE, MOCK_DECIMALS)));
    }

    #[test]
    fn price_past_max_age_is_stale() {
        let s = setup();
        s.set_price(ONE, NOW - MAX_AGE - 1);
        assert_eq!(s.fresh(), Err(Error::StaleNav));
    }

    #[test]
    fn price_goes_stale_as_time_passes() {
        let s = setup();
        s.set_price(ONE, NOW);
        assert!(s.fresh().is_ok());
        s.env.ledger().set_timestamp(NOW + MAX_AGE + 1);
        assert_eq!(s.fresh(), Err(Error::StaleNav));
    }

    #[test]
    fn future_timestamp_is_fresh() {
        let s = setup();
        s.set_price(ONE, NOW + 30);
        assert_eq!(s.fresh(), Ok((ONE, MOCK_DECIMALS)));
    }

    #[test]
    fn missing_price_is_no_price() {
        let s = setup();
        assert_eq!(s.fresh(), Err(Error::NoPrice));
    }

    #[test]
    fn non_positive_price_is_no_price() {
        let s = setup();
        s.set_price(0, NOW);
        assert_eq!(s.fresh(), Err(Error::NoPrice));
        s.set_price(-1, NOW);
        assert_eq!(s.fresh(), Err(Error::NoPrice));
    }

    #[test]
    fn nav_ignores_staleness() {
        let s = setup();
        s.set_price(ONE, NOW - MAX_AGE - 1_000);
        let got = s.env.as_contract(&s.repo, || nav(&s.env, &s.cfg, &s.asset));
        assert_eq!(got, Ok((ONE, MOCK_DECIMALS, NOW - MAX_AGE - 1_000)));
    }
}
