#![cfg(test)]

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    IntoVal,
};

const DEC: u32 = 14;
const ONE: i128 = 100_000_000_000_000; // 1.0 at 14 decimals

struct Setup {
    env: Env,
    admin: Address,
    client: MockOracleClient<'static>,
    tbenji: Asset,
}

fn setup() -> Setup {
    setup_in(Env::default())
}

fn setup_in(env: Env) -> Setup {
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let id = env.register(
        MockOracle,
        (
            admin.clone(),
            Asset::Other(symbol_short!("USD")),
            DEC,
            300u32,
        ),
    );
    let client = MockOracleClient::new(&env, &id);
    let tbenji = Asset::Stellar(Address::generate(&env));
    Setup {
        env,
        admin,
        client,
        tbenji,
    }
}

#[test]
fn metadata() {
    let s = setup();
    assert_eq!(s.client.base(), Asset::Other(symbol_short!("USD")));
    assert_eq!(s.client.decimals(), DEC);
    assert_eq!(s.client.resolution(), 300);
    assert_eq!(s.client.admin(), s.admin);
    assert_eq!(s.client.assets().len(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn constructor_rejects_bad_decimals() {
    let env = Env::default();
    let admin = Address::generate(&env);
    env.register(
        MockOracle,
        (admin, Asset::Other(symbol_short!("USD")), 39u32, 300u32),
    );
}

#[test]
fn lastprice_none_before_set() {
    let s = setup();
    assert_eq!(s.client.lastprice(&s.tbenji), None);
    assert_eq!(s.client.prices(&s.tbenji, &5), None);
    assert_eq!(s.client.price(&s.tbenji, &u64::MAX), None);
}

#[test]
fn set_price_then_lastprice() {
    let s = setup();
    s.env.mock_all_auths();
    s.client.set_price(&s.tbenji, &ONE);
    // Admin auth was required.
    assert_eq!(s.env.auths()[0].0, s.admin);
    assert_eq!(
        s.client.lastprice(&s.tbenji),
        Some(PriceData {
            price: ONE,
            timestamp: 1_000
        })
    );
    assert_eq!(
        s.client.assets(),
        Vec::from_array(&s.env, [s.tbenji.clone()])
    );
}

#[test]
fn assets_listed_once_in_first_set_order() {
    let s = setup();
    s.env.mock_all_auths();
    let usdc = Asset::Other(symbol_short!("USDC"));
    s.client.set_price(&s.tbenji, &ONE);
    s.client.set_price(&usdc, &ONE);
    s.client.set_price(&s.tbenji, &(ONE + 1));
    assert_eq!(
        s.client.assets(),
        Vec::from_array(&s.env, [s.tbenji.clone(), usdc])
    );
}

#[test]
fn non_admin_set_price_fails() {
    let s = setup();
    let attacker = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &s.client.address,
            fn_name: "set_price",
            args: (s.tbenji.clone(), ONE).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.client.try_set_price(&s.tbenji, &ONE).is_err());
    assert_eq!(s.client.lastprice(&s.tbenji), None);
}

#[test]
fn no_auth_set_price_fails() {
    let s = setup();
    assert!(s.client.try_set_price(&s.tbenji, &ONE).is_err());
}

#[test]
fn rejects_non_positive_price() {
    let s = setup();
    s.env.mock_all_auths();
    assert_eq!(
        s.client.try_set_price(&s.tbenji, &0),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        s.client.try_set_price(&s.tbenji, &-1),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(s.client.assets().len(), 0);
}

#[test]
fn prices_newest_first_and_capped() {
    let s = setup();
    s.env.mock_all_auths();
    for i in 0..3u64 {
        s.env.ledger().set_timestamp(1_000 + i * 300);
        s.client.set_price(&s.tbenji, &(ONE + i as i128));
    }
    let all = s.client.prices(&s.tbenji, &10).unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all.get(0).unwrap().price, ONE + 2);
    assert_eq!(all.get(0).unwrap().timestamp, 1_600);
    assert_eq!(all.get(2).unwrap().price, ONE);
    let two = s.client.prices(&s.tbenji, &2).unwrap();
    assert_eq!(two.len(), 2);
    assert_eq!(two.get(1).unwrap().price, ONE + 1);
    assert_eq!(s.client.prices(&s.tbenji, &0), None);
}

#[test]
fn history_trimmed_to_max() {
    let s = setup();
    s.env.mock_all_auths();
    for i in 0..(MAX_HISTORY as u64 + 5) {
        s.env.ledger().set_timestamp(1_000 + i * 300);
        s.client.set_price(&s.tbenji, &(ONE + i as i128));
    }
    let all = s.client.prices(&s.tbenji, &100).unwrap();
    assert_eq!(all.len(), MAX_HISTORY);
    assert_eq!(all.get(0).unwrap().price, ONE + MAX_HISTORY as i128 + 4);
    assert_eq!(all.last().unwrap().price, ONE + 5);
}

#[test]
fn price_at_timestamp_lookup() {
    let s = setup();
    s.env.mock_all_auths();
    for (ts, price) in [(1_200, ONE), (1_500, ONE * 2), (1_800, ONE * 3)] {
        s.env.ledger().set_timestamp(ts);
        s.client.set_price(&s.tbenji, &price);
    }

    assert_eq!(s.client.price(&s.tbenji, &1_199), None);
    assert_eq!(s.client.price(&s.tbenji, &1_200).unwrap().price, ONE);
    assert_eq!(s.client.price(&s.tbenji, &1_499).unwrap().price, ONE);
    assert_eq!(s.client.price(&s.tbenji, &1_650).unwrap().price, ONE * 2);
    assert_eq!(
        s.client.price(&s.tbenji, &10_000),
        Some(PriceData {
            price: ONE * 3,
            timestamp: 1_800
        })
    );
}

/// A second push inside the newest record's resolution slot replaces that
/// record (price and timestamp); the older records stay.
#[test]
fn same_slot_push_replaces_only_the_newest_record() {
    let s = setup();
    s.env.mock_all_auths();
    s.env.ledger().set_timestamp(1_200); // slot 4
    s.client.set_price(&s.tbenji, &ONE);
    s.env.ledger().set_timestamp(1_500); // slot 5
    s.client.set_price(&s.tbenji, &(ONE * 2));
    s.env.ledger().set_timestamp(1_799); // still slot 5
    s.client.set_price(&s.tbenji, &(ONE * 3));

    let all = s.client.prices(&s.tbenji, &10).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(
        all.get(0).unwrap(),
        PriceData {
            price: ONE * 3,
            timestamp: 1_799
        }
    );
    assert_eq!(
        all.get(1).unwrap(),
        PriceData {
            price: ONE,
            timestamp: 1_200
        }
    );

    s.env.ledger().set_timestamp(1_800); // slot 6: appends
    s.client.set_price(&s.tbenji, &ONE);
    assert_eq!(s.client.prices(&s.tbenji, &10).unwrap().len(), 3);
}

/// nav-review side feed-rewrite: a feeder key posting every ledger (5 s)
/// adds one record per resolution slot, so replacing the whole 20-record
/// window takes more than 18 × resolution of ledger time.
#[test]
fn flooding_posts_add_one_record_per_slot() {
    // ~1,300 posts: skip the ledger snapshot (~1.6 MB).
    let s = setup_in(Env::new_with_config(
        soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        },
    ));
    s.env.mock_all_auths();
    s.env.ledger().set_timestamp(1_200);
    for _ in 0..MAX_HISTORY {
        s.client.set_price(&s.tbenji, &ONE);
        s.env
            .ledger()
            .set_timestamp(s.env.ledger().timestamp() + 300);
    }
    let start = s.env.ledger().timestamp();
    let mut posts = 0u64;
    loop {
        s.client.set_price(&s.tbenji, &(ONE / 2));
        posts += 1;
        let window = s.client.prices(&s.tbenji, &MAX_HISTORY).unwrap();
        if window.iter().all(|r| r.price == ONE / 2) {
            let span = window.get(0).unwrap().timestamp - window.last().unwrap().timestamp;
            assert!(span > u64::from(MAX_HISTORY - 2) * 300);
            break;
        }
        s.env.ledger().set_timestamp(s.env.ledger().timestamp() + 5);
    }
    // 20 slots: the one the flood starts in plus 19 more.
    let elapsed = s.env.ledger().timestamp() - start;
    assert_eq!(elapsed, u64::from(MAX_HISTORY - 1) * 300);
    assert_eq!(posts, elapsed / 5 + 1);
}

#[test]
fn stale_price_demo() {
    // The feed stops: lastprice keeps its old ledger timestamp, so the repo
    // contract's staleness check can reject it.
    let s = setup();
    s.env.mock_all_auths();
    s.env.ledger().set_timestamp(5_000);
    s.client.set_price(&s.tbenji, &ONE);
    s.env.ledger().set_timestamp(10_000);
    let p = s.client.lastprice(&s.tbenji).unwrap();
    assert_eq!(s.env.ledger().timestamp() - p.timestamp, 5_000);
}

#[test]
fn set_admin_hands_over_control() {
    let s = setup();
    s.env.mock_all_auths();
    let new_admin = Address::generate(&s.env);
    s.client.set_admin(&new_admin);
    assert_eq!(s.client.admin(), new_admin);
    s.client.set_price(&s.tbenji, &ONE);
    assert_eq!(s.env.auths()[0].0, new_admin);
}
