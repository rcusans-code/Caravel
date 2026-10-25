extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Event as _,
};

use crate::{events, Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Config, Error, Offer};

const UNIT: i128 = 10_000_000; // 1.0 in 7-decimal units

fn demo_config(env: &Env) -> Config {
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
        max_nav_age_secs: 180,
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
    };

    client.set_asset(&token, &config);
    assert_eq!(env.events().all().events().len(), 1);
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
        };
        assert_eq!(
            client.try_set_asset(&token, &config),
            Err(Ok(Error::InvalidConfig))
        );
    }
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

#[test]
fn flows_are_stubbed() {
    let env = Env::default();
    let (client, _) = setup(&env);
    assert_eq!(client.try_repay(&1), Err(Ok(Error::NotImplemented)));
    assert_eq!(client.try_check_margin(&1), Err(Ok(Error::NotImplemented)));
    assert_eq!(
        client.try_take_offer(&Address::generate(&env), &1),
        Err(Ok(Error::NotImplemented))
    );
}

// --- offers ---------------------------------------------------------------

/// A deployed repo contract with a real USDC SAC, tBENJI configured at a 3%
/// haircut, and a lender holding 10_000 USDC.
struct World<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    tbenji: Address,
    lender: Address,
}

fn world<'a>() -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let issuer = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let tbenji = env.register_stellar_asset_contract_v2(issuer).address();

    let mut config = demo_config(&env);
    config.usdc = usdc.clone();
    let id = env.register(CaravelRepo, (config,));
    let repo = CaravelRepoClient::new(&env, &id);
    repo.set_asset(
        &tbenji,
        &AssetConfig {
            oracle_asset: Asset::Stellar(tbenji.clone()),
            haircut_bps: 300,
            enabled: true,
        },
    );

    let lender = Address::generate(&env);
    StellarAssetClient::new(&env, &usdc).mint(&lender, &(10_000 * UNIT));

    World {
        usdc: TokenClient::new(&env, &usdc),
        repo,
        tbenji,
        lender,
        env,
    }
}

const PRINCIPAL: i128 = 970 * UNIT;
const APR_BPS: u32 = 500;
const TERM_SECS: u64 = 7 * 60; // 7 demo days

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
            created_at: 1_000,
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
