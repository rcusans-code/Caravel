extern crate std;

use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal, InvokeError, String, Symbol, Val, Vec,
};

use crate::{SpikoError, SpikoMock, SpikoMockClient};

struct T<'a> {
    env: Env,
    token: SpikoMockClient<'a>,
    admin: Address,
    alice: Address,
    bob: Address,
}

fn setup<'a>() -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(
        SpikoMock,
        (
            admin.clone(),
            String::from_str(&env, "Test SAFO"),
            String::from_str(&env, "tSAFO"),
            5u32,
        ),
    );
    let token = SpikoMockClient::new(&env, &id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    token.set_whitelisted(&alice, &true);
    token.set_whitelisted(&bob, &true);
    token.mint(&alice, &1_000);
    T {
        env,
        token,
        admin,
        alice,
        bob,
    }
}

#[test]
fn metadata_and_mint() {
    let t = setup();
    assert_eq!(t.token.decimals(), 5);
    assert_eq!(t.token.symbol(), String::from_str(&t.env, "tSAFO"));
    assert_eq!(t.token.name(), String::from_str(&t.env, "Test SAFO"));
    assert_eq!(t.token.admin(), t.admin);
    assert_eq!(t.token.balance(&t.alice), 1_000);
    assert_eq!(t.token.total_supply(), 1_000);
}

#[test]
fn transfer_between_allowlisted_holders() {
    let t = setup();
    t.token.transfer(&t.alice, &t.bob, &400);
    // `from` signed the transfer (auths() covers the last call only).
    assert_eq!(t.env.auths()[0].0, t.alice);
    assert_eq!(t.token.balance(&t.alice), 600);
    assert_eq!(t.token.balance(&t.bob), 400);
}

#[test]
fn transfer_checks_both_sides_of_the_allowlist() {
    let t = setup();
    let outsider = Address::generate(&t.env);
    assert_eq!(
        t.token.try_transfer(&t.alice, &outsider, &1),
        Err(Ok(SpikoError::NotWhitelisted))
    );

    // Removing a holder freezes their balance in place.
    t.token.set_whitelisted(&t.alice, &false);
    assert!(!t.token.is_whitelisted(&t.alice));
    assert_eq!(
        t.token.try_transfer(&t.alice, &t.bob, &1),
        Err(Ok(SpikoError::NotWhitelisted))
    );
    assert_eq!(
        t.token.try_transfer(&t.bob, &t.alice, &1),
        Err(Ok(SpikoError::NotWhitelisted))
    );
    assert_eq!(t.token.balance(&t.alice), 1_000);
}

#[test]
fn mint_requires_allowlisted_receiver() {
    let t = setup();
    let outsider = Address::generate(&t.env);
    assert_eq!(
        t.token.try_mint(&outsider, &1),
        Err(Ok(SpikoError::NotWhitelisted))
    );
}

#[test]
fn transfer_rejects_bad_amounts() {
    let t = setup();
    for amount in [0, -1] {
        assert_eq!(
            t.token.try_transfer(&t.alice, &t.bob, &amount),
            Err(Ok(SpikoError::InvalidAmount))
        );
    }
    assert_eq!(
        t.token.try_transfer(&t.alice, &t.bob, &1_001),
        Err(Ok(SpikoError::InsufficientBalance))
    );
}

#[test]
fn pause_blocks_transfers_and_mints_until_unpaused() {
    let t = setup();
    t.token.pause();
    assert!(t.token.paused());
    assert_eq!(
        t.token.try_transfer(&t.alice, &t.bob, &1),
        Err(Ok(SpikoError::Paused))
    );
    assert_eq!(t.token.try_mint(&t.alice, &1), Err(Ok(SpikoError::Paused)));

    t.token.unpause();
    t.token.transfer(&t.alice, &t.bob, &1);
    assert_eq!(t.token.balance(&t.bob), 1);
}

#[test]
#[should_panic]
fn transfer_requires_from_auth() {
    let t = setup();
    // Only bob signs; alice's tokens must not move.
    t.env.mock_auths(&[MockAuth {
        address: &t.bob,
        invoke: &MockAuthInvoke {
            contract: &t.token.address,
            fn_name: "transfer",
            args: (t.alice.clone(), t.bob.clone(), 1i128).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    t.token.transfer(&t.alice, &t.bob, &1);
}

#[test]
#[should_panic]
fn admin_ops_require_admin_auth() {
    let t = setup();
    t.env.mock_auths(&[]);
    t.token.pause();
}

#[test]
#[should_panic]
fn whitelisting_requires_admin_auth() {
    let t = setup();
    t.env.mock_auths(&[]);
    t.token.set_whitelisted(&Address::generate(&t.env), &true);
}

/// No allowance path exists: a contract (or anyone) can only move a holder's
/// tokens inside a call the holder signed. Calling the SEP-41 allowance
/// functions by name must fail, so adding one later breaks this test.
#[test]
fn has_no_allowance_functions() {
    let t = setup();
    let a = t.alice.clone();
    let b = t.bob.clone();
    let calls: [(&str, Vec<Val>); 4] = [
        (
            "approve",
            (a.clone(), b.clone(), 1i128, 1_000u32).into_val(&t.env),
        ),
        ("allowance", (a.clone(), b.clone()).into_val(&t.env)),
        (
            "transfer_from",
            (b.clone(), a.clone(), b.clone(), 1i128).into_val(&t.env),
        ),
        ("burn_from", (b.clone(), a.clone(), 1i128).into_val(&t.env)),
    ];
    for (name, args) in calls {
        let res = t.env.try_invoke_contract::<Val, InvokeError>(
            &t.token.address,
            &Symbol::new(&t.env, name),
            args,
        );
        assert!(res.is_err(), "spiko mock must not expose `{name}`");
    }
    assert_eq!(t.token.balance(&t.alice), 1_000);
}

/// Raven audit CT-01: deleting `mint`'s `require_auth` used to leave every
/// spiko-mock test green. With no signature the mint is refused and the
/// balance is unchanged.
#[test]
fn audit_mint_requires_admin_auth() {
    let t = setup();
    t.env.mock_auths(&[]);
    assert!(t.token.try_mint(&t.alice, &1).is_err());
    assert_eq!(t.token.balance(&t.alice), 1_000);
}
