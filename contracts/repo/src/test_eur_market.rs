//! EUR market (DECISIONS.md #52): the same wasm deployed with
//! `Config.quote = EUR`, a EUR-based feed and a 7-decimal EURC-like loan
//! token. Every amount the lender, treasury, borrower and liquidator move is
//! in that token; the math is unchanged, so the numbers below are the USD
//! ones of `test_spiko.rs` (970 at 5% for 7 demo days, tSAFO at NAV 1.00,
//! 30% haircut), now in EURC. The constructor refuses a feed whose base is
//! not the declared quote, and any quote other than USD or EUR.

extern crate std;

use caravel_spiko_mock::{SpikoMock, SpikoMockClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Symbol,
};

use crate::{
    oracle::mock::{MOCK_DECIMALS, ONE},
    test::{demo_config, NO_CAP, SETTLE_SECS, TRIGGER_BPS, WIDE_BAND_BPS},
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Config, Status,
};

const UNIT: i128 = 10_000_000; // 1 EURC (7 decimals, like Circle EURC)
const SAFO: i128 = 100_000; // 1 tSAFO (5 decimals)
const NOW: u64 = 1_000;
const PRINCIPAL: i128 = 970 * UNIT;
const APR_BPS: u32 = 500;
const TERM_SECS: u64 = 7 * 60;
const MATURED: u64 = NOW + TERM_SECS + 60 + 1; // past maturity + demo grace
const SAFO_HAIRCUT_BPS: u32 = 3_000;
const INTEREST: i128 = 9_301_370;
const DEBT: i128 = PRINCIPAL + INTEREST;
const FEE: i128 = 930_137;
const LENDER_DUE: i128 = DEBT - FEE;
/// DEBT / (1.00 EUR × 0.70), in 5-decimal tSAFO units rounded up.
const TAKE_COLLATERAL: i128 = 138_704_306;
/// Liquidator pays NAV × 0.98 for TAKE_COLLATERAL tSAFO, rounded up, in EURC.
const PROCEEDS: i128 = 13_593_021_988;

/// A real SEP-40 mock feed (`contracts/oracle`) quoting in `base`.
fn feed<'a>(env: &Env, base: &str) -> caravel_oracle::MockOracleClient<'a> {
    let id = env.register(
        caravel_oracle::MockOracle,
        (
            Address::generate(env),
            caravel_oracle::Asset::Other(Symbol::new(env, base)),
            MOCK_DECIMALS,
            60u32,
        ),
    );
    caravel_oracle::MockOracleClient::new(env, &id)
}

/// `demo_config` with a 7-decimal loan token, `oracle` and `quote`.
fn config(env: &Env, loan: &Address, oracle: &Address, quote: &str) -> Config {
    let mut c = demo_config(env);
    c.usdc = loan.clone();
    c.oracle = oracle.clone();
    c.quote = Symbol::new(env, quote);
    c
}

/// `true` when `__constructor` accepts `config`.
fn ctor_accepts(env: &Env, config: Config) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(CaravelRepo, (config,));
    }))
    .is_ok()
}

struct World<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    eurc: TokenClient<'a>,
    safo: SpikoMockClient<'a>,
    oracle: caravel_oracle::MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
    treasury: Address,
}

/// EUR market: EUR feed, `quote EUR`, mock EURC (SAC, 7 decimals) as the
/// loan token, tSAFO listed at NAV 1.00 EUR and a 30% haircut.
fn world<'a>() -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let eurc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let safo_id = env.register(
        SpikoMock,
        (
            Address::generate(&env),
            String::from_str(&env, "Test Spiko SAFO"),
            String::from_str(&env, "tSAFO"),
            5u32,
        ),
    );
    let safo = SpikoMockClient::new(&env, &safo_id);
    let oracle = feed(&env, "EUR");
    oracle.set_price(&caravel_oracle::Asset::Stellar(safo_id.clone()), &ONE);

    let cfg = config(&env, &eurc, &oracle.address, "EUR");
    let treasury = cfg.treasury.clone();
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (cfg,)));
    repo.set_asset(
        &safo_id,
        &AssetConfig {
            oracle_asset: Asset::Stellar(safo_id.clone()),
            haircut_bps: SAFO_HAIRCUT_BPS,
            margin_trigger_bps: TRIGGER_BPS,
            enabled: true,
            max_nav_age_secs: 180,
            max_nav_move_bps: WIDE_BAND_BPS,
            nav_floor: None,
            nav_ceiling: None,
            max_open_debt: NO_CAP,
            band_settle_secs: SETTLE_SECS,
        },
    );

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    crate::test::whitelist(&env, &repo, &liquidator);
    for who in [&repo.address, &borrower, &liquidator] {
        safo.set_whitelisted(who, &true);
    }
    safo.mint(&borrower, &(5_000 * SAFO));
    let eurc_admin = StellarAssetClient::new(&env, &eurc);
    eurc_admin.mint(&lender, &(10_000 * UNIT));
    // The borrower holds EURC for the interest (deploy.sh EUR mode mints it).
    eurc_admin.mint(&borrower, &(100 * UNIT));
    eurc_admin.mint(&liquidator, &(2_000 * UNIT));

    World {
        eurc: TokenClient::new(&env, &eurc),
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
    fn take(&self) -> u64 {
        let offer_id = self.repo.create_offer(
            &self.lender,
            &self.safo.address,
            &PRINCIPAL,
            &APR_BPS,
            &TERM_SECS,
        );
        // The principal sits in escrow, in EURC.
        assert_eq!(self.eurc.balance(&self.repo.address), PRINCIPAL);
        self.repo.take_offer(&self.borrower, &offer_id, &false)
    }
}

#[test]
fn eur_market_offer_take_repay_settle_in_eurc() {
    let w = world();
    assert_eq!(w.repo.config().quote, Symbol::new(&w.env, "EUR"));
    let repo_id = w.take();

    let repo = w.repo.repo(&repo_id);
    assert_eq!(repo.collateral_amount, TAKE_COLLATERAL);
    assert_eq!(repo.interest, INTEREST);
    assert_eq!(w.eurc.balance(&w.borrower), 100 * UNIT + PRINCIPAL);
    assert_eq!(w.eurc.balance(&w.repo.address), 0);

    w.repo.repay(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
    assert_eq!(
        w.eurc.balance(&w.lender),
        10_000 * UNIT - PRINCIPAL + LENDER_DUE
    );
    assert_eq!(w.eurc.balance(&w.treasury), FEE);
    assert_eq!(w.eurc.balance(&w.borrower), 100 * UNIT + PRINCIPAL - DEBT);
    assert_eq!(w.safo.balance(&w.borrower), 5_000 * SAFO);
    assert_eq!(w.safo.balance(&w.repo.address), 0);
}

#[test]
fn eur_market_liquidation_pays_proceeds_in_eurc() {
    let w = world();
    let repo_id = w.take();
    w.env.ledger().set_timestamp(MATURED);
    w.repo.default(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
    // A fresh EUR NAV for the liquidation.
    w.oracle.set_price(
        &caravel_oracle::Asset::Stellar(w.safo.address.clone()),
        &ONE,
    );
    let borrower_eurc = w.eurc.balance(&w.borrower);

    w.repo.liquidate(&w.liquidator, &repo_id);

    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
    assert_eq!(w.safo.balance(&w.liquidator), TAKE_COLLATERAL);
    assert_eq!(w.eurc.balance(&w.liquidator), 2_000 * UNIT - PROCEEDS);
    assert_eq!(
        w.eurc.balance(&w.lender),
        10_000 * UNIT - PRINCIPAL + LENDER_DUE
    );
    assert_eq!(w.eurc.balance(&w.treasury), FEE);
    assert_eq!(w.eurc.balance(&w.borrower), borrower_eurc + PROCEEDS - DEBT);
    assert_eq!(w.eurc.balance(&w.repo.address), 0);
}

/// A EUR market on a USD feed would price EUR debt in dollars.
#[test]
fn ctor_rejects_quote_eur_on_a_usd_feed() {
    let env = Env::default();
    let usd = feed(&env, "USD");
    let eurc = demo_config(&env).usdc;
    assert!(!ctor_accepts(
        &env,
        config(&env, &eurc, &usd.address, "EUR")
    ));
    assert!(ctor_accepts(&env, config(&env, &eurc, &usd.address, "USD")));
}

/// The mirror case: a USD market on the EUR feed.
#[test]
fn ctor_rejects_quote_usd_on_a_eur_feed() {
    let env = Env::default();
    let eur = feed(&env, "EUR");
    let usdc = demo_config(&env).usdc;
    assert!(!ctor_accepts(
        &env,
        config(&env, &usdc, &eur.address, "USD")
    ));
    assert!(ctor_accepts(&env, config(&env, &usdc, &eur.address, "EUR")));
}

/// Only USD and EUR markets exist (#52), even with a matching feed.
#[test]
fn ctor_rejects_quote_gbp_even_on_a_gbp_feed() {
    let env = Env::default();
    let gbp = feed(&env, "GBP");
    let token = demo_config(&env).usdc;
    assert!(!ctor_accepts(
        &env,
        config(&env, &token, &gbp.address, "GBP")
    ));
}
