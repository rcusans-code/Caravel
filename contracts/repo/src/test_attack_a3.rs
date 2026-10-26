//! Attack angle A3 / ECO-01 (DECISIONS.md #26): the margin trigger has its own
//! per-asset field, `AssetConfig.margin_trigger_bps`, with
//! `liquidation_discount_bps ≤ trigger < haircut_bps`. Before, the call fired
//! on the discount line itself (NAV 0.989796 at haircut 300 / discount 200),
//! so any NAV drop during the margin window left the lender short. At
//! trigger 250 the call fires at NAV < 0.994872 and a liquidation on the call
//! line raises 0.98 / 0.975 − 1 = 0.51% more than the debt.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Event as _,
};

use crate::{
    events, math,
    oracle::mock::{setup_mock_oracle, MockOracleClient, MOCK_DECIMALS, ONE},
    test::{
        demo_config, APR_BPS, DEMO_NAV_AGE, NOW, NO_CAP, PRINCIPAL, TERM_SECS, UNIT, WIDE_BAND_BPS,
    },
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Error, Status,
};

/// Full-term interest on `PRINCIPAL` at `APR_BPS` over `TERM_SECS` (demo days).
const INTEREST: i128 = 9_301_370;
const DEBT: i128 = PRINCIPAL + INTEREST;
/// 10% of interest.
const FEE: i128 = 930_137;
const LENDER_DUE: i128 = DEBT - FEE;
/// Max-LTV take at NAV 1.00 and a 3% haircut.
const TAKE_COLLATERAL: i128 = 10_009_589_042;
const HAIRCUT: u32 = 300;
/// Demo and launch trigger for tBENJI / tSAFO (#26).
const TRIGGER: u32 = 250;
/// `Config.liquidation_discount_bps` in `demo_config`.
const DISCOUNT: u32 = 200;
/// The call line at trigger 250 is NAV 0.99487179…: just above it, just below.
const ABOVE_250_LINE: i128 = 99_487_200_000_000; // 0.994872
const BELOW_250_LINE: i128 = 99_487_100_000_000; // 0.994871
/// The old call line (trigger = discount 200) is NAV 0.98979591…
const BELOW_200_LINE: i128 = 98_979_500_000_000; // 0.989795

fn asset_cfg(token: &Address, haircut_bps: u32, margin_trigger_bps: u32) -> AssetConfig {
    AssetConfig {
        oracle_asset: Asset::Stellar(token.clone()),
        haircut_bps,
        margin_trigger_bps,
        enabled: true,
        max_nav_age_secs: DEMO_NAV_AGE,
        max_nav_move_bps: WIDE_BAND_BPS,
        nav_floor: None,
        nav_ceiling: None,
        max_open_debt: NO_CAP,
        band_settle_secs: crate::test::SETTLE_SECS,
    }
}

struct W<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    tbenji: Address,
    oracle: MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
    treasury: Address,
}

/// Repo contract, USDC + tBENJI SACs, mock feed at NAV 1.00, tBENJI listed at
/// haircut 300 and the given trigger, a funded lender, borrower, liquidator.
fn world<'a>(trigger: u32) -> W<'a> {
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
    repo.set_asset(&tbenji, &asset_cfg(&tbenji, HAIRCUT, trigger));

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &(10_000 * UNIT));
    usdc_admin.mint(&borrower, &(100 * UNIT));
    usdc_admin.mint(&liquidator, &(2_000 * UNIT));
    StellarAssetClient::new(&env, &tbenji).mint(&borrower, &(5_000 * UNIT));
    repo.set_liquidator(&liquidator, &true);

    W {
        usdc: TokenClient::new(&env, &usdc),
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
    fn take(&self) -> u64 {
        let offer =
            self.repo
                .create_offer(&self.lender, &self.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
        let id = self.repo.take_offer(&self.borrower, &offer, &false);
        let repo = self.repo.repo(&id);
        assert_eq!(repo.collateral_amount, TAKE_COLLATERAL);
        assert_eq!(repo.interest, INTEREST);
        id
    }
    fn set_nav(&self, price: i128, ts: u64) {
        self.env.ledger().set_timestamp(ts);
        self.oracle
            .set_price(&Asset::Stellar(self.tbenji.clone()), &price, &ts);
    }
}

#[test]
fn a3_trigger_250_calls_below_nav_0_994872() {
    let w = world(TRIGGER);
    let id = w.take();

    // Max-LTV take at NAV 1.00 opens below the trigger.
    assert_eq!(w.repo.check_margin(&id), Status::Open);

    // Just above the call line: still healthy.
    w.set_nav(ABOVE_250_LINE, NOW + 10);
    assert_eq!(w.repo.check_margin(&id), Status::Open);

    // Just below it: called.
    w.set_nav(BELOW_250_LINE, NOW + 20);
    assert_eq!(w.repo.check_margin(&id), Status::MarginCall);
    assert_eq!(w.repo.repo(&id).margin_call_deadline, Some(NOW + 20 + 120));
}

#[test]
fn a3_trigger_on_discount_line_waits_until_nav_0_989796() {
    // The pre-#26 behaviour, still allowed at trigger = discount: no call
    // anywhere above the zero-buffer line.
    let w = world(DISCOUNT);
    let id = w.take();
    w.set_nav(BELOW_250_LINE, NOW + 10);
    assert_eq!(w.repo.check_margin(&id), Status::Open);
    w.set_nav(BELOW_200_LINE, NOW + 20);
    assert_eq!(w.repo.check_margin(&id), Status::MarginCall);
}

#[test]
fn a3_liquidation_at_the_call_line_pays_0_51_pct_over_debt() {
    let w = world(TRIGGER);
    let id = w.take();

    w.set_nav(BELOW_250_LINE, NOW + 10);
    assert_eq!(w.repo.check_margin(&id), Status::MarginCall);

    // Window missed, NAV unchanged (age 121 s < 180 s): still past the
    // trigger, so `default` does not clear it.
    w.env.ledger().set_timestamp(NOW + 10 + 120 + 1);
    assert_eq!(w.repo.default(&id), Status::Defaulted);

    let lender_before = w.usdc.balance(&w.lender);
    let treasury_before = w.usdc.balance(&w.treasury);
    let borrower_before = w.usdc.balance(&w.borrower);
    let liquidator_before = w.usdc.balance(&w.liquidator);
    w.repo.liquidate(&w.liquidator, &id);
    let events = w
        .env
        .events()
        .all()
        .filter_by_contract(&w.repo.address)
        .events()
        .to_vec();

    let proceeds = liquidator_before - w.usdc.balance(&w.liquidator);
    let surplus = proceeds - DEBT;
    // 0.98 / 0.975 − 1 = 0.5128% at the line; a hair less just below it.
    // In millionths of the debt: 5127.4.
    assert_eq!(surplus * 1_000_000 / DEBT, 5_127);
    assert_eq!(w.usdc.balance(&w.lender) - lender_before, LENDER_DUE);
    assert_eq!(w.usdc.balance(&w.treasury) - treasury_before, FEE);
    assert_eq!(w.usdc.balance(&w.borrower) - borrower_before, surplus);
    assert_eq!(w.repo.repo(&id).status, Status::Liquidated);

    // Paid in full: `Liquidated` is the only event, no `Shortfall`.
    assert_eq!(
        events,
        [events::Liquidated {
            repo_id: id,
            liquidator: w.liquidator.clone(),
            proceeds,
            lender_amount: LENDER_DUE,
            fee: FEE,
            borrower_amount: surplus,
            nav: BELOW_250_LINE,
            nav_decimals: MOCK_DECIMALS,
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
}

#[test]
fn a3_trigger_bounds_are_discount_inclusive_haircut_exclusive() {
    let w = world(TRIGGER);
    let token = Address::generate(&w.env);
    for bad in [0, DISCOUNT - 1, HAIRCUT, HAIRCUT + 1] {
        assert_eq!(
            w.repo
                .try_set_asset(&token, &asset_cfg(&token, HAIRCUT, bad)),
            Err(Ok(Error::InvalidConfig))
        );
    }
    for good in [DISCOUNT, TRIGGER, HAIRCUT - 1] {
        let fresh = Address::generate(&w.env);
        let cfg = asset_cfg(&fresh, HAIRCUT, good);
        w.repo.set_asset(&fresh, &cfg);
        assert_eq!(w.repo.asset(&fresh), cfg);
    }
    // propose_asset validates the same way.
    assert_eq!(
        w.repo
            .try_propose_asset(&w.tbenji, &asset_cfg(&w.tbenji, HAIRCUT, HAIRCUT)),
        Err(Ok(Error::InvalidConfig))
    );
}

#[test]
fn a3_raising_the_trigger_tightens_lowering_loosens() {
    let w = world(TRIGGER);

    // Lower: loosens, for the admin's instant path and the guardian's.
    let lower = asset_cfg(&w.tbenji, HAIRCUT, DISCOUNT);
    assert_eq!(
        w.repo.try_set_asset(&w.tbenji, &lower),
        Err(Ok(Error::Loosens))
    );
    assert_eq!(
        w.repo.try_guardian_set_asset(&w.tbenji, &lower),
        Err(Ok(Error::Loosens))
    );

    // Raise: instant for the guardian, and the event carries the field.
    let higher = asset_cfg(&w.tbenji, HAIRCUT, 280);
    w.repo.guardian_set_asset(&w.tbenji, &higher);
    let event = events::AssetConfigured {
        asset: w.tbenji.clone(),
        haircut_bps: HAIRCUT,
        margin_trigger_bps: 280,
        enabled: true,
        max_nav_age_secs: DEMO_NAV_AGE,
        max_nav_move_bps: WIDE_BAND_BPS,
        nav_floor: None,
        nav_ceiling: None,
        max_open_debt: NO_CAP,
        band_settle_secs: crate::test::SETTLE_SECS,
    };
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [event.to_xdr(&w.env, &w.repo.address)]
    );
    assert_eq!(w.repo.asset(&w.tbenji), higher);

    // Lowering goes through the timelock.
    let eta = w.repo.propose_asset(&w.tbenji, &lower);
    w.env.ledger().set_timestamp(eta);
    w.repo.execute_asset(&w.tbenji);
    assert_eq!(w.repo.asset(&w.tbenji).margin_trigger_bps, DISCOUNT);
}

#[test]
fn a3_raised_trigger_is_clamped_below_the_repos_haircut() {
    // A live repo snapshotted haircut 300. The guardian re-tiers the asset to
    // haircut 500 / trigger 400, above the snapshot. Raven UA-01 / D3: the
    // repo is checked at min(400, 300 − 1) = 299, so at NAV 1.00 (debt 0.97
    // × value, not past 0.9701 × value) it is not margin-called.
    let w = world(TRIGGER);
    let id = w.take();
    w.repo
        .guardian_set_asset(&w.tbenji, &asset_cfg(&w.tbenji, 500, 400));
    assert_eq!(w.repo.check_margin(&id), Status::Open);

    // A real NAV dip past the clamped line (0.97 / 0.9701 ≈ 0.999897) still
    // calls it, and a top-up back to initial margin at the snapshot haircut
    // clears it: the call is always curable at the repo's own terms.
    let dip = 999 * ONE / 1_000;
    w.set_nav(dip, NOW + 1);
    assert_eq!(w.repo.check_margin(&id), Status::MarginCall);
    w.repo.top_up(&id, &1);
    assert_eq!(w.repo.repo(&id).status, Status::MarginCall);
    let required = math::required_collateral(DEBT, 999, 3, HAIRCUT).unwrap();
    w.repo.top_up(&id, &(required - TAKE_COLLATERAL));
    let repo = w.repo.repo(&id);
    assert_eq!(repo.status, Status::Open);
    assert_eq!(repo.margin_call_deadline, None);
    assert_eq!(w.repo.check_margin(&id), Status::Open);
}
