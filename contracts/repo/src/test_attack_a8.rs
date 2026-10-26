//! Attack angle A8 (small contract guards): EXP-03, COR-03, COR-04, ORC-01.
//! Flipped from the post-implementation attack scenarios: each test used to
//! pass by reproducing the trap and now asserts the guard.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

use crate::{
    math,
    oracle::mock::{setup_mock_oracle, MockOracleClient, MOCK_DECIMALS, ONE},
    test::{
        demo_config, APR_BPS, DEMO_NAV_AGE, NOW, NO_CAP, PRINCIPAL, TERM_SECS, TRIGGER_BPS, UNIT,
        WIDE_BAND_BPS,
    },
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Config, Error, Status,
};

const INTEREST: i128 = 9_301_370;
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

fn asset_cfg(token: &Address) -> AssetConfig {
    AssetConfig {
        oracle_asset: Asset::Stellar(token.clone()),
        haircut_bps: 300,
        margin_trigger_bps: TRIGGER_BPS,
        enabled: true,
        max_nav_age_secs: DEMO_NAV_AGE,
        max_nav_move_bps: WIDE_BAND_BPS,
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
    repo.set_asset(&tbenji, &asset_cfg(&tbenji));

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &(10_000 * UNIT));
    usdc_admin.mint(&borrower, &(2_100 * UNIT));
    usdc_admin.mint(&liquidator, &(2_000 * UNIT));
    StellarAssetClient::new(&env, &tbenji).mint(&borrower, &(5_000 * UNIT));
    repo.set_liquidator(&liquidator, &true);

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
    fn take(&self) -> u64 {
        let id =
            self.repo
                .create_offer(&self.lender, &self.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
        self.repo.take_offer(&self.borrower, &id, &false)
    }
    fn t(&self, ts: u64) {
        self.env.ledger().set_timestamp(ts);
    }
    /// Takes a repo, breaches it at `nav` and defaults it on the missed call.
    fn defaulted(&self, nav: i128) -> u64 {
        let repo_id = self.take();
        self.set_nav(nav, NOW);
        assert_eq!(self.repo.check_margin(&repo_id), Status::MarginCall);
        let deadline = self.repo.repo(&repo_id).margin_call_deadline.unwrap();
        self.t(deadline + 1);
        self.set_nav(nav, deadline + 1);
        assert_eq!(self.repo.default(&repo_id), Status::Defaulted);
        repo_id
    }
}

// --- EXP-03: borrower cannot liquidate its own repo --------------------------

#[test]
fn exp_borrower_self_liquidates_at_discount() {
    let w = world();
    let nav = ONE * 95 / 100;
    let repo_id = w.defaulted(nav);
    // Even whitelisted, the borrower is not a liquidator of its own repo.
    w.repo.set_liquidator(&w.borrower, &true);

    let usdc_before = w.usdc.balance(&w.borrower);
    let coll_before = w.tbenji_token.balance(&w.borrower);
    assert_eq!(
        w.repo.try_liquidate(&w.borrower, &repo_id),
        Err(Ok(Error::NotLiquidator))
    );
    assert_eq!(w.usdc.balance(&w.borrower), usdc_before);
    assert_eq!(w.tbenji_token.balance(&w.borrower), coll_before);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);

    // What the borrower would have kept the lender short (qa.md EXP-03:
    // 38.9443834 USDC, fee excluded).
    let proceeds = math::liquidation_proceeds(TAKE_COLLATERAL, nav, MOCK_DECIMALS, 200).unwrap();
    let split = math::waterfall(proceeds, PRINCIPAL, INTEREST, 1_000).unwrap();
    assert_eq!(split.shortfall, 389_443_834);

    // An independent liquidator still clears it.
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
    assert_eq!(w.tbenji_token.balance(&w.liquidator), TAKE_COLLATERAL);
}

// --- COR-04: config bounds ---------------------------------------------------

/// `Some(code)` if the constructor rejected `config` with contract error `code`.
fn construct(config: Config) -> Option<std::string::String> {
    let env = config.admin.env().clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(CaravelRepo, (config,));
    }));
    result.err().map(|e| {
        e.downcast_ref::<std::string::String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| (*s).into()))
            .unwrap_or_default()
    })
}

#[test]
fn cor_validate_config_edges() {
    let env = Env::default();
    let invalid = std::format!("{:?}", soroban_sdk::Error::from(Error::InvalidConfig));
    let edges: [fn(&mut Config); 4] = [
        |c| c.fee_bps = 10_000,
        |c| c.liquidation_discount_bps = 0,
        |c| c.timelock_secs = 1,
        |c| c.timelock_secs = 59,
    ];
    for edge in edges {
        let mut c = demo_config(&env);
        edge(&mut c);
        let err = construct(c).expect("config must be rejected");
        assert!(err.contains(&invalid), "{err}");
    }

    // The tightest accepted values still construct.
    let mut c = demo_config(&env);
    c.fee_bps = 9_999;
    c.liquidation_discount_bps = 1;
    c.timelock_secs = 60;
    assert_eq!(construct(c), None);
}

// --- ORC-01: future-dated NAV ------------------------------------------------

#[test]
fn future_timestamp_beyond_skew_is_no_price() {
    let w = world();
    let repo_id = w.take();

    // 61 s ahead: rejected, even though it would otherwise be "fresh" for
    // max_nav_age_secs past its own future timestamp.
    w.set_nav(ONE * 95 / 100, NOW + 61);
    assert_eq!(w.repo.try_check_margin(&repo_id), Err(Ok(Error::NoPrice)));
    let offer = w
        .repo
        .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer, &false),
        Err(Ok(Error::NoPrice))
    );

    // Exactly 60 s ahead is clock skew: accepted.
    w.set_nav(ONE * 95 / 100, NOW + 60);
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);
}
