//! NAV client: reads collateral prices from a SEP-40 feed (DECISIONS.md #2, #22).
//!
//! Flows read NAV only through [`fresh_collateral_nav`] (or
//! [`banded_collateral_nav`] where staleness must not block, e.g. `top_up`,
//! DECISIONS.md #6), which also fold in the collateral token's decimals
//! (#28). Both apply the NAV sanity band (#31). Never call the oracle
//! directly from `lib.rs`.

use soroban_sdk::{contractclient, contracttype, token, Address, Env, Vec};

use crate::{
    errors::Error,
    math,
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

/// Oracle records the NAV sanity band reads back (`prices(asset, 20)`,
/// DECISIONS.md #31). Same depth as the mock oracle's history.
pub const NAV_BAND_RECORDS: u32 = 20;

/// The subset of the SEP-40 interface Caravel uses.
#[allow(dead_code)]
#[contractclient(name = "PriceFeedClient")]
pub trait PriceFeed {
    /// Latest price for `asset`, or `None` if the feed has none.
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
    /// Up to `records` most recent prices for `asset`, newest first.
    fn prices(env: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>>;
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

/// Largest clock skew [`fresh_nav`] accepts on a future price timestamp.
pub const MAX_FUTURE_SKEW_SECS: u64 = 60;

/// Latest NAV for `asset` as `(price, decimals)`, rejecting old and
/// implausible prices.
///
/// Used by `take_offer`, `check_margin` and `liquidate` (DECISIONS.md #6, #17).
///
/// - `StaleNav` if `now - timestamp > asset.max_nav_age_secs` (per asset,
///   DECISIONS.md #25). A price exactly `max_nav_age_secs` old is still fresh.
/// - A timestamp up to [`MAX_FUTURE_SKEW_SECS`] in the future is treated as
///   age 0, i.e. fresh: this absorbs clock skew between the feed's timestamp
///   and the ledger close time. Further ahead is `NoPrice`: a future-dated
///   price would otherwise stay "fresh" until long after it was posted.
/// - `NoPrice` if the feed has no price for the asset or it is `<= 0`.
/// - `NavOutOfBand` if the price fails [`check_band`] (DECISIONS.md #31).
pub fn fresh_nav(env: &Env, cfg: &Config, asset: &AssetConfig) -> Result<(i128, u32), Error> {
    let (price, decimals, timestamp) = nav(env, cfg, asset)?;
    let now = env.ledger().timestamp();
    if timestamp > now.saturating_add(MAX_FUTURE_SKEW_SECS) {
        return Err(Error::NoPrice);
    }
    let age = now.saturating_sub(timestamp);
    if age > asset.max_nav_age_secs {
        return Err(Error::StaleNav);
    }
    check_band(env, cfg, asset, price)?;
    Ok((price, decimals))
}

/// NAV sanity band (DECISIONS.md #31). `price` is the latest NAV in the
/// feed's own scale. `NavOutOfBand` if it is below `nav_floor`, above
/// `nav_ceiling`, or more than `max_nav_move_bps` away from any positive
/// record in the feed's last [`NAV_BAND_RECORDS`] (`prices`, newest first).
///
/// Every record in the window counts, not only the newest different one:
/// re-posts of a bad price (nav-keeper re-posts every 60 s) cannot push the
/// last good price out of view, and a second push next to a bad one cannot
/// pass by comparing against the first. A jump is accepted once every record
/// in the window is within the band of it, i.e. after the window has rolled
/// over, or at once if the admin widens the band with `set_asset`.
///
/// With a single record (no history) only `nav_floor` / `nav_ceiling` apply.
/// Records `<= 0` are skipped (no price, not a reference). Reads storage
/// only; writes nothing.
pub fn check_band(env: &Env, cfg: &Config, asset: &AssetConfig, price: i128) -> Result<(), Error> {
    if asset.nav_floor.is_some_and(|floor| price < floor)
        || asset.nav_ceiling.is_some_and(|ceiling| price > ceiling)
    {
        return Err(Error::NavOutOfBand);
    }
    let history = PriceFeedClient::new(env, &cfg.oracle)
        .prices(&asset.oracle_asset, &NAV_BAND_RECORDS)
        .unwrap_or_else(|| Vec::new(env));
    for record in history.iter() {
        if record.price > 0 && !within_bps(price, record.price, asset.max_nav_move_bps)? {
            return Err(Error::NavOutOfBand);
        }
    }
    Ok(())
}

/// `|price − reference| ≤ reference × max_bps / 10_000`, exact integer math.
fn within_bps(price: i128, reference: i128, max_bps: u32) -> Result<bool, Error> {
    let diff = price
        .checked_sub(reference)
        .and_then(i128::checked_abs)
        .ok_or(Error::MathOverflow)?;
    let lhs = diff.checked_mul(math::BPS).ok_or(Error::MathOverflow)?;
    let rhs = reference
        .checked_mul(max_bps as i128)
        .ok_or(Error::MathOverflow)?;
    Ok(lhs <= rhs)
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

/// [`nav`] for the collateral token `token`, scaled like
/// [`fresh_collateral_nav`], with the sanity band ([`check_band`]) but no
/// staleness check. For `top_up`'s clear decision: an old price may clear a
/// margin call (#6), an implausible one may not (#31).
pub fn banded_collateral_nav(
    env: &Env,
    cfg: &Config,
    token: &Address,
    asset: &AssetConfig,
) -> Result<(i128, u32), Error> {
    let (price, decimals, _) = nav(env, cfg, asset)?;
    check_band(env, cfg, asset, price)?;
    scale_for_token(price, decimals, token::Client::new(env, token).decimals())
}

/// Test-only SEP-40 mock with an admin-free `set_price`.
///
/// Keeps the last [`super::NAV_BAND_RECORDS`] records per asset in write
/// order (`lastprice` = the last write, `prices` = newest write first). A
/// write with the same timestamp as the newest record replaces it, like the
/// real mock oracle (`contracts/oracle`).
///
/// ```ignore
/// let oracle = oracle::mock::setup_mock_oracle(&env);
/// oracle::mock::MockOracleClient::new(&env, &oracle)
///     .set_price(&Asset::Stellar(token), &100_000_000_000_000, &env.ledger().timestamp());
/// // put `oracle` in Config.oracle, then call fresh_nav.
/// ```
#[cfg(test)]
pub mod mock {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, Vec};

    use super::{PriceData, NAV_BAND_RECORDS};
    use crate::types::Asset;

    /// Same as Reflector.
    pub const MOCK_DECIMALS: u32 = 14;
    /// 1.0 at `MOCK_DECIMALS`.
    pub const ONE: i128 = 100_000_000_000_000;

    #[contracttype]
    enum Key {
        /// Oldest first.
        History(Asset),
    }

    #[contract]
    pub struct MockOracle;

    fn history(env: &Env, asset: &Asset) -> Vec<PriceData> {
        env.storage()
            .instance()
            .get(&Key::History(asset.clone()))
            .unwrap_or_else(|| Vec::new(env))
    }

    #[contractimpl]
    impl MockOracle {
        pub fn set_price(env: Env, asset: Asset, price: i128, timestamp: u64) {
            let mut history = history(&env, &asset);
            if history.last().is_some_and(|r| r.timestamp == timestamp) {
                history.pop_back();
            }
            history.push_back(PriceData { price, timestamp });
            while history.len() > NAV_BAND_RECORDS {
                history.pop_front();
            }
            env.storage().instance().set(&Key::History(asset), &history);
        }

        pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
            history(&env, &asset).last()
        }

        pub fn prices(env: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
            let history = history(&env, &asset);
            if history.is_empty() || records == 0 {
                return None;
            }
            let mut out = Vec::new(&env);
            for record in history.iter().rev().take(records as usize) {
                out.push_back(record);
            }
            Some(out)
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
        test::{NO_CAP, TRIGGER_BPS},
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
            guardian: Address::generate(&env),
            timelock_secs: 120,
        };
        let repo = env.register(CaravelRepo, (cfg.clone(),));
        let asset = AssetConfig {
            oracle_asset: Asset::Stellar(Address::generate(&env)),
            haircut_bps: 300,
            margin_trigger_bps: TRIGGER_BPS,
            enabled: true,
            max_nav_age_secs: MAX_AGE,
            max_nav_move_bps: crate::test::WIDE_BAND_BPS,
            nav_floor: None,
            nav_ceiling: None,
            max_open_debt: NO_CAP,
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

    // --- NAV sanity band (DECISIONS.md #31) ------------------------------------

    /// 0.5% of NAV 1.00: exactly a 50 bps move.
    const FIFTY_BPS: i128 = ONE / 200;

    fn banded(max_nav_move_bps: u32) -> Setup {
        let mut s = setup();
        s.asset.max_nav_move_bps = max_nav_move_bps;
        s
    }

    #[test]
    fn band_edge_is_inclusive() {
        let s = banded(50);
        s.set_price(ONE, NOW - 60);
        s.set_price(ONE + FIFTY_BPS, NOW);
        assert_eq!(s.fresh(), Ok((ONE + FIFTY_BPS, MOCK_DECIMALS)));

        let s = banded(50);
        s.set_price(ONE, NOW - 60);
        s.set_price(ONE + FIFTY_BPS + 1, NOW);
        assert_eq!(s.fresh(), Err(Error::NavOutOfBand));

        let s = banded(50);
        s.set_price(ONE, NOW - 60);
        s.set_price(ONE - FIFTY_BPS - 1, NOW);
        assert_eq!(s.fresh(), Err(Error::NavOutOfBand));
    }

    #[test]
    fn band_checks_every_record_in_the_window() {
        // Two pushes of 0.4% each: each is within 50 bps of the one before,
        // but the second is 0.8% from the first record still in the window.
        let s = banded(50);
        s.set_price(ONE, NOW - 120);
        s.set_price(ONE + ONE * 4 / 1_000, NOW - 60);
        s.set_price(ONE + ONE * 8 / 1_000, NOW);
        assert_eq!(s.fresh(), Err(Error::NavOutOfBand));
    }

    #[test]
    fn band_skips_non_positive_records() {
        let s = banded(50);
        s.set_price(0, NOW - 60);
        s.set_price(ONE, NOW);
        assert_eq!(s.fresh(), Ok((ONE, MOCK_DECIMALS)));
    }

    #[test]
    fn band_floor_and_ceiling_are_inclusive() {
        let mut s = banded(50);
        s.set_price(ONE, NOW);
        s.asset.nav_floor = Some(ONE);
        s.asset.nav_ceiling = Some(ONE);
        assert_eq!(s.fresh(), Ok((ONE, MOCK_DECIMALS)));
        s.asset.nav_floor = Some(ONE + 1);
        assert_eq!(s.fresh(), Err(Error::NavOutOfBand));
        s.asset.nav_floor = None;
        s.asset.nav_ceiling = Some(ONE - 1);
        assert_eq!(s.fresh(), Err(Error::NavOutOfBand));
    }

    #[test]
    fn staleness_is_checked_before_the_band() {
        let s = banded(50);
        s.set_price(ONE, NOW - MAX_AGE - 61);
        s.set_price(ONE / 2, NOW - MAX_AGE - 1);
        assert_eq!(s.fresh(), Err(Error::StaleNav));
    }

    /// The flash-crash QA case (issue #26 comment) on the real mock oracle
    /// (`contracts/oracle`), not the test mock: a bad push re-posted once by
    /// nav-keeper fills both of the two newest records, so a
    /// `prices(asset, 2)` check would pass it. The band still sees the good
    /// record behind them.
    #[test]
    fn nav_keeper_reposts_cannot_hide_a_jump_on_the_real_oracle() {
        let mut s = banded(50);
        s.env.mock_all_auths();
        let oracle = s.env.register(
            caravel_oracle::MockOracle,
            (
                Address::generate(&s.env),
                caravel_oracle::Asset::Other(Symbol::new(&s.env, "USD")),
                MOCK_DECIMALS,
                300u32,
            ),
        );
        let feed = caravel_oracle::MockOracleClient::new(&s.env, &oracle);
        let token = Address::generate(&s.env);
        s.asset.oracle_asset = Asset::Stellar(token.clone());
        s.cfg.oracle = oracle;
        let real_asset = caravel_oracle::Asset::Stellar(token);

        for (ts, price) in [(1_005, ONE), (1_065, ONE / 2), (1_125, ONE / 2)] {
            s.env.ledger().set_timestamp(ts);
            feed.set_price(&real_asset, &price);
        }
        s.env.ledger().set_timestamp(1_130);

        let two = feed.prices(&real_asset, &2).unwrap();
        assert_eq!(
            (two.get_unchecked(0).price, two.get_unchecked(0).timestamp),
            (ONE / 2, 1_125)
        );
        assert_eq!(
            (two.get_unchecked(1).price, two.get_unchecked(1).timestamp),
            (ONE / 2, 1_065)
        );
        assert_eq!(s.fresh(), Err(Error::NavOutOfBand));
    }
}
