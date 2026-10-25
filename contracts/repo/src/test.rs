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
    assert_eq!(client.try_check_margin(&1), Err(Ok(Error::NotImplemented)));
    assert_eq!(client.try_default(&1), Err(Ok(Error::NotImplemented)));
}

// --- offers ---------------------------------------------------------------

/// A deployed repo contract with real USDC and tBENJI SACs, a mock SEP-40
/// feed at NAV 1.00, tBENJI configured at a 3% haircut, a lender holding
/// 10_000 USDC and a borrower holding 2_000 tBENJI + 100 USDC for interest.
struct World<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    tbenji: Address,
    tbenji_token: TokenClient<'a>,
    oracle: MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    treasury: Address,
}

const NOW: u64 = 1_000;

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
        },
    );

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    StellarAssetClient::new(&env, &usdc).mint(&lender, &(10_000 * UNIT));
    StellarAssetClient::new(&env, &usdc).mint(&borrower, &(100 * UNIT));
    StellarAssetClient::new(&env, &tbenji).mint(&borrower, &(2_000 * UNIT));

    World {
        usdc: TokenClient::new(&env, &usdc),
        tbenji_token: TokenClient::new(&env, &tbenji),
        repo,
        tbenji,
        oracle,
        lender,
        borrower,
        treasury,
        env,
    }
}

impl World<'_> {
    fn set_nav(&self, price: i128, timestamp: u64) {
        self.oracle
            .set_price(&Asset::Stellar(self.tbenji.clone()), &price, &timestamp);
    }

    fn offer(&self) -> u64 {
        self.repo
            .create_offer(&self.lender, &self.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS)
    }

    fn take(&self) -> u64 {
        let offer_id = self.offer();
        self.repo.take_offer(&self.borrower, &offer_id)
    }

    fn set_status(&self, repo_id: u64, status: Status) {
        self.env.as_contract(&self.repo.address, || {
            let mut repo = storage::read_repo(&self.env, repo_id).unwrap();
            repo.status = status;
            storage::write_repo(&self.env, &repo);
        });
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
    }
}

#[test]
fn take_offer_is_atomic_dvp() {
    let w = world();
    let offer_id = w.offer();
    let repo_id = w.repo.take_offer(&w.borrower, &offer_id);
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
    let take_args = (w.borrower.clone(), offer_id).into_val(&w.env);
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
    let ok = w.repo.try_take_offer(&w.borrower, &offer_id).is_ok();
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
    assert!(w.repo.try_take_offer(&w.borrower, &offer_id).is_err());
    assert_eq!(w.repo.offer(&offer_id).id, offer_id);
}

#[test]
fn take_offer_rejects_stale_nav() {
    let w = world();
    let offer_id = w.offer();

    // demo max_nav_age_secs = 180
    w.set_nav(ONE, NOW - 181);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id),
        Err(Ok(Error::StaleNav))
    );

    // Exactly at the limit is still fresh.
    w.set_nav(ONE, NOW - 180);
    assert_eq!(w.repo.take_offer(&w.borrower, &offer_id), 1);
}

#[test]
fn take_offer_rejects_missing_price() {
    let w = world();
    let offer_id = w.offer();
    w.set_nav(0, NOW);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id),
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
        },
    );
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id),
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
    assert!(w.repo.try_take_offer(&poor, &offer_id).is_err());
    assert_eq!(w.tbenji_token.balance(&poor), TAKE_COLLATERAL - 1);
    assert_eq!(w.usdc.balance(&w.repo.address), PRINCIPAL);
    assert_eq!(w.repo.try_repo(&1), Err(Ok(Error::RepoNotFound)));
}

#[test]
fn offer_can_be_taken_only_once() {
    let w = world();
    let offer_id = w.offer();
    w.repo.take_offer(&w.borrower, &offer_id);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id),
        Err(Ok(Error::OfferNotFound))
    );
    assert_eq!(
        w.repo.try_cancel_offer(&offer_id),
        Err(Ok(Error::OfferNotFound))
    );
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &99),
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
