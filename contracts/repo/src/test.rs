extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::{CaravelRepo, CaravelRepoClient, Config, Error};

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
}
