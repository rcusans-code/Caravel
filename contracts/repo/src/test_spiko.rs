//! Spiko-style collateral (tSAFO, issue #20, DECISIONS.md #28, #29): the full repo
//! flow on `caravel-spiko-mock`, a custom Soroban token with an allowlist on
//! every transfer, no `approve` / `transfer_from`, an issuer pause and
//! 5 decimals like Spiko's mainnet tokens.

extern crate std;

use caravel_spiko_mock::{SpikoError, SpikoMock, SpikoMockClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, InvokeError, String,
};

use crate::{
    math,
    oracle::mock::{setup_mock_oracle, MockOracleClient, ONE},
    test::{NO_CAP, WIDE_BAND_BPS},
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Config, Error, Status,
};

const UNIT: i128 = 10_000_000; // 1 USDC
const SAFO: i128 = 100_000; // 1 tSAFO (5 decimals)
const NOW: u64 = 1_000;
const PRINCIPAL: i128 = 970 * UNIT;
const APR_BPS: u32 = 500;
const TERM_SECS: u64 = 7 * 60;
const GRACE_SECS: u64 = 60;
const MATURED: u64 = NOW + TERM_SECS + GRACE_SECS + 1;
/// Tier 5 (docs/collateral-research.md §3), scripts/deploy.sh default.
const SAFO_HAIRCUT_BPS: u32 = 3_000;

// Same offer as test.rs: 970 USDC, 7 demo days, 5% APR, fee 10% of interest.
const INTEREST: i128 = 9_301_370;
const DEBT: i128 = PRINCIPAL + INTEREST;
const FEE: i128 = 930_137;
const LENDER_DUE: i128 = DEBT - FEE;
/// DEBT / (1.00 × 0.70) = 13_870_430_529 USDC units, in 5-decimal tSAFO
/// units rounded up: 1_387.04306 tSAFO.
const TAKE_COLLATERAL: i128 = 138_704_306;

struct World<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    safo: SpikoMockClient<'a>,
    oracle: MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
    treasury: Address,
}

fn config(env: &Env, usdc: &Address, oracle: &Address) -> Config {
    Config {
        admin: Address::generate(env),
        usdc: usdc.clone(),
        oracle: oracle.clone(),
        treasury: Address::generate(env),
        fee_bps: 1_000,
        liquidation_discount_bps: 200,
        day_secs: 60,
        margin_window_secs: 120,
        grace_secs: GRACE_SECS,
    }
}

fn spiko_token<'a>(env: &Env, decimals: u32) -> SpikoMockClient<'a> {
    let id = env.register(
        SpikoMock,
        (
            Address::generate(env),
            String::from_str(env, "Test Spiko SAFO"),
            String::from_str(env, "tSAFO"),
            decimals,
        ),
    );
    SpikoMockClient::new(env, &id)
}

/// Repo contract with real USDC (SAC), tSAFO (Spiko mock, 5 decimals) at
/// NAV 1.00 and a 30% haircut. Spiko has allowlisted the repo contract, the
/// borrower and the liquidator; the lender never touches tSAFO.
fn world<'a>() -> World<'a> {
    world_with_decimals(5)
}

fn world_with_decimals<'a>(decimals: u32) -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let usdc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let safo = spiko_token(&env, decimals);
    let oracle = MockOracleClient::new(&env, &setup_mock_oracle(&env));
    oracle.set_price(&Asset::Stellar(safo.address.clone()), &ONE, &NOW);

    let cfg = config(&env, &usdc, &oracle.address);
    let treasury = cfg.treasury.clone();
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (cfg,)));
    repo.set_asset(
        &safo.address,
        &AssetConfig {
            oracle_asset: Asset::Stellar(safo.address.clone()),
            haircut_bps: SAFO_HAIRCUT_BPS,
            enabled: true,
            max_nav_age_secs: 180,
            max_nav_move_bps: WIDE_BAND_BPS,
            nav_floor: None,
            nav_ceiling: None,
            max_open_debt: NO_CAP,
        },
    );

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    repo.set_liquidator(&liquidator, &true);
    for who in [&repo.address, &borrower, &liquidator] {
        safo.set_whitelisted(who, &true);
    }
    let one = 10i128.pow(decimals);
    safo.mint(&borrower, &(5_000 * one));
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &(10_000 * UNIT));
    usdc_admin.mint(&borrower, &(100 * UNIT));
    usdc_admin.mint(&liquidator, &(2_000 * UNIT));

    World {
        usdc: TokenClient::new(&env, &usdc),
        repo,
        safo,
        oracle,
        lender,
        borrower,
        liquidator,
        treasury,
        env,
    }
}

impl World<'_> {
    fn offer(&self) -> u64 {
        self.repo.create_offer(
            &self.lender,
            &self.safo.address,
            &PRINCIPAL,
            &APR_BPS,
            &TERM_SECS,
        )
    }

    fn take(&self) -> u64 {
        let offer_id = self.offer();
        self.repo.take_offer(&self.borrower, &offer_id, &false)
    }

    fn set_nav(&self, price: i128, timestamp: u64) {
        self.oracle.set_price(
            &Asset::Stellar(self.safo.address.clone()),
            &price,
            &timestamp,
        );
    }

    fn defaulted(&self) -> u64 {
        let repo_id = self.take();
        self.env.ledger().set_timestamp(MATURED);
        self.repo.default(&repo_id);
        self.set_nav(ONE, MATURED);
        repo_id
    }
}

/// What a Spiko-side rejection looks like from Caravel's client: the
/// token's own error code, not a Caravel `Error` and not a host panic.
fn spiko<T>(e: SpikoError) -> Result<T, Result<Error, InvokeError>> {
    Err(Err(InvokeError::Contract(e as u32)))
}

// --- happy path --------------------------------------------------------------

/// The no-approve take (collateral-research §4 check): the borrower signs
/// only `take_offer` with the tSAFO transfer nested inside it. No allowance
/// exists or is needed; strict auth (no `mock_all_auths`) proves it.
#[test]
fn take_offer_works_without_approve() {
    let w = world();
    let offer_id = w.offer();

    let transfer = MockAuthInvoke {
        contract: &w.safo.address,
        fn_name: "transfer",
        args: (w.borrower.clone(), w.repo.address.clone(), TAKE_COLLATERAL).into_val(&w.env),
        sub_invokes: &[],
    };
    w.env.mock_auths(&[MockAuth {
        address: &w.borrower,
        invoke: &MockAuthInvoke {
            contract: &w.repo.address,
            fn_name: "take_offer",
            args: (w.borrower.clone(), offer_id, false).into_val(&w.env),
            sub_invokes: &[transfer],
        },
    }]);
    let repo_id = w.repo.take_offer(&w.borrower, &offer_id, &false);
    w.env.mock_all_auths();

    let repo = w.repo.repo(&repo_id);
    assert_eq!(repo.collateral_asset, w.safo.address);
    assert_eq!(repo.collateral_amount, TAKE_COLLATERAL);
    assert_eq!(repo.haircut_bps, SAFO_HAIRCUT_BPS);
    assert_eq!(repo.interest, INTEREST);
    assert_eq!(repo.status, Status::Open);

    assert_eq!(w.safo.balance(&w.repo.address), TAKE_COLLATERAL);
    assert_eq!(w.safo.balance(&w.borrower), 5_000 * SAFO - TAKE_COLLATERAL);
    assert_eq!(w.usdc.balance(&w.borrower), 100 * UNIT + PRINCIPAL);
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
}

/// A signature for any other tSAFO amount does not cover the take (#21).
#[test]
fn take_offer_signature_pins_spiko_amount() {
    let w = world();
    let offer_id = w.offer();
    let transfer = MockAuthInvoke {
        contract: &w.safo.address,
        fn_name: "transfer",
        args: (
            w.borrower.clone(),
            w.repo.address.clone(),
            TAKE_COLLATERAL - 1,
        )
            .into_val(&w.env),
        sub_invokes: &[],
    };
    w.env.mock_auths(&[MockAuth {
        address: &w.borrower,
        invoke: &MockAuthInvoke {
            contract: &w.repo.address,
            fn_name: "take_offer",
            args: (w.borrower.clone(), offer_id, false).into_val(&w.env),
            sub_invokes: &[transfer],
        },
    }]);
    assert!(w
        .repo
        .try_take_offer(&w.borrower, &offer_id, &false)
        .is_err());
    w.env.mock_all_auths();
    assert_eq!(w.safo.balance(&w.repo.address), 0);
}

/// Collateral is posted in the token's own 5-decimal units (#28): the same
/// USDC value as a 7-decimal token, to within one 5-decimal unit (round up).
#[test]
fn collateral_is_in_token_units() {
    let value_needed = math::required_collateral(DEBT, ONE, 14, SAFO_HAIRCUT_BPS).unwrap();
    assert_eq!(value_needed, 13_870_430_529);
    assert_eq!(TAKE_COLLATERAL, (value_needed + 99) / 100);

    let five = world_with_decimals(5);
    let seven = world_with_decimals(7);
    let c5 = five.repo.repo(&five.take()).collateral_amount;
    let c7 = seven.repo.repo(&seven.take()).collateral_amount;
    assert_eq!(c5, TAKE_COLLATERAL);
    assert_eq!(c7, value_needed);
    assert!(c5 * 100 >= c7 && c5 * 100 - c7 < 100);

    // And the 5-decimal take is the minimum that passes the haircut check.
    let (nav, dec) = crate::oracle::scale_for_token(ONE, 14, 5).unwrap();
    assert_eq!(dec, 12);
    assert!(math::ltv_ok(DEBT, c5, nav, dec, SAFO_HAIRCUT_BPS).unwrap());
    assert!(!math::ltv_ok(DEBT, c5 - 1, nav, dec, SAFO_HAIRCUT_BPS).unwrap());
}

#[test]
fn repay_returns_spiko_collateral() {
    let w = world();
    let repo_id = w.take();
    w.repo.repay(&repo_id);

    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
    assert_eq!(w.safo.balance(&w.repo.address), 0);
    assert_eq!(w.safo.balance(&w.borrower), 5_000 * SAFO);
    assert_eq!(
        w.usdc.balance(&w.lender),
        10_000 * UNIT - PRINCIPAL + LENDER_DUE
    );
    assert_eq!(w.usdc.balance(&w.treasury), FEE);
    assert_eq!(w.usdc.balance(&w.borrower), 100 * UNIT + PRINCIPAL - DEBT);
}

/// NAV falls 30%: margin call; topping up to the initial margin clears it.
#[test]
fn top_up_clears_spiko_margin_call() {
    let w = world();
    let repo_id = w.take();
    w.set_nav(ONE * 70 / 100, NOW);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);

    // At NAV 0.70 the initial margin needs DEBT / (0.70 × 0.70) of tSAFO.
    let (nav, dec) = crate::oracle::scale_for_token(ONE * 70 / 100, 14, 5).unwrap();
    let need = math::required_collateral(DEBT, nav, dec, SAFO_HAIRCUT_BPS).unwrap();
    let short = need - TAKE_COLLATERAL;
    w.repo.top_up(&repo_id, &(short - 1));
    assert_eq!(w.repo.repo(&repo_id).status, Status::MarginCall);
    w.repo.top_up(&repo_id, &1);

    let repo = w.repo.repo(&repo_id);
    assert_eq!(repo.status, Status::Open);
    assert_eq!(repo.collateral_amount, need);
    assert_eq!(w.safo.balance(&w.repo.address), need);
}

#[test]
fn default_then_liquidate_to_allowlisted_liquidator() {
    let w = world();
    let repo_id = w.defaulted();
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
    let borrower_usdc = w.usdc.balance(&w.borrower);

    w.repo.liquidate(&w.liquidator, &repo_id);

    // Liquidator pays NAV × 0.98 for 1_387.04306 tSAFO, rounded up.
    let proceeds = 13_593_021_988;
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
    assert_eq!(w.safo.balance(&w.liquidator), TAKE_COLLATERAL);
    assert_eq!(w.safo.balance(&w.repo.address), 0);
    assert_eq!(w.usdc.balance(&w.liquidator), 2_000 * UNIT - proceeds);
    assert_eq!(
        w.usdc.balance(&w.lender),
        10_000 * UNIT - PRINCIPAL + LENDER_DUE
    );
    assert_eq!(w.usdc.balance(&w.treasury), FEE);
    assert_eq!(w.usdc.balance(&w.borrower), borrower_usdc + proceeds - DEBT);
}

// --- allowlist and pause (issuer controls) ------------------------------------

#[test]
fn take_offer_rejects_borrower_not_allowlisted() {
    let w = world();
    let offer_id = w.offer();
    w.safo.set_whitelisted(&w.borrower, &false);

    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &false),
        spiko(SpikoError::NotWhitelisted)
    );
    // Atomic: offer still open, USDC still escrowed, no repo.
    assert_eq!(w.repo.offer(&offer_id).principal, PRINCIPAL);
    assert_eq!(w.usdc.balance(&w.repo.address), PRINCIPAL);
    assert_eq!(w.repo.try_repo(&1), Err(Ok(Error::RepoNotFound)));
}

#[test]
fn take_offer_rejects_repo_contract_not_allowlisted() {
    let w = world();
    let offer_id = w.offer();
    w.safo.set_whitelisted(&w.repo.address, &false);

    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &false),
        spiko(SpikoError::NotWhitelisted)
    );
    assert_eq!(w.safo.balance(&w.borrower), 5_000 * SAFO);
    assert_eq!(w.usdc.balance(&w.repo.address), PRINCIPAL);
}

/// Caravel's liquidator whitelist is not enough: Spiko must allowlist every
/// liquidator too, or the defaulted collateral cannot move.
#[test]
fn liquidate_rejects_liquidator_not_allowlisted_on_token() {
    let w = world();
    let repo_id = w.defaulted();
    let other = Address::generate(&w.env);
    w.repo.set_liquidator(&other, &true);
    StellarAssetClient::new(&w.env, &w.usdc.address).mint(&other, &(2_000 * UNIT));

    assert_eq!(
        w.repo.try_liquidate(&other, &repo_id),
        spiko(SpikoError::NotWhitelisted)
    );
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
    assert_eq!(w.usdc.balance(&other), 2_000 * UNIT);

    w.safo.set_whitelisted(&other, &true);
    w.repo.liquidate(&other, &repo_id);
    assert_eq!(w.safo.balance(&other), TAKE_COLLATERAL);
}

#[test]
fn paused_token_blocks_take() {
    let w = world();
    let offer_id = w.offer();
    w.safo.pause();
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer_id, &false),
        spiko(SpikoError::Paused)
    );
    w.safo.unpause();
    w.repo.take_offer(&w.borrower, &offer_id, &false);
}

/// Issuer risk (README "Risks"): a pause freezes the borrower's exit and the
/// lender's recovery alike. Nothing is lost; every call works after unpause.
#[test]
fn paused_token_freezes_repay_top_up_and_liquidate() {
    let w = world();
    let repo_id = w.take();
    let defaulted = w.take();
    w.env.ledger().set_timestamp(MATURED);
    w.set_nav(ONE, MATURED);
    w.safo.pause();

    assert_eq!(w.repo.try_repay(&repo_id), spiko(SpikoError::Paused));
    assert_eq!(
        w.repo.try_top_up(&repo_id, &SAFO),
        spiko(SpikoError::Paused)
    );
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);

    w.repo.default(&defaulted); // moves no tokens, so a pause cannot block it
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &defaulted),
        spiko(SpikoError::Paused)
    );
    assert_eq!(w.repo.repo(&defaulted).status, Status::Defaulted);

    w.safo.unpause();
    w.repo.repay(&repo_id);
    w.repo.liquidate(&w.liquidator, &defaulted);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
    assert_eq!(w.repo.repo(&defaulted).status, Status::Liquidated);
}

/// Issuer risk: if Spiko removes the borrower after the take, repay cannot
/// return the collateral, so it reverts. The lender is still protected:
/// the repo defaults and an allowlisted liquidator takes the collateral.
#[test]
fn borrower_removed_after_take_cannot_repay_but_lender_recovers() {
    let w = world();
    let repo_id = w.take();
    w.safo.set_whitelisted(&w.borrower, &false);
    assert_eq!(
        w.repo.try_repay(&repo_id),
        spiko(SpikoError::NotWhitelisted)
    );
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);

    w.env.ledger().set_timestamp(MATURED);
    w.repo.default(&repo_id);
    w.set_nav(ONE, MATURED);
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(
        w.usdc.balance(&w.lender),
        10_000 * UNIT - PRINCIPAL + LENDER_DUE
    );
}
