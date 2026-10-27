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
    // The current admin signed the handover (checked right after the call).
    assert_eq!(s.env.auths()[0].0, s.admin);
    // Two-step (Raven R6, UA-06): nothing moves until the new admin accepts.
    assert_eq!(s.client.admin(), s.admin);
    assert_eq!(s.client.pending_admin(), Some(new_admin.clone()));
    s.client.accept_admin();
    assert_eq!(s.env.auths()[0].0, new_admin);
    assert_eq!(s.client.admin(), new_admin);
    assert_eq!(s.client.pending_admin(), None);
    s.client.set_price(&s.tbenji, &ONE);
    assert_eq!(s.env.auths()[0].0, new_admin);
}

/// Raven audit CT-01: deleting `set_admin`'s `require_auth` used to leave
/// every oracle test green. Without the current admin's signature the
/// handover is refused, even when the would-be admin signs.
#[test]
fn audit_set_admin_requires_current_admin_auth() {
    let s = setup();
    let thief = Address::generate(&s.env);
    // Nobody signs: refused.
    assert!(s.client.try_set_admin(&thief).is_err());
    // Only the would-be admin signs: refused.
    s.env.mock_auths(&[MockAuth {
        address: &thief,
        invoke: &MockAuthInvoke {
            contract: &s.client.address,
            fn_name: "set_admin",
            args: (&thief,).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.client.try_set_admin(&thief).is_err());
    assert_eq!(s.client.admin(), s.admin);
}

// --- Raven R6 (UA-06): two-step admin handover, admin and price events -------

#[test]
fn r6_set_admin_is_two_step_and_only_the_named_admin_accepts() {
    let s = setup();
    s.env.mock_all_auths();
    // Nothing pending: accept fails.
    assert_eq!(s.client.try_accept_admin(), Err(Ok(Error::NoPendingAdmin)));
    let typo = Address::generate(&s.env);
    s.client.set_admin(&typo);
    // A mistyped handover is harmless: the old admin still prices and can
    // name the right successor, which replaces the typo.
    s.client.set_price(&s.tbenji, &ONE);
    assert_eq!(s.env.auths()[0].0, s.admin);
    let next = Address::generate(&s.env);
    s.client.set_admin(&next);
    assert_eq!(s.client.pending_admin(), Some(next.clone()));
    // Only `next` can accept: with the typo (or the old admin) signing, it fails.
    for wrong in [&typo, &s.admin] {
        s.env.mock_auths(&[MockAuth {
            address: wrong,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "accept_admin",
                args: ().into_val(&s.env),
                sub_invokes: &[],
            },
        }]);
        assert!(s.client.try_accept_admin().is_err());
        assert_eq!(s.client.admin(), s.admin);
    }
    s.env.mock_all_auths();
    s.client.accept_admin();
    assert_eq!(s.env.auths()[0].0, next);
    assert_eq!(s.client.admin(), next);
    // Naming the current admin cancels a pending handover.
    let other = Address::generate(&s.env);
    s.client.set_admin(&other);
    s.client.set_admin(&next);
    assert_eq!(s.client.pending_admin(), None);
}

#[test]
fn r6_admin_and_price_changes_emit_events() {
    use soroban_sdk::{testutils::Events as _, Event as _};
    let s = setup();
    s.env.mock_all_auths();
    s.client.set_price(&s.tbenji, &ONE);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.client.address),
        [PriceSet {
            asset: s.tbenji.clone(),
            price: ONE,
            timestamp: 1_000,
        }
        .to_xdr(&s.env, &s.client.address)]
    );
    let next = Address::generate(&s.env);
    s.client.set_admin(&next);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.client.address),
        [AdminProposed {
            pending: next.clone()
        }
        .to_xdr(&s.env, &s.client.address)]
    );
    s.client.accept_admin();
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.client.address),
        [AdminSet {
            admin: next,
            previous: s.admin.clone(),
        }
        .to_xdr(&s.env, &s.client.address)]
    );
}

// --- source-timed assets (DECISIONS #39 draft: Spiko NAV publication time) ---

/// Mon 26 Oct 2026 17:48:20 UTC: Spiko's eurSAFO NAV publication time.
const MON_PUB: u64 = 1_793_036_900;
const DAY: u64 = 86_400;

/// Source-timed setup: ledger at Mon 26 Oct 2026 18:00 UTC, `tbenji` (the
/// test asset) switched to source-timed.
fn source_timed() -> Setup {
    let s = setup();
    s.env.mock_all_auths();
    s.env.ledger().set_timestamp(MON_PUB + 700);
    s.client.set_source_timed(&s.tbenji, &true);
    s
}

#[test]
fn source_timed_is_off_by_default_and_admin_switches_it() {
    let s = setup();
    assert!(!s.client.source_timed(&s.tbenji));
    s.env.mock_all_auths();
    s.client.set_source_timed(&s.tbenji, &true);
    assert_eq!(s.env.auths()[0].0, s.admin);
    assert!(s.client.source_timed(&s.tbenji));
    // Per asset: another asset stays ledger-timed.
    assert!(!s.client.source_timed(&Asset::Other(symbol_short!("USDC"))));
    s.client.set_source_timed(&s.tbenji, &false);
    assert!(!s.client.source_timed(&s.tbenji));
}

#[test]
fn set_source_timed_requires_admin_auth() {
    let s = setup();
    let attacker = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &s.client.address,
            fn_name: "set_source_timed",
            args: (s.tbenji.clone(), true).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.client.try_set_source_timed(&s.tbenji, &true).is_err());
    assert!(!s.client.source_timed(&s.tbenji));
}

#[test]
fn set_price_at_records_the_source_time_not_ledger_time() {
    let s = source_timed();
    s.client.set_price_at(&s.tbenji, &ONE, &MON_PUB);
    assert_eq!(s.env.auths()[0].0, s.admin);
    assert_eq!(
        s.client.lastprice(&s.tbenji),
        Some(PriceData {
            price: ONE,
            timestamp: MON_PUB
        })
    );
    assert_eq!(
        s.client.assets(),
        Vec::from_array(&s.env, [s.tbenji.clone()])
    );
    // Exactly the ledger time is not in the future.
    s.env.ledger().set_timestamp(MON_PUB + DAY);
    s.client.set_price_at(&s.tbenji, &ONE, &(MON_PUB + DAY));
    assert_eq!(
        s.client.lastprice(&s.tbenji).unwrap().timestamp,
        MON_PUB + DAY
    );
}

#[test]
fn non_admin_set_price_at_fails() {
    let s = source_timed();
    let attacker = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &s.client.address,
            fn_name: "set_price_at",
            args: (s.tbenji.clone(), ONE, MON_PUB).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s
        .client
        .try_set_price_at(&s.tbenji, &ONE, &MON_PUB)
        .is_err());
    assert_eq!(s.client.lastprice(&s.tbenji), None);
}

#[test]
fn each_asset_takes_only_its_own_write_mode() {
    let s = source_timed();
    // A re-posting keeper cannot stamp ledger time over the source time.
    assert_eq!(
        s.client.try_set_price(&s.tbenji, &ONE),
        Err(Ok(Error::SourceTimed))
    );
    let usdc = Asset::Other(symbol_short!("USDC"));
    assert_eq!(
        s.client.try_set_price_at(&usdc, &ONE, &MON_PUB),
        Err(Ok(Error::NotSourceTimed))
    );
    assert_eq!(s.client.lastprice(&s.tbenji), None);
    assert_eq!(s.client.lastprice(&usdc), None);
}

#[test]
fn set_price_at_rejects_bad_prices_and_future_timestamps() {
    let s = source_timed();
    let now = s.env.ledger().timestamp();
    assert_eq!(
        s.client.try_set_price_at(&s.tbenji, &0, &MON_PUB),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        s.client.try_set_price_at(&s.tbenji, &ONE, &(now + 1)),
        Err(Ok(Error::FutureTimestamp))
    );
    assert_eq!(s.client.lastprice(&s.tbenji), None);
}

#[test]
fn set_price_at_rejects_older_equal_and_same_day_records() {
    let s = source_timed();
    s.client.set_price_at(&s.tbenji, &ONE, &MON_PUB);
    s.env.ledger().set_timestamp(MON_PUB + 2 * DAY);
    for ts in [MON_PUB - DAY, MON_PUB - 1, MON_PUB] {
        assert_eq!(
            s.client.try_set_price_at(&s.tbenji, &(ONE + 1), &ts),
            Err(Ok(Error::NotNewer))
        );
    }
    // A correction later the same UTC day (Spiko republishes Monday's NAV
    // at 23:59:59) cannot replace Monday's record: one record per NAV day.
    let monday_end = (MON_PUB / DAY + 1) * DAY - 1;
    assert_eq!(
        s.client
            .try_set_price_at(&s.tbenji, &(ONE + 1), &monday_end),
        Err(Ok(Error::SameDay))
    );
    let all = s.client.prices(&s.tbenji, &10).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(
        all.get_unchecked(0),
        PriceData {
            price: ONE,
            timestamp: MON_PUB
        }
    );
    // Tuesday's NAV appends.
    s.client
        .set_price_at(&s.tbenji, &(ONE + 1), &(monday_end + 1));
    assert_eq!(s.client.prices(&s.tbenji, &10).unwrap().len(), 2);
}

#[test]
fn weekend_keeps_fridays_record_and_its_source_time() {
    let s = source_timed();
    let fri = MON_PUB - 3 * DAY - 7_200; // Fri 23 Oct 15:48 UTC
    s.env.ledger().set_timestamp(fri + 600);
    s.client.set_price_at(&s.tbenji, &ONE, &fri);
    // Saturday and Sunday nothing is published, so nothing is posted: the
    // record keeps Friday's time and its age grows with the ledger.
    s.env.ledger().set_timestamp(MON_PUB);
    let last = s.client.lastprice(&s.tbenji).unwrap();
    assert_eq!(last.timestamp, fri);
    assert_eq!(s.env.ledger().timestamp() - last.timestamp, 3 * DAY + 7_200);
    // Monday's print appends.
    s.env.ledger().set_timestamp(MON_PUB + 300);
    s.client.set_price_at(&s.tbenji, &(ONE + 7), &MON_PUB);
    let all = s.client.prices(&s.tbenji, &10).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all.get_unchecked(0).timestamp, MON_PUB);
    assert_eq!(all.get_unchecked(1).timestamp, fri);
}

#[test]
fn set_price_at_takes_one_write_per_ledger_slot() {
    // A feed back from an outage posts its backlog: one record per ledger
    // resolution slot (300 s here), so it cannot flush the band window in
    // one ledger.
    let s = source_timed();
    let now = s.env.ledger().timestamp();
    s.client.set_price_at(&s.tbenji, &ONE, &(now - 3 * DAY));
    assert_eq!(
        s.client.try_set_price_at(&s.tbenji, &ONE, &(now - 2 * DAY)),
        Err(Ok(Error::TooSoon))
    );
    s.env.ledger().set_timestamp((now / 300 + 1) * 300);
    s.client.set_price_at(&s.tbenji, &ONE, &(now - 2 * DAY));
    assert_eq!(s.client.prices(&s.tbenji, &10).unwrap().len(), 2);
}

/// side feed-rewrite, source-timed: even with a 20-day-old history, a
/// feeder key needs 19 more ledger resolution slots to replace the whole
/// 20-record window, and every record sits on its own UTC day.
#[test]
fn source_timed_window_cannot_be_flushed_faster_than_ledger_timed() {
    let s = setup_in(Env::new_with_config(
        soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        },
    ));
    s.env.mock_all_auths();
    let start_day = MON_PUB / DAY - 40;
    s.env.ledger().set_timestamp(MON_PUB);
    s.client.set_source_timed(&s.tbenji, &true);
    for i in 0..u64::from(MAX_HISTORY) {
        s.client
            .set_price_at(&s.tbenji, &ONE, &((start_day + i) * DAY));
        s.env
            .ledger()
            .set_timestamp(s.env.ledger().timestamp() + 300);
    }
    let start = s.env.ledger().timestamp();
    let mut day = start_day + u64::from(MAX_HISTORY);
    loop {
        match s
            .client
            .try_set_price_at(&s.tbenji, &(ONE / 2), &(day * DAY))
        {
            Ok(_) => day += 1,
            Err(Ok(Error::TooSoon)) => {}
            other => panic!("unexpected {other:?}"),
        }
        let window = s.client.prices(&s.tbenji, &MAX_HISTORY).unwrap();
        if window.iter().all(|r| r.price == ONE / 2) {
            break;
        }
        s.env.ledger().set_timestamp(s.env.ledger().timestamp() + 5);
    }
    // 20 writes in 20 distinct slots: more than 18 × resolution, the same
    // bound #40 gives the ledger-timed feed.
    assert!(s.env.ledger().timestamp() - start > u64::from(MAX_HISTORY - 2) * 300);
    let window = s.client.prices(&s.tbenji, &MAX_HISTORY).unwrap();
    for (a, b) in window.iter().zip(window.iter().skip(1)) {
        assert!(a.timestamp / DAY > b.timestamp / DAY);
    }
}

#[test]
fn source_timed_switch_and_price_emit_events() {
    use soroban_sdk::{testutils::Events as _, Event as _};
    let s = setup();
    s.env.mock_all_auths();
    s.env.ledger().set_timestamp(MON_PUB + 700);
    s.client.set_source_timed(&s.tbenji, &true);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.client.address),
        [SourceTimedSet {
            asset: s.tbenji.clone(),
            source_timed: true,
        }
        .to_xdr(&s.env, &s.client.address)]
    );
    s.client.set_price_at(&s.tbenji, &ONE, &MON_PUB);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.client.address),
        [PriceSet {
            asset: s.tbenji.clone(),
            price: ONE,
            timestamp: MON_PUB,
        }
        .to_xdr(&s.env, &s.client.address)]
    );
}

#[test]
fn switching_back_to_ledger_time_appends_after_source_records() {
    let s = source_timed();
    s.client.set_price_at(&s.tbenji, &ONE, &MON_PUB);
    s.client.set_source_timed(&s.tbenji, &false);
    s.client.set_price(&s.tbenji, &(ONE * 2));
    let all = s.client.prices(&s.tbenji, &10).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all.get_unchecked(0).timestamp, MON_PUB + 700);
    assert_eq!(all.get_unchecked(1).timestamp, MON_PUB);
}
