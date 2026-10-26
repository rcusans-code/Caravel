//! Raven audit angle R5 (contract guards, no ABI change): one test per
//! finding, each the audit's repro flipped to the fixed behaviour.
//!
//! - CS-01: a refunded auto-repay at `default` switches `auto_repay` off, so
//!   a later hand repay does not strip the borrower's other repos' cover.
//! - UA-01 / OZ-01 (D3): the margin trigger is clamped per repo to
//!   `repo.haircut_bps − 1`; a tighten-only key cannot margin-call a healthy
//!   repo at an unchanged NAV.
//! - STD-01: the constructor requires a feed quoted in USD.
//! - STD-02: an asset's `max_nav_age_secs` is at least the feed resolution.
//! - CS-07: the constructor requires 7-decimal USDC.
//! - AS-03: a frozen lender's offer cannot be taken.
//! - OZ-05: the constructor rejects `guardian == admin`.

extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, IssuerFlags, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Symbol,
};

use crate::{
    oracle::mock::{setup_mock_oracle, MockOracleClient, ONE},
    test::{
        demo_config, whitelist, APR_BPS, DEMO_NAV_AGE, NOW, NO_CAP, PRINCIPAL, SETTLE_SECS,
        TERM_SECS, TRIGGER_BPS, UNIT, WIDE_BAND_BPS,
    },
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Config, Error, Status,
};

const GRACE_SECS: u64 = 60; // demo profile
const WINDOW_SECS: u64 = 120; // demo profile
const MATURED: u64 = NOW + TERM_SECS + GRACE_SECS + 1;
const INTEREST: i128 = 9_301_370;
const DEBT: i128 = PRINCIPAL + INTEREST;
const HAIRCUT: u32 = 300;

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
        band_settle_secs: SETTLE_SECS,
    }
}

struct W<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    usdc_admin: StellarAssetClient<'a>,
    tbenji: Address,
    tbenji_admin: StellarAssetClient<'a>,
    tbenji_token: TokenClient<'a>,
    oracle: MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
}

/// USDC + tBENJI SACs (revocable, like the live issuers), mock feed at NAV
/// 1.00, tBENJI at haircut 300 / trigger 200, funded lender, borrower and
/// whitelisted liquidator.
fn world<'a>() -> W<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    let issuer = Address::generate(&env);
    let usdc_sac = env.register_stellar_asset_contract_v2(issuer.clone());
    usdc_sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let usdc = usdc_sac.address();
    let tbenji_sac = env.register_stellar_asset_contract_v2(issuer);
    tbenji_sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let tbenji = tbenji_sac.address();
    let oracle = MockOracleClient::new(&env, &setup_mock_oracle(&env));
    oracle.set_price(&Asset::Stellar(tbenji.clone()), &ONE, &NOW);
    let mut config = demo_config(&env);
    config.usdc = usdc.clone();
    config.oracle = oracle.address.clone();
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (config,)));
    repo.set_asset(&tbenji, &asset_cfg(&tbenji, HAIRCUT, TRIGGER_BPS));
    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &(10_000 * UNIT));
    usdc_admin.mint(&borrower, &(100 * UNIT));
    usdc_admin.mint(&liquidator, &(2_000 * UNIT));
    let tbenji_admin = StellarAssetClient::new(&env, &tbenji);
    tbenji_admin.mint(&borrower, &(5_000 * UNIT));
    whitelist(&env, &repo, &liquidator);
    W {
        usdc: TokenClient::new(&env, &usdc),
        usdc_admin,
        tbenji_token: TokenClient::new(&env, &tbenji),
        tbenji_admin,
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
    fn offer(&self) -> u64 {
        self.repo
            .create_offer(&self.lender, &self.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS)
    }
    fn take(&self, auto_repay: bool) -> u64 {
        let offer = self.offer();
        self.repo.take_offer(&self.borrower, &offer, &auto_repay)
    }
    fn nav(&self, ts: u64) {
        self.env.ledger().set_timestamp(ts);
        self.oracle
            .set_price(&Asset::Stellar(self.tbenji.clone()), &ONE, &ts);
    }
    fn allowance(&self) -> i128 {
        self.usdc.allowance(&self.borrower, &self.repo.address)
    }
}

/// The panic message of a failed `__constructor`, or `None` if it succeeded.
fn ctor_failure(env: &Env, config: Config) -> Option<std::string::String> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(CaravelRepo, (config,));
    }));
    result.err().map(|payload| {
        payload
            .downcast_ref::<std::string::String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).into()))
            .unwrap_or_default()
    })
}

/// `InvalidConfig` (code 2) out of the constructor.
fn assert_ctor_invalid_config(env: &Env, config: Config) {
    let msg = ctor_failure(env, config).expect("constructor accepted the config");
    assert!(
        msg.contains("Error(Contract, #2)"),
        "not InvalidConfig: {msg}"
    );
}

/// The real caravel-oracle contract (the one deploy.sh deploys), quoting in
/// `base` at `resolution` seconds.
fn real_oracle(env: &Env, base: &str, resolution: u32) -> Address {
    env.register(
        caravel_oracle::MockOracle,
        (
            Address::generate(env),
            caravel_oracle::Asset::Other(Symbol::new(env, base)),
            14u32,
            resolution,
        ),
    )
}

/// A token whose only job is to report 6 decimals.
#[contract]
struct SixDecimalToken;

#[contractimpl]
impl SixDecimalToken {
    pub fn decimals(_env: Env) -> u32 {
        6
    }
}

// --- CS-01 --------------------------------------------------------------------

/// Audit repro `raven_r1_…` flipped. A refunded auto-repay at A's default
/// (borrower frozen on the collateral) used to leave `auto_repay` on, so a
/// later hand repay of A from Defaulted took A's share off the shared
/// allowance a second time and B, opted in and funded, defaulted. Now A's
/// default switches auto-repay off, the hand repay leaves B's share, and B
/// auto-repays.
#[test]
fn cs01_refunded_default_keeps_other_repos_allowance() {
    let w = world();
    let a = w.take(true);
    let b = w.take(true);
    w.usdc_admin.mint(&w.borrower, &(5_000 * UNIT));
    assert_eq!(w.allowance(), 2 * DEBT);

    w.tbenji_admin.set_authorized(&w.borrower, &false);
    w.env.ledger().set_timestamp(MATURED);
    assert_eq!(w.repo.default(&a), Status::Defaulted);
    assert!(
        !w.repo.repo(&a).auto_repay,
        "refund switches auto-repay off"
    );
    assert_eq!(w.allowance(), DEBT, "the refunded pull spent A's share");

    w.tbenji_admin.set_authorized(&w.borrower, &true);
    w.repo.repay(&a);
    assert_eq!(w.allowance(), DEBT, "hand repay of A keeps B's share");

    w.repo.auto_repay(&b);
    assert_eq!(w.repo.repo(&b).status, Status::Repaid);
    assert_eq!(w.allowance(), 0);
}

/// A failed pull moves nothing, so the repo keeps `auto_repay` and its
/// share: a later hand repay from Defaulted releases it as before.
#[test]
fn cs01_failed_pull_keeps_auto_repay() {
    let w = world();
    let a = w.take(true);
    // Spend the principal so the borrower cannot cover the debt.
    let spare = Address::generate(&w.env);
    w.usdc
        .transfer(&w.borrower, &spare, &w.usdc.balance(&w.borrower));
    w.env.ledger().set_timestamp(MATURED);
    assert_eq!(w.repo.default(&a), Status::Defaulted);
    assert!(w.repo.repo(&a).auto_repay);
    assert_eq!(w.allowance(), DEBT);
    w.usdc_admin.mint(&w.borrower, &DEBT);
    w.repo.repay(&a);
    assert_eq!(w.allowance(), 0);
}

// --- UA-01 / OZ-01 ------------------------------------------------------------

/// Audit repros `oz01_…` and `ua01_…` flipped: the guardian raises haircut
/// and trigger past a live repo's snapshotted haircut (9,999 / 9,998 and
/// 9,000 / 8,999). At an unchanged NAV of 1.00 the repo is not margin-called,
/// so it cannot be defaulted or sold at the discount.
#[test]
fn ua01_oz01_tightening_cannot_margin_call_at_par() {
    for (haircut, trigger) in [(9_999, 9_998), (9_000, 8_999), (HAIRCUT, HAIRCUT - 1)] {
        let w = world();
        let id = w.take(false);
        assert_eq!(w.repo.check_margin(&id), Status::Open);
        // The last case keeps the haircut and raises the trigger to the
        // highest legal value, haircut − 1: the clamp does not bind.
        w.repo
            .guardian_set_asset(&w.tbenji, &asset_cfg(&w.tbenji, haircut, trigger));
        assert_eq!(w.repo.asset(&w.tbenji).margin_trigger_bps, trigger);
        w.nav(NOW + 1);
        assert_eq!(
            w.repo.check_margin(&id),
            Status::Open,
            "{haircut}/{trigger}"
        );
        w.nav(NOW + 1 + WINDOW_SECS + 1);
        assert_eq!(w.repo.check_margin(&id), Status::Open);
        assert_eq!(w.repo.try_default(&id), Err(Ok(Error::NotDefaultable)));
    }
}

/// The admin's instant chain (`oz01b_…`): same tightening through
/// `set_asset`, plus whitelisting itself. With the clamp there is no call to
/// miss, so no default and no discounted sale.
#[test]
fn oz01b_admin_tightening_cannot_force_a_sale() {
    let w = world();
    let admin = w.repo.config().admin;
    let id = w.take(false);
    w.repo
        .set_asset(&w.tbenji, &asset_cfg(&w.tbenji, 9_000, 8_999));
    whitelist(&w.env, &w.repo, &admin);
    w.nav(NOW + 1);
    assert_eq!(w.repo.check_margin(&id), Status::Open);
    w.nav(NOW + 1 + WINDOW_SECS + 1);
    assert_eq!(w.repo.try_default(&id), Err(Ok(Error::NotDefaultable)));
    assert_eq!(
        w.repo.try_liquidate(&admin, &id),
        Err(Ok(Error::InvalidStatus))
    );
    // The repo still margins on a real NAV fall at its own terms: past
    // 0.97 / 0.9701 ≈ 0.999897 it is called at the clamped trigger 299.
    w.env.ledger().set_timestamp(NOW + 400);
    w.oracle.set_price(
        &Asset::Stellar(w.tbenji.clone()),
        &(999 * ONE / 1_000),
        &(NOW + 400),
    );
    assert_eq!(w.repo.check_margin(&id), Status::MarginCall);
    let _ = (&w.liquidator, &w.tbenji_token);
}

// --- STD-01 -------------------------------------------------------------------

/// Audit repro `r2_base_not_checked` flipped: a feed quoted in XLM is
/// rejected at construction; the same feed in USD is accepted. A feed
/// address that is not a contract is rejected too.
#[test]
fn std01_constructor_requires_a_usd_feed() {
    let env = Env::default();
    let mut config = demo_config(&env);
    config.oracle = real_oracle(&env, "XLM", 60);
    assert_ctor_invalid_config(&env, config.clone());

    config.oracle = Address::generate(&env);
    assert_ctor_invalid_config(&env, config.clone());

    config.oracle = real_oracle(&env, "USD", 60);
    assert_eq!(ctor_failure(&env, config), None);
}

// --- STD-02 -------------------------------------------------------------------

/// Audit repro `r1_sep40_floored_timestamp_vs_max_nav_age` flipped: with a
/// 300 s feed, `max_nav_age_secs` 180 (the demo value) is rejected on every
/// entry point that writes an asset config; 300 is accepted.
#[test]
fn std02_nav_age_below_feed_resolution_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let mut config = demo_config(&env);
    config.oracle = real_oracle(&env, "USD", 300);
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (config,)));
    let token = Address::generate(&env);
    let mut cfg = asset_cfg(&token, HAIRCUT, TRIGGER_BPS);
    cfg.max_nav_age_secs = 299;
    assert_eq!(
        repo.try_set_asset(&token, &cfg),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(
        repo.try_propose_asset(&token, &cfg),
        Err(Ok(Error::InvalidConfig))
    );
    cfg.max_nav_age_secs = 300;
    repo.set_asset(&token, &cfg);
    cfg.max_nav_age_secs = 299;
    assert_eq!(
        repo.try_guardian_set_asset(&token, &cfg),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(repo.asset(&token).max_nav_age_secs, 300);
}

// --- CS-07 --------------------------------------------------------------------

/// A 6-decimal dollar token would misprice every LTV by 10×: rejected at
/// construction. A `usdc` that is not a token is rejected too.
#[test]
fn cs07_constructor_requires_7_decimal_usdc() {
    let env = Env::default();
    let mut config = demo_config(&env);
    config.usdc = env.register(SixDecimalToken, ());
    assert_ctor_invalid_config(&env, config.clone());

    config.usdc = Address::generate(&env);
    assert_ctor_invalid_config(&env, config.clone());

    config.usdc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    assert_eq!(ctor_failure(&env, config), None);
}

// --- AS-03 --------------------------------------------------------------------

/// Audit repro `raven_r2_frozen_lender_offer_is_still_lent_out` flipped: a
/// lender the USDC issuer froze after posting cannot cancel, and its escrow
/// is no longer lent out either (`OfferNotFound`). The offer stays stored
/// and is takeable again once the issuer re-authorizes the lender.
#[test]
fn as03_frozen_lender_offer_cannot_be_taken() {
    let w = world();
    let offer = w.offer();
    w.usdc_admin.set_authorized(&w.lender, &false);
    assert!(w.repo.try_cancel_offer(&offer).is_err());
    let borrower_usdc = w.usdc.balance(&w.borrower);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer, &false),
        Err(Ok(Error::OfferNotFound))
    );
    assert_eq!(w.usdc.balance(&w.borrower), borrower_usdc);
    assert_eq!(w.repo.offer(&offer).id, offer);

    w.usdc_admin.set_authorized(&w.lender, &true);
    let id = w.repo.take_offer(&w.borrower, &offer, &false);
    assert_eq!(w.repo.repo(&id).status, Status::Open);
}

// --- OZ-05 --------------------------------------------------------------------

/// Audit repro `oz05_…` flipped: one key as admin and guardian is rejected.
#[test]
fn oz05_constructor_rejects_guardian_equal_admin() {
    let env = Env::default();
    let mut config = demo_config(&env);
    config.guardian = config.admin.clone();
    assert_ctor_invalid_config(&env, config.clone());
    config.guardian = Address::generate(&env);
    assert_eq!(ctor_failure(&env, config), None);
}
