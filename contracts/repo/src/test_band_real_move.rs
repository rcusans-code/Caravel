//! NAV side 4 (band-real-move, NAV review 2026-10-26): a genuine NAV move
//! larger than the sanity band (#31) froze `check_margin`, missed-call
//! `default` and `liquidate` until the 20-record window rolled or a widening
//! cleared the timelock (#33). The fix: a price the repo has watched stand
//! `band_settle_secs` of ledger time (`note_nav`, its own clock) is accepted.
//! EUTBL launch values: haircut 500, trigger 350, band 150 bps; settle
//! 86_400 s (production) / 1_200 s (demo).
//!
//! Every scenario runs twice: `before` = nobody calls `note_nav` (today's
//! behaviour, the code path of base 5faee32), `after` = keeper / nav-keeper
//! call `note_nav` after every feed post. Run with `--nocapture` to see the
//! measured numbers (`BAND-REAL-MOVE` lines).

extern crate std;

use std::println;

use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Symbol,
};

use crate::{
    oracle::{
        mock::{setup_mock_oracle, MockOracleClient, MOCK_DECIMALS, ONE},
        NAV_BAND_RECORDS,
    },
    test::{demo_config, NO_CAP, UNIT},
    Asset, AssetConfig, BandCandidate, CaravelRepo, CaravelRepoClient, Config, Error, Pause,
    Status,
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
    /// `AssetConfig.band_settle_secs` for this profile.
    settle: u64,
}

/// nav-keeper re-posts every 60 s; demo time (#5).
const DEMO: Profile = Profile {
    name: "60 s cadence (demo, nav-keeper)",
    cadence: MINUTE,
    max_nav_age: 180,
    term: 7 * MINUTE,
    settle: 1_200,
};

/// A fund printing NAV once a day (production intent, README table).
const DAILY: Profile = Profile {
    name: "daily cadence (production)",
    cadence: DAY,
    max_nav_age: 345_600,
    term: 7 * DAY,
    settle: DAY,
};

/// Who calls `note_nav`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    /// Nobody: today's behaviour.
    Before,
    /// After every feed post (keeper + nav-keeper each tick).
    After,
}

impl Mode {
    fn label(self) -> &'static str {
        match self {
            Mode::Before => "before",
            Mode::After => "after ",
        }
    }
}

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
    mode: Mode,
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
        band_settle_secs: p.settle,
    }
}

fn env() -> Env {
    // Up to ~100 feed posts per test: no ledger snapshots.
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env
}

/// A full 20-record window at NAV 1.00, one record per cadence, the last at
/// `T0`; ledger at `T0`.
fn world<'a>(p: Profile, mode: Mode) -> W<'a> {
    let env = env();
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
    crate::test::whitelist(&env, &repo, &liquidator);

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
        mode,
        env,
    };
    for _ in 0..NAV_BAND_RECORDS {
        w.post(ONE);
    }
    w
}

impl W<'_> {
    /// One feed record at the next cadence tick; the ledger moves with it.
    /// In `After` mode the keeper calls `note_nav` in the same ledger.
    fn post(&mut self, price: i128) {
        let ts = self.next_ts;
        self.post_stamped(price, ts);
    }
    /// Like `post`, but the feed stamps the record `stamp` (a feed that
    /// lies about time; the real mock oracle stamps ledger time).
    fn post_stamped(&mut self, price: i128, stamp: u64) {
        let ts = self.next_ts;
        self.env.ledger().set_timestamp(ts);
        self.oracle
            .set_price(&Asset::Stellar(self.token.clone()), &price, &stamp);
        self.next_ts = ts + self.p.cadence;
        if self.mode == Mode::After {
            self.repo.note_nav(&self.token);
        }
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
/// past the 3.5% trigger, yet `check_margin` is `NavOutOfBand` until either
/// the window rolls (19 re-posts) or, with `note_nav`, the level has stood
/// `band_settle_secs`.
fn real_drop(p: Profile, mode: Mode) -> (u32, u64) {
    let mut w = world(p, mode);
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
        "BAND-REAL-MOVE {} | 2% drop, EUTBL 150 bps, settle {} s, {}: check_margin NavOutOfBand for {} re-posts = {} s ({:.2} days), then MarginCall",
        mode.label(),
        p.settle,
        p.name,
        reposts,
        frozen,
        frozen as f64 / DAY as f64
    );
    (reposts, frozen)
}

#[test]
fn real_2pct_drop_freezes_margin_call_60s() {
    assert_eq!(real_drop(DEMO, Mode::Before), (19, 19 * MINUTE));
    // Demo settle (1_200 s) is longer than the 19-minute window roll at a
    // 60 s cadence: the roll still recovers first, nothing changes.
    assert_eq!(real_drop(DEMO, Mode::After), (19, 19 * MINUTE));
}

#[test]
fn real_2pct_drop_freezes_margin_call_daily() {
    assert_eq!(real_drop(DAILY, Mode::Before), (19, 19 * DAY));
    // One day of ledger time, then the next keeper tick.
    assert_eq!(real_drop(DAILY, Mode::After), (1, DAY));
}

/// Daily feed, 7-day EUTBL repo: EUR/USD drops 2% in a day and keeps
/// sliding 0.1% a day for 30 days. The borrower walks. Maturity default needs
/// no NAV and lands on day 8; `liquidate` was `NavOutOfBand` for as long as
/// the slide ran plus the window roll, while the lender's cover shrank.
fn slide(mode: Mode) -> (u64, u64, i128, i128) {
    let mut w = world(DAILY, mode);
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
        "BAND-REAL-MOVE {} | -2% then -0.1%/day x30, daily, 7-day term, debt {:.2}: default day {} (NAV {:.4}, proceeds then {:.2}); liquidated day {} (NAV {:.4}): {} days frozen after default; lender received {:.2}, shortfall {:.2}, proceeds fell {:.2} during the freeze",
        mode.label(),
        usdc(debt),
        d_day,
        pct(d_price),
        usdc(proceeds(d_price)),
        l_day,
        pct(l_price),
        l_day - d_day,
        usdc(lender_got),
        usdc((debt - lender_got).max(0)),
        usdc(proceeds(d_price) - proceeds(l_price)),
    );
    // Shortfall against the lender's cap (debt − protocol fee, #3).
    (d_day, l_day, debt - lender_got, repo.interest)
}

#[test]
fn real_drop_then_slide_daily_lender_waits_and_loses() {
    let (d_day, l_day, short, interest) = slide(Mode::Before);
    assert_eq!((d_day, l_day), (8, 34));
    assert!(short > interest, "lender short of principal before the fix");
    // The 0.98 level was noted the day it printed, and each later print
    // stays within 150 bps of it: liquidation lands the day of the default
    // and the lender is short only the protocol fee (a share of interest).
    let (d_day, l_day, short, interest) = slide(Mode::After);
    assert_eq!((d_day, l_day), (8, 8));
    assert!(short <= interest, "lender whole after the fix");
}

/// The timelocked widening (#31, #33) was the only fast path before: proposed
/// the moment the drop prints, it lands `timelock_secs` later and stays wide.
#[test]
fn widening_recovers_after_timelock() {
    for p in [DEMO, DAILY] {
        let mut w = world(p, Mode::Before);
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
fn trend(p: Profile, mode: Mode, step_ppm: i128, trend_records: u32) -> (Option<u32>, u32, u32) {
    let mut w = world(p, mode);
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
        "BAND-REAL-MOVE {} | trend {:+.3}%/record for {} records, {}: first frozen at record {:?} ({:?} s), frozen {} of {} records ({} s), recovers {} records ({} s) after the trend stops; final NAV {:.4}",
        mode.label(),
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
/// record 15 for as long as the trend runs. With `note_nav` on a daily feed
/// the level re-settles every ~1.5% of drift: one frozen day each time.
#[test]
fn slow_trend_up_freezes_60s_and_daily() {
    for p in [DEMO, DAILY] {
        assert_eq!(trend(p, Mode::Before, 1_000, 40), (Some(15), 26, 5));
    }
    assert_eq!(trend(DAILY, Mode::After, 1_000, 40), (Some(15), 2, 0));
    // 0.1% a minute (144% a day, no T-bill) restarts the level every 15
    // minutes, before the 20-minute demo settle: no change at 60 s.
    assert_eq!(trend(DEMO, Mode::After, 1_000, 40), (Some(15), 26, 5));
}

/// Falling trend: the same freeze while the lender's cover shrinks (one
/// record later: the band is measured against the higher, older record).
#[test]
fn slow_trend_down_freezes() {
    assert_eq!(trend(DAILY, Mode::Before, -1_000, 40), (Some(16), 25, 4));
    assert_eq!(trend(DAILY, Mode::After, -1_000, 40), (Some(16), 2, 0));
}

/// The freeze threshold: 150 bps over 19 steps is ~0.078% per record.
#[test]
fn slow_trend_threshold() {
    assert_eq!(trend(DAILY, Mode::Before, 780, 60).1, 0);
    assert!(trend(DAILY, Mode::Before, 790, 60).1 > 0);
}

// --- the settle clock itself -------------------------------------------------

/// A bad push held by a wrong feeder key (sides.md § 1) is accepted only
/// after `band_settle_secs` of ledger time: the guardian's window to pause.
/// A `nav_floor` still refuses it for good.
#[test]
fn bad_push_waits_out_the_settle_time_and_floor_still_holds() {
    let mut w = world(DEMO, Mode::After);
    let repo_id = w.take();
    let pushed_at = w.next_ts;
    w.post(ONE / 2);
    let mut records = 0;
    while w.margin(repo_id) == Err(Error::NavOutOfBand) {
        // Guardian could pause here; the clock is ledger time only.
        assert!(w.now() - pushed_at < DEMO.settle);
        w.post(ONE / 2);
        records += 1;
    }
    // Demo: window roll (19 min) and settle (20 min) race; whichever is first.
    assert!(w.now() - pushed_at <= DEMO.settle);
    println!(
        "BAND-REAL-MOVE after  | bad push 0.50, demo: accepted after {} s ({} re-posts)",
        w.now() - pushed_at,
        records
    );

    // Daily: the window would take 19 days; the settle path takes 1 day,
    // unless a floor is set.
    let mut w = world(DAILY, Mode::After);
    let repo_id = w.take();
    let pushed_at = w.next_ts;
    w.post(ONE / 2);
    assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
    w.env.ledger().set_timestamp(pushed_at + DAY - 1);
    assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
    w.env.ledger().set_timestamp(pushed_at + DAY);
    assert_eq!(w.margin(repo_id), Ok(Status::MarginCall));

    let mut floored = eutbl(&w.token, DAILY, EUTBL_BAND);
    floored.nav_floor = Some(ONE * 9 / 10);
    w.repo.set_asset(&w.token, &floored);
    assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
}

/// The clock is the repo's ledger time, never the feed's stamp: a record
/// stamped two days back is still "new" to the repo.
#[test]
fn feed_timestamps_cannot_start_the_clock_early() {
    let mut w = world(DAILY, Mode::After);
    let repo_id = w.take();
    let at = w.next_ts;
    w.post_stamped(ONE * 98 / 100, at - 2 * DAY);
    assert_eq!(
        w.repo.band_candidate(&w.token),
        Some(BandCandidate {
            price: ONE * 98 / 100,
            since: at
        })
    );
    assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
}

/// A failing call cannot start the clock: its writes roll back. Before any
/// `note_nav`, the window roll is the only way out (today's behaviour).
#[test]
fn only_note_nav_starts_the_clock() {
    let mut w = world(DAILY, Mode::Before);
    let repo_id = w.take();
    w.post(ONE * 98 / 100);
    assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
    assert_eq!(w.repo.band_candidate(&w.token), None);
    // Two days on (NAV age limit is four).
    w.env.ledger().set_timestamp(w.now() + 2 * DAY);
    assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
    // First note now: the clock starts now, not at the push.
    w.repo.note_nav(&w.token);
    assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
    w.env.ledger().set_timestamp(w.now() + DAY);
    assert_eq!(w.margin(repo_id), Ok(Status::MarginCall));
}

/// The level must hold the whole time: if the feed went back to 1.00 after
/// the clock started and nobody noted it, the old clock does not count, and
/// the next `note_nav` restarts it.
#[test]
fn a_reversal_in_between_voids_the_clock() {
    let mut w = world(DAILY, Mode::After);
    let repo_id = w.take();
    w.post(ONE * 98 / 100);
    let first = w.repo.band_candidate(&w.token).unwrap();
    // Feed back at 1.00 for three days, no keeper.
    w.mode = Mode::Before;
    for _ in 0..3 {
        w.post(ONE);
    }
    // 0.98 again: the 0.98 level is 4 days old, but 1.00 records since.
    w.post(ONE * 98 / 100);
    assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
    let restarted = w.repo.note_nav(&w.token);
    assert_eq!(restarted.price, first.price);
    assert_eq!(restarted.since, w.now());
    assert!(restarted.since > first.since);
    assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
    w.env.ledger().set_timestamp(w.now() + DAY);
    assert_eq!(w.margin(repo_id), Ok(Status::MarginCall));
}

/// `note_nav` writes (and emits `NavLevelNoted`) only when the level moves;
/// re-tiering the asset never restarts it.
#[test]
fn note_nav_keeps_the_level_and_set_asset_never_resets_it() {
    let mut w = world(DAILY, Mode::After);
    let level = w.repo.band_candidate(&w.token).unwrap();
    assert_eq!(level.price, ONE);
    assert_eq!(level.since, T0 - 19 * DAY);
    w.post(ONE + ONE / 1_000);
    assert_eq!(w.repo.band_candidate(&w.token), Some(level.clone()));
    // A no-op note emits nothing; a moved level emits `NavLevelNoted`.
    let repo_events = |w: &W| {
        w.env
            .events()
            .all()
            .filter_by_contract(&w.repo.address)
            .events()
            .len()
    };
    w.repo.note_nav(&w.token);
    assert_eq!(repo_events(&w), 0);
    w.post(ONE * 98 / 100);
    assert_eq!(repo_events(&w), 1);
    let moved = w.repo.band_candidate(&w.token).unwrap();
    assert_eq!(moved.since, w.now());
    w.repo.set_asset(&w.token, &eutbl(&w.token, DAILY, 100));
    assert_eq!(w.repo.band_candidate(&w.token), Some(moved));
}

#[test]
fn settle_time_is_validated_and_lowering_it_is_timelocked() {
    let w = world(DAILY, Mode::Before);
    let mut cfg = eutbl(&w.token, DAILY, EUTBL_BAND);
    cfg.band_settle_secs = 0;
    assert_eq!(
        w.repo.try_set_asset(&w.token, &cfg),
        Err(Ok(Error::InvalidConfig))
    );
    // Raising is a tightening: instant, guardian too.
    cfg.band_settle_secs = 2 * DAY;
    w.repo.guardian_set_asset(&w.token, &cfg);
    assert_eq!(w.repo.asset(&w.token).band_settle_secs, 2 * DAY);
    // Lowering loosens: only through the timelock.
    cfg.band_settle_secs = DAY;
    assert_eq!(
        w.repo.try_set_asset(&w.token, &cfg),
        Err(Ok(Error::Loosens))
    );
    assert_eq!(
        w.repo.try_guardian_set_asset(&w.token, &cfg),
        Err(Ok(Error::Loosens))
    );
    w.repo.propose_asset(&w.token, &cfg);
    w.env.ledger().set_timestamp(w.now() + 2 * DAY);
    w.repo.execute_asset(&w.token);
    assert_eq!(w.repo.asset(&w.token).band_settle_secs, DAY);
}

#[test]
fn note_nav_errors() {
    let env = env();
    let mut cfg = demo_config(&env);
    let oracle = setup_mock_oracle(&env);
    cfg.oracle = oracle;
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (cfg,)));
    let token = Address::generate(&env);
    assert_eq!(repo.try_note_nav(&token), Err(Ok(Error::AssetNotSupported)));
    assert_eq!(
        repo.try_band_candidate(&token),
        Err(Ok(Error::AssetNotSupported))
    );
    repo.set_asset(&token, &eutbl(&token, DEMO, EUTBL_BAND));
    assert_eq!(repo.try_note_nav(&token), Err(Ok(Error::NoPrice)));
    assert_eq!(repo.band_candidate(&token), None);
}

/// The guardian keeps its instant brake during the settle window:
/// `no_seize` holds a defaulted repo's liquidation even once the level settles.
#[test]
fn guardian_no_seize_still_holds_after_settle() {
    let mut w = world(DAILY, Mode::After);
    let repo_id = w.take();
    w.post(ONE * 98 / 100);
    w.repo.guardian_set_pause(
        &w.token,
        &Pause {
            no_new_repos: true,
            no_seize: true,
        },
    );
    w.post(ONE * 98 / 100);
    // Settled: the margin call is raised, but nothing can be seized.
    assert_eq!(w.margin(repo_id), Ok(Status::MarginCall));
    w.env.ledger().set_timestamp(w.now() + 4 * DAY);
    w.oracle.set_price(
        &Asset::Stellar(w.token.clone()),
        &(ONE * 98 / 100),
        &w.now(),
    );
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::Paused)));
}

/// Same 2% drop on the real mock oracle (`contracts/oracle`, ledger-stamped
/// records, one per resolution slot) at a daily resolution: accepted one day
/// after the level was first noted.
#[test]
fn real_oracle_daily_resolution_settles_in_a_day() {
    let env = env();
    let issuer = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let token = env.register_stellar_asset_contract_v2(issuer).address();
    let oracle_id = env.register(
        caravel_oracle::MockOracle,
        (
            Address::generate(&env),
            caravel_oracle::Asset::Other(Symbol::new(&env, "USD")),
            MOCK_DECIMALS,
            DAY as u32,
        ),
    );
    let feed = caravel_oracle::MockOracleClient::new(&env, &oracle_id);
    let feed_asset = caravel_oracle::Asset::Stellar(token.clone());
    let mut cfg = config(&env, DAILY);
    cfg.usdc = usdc.clone();
    cfg.oracle = oracle_id;
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (cfg,)));
    repo.set_asset(&token, &eutbl(&token, DAILY, EUTBL_BAND));

    let mut t = T0;
    let mut post = |price: i128| {
        env.ledger().set_timestamp(t);
        feed.set_price(&feed_asset, &price);
        repo.note_nav(&token);
        t += DAY;
    };
    for _ in 0..NAV_BAND_RECORDS {
        post(ONE);
    }
    post(ONE * 98 / 100);
    let dropped = env.ledger().timestamp();
    // The read path `take_offer` / `check_margin` / `liquidate` use.
    let check = |at: u64| {
        env.ledger().set_timestamp(at);
        env.as_contract(&repo.address, || {
            crate::oracle::fresh_nav(
                &env,
                &crate::storage::read_config(&env),
                &crate::storage::read_asset(&env, &token).unwrap(),
            )
        })
    };
    assert_eq!(check(dropped + DAY - 1), Err(Error::NavOutOfBand));
    assert_eq!(check(dropped + DAY).map(|(p, _)| p), Ok(ONE * 98 / 100));
}

// --- corridor jump (QA t_28264b5d) --------------------------------------------

/// `level × (1 + 145 bps)`: inside the 150 bps band of a 1.00 level.
const CORRIDOR_HIGH: i128 = ONE * 10_145 / 10_000;
/// `level × (1 − 144 bps)`: inside the band of 1.00, ~2.85% below the high.
const CORRIDOR_LOW: i128 = ONE * 9_856 / 10_000;

/// A level that has stood far longer than the settle time (the steady state:
/// the keeper notes every tick and drift stays inside the band of the old
/// level), a full window at one edge of the corridor, then one push to the
/// other edge. Both pushes are inside the band of the level, but the jump is
/// about twice the band against every record: it must not pass in the same
/// ledger (or the next tick) in either mode.
fn corridor_world<'a>(p: Profile, mode: Mode, edge: i128) -> W<'a> {
    let mut w = world(p, mode);
    for _ in 0..NAV_BAND_RECORDS {
        w.post(edge);
    }
    if mode == Mode::After {
        let level = w.repo.band_candidate(&w.token).unwrap();
        assert_eq!(level.price, ONE);
        assert!(w.now() - level.since >= p.settle);
    }
    w
}

#[test]
fn corridor_jump_is_not_accepted_instantly() {
    for p in [DAILY, DEMO] {
        for mode in [Mode::Before, Mode::After] {
            let mut w = corridor_world(p, mode, CORRIDOR_HIGH);
            let repo_id = w.take();
            assert_eq!(w.margin(repo_id), Ok(Status::Open));
            w.post(CORRIDOR_LOW);
            assert_eq!(
                w.margin(repo_id),
                Err(Error::NavOutOfBand),
                "{} {:?}: -2.85% push accepted at once",
                p.name,
                mode
            );
            // Next tick, same price: 18 records at the high still in view.
            w.post(CORRIDOR_LOW);
            assert_eq!(w.margin(repo_id), Err(Error::NavOutOfBand));
        }
    }
}

/// Upward variant: a full window at the low edge, one push to the high edge;
/// `take_offer` must refuse it (it would over-value the collateral).
#[test]
fn corridor_jump_up_is_refused_by_take_offer() {
    for p in [DAILY, DEMO] {
        for mode in [Mode::Before, Mode::After] {
            let mut w = corridor_world(p, mode, CORRIDOR_LOW);
            w.post(CORRIDOR_HIGH);
            let id = w
                .repo
                .create_offer(&w.lender, &w.token, &PRINCIPAL, &APR_BPS, &w.p.term);
            assert_eq!(
                w.repo.try_take_offer(&w.borrower, &id, &false),
                Err(Ok(Error::NavOutOfBand)),
                "{} {:?}: +2.93% push accepted at once",
                p.name,
                mode
            );
        }
    }
}
