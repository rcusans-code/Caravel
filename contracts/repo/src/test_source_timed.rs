//! Source-timed NAV feed (DECISIONS #39 draft, card t_619b8285): eurSAFO's
//! price is posted by `scripts/keeper/src/spiko-nav.ts` with the real oracle's
//! `set_price_at`, stamped with Spiko's own publication time, never the
//! time the keeper posted it. These tests run the repo against that oracle
//! (`contracts/oracle`, asset switched to source-timed) on a production-shaped
//! profile (day 86,400 s, eurSAFO params from docs/research/spiko-nav/size.py:
//! NAV age 96 h, band 500 bps, settle 1 day, haircut 3,000, trigger 2,050) and
//! check that every freshness rule now measures the NAV's age:
//! staleness (#25), the weekend gap, the claim-in-kind outage clock (#38) and
//! the band window (#31) over 20 real daily prints.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Symbol,
};

use crate::{
    oracle::mock::MOCK_DECIMALS,
    test::{demo_config, UNIT},
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Error, Status,
};

const DAY: u64 = 86_400;
const HOUR: u64 = 3_600;
const MAX_AGE: u64 = 96 * HOUR;
const PRINCIPAL: i128 = 970 * UNIT;
const APR_BPS: u32 = 500;
const TERM: u64 = 7 * DAY;

/// Mon 26 Oct 2026: Spiko published eurSAFO's NAV (1.015785 EUR) at
/// 17:48:20 UTC and the EUR/USD rate (1.1204) at 17:43:16; the feed posts
/// NAV × rate stamped with the older time (Public API, recorded in
/// docs/research/spiko-nav/data/eursafo.json).
const MON_PUB: u64 = 1_793_036_596;
const MON_PRICE: i128 = 113_808_551_400_000;
/// Fri 23 Oct 2026 15:45:57 UTC (NAV and rate published together).
const FRI_PUB: u64 = 1_792_770_357;
const FRI_PRICE: i128 = 113_799_812_280_000;

/// 20 consecutive real prints, 10 Sep .. 7 Oct 2026, `(source time, price)`:
/// the window with the largest spread in the history (369 bps, EUR/USD
/// falling from 1.1592 to 1.1176).
const REAL_WINDOW: [(u64, i128); 20] = [
    (1_789_058_659, 117_897_689_260_000), // 2026-09-10
    (1_789_138_379, 117_730_011_600_000), // 2026-09-11
    (1_789_402_779, 117_601_458_300_000), // 2026-09-14
    (1_789_486_072, 116_890_750_785_000), // 2026-09-15
    (1_789_568_819, 116_898_831_235_000), // 2026-09-16
    (1_789_651_132, 116_852_133_420_000), // 2026-09-17
    (1_789_750_436, 116_109_028_420_000), // 2026-09-18
    (1_790_006_063, 116_229_406_370_000), // 2026-09-21
    (1_790_094_466, 115_929_231_050_000), // 2026-09-22
    (1_790_191_574, 115_522_620_345_000), // 2026-09-23
    (1_790_267_859, 115_252_742_000_000), // 2026-09-24
    (1_790_351_875, 115_557_964_995_000), // 2026-09-25
    (1_790_608_342, 115_186_754_040_000), // 2026-09-28
    (1_790_707_831, 115_195_504_320_000), // 2026-09-29
    (1_790_779_435, 115_148_611_110_000), // 2026-09-30
    (1_790_871_347, 114_209_413_950_000), // 2026-10-01
    (1_790_954_409, 114_377_632_040_000), // 2026-10-02
    (1_791_217_822, 113_676_521_860_000), // 2026-10-05
    (1_791_302_827, 114_166_912_515_000), // 2026-10-06
    (1_791_386_223, 113_541_637_520_000), // 2026-10-07
];

struct W<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    token: Address,
    collateral: TokenClient<'a>,
    feed: caravel_oracle::MockOracleClient<'a>,
    asset: caravel_oracle::Asset,
    lender: Address,
    borrower: Address,
    liquidator: Address,
}

fn eursafo_cfg(token: &Address) -> AssetConfig {
    AssetConfig {
        oracle_asset: Asset::Stellar(token.clone()),
        haircut_bps: 3_000,
        margin_trigger_bps: 2_050,
        enabled: true,
        max_nav_age_secs: MAX_AGE,
        max_nav_move_bps: 500,
        nav_floor: None,
        nav_ceiling: None,
        max_open_debt: i128::MAX,
        band_settle_secs: DAY,
    }
}

/// Production-shaped repo on a real oracle whose eurSAFO asset is
/// source-timed. Ledger starts at `start`; nothing is priced yet.
fn world<'a>(start: u64) -> W<'a> {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.ledger().set_timestamp(start);
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
            60u32,
        ),
    );
    let feed = caravel_oracle::MockOracleClient::new(&env, &oracle_id);
    let asset = caravel_oracle::Asset::Stellar(token.clone());
    feed.set_source_timed(&asset, &true);

    let mut config = demo_config(&env);
    config.usdc = usdc.clone();
    config.oracle = oracle_id;
    config.liquidation_discount_bps = 100;
    config.day_secs = DAY;
    config.margin_window_secs = 3 * DAY;
    config.grace_secs = DAY;
    config.timelock_secs = 2 * DAY;
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (config,)));
    repo.set_asset(&token, &eursafo_cfg(&token));

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &(10_000 * UNIT));
    usdc_admin.mint(&borrower, &(100 * UNIT));
    usdc_admin.mint(&liquidator, &(5_000 * UNIT));
    StellarAssetClient::new(&env, &token).mint(&borrower, &(5_000 * UNIT));
    crate::test::whitelist(&env, &repo, &liquidator);

    W {
        usdc: TokenClient::new(&env, &usdc),
        collateral: TokenClient::new(&env, &token),
        repo,
        token,
        feed,
        asset,
        lender,
        borrower,
        liquidator,
        env,
    }
}

impl W<'_> {
    fn at(&self, ts: u64) {
        self.env.ledger().set_timestamp(ts);
    }
    /// The feeder posts a Spiko print at ledger time `posted_at`.
    fn post(&self, price: i128, source_ts: u64, posted_at: u64) {
        self.at(posted_at);
        self.feed.set_price_at(&self.asset, &price, &source_ts);
    }
    fn offer(&self) -> u64 {
        self.repo
            .create_offer(&self.lender, &self.token, &PRINCIPAL, &APR_BPS, &TERM)
    }
    fn try_take(&self, offer: u64) -> Result<u64, Error> {
        match self.repo.try_take_offer(&self.borrower, &offer, &false) {
            Ok(Ok(id)) => Ok(id),
            Err(Ok(e)) => Err(e),
            other => panic!("take_offer: {other:?}"),
        }
    }
}

/// #25 with source time: the NAV's age runs from Spiko's publication, not
/// from the post. Posted 3 h late, Monday's print still goes stale exactly
/// 96 h after Spiko published it (93 h after the post).
#[test]
fn staleness_counts_from_spiko_publication_not_from_the_post() {
    let w = world(MON_PUB);
    w.post(MON_PRICE, MON_PUB, MON_PUB + 3 * HOUR);
    assert_eq!(w.feed.lastprice(&w.asset).unwrap().timestamp, MON_PUB);

    let offer = w.offer();
    w.at(MON_PUB + MAX_AGE);
    let repo_id = w.try_take(offer).expect("exactly 96 h old is fresh");
    assert_eq!(w.repo.repo(&repo_id).status, Status::Open);

    let offer = w.offer();
    w.at(MON_PUB + MAX_AGE + 1);
    assert_eq!(w.try_take(offer), Err(Error::StaleNav));
    assert_eq!(w.repo.try_check_margin(&repo_id), Err(Ok(Error::StaleNav)));
    // Exits never wait for a NAV (#6).
    w.repo.repay(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
}

/// A normal weekend: Spiko publishes nothing Saturday and Sunday, the feed
/// posts nothing, and Friday's print (15:46 UTC) still prices takes and
/// margin checks on Monday morning (66 h old) until Monday's print lands.
#[test]
fn weekend_friday_print_stays_fresh_until_monday() {
    let w = world(FRI_PUB);
    w.post(FRI_PRICE, FRI_PUB, FRI_PUB + 600);
    let offer = w.offer();
    let sunday_noon = FRI_PUB + 2 * DAY - 4 * HOUR + 14 * 60;
    w.at(sunday_noon);
    let repo_id = w.try_take(offer).expect("Sunday: Friday's NAV is fresh");
    assert_eq!(w.repo.check_margin(&repo_id), Status::Open);

    let monday_morning = MON_PUB - 9 * HOUR; // 08:43 UTC, before the print
    w.at(monday_morning);
    assert!(monday_morning - FRI_PUB < MAX_AGE);
    assert_eq!(w.repo.check_margin(&repo_id), Status::Open);
    let offer = w.offer();
    assert!(w.try_take(offer).is_ok());

    // Monday's print appends; its source time is what the repo reads.
    w.post(MON_PRICE, MON_PUB, MON_PUB + 120);
    let all = w.feed.prices(&w.asset, &5).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all.get_unchecked(0).timestamp, MON_PUB);
    assert_eq!(all.get_unchecked(1).timestamp, FRI_PUB);
    assert_eq!(w.repo.check_margin(&repo_id), Status::Open);
}

/// Easter 2026 (Good Friday and Easter Monday are SAFO non-operating days):
/// Thursday 2 Apr's print is 117 h old when Tuesday's lands, so for the last
/// ~21 h takes and margin checks wait on StaleNav while repay still works;
/// Tuesday's print reopens them. docs/research/spiko-nav/size.py measures
/// this gap on the real history.
#[test]
fn easter_gap_goes_stale_then_tuesdays_print_reopens() {
    // Real prints (eursafo.json): NAV x EUR/USD, older publication time.
    const THU_PUB: u64 = 1_775_146_832; // 2026-04-02 16:20:32 UTC, 1.002024 x 1.1527
    const THU_PRICE: i128 = 115_503_306_480_000;
    const TUE_PUB: u64 = 1_775_569_450; // 2026-04-07 13:44:10 UTC, 1.002084 x 1.157
    const TUE_PRICE: i128 = 115_941_118_800_000;
    let w = world(THU_PUB);
    w.post(THU_PRICE, THU_PUB, THU_PUB + 600);
    let repo_id = w.try_take(w.offer()).unwrap();

    w.at(THU_PUB + MAX_AGE + 1); // Easter Monday 16:20 UTC
    assert_eq!(w.try_take(w.offer()), Err(Error::StaleNav));
    assert_eq!(w.repo.try_check_margin(&repo_id), Err(Ok(Error::StaleNav)));

    w.post(TUE_PRICE, TUE_PUB, TUE_PUB + 300);
    assert_eq!(w.repo.check_margin(&repo_id), Status::Open);
    assert!(w.try_take(w.offer()).is_ok());
    w.repo.repay(&repo_id);
    assert_eq!(w.repo.repo(&repo_id).status, Status::Repaid);
}

/// #38 with source time: the claim-in-kind clock starts at Spiko's last
/// publication (max age + 7 days after it), however late the keeper posted
/// that print, and `liquidate` waits on StaleNav until then.
#[test]
fn nav_outage_claim_in_kind_clock_runs_from_spiko_time() {
    let w = world(MON_PUB);
    w.post(MON_PRICE, MON_PUB, MON_PUB + 5 * HOUR);
    let repo_id = w.try_take(w.offer()).unwrap();
    let r = w.repo.repo(&repo_id);
    // Spiko stops publishing; the repo matures unpaid and defaults (a
    // maturity default reads no NAV).
    w.at(r.maturity_ts + DAY + 1);
    assert_eq!(w.repo.default(&repo_id), Status::Defaulted);
    assert_eq!(
        w.repo.try_liquidate(&w.liquidator, &repo_id),
        Err(Ok(Error::StaleNav))
    );

    let opens_after = MON_PUB + MAX_AGE + 7 * DAY;
    w.at(opens_after);
    assert_eq!(
        w.repo.try_claim_in_kind(&repo_id),
        Err(Ok(Error::NoNavOutage))
    );
    w.at(opens_after + 1);
    let lender_before = w.collateral.balance(&w.lender);
    let claimed = w.repo.claim_in_kind(&repo_id);
    assert_eq!(claimed, r.collateral_amount);
    assert_eq!(
        w.collateral.balance(&w.lender) - lender_before,
        r.collateral_amount
    );
    assert_eq!(w.repo.repo(&repo_id).status, Status::Liquidated);
    assert_eq!(w.repo.open_debt(&w.token), 0);
}

/// #31 over daily source-timed prints: the 20-record window now holds 20
/// business days of real moves (not one move re-posted 20 times). The real
/// window with the largest spread (369 bps, 10 Sep .. 7 Oct 2026) passes
/// the 500 bps band, so a take on 7 Oct goes through; a bad print 6% off
/// the last one is refused with NavOutOfBand.
#[test]
fn real_daily_fx_drift_passes_the_band_and_a_bad_print_does_not() {
    let (first_ts, _) = REAL_WINDOW[0];
    let w = world(first_ts);
    for (ts, price) in REAL_WINDOW {
        w.post(price, ts, ts + 900);
    }
    assert_eq!(w.feed.prices(&w.asset, &20).unwrap().len(), 20);
    let (last_ts, last_price) = REAL_WINDOW[19];
    w.at(last_ts + HOUR);
    let repo_id = w.try_take(w.offer()).expect("real 20-day drift is in band");
    assert_eq!(w.repo.check_margin(&repo_id), Status::Open);

    // Next morning a print 6% above the last one: out of band against
    // every record in the window, so takes and margin checks stop.
    let bad = last_price * 106 / 100;
    w.post(bad, last_ts + DAY, last_ts + DAY + 600);
    assert_eq!(w.try_take(w.offer()), Err(Error::NavOutOfBand));
    assert_eq!(
        w.repo.try_check_margin(&repo_id),
        Err(Ok(Error::NavOutOfBand))
    );
    // The feeder cannot overwrite the bad print the same NAV day; the
    // correction lands with the next day's print (or the guardian pauses).
    assert_eq!(
        w.feed
            .try_set_price_at(&w.asset, &last_price, &(last_ts + DAY + 60)),
        Err(Ok(caravel_oracle::Error::SameDay))
    );
    // The corrected print is still out of band against the bad record in
    // the window (#40: no rewrite). It is accepted by the #41 settle path:
    // the keeper notes the level, and one day of ledger time later the
    // margin check runs again (the borrower's loan is healthy).
    let fix_posted = last_ts + 2 * DAY + 600;
    w.post(last_price, last_ts + 2 * DAY, fix_posted);
    assert_eq!(
        w.repo.try_check_margin(&repo_id),
        Err(Ok(Error::NavOutOfBand))
    );
    w.repo.note_nav(&w.token);
    w.at(fix_posted + DAY);
    assert_eq!(w.repo.check_margin(&repo_id), Status::Open);
    assert!(w.usdc.balance(&w.borrower) >= PRINCIPAL);
}
