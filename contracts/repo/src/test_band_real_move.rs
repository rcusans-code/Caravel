//! NAV side 4 (band-real-move, NAV review 2026-10-26): a genuine NAV move
//! larger than the sanity band (#31) freezes `check_margin`, missed-call
//! `default` and `liquidate` until the 20-record window rolls or a widening
//! clears the timelock (#33). EUTBL launch values: haircut 500, trigger 350,
//! band 150 bps. These tests measure today's recovery time in records and in
//! seconds at nav-keeper's 60 s cadence and at a once-a-day NAV.
//!
//! Run with `--nocapture` to see the measured numbers (`BAND-REAL-MOVE` lines).

extern crate std;

use std::println;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

use crate::{
    oracle::{
        mock::{setup_mock_oracle, MockOracleClient, ONE},
        NAV_BAND_RECORDS,
    },
    test::{demo_config, NO_CAP, UNIT},
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Config, Error, Status,
};

/// EUTBL launch values (DECISIONS #26, #31; README parameter table).
const EUTBL_HAIRCUT: u32 = 500;
const EUTBL_TRIGGER: u32 = 350;
const EUTBL_BAND: u32 = 150;

const MINUTE: u64 = 60;
const DAY: u64 = 86_400;
/// Start of the feed history; large enough for 20 daily records before it.
const T0: u64 = 10_000_000;

const PRINCIPAL: i128 = 970 * UNIT;
const APR_BPS: u32 = 500;

/// Feed cadence and the matching protocol profile.
#[derive(Clone, Copy)]
struct Profile {
    name: &'static str,
    cadence: u64,
    max_nav_age: u64,
    term: u64,
}

/// nav-keeper re-posts every 60 s; demo time (#5).
const DEMO: Profile = Profile {
    name: "60 s cadence (demo, nav-keeper)",
    cadence: MINUTE,
    max_nav_age: 180,
    term: 7 * MINUTE,
};

/// A fund printing NAV once a day (production intent, README table).
const DAILY: Profile = Profile {
    name: "daily cadence (production)",
    cadence: DAY,
    max_nav_age: 345_600,
    term: 7 * DAY,
};

fn config(env: &Env, p: Profile) -> Config {
    let mut c = demo_config(env);
    if p.cadence == DAY {
        c.day_secs = DAY;
        c.margin_window_secs = 3 * DAY;
        c.grace_secs = DAY;
        c.timelock_secs = 2 * DAY;
    }
    c
}

struct W<'a> {
    env: Env,
    p: Profile,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    token: Address,
    oracle: MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
    /// Ledger time of the next feed record.
    next_ts: u64,
}

fn eutbl(token: &Address, p: Profile, band: u32) -> AssetConfig {
    AssetConfig {
        oracle_asset: Asset::Stellar(token.clone()),
        haircut_bps: EUTBL_HAIRCUT,
        margin_trigger_bps: EUTBL_TRIGGER,
        enabled: true,
        max_nav_age_secs: p.max_nav_age,
        max_nav_move_bps: band,
        nav_floor: None,
        nav_ceiling: None,
        max_open_debt: NO_CAP,
    }
}

/// A full 20-record window at NAV 1.00, one record per cadence, the last at
/// `T0`; ledger at `T0`.
fn world<'a>(p: Profile) -> W<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().set_timestamp(T0);

    let issuer = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let token = env.register_stellar_asset_contract_v2(issuer).address();
    let oracle = MockOracleClient::new(&env, &setup_mock_oracle(&env));

    let mut cfg = config(&env, p);
    cfg.usdc = usdc.clone();
    cfg.oracle = oracle.address.clone();
    let id = env.register(CaravelRepo, (cfg,));
    let repo = CaravelRepoClient::new(&env, &id);
    repo.set_asset(&token, &eutbl(&token, p, EUTBL_BAND));

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &(10_000 * UNIT));
    usdc_admin.mint(&borrower, &(100 * UNIT));
    usdc_admin.mint(&liquidator, &(5_000 * UNIT));
    StellarAssetClient::new(&env, &token).mint(&borrower, &(5_000 * UNIT));
    repo.set_liquidator(&liquidator, &true);

    let mut w = W {
        usdc: TokenClient::new(&env, &usdc),
        repo,
        token,
        oracle,
        lender,
        borrower,
        liquidator,
        next_ts: T0 - (NAV_BAND_RECORDS as u64 - 1) * p.cadence,
        p,
        env,
    };
    for _ in 0..NAV_BAND_RECORDS {
        w.post(ONE);
    }
    w
}

impl W<'_> {
    /// One feed record at the next cadence tick; the ledger moves with it.
    fn post(&mut self, price: i128) {
        let ts = self.next_ts;
        self.env.ledger().set_timestamp(ts);
        self.oracle
            .set_price(&Asset::Stellar(self.token.clone()), &price, &ts);
        self.next_ts = ts + self.p.cadence;
    }
    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }
    fn take(&self) -> u64 {
        let id = self.repo.create_offer(
            &self.lender,
            &self.token,
            &PRINCIPAL,
            &APR_BPS,
            &self.p.term,
        );
        self.repo.take_offer(&self.borrower, &id, &false)
    }
    fn margin(&self, repo_id: u64) -> Result<Status, Error> {
        match self.repo.try_check_margin(&repo_id) {
            Ok(Ok(s)) => Ok(s),
            Err(Ok(e)) => Err(e),
            other => panic!("unexpected {other:?}"),
        }
    }
}

fn pct(price: i128) -> f64 {
    price as f64 / ONE as f64
}

/// A real 2% drop (EUR/USD on EUTBL) from a full window at 1.00: the loan is
/// past the 3.5% trigger, yet `check_margin` is `NavOutOfBand` until 19
/// re-posts of 0.98 have pushed every 1.00 out of the window.
fn real_drop(p: Profile) -> (u32, u64) {
    let mut w = world(p);
    let repo_id = w.take();
    assert_eq!(w.margin(repo_id), Ok(Status::Open));

    let drop_at = w.next_ts;
    w.post(ONE * 98 / 100);
    assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));

    let mut reposts = 0u32;
    while w.margin(repo_id) == Err(Error::NavOutOfBand) {
        w.post(ONE * 98 / 100);
        reposts += 1;
        assert!(reposts <= 100, "never recovered");
    }
    let frozen = w.now() - drop_at;
    // The breach was real all along: the first accepted check calls it.
    assert_eq!(w.margin(repo_id), Ok(Status::MarginCall));
    println!(
        "BAND-REAL-MOVE before | 2% drop, EUTBL 150 bps, {}: check_margin NavOutOfBand for {} re-posts = {} s ({:.2} days), then MarginCall",
        p.name,
        reposts,
        frozen,
        frozen as f64 / DAY as f64
    );
    (reposts, frozen)
}

#[test]
fn real_2pct_drop_freezes_margin_call_60s() {
    assert_eq!(real_drop(DEMO), (19, 19 * MINUTE));
}

#[test]
fn real_2pct_drop_freezes_margin_call_daily() {
    assert_eq!(real_drop(DAILY), (19, 19 * DAY));
}

/// Daily feed, 7-day EUTBL repo: EUR/USD drops 2% in a day and keeps
/// sliding 0.1% a day for 30 days. The borrower walks. Maturity default needs
/// no NAV and lands on day 8, but `liquidate` stays `NavOutOfBand` for as long
/// as the slide runs plus the window roll, while the lender's cover shrinks.
#[test]
fn real_drop_then_slide_daily_lender_waits_and_loses() {
    let mut w = world(DAILY);
    let repo_id = w.take();
    let repo = w.repo.repo(&repo_id);
    let debt = repo.principal + repo.interest;
    let collateral = repo.collateral_amount;
    let mut price = ONE * 98 / 100;
    w.post(price);

    let mut defaulted = None;
    let mut liquidated = None;
    for day in 1..=60u64 {
        if day <= 30 {
            price = price * 999 / 1_000;
        }
        w.post(price);
        if defaulted.is_none() && w.now() > repo.maturity_ts + DAY {
            assert_eq!(w.repo.default(&repo_id), Status::Defaulted);
            defaulted = Some((day, price));
        }
        if defaulted.is_some() {
            match w.repo.try_liquidate(&w.liquidator, &repo_id) {
                Err(Ok(Error::NavOutOfBand)) => {}
                Ok(Ok(())) => {
                    liquidated = Some((day, price));
                    break;
                }
                other => panic!("unexpected {other:?}"),
            }
        }
    }
    let (d_day, d_price) = defaulted.unwrap();
    let (l_day, l_price) = liquidated.unwrap();
    // Proceeds = collateral x NAV x (1 - 2%) (math::liquidation_proceeds).
    let proceeds = |nav: i128| collateral * nav / ONE * 98 / 100;
    let lender_got = w.usdc.balance(&w.lender) - (10_000 * UNIT - PRINCIPAL);
    let usdc = |v: i128| v as f64 / UNIT as f64;
    println!(
        "BAND-REAL-MOVE before | -2% then -0.1%/day x30, daily, 7-day term, debt {:.2}: default day {} (NAV {:.4}, proceeds then {:.2}); liquidate NavOutOfBand until day {} (NAV {:.4}): {} days frozen after default; lender received {:.2}, shortfall {:.2}, proceeds fell {:.2} during the freeze",
        usdc(debt),
        d_day,
        pct(d_price),
        usdc(proceeds(d_price)),
        l_day,
        pct(l_price),
        l_day - d_day,
        usdc(lender_got),
        usdc(debt - lender_got),
        usdc(proceeds(d_price) - proceeds(l_price)),
    );
    assert_eq!((d_day, l_day), (8, 34));
}

/// The timelocked widening (#31, #33) is today's fast path: proposed the
/// moment the drop prints, it lands `timelock_secs` later.
#[test]
fn widening_recovers_after_timelock() {
    for p in [DEMO, DAILY] {
        let mut w = world(p);
        let repo_id = w.take();
        let drop_at = w.next_ts;
        w.post(ONE * 98 / 100);
        assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
        w.repo.propose_asset(&w.token, &eutbl(&w.token, p, 300));
        let mut frozen_records = 0;
        loop {
            w.post(ONE * 98 / 100);
            frozen_records += 1;
            if w.repo.try_execute_asset(&w.token).is_ok() {
                break;
            }
            assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
        }
        assert_eq!(w.margin(repo_id), Ok(Status::MarginCall));
        println!(
            "BAND-REAL-MOVE before | 2% drop, {}: widening 150 -> 300 bps proposed at the drop, executed after {} s ({} records); band stays 300 bps until a manual re-tighten",
            p.name,
            w.now() - drop_at,
            frozen_records
        );
    }
}

/// A steady trend of `step_ppm` per record (1_000 = +0.1%). Returns (first
/// frozen record, frozen records while the trend runs for `trend` records,
/// records after the trend stops until accepted).
fn trend(p: Profile, step_ppm: i128, trend_records: u32) -> (Option<u32>, u32, u32) {
    let mut w = world(p);
    // Healthy repo far from the trigger either way: only the band can block.
    let repo_id = w.take();
    w.repo.top_up(&repo_id, &(1_000 * UNIT));
    let mut price = ONE;
    let mut first = None;
    let mut frozen = 0u32;
    for i in 1..=trend_records {
        price = price * (1_000_000 + step_ppm) / 1_000_000;
        w.post(price);
        if w.margin(repo_id) == Err(Error::NavOutOfBand) {
            frozen += 1;
            first.get_or_insert(i);
        }
    }
    let mut settle = 0u32;
    while w.margin(repo_id) == Err(Error::NavOutOfBand) {
        w.post(price);
        settle += 1;
        assert!(settle <= 100);
    }
    println!(
        "BAND-REAL-MOVE before | trend {:+.3}%/record for {} records, {}: first frozen at record {:?} ({:?} s), frozen {} of {} records ({} s), recovers {} records ({} s) after the trend stops; final NAV {:.4}",
        step_ppm as f64 / 10_000.0,
        trend_records,
        p.name,
        first,
        first.map(|r| r as u64 * p.cadence),
        frozen,
        trend_records,
        frozen as u64 * p.cadence,
        settle,
        settle as u64 * p.cadence,
        pct(price)
    );
    (first, frozen, settle)
}

/// +0.1% per record (1.9% over a full window, the band is 1.5%): frozen from
/// record 15 for as long as the trend runs.
#[test]
fn slow_trend_up_freezes_60s_and_daily() {
    for p in [DEMO, DAILY] {
        let (first, frozen, settle) = trend(p, 1_000, 40);
        assert_eq!(first, Some(15));
        assert_eq!(frozen, 26);
        assert_eq!(settle, 5);
    }
}

/// Falling trend: the same freeze while the lender's cover shrinks (one
/// record later: the band is measured against the higher, older record).
#[test]
fn slow_trend_down_freezes() {
    let (first, frozen, settle) = trend(DAILY, -1_000, 40);
    assert_eq!(first, Some(16));
    assert_eq!(frozen, 25);
    assert_eq!(settle, 4);
}

/// The freeze threshold: 150 bps over 19 steps is ~0.078% per record.
#[test]
fn slow_trend_threshold() {
    assert_eq!(trend(DAILY, 780, 60).1, 0);
    assert!(trend(DAILY, 790, 60).1 > 0);
}
