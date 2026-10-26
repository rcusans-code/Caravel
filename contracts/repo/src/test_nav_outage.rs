//! NAV side 3 (nav-outage): the feed stops and a Defaulted repo has no
//! lender exit. `liquidate` stays blocked on a stale NAV (DECISIONS.md Open
//! item, kept as proposed); after `NAV_OUTAGE_DAYS` of staleness the lender
//! claims the collateral in kind (`claim_in_kind`). Harness copied from
//! `test_attack_a2.rs` (SAC USDC + tBENJI, mock oracle, demo config:
//! day_secs 60, NAV age 180 s). The permissioned-token refusal lives in
//! `test_spiko.rs` (`in_kind_claim_*`).

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, IssuerFlags, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal,
};

use crate::{
    inkind::NAV_OUTAGE_DAYS,
    oracle::{
        mock::{setup_mock_oracle, MockOracleClient, ONE},
        MAX_FUTURE_SKEW_SECS,
    },
    test::{
        demo_config, APR_BPS, DEMO_NAV_AGE, NOW, NO_CAP, PRINCIPAL, TERM_SECS, TIMELOCK,
        TRIGGER_BPS, UNIT, WIDE_BAND_BPS,
    },
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Error, Pause, Status,
};

const DAY_SECS: u64 = 60;
const GRACE_SECS: u64 = 60;
const MATURED: u64 = NOW + TERM_SECS + GRACE_SECS + 1;
const INTEREST: i128 = 9_301_370;
const DEBT: i128 = PRINCIPAL + INTEREST;
const TAKE_COLLATERAL: i128 = 10_009_589_042;
/// Last second the in-kind claim is still closed for a NAV posted at NOW:
/// 1_000 + 180 + 7 × 60 = 1_600.
const OUTAGE_EDGE: u64 = NOW + DEMO_NAV_AGE + NAV_OUTAGE_DAYS * DAY_SECS;

struct W<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    tbenji: Address,
    tbenji_admin: StellarAssetClient<'a>,
    tbenji_token: TokenClient<'a>,
    oracle: MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
}

fn world<'a>() -> W<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let issuer = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let tbenji_sac = env.register_stellar_asset_contract_v2(issuer);
    // Issuer can freeze a holder (the lender, in the frozen-trustline test).
    tbenji_sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let tbenji = tbenji_sac.address();
    let oracle = MockOracleClient::new(&env, &setup_mock_oracle(&env));
    oracle.set_price(&Asset::Stellar(tbenji.clone()), &ONE, &NOW);

    let mut config = demo_config(&env);
    config.usdc = usdc.clone();
    config.oracle = oracle.address.clone();
    let id = env.register(CaravelRepo, (config,));
    let repo = CaravelRepoClient::new(&env, &id);
    repo.set_asset(
        &tbenji,
        &AssetConfig {
            oracle_asset: Asset::Stellar(tbenji.clone()),
            haircut_bps: 300,
            margin_trigger_bps: TRIGGER_BPS,
            enabled: true,
            max_nav_age_secs: DEMO_NAV_AGE,
            max_nav_move_bps: WIDE_BAND_BPS,
            nav_floor: None,
            nav_ceiling: None,
            max_open_debt: NO_CAP,
            band_settle_secs: crate::test::SETTLE_SECS,
        },
    );

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &(10_000 * UNIT));
    usdc_admin.mint(&borrower, &(100 * UNIT));
    let tbenji_admin = StellarAssetClient::new(&env, &tbenji);
    tbenji_admin.mint(&borrower, &(5_000 * UNIT));
    crate::test::whitelist(&env, &repo, &liquidator);
    usdc_admin.mint(&liquidator, &(2_000 * UNIT));

    W {
        usdc: TokenClient::new(&env, &usdc),
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
    fn t(&self, ts: u64) {
        self.env.ledger().set_timestamp(ts);
    }
    fn set_nav(&self, price: i128, ts: u64) {
        self.oracle
            .set_price(&Asset::Stellar(self.tbenji.clone()), &price, &ts);
    }
    fn take(&self) -> u64 {
        let offer =
            self.repo
                .create_offer(&self.lender, &self.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
        self.repo.take_offer(&self.borrower, &offer, &false)
    }
    /// Repo taken at NOW on a NAV posted at NOW; the feed never posts again.
    /// Matures unpaid and defaults (a maturity default reads no NAV).
    fn defaulted_after_feed_stops(&self) -> u64 {
        let repo_id = self.take();
        self.t(MATURED);
        assert_eq!(self.repo.default(&repo_id), Status::Defaulted);
        repo_id
    }
}

fn w_defaulted<'a>() -> (W<'a>, u64) {
    let w = world();
    let repo_id = w.defaulted_after_feed_stops();
    (w, repo_id)
}

/// Scenario A at base: Defaulted repo, feed stopped. 30 demo days and 30
/// real days later `liquidate` still fails `StaleNav`; the collateral stays
/// in the contract, the lender is unpaid and `open_debt` is never released.
/// Unchanged by the fix: `liquidate` stays blocked on a stale NAV.
#[test]
fn outage_defaulted_repo_stays_locked_and_liquidate_stays_stale() {
    let (w, repo_id) = w_defaulted();
    let lender_usdc = w.usdc.balance(&w.lender);

    for (label, later) in [
        ("30 demo days", 30 * DAY_SECS),
        ("30 real days", 30 * 86_400),
    ] {
        w.t(MATURED + later);
        let liq = w.repo.try_liquidate(&w.liquidator, &repo_id);
        std::println!(
            "[nav-outage] {label} after default: liquidate={liq:?} status={:?} open_debt={} \
             collateral_in_contract={} lender_usdc_delta={}",
            w.repo.repo(&repo_id).status,
            w.repo.open_debt(&w.tbenji),
            w.tbenji_token.balance(&w.repo.address),
            w.usdc.balance(&w.lender) - lender_usdc,
        );
        assert_eq!(liq, Err(Ok(Error::StaleNav)));
        assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
        assert_eq!(w.repo.open_debt(&w.tbenji), DEBT);
        assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);
        assert_eq!(w.usdc.balance(&w.lender), lender_usdc);
        assert_eq!(w.tbenji_token.balance(&w.lender), 0);
    }
}

/// The fallback: closed up to and at the exact second the NAV has been
/// stale for 7 days, open one second later. The lender gets the whole
/// collateral, open_debt drops to 0, the repo is Liquidated and every other
/// settlement path is closed.
#[test]
fn outage_lender_claims_in_kind_after_seven_days_stale() {
    let (w, repo_id) = w_defaulted();

    // Stale (age 481 s > 180 s) but not for 7 days yet.
    assert_eq!(
        w.repo.try_claim_in_kind(&repo_id),
        Err(Ok(Error::NoNavOutage))
    );
    w.t(OUTAGE_EDGE);
    assert_eq!(
        w.repo.try_claim_in_kind(&repo_id),
        Err(Ok(Error::NoNavOutage))
    );
    assert_eq!(w.repo.open_debt(&w.tbenji), DEBT);

    w.t(OUTAGE_EDGE + 1);
    let lender_usdc = w.usdc.balance(&w.lender);
    let claimed = w.repo.claim_in_kind(&repo_id);
    std::println!(
        "[nav-outage] after fix, {} s after last NAV: claim_in_kind={claimed} status={:?} \
         open_debt={} collateral_in_contract={} lender_tbenji={} lender_usdc_delta={}",
        OUTAGE_EDGE + 1 - NOW,
        w.repo.repo(&repo_id).status,
        w.repo.open_debt(&w.tbenji),
        w.tbenji_token.balance(&w.repo.address),
        w.tbenji_token.balance(&w.lender),
        w.usdc.balance(&w.lender) - lender_usdc,
    );
    assert_eq!(claimed, TAKE_COLLATERAL);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
    assert_eq!(w.repo.open_debt(&w.tbenji), 0);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);
    assert_eq!(w.tbenji_token.balance(&w.lender), TAKE_COLLATERAL);
    assert_eq!(w.repo.claimable_collateral(&w.lender, &w.tbenji), 0);

    // Settled once: no second claim, no repay, no sale when the NAV returns.
    assert_eq!(
        w.repo.try_claim_in_kind(&repo_id),
        Err(Ok(Error::InvalidStatus))
    );
    assert_eq!(w.repo.try_repay(&repo_id), Err(Ok(Error::InvalidStatus)));
    w.set_nav(ONE, OUTAGE_EDGE + 1);
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &repo_id),
        Err(Ok(Error::InvalidStatus))
    );
}

/// The freed cap is real: with the cap set to exactly one debt, a second
/// take fails `CapExceeded` while the first repo sits Defaulted in the
/// outage, and passes after the in-kind claim once the feed is back.
#[test]
fn outage_claim_frees_the_asset_cap() {
    let w = world();
    let mut cfg = w.repo.asset(&w.tbenji);
    cfg.max_open_debt = DEBT;
    w.repo.set_asset(&w.tbenji, &cfg);
    let repo_id = w.defaulted_after_feed_stops();

    w.t(OUTAGE_EDGE + 1);
    w.set_nav(ONE, OUTAGE_EDGE + 1); // feed back, liquidity needed again
    let offer = w
        .repo
        .create_offer(&w.lender, &w.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer, &false),
        Err(Ok(Error::CapExceeded))
    );
    // A fresh NAV closes the in-kind path again: the sale is the exit now.
    assert_eq!(
        w.repo.try_claim_in_kind(&repo_id),
        Err(Ok(Error::NoNavOutage))
    );
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(w.repo.open_debt(&w.tbenji), 0);
    w.tbenji_admin.mint(&w.borrower, &(5_000 * UNIT));
    w.repo.take_offer(&w.borrower, &offer, &false);
    assert_eq!(w.repo.open_debt(&w.tbenji), DEBT);
}

/// Same cap, no feed recovery: the in-kind claim alone frees it.
#[test]
fn outage_claim_in_kind_frees_cap_without_feed() {
    let w = world();
    let mut cfg = w.repo.asset(&w.tbenji);
    cfg.max_open_debt = DEBT;
    w.repo.set_asset(&w.tbenji, &cfg);
    let repo_id = w.defaulted_after_feed_stops();
    w.t(OUTAGE_EDGE + 1);
    w.repo.claim_in_kind(&repo_id);
    assert_eq!(w.repo.open_debt(&w.tbenji), 0);
}

/// The borrower keeps the a2 exit through the outage: repay out of
/// Defaulted needs no NAV, and once it lands the lender cannot claim.
#[test]
fn outage_borrower_repays_before_claim() {
    let (w, repo_id) = w_defaulted();
    w.t(OUTAGE_EDGE + 1);
    StellarAssetClient::new(&w.env, &w.usdc.address).mint(&w.borrower, &(1_000 * UNIT));
    w.repo.repay(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
    assert_eq!(w.tbenji_token.balance(&w.borrower), 5_000 * UNIT);
    assert_eq!(
        w.repo.try_claim_in_kind(&repo_id),
        Err(Ok(Error::InvalidStatus))
    );
}

/// Only a Defaulted repo: an overdue Open repo must be defaulted first.
#[test]
fn outage_claim_needs_defaulted() {
    let w = world();
    let repo_id = w.take();
    w.t(OUTAGE_EDGE + 1);
    assert_eq!(
        w.repo.try_claim_in_kind(&repo_id),
        Err(Ok(Error::InvalidStatus))
    );
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);
}

/// `no_seize` (#30) holds the in-kind claim like it holds `liquidate`.
#[test]
fn outage_claim_respects_no_seize() {
    let (w, repo_id) = w_defaulted();
    w.repo.set_pause(
        &w.tbenji,
        &Pause {
            no_new_repos: false,
            no_seize: true,
        },
    );
    w.t(OUTAGE_EDGE + 1);
    assert_eq!(w.repo.try_claim_in_kind(&repo_id), Err(Ok(Error::Paused)));
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
}

/// Lender only: the borrower's (or anyone else's) signature is not enough.
#[test]
fn outage_claim_needs_lender_auth() {
    let (w, repo_id) = w_defaulted();
    w.t(OUTAGE_EDGE + 1);
    w.env.mock_auths(&[MockAuth {
        address: &w.borrower,
        invoke: &MockAuthInvoke {
            contract: &w.repo.address,
            fn_name: "claim_in_kind",
            args: (repo_id,).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert!(w.repo.try_claim_in_kind(&repo_id).is_err());
    w.env.mock_all_auths();
    assert_eq!(w.repo.repo(&repo_id).status, Status::Defaulted);
}

/// A frozen trustline (SAC `set_authorized(false)` on the lender) refuses
/// the push: the claim still lands, the collateral is parked, and the lender
/// collects it once unfrozen. `claim_collateral` with nothing parked fails.
#[test]
fn outage_claim_frozen_lender_parks_then_collects() {
    let (w, repo_id) = w_defaulted();
    w.tbenji_admin.set_authorized(&w.lender, &false);
    w.t(OUTAGE_EDGE + 1);
    assert_eq!(w.repo.claim_in_kind(&repo_id), TAKE_COLLATERAL);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
    assert_eq!(w.repo.open_debt(&w.tbenji), 0);
    assert_eq!(
        w.repo.claimable_collateral(&w.lender, &w.tbenji),
        TAKE_COLLATERAL
    );
    assert_eq!(w.tbenji_token.balance(&w.repo.address), TAKE_COLLATERAL);

    // Still frozen: the collect reverts and the balance stays parked.
    assert!(w
        .repo
        .try_claim_collateral(&w.lender, &w.tbenji, &w.lender)
        .is_err());
    assert_eq!(
        w.repo.claimable_collateral(&w.lender, &w.tbenji),
        TAKE_COLLATERAL
    );

    w.tbenji_admin.set_authorized(&w.lender, &true);
    assert_eq!(
        w.repo.claim_collateral(&w.lender, &w.tbenji, &w.lender),
        TAKE_COLLATERAL
    );
    assert_eq!(w.tbenji_token.balance(&w.lender), TAKE_COLLATERAL);
    assert_eq!(w.tbenji_token.balance(&w.repo.address), 0);
    assert_eq!(
        w.repo.try_claim_collateral(&w.lender, &w.tbenji, &w.lender),
        Err(Ok(Error::NothingToClaim))
    );
}

/// The window runs from the last NAV, not from the default: a feed dead
/// long before maturity opens the claim as soon as the repo defaults.
#[test]
fn outage_claim_opens_at_default_when_feed_died_long_before() {
    let w = world();
    let repo_id = w.take();
    w.t(MATURED + 30 * DAY_SECS);
    assert_eq!(w.repo.default(&repo_id), Status::Defaulted);
    assert_eq!(w.repo.claim_in_kind(&repo_id), TAKE_COLLATERAL);
}

/// A feed that re-posts the old price with a fresh timestamp (our testnet
/// nav-keeper) hides the outage: the in-kind path never opens and the
/// sale goes ahead at the re-posted price. Why production feeds must carry
/// the source publication time (drafted DECISIONS row).
#[test]
fn outage_reposting_feeder_hides_outage() {
    let (w, repo_id) = w_defaulted();
    let later = MATURED + 30 * DAY_SECS;
    w.t(later);
    w.set_nav(ONE, later); // re-stamped, not re-published
    assert_eq!(
        w.repo.try_claim_in_kind(&repo_id),
        Err(Ok(Error::NoNavOutage))
    );
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
}

// --- feed with no usable timestamp (QA residual of t_ca1e5c8a) ---------------

/// Fallback clock start for a repo taken at NOW: `maturity_ts + grace_secs`.
const FALLBACK_START: u64 = NOW + TERM_SECS + GRACE_SECS;
/// Last second the claim is still closed on the fallback clock:
/// 1_480 + 180 + 7 × 60 = 2_080 (later than `OUTAGE_EDGE`, 1_600).
const FALLBACK_EDGE: u64 = FALLBACK_START + DEMO_NAV_AGE + NAV_OUTAGE_DAYS * DAY_SECS;
/// A real ledger time (~Jan 2027) stamped in milliseconds: the ledger never
/// reaches it, so the record stays future-dated.
const MS_STAMP: u64 = 1_800_000_000 * 1_000;

impl W<'_> {
    /// Closed at the fallback edge second (and so at `OUTAGE_EDGE + 1`,
    /// where a usable NAV posted at NOW would already have opened it), open
    /// one second later; the lender takes the whole collateral.
    fn claim_opens_on_fallback_clock(&self, repo_id: u64) {
        for ts in [OUTAGE_EDGE + 1, FALLBACK_EDGE] {
            self.t(ts);
            assert_eq!(
                self.repo.try_claim_in_kind(&repo_id),
                Err(Ok(Error::NoNavOutage))
            );
        }
        // The sale stays blocked: `fresh_nav` rejects this feed.
        assert_eq!(
            self.repo.try_liquidate(&self.liquidator, &repo_id),
            Err(Ok(Error::NoPrice))
        );
        self.t(FALLBACK_EDGE + 1);
        assert_eq!(self.repo.claim_in_kind(&repo_id), TAKE_COLLATERAL);
        assert_eq!(self.repo.repo(&repo_id).status, Status::Liquidated);
        assert_eq!(self.repo.open_debt(&self.tbenji), 0);
        assert_eq!(self.tbenji_token.balance(&self.lender), TAKE_COLLATERAL);
    }
}

/// QA repro: after the default the feeder posts one NAV stamped in
/// milliseconds (a real time × 1000) and stops. The real oracle keeps history
/// sorted, so that record stays `lastprice` for good and `liquidate` fails
/// `NoPrice`. Before the fix the in-kind claim counted it as fresh and
/// never opened (QA: 30 real days later still `NoNavOutage`); now the clock
/// runs from maturity + grace.
#[test]
fn outage_future_dated_nav_opens_on_maturity_clock() {
    let (w, repo_id) = w_defaulted();
    w.set_nav(ONE, MS_STAMP);
    w.claim_opens_on_fallback_clock(repo_id);
}

/// Same with 30 real days gone: the claim is open, not locked for ever.
#[test]
fn outage_future_dated_nav_claim_open_after_30_real_days() {
    let (w, repo_id) = w_defaulted();
    w.set_nav(ONE, MS_STAMP);
    w.t(MATURED + 30 * 86_400);
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &repo_id),
        Err(Ok(Error::NoPrice))
    );
    assert_eq!(w.repo.claim_in_kind(&repo_id), TAKE_COLLATERAL);
    assert_eq!(w.repo.open_debt(&w.tbenji), 0);
}

/// Never-priced asset: after the default the admin re-points the asset to a
/// feed key that has no price (timelocked, #33). `lastprice` is `None`, so
/// there is no timestamp at all; the clock runs from maturity + grace.
#[test]
fn outage_never_priced_asset_opens_on_maturity_clock() {
    let (w, repo_id) = w_defaulted();
    let mut cfg = w.repo.asset(&w.tbenji);
    cfg.oracle_asset = Asset::Stellar(Address::generate(&w.env));
    w.repo.propose_asset(&w.tbenji, &cfg);
    w.t(MATURED + TIMELOCK);
    w.repo.execute_asset(&w.tbenji);
    assert_eq!(w.repo.asset(&w.tbenji).oracle_asset, cfg.oracle_asset);
    w.claim_opens_on_fallback_clock(repo_id);
}

/// A price `<= 0` is no price too (`oracle::nav` = `NoPrice`).
#[test]
fn outage_zero_price_opens_on_maturity_clock() {
    let (w, repo_id) = w_defaulted();
    w.set_nav(0, MATURED);
    w.claim_opens_on_fallback_clock(repo_id);
}

/// The skew boundary matches `fresh_nav`: a NAV dated exactly
/// `MAX_FUTURE_SKEW_SECS` ahead is usable (age 0, claim closed); one second
/// further is not, and the maturity clock, already past, opens the claim.
#[test]
fn outage_future_skew_edge_matches_fresh_nav() {
    let open_at = FALLBACK_EDGE + 1;

    let (w, repo_id) = w_defaulted();
    w.t(open_at);
    w.set_nav(ONE, open_at + MAX_FUTURE_SKEW_SECS);
    assert_eq!(
        w.repo.try_claim_in_kind(&repo_id),
        Err(Ok(Error::NoNavOutage))
    );

    let (w, repo_id) = w_defaulted();
    w.t(open_at);
    w.set_nav(ONE, open_at + MAX_FUTURE_SKEW_SECS + 1);
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &repo_id),
        Err(Ok(Error::NoPrice))
    );
    assert_eq!(w.repo.claim_in_kind(&repo_id), TAKE_COLLATERAL);
}

/// QA variant: the fallback clock lasts only while the feed has no usable
/// timestamp. A price `<= 0` after the default, then a real price returns
/// before the fallback edge: the claim follows the new price's clock (closed
/// one second past the old fallback edge) and the sale goes ahead instead.
#[test]
fn outage_fallback_ends_when_a_usable_price_returns() {
    let (w, repo_id) = w_defaulted();
    w.set_nav(0, MATURED);
    let back = FALLBACK_EDGE - 10;
    w.t(back);
    w.set_nav(ONE, back);
    w.t(FALLBACK_EDGE + 1);
    assert_eq!(
        w.repo.try_claim_in_kind(&repo_id),
        Err(Ok(Error::NoNavOutage))
    );
    w.repo.liquidate(&w.liquidator, &repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
    assert_eq!(w.repo.open_debt(&w.tbenji), 0);
}
