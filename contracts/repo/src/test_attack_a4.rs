//! Attack angle A4 (COR-02): a missed margin call defaults only on a fresh,
//! in-band NAV that confirms the breach. A stale, missing or out-of-band NAV
//! makes `default` wait with the oracle error; maturity defaults need no NAV.
//! Harness trimmed from the post-implementation attack suite (SAC world).

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Event as _,
};

use crate::{
    events,
    oracle::mock::{setup_mock_oracle, MockOracleClient, ONE},
    test::{
        demo_config, APR_BPS, DEMO_NAV_AGE, NOW, NO_CAP, PRINCIPAL, TERM_SECS, TRIGGER_BPS, UNIT,
        WIDE_BAND_BPS,
    },
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, DefaultReason, Error, Status,
};

const GRACE_SECS: u64 = 60;
const MATURED: u64 = NOW + TERM_SECS + GRACE_SECS + 1;
const TAKE_COLLATERAL: i128 = 10_009_589_042;

struct W<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    tbenji: Address,
    tbenji_token: TokenClient<'a>,
    oracle: MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
}

fn asset_cfg(token: &Address, max_nav_move_bps: u32) -> AssetConfig {
    AssetConfig {
        oracle_asset: Asset::Stellar(token.clone()),
        haircut_bps: 300,
        margin_trigger_bps: TRIGGER_BPS,
        enabled: true,
        max_nav_age_secs: DEMO_NAV_AGE,
        max_nav_move_bps,
        nav_floor: None,
        nav_ceiling: None,
        max_open_debt: NO_CAP,
        band_settle_secs: crate::test::SETTLE_SECS,
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
    let id = env.register(CaravelRepo, (config,));
    let repo = CaravelRepoClient::new(&env, &id);
    repo.set_asset(&tbenji, &asset_cfg(&tbenji, WIDE_BAND_BPS));

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
        tbenji_token: TokenClient::new(&env, &tbenji),
        repo,
        tbenji,
        oracle,
        lender,
        borrower,
        liquidator,
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
    /// Margin call at NAV 0.95, NAV back to 1.00 a second later.
    fn called_then_recovered(&self, auto: bool) -> (u64, u64) {
        let repo_id = self.take(auto);
        self.set_nav(ONE * 95 / 100, NOW);
        assert_eq!(self.repo.check_margin(&repo_id), Status::MarginCall);
        let deadline = self.repo.repo(&repo_id).margin_call_deadline.unwrap();
        self.set_nav(ONE, NOW + 1);
        (repo_id, deadline)
    }
    fn last_repo_event(&self) -> soroban_sdk::xdr::ContractEvent {
        let all = self.env.events().all();
        let evs = all.filter_by_contract(&self.repo.address).events().to_vec();
        evs.last().unwrap().clone()
    }
}

/// COR-02 flipped (was `cor_stale_nav_default_then_liquidate_chain`): past
/// the deadline with a stale NAV, `default` returns StaleNav and the repo
/// stays in MarginCall; a fresh healthy NAV then clears the call (Open +
/// MarginCleared). The borrower never loses the 2% liquidation discount on
/// collateral that no fresh post-deadline price showed in breach.
#[test]
fn cor_stale_nav_default_then_liquidate_chain() {
    let w = world();
    let (repo_id, deadline) = w.called_then_recovered(false);

    let late = NOW + 1 + DEMO_NAV_AGE + 1;
    assert!(late > deadline, "deadline {deadline}");
    w.t(late);
    assert_eq!(w.repo.try_check_margin(&repo_id), Err(Ok(Error::StaleNav)));
    let before = w.repo.repo(&repo_id);
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::StaleNav)));
    assert_eq!(w.repo.repo(&repo_id), before);
    assert_eq!(before.status, Status::MarginCall);
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &repo_id),
        Err(Ok(Error::InvalidStatus))
    );

    // Fresh NAV 1.00: healthy, the call clears instead of defaulting.
    w.set_nav(ONE, late);
    assert_eq!(w.repo.default(&repo_id), Status::Open);
    assert_eq!(
        w.last_repo_event(),
        events::MarginCleared { repo_id }.to_xdr(&w.env, &w.repo.address)
    );
    let repo = w.repo.repo(&repo_id);
    assert_eq!(repo.status, Status::Open);
    assert_eq!(repo.margin_call_deadline, None);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);

    // The borrower can repay as normal: nothing was seized.
    let usdc_before = w.usdc.balance(&w.borrower);
    w.repo.repay(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
    assert!(w.usdc.balance(&w.borrower) < usdc_before);
}

/// A fresh NAV that confirms the breach after a stale spell still defaults.
#[test]
fn a4_stale_then_fresh_breach_defaults() {
    let w = world();
    let (repo_id, _) = w.called_then_recovered(false);
    let late = NOW + 1 + DEMO_NAV_AGE + 1;
    w.t(late);
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::StaleNav)));
    w.set_nav(ONE * 95 / 100, late);
    assert_eq!(w.repo.default(&repo_id), Status::Defaulted);
    assert_eq!(
        w.last_repo_event(),
        events::Defaulted {
            repo_id,
            reason: DefaultReason::MarginCall,
        }
        .to_xdr(&w.env, &w.repo.address)
    );
}

/// An out-of-band NAV past the deadline returns NavOutOfBand: no default, no
/// clear.
#[test]
fn a4_out_of_band_nav_waits() {
    let w = world();
    let repo_id = w.take(false);
    w.set_nav(ONE * 95 / 100, NOW);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);
    let deadline = w.repo.repo(&repo_id).margin_call_deadline.unwrap();
    // Band of 1% on the 0.95 record: a jump to 1.00 is out of band.
    w.repo
        .guardian_set_asset(&w.tbenji, &asset_cfg(&w.tbenji, 100));
    w.t(deadline + 1);
    w.set_nav(ONE, deadline + 1);
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::NavOutOfBand)));
    assert_eq!(w.repo.repo(&repo_id).status, Status::MarginCall);
}

/// An opted-in repo waits too: no auto-repay pull on a stale price.
#[test]
fn a4_stale_nav_waits_before_auto_repay() {
    let w = world();
    let (repo_id, _) = w.called_then_recovered(true);
    let late = NOW + 1 + DEMO_NAV_AGE + 1;
    w.t(late);
    let usdc_before = w.usdc.balance(&w.borrower);
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::StaleNav)));
    assert_eq!(w.usdc.balance(&w.borrower), usdc_before);
    assert_eq!(w.repo.repo(&repo_id).status, Status::MarginCall);
}

/// Maturity defaults are unchanged: no NAV read, a stale price never blocks.
#[test]
fn a4_maturity_default_ignores_stale_nav() {
    let w = world();
    let (repo_id, _) = w.called_then_recovered(false);
    w.t(MATURED);
    assert_eq!(w.repo.default(&repo_id), Status::Defaulted);
}
