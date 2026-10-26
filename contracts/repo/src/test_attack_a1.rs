//! Attack angle A1 (EXP-01, EXP-02, CMP-01): a frozen USDC account on one
//! side of a repo must not trap the other side's funds. USDC payouts to the
//! lender, treasury and borrower surplus become "try, else park as
//! claimable"; collateral legs stay push (DECISIONS.md #24), and an
//! auto-repay that cannot return the collateral refunds the USDC and lets
//! `default` land. Scenarios flipped from the post-implementation attack
//! harness (critics/test_attack.rs).

extern crate std;

use caravel_spiko_mock::{SpikoError, SpikoMock, SpikoMockClient};
use soroban_sdk::{
    testutils::{Address as _, Events as _, IssuerFlags, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Event as _, InvokeError, String,
};

use crate::{
    events, math,
    oracle::mock::{setup_mock_oracle, MockOracleClient, ONE},
    test::{
        demo_config, APR_BPS, DEMO_NAV_AGE, NOW, NO_CAP, PRINCIPAL, TERM_SECS, TRIGGER_BPS, UNIT,
        WIDE_BAND_BPS,
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
const LENDER_START: i128 = 10_000 * UNIT;

// --- SAC world (tBENJI + USDC as Stellar Asset Contracts) -------------------

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
        band_settle_secs: crate::test::SETTLE_SECS,
        margin_trigger_bps: TRIGGER_BPS,
    }
}

fn world<'a>() -> W<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let issuer = Address::generate(&env);
    let usdc_sac = env.register_stellar_asset_contract_v2(issuer.clone());
    // Circle-style issuer: can revoke authorization (freeze) a holder.
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
    let treasury = config.treasury.clone();
    let id = env.register(CaravelRepo, (config,));
    let repo = CaravelRepoClient::new(&env, &id);
    repo.set_asset(&tbenji, &asset_cfg(&tbenji, 300));

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &LENDER_START);
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
    fn set_usdc_auth(&self, who: &Address, authorized: bool) {
        self.usdc_admin.set_authorized(who, &authorized);
    }
    /// Matures `repo_id`, defaults it and liquidates it at NAV 1.00.
    fn default_and_liquidate(&self, repo_id: u64) {
        self.t(MATURED);
        assert_eq!(self.repo.default(&repo_id), Status::Defaulted);
        self.set_nav(ONE, MATURED);
        self.repo.liquidate(&self.liquidator, &repo_id);
        assert_eq!(self.repo.repo(&repo_id).status, Status::Liquidated);
    }
}

/// NAV 1.00 liquidation of a full take: proceeds and their waterfall.
fn liquidation_split() -> (i128, math::Waterfall) {
    let proceeds = math::liquidation_proceeds(TAKE_COLLATERAL, ONE, 14, 200).unwrap();
    let split = math::waterfall(proceeds, PRINCIPAL, INTEREST, 1_000).unwrap();
    (proceeds, split)
}

/// EXP-01: a frozen lender no longer traps the borrower. Manual repay,
/// auto-repay via `default` and liquidation all land; the lender's USDC is
/// parked and paid out by `claim` once the account is unfrozen.
#[test]
fn exp_frozen_lender_traps_borrower_collateral() {
    let w = world();
    let manual = w.take(false);
    let auto = w.take(true);
    let seized = w.take(false);
    w.set_usdc_auth(&w.lender, false);

    // Manual repay: the borrower gets the collateral back, the lender's
    // share is parked, the treasury is paid.
    let borrower_coll = w.tbenji_token.balance(&w.borrower);
    w.repo.repay(&manual);
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [
            events::PayoutParked {
                repo_id: manual,
                to: w.lender.clone(),
                amount: LENDER_DUE,
            }
            .to_xdr(&w.env, &w.repo.address),
            events::Repaid {
                repo_id: manual,
                lender_amount: LENDER_DUE,
                fee: FEE,
                automatic: false,
            }
            .to_xdr(&w.env, &w.repo.address),
        ]
    );
    assert_eq!(w.repo.repo(&manual).status, Status::Repaid);
    assert_eq!(
        w.tbenji_token.balance(&w.borrower),
        borrower_coll + TAKE_COLLATERAL
    );
    assert_eq!(w.repo.claimable(&w.lender), LENDER_DUE);
    assert_eq!(w.usdc.balance(&w.treasury), FEE);

    // Opted in and funded: default settles as Repaid, it no longer reverts.
    w.t(MATURED);
    assert_eq!(w.repo.default(&auto), Status::Repaid);
    assert_eq!(w.repo.claimable(&w.lender), 2 * LENDER_DUE);

    // Liquidation lands; the lender's share is parked, the surplus paid.
    w.set_nav(ONE, MATURED);
    assert_eq!(w.repo.default(&seized), Status::Defaulted);
    let (_, split) = liquidation_split();
    let borrower_usdc = w.usdc.balance(&w.borrower);
    w.repo.liquidate(&w.liquidator, &seized);
    assert_eq!(w.repo.repo(&seized).status, Status::Liquidated);
    assert_eq!(w.usdc.balance(&w.borrower), borrower_usdc + split.borrower);
    assert_eq!(w.tbenji_token.balance(&w.liquidator), TAKE_COLLATERAL);
    let parked = 2 * LENDER_DUE + split.lender;
    assert_eq!(w.repo.claimable(&w.lender), parked);
    // Nothing collateral-side is left behind.
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);
    assert_eq!(w.usdc.balance(&w.repo.address), parked);

    // Still frozen: claim reverts, the balance stays parked.
    assert!(w.repo.try_claim(&w.lender).is_err());
    assert_eq!(w.repo.claimable(&w.lender), parked);

    // Unfrozen: claim pays everything, once.
    w.set_usdc_auth(&w.lender, true);
    let before = w.usdc.balance(&w.lender);
    assert_eq!(w.repo.claim(&w.lender), parked);
    assert_eq!(
        w.env.events().all().filter_by_contract(&w.repo.address),
        [events::Claimed {
            who: w.lender.clone(),
            amount: parked,
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
    assert_eq!(w.usdc.balance(&w.lender), before + parked);
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
    assert_eq!(w.repo.claimable(&w.lender), 0);
    assert_eq!(w.repo.try_claim(&w.lender), Err(Ok(Error::NothingToClaim)));
}

/// EXP-01: a frozen borrower no longer blocks the liquidation. The lender
/// and treasury are paid, the borrower's surplus is parked.
#[test]
fn exp_frozen_borrower_blocks_liquidation_and_lender_payout() {
    let w = world();
    let repo_id = w.take(false);
    w.set_usdc_auth(&w.borrower, false);
    let (proceeds, split) = liquidation_split();
    assert!(split.borrower > 0);

    let liquidator_usdc = w.usdc.balance(&w.liquidator);
    w.default_and_liquidate(repo_id);
    assert_eq!(w.usdc.balance(&w.liquidator), liquidator_usdc - proceeds);
    assert_eq!(
        w.usdc.balance(&w.lender),
        LENDER_START - PRINCIPAL + LENDER_DUE
    );
    assert_eq!(w.usdc.balance(&w.treasury), FEE);
    assert_eq!(split.lender, LENDER_DUE);
    assert_eq!(w.tbenji_token.balance(&w.liquidator), TAKE_COLLATERAL);
    assert_eq!(w.repo.claimable(&w.borrower), split.borrower);
    assert_eq!(w.usdc.balance(&w.repo.address), split.borrower);

    w.set_usdc_auth(&w.borrower, true);
    let before = w.usdc.balance(&w.borrower);
    assert_eq!(w.repo.claim(&w.borrower), split.borrower);
    assert_eq!(w.usdc.balance(&w.borrower), before + split.borrower);
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
}

/// EXP-01: a frozen treasury no longer blocks any exit. Repay, auto-repay
/// and liquidation land; each fee is parked for the treasury.
#[test]
fn exp_frozen_treasury_blocks_all_exits() {
    let w = world();
    let a = w.take(false);
    let b = w.take(true);
    let c = w.take(false);
    w.set_usdc_auth(&w.treasury, false);

    w.repo.repay(&a);
    assert_eq!(w.repo.repo(&a).status, Status::Repaid);
    w.t(MATURED);
    assert_eq!(w.repo.default(&b), Status::Repaid);
    w.default_and_liquidate(c);
    let (_, split) = liquidation_split();
    assert_eq!(split.fee, FEE);

    // The lender was paid in full three times over; only the fees wait.
    assert_eq!(
        w.usdc.balance(&w.lender),
        LENDER_START - 3 * PRINCIPAL + 3 * LENDER_DUE
    );
    assert_eq!(w.repo.claimable(&w.treasury), 3 * FEE);
    assert_eq!(w.usdc.balance(&w.treasury), 0);

    w.set_usdc_auth(&w.treasury, true);
    assert_eq!(w.repo.claim(&w.treasury), 3 * FEE);
    assert_eq!(w.usdc.balance(&w.treasury), 3 * FEE);
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
}

/// EXP-02: the borrower's collateral is frozen while it holds the debt and
/// opted in. Auto-repay cannot return the collateral, so it fails cleanly;
/// `default` refunds the pulled USDC and lands, and the liquidation pays the
/// lender.
#[test]
fn exp_frozen_borrower_collateral_blocks_default_when_opted_in() {
    let w = world();
    let repo_id = w.take(true);
    w.usdc_admin.mint(&w.borrower, &(1_000 * UNIT));
    StellarAssetClient::new(&w.env, &w.tbenji).set_authorized(&w.borrower, &false);
    w.t(MATURED);
    let borrower_usdc = w.usdc.balance(&w.borrower);

    assert_eq!(
        w.repo.try_auto_repay(&repo_id),
        Err(Ok(Error::AutoRepayFailed))
    );
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);

    assert_eq!(w.repo.default(&repo_id), Status::Defaulted);
    // The pull was refunded: the borrower holds the same USDC, the contract
    // holds none, the collateral is still in the contract.
    assert_eq!(w.usdc.balance(&w.borrower), borrower_usdc);
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);

    let (_, split) = liquidation_split();
    w.set_nav(ONE, MATURED);
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
    assert_eq!(
        w.usdc.balance(&w.lender),
        LENDER_START - PRINCIPAL + LENDER_DUE
    );
    assert_eq!(w.usdc.balance(&w.borrower), borrower_usdc + split.borrower);
    assert_eq!(w.repo.claimable(&w.borrower), 0);
}

/// The refunded pull spends only this repo's share of the shared allowance:
/// the borrower's other opted-in repo still auto-repays.
#[test]
fn refunded_settle_keeps_other_repos_allowance() {
    let w = world();
    let frozen_side = w.take(true);
    let other = w.take(true);
    w.usdc_admin.mint(&w.borrower, &(1_000 * UNIT));
    let before = w.usdc.allowance(&w.borrower, &w.repo.address);
    assert_eq!(before, 2 * DEBT);

    let tbenji_admin = StellarAssetClient::new(&w.env, &w.tbenji);
    tbenji_admin.set_authorized(&w.borrower, &false);
    w.t(MATURED);
    assert_eq!(w.repo.default(&frozen_side), Status::Defaulted);
    assert_eq!(w.usdc.allowance(&w.borrower, &w.repo.address), DEBT);

    tbenji_admin.set_authorized(&w.borrower, &true);
    w.repo.auto_repay(&other);
    assert_eq!(w.repo.repo(&other).status, Status::Repaid);
}

#[test]
fn claim_requires_auth_and_a_balance() {
    let w = world();
    assert_eq!(w.repo.claimable(&w.lender), 0);
    assert_eq!(w.repo.try_claim(&w.lender), Err(Ok(Error::NothingToClaim)));

    let repo_id = w.take(false);
    w.set_usdc_auth(&w.lender, false);
    w.repo.repay(&repo_id);
    w.set_usdc_auth(&w.lender, true);

    w.env.set_auths(&[]);
    assert!(w.repo.try_claim(&w.lender).is_err());
    assert_eq!(w.repo.claimable(&w.lender), LENDER_DUE);
    w.env.mock_all_auths();
    w.repo.claim(&w.lender);
    assert_eq!(w.env.auths()[0].0, w.lender);
}

/// Healthy accounts: no payout is parked and balances match the direct push.
#[test]
fn unfrozen_settlements_park_nothing() {
    let w = world();
    let a = w.take(false);
    let b = w.take(false);
    w.repo.repay(&a);
    w.default_and_liquidate(b);
    for who in [&w.lender, &w.borrower, &w.treasury] {
        assert_eq!(w.repo.claimable(who), 0);
    }
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
    assert_eq!(w.usdc.balance(&w.treasury), 2 * FEE);
}

// --- Spiko world (permissioned tSAFO collateral) ---------------------------

const SAFO_HAIRCUT_BPS: u32 = 3_000;

struct S<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    usdc_admin: StellarAssetClient<'a>,
    safo: SpikoMockClient<'a>,
    oracle: MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
}

fn spiko_world<'a>() -> S<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    let usdc = env
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
    let oracle = MockOracleClient::new(&env, &setup_mock_oracle(&env));
    oracle.set_price(&Asset::Stellar(safo_id.clone()), &ONE, &NOW);

    let mut cfg = demo_config(&env);
    cfg.usdc = usdc.clone();
    cfg.oracle = oracle.address.clone();
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (cfg,)));
    repo.set_asset(&safo_id, &asset_cfg(&safo_id, SAFO_HAIRCUT_BPS));

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    repo.set_liquidator(&liquidator, &true);
    for who in [&repo.address, &borrower, &liquidator] {
        safo.set_whitelisted(who, &true);
    }
    safo.mint(&borrower, &(5_000 * 100_000));
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &LENDER_START);
    usdc_admin.mint(&borrower, &(100 * UNIT));
    usdc_admin.mint(&liquidator, &(2_000 * UNIT));
    S {
        usdc: TokenClient::new(&env, &usdc),
        usdc_admin,
        repo,
        safo,
        oracle,
        lender,
        borrower,
        liquidator,
        env,
    }
}

fn spiko<T>(e: SpikoError) -> Result<T, Result<Error, InvokeError>> {
    Err(Err(InvokeError::Contract(e as u32)))
}

/// CMP-01 (merged into EXP-02): the borrower is taken off the tSAFO
/// allowlist while it holds the debt and opted in. Repay still fails on the
/// collateral push (#24), but `default` no longer reverts: it refunds the
/// pull and lands, without the borrower opting out, and the liquidation pays
/// the lender.
#[test]
fn cmp_borrower_deallowlisted_before_repay() {
    let w = spiko_world();
    let repo_id = w
        .repo
        .create_offer(&w.lender, &w.safo.address, &PRINCIPAL, &APR_BPS, &TERM_SECS);
    let repo_id = w.repo.take_offer(&w.borrower, &repo_id, &true);
    w.usdc_admin.mint(&w.borrower, &(1_000 * UNIT));
    w.safo.set_whitelisted(&w.borrower, &false);
    assert_eq!(
        w.repo.try_repay(&repo_id),
        spiko(SpikoError::NotWhitelisted)
    );
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);

    w.env.ledger().set_timestamp(MATURED);
    assert_eq!(
        w.repo.try_auto_repay(&repo_id),
        Err(Ok(Error::AutoRepayFailed))
    );
    let borrower_usdc = w.usdc.balance(&w.borrower);
    assert_eq!(w.repo.default(&repo_id), Status::Defaulted);
    assert!(w.repo.repo(&repo_id).auto_repay);
    assert_eq!(w.usdc.balance(&w.borrower), borrower_usdc);

    w.oracle
        .set_price(&Asset::Stellar(w.safo.address.clone()), &ONE, &MATURED);
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
    assert_eq!(
        w.usdc.balance(&w.lender),
        LENDER_START - PRINCIPAL + LENDER_DUE
    );
    assert!(w.safo.balance(&w.liquidator) > 0);
    assert_eq!(w.usdc.balance(&w.repo.address), 0);
}

// --- Raven audit CT-03: storage TTL --------------------------------------

/// Raven audit CT-03: nothing asserted a TTL, so making `extend_instance` /
/// `extend_persistent` no-ops left the suite green. Every write puts an
/// entry at the full bump; an entry nobody touches for 29 days is still
/// live, and the next read puts it back at the full bump. The instance is
/// kept alive by a view call every 4 days, as the keeper's tick does.
/// (`AllowanceUntil` is bumped on write only; reads do not extend it.)
/// Lives here because this world's USDC issuer can freeze the lender, which
/// is what parks a payout under `Claimable`.
#[test]
fn ttl_is_bumped_on_every_touch() {
    use crate::storage::DataKey;
    use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
    const DAY: u32 = 17_280;
    const INSTANCE_TTL: u32 = 6 * DAY; // storage.rs INSTANCE_BUMP
    const INSTANCE_MIN: u32 = INSTANCE_TTL - DAY; // INSTANCE_THRESHOLD
    const ENTRY_TTL: u32 = 30 * DAY; // storage.rs PERSISTENT_BUMP

    let w = world();
    let addr = w.repo.address.clone();
    let inst = || {
        w.env
            .as_contract(&addr, || w.env.storage().instance().get_ttl())
    };
    let ttl = |key: DataKey| {
        w.env
            .as_contract(&addr, || w.env.storage().persistent().get_ttl(&key))
    };
    let hop = |days: u32| {
        let seq = w.env.ledger().sequence();
        w.env.ledger().set_sequence_number(seq + days * DAY);
    };
    let allowance = || DataKey::AllowanceUntil(w.borrower.clone());

    // create_offer: Offer + instance.
    let offer = || {
        w.repo
            .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS)
    };
    let kept = offer(); // stays open for the whole test
    assert_eq!(ttl(DataKey::Offer(kept)), ENTRY_TTL);
    assert_eq!(inst(), INSTANCE_TTL);

    // take_offer with auto-repay: Repo + AllowanceUntil.
    let offer_id = offer();
    let id = w.repo.take_offer(&w.borrower, &offer_id, &true);
    assert_eq!(ttl(DataKey::Repo(id)), ENTRY_TTL);
    assert_eq!(ttl(allowance()), ENTRY_TTL);
    assert!(inst() >= INSTANCE_MIN);

    // 29 days with the offer and the repo untouched.
    for _ in 0..7 {
        hop(4);
        assert!(inst() < INSTANCE_MIN); // due for a bump
        w.repo.config();
        assert_eq!(inst(), INSTANCE_TTL);
    }
    hop(1);
    assert_eq!(ttl(DataKey::Repo(id)), DAY);
    assert_eq!(ttl(DataKey::Offer(kept)), DAY);
    assert_eq!(ttl(allowance()), DAY);

    // A read 29 days on restores the full bump.
    assert_eq!(w.repo.repo(&id).status, Status::Open);
    assert_eq!(ttl(DataKey::Repo(id)), ENTRY_TTL);
    assert_eq!(w.repo.offer(&kept).id, kept);
    assert_eq!(ttl(DataKey::Offer(kept)), ENTRY_TTL);

    // repay two days on with the lender frozen: the instance and Repo are
    // bumped, the lender's USDC is parked under Claimable at the full bump.
    // Only the ledger sequence moves in this test, and the 7-minute repo's
    // SAC allowance has long lapsed, so AllowanceUntil is removed.
    let offer_id = offer(); // before the freeze: create_offer pulls the lender's USDC
    hop(2);
    assert!(inst() < INSTANCE_MIN);
    w.set_usdc_auth(&w.lender, false);
    w.repo.repay(&id);
    assert_eq!(inst(), INSTANCE_TTL);
    assert_eq!(ttl(DataKey::Repo(id)), ENTRY_TTL);
    assert_eq!(w.repo.repo(&id).status, Status::Repaid);
    assert!(!w
        .env
        .as_contract(&addr, || w.env.storage().persistent().has(&allowance())));
    let parked = w.repo.claimable(&w.lender);
    assert!(parked > 0);
    assert_eq!(ttl(DataKey::Claimable(w.lender.clone())), ENTRY_TTL);

    // A new auto-repay take writes AllowanceUntil at the full bump again.
    let second = w.repo.take_offer(&w.borrower, &offer_id, &true);
    assert_eq!(ttl(DataKey::Repo(second)), ENTRY_TTL);
    assert_eq!(ttl(allowance()), ENTRY_TTL);

    // The parked balance is bumped again when read, then claimed.
    hop(4);
    assert_eq!(
        ttl(DataKey::Claimable(w.lender.clone())),
        ENTRY_TTL - 4 * DAY
    );
    assert_eq!(w.repo.claimable(&w.lender), parked);
    assert_eq!(ttl(DataKey::Claimable(w.lender.clone())), ENTRY_TTL);
    w.set_usdc_auth(&w.lender, true);
    assert_eq!(w.repo.claim(&w.lender), parked);
    assert_eq!(w.repo.claimable(&w.lender), 0);
    assert!(inst() >= INSTANCE_MIN);
}
