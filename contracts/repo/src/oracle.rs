//! NAV client: reads collateral prices from a SEP-40 feed (DECISIONS.md #2, #22).
//!
//! Flows read NAV only through [`fresh_collateral_nav`] (or [`collateral_nav`]
//! where staleness must not block, e.g. `top_up`, DECISIONS.md #6), which also
//! fold in the collateral token's decimals (#28). Never call the oracle
//! directly from `lib.rs`.

use soroban_sdk::{contractclient, contracttype, token, Address, Env};

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
/// - `StaleNav` if `now - timestamp > asset.max_nav_age_secs` (per asset,
///   DECISIONS.md #25). A price exactly `max_nav_age_secs` old is still fresh.
/// - A timestamp in the future (`timestamp > now`) is treated as age 0, i.e.
///   fresh. The feed is trusted; this only absorbs clock skew between the
///   feed's timestamp and the ledger close time.
/// - `NoPrice` if the feed has no price for the asset or it is `<= 0`.
pub fn fresh_nav(env: &Env, cfg: &Config, asset: &AssetConfig) -> Result<(i128, u32), Error> {
    let (price, decimals, timestamp) = nav(env, cfg, asset)?;
    let age = env.ledger().timestamp().saturating_sub(timestamp);
    if age > asset.max_nav_age_secs {
        return Err(Error::StaleNav);
    }
    Ok((price, decimals))
}

/// Decimals of every USDC amount and collateral value in `math.rs`.
pub const VALUE_DECIMALS: u32 = 7;

/// Folds the collateral token's own `decimals()` into the NAV scale
/// (DECISIONS.md #28). `math.rs` computes `value = amount × nav / 10^dec`
/// in 7-decimal USDC; with `amount` in token units that holds when
/// `dec = nav_decimals + token_decimals − 7`. A 7-decimal token (any SAC,
/// tBENJI) is unchanged; a 5-decimal Spiko token gets `dec − 2`. Below zero
/// the NAV itself is scaled up instead.
pub fn scale_for_token(
    nav: i128,
    nav_decimals: u32,
    token_decimals: u32,
) -> Result<(i128, u32), Error> {
    let total = nav_decimals
        .checked_add(token_decimals)
        .ok_or(Error::MathOverflow)?;
    if total >= VALUE_DECIMALS {
        return Ok((nav, total - VALUE_DECIMALS));
    }
    let up = 10i128
        .checked_pow(VALUE_DECIMALS - total)
        .ok_or(Error::MathOverflow)?;
    Ok((nav.checked_mul(up).ok_or(Error::MathOverflow)?, 0))
}

/// [`fresh_nav`] for the collateral token `token`, scaled so `math.rs` reads
/// amounts in the token's own units. Flows use this, never `fresh_nav`.
pub fn fresh_collateral_nav(
    env: &Env,
    cfg: &Config,
    token: &Address,
    asset: &AssetConfig,
) -> Result<(i128, u32), Error> {
    let (price, decimals) = fresh_nav(env, cfg, asset)?;
    scale_for_token(price, decimals, token::Client::new(env, token).decimals())
}

/// [`nav`] (no staleness check) for the collateral token `token`, scaled
/// like [`fresh_collateral_nav`]: `(price, decimals, timestamp)`.
pub fn collateral_nav(
    env: &Env,
    cfg: &Config,
    token: &Address,
    asset: &AssetConfig,
) -> Result<(i128, u32, u64), Error> {
    let (price, decimals, timestamp) = nav(env, cfg, asset)?;
    let (price, decimals) =
        scale_for_token(price, decimals, token::Client::new(env, token).decimals())?;
    Ok((price, decimals, timestamp))
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
        nav, scale_for_token, PriceFeedClient,
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
        };
        let repo = env.register(CaravelRepo, (cfg.clone(),));
        let asset = AssetConfig {
            oracle_asset: Asset::Stellar(Address::generate(&env)),
            haircut_bps: 300,
            enabled: true,
            max_nav_age_secs: MAX_AGE,
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

    #[test]
    fn token_decimals_fold_into_nav_scale() {
        // 7-decimal token (SAC, tBENJI): unchanged.
        assert_eq!(scale_for_token(ONE, 14, 7), Ok((ONE, 14)));
        // 5-decimal Spiko token: two fewer decimals of NAV scale.
        assert_eq!(scale_for_token(ONE, 14, 5), Ok((ONE, 12)));
        // 7-decimal feed, 0-decimal token: NAV scaled up instead.
        assert_eq!(scale_for_token(10_000_000, 7, 0), Ok((10_000_000, 0)));
        assert_eq!(scale_for_token(100, 2, 0), Ok((10_000_000, 0)));
        assert_eq!(scale_for_token(i128::MAX, 0, 0), Err(Error::MathOverflow));
        assert_eq!(scale_for_token(ONE, u32::MAX, 1), Err(Error::MathOverflow));
    }
}
