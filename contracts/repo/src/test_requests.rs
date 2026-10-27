//! Borrow requests (request.rs): a borrower posts the loan it wants with its
//! collateral escrowed, a lender fills it in one atomic DvP. Same demo
//! numbers as test.rs: 970 USDC for 7 demo days at 5% APR against tBENJI at
//! NAV 1.00 with a 3% haircut; fee = 10% of interest.

extern crate std;

use caravel_spiko_mock::{SpikoMock, SpikoMockClient};
use soroban_sdk::{
    testutils::{Address as _, Events as _, IssuerFlags, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Event as _, IntoVal, String,
};

use crate::{
    events,
    oracle::mock::{setup_mock_oracle, MockOracleClient, ONE},
    test::{demo_config, whitelist, DEMO_NAV_AGE, NO_CAP, SETTLE_SECS, TRIGGER_BPS, WIDE_BAND_BPS},
    Asset, AssetConfig, BorrowRequest, CaravelRepo, CaravelRepoClient, Error, Pause, Repo, Status,
};

const UNIT: i128 = 10_000_000;
const NOW: u64 = 1_000;
const PRINCIPAL: i128 = 970 * UNIT;
const APR_BPS: u32 = 500;
const TERM_SECS: u64 = 7 * 60;
const GRACE_SECS: u64 = 60;
const MATURED: u64 = NOW + TERM_SECS + GRACE_SECS + 1;
const INTEREST: i128 = 9_301_370;
const DEBT: i128 = PRINCIPAL + INTEREST;
const FEE: i128 = 930_137;
const LENDER_DUE: i128 = DEBT - FEE;
/// DEBT / (1.00 × 0.97), rounded up: what `take_offer` would charge.
const REQUIRED: i128 = 10_009_589_042;
/// The borrower's escrow: ~10% over the required collateral.
const ESCROW: i128 = 1_100 * UNIT;
const BORROWER_TBENJI: i128 = 2_000 * UNIT;
const BORROWER_USDC: i128 = 100 * UNIT;
const LENDER_USDC: i128 = 10_000 * UNIT;

struct World<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    usdc_admin: StellarAssetClient<'a>,
    tbenji: Address,
    tbenji_token: TokenClient<'a>,
    oracle: MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
    treasury: Address,
}

fn tbenji_config(tbenji: &Address) -> AssetConfig {
    AssetConfig {
        oracle_asset: Asset::Stellar(tbenji.clone()),
        haircut_bps: 300,
        margin_trigger_bps: TRIGGER_BPS,
        enabled: true,
        max_nav_age_secs: DEMO_NAV_AGE,
        max_nav_move_bps: WIDE_BAND_BPS,
        nav_floor: None,
        nav_ceiling: None,
        max_open_debt: NO_CAP,
        band_settle_secs: SETTLE_SECS,
    }
}

fn world<'a>() -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let issuer = Address::generate(&env);
    let usdc_sac = env.register_stellar_asset_contract_v2(issuer.clone());
    // Circle-style issuer: can freeze a holder (Raven AS-03 tests).
    usdc_sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let usdc = usdc_sac.address();
    let tbenji = env.register_stellar_asset_contract_v2(issuer).address();
    let oracle = MockOracleClient::new(&env, &setup_mock_oracle(&env));
    oracle.set_price(&Asset::Stellar(tbenji.clone()), &ONE, &NOW);

    let mut config = demo_config(&env);
    config.usdc = usdc.clone();
    config.oracle = oracle.address.clone();
    let treasury = config.treasury.clone();
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (config,)));
    repo.set_asset(&tbenji, &tbenji_config(&tbenji));

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    whitelist(&env, &repo, &liquidator);
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &LENDER_USDC);
    usdc_admin.mint(&borrower, &BORROWER_USDC);
    usdc_admin.mint(&liquidator, &(2_000 * UNIT));
    StellarAssetClient::new(&env, &tbenji).mint(&borrower, &BORROWER_TBENJI);

    World {
        usdc: TokenClient::new(&env, &usdc),
        usdc_admin,
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
    fn request_with(&self, collateral: i128) -> u64 {
        self.repo.create_request(
            &self.borrower,
            &self.tbenji,
            &collateral,
            &PRINCIPAL,
            &APR_BPS,
            &TERM_SECS,
        )
    }

    fn request(&self) -> u64 {
        self.request_with(ESCROW)
    }

    fn fill(&self, request_id: u64) -> u64 {
        self.repo.fill_request(&self.lender, &request_id)
    }

    fn set_nav(&self, price: i128, timestamp: u64) {
        self.oracle
            .set_price(&Asset::Stellar(self.tbenji.clone()), &price, &timestamp);
    }

    fn set_time(&self, timestamp: u64) {
        self.env.ledger().set_timestamp(timestamp);
    }

    /// Balances unchanged since the request was posted: escrow in the
    /// contract, no USDC moved.
    fn assert_still_posted(&self, request_id: u64, escrow: i128) {
        assert_eq!(self.repo.request(&request_id).collateral_amount, escrow);
        assert_eq!(self.tbenji_token.balance(&self.repo.address), escrow);
        assert_eq!(
            self.tbenji_token.balance(&self.borrower),
            BORROWER_TBENJI - escrow
        );
        assert_eq!(self.usdc.balance(&self.lender), LENDER_USDC);
        assert_eq!(self.usdc.balance(&self.borrower), BORROWER_USDC);
        assert_eq!(self.repo.open_debt(&self.tbenji), 0);
        assert_eq!(self.repo.try_repo(&1), Err(Ok(Error::RepoNotFound)));
    }

    fn request_born_repo(&self, request_id: u64) -> Repo {
        Repo {
            id: 1,
            offer_id: 0,
            lender: self.lender.clone(),
            borrower: self.borrower.clone(),
            collateral_asset: self.tbenji.clone(),
            collateral_amount: ESCROW,
            principal: PRINCIPAL,
            interest: INTEREST,
            haircut_bps: 300,
            start_ts: NOW,
            maturity_ts: NOW + TERM_SECS,
            margin_call_deadline: None,
            status: Status::Open,
            auto_repay: false,
            request_id: Some(request_id),
        }
    }
}

// --- create / cancel -----------------------------------------------------------

#[test]
fn create_request_escrows_collateral() {
    let w = world();
    // An offer first: requests keep their own id counter.
    w.repo
        .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
    let id = w.request();
    assert_eq!(id, 1);

    let event = events::RequestCreated {
        request_id: 1,
        borrower: w.borrower.clone(),
        collateral_asset: w.tbenji.clone(),
        collateral_amount: ESCROW,
        principal: PRINCIPAL,
        apr_bps: APR_BPS,
        term_secs: TERM_SECS,
    };
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [event.to_xdr(&w.env, &w.repo.address)]
    );
    assert_eq!(w.env.auths()[0].0, w.borrower);

    assert_eq!(
        w.repo.request(&1),
        BorrowRequest {
            id: 1,
            borrower: w.borrower.clone(),
            collateral_asset: w.tbenji.clone(),
            collateral_amount: ESCROW,
            principal: PRINCIPAL,
            apr_bps: APR_BPS,
            term_secs: TERM_SECS,
            created_at: NOW,
        }
    );
    assert_eq!(w.tbenji_token.balance(&w.repo.address), ESCROW);
    assert_eq!(
        w.tbenji_token.balance(&w.borrower),
        BORROWER_TBENJI - ESCROW
    );
    // No USDC moves at posting; the offer's escrow is untouched.
    assert_eq!(w.usdc.balance(&w.borrower), BORROWER_USDC);
    assert_eq!(w.usdc.balance(&w.repo.address), PRINCIPAL);

    assert_eq!(w.request_with(UNIT), 2);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), ESCROW + UNIT);
}

#[test]
fn create_request_needs_no_nav() {
    let w = world();
    // Stale NAV: posting still works; only the fill reads the NAV.
    w.set_time(NOW + DEMO_NAV_AGE + 1);
    let id = w.request();
    assert_eq!(w.repo.request(&id).created_at, NOW + DEMO_NAV_AGE + 1);
}

#[test]
fn create_request_rejects_bad_terms() {
    let w = world();
    for (collateral, principal, term) in [
        (0, PRINCIPAL, TERM_SECS),
        (-1, PRINCIPAL, TERM_SECS),
        (ESCROW, 0, TERM_SECS),
        (ESCROW, -1, TERM_SECS),
        (ESCROW, PRINCIPAL, 0),
    ] {
        assert_eq!(
            w.repo.try_create_request(
                &w.borrower,
                &w.tbenji,
                &collateral,
                &principal,
                &APR_BPS,
                &term
            ),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(
        w.repo.try_create_request(
            &w.borrower,
            &w.tbenji,
            &ESCROW,
            &PRINCIPAL,
            &u32::MAX,
            &u64::MAX
        ),
        Err(Ok(Error::MathOverflow))
    );
    assert_eq!(w.tbenji_token.balance(&w.borrower), BORROWER_TBENJI);
    assert_eq!(w.repo.try_request(&1), Err(Ok(Error::RequestNotFound)));
}

#[test]
fn create_request_rejects_missing_disabled_or_paused_asset() {
    let w = world();
    let unknown = Address::generate(&w.env);
    assert_eq!(
        w.repo.try_create_request(
            &w.borrower,
            &unknown,
            &ESCROW,
            &PRINCIPAL,
            &APR_BPS,
            &TERM_SECS
        ),
        Err(Ok(Error::AssetNotSupported))
    );

    w.repo.set_pause(
        &w.tbenji,
        &Pause {
            no_new_repos: true,
            no_seize: false,
        },
    );
    assert_eq!(
        w.repo.try_create_request(
            &w.borrower,
            &w.tbenji,
            &ESCROW,
            &PRINCIPAL,
            &APR_BPS,
            &TERM_SECS
        ),
        Err(Ok(Error::Paused))
    );

    let mut disabled = tbenji_config(&w.tbenji);
    disabled.enabled = false;
    w.repo.set_asset(&w.tbenji, &disabled);
    assert_eq!(
        w.repo.try_create_request(
            &w.borrower,
            &w.tbenji,
            &ESCROW,
            &PRINCIPAL,
            &APR_BPS,
            &TERM_SECS
        ),
        Err(Ok(Error::AssetNotSupported))
    );
    assert_eq!(w.tbenji_token.balance(&w.borrower), BORROWER_TBENJI);
}

#[test]
fn create_request_fails_without_collateral() {
    let w = world();
    let broke = Address::generate(&w.env);
    assert!(w
        .repo
        .try_create_request(&broke, &w.tbenji, &ESCROW, &PRINCIPAL, &APR_BPS, &TERM_SECS)
        .is_err());
    assert_eq!(w.repo.try_request(&1), Err(Ok(Error::RequestNotFound)));
}

#[test]
fn cancel_request_returns_collateral() {
    let w = world();
    let id = w.request();
    w.repo.cancel_request(&id);

    let event = events::RequestCancelled {
        request_id: id,
        borrower: w.borrower.clone(),
        collateral_amount: ESCROW,
    };
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [event.to_xdr(&w.env, &w.repo.address)]
    );
    assert_eq!(w.env.auths()[0].0, w.borrower);
    assert_eq!(w.tbenji_token.balance(&w.borrower), BORROWER_TBENJI);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);
    assert_eq!(w.repo.try_request(&id), Err(Ok(Error::RequestNotFound)));

    // Gone: no second cancel, no fill.
    assert_eq!(
        w.repo.try_cancel_request(&id),
        Err(Ok(Error::RequestNotFound))
    );
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &id),
        Err(Ok(Error::RequestNotFound))
    );
    assert_eq!(w.usdc.balance(&w.lender), LENDER_USDC);
}

#[test]
fn cancel_request_leaves_other_requests_escrowed() {
    let w = world();
    let first = w.request();
    let second = w.request_with(100 * UNIT);
    w.repo.cancel_request(&first);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 100 * UNIT);
    assert_eq!(w.repo.request(&second).collateral_amount, 100 * UNIT);
}

#[test]
fn non_borrower_cannot_cancel_request() {
    let w = world();
    let id = w.request();

    // Nobody signs.
    w.env.set_auths(&[]);
    assert!(w.repo.try_cancel_request(&id).is_err());

    // A stranger signs the cancel: the borrower's require_auth still fails.
    let stranger = Address::generate(&w.env);
    assert!(w
        .repo
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &w.repo.address,
                fn_name: "cancel_request",
                args: (id,).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_cancel_request(&id)
        .is_err());
    // So does the lender.
    assert!(w
        .repo
        .mock_auths(&[MockAuth {
            address: &w.lender,
            invoke: &MockAuthInvoke {
                contract: &w.repo.address,
                fn_name: "cancel_request",
                args: (id,).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_cancel_request(&id)
        .is_err());

    w.env.mock_all_auths();
    w.assert_still_posted(id, ESCROW);
}

#[test]
fn cancel_request_works_while_paused_or_disabled() {
    let w = world();
    let id = w.request();
    w.repo.set_pause(
        &w.tbenji,
        &Pause {
            no_new_repos: true,
            no_seize: true,
        },
    );
    let mut disabled = tbenji_config(&w.tbenji);
    disabled.enabled = false;
    w.repo.set_asset(&w.tbenji, &disabled);
    // Stale NAV too: the exit reads none.
    w.set_time(NOW + DEMO_NAV_AGE + 1);

    w.repo.cancel_request(&id);
    assert_eq!(w.tbenji_token.balance(&w.borrower), BORROWER_TBENJI);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);
}

#[test]
fn cancel_missing_request_is_an_error() {
    let w = world();
    assert_eq!(
        w.repo.try_cancel_request(&42),
        Err(Ok(Error::RequestNotFound))
    );
}

// --- fill ------------------------------------------------------------------------

#[test]
fn fill_request_is_atomic_dvp() {
    let w = world();
    let request_id = w.request();
    let repo_id = w.fill(request_id);
    assert_eq!(repo_id, 1);

    let opened = events::RepoOpened {
        repo_id,
        offer_id: 0,
        lender: w.lender.clone(),
        borrower: w.borrower.clone(),
        collateral_asset: w.tbenji.clone(),
        collateral_amount: ESCROW,
        principal: PRINCIPAL,
        interest: INTEREST,
        haircut_bps: 300,
        maturity_ts: NOW + TERM_SECS,
        auto_repay: false,
    };
    let filled = events::RequestFilled {
        request_id,
        repo_id,
        lender: w.lender.clone(),
        borrower: w.borrower.clone(),
    };
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [
            opened.to_xdr(&w.env, &w.repo.address),
            filled.to_xdr(&w.env, &w.repo.address)
        ]
    );
    assert_eq!(w.env.auths()[0].0, w.lender);

    // Payment: lender's USDC straight to the borrower, none left in the
    // contract. Delivery: the whole escrow stays as the repo's collateral.
    assert_eq!(w.usdc.balance(&w.lender), LENDER_USDC - PRINCIPAL);
    assert_eq!(w.usdc.balance(&w.borrower), BORROWER_USDC + PRINCIPAL);
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), ESCROW);
    assert_eq!(
        w.tbenji_token.balance(&w.borrower),
        BORROWER_TBENJI - ESCROW
    );

    assert_eq!(w.repo.repo(&repo_id), w.request_born_repo(request_id));
    assert_eq!(w.repo.open_debt(&w.tbenji), DEBT);
    assert_eq!(
        w.repo.try_request(&request_id),
        Err(Ok(Error::RequestNotFound))
    );
    // auto_repay starts off: no allowance was signed.
    assert_eq!(w.usdc.allowance(&w.borrower, &w.repo.address), 0);
}

#[test]
fn fill_request_shares_the_repo_counter_with_take_offer() {
    let w = world();
    let offer_id = w
        .repo
        .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
    assert_eq!(w.repo.take_offer(&w.borrower, &offer_id, &false), 1);
    StellarAssetClient::new(&w.env, &w.tbenji).mint(&w.borrower, &ESCROW);
    let request_id = w.request_with(ESCROW);
    assert_eq!(w.fill(request_id), 2);
    assert_eq!(w.repo.repo(&1).request_id, None);
    assert_eq!(w.repo.repo(&1).offer_id, offer_id);
    assert_eq!(w.repo.repo(&2).request_id, Some(request_id));
    assert_eq!(w.repo.repo(&2).offer_id, 0);
    assert_eq!(w.repo.open_debt(&w.tbenji), 2 * DEBT);
}

#[test]
fn fill_request_requires_lender_auth() {
    let w = world();
    let id = w.request();
    w.env.set_auths(&[]);
    assert!(w.repo.try_fill_request(&w.lender, &id).is_err());
    w.env.mock_all_auths();
    w.assert_still_posted(id, ESCROW);
}

#[test]
fn fill_request_escrow_exactly_at_required_fills_one_below_fails() {
    let w = world();
    let short = w.request_with(REQUIRED - 1);
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &short),
        Err(Ok(Error::InsufficientCollateral))
    );
    w.assert_still_posted(short, REQUIRED - 1);

    w.repo.cancel_request(&short);
    let exact = w.request_with(REQUIRED);
    let repo_id = w.fill(exact);
    assert_eq!(w.repo.repo(&repo_id).collateral_amount, REQUIRED);
}

#[test]
fn fill_request_rejects_nav_drop_and_request_stays() {
    let w = world();
    let id = w.request();
    // 1_100 tBENJI covers the debt at a 3% haircut down to NAV ~0.9095.
    w.set_nav(ONE * 90 / 100, NOW);
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &id),
        Err(Ok(Error::InsufficientCollateral))
    );
    w.assert_still_posted(id, ESCROW);

    // The NAV recovers: the same request fills.
    w.set_nav(ONE, NOW);
    assert_eq!(w.fill(id), 1);

    // The borrower could equally have cancelled and reposted.
    let w = world();
    let id = w.request();
    w.set_nav(ONE * 90 / 100, NOW);
    w.repo.cancel_request(&id);
    assert_eq!(w.tbenji_token.balance(&w.borrower), BORROWER_TBENJI);
}

#[test]
fn fill_request_rejects_stale_or_missing_nav() {
    let w = world();
    let id = w.request();
    w.set_time(NOW + DEMO_NAV_AGE + 1);
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &id),
        Err(Ok(Error::StaleNav))
    );
    w.assert_still_posted(id, ESCROW);

    // Exactly at the age limit it fills.
    w.set_time(NOW + DEMO_NAV_AGE);
    assert_eq!(w.fill(id), 1);
}

#[test]
fn fill_request_rejects_nav_out_of_band() {
    let w = world();
    let mut banded = tbenji_config(&w.tbenji);
    banded.nav_ceiling = Some(ONE);
    w.repo.set_asset(&w.tbenji, &banded);
    let id = w.request();
    w.set_nav(ONE + 1, NOW);
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &id),
        Err(Ok(Error::NavOutOfBand))
    );
    w.assert_still_posted(id, ESCROW);
}

#[test]
fn fill_request_rejects_paused_asset() {
    let w = world();
    let id = w.request();
    w.repo.set_pause(
        &w.tbenji,
        &Pause {
            no_new_repos: true,
            no_seize: false,
        },
    );
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &id),
        Err(Ok(Error::Paused))
    );
    w.assert_still_posted(id, ESCROW);
}

#[test]
fn fill_request_rejects_asset_disabled_after_posting() {
    let w = world();
    let id = w.request();
    let mut disabled = tbenji_config(&w.tbenji);
    disabled.enabled = false;
    w.repo.set_asset(&w.tbenji, &disabled);
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &id),
        Err(Ok(Error::AssetNotSupported))
    );
    w.assert_still_posted(id, ESCROW);
}

#[test]
fn fill_request_respects_exposure_cap() {
    let w = world();
    let id = w.request();
    let mut capped = tbenji_config(&w.tbenji);
    capped.max_open_debt = DEBT - 1;
    w.repo.set_asset(&w.tbenji, &capped);
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &id),
        Err(Ok(Error::CapExceeded))
    );
    w.assert_still_posted(id, ESCROW);

    // Exactly at the cap passes (lowering further is a tightening, so set a
    // fresh world with the cap at DEBT).
    let w = world();
    let mut capped = tbenji_config(&w.tbenji);
    capped.max_open_debt = DEBT;
    w.repo.set_asset(&w.tbenji, &capped);
    let id = w.request();
    assert_eq!(w.fill(id), 1);
    assert_eq!(w.repo.open_debt(&w.tbenji), DEBT);
}

#[test]
fn request_fills_only_once() {
    let w = world();
    let id = w.request();
    w.fill(id);
    // A second fill, same ledger, another lender: gone.
    let other = Address::generate(&w.env);
    w.usdc_admin.mint(&other, &LENDER_USDC);
    assert_eq!(
        w.repo.try_fill_request(&other, &id),
        Err(Ok(Error::RequestNotFound))
    );
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &id),
        Err(Ok(Error::RequestNotFound))
    );
    assert_eq!(w.usdc.balance(&other), LENDER_USDC);
    assert_eq!(w.usdc.balance(&w.lender), LENDER_USDC - PRINCIPAL);
    assert_eq!(w.usdc.balance(&w.borrower), BORROWER_USDC + PRINCIPAL);
    assert_eq!(w.repo.try_repo(&2), Err(Ok(Error::RepoNotFound)));
}

#[test]
fn cancel_after_fill_fails() {
    let w = world();
    let id = w.request();
    let repo_id = w.fill(id);
    assert_eq!(
        w.repo.try_cancel_request(&id),
        Err(Ok(Error::RequestNotFound))
    );
    // The collateral stays behind the repo.
    assert_eq!(w.tbenji_token.balance(&w.repo.address), ESCROW);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);
}

#[test]
fn frozen_lender_cannot_fill() {
    let w = world();
    let id = w.request();
    w.usdc_admin.set_authorized(&w.lender, &false);
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &id),
        Err(Ok(Error::UsdcFrozen))
    );
    w.assert_still_posted(id, ESCROW);

    // Re-authorized: it fills.
    w.usdc_admin.set_authorized(&w.lender, &true);
    assert_eq!(w.fill(id), 1);
}

#[test]
fn frozen_borrower_request_cannot_be_filled_but_can_be_cancelled() {
    let w = world();
    let id = w.request();
    w.usdc_admin.set_authorized(&w.borrower, &false);
    assert_eq!(
        w.repo.try_fill_request(&w.lender, &id),
        Err(Ok(Error::UsdcFrozen))
    );
    // The escrow is tBENJI, not USDC: the exit still works.
    w.repo.cancel_request(&id);
    assert_eq!(w.tbenji_token.balance(&w.borrower), BORROWER_TBENJI);
}

#[test]
fn lender_without_usdc_cannot_fill() {
    let w = world();
    let id = w.request();
    let broke = Address::generate(&w.env);
    assert!(w.repo.try_fill_request(&broke, &id).is_err());
    w.assert_still_posted(id, ESCROW);
}

// --- a request-born repo settles like an offer-born one ---------------------------

#[test]
fn request_born_repo_repays() {
    let w = world();
    let repo_id = w.fill(w.request());
    // The borrower holds PRINCIPAL + 100 USDC; the debt is PRINCIPAL + INTEREST.
    w.repo.repay(&repo_id);

    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
    assert_eq!(
        w.usdc.balance(&w.lender),
        LENDER_USDC - PRINCIPAL + LENDER_DUE
    );
    assert_eq!(w.usdc.balance(&w.treasury), FEE);
    assert_eq!(w.usdc.balance(&w.borrower), BORROWER_USDC - INTEREST);
    // The whole escrow, cushion included, comes back.
    assert_eq!(w.tbenji_token.balance(&w.borrower), BORROWER_TBENJI);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);
    assert_eq!(w.repo.open_debt(&w.tbenji), 0);
}

#[test]
fn request_born_repo_turns_on_auto_repay_and_auto_repays() {
    let w = world();
    let repo_id = w.fill(w.request());
    w.repo.set_auto_repay(&repo_id, &true);
    assert!(w.repo.repo(&repo_id).auto_repay);
    assert_eq!(w.usdc.allowance(&w.borrower, &w.repo.address), DEBT);

    w.set_time(NOW + TERM_SECS);
    w.repo.auto_repay(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
    assert_eq!(w.tbenji_token.balance(&w.borrower), BORROWER_TBENJI);
    assert_eq!(
        w.usdc.balance(&w.lender),
        LENDER_USDC - PRINCIPAL + LENDER_DUE
    );
}

#[test]
fn request_born_repo_defaults_and_liquidates() {
    let w = world();
    let repo_id = w.fill(w.request());
    w.set_time(MATURED);
    assert_eq!(w.repo.default(&repo_id), Status::Defaulted);

    w.set_nav(ONE, MATURED);
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);

    // Proceeds = 1_100 tBENJI × 1.00 × 0.98. The lender is paid in full,
    // the borrower gets the cushion's surplus.
    let proceeds = ESCROW * 98 / 100;
    assert_eq!(
        w.usdc.balance(&w.lender),
        LENDER_USDC - PRINCIPAL + LENDER_DUE
    );
    assert_eq!(w.usdc.balance(&w.treasury), FEE);
    assert_eq!(
        w.usdc.balance(&w.borrower),
        BORROWER_USDC + PRINCIPAL + proceeds - DEBT
    );
    assert_eq!(w.usdc.balance(&w.liquidator), 2_000 * UNIT - proceeds);
    assert_eq!(w.tbenji_token.balance(&w.liquidator), ESCROW);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);
    assert_eq!(w.repo.open_debt(&w.tbenji), 0);
}

#[test]
fn request_born_repo_margin_calls_and_tops_up() {
    let w = world();
    let repo_id = w.fill(w.request());
    // Trigger 2%: breach once DEBT > 1_100 × NAV × 0.98, i.e. NAV < ~0.9084.
    w.set_nav(ONE * 90 / 100, NOW);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);
    // Top up to initial margin at the 3% haircut: 979.30 / (0.9 × 0.97).
    w.repo.top_up(&repo_id, &(25 * UNIT));
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);
    assert_eq!(w.repo.repo(&repo_id).collateral_amount, ESCROW + 25 * UNIT);
}

// --- permissioned collateral (Spiko-style tSAFO) ------------------------------------

#[test]
fn spiko_request_round_trip() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let usdc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let safo = SpikoMockClient::new(
        &env,
        &env.register(
            SpikoMock,
            (
                Address::generate(&env),
                String::from_str(&env, "Test Spiko SAFO"),
                String::from_str(&env, "tSAFO"),
                5u32,
            ),
        ),
    );
    let oracle = MockOracleClient::new(&env, &setup_mock_oracle(&env));
    oracle.set_price(&Asset::Stellar(safo.address.clone()), &ONE, &NOW);
    let mut config = demo_config(&env);
    config.usdc = usdc.clone();
    config.oracle = oracle.address.clone();
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (config,)));
    let mut asset = tbenji_config(&safo.address);
    asset.haircut_bps = 3_000;
    repo.set_asset(&safo.address, &asset);

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    safo.set_whitelisted(&repo.address, &true);
    safo.set_whitelisted(&borrower, &true);
    safo.mint(&borrower, &(5_000 * 100_000));
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &LENDER_USDC);
    usdc_admin.mint(&borrower, &BORROWER_USDC);
    let usdc = TokenClient::new(&env, &usdc);

    // 1_387.04306 tSAFO covers the debt at a 30% haircut; post 1_500.
    let escrow = 1_500 * 100_000;
    let id = repo.create_request(
        &borrower,
        &safo.address,
        &escrow,
        &PRINCIPAL,
        &APR_BPS,
        &TERM_SECS,
    );
    assert_eq!(safo.balance(&repo.address), escrow);
    let repo_id = repo.fill_request(&lender, &id);
    assert_eq!(usdc.balance(&borrower), BORROWER_USDC + PRINCIPAL);
    assert_eq!(repo.repo(&repo_id).collateral_amount, escrow);

    repo.repay(&repo_id);
    assert_eq!(safo.balance(&borrower), 5_000 * 100_000);
    assert_eq!(safo.balance(&repo.address), 0);

    // A cancel works on a permissioned token too.
    let id = repo.create_request(
        &borrower,
        &safo.address,
        &escrow,
        &PRINCIPAL,
        &APR_BPS,
        &TERM_SECS,
    );
    repo.cancel_request(&id);
    assert_eq!(safo.balance(&borrower), 5_000 * 100_000);
}
