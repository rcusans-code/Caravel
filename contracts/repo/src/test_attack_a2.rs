//! Attack angle A2 (COR-01): a Defaulted repo stays repayable by the borrower
//! until a liquidation lands. Harness copied from the post-implementation
//! attack suite (SAC USDC + tBENJI, mock oracle).

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

use crate::{
    oracle::mock::{setup_mock_oracle, MockOracleClient, ONE},
    test::{
        demo_config, APR_BPS, DEMO_NAV_AGE, NOW, NO_CAP, PRINCIPAL, TERM_SECS, UNIT, WIDE_BAND_BPS,
    },
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Error, Status,
};

const GRACE_SECS: u64 = 60;
const MATURED: u64 = NOW + TERM_SECS + GRACE_SECS + 1;
const INTEREST: i128 = 9_301_370;
const DEBT: i128 = PRINCIPAL + INTEREST;
const FEE: i128 = 930_137;
const LENDER_DUE: i128 = DEBT - FEE;
const TAKE_COLLATERAL: i128 = 10_009_589_042;

struct W<'a> {
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

fn asset_cfg(token: &Address, haircut_bps: u32) -> AssetConfig {
    AssetConfig {
        oracle_asset: Asset::Stellar(token.clone()),
        haircut_bps,
        enabled: true,
        max_nav_age_secs: DEMO_NAV_AGE,
        max_nav_move_bps: WIDE_BAND_BPS,
        nav_floor: None,
        nav_ceiling: None,
        max_open_debt: NO_CAP,
    }
}

fn world<'a>() -> W<'a> {
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
    repo.set_asset(&tbenji, &asset_cfg(&tbenji, 300));

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &(10_000 * UNIT));
    usdc_admin.mint(&borrower, &(100 * UNIT));
    StellarAssetClient::new(&env, &tbenji).mint(&borrower, &(5_000 * UNIT));
    repo.set_liquidator(&liquidator, &true);
    usdc_admin.mint(&liquidator, &(2_000 * UNIT));

    W {
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

impl W<'_> {
    fn set_nav(&self, price: i128, ts: u64) {
        self.oracle
            .set_price(&Asset::Stellar(self.tbenji.clone()), &price, &ts);
    }
    fn take(&self, auto: bool) -> u64 {
        let id =
            self.repo
                .create_offer(&self.lender, &self.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
        self.repo.take_offer(&self.borrower, &id, &auto)
    }
    fn t(&self, ts: u64) {
        self.env.ledger().set_timestamp(ts);
    }
    /// Opted-in repo whose auto-repay pull fails at maturity: default lands.
    fn defaulted_auto(&self) -> u64 {
        let repo_id = self.take(true);
        self.usdc_admin.mint(&self.borrower, &(1_000 * UNIT));
        self.t(MATURED);
        self.usdc
            .approve(&self.borrower, &self.repo.address, &0, &0);
        assert_eq!(self.repo.default(&repo_id), Status::Defaulted);
        repo_id
    }
}

/// Flipped from the attack suite's
/// `cor_defaulted_without_liquidator_is_terminal_and_pins_open_debt`: with no
/// liquidator around, the borrower repays out of Defaulted at the same fixed
/// debt, the lender and treasury get exactly what an on-time repay pays, the
/// collateral comes back and open_debt is released.
#[test]
fn cor_defaulted_without_liquidator_borrower_repays_and_releases_open_debt() {
    let w = world();
    let repo_id = w.defaulted_auto();

    // Everything except repay stays closed in Defaulted.
    assert_eq!(
        w.repo.try_top_up(&repo_id, &UNIT),
        Err(Ok(Error::InvalidStatus))
    );
    assert_eq!(
        w.repo.try_auto_repay(&repo_id),
        Err(Ok(Error::InvalidStatus))
    );
    assert_eq!(
        w.repo.try_set_auto_repay(&repo_id, &false),
        Err(Ok(Error::InvalidStatus))
    );
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(w.repo.check_margin(&repo_id), Status::Defaulted);
    assert_eq!(w.repo.open_debt(&w.tbenji), DEBT);

    let lender_before = w.usdc.balance(&w.lender);
    let treasury_before = w.usdc.balance(&w.treasury);
    let borrower_before = w.usdc.balance(&w.borrower);
    let tbenji_before = w.tbenji_token.balance(&w.borrower);

    w.repo.repay(&repo_id);

    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
    assert_eq!(w.repo.open_debt(&w.tbenji), 0);
    assert_eq!(w.usdc.balance(&w.lender) - lender_before, LENDER_DUE);
    assert_eq!(w.usdc.balance(&w.treasury) - treasury_before, FEE);
    assert_eq!(borrower_before - w.usdc.balance(&w.borrower), DEBT);
    assert_eq!(
        w.tbenji_token.balance(&w.borrower) - tbenji_before,
        TAKE_COLLATERAL
    );
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);
    // The hand repay drops this repo's share of the auto-repay allowance.
    assert_eq!(w.usdc.allowance(&w.borrower, &w.repo.address), 0);
}

/// Repay first, then a liquidator arrives: liquidate sees Repaid and fails
/// with InvalidStatus; nothing moves.
#[test]
fn repay_out_of_defaulted_then_liquidate_is_invalid_status() {
    let w = world();
    let repo_id = w.defaulted_auto();
    w.repo.repay(&repo_id);

    w.set_nav(ONE, MATURED);
    let liq_usdc = w.usdc.balance(&w.liquidator);
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &repo_id),
        Err(Ok(Error::InvalidStatus))
    );
    assert_eq!(w.usdc.balance(&w.liquidator), liq_usdc);
    assert_eq!(w.tbenji_token.balance(&w.liquidator), 0);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
}

/// Liquidate first, then the borrower tries to repay: InvalidStatus, so a
/// repo is never settled twice.
#[test]
fn liquidate_then_repay_is_invalid_status() {
    let w = world();
    let repo_id = w.defaulted_auto();
    w.set_nav(ONE, MATURED);
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(w.repo.try_repay(&repo_id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
}

/// A missed margin call defaults the repo; the borrower can still repay it,
/// and needs no fresh NAV to do so (#6).
#[test]
fn missed_margin_call_default_is_repayable_with_stale_nav() {
    let w = world();
    let repo_id = w.take(false);
    w.set_nav(ONE * 95 / 100, NOW);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);
    let deadline = w.repo.repo(&repo_id).margin_call_deadline.unwrap();
    w.t(deadline + 1);
    w.set_nav(ONE * 95 / 100, deadline + 1);
    assert_eq!(w.repo.default(&repo_id), Status::Defaulted);

    // NAV goes stale; repay still works.
    w.t(deadline + 1 + DEMO_NAV_AGE + 1);
    w.repo.repay(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
    assert_eq!(w.repo.open_debt(&w.tbenji), 0);
}
