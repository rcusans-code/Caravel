//! Raven audit R12 / UA-07: the `production` cargo feature.
//!
//! The default build (testnet, the demo) keeps a 60 s timelock floor and a
//! 6-day instance TTL. `--features production` raises the floor to one day
//! and the instance TTL to 30 days, so a mainnet contract cannot be deployed
//! with the 120 s demo timelock.
//!
//! The rest of the suite runs on the demo profile (timelock 120 s), so run
//! the production tests alone:
//!   cargo test -p caravel-repo --features production production_
//! `cargo test --workspace` runs the default-build tests below.

extern crate std;

use soroban_sdk::{testutils::storage::Instance as _, Env};

use crate::{
    storage::PROD_INSTANCE_BUMP, test::demo_config, CaravelRepo, CaravelRepoClient, Config,
    MIN_TIMELOCK_SECS, PRODUCTION_MIN_TIMELOCK_SECS,
};

const DAY_LEDGERS: u32 = 17_280; // ~5 s per ledger, storage.rs DAY_IN_LEDGERS
const DAY_SECS: u64 = 86_400;

/// `true` when `__constructor` accepts `config`.
fn ctor_accepts(env: &Env, config: Config) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(CaravelRepo, (config,));
    }))
    .is_ok()
}

fn with_timelock(env: &Env, secs: u64) -> Config {
    let mut config = demo_config(env);
    config.timelock_secs = secs;
    config
}

/// Instance TTL right after a view call (views bump the instance).
fn instance_ttl_after_view(env: &Env, config: Config) -> u32 {
    let id = env.register(CaravelRepo, (config,));
    CaravelRepoClient::new(env, &id).config();
    env.as_contract(&id, || env.storage().instance().get_ttl())
}

/// Holds in every build: the production values themselves.
#[test]
fn production_profile_values() {
    assert!(PRODUCTION_MIN_TIMELOCK_SECS >= DAY_SECS);
    assert_eq!(PROD_INSTANCE_BUMP, 30 * DAY_LEDGERS);
}

/// Default build: the demo floor is unchanged (60 s), so testnet keeps its
/// 120 s timelock and `deploy.sh` defaults still construct.
#[cfg(not(feature = "production"))]
#[test]
fn production_feature_off_keeps_demo_floor() {
    let env = Env::default();
    env.mock_all_auths();
    assert_eq!(MIN_TIMELOCK_SECS, crate::DEMO_MIN_TIMELOCK_SECS);
    assert_eq!(MIN_TIMELOCK_SECS, 60);
    assert!(ctor_accepts(&env, with_timelock(&env, 60)));
    assert!(ctor_accepts(&env, with_timelock(&env, 120)));
    assert!(!ctor_accepts(&env, with_timelock(&env, 59)));
    assert_eq!(
        instance_ttl_after_view(&env, demo_config(&env)),
        6 * DAY_LEDGERS
    );
}

/// `--features production`: a demo timelock (120 s) or anything under one day
/// is `InvalidConfig`; the production 2 days constructs; the instance TTL is
/// 30 days.
#[cfg(feature = "production")]
#[test]
fn production_feature_on_requires_one_day_timelock() {
    let env = Env::default();
    env.mock_all_auths();
    assert_eq!(MIN_TIMELOCK_SECS, PRODUCTION_MIN_TIMELOCK_SECS);
    assert!(MIN_TIMELOCK_SECS >= DAY_SECS);
    assert!(!ctor_accepts(&env, with_timelock(&env, 120)));
    assert!(!ctor_accepts(&env, with_timelock(&env, DAY_SECS - 1)));
    assert!(ctor_accepts(&env, with_timelock(&env, DAY_SECS)));
    assert!(ctor_accepts(&env, with_timelock(&env, 2 * DAY_SECS)));
    assert_eq!(
        instance_ttl_after_view(&env, with_timelock(&env, 2 * DAY_SECS)),
        PROD_INSTANCE_BUMP
    );
}
