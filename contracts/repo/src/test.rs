extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Event as _, IntoVal,
};

use crate::{
    events,
    oracle::mock::{setup_mock_oracle, MockOracleClient, ONE},
    storage, Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Config, Error, Offer, Repo,
    Status,
};

pub(crate) const UNIT: i128 = 10_000_000; // 1.0 in 7-decimal units
/// Demo tBENJI staleness limit: 3 demo days at 60 s per day.
pub(crate) const DEMO_NAV_AGE: u64 = 180;
/// No exposure cap in play (#30); the cap tests set their own.
pub(crate) const NO_CAP: i128 = i128::MAX;

pub(crate) fn demo_config(env: &Env) -> Config {
    Config {
        admin: Address::generate(env),
        usdc: Address::generate(env),
        oracle: Address::generate(env),
        treasury: Address::generate(env),
        fee_bps: 1_000,
        liquidation_discount_bps: 200,
        day_secs: 60,
        margin_window_secs: 120,
        grace_secs: 60,
    }
}

fn setup(env: &Env) -> (CaravelRepoClient<'_>, Config) {
    let config = demo_config(env);
    let id = env.register(CaravelRepo, (config.clone(),));
    (CaravelRepoClient::new(env, &id), config)
}

#[test]
fn constructor_stores_config() {
    let env = Env::default();
    let (client, config) = setup(&env);
    assert_eq!(client.config(), config);
}

#[test]
fn constructor_rejects_invalid_config() {
    let env = Env::default();
    let mut config = demo_config(&env);
    config.liquidation_discount_bps = 10_000;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(CaravelRepo, (config,));
    }));
    assert!(result.is_err());
}

#[test]
fn missing_entries_are_errors() {
    let env = Env::default();
    let (client, _) = setup(&env);
    assert_eq!(client.try_offer(&1), Err(Ok(Error::OfferNotFound)));
    assert_eq!(client.try_repo(&1), Err(Ok(Error::RepoNotFound)));
    let asset = Address::generate(&env);
    assert_eq!(client.try_asset(&asset), Err(Ok(Error::AssetNotSupported)));
}

#[test]
fn admin_configures_assets() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _) = setup(&env);
    let token = Address::generate(&env);
    let mut config = AssetConfig {
        oracle_asset: Asset::Stellar(token.clone()),
        haircut_bps: 300,
        enabled: true,
        max_nav_age_secs: DEMO_NAV_AGE,
        max_open_debt: NO_CAP,
    };

    client.set_asset(&token, &config);
    let event = events::AssetConfigured {
        asset: token.clone(),
        haircut_bps: 300,
        enabled: true,
        max_nav_age_secs: DEMO_NAV_AGE,
        max_open_debt: NO_CAP,
    };
    assert_eq!(
        env.events().all().filter_by_contract(&client.address),
        [event.to_xdr(&env, &client.address)]
    );
    assert_eq!(client.asset(&token), config);

    // Re-tier in place.
    config.haircut_bps = 500;
    config.enabled = false;
    client.set_asset(&token, &config);
    assert_eq!(client.asset(&token), config);
}

#[test]
fn set_asset_requires_haircut_above_liquidation_discount() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, protocol) = setup(&env);
    let token = Address::generate(&env);
    for haircut_bps in [0, protocol.liquidation_discount_bps, 10_000, u32::MAX] {
        let config = AssetConfig {
            oracle_asset: Asset::Stellar(token.clone()),
            haircut_bps,
            enabled: true,
            max_nav_age_secs: DEMO_NAV_AGE,
            max_open_debt: NO_CAP,
        };
        assert_eq!(
            client.try_set_asset(&token, &config),
            Err(Ok(Error::InvalidConfig))
        );
    }
    assert_eq!(client.try_asset(&token), Err(Ok(Error::AssetNotSupported)));
}

#[test]
fn set_asset_rejects_zero_max_nav_age() {
    // DECISIONS.md #25: staleness is per asset and must be positive.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _) = setup(&env);
    let token = Address::generate(&env);
    let config = AssetConfig {
        oracle_asset: Asset::Stellar(token.clone()),
        haircut_bps: 300,
        enabled: true,
        max_nav_age_secs: 0,
        max_open_debt: NO_CAP,
    };
    assert_eq!(
        client.try_set_asset(&token, &config),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(client.try_asset(&token), Err(Ok(Error::AssetNotSupported)));
}

#[test]
#[should_panic]
fn set_asset_requires_admin_auth() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let token = Address::generate(&env);
    client.set_asset(
        &token,
        &AssetConfig {
            oracle_asset: Asset::Stellar(token.clone()),
            haircut_bps: 300,
            enabled: true,
            max_nav_age_secs: DEMO_NAV_AGE,
            max_open_debt: NO_CAP,
        },
    );
}

#[test]
fn admin_manages_liquidator_whitelist() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _) = setup(&env);
    let liquidator = Address::generate(&env);

    assert!(!client.is_liquidator(&liquidator));
    client.set_liquidator(&liquidator, &true);
    assert!(client.is_liquidator(&liquidator));
    client.set_liquidator(&liquidator, &false);
    assert!(!client.is_liquidator(&liquidator));
}

// --- offers ---------------------------------------------------------------

/// A deployed repo contract with real USDC and tBENJI SACs, a mock SEP-40
/// feed at NAV 1.00, tBENJI configured at a 3% haircut, a lender holding
/// 10_000 USDC, a borrower holding 2_000 tBENJI + 100 USDC for interest, and
/// a whitelisted liquidator holding 2_000 USDC.
struct World<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    tbenji: Address,
    tbenji_token: TokenClient<'a>,
    oracle: MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
    treasury: Address,
}

pub(crate) const NOW: u64 = 1_000;

fn world<'a>() -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let issuer = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let tbenji = env.register_stellar_asset_contract_v2(issuer).address();
    let oracle = MockOracleClient::new(&env, &setup_mock_oracle(&env));
    oracle.set_price(&Asset::Stellar(tbenji.clone()), &ONE, &NOW);

    let mut config = demo_config(&env);
    config.usdc = usdc.clone();
    config.oracle = oracle.address.clone();
    let treasury = config.treasury.clone();
    let id = env.register(CaravelRepo, (config,));
    let repo = CaravelRepoClient::new(&env, &id);
    repo.set_asset(
        &tbenji,
        &AssetConfig {
            oracle_asset: Asset::Stellar(tbenji.clone()),
            haircut_bps: 300,
            enabled: true,
            max_nav_age_secs: DEMO_NAV_AGE,
            max_open_debt: NO_CAP,
        },
    );

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    StellarAssetClient::new(&env, &usdc).mint(&lender, &(10_000 * UNIT));
    StellarAssetClient::new(&env, &usdc).mint(&borrower, &(100 * UNIT));
    StellarAssetClient::new(&env, &tbenji).mint(&borrower, &(2_000 * UNIT));
    let liquidator = Address::generate(&env);
    repo.set_liquidator(&liquidator, &true);
    StellarAssetClient::new(&env, &usdc).mint(&liquidator, &(2_000 * UNIT));

    World {
        usdc: TokenClient::new(&env, &usdc),
        tbenji_token: TokenClient::new(&env, &tbenji),
        repo,
        tbenji,
        oracle,
        lender,
        borrower,
        liquidator,
        treasury,
        env,
    }
}

impl World<'_> {
    fn set_nav(&self, price: i128, timestamp: u64) {
        self.set_nav_of(&self.tbenji, price, timestamp);
    }

    fn set_nav_of(&self, asset: &Address, price: i128, timestamp: u64) {
        self.oracle
            .set_price(&Asset::Stellar(asset.clone()), &price, &timestamp);
    }

    fn offer(&self) -> u64 {
        self.repo
            .create_offer(&self.lender, &self.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS)
    }

    fn take(&self) -> u64 {
        let offer_id = self.offer();
        self.repo.take_offer(&self.borrower, &offer_id, &false)
    }

    fn set_status(&self, repo_id: u64, status: Status) {
        self.env.as_contract(&self.repo.address, || {
            let mut repo = storage::read_repo(&self.env, repo_id).unwrap();
            repo.status = status;
            storage::write_repo(&self.env, &repo);
        });
    }

    /// Stands in for Misha's `check_margin` until margin.rs lands.
    fn margin_call(&self, repo_id: u64, deadline: u64) {
        self.env.as_contract(&self.repo.address, || {
            let mut repo = storage::read_repo(&self.env, repo_id).unwrap();
            repo.status = Status::MarginCall;
            repo.margin_call_deadline = Some(deadline);
            storage::write_repo(&self.env, &repo);
        });
    }

    fn set_time(&self, timestamp: u64) {
        self.env.ledger().set_timestamp(timestamp);
    }

    /// A repo taken at NOW, defaulted one second past maturity + grace.
    fn defaulted(&self) -> u64 {
        let repo_id = self.take();
        self.set_time(MATURED);
        self.repo.default(&repo_id);
        repo_id
    }
}

pub(crate) const PRINCIPAL: i128 = 970 * UNIT;
pub(crate) const APR_BPS: u32 = 500;
pub(crate) const TERM_SECS: u64 = 7 * 60; // 7 demo days

#[test]
fn create_offer_escrows_usdc() {
    let w = world();
    let id = w
        .repo
        .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
    assert_eq!(id, 1);

    // Event first: later calls in this test would replace it.
    let event = events::OfferCreated {
        offer_id: 1,
        lender: w.lender.clone(),
        collateral_asset: w.tbenji.clone(),
        principal: PRINCIPAL,
        apr_bps: APR_BPS,
        term_secs: TERM_SECS,
    };
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [event.to_xdr(&w.env, &w.repo.address)]
    );

    assert_eq!(w.usdc.balance(&w.lender), 10_000 * UNIT - PRINCIPAL);
    assert_eq!(w.usdc.balance(&w.repo.address), PRINCIPAL);
    assert_eq!(
        w.repo.offer(&1),
        Offer {
            id: 1,
            lender: w.lender.clone(),
            collateral_asset: w.tbenji.clone(),
            principal: PRINCIPAL,
            apr_bps: APR_BPS,
            term_secs: TERM_SECS,
            created_at: NOW,
        }
    );

    // Ids are sequential.
    let id = w
        .repo
        .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
    assert_eq!(id, 2);
    assert_eq!(w.usdc.balance(&w.repo.address), 2 * PRINCIPAL);
}

#[test]
fn create_offer_requires_lender_auth() {
    let w = world();
    w.repo
        .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
    assert_eq!(w.env.auths()[0].0, w.lender);
}

#[test]
fn create_offer_rejects_missing_or_disabled_asset() {
    let w = world();
    let unknown = Address::generate(&w.env);
    assert_eq!(
        w.repo
            .try_create_offer(&w.lender, &unknown, &PRINCIPAL, &APR_BPS, &TERM_SECS),
        Err(Ok(Error::AssetNotSupported))
    );

    w.repo.set_asset(
        &w.tbenji,
        &AssetConfig {
            oracle_asset: Asset::Stellar(w.tbenji.clone()),
            haircut_bps: 300,
            enabled: false,
            max_nav_age_secs: DEMO_NAV_AGE,
            max_open_debt: NO_CAP,
        },
    );
    assert_eq!(
        w.repo
            .try_create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS),
        Err(Ok(Error::AssetNotSupported))
    );
    assert_eq!(w.usdc.balance(&w.lender), 10_000 * UNIT);
}

#[test]
fn create_offer_rejects_bad_terms() {
    let w = world();
    for (principal, term) in [(0, TERM_SECS), (-1, TERM_SECS), (PRINCIPAL, 0)] {
        assert_eq!(
            w.repo
                .try_create_offer(&w.lender, &w.tbenji, &principal, &APR_BPS, &term),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(
        w.repo
            .try_create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &u32::MAX, &u64::MAX),
        Err(Ok(Error::MathOverflow))
    );
    assert_eq!(w.usdc.balance(&w.lender), 10_000 * UNIT);
}

#[test]
fn create_offer_fails_without_funds() {
    let w = world();
    let broke = Address::generate(&w.env);
    assert!(w
        .repo
        .try_create_offer(&broke, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS)
        .is_err());
    assert_eq!(w.repo.try_offer(&1), Err(Ok(Error::OfferNotFound)));
}

#[test]
fn cancel_offer_returns_escrow_to_lender() {
    let w = world();
    let id = w
        .repo
        .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
    w.repo.cancel_offer(&id);

    let event = events::OfferCancelled {
        offer_id: id,
        lender: w.lender.clone(),
        principal: PRINCIPAL,
    };
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [event.to_xdr(&w.env, &w.repo.address)]
    );
    assert_eq!(w.env.auths()[0].0, w.lender);

    assert_eq!(w.usdc.balance(&w.lender), 10_000 * UNIT);
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
    assert_eq!(w.repo.try_offer(&id), Err(Ok(Error::OfferNotFound)));

    // A cancelled offer cannot be cancelled again.
    assert_eq!(w.repo.try_cancel_offer(&id), Err(Ok(Error::OfferNotFound)));
}

#[test]
fn cancel_offer_leaves_other_offers_escrowed() {
    let w = world();
    let first = w
        .repo
        .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
    let second = w
        .repo
        .create_offer(&w.lender, &w.tbenji, &(100 * UNIT), &APR_BPS, &TERM_SECS);
    w.repo.cancel_offer(&first);
    assert_eq!(w.usdc.balance(&w.repo.address), 100 * UNIT);
    assert_eq!(w.repo.offer(&second).principal, 100 * UNIT);
}

#[test]
fn cancel_offer_requires_lender_auth() {
    let w = world();
    let id = w
        .repo
        .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);

    // Nobody signs: the lender's require_auth fails and the escrow stays put.
    w.env.set_auths(&[]);
    assert!(w.repo.try_cancel_offer(&id).is_err());
    assert_eq!(w.usdc.balance(&w.repo.address), PRINCIPAL);
    assert_eq!(w.repo.offer(&id).lender, w.lender);
}

#[test]
fn cancel_missing_offer_is_an_error() {
    let w = world();
    assert_eq!(w.repo.try_cancel_offer(&42), Err(Ok(Error::OfferNotFound)));
}

// --- take ---------------------------------------------------------------------

// The INTRO.md example, same numbers as the math tests: 970 USDC for 7 days at
// 5% APR against tBENJI at NAV 1.00 with a 3% haircut; fee = 10% of interest.
const INTEREST: i128 = 9_301_370;
const DEBT: i128 = PRINCIPAL + INTEREST;
const FEE: i128 = 930_137;
const LENDER_DUE: i128 = DEBT - FEE;
// DEBT / (1.00 × 0.97), rounded up.
const TAKE_COLLATERAL: i128 = 10_009_589_042;

fn opened_repo(w: &World) -> Repo {
    Repo {
        id: 1,
        offer_id: 1,
        lender: w.lender.clone(),
        borrower: w.borrower.clone(),
        collateral_asset: w.tbenji.clone(),
        collateral_amount: TAKE_COLLATERAL,
        principal: PRINCIPAL,
        interest: INTEREST,
        haircut_bps: 300,
        start_ts: NOW,
        maturity_ts: NOW + TERM_SECS,
        margin_call_deadline: None,
        status: Status::Open,
        auto_repay: false,
    }
}

#[test]
fn take_offer_is_atomic_dvp() {
    let w = world();
    let offer_id = w.offer();
    let repo_id = w.repo.take_offer(&w.borrower, &offer_id, &false);
    assert_eq!(repo_id, 1);

    let event = events::RepoOpened {
        repo_id,
        offer_id,
        lender: w.lender.clone(),
        borrower: w.borrower.clone(),
        collateral_asset: w.tbenji.clone(),
        collateral_amount: TAKE_COLLATERAL,
        principal: PRINCIPAL,
        interest: INTEREST,
        haircut_bps: 300,
        maturity_ts: NOW + TERM_SECS,
        auto_repay: false,
    };
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [event.to_xdr(&w.env, &w.repo.address)]
    );

    // Delivery: collateral into the contract. Payment: escrow to the borrower.
    assert_eq!(
        w.tbenji_token.balance(&w.borrower),
        2_000 * UNIT - TAKE_COLLATERAL
    );
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);
    assert_eq!(w.usdc.balance(&w.borrower), 100 * UNIT + PRINCIPAL);
    assert_eq!(w.usdc.balance(&w.repo.address), 0);

    assert_eq!(w.repo.repo(&repo_id), opened_repo(&w));
    assert_eq!(w.repo.try_offer(&offer_id), Err(Ok(Error::OfferNotFound)));
}

#[test]
fn take_offer_collateral_follows_nav() {
    let w = world();
    // NAV 1.0137 at 14 decimals: less collateral than at par, still the minimum.
    let nav = 101_370_000_000_000;
    w.set_nav(nav, NOW);
    let repo = w.repo.repo(&w.take());
    let need = crate::math::required_collateral(DEBT, nav, 14, 300).unwrap();
    assert_eq!(repo.collateral_amount, need);
    assert!(need < TAKE_COLLATERAL);
    assert!(crate::math::ltv_ok(DEBT, need, nav, 14, 300).unwrap());
    assert!(!crate::math::ltv_ok(DEBT, need - 1, nav, 14, 300).unwrap());
}

/// The borrower signs `take_offer` with the exact tBENJI transfer nested
/// inside it, so the wallet pins the collateral amount (#21).
fn take_with_signed_amount(w: &World, offer_id: u64, amount: i128) -> bool {
    let take_args = (w.borrower.clone(), offer_id, false).into_val(&w.env);
    let transfer_args = (w.borrower.clone(), w.repo.address.clone(), amount).into_val(&w.env);
    let transfer = MockAuthInvoke {
        contract: &w.tbenji,
        fn_name: "transfer",
        args: transfer_args,
        sub_invokes: &[],
    };
    w.env.mock_auths(&[MockAuth {
        address: &w.borrower,
        invoke: &MockAuthInvoke {
            contract: &w.repo.address,
            fn_name: "take_offer",
            args: take_args,
            sub_invokes: &[transfer],
        },
    }]);
    let ok = w
        .repo
        .try_take_offer(&w.borrower, &offer_id, &false)
        .is_ok();
    w.env.mock_all_auths();
    ok
}

#[test]
fn take_offer_signature_pins_collateral_amount() {
    let w = world();
    let offer_id = w.offer();

    // Simulated at NAV 1.00, NAV drops to 0.99 before submit: the contract now
    // wants more collateral than was signed, so the tx fails, nothing moves.
    w.set_nav(99 * ONE / 100, NOW);
    assert!(!take_with_signed_amount(&w, offer_id, TAKE_COLLATERAL));
    assert_eq!(w.tbenji_token.balance(&w.borrower), 2_000 * UNIT);
    assert_eq!(w.usdc.balance(&w.repo.address), PRINCIPAL);
    assert_eq!(w.repo.offer(&offer_id).id, offer_id);

    // Re-simulated at the new NAV: the exact amount goes through.
    let need = crate::math::required_collateral(DEBT, 99 * ONE / 100, 14, 300).unwrap();
    assert!(take_with_signed_amount(&w, offer_id, need));
    assert_eq!(w.tbenji_token.balance(&w.repo.address), need);
}

#[test]
fn take_offer_requires_borrower_auth() {
    let w = world();
    let offer_id = w.offer();
    w.env.set_auths(&[]);
    assert!(w
        .repo
        .try_take_offer(&w.borrower, &offer_id, &false)
        .is_err());
    assert_eq!(w.repo.offer(&offer_id).id, offer_id);
}

#[test]
fn take_offer_rejects_stale_nav() {
    let w = world();
    let offer_id = w.offer();

    // demo tBENJI max_nav_age_secs = 180
    w.set_nav(ONE, NOW - 181);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &false),
        Err(Ok(Error::StaleNav))
    );

    // Exactly at the limit is still fresh.
    w.set_nav(ONE, NOW - 180);
    assert_eq!(w.repo.take_offer(&w.borrower, &offer_id, &false), 1);
}

#[test]
fn take_offer_rejects_missing_price() {
    let w = world();
    let offer_id = w.offer();
    w.set_nav(0, NOW);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &false),
        Err(Ok(Error::NoPrice))
    );
}

#[test]
fn take_offer_rejects_asset_disabled_after_offer() {
    // DECISIONS.md #23
    let w = world();
    let offer_id = w.offer();
    w.repo.set_asset(
        &w.tbenji,
        &AssetConfig {
            oracle_asset: Asset::Stellar(w.tbenji.clone()),
            haircut_bps: 300,
            enabled: false,
            max_nav_age_secs: DEMO_NAV_AGE,
            max_open_debt: NO_CAP,
        },
    );
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &false),
        Err(Ok(Error::AssetNotSupported))
    );
    // The lender can still get out.
    w.repo.cancel_offer(&offer_id);
    assert_eq!(w.usdc.balance(&w.lender), 10_000 * UNIT);
}

#[test]
fn take_offer_fails_without_enough_collateral() {
    let w = world();
    let offer_id = w.offer();
    let poor = Address::generate(&w.env);
    StellarAssetClient::new(&w.env, &w.tbenji).mint(&poor, &(TAKE_COLLATERAL - 1));
    assert!(w.repo.try_take_offer(&poor, &offer_id, &false).is_err());
    assert_eq!(w.tbenji_token.balance(&poor), TAKE_COLLATERAL - 1);
    assert_eq!(w.usdc.balance(&w.repo.address), PRINCIPAL);
    assert_eq!(w.repo.try_repo(&1), Err(Ok(Error::RepoNotFound)));
}

#[test]
fn offer_can_be_taken_only_once() {
    let w = world();
    let offer_id = w.offer();
    w.repo.take_offer(&w.borrower, &offer_id, &false);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &false),
        Err(Ok(Error::OfferNotFound))
    );
    assert_eq!(
        w.repo.try_cancel_offer(&offer_id),
        Err(Ok(Error::OfferNotFound))
    );
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &99, &false),
        Err(Ok(Error::OfferNotFound))
    );
}

#[test]
fn retiering_asset_does_not_touch_live_repo() {
    // DECISIONS.md #19
    let w = world();
    let repo_id = w.take();
    w.repo.set_asset(
        &w.tbenji,
        &AssetConfig {
            oracle_asset: Asset::Stellar(w.tbenji.clone()),
            haircut_bps: 800,
            enabled: true,
            max_nav_age_secs: DEMO_NAV_AGE,
            max_open_debt: NO_CAP,
        },
    );
    assert_eq!(w.repo.repo(&repo_id), opened_repo(&w));
}

// --- repay --------------------------------------------------------------------

#[test]
fn repay_pays_lender_exact_offer_terms() {
    let w = world();
    let repo_id = w.take();
    w.repo.repay(&repo_id);

    let event = events::Repaid {
        repo_id,
        lender_amount: LENDER_DUE,
        fee: FEE,
        automatic: false,
    };
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [event.to_xdr(&w.env, &w.repo.address)]
    );

    // Lender: principal + interest − fee, exactly (#3).
    assert_eq!(
        w.usdc.balance(&w.lender),
        10_000 * UNIT - PRINCIPAL + LENDER_DUE
    );
    assert_eq!(w.usdc.balance(&w.treasury), FEE);
    // Borrower: paid the interest, has all collateral back.
    assert_eq!(w.usdc.balance(&w.borrower), 100 * UNIT - INTEREST);
    assert_eq!(w.tbenji_token.balance(&w.borrower), 2_000 * UNIT);
    // Contract holds nothing.
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);

    let mut repaid = opened_repo(&w);
    repaid.status = Status::Repaid;
    assert_eq!(w.repo.repo(&repo_id), repaid);
}

#[test]
fn repay_works_with_stale_or_missing_nav() {
    // DECISIONS.md #6: a borrower can always exit. NAV is long stale, then gone.
    let w = world();
    let repo_id = w.take();
    w.env.ledger().set_timestamp(NOW + 10_000);
    w.set_nav(0, NOW);
    w.repo.repay(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
}

#[test]
fn repay_works_after_maturity_until_defaulted() {
    let w = world();
    let repo_id = w.take();
    // Past maturity + grace, but nobody has called `default` yet.
    w.env.ledger().set_timestamp(NOW + TERM_SECS + 60 + 1);
    w.repo.repay(&repo_id);
    assert_eq!(w.usdc.balance(&w.treasury), FEE);
}

#[test]
fn repay_clears_a_margin_call() {
    let w = world();
    let repo_id = w.take();
    w.set_status(repo_id, Status::MarginCall);
    w.repo.repay(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
    assert_eq!(w.tbenji_token.balance(&w.borrower), 2_000 * UNIT);
}

#[test]
fn repay_only_from_open_or_margin_call() {
    let w = world();
    let repo_id = w.take();
    for status in [Status::Repaid, Status::Defaulted, Status::Liquidated] {
        w.set_status(repo_id, status);
        assert_eq!(w.repo.try_repay(&repo_id), Err(Ok(Error::InvalidStatus)));
    }
    assert_eq!(w.repo.try_repay(&99), Err(Ok(Error::RepoNotFound)));
}

#[test]
fn repay_twice_is_rejected() {
    let w = world();
    let repo_id = w.take();
    w.repo.repay(&repo_id);
    assert_eq!(w.repo.try_repay(&repo_id), Err(Ok(Error::InvalidStatus)));
}

#[test]
fn repay_requires_borrower_auth() {
    let w = world();
    let repo_id = w.take();
    w.env.set_auths(&[]);
    assert!(w.repo.try_repay(&repo_id).is_err());
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);
}

#[test]
fn repay_fails_without_enough_usdc() {
    let w = world();
    let repo_id = w.take();
    // Borrower spends the interest buffer elsewhere.
    w.usdc
        .transfer(&w.borrower, Address::generate(&w.env), &(100 * UNIT));
    assert!(w.repo.try_repay(&repo_id).is_err());
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);
}

// --- default ------------------------------------------------------------------

const GRACE_SECS: u64 = 60; // demo profile
/// First second at which an unpaid repo taken at NOW can be defaulted.
const MATURED: u64 = NOW + TERM_SECS + GRACE_SECS + 1;

#[test]
fn default_after_maturity_plus_grace() {
    let w = world();
    let repo_id = w.take();

    for t in [NOW + TERM_SECS, MATURED - 1] {
        w.set_time(t);
        assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::NotDefaultable)));
    }

    w.set_time(MATURED);
    w.env.set_auths(&[]); // anyone, no signature (#7)
    w.repo.default(&repo_id);
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [events::Defaulted { repo_id }.to_xdr(&w.env, &w.repo.address)]
    );
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
    // Collateral stays put until a liquidator buys it.
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);
}

#[test]
fn default_after_missed_margin_call() {
    let w = world();
    let repo_id = w.take();
    let deadline = NOW + 200; // well before maturity
    w.margin_call(repo_id, deadline);

    w.set_time(deadline);
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::NotDefaultable)));
    w.set_time(deadline + 1);
    w.repo.default(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
}

#[test]
fn cleared_margin_call_does_not_default() {
    // A top-up moved the repo back to Open; an old deadline must not count.
    let w = world();
    let repo_id = w.take();
    w.margin_call(repo_id, NOW + 200);
    w.set_status(repo_id, Status::Open);
    w.set_time(NOW + 300);
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::NotDefaultable)));
}

#[test]
fn default_needs_no_nav() {
    // DECISIONS.md #17
    let w = world();
    let repo_id = w.take();
    w.set_nav(0, NOW);
    w.set_time(MATURED);
    w.repo.default(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
}

#[test]
fn default_only_from_open_or_margin_call() {
    let w = world();
    let repo_id = w.take();
    w.set_time(MATURED);
    for status in [Status::Repaid, Status::Defaulted, Status::Liquidated] {
        w.set_status(repo_id, status);
        assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::InvalidStatus)));
    }
    assert_eq!(w.repo.try_default(&99), Err(Ok(Error::RepoNotFound)));
}

#[test]
fn defaulted_repo_cannot_be_repaid() {
    let w = world();
    let repo_id = w.defaulted();
    assert_eq!(w.repo.try_repay(&repo_id), Err(Ok(Error::InvalidStatus)));
}

// --- auto-repay (#27) ----------------------------------------------------------

impl World<'_> {
    fn take_auto(&self) -> u64 {
        let offer_id = self.offer();
        self.repo.take_offer(&self.borrower, &offer_id, &true)
    }

    fn allowance(&self) -> i128 {
        self.usdc.allowance(&self.borrower, &self.repo.address)
    }

    /// Balances after a repo taken at NOW was repaid, by hand or automatically.
    fn assert_repaid(&self, repo_id: u64) {
        assert_eq!(self.repo.repo(&repo_id).status, Status::Repaid);
        assert_eq!(
            self.usdc.balance(&self.lender),
            10_000 * UNIT - PRINCIPAL + LENDER_DUE
        );
        assert_eq!(self.usdc.balance(&self.treasury), FEE);
        assert_eq!(self.usdc.balance(&self.borrower), 100 * UNIT - INTEREST);
        assert_eq!(self.tbenji_token.balance(&self.borrower), 2_000 * UNIT);
        assert_eq!(self.usdc.balance(&self.repo.address), 0);
        assert_eq!(self.tbenji_token.balance(&self.repo.address), 0);
    }
}

#[test]
fn take_with_auto_repay_approves_the_debt() {
    let w = world();
    let repo_id = w.take_auto();
    let opened = events::RepoOpened {
        repo_id,
        offer_id: 1,
        lender: w.lender.clone(),
        borrower: w.borrower.clone(),
        collateral_asset: w.tbenji.clone(),
        collateral_amount: TAKE_COLLATERAL,
        principal: PRINCIPAL,
        interest: INTEREST,
        haircut_bps: 300,
        maturity_ts: NOW + TERM_SECS,
        auto_repay: true,
    };
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [opened.to_xdr(&w.env, &w.repo.address)]
    );
    assert!(w.repo.repo(&repo_id).auto_repay);
    assert_eq!(w.allowance(), DEBT);
}

#[test]
fn take_without_auto_repay_approves_nothing() {
    let w = world();
    let repo_id = w.take();
    assert!(!w.repo.repo(&repo_id).auto_repay);
    assert_eq!(w.allowance(), 0);
}

#[test]
fn auto_repay_at_maturity_returns_collateral() {
    let w = world();
    let repo_id = w.take_auto();

    w.set_time(NOW + TERM_SECS - 1);
    assert_eq!(w.repo.try_auto_repay(&repo_id), Err(Ok(Error::NotDue)));

    w.set_time(NOW + TERM_SECS);
    w.env.set_auths(&[]); // anyone, no signature: the keeper
    w.repo.auto_repay(&repo_id);
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [events::Repaid {
            repo_id,
            lender_amount: LENDER_DUE,
            fee: FEE,
            automatic: true,
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
    w.assert_repaid(repo_id);
    assert_eq!(w.allowance(), 0);
    assert_eq!(
        w.repo.try_auto_repay(&repo_id),
        Err(Ok(Error::InvalidStatus))
    );
}

#[test]
fn auto_repay_needs_opt_in() {
    let w = world();
    let repo_id = w.take();
    w.set_time(NOW + TERM_SECS);
    assert_eq!(
        w.repo.try_auto_repay(&repo_id),
        Err(Ok(Error::AutoRepayOff))
    );
    assert_eq!(w.repo.try_auto_repay(&99), Err(Ok(Error::RepoNotFound)));
}

#[test]
fn default_auto_repays_an_opted_in_borrower() {
    // Nobody called `auto_repay`; whoever calls `default` settles it instead.
    let w = world();
    let repo_id = w.take_auto();
    w.set_time(MATURED);
    w.env.set_auths(&[]);
    assert_eq!(w.repo.default(&repo_id), Status::Repaid);
    w.assert_repaid(repo_id);
}

#[test]
fn short_borrower_still_defaults() {
    let w = world();
    let repo_id = w.take_auto();
    // Spent the loan: one stroop short of the debt.
    let keep = DEBT - 1;
    let spend = w.usdc.balance(&w.borrower) - keep;
    w.usdc
        .transfer(&w.borrower, Address::generate(&w.env), &spend);

    w.set_time(NOW + TERM_SECS);
    assert_eq!(
        w.repo.try_auto_repay(&repo_id),
        Err(Ok(Error::AutoRepayFailed))
    );
    // Nothing moved; the borrower can still repay by hand during grace.
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);
    assert_eq!(w.usdc.balance(&w.borrower), keep);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);

    w.set_time(MATURED);
    assert_eq!(w.repo.default(&repo_id), Status::Defaulted);
    assert_eq!(w.usdc.balance(&w.borrower), keep);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);
}

#[test]
fn auto_repay_instead_of_missed_margin_call_default() {
    let w = world();
    let repo_id = w.take_auto();
    let deadline = NOW + 200; // well before maturity
    w.margin_call(repo_id, deadline);

    w.set_time(deadline);
    assert_eq!(w.repo.try_auto_repay(&repo_id), Err(Ok(Error::NotDue)));
    w.set_time(deadline + 1);
    w.repo.auto_repay(&repo_id);
    w.assert_repaid(repo_id);
}

#[test]
fn expired_allowance_falls_back_to_default() {
    let w = world();
    let repo_id = w.take_auto();
    // Keeper down for days: the allowance lapsed before anyone called default.
    w.env
        .ledger()
        .set_sequence_number(w.env.ledger().sequence() + 100_000);
    w.set_time(MATURED);
    assert_eq!(w.repo.default(&repo_id), Status::Defaulted);
}

#[test]
fn set_auto_repay_toggles_the_allowance() {
    let w = world();
    let repo_id = w.take();

    w.repo.set_auto_repay(&repo_id, &true);
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [events::AutoRepaySet {
            repo_id,
            enabled: true
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
    assert!(w.repo.repo(&repo_id).auto_repay);
    assert_eq!(w.allowance(), DEBT);
    w.repo.set_auto_repay(&repo_id, &true); // no-op, no double allowance
    assert_eq!(w.allowance(), DEBT);

    w.repo.set_auto_repay(&repo_id, &false);
    assert!(!w.repo.repo(&repo_id).auto_repay);
    assert_eq!(w.allowance(), 0);
}

#[test]
fn borrower_who_forgot_can_opt_in_during_grace() {
    let w = world();
    let repo_id = w.take();
    w.set_time(NOW + TERM_SECS + 30);
    w.repo.set_auto_repay(&repo_id, &true);
    w.repo.auto_repay(&repo_id);
    w.assert_repaid(repo_id);
}

#[test]
fn set_auto_repay_requires_borrower_auth() {
    let w = world();
    let repo_id = w.take();
    w.env.set_auths(&[]);
    assert!(w.repo.try_set_auto_repay(&repo_id, &true).is_err());
    assert!(!w.repo.repo(&repo_id).auto_repay);
}

#[test]
fn set_auto_repay_only_on_live_repos() {
    let w = world();
    let repo_id = w.take();
    for status in [Status::Repaid, Status::Defaulted, Status::Liquidated] {
        w.set_status(repo_id, status);
        assert_eq!(
            w.repo.try_set_auto_repay(&repo_id, &true),
            Err(Ok(Error::InvalidStatus))
        );
    }
}

#[test]
fn manual_repay_releases_the_allowance() {
    let w = world();
    let repo_id = w.take_auto();
    w.repo.repay(&repo_id);
    w.assert_repaid(repo_id);
    assert_eq!(w.allowance(), 0);
}

#[test]
fn one_allowance_covers_every_opted_in_repo() {
    let w = world();
    StellarAssetClient::new(&w.env, &w.tbenji).mint(&w.borrower, &(2_000 * UNIT));
    StellarAssetClient::new(&w.env, &w.usdc.address).mint(&w.lender, &(1_000 * UNIT));
    let first = w.take_auto();
    let second = w.take_auto();
    assert_eq!(w.allowance(), 2 * DEBT);

    w.set_time(NOW + TERM_SECS);
    w.repo.auto_repay(&first);
    assert_eq!(w.allowance(), DEBT);
    w.repo.auto_repay(&second);
    assert_eq!(w.allowance(), 0);
    assert_eq!(w.repo.repo(&second).status, Status::Repaid);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);
}

#[test]
fn allowance_expiry_is_stable_between_simulate_and_submit() {
    use crate::autorepay::expiry;
    let secs = TERM_SECS + GRACE_SECS;
    let max_ttl = 3_110_400; // ~180 days, the network cap
    let at = |seq| expiry(seq, secs, max_ttl);
    // A tx lands a few ledgers after it was simulated: same signed expiry.
    let seq = 1_000_000;
    assert!((seq..seq + 10).all(|s| at(s) == at(seq)));
    // Covers maturity + grace + a day, in whole buckets.
    assert!(at(seq) >= seq + (secs / 4) as u32 + 17_280);
    assert_eq!(at(seq) % 4_096, 0);
    // A year-long term is capped at what the network accepts.
    let long = expiry(seq, 365 * 86_400, max_ttl);
    assert!(long < seq + max_ttl);
}

// --- liquidate ----------------------------------------------------------------

/// Liquidates at `nav` (14 decimals) and checks every balance against the
/// expected split. Returns the repo contract's events from the call.
fn liquidate_at(
    w: &World,
    nav: i128,
    proceeds: i128,
    lender: i128,
    fee: i128,
    borrower: i128,
) -> std::vec::Vec<soroban_sdk::xdr::ContractEvent> {
    let repo_id = w.defaulted();
    w.set_nav(nav, MATURED);
    let lender_before = w.usdc.balance(&w.lender);
    let borrower_before = w.usdc.balance(&w.borrower);

    w.repo.liquidate(&w.liquidator, &repo_id);
    let events = w
        .env
        .events()
        .all()
        .filter_by_contract(&w.repo.address)
        .events()
        .to_vec();

    assert_eq!(lender + fee + borrower, proceeds);
    assert_eq!(w.usdc.balance(&w.liquidator), 2_000 * UNIT - proceeds);
    assert_eq!(w.usdc.balance(&w.lender), lender_before + lender);
    assert_eq!(w.usdc.balance(&w.treasury), fee);
    assert_eq!(w.usdc.balance(&w.borrower), borrower_before + borrower);
    assert_eq!(w.tbenji_token.balance(&w.liquidator), TAKE_COLLATERAL);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);

    assert_eq!(
        events[0],
        events::Liquidated {
            repo_id,
            liquidator: w.liquidator.clone(),
            proceeds,
            lender_amount: lender,
            fee,
            borrower_amount: borrower,
        }
        .to_xdr(&w.env, &w.repo.address)
    );
    events
}

/// Brief scenario 1: borrower misses maturity, NAV unchanged. Lender and
/// treasury paid in full, borrower gets the surplus.
#[test]
fn liquidate_with_surplus() {
    let w = world();
    let events = liquidate_at(&w, ONE, 9_809_397_262, LENDER_DUE, FEE, 100_095_892);
    assert_eq!(events.len(), 1);
}

/// Brief scenario 2: NAV falls past the trigger. Proceeds cover the lender's
/// terms but not the whole fee: lender exact, fee partly waived, no Shortfall.
#[test]
fn liquidate_lender_made_whole() {
    let w = world();
    let events = liquidate_at(
        &w,
        98_975_000_000_000,
        9_708_850_940,
        LENDER_DUE,
        479_707,
        0,
    );
    assert_eq!(events.len(), 1);
}

/// Brief scenario 3: NAV falls 2%, beyond the buffer. Lender takes all
/// proceeds, treasury and borrower nothing, Shortfall emitted (#4).
#[test]
fn liquidate_with_shortfall() {
    let w = world();
    let proceeds = 9_613_209_316;
    let events = liquidate_at(&w, 98 * ONE / 100, proceeds, proceeds, 0, 0);
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[1],
        events::Shortfall {
            repo_id: 1,
            amount: LENDER_DUE - proceeds,
        }
        .to_xdr(&w.env, &w.repo.address)
    );
}

#[test]
fn liquidate_requires_whitelist() {
    let w = world();
    let repo_id = w.defaulted();
    w.set_nav(ONE, MATURED);
    let outsider = Address::generate(&w.env);
    assert_eq!(
        w.repo.try_liquidate(&outsider, &repo_id),
        Err(Ok(Error::NotLiquidator))
    );
    w.repo.set_liquidator(&w.liquidator, &false);
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &repo_id),
        Err(Ok(Error::NotLiquidator))
    );
}

#[test]
fn liquidate_requires_liquidator_auth() {
    let w = world();
    let repo_id = w.defaulted();
    w.set_nav(ONE, MATURED);
    w.env.set_auths(&[]);
    assert!(w.repo.try_liquidate(&w.liquidator, &repo_id).is_err());
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
}

#[test]
fn liquidate_only_defaulted_repos() {
    let w = world();
    let repo_id = w.take();
    for status in [
        Status::Open,
        Status::MarginCall,
        Status::Repaid,
        Status::Liquidated,
    ] {
        w.set_status(repo_id, status);
        assert_eq!(
            w.repo.try_liquidate(&w.liquidator, &repo_id),
            Err(Ok(Error::InvalidStatus))
        );
    }
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &99),
        Err(Ok(Error::RepoNotFound))
    );
}

#[test]
fn liquidate_twice_is_rejected() {
    let w = world();
    let repo_id = w.defaulted();
    w.set_nav(ONE, MATURED);
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &repo_id),
        Err(Ok(Error::InvalidStatus))
    );
}

#[test]
fn liquidate_rejects_stale_nav() {
    // DECISIONS.md #6
    let w = world();
    let repo_id = w.defaulted();
    w.set_nav(ONE, MATURED - 181);
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &repo_id),
        Err(Ok(Error::StaleNav))
    );
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
}

#[test]
fn liquidate_works_on_disabled_asset() {
    // DECISIONS.md #22: disabling an asset stops new offers, not live repos.
    let w = world();
    let repo_id = w.defaulted();
    w.repo.set_asset(
        &w.tbenji,
        &AssetConfig {
            oracle_asset: Asset::Stellar(w.tbenji.clone()),
            haircut_bps: 300,
            enabled: false,
            max_nav_age_secs: DEMO_NAV_AGE,
            max_open_debt: NO_CAP,
        },
    );
    w.set_nav(ONE, MATURED);
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
}

#[test]
fn liquidate_fails_without_liquidator_funds() {
    let w = world();
    let repo_id = w.defaulted();
    w.set_nav(ONE, MATURED);
    w.usdc
        .transfer(&w.liquidator, Address::generate(&w.env), &(2_000 * UNIT));
    assert!(w.repo.try_liquidate(&w.liquidator, &repo_id).is_err());
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);
}

// --- margin -------------------------------------------------------------------

/// NAV 0.985: the repo opened at NAV 1.00 is past the trigger (#14), which
/// sits near NAV 0.98977 (debt / (collateral × 0.98)).
const BREACH_NAV: i128 = 985 * ONE / 1_000;
/// NAV 0.999: below the take NAV, still above the trigger.
const DIPPED_NAV: i128 = 999 * ONE / 1_000;
const MARGIN_WINDOW: u64 = 120; // demo profile

impl World<'_> {
    /// Takes a repo at NOW, drops NAV to BREACH_NAV and lets anyone call
    /// `check_margin`. Returns the repo id.
    fn breached(&self) -> u64 {
        let repo_id = self.take();
        self.set_nav(BREACH_NAV, NOW);
        assert_eq!(self.repo.check_margin(&repo_id), Status::MarginCall);
        repo_id
    }

    fn repo_events(&self) -> std::vec::Vec<soroban_sdk::xdr::ContractEvent> {
        self.env
            .events()
            .all()
            .filter_by_contract(&self.repo.address)
            .events()
            .to_vec()
    }
}

/// Collateral needed at `nav` for `debt ≤ value × (1 − bps)`.
fn need(nav: i128, bps: u32) -> i128 {
    crate::math::required_collateral(DEBT, nav, 14, bps).unwrap()
}

#[test]
fn check_margin_healthy_repo_stays_open() {
    let w = world();
    let repo_id = w.take();
    w.env.set_auths(&[]); // anyone (#7)
    for nav in [ONE, DIPPED_NAV] {
        w.set_nav(nav, NOW);
        assert_eq!(w.repo.check_margin(&repo_id), Status::Open);
        assert!(w.repo_events().is_empty());
    }
    assert_eq!(w.repo.repo(&repo_id), opened_repo(&w));
}

#[test]
fn check_margin_breach_sets_deadline_and_emits() {
    let w = world();
    let repo_id = w.take();
    w.set_nav(BREACH_NAV, NOW);
    w.set_time(NOW + 10);
    w.env.set_auths(&[]); // anyone (#7)
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);

    let deadline = NOW + 10 + MARGIN_WINDOW;
    assert_eq!(
        w.repo_events(),
        [events::MarginCall { repo_id, deadline }.to_xdr(&w.env, &w.repo.address)]
    );
    let mut called = opened_repo(&w);
    called.status = Status::MarginCall;
    called.margin_call_deadline = Some(deadline);
    assert_eq!(w.repo.repo(&repo_id), called);
}

#[test]
fn check_margin_does_not_call_twice() {
    let w = world();
    let repo_id = w.breached();
    let deadline = NOW + MARGIN_WINDOW;

    // Later and worse: same deadline, no second event.
    w.set_time(NOW + 60);
    w.set_nav(98 * ONE / 100, NOW + 60);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);
    assert!(w.repo_events().is_empty());
    assert_eq!(w.repo.repo(&repo_id).margin_call_deadline, Some(deadline));
}

#[test]
fn check_margin_does_not_clear_on_nav_recovery() {
    // DECISIONS.md #20: only a top-up to initial margin clears the call.
    let w = world();
    let repo_id = w.breached();
    w.set_nav(ONE, NOW);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);
    assert_eq!(
        w.repo.repo(&repo_id).margin_call_deadline,
        Some(NOW + MARGIN_WINDOW)
    );
}

#[test]
fn check_margin_rejects_stale_nav() {
    // DECISIONS.md #17: no margin call on an old price.
    let w = world();
    let repo_id = w.take();
    w.set_nav(BREACH_NAV, NOW - 181);
    assert_eq!(w.repo.try_check_margin(&repo_id), Err(Ok(Error::StaleNav)));
    assert_eq!(w.repo.repo(&repo_id), opened_repo(&w));

    // Exactly at the limit is still fresh.
    w.set_nav(BREACH_NAV, NOW - 180);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);

    // A called repo is blocked too, and keeps its deadline.
    w.set_time(NOW + 1);
    assert_eq!(w.repo.try_check_margin(&repo_id), Err(Ok(Error::StaleNav)));
    assert_eq!(
        w.repo.repo(&repo_id).margin_call_deadline,
        Some(NOW + MARGIN_WINDOW)
    );
}

#[test]
fn check_margin_rejects_missing_price() {
    let w = world();
    let repo_id = w.take();
    w.set_nav(0, NOW);
    assert_eq!(w.repo.try_check_margin(&repo_id), Err(Ok(Error::NoPrice)));
}

#[test]
fn check_margin_settled_repos_return_status() {
    // A keeper can poll any id; settled repos need no NAV.
    let w = world();
    let repo_id = w.take();
    w.set_nav(0, NOW);
    for status in [Status::Repaid, Status::Defaulted, Status::Liquidated] {
        w.set_status(repo_id, status);
        assert_eq!(w.repo.check_margin(&repo_id), status);
    }
    assert_eq!(w.repo.try_check_margin(&99), Err(Ok(Error::RepoNotFound)));
}

#[test]
fn missed_margin_call_defaults() {
    // check_margin's deadline is what Den's `default` reads.
    let w = world();
    let repo_id = w.breached();
    let deadline = NOW + MARGIN_WINDOW;
    w.set_time(deadline);
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::NotDefaultable)));
    w.set_time(deadline + 1);
    w.repo.default(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
    assert_eq!(
        w.repo.try_top_up(&repo_id, &UNIT),
        Err(Ok(Error::InvalidStatus))
    );
}

#[test]
fn top_up_partial_keeps_margin_call() {
    let w = world();
    let repo_id = w.breached();

    // Out of breach (liquidation discount) but below initial margin (haircut).
    let partial = need(BREACH_NAV, 200) - TAKE_COLLATERAL;
    w.repo.top_up(&repo_id, &partial);
    assert_eq!(
        w.repo_events(),
        [events::ToppedUp {
            repo_id,
            amount: partial,
            collateral_amount: TAKE_COLLATERAL + partial,
            cleared: false,
        }
        .to_xdr(&w.env, &w.repo.address)]
    );

    let repo = w.repo.repo(&repo_id);
    assert_eq!(repo.status, Status::MarginCall);
    assert_eq!(repo.margin_call_deadline, Some(NOW + MARGIN_WINDOW));
    assert_eq!(repo.collateral_amount, TAKE_COLLATERAL + partial);
    assert_eq!(
        w.tbenji_token.balance(&w.repo.address),
        TAKE_COLLATERAL + partial
    );
    assert_eq!(
        w.tbenji_token.balance(&w.borrower),
        2_000 * UNIT - TAKE_COLLATERAL - partial
    );
    // No longer breached, still not cleared (#20).
    assert!(
        !crate::math::margin_breached(DEBT, TAKE_COLLATERAL + partial, BREACH_NAV, 14, 200)
            .unwrap()
    );
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);

    // One unit short of initial margin: still called.
    let rest = need(BREACH_NAV, 300) - TAKE_COLLATERAL - partial;
    w.repo.top_up(&repo_id, &(rest - 1));
    assert_eq!(w.repo.repo(&repo_id).status, Status::MarginCall);
}

#[test]
fn top_up_to_initial_margin_clears_call() {
    let w = world();
    let repo_id = w.breached();
    let amount = need(BREACH_NAV, 300) - TAKE_COLLATERAL;
    w.repo.top_up(&repo_id, &amount);
    assert_eq!(
        w.repo_events(),
        [events::ToppedUp {
            repo_id,
            amount,
            collateral_amount: TAKE_COLLATERAL + amount,
            cleared: true,
        }
        .to_xdr(&w.env, &w.repo.address)]
    );

    let mut open = opened_repo(&w);
    open.collateral_amount = TAKE_COLLATERAL + amount;
    assert_eq!(w.repo.repo(&repo_id), open);

    // The old deadline no longer counts.
    w.set_time(NOW + MARGIN_WINDOW + 1);
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::NotDefaultable)));
}

#[test]
fn cleared_repo_can_be_called_again() {
    let w = world();
    let repo_id = w.breached();
    w.repo
        .top_up(&repo_id, &(need(BREACH_NAV, 300) - TAKE_COLLATERAL));

    // NAV keeps falling: a fresh call with a fresh deadline.
    w.set_time(NOW + 300);
    w.set_nav(95 * ONE / 100, NOW + 300);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);
    assert_eq!(
        w.repo.repo(&repo_id).margin_call_deadline,
        Some(NOW + 300 + MARGIN_WINDOW)
    );
}

#[test]
fn top_up_works_with_stale_nav() {
    // DECISIONS.md #6: the last known NAV decides the clear.
    let w = world();
    let repo_id = w.take();
    w.set_nav(BREACH_NAV, NOW - 100);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);

    w.set_time(NOW + 100); // NAV now 200 s old, deadline not yet passed
    assert_eq!(w.repo.try_check_margin(&repo_id), Err(Ok(Error::StaleNav)));
    w.repo
        .top_up(&repo_id, &(need(BREACH_NAV, 300) - TAKE_COLLATERAL));
    let repo = w.repo.repo(&repo_id);
    assert_eq!(repo.status, Status::Open);
    assert_eq!(repo.margin_call_deadline, None);
}

#[test]
fn top_up_without_price_adds_collateral_but_keeps_call() {
    let w = world();
    let repo_id = w.breached();
    w.set_nav(0, NOW);
    w.repo.top_up(&repo_id, &(100 * UNIT));
    let repo = w.repo.repo(&repo_id);
    assert_eq!(repo.status, Status::MarginCall);
    assert_eq!(repo.collateral_amount, TAKE_COLLATERAL + 100 * UNIT);
}

#[test]
fn top_up_after_deadline_until_defaulted() {
    // Like repay: the borrower can cure until someone calls `default`.
    let w = world();
    let repo_id = w.breached();
    w.set_time(NOW + MARGIN_WINDOW + 30);
    w.repo
        .top_up(&repo_id, &(need(BREACH_NAV, 300) - TAKE_COLLATERAL));
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::NotDefaultable)));
}

#[test]
fn top_up_open_repo_adds_collateral() {
    let w = world();
    let repo_id = w.take();
    w.repo.top_up(&repo_id, &UNIT);
    assert_eq!(w.env.auths()[0].0, w.borrower);
    let mut open = opened_repo(&w);
    open.collateral_amount = TAKE_COLLATERAL + UNIT;
    assert_eq!(w.repo.repo(&repo_id), open);
    assert_eq!(
        w.tbenji_token.balance(&w.repo.address),
        TAKE_COLLATERAL + UNIT
    );
}

#[test]
fn top_up_requires_borrower_auth() {
    let w = world();
    let repo_id = w.breached();
    w.env.set_auths(&[]);
    assert!(w
        .repo
        .try_top_up(&repo_id, &(need(BREACH_NAV, 300) - TAKE_COLLATERAL))
        .is_err());
    let repo = w.repo.repo(&repo_id);
    assert_eq!(repo.status, Status::MarginCall);
    assert_eq!(repo.collateral_amount, TAKE_COLLATERAL);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);
}

#[test]
fn top_up_fails_without_enough_collateral() {
    let w = world();
    let repo_id = w.take();
    let held = w.tbenji_token.balance(&w.borrower);
    assert!(w.repo.try_top_up(&repo_id, &(held + 1)).is_err());
    assert_eq!(w.repo.repo(&repo_id), opened_repo(&w));
}

#[test]
fn top_up_rejects_bad_amount_and_status() {
    let w = world();
    let repo_id = w.take();
    for amount in [0, -1] {
        assert_eq!(
            w.repo.try_top_up(&repo_id, &amount),
            Err(Ok(Error::InvalidAmount))
        );
    }
    for status in [Status::Repaid, Status::Defaulted, Status::Liquidated] {
        w.set_status(repo_id, status);
        assert_eq!(
            w.repo.try_top_up(&repo_id, &UNIT),
            Err(Ok(Error::InvalidStatus))
        );
    }
    assert_eq!(w.repo.try_top_up(&99, &UNIT), Err(Ok(Error::RepoNotFound)));
}

// --- per-asset NAV staleness (DECISIONS.md #25) ---------------------------------

/// Production intent for a fund that prints NAV on business days only: a
/// Friday print must still count on Monday, and through a holiday Monday to
/// Tuesday's print. 96 h = 345,600 s.
const WEEKEND_NAV_AGE: u64 = 96 * 3_600;
const HOUR: u64 = 3_600;

impl World<'_> {
    /// Registers a second collateral SAC with its own staleness limit, NAV
    /// 1.00 printed at `nav_ts`, and mints the borrower 3_000 of it.
    fn add_asset(&self, max_nav_age_secs: u64, nav_ts: u64) -> Address {
        let issuer = Address::generate(&self.env);
        let token = self
            .env
            .register_stellar_asset_contract_v2(issuer)
            .address();
        self.oracle
            .set_price(&Asset::Stellar(token.clone()), &ONE, &nav_ts);
        self.repo.set_asset(
            &token,
            &AssetConfig {
                oracle_asset: Asset::Stellar(token.clone()),
                haircut_bps: 300,
                enabled: true,
                max_nav_age_secs,
                max_open_debt: NO_CAP,
            },
        );
        StellarAssetClient::new(&self.env, &token).mint(&self.borrower, &(3_000 * UNIT));
        token
    }

    fn offer_on(&self, asset: &Address) -> u64 {
        self.repo
            .create_offer(&self.lender, asset, &PRINCIPAL, &APR_BPS, &TERM_SECS)
    }
}

#[test]
fn staleness_is_per_asset() {
    let w = world();
    // tBENJI: 180 s. A second fund: 96 h. Both priced at NOW.
    let fund = w.add_asset(WEEKEND_NAV_AGE, NOW);
    let benji_repo = w.take();
    let fund_repo = w.repo.take_offer(&w.borrower, &w.offer_on(&fund), &false);
    let benji_offer = w.offer();
    let fund_offer = w.offer_on(&fund);

    // Same ledger timestamp, same NAV age (181 s): stale for one, fresh for the other.
    w.set_time(NOW + DEMO_NAV_AGE + 1);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &benji_offer, &false),
        Err(Ok(Error::StaleNav))
    );
    assert_eq!(
        w.repo.try_check_margin(&benji_repo),
        Err(Ok(Error::StaleNav))
    );
    assert_eq!(w.repo.check_margin(&fund_repo), Status::Open);
    let taken = w.repo.take_offer(&w.borrower, &fund_offer, &false);
    assert_eq!(w.repo.repo(&taken).collateral_asset, fund);
    assert_eq!(w.repo.offer(&benji_offer).id, benji_offer);
}

#[test]
fn weekend_nav_within_96h_allows_take_and_margin_check() {
    let w = world();
    // Friday's print at NOW; no prints on Saturday or Sunday.
    let fund = w.add_asset(WEEKEND_NAV_AGE, NOW);
    let first = w.offer_on(&fund);
    let second = w.offer_on(&fund);

    // Monday: NAV is 72 h old, far older than a day, still within 96 h.
    w.set_time(NOW + 72 * HOUR);
    let repo_id = w.repo.take_offer(&w.borrower, &first, &false);
    assert_eq!(w.repo.repo(&repo_id).collateral_amount, TAKE_COLLATERAL);
    assert_eq!(w.repo.check_margin(&repo_id), Status::Open);

    // A Friday price that breaches still raises a margin call on Monday.
    w.set_nav_of(&fund, BREACH_NAV, NOW);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);

    // Exactly 96 h is still fresh; one second more is stale.
    w.set_time(NOW + WEEKEND_NAV_AGE);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);
    w.set_time(NOW + WEEKEND_NAV_AGE + 1);
    assert_eq!(w.repo.try_check_margin(&repo_id), Err(Ok(Error::StaleNav)));
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &second, &false),
        Err(Ok(Error::StaleNav))
    );
}

#[test]
fn stale_nav_blocks_take_margin_and_liquidate_but_never_repay_or_top_up() {
    // DECISIONS.md #6, #17, #25: no new risk on an old price; the borrower can
    // always exit or cure.
    let w = world();
    StellarAssetClient::new(&w.env, &w.tbenji).mint(&w.borrower, &(2_000 * UNIT));
    let topped = w.take();
    let repaid = w.take();
    let defaulted = w.take();
    let offer_id = w.offer();

    // The NAV printed at NOW is never updated. Past maturity + grace it is
    // long stale (> 180 s); `default` needs no NAV.
    w.set_time(MATURED);
    w.repo.default(&defaulted);

    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &false),
        Err(Ok(Error::StaleNav))
    );
    assert_eq!(w.repo.try_check_margin(&topped), Err(Ok(Error::StaleNav)));
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &defaulted),
        Err(Ok(Error::StaleNav))
    );
    // Nothing moved on the blocked calls.
    assert_eq!(w.repo.offer(&offer_id).id, offer_id);
    assert_eq!(w.repo.repo(&topped).status, Status::Open);
    assert_eq!(w.repo.repo(&defaulted).status, Status::Defaulted);

    w.repo.top_up(&topped, &UNIT);
    assert_eq!(
        w.repo.repo(&topped).collateral_amount,
        TAKE_COLLATERAL + UNIT
    );
    w.repo.repay(&repaid);
    assert_eq!(w.repo.repo(&repaid).status, Status::Repaid);
    w.repo.repay(&topped);
    assert_eq!(w.repo.repo(&topped).status, Status::Repaid);
    assert_eq!(
        w.tbenji_token.balance(&w.repo.address),
        TAKE_COLLATERAL // only the defaulted repo's collateral is left
    );
}

// --- exposure cap (#30) -------------------------------------------------------

impl World<'_> {
    /// Re-sets tBENJI at the world's terms with exposure cap `cap`.
    fn set_cap(&self, cap: i128) {
        self.repo.set_asset(
            &self.tbenji,
            &AssetConfig {
                oracle_asset: Asset::Stellar(self.tbenji.clone()),
                haircut_bps: 300,
                enabled: true,
                max_nav_age_secs: DEMO_NAV_AGE,
                max_open_debt: cap,
            },
        );
    }

    fn open_debt(&self) -> i128 {
        self.repo.open_debt(&self.tbenji)
    }
}

#[test]
fn cap_exactly_at_limit_passes_one_unit_over_fails() {
    let w = world();
    let offer_id = w.offer();

    // One stroop short: nothing moves and the offer stays on the board.
    w.set_cap(DEBT - 1);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &false),
        Err(Ok(Error::CapExceeded))
    );
    assert_eq!(w.repo.offer(&offer_id).id, offer_id);
    assert_eq!(w.open_debt(), 0);
    assert_eq!(w.usdc.balance(&w.borrower), 100 * UNIT);
    assert_eq!(w.tbenji_token.balance(&w.borrower), 2_000 * UNIT);

    // Exactly at the cap.
    w.set_cap(DEBT);
    let repo_id = w.repo.take_offer(&w.borrower, &offer_id, &false);
    assert_eq!(w.open_debt(), DEBT);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);

    // The cap is full: the next take is one whole debt over.
    StellarAssetClient::new(&w.env, &w.tbenji).mint(&w.borrower, &(2_000 * UNIT));
    let next = w.offer();
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &next, &false),
        Err(Ok(Error::CapExceeded))
    );
    w.set_cap(2 * DEBT);
    w.repo.take_offer(&w.borrower, &next, &false);
    assert_eq!(w.open_debt(), 2 * DEBT);
}

#[test]
fn zero_cap_allows_no_new_repos() {
    let w = world();
    w.set_cap(0);
    let offer_id = w.offer(); // lenders can still post
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &true),
        Err(Ok(Error::CapExceeded))
    );
    assert_eq!(w.open_debt(), 0);
    assert_eq!(w.allowance(), 0);
}

#[test]
fn set_asset_rejects_negative_cap() {
    let w = world();
    let config = AssetConfig {
        oracle_asset: Asset::Stellar(w.tbenji.clone()),
        haircut_bps: 300,
        enabled: true,
        max_nav_age_secs: DEMO_NAV_AGE,
        max_open_debt: -1,
    };
    assert_eq!(
        w.repo.try_set_asset(&w.tbenji, &config),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(w.repo.asset(&w.tbenji).max_open_debt, NO_CAP);
}

#[test]
fn open_debt_is_per_asset_and_survives_set_asset() {
    let w = world();
    let fund = w.add_asset(DEMO_NAV_AGE, NOW);
    w.set_cap(DEBT);
    w.take();
    // Re-tiering tBENJI does not reset its counter.
    w.set_cap(DEBT);
    assert_eq!(w.open_debt(), DEBT);
    // tBENJI is full; the other fund has its own cap and counter.
    let benji_offer = w.offer();
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &benji_offer, &false),
        Err(Ok(Error::CapExceeded))
    );
    w.repo.take_offer(&w.borrower, &w.offer_on(&fund), &false);
    assert_eq!(w.repo.open_debt(&fund), DEBT);
    assert_eq!(w.open_debt(), DEBT);
    assert_eq!(w.repo.open_debt(&Address::generate(&w.env)), 0);
}

#[test]
fn open_debt_is_released_on_every_exit_path() {
    let w = world();
    StellarAssetClient::new(&w.env, &w.tbenji).mint(&w.borrower, &(4_000 * UNIT));
    let repaid = w.take();
    let auto_repaid = w.take_auto();
    let settled_at_default = w.take_auto();
    let liquidated = w.take();
    let shortfall = w.take();
    assert_eq!(w.open_debt(), 5 * DEBT);

    w.repo.repay(&repaid);
    assert_eq!(w.open_debt(), 4 * DEBT);

    w.set_time(NOW + TERM_SECS);
    w.repo.auto_repay(&auto_repaid);
    assert_eq!(w.open_debt(), 3 * DEBT);

    // `default` settles an opted-in borrower by auto-repay.
    w.set_time(MATURED);
    assert_eq!(w.repo.default(&settled_at_default), Status::Repaid);
    assert_eq!(w.open_debt(), 2 * DEBT);

    // A defaulted repo is still exposure until it is liquidated.
    w.repo.default(&liquidated);
    w.repo.default(&shortfall);
    assert_eq!(w.open_debt(), 2 * DEBT);

    w.set_nav(ONE, MATURED);
    w.repo.liquidate(&w.liquidator, &liquidated);
    assert_eq!(w.open_debt(), DEBT);

    // Shortfall settlement frees the whole debt, not just the proceeds.
    w.set_nav(98 * ONE / 100, MATURED);
    w.repo.liquidate(&w.liquidator, &shortfall);
    let events = w.env.events().all().filter_by_contract(&w.repo.address);
    assert!(events.events().iter().any(|e| *e
        == events::Shortfall {
            repo_id: shortfall,
            amount: LENDER_DUE - 9_613_209_316,
        }
        .to_xdr(&w.env, &w.repo.address)));
    assert_eq!(w.open_debt(), 0);
}

#[test]
fn lowering_cap_below_open_debt_leaves_live_repos_alone() {
    let w = world();
    StellarAssetClient::new(&w.env, &w.tbenji).mint(&w.borrower, &(4_000 * UNIT));
    let topped = w.take();
    let repaid = w.take();
    let defaulted = w.take();
    let before = w.repo.repo(&topped);
    let offer_id = w.offer();

    // Cap cut to zero with 3 × DEBT open: no new repos ...
    w.set_cap(0);
    assert_eq!(w.open_debt(), 3 * DEBT);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &false),
        Err(Ok(Error::CapExceeded))
    );

    // ... but every live repo keeps its terms and every exit works.
    assert_eq!(w.repo.check_margin(&topped), Status::Open);
    w.repo.top_up(&topped, &UNIT);
    w.repo.set_auto_repay(&topped, &true);
    let mut expected = before.clone();
    expected.collateral_amount += UNIT;
    expected.auto_repay = true;
    assert_eq!(w.repo.repo(&topped), expected);
    w.repo.repay(&repaid);
    w.set_time(NOW + TERM_SECS);
    w.repo.auto_repay(&topped);
    w.set_time(MATURED);
    w.repo.default(&defaulted);
    w.set_nav(ONE, MATURED);
    w.repo.liquidate(&w.liquidator, &defaulted);
    assert_eq!(w.open_debt(), 0);

    // Headroom is back once the cap is raised again.
    w.set_cap(DEBT);
    w.repo.take_offer(&w.borrower, &offer_id, &false);
    assert_eq!(w.open_debt(), DEBT);
}
