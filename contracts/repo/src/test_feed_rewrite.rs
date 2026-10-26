//! NAV side `feed-rewrite` (nav-review 2026-10-26, sides.md § 1): the feeder
//! key can no longer rewrite or quickly flush the 20-record band window
//! (#31) on the real mock oracle (`contracts/oracle`). Before the fix,
//! `set_price_at` overwrote all 20 records in one ledger and 20 posts in
//! 100 s flushed them (lender -480.37 / -872.74 USDC, flash-crash S2a / S6).
//! Now every record is stamped with ledger time, one per resolution slot.
//! Testnet tBENJI config (deployments/testnet.json): band 2,500 bps, no
//! bounds, NAV age 180 s, haircut 300, trigger 250; oracle resolution 60 s.

extern crate std;
use std::println;

use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Symbol,
};

use crate::{
    oracle::{self, mock::MOCK_DECIMALS, mock::ONE},
    test::{demo_config, APR_BPS, NO_CAP, PRINCIPAL, TERM_SECS, UNIT},
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Error, Pause, Status,
};

const T0: u64 = 1_000_000;
const RESOLUTION: u32 = 60;
const LEDGER_SECS: u64 = 5;

struct W<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    tbenji: Address,
    feed: caravel_oracle::MockOracleClient<'a>,
    lender: Address,
    borrower: Address,
    liquidator: Address,
    asset: caravel_oracle::Asset,
}

fn asset_cfg(token: &Address) -> AssetConfig {
    AssetConfig {
        oracle_asset: Asset::Stellar(token.clone()),
        haircut_bps: 300,
        margin_trigger_bps: 250,
        enabled: true,
        max_nav_age_secs: 180,
        max_nav_move_bps: 2_500,
        nav_floor: None,
        nav_ceiling: None,
        max_open_debt: NO_CAP,
    }
}

/// Honest history: 20 posts of 1.00, one per minute, the last at `now()`.
fn world<'a>() -> W<'a> {
    // Hundreds of feed posts per test: a ledger snapshot would be ~400 KB each.
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let tbenji = env.register_stellar_asset_contract_v2(issuer).address();
    let oracle_id = env.register(
        caravel_oracle::MockOracle,
        (
            Address::generate(&env),
            caravel_oracle::Asset::Other(Symbol::new(&env, "USD")),
            MOCK_DECIMALS,
            RESOLUTION,
        ),
    );
    let feed = caravel_oracle::MockOracleClient::new(&env, &oracle_id);
    let asset = caravel_oracle::Asset::Stellar(tbenji.clone());
    for i in 0..20u64 {
        env.ledger().set_timestamp(T0 + i * 60);
        feed.set_price(&asset, &ONE);
    }

    let mut config = demo_config(&env);
    config.usdc = usdc.clone();
    config.oracle = oracle_id;
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (config,)));
    repo.set_asset(&tbenji, &asset_cfg(&tbenji));

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&lender, &(10_000 * UNIT));
    usdc_admin.mint(&liquidator, &(2_000 * UNIT));
    StellarAssetClient::new(&env, &tbenji).mint(&borrower, &(5_000 * UNIT));
    repo.set_liquidator(&liquidator, &true);

    W {
        usdc: TokenClient::new(&env, &usdc),
        repo,
        tbenji,
        feed,
        lender,
        borrower,
        liquidator,
        asset,
        env,
    }
}

impl W<'_> {
    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }
    fn next_ledger(&self) {
        self.env.ledger().set_timestamp(self.now() + LEDGER_SECS);
    }
    fn fresh_nav(&self) -> Result<(i128, u32), Error> {
        let cfg = self.repo.config();
        let asset = asset_cfg(&self.tbenji);
        self.env.as_contract(&self.repo.address, || {
            oracle::fresh_nav(&self.env, &cfg, &asset)
        })
    }
    fn offer(&self) -> u64 {
        self.repo
            .create_offer(&self.lender, &self.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS)
    }
    /// check_margin -> default after the deadline -> liquidate; USDC the
    /// lender receives from the liquidation.
    fn margin_call_to_liquidation(&self, repo_id: u64) -> i128 {
        assert_eq!(self.repo.check_margin(&repo_id), Status::MarginCall);
        let deadline = self.repo.repo(&repo_id).margin_call_deadline.unwrap();
        self.env.ledger().set_timestamp(deadline + 1);
        assert_eq!(self.repo.default(&repo_id), Status::Defaulted);
        let before = self.usdc.balance(&self.lender);
        self.repo.liquidate(&self.liquidator, &repo_id);
        self.usdc.balance(&self.lender) - before
    }
    fn lender_due(&self, repo_id: u64) -> i128 {
        let r = self.repo.repo(&repo_id);
        // fee_bps 1,000 of the interest goes to the treasury.
        r.principal + r.interest - r.interest * 1_000 / 10_000
    }
}

fn usdc(x: i128) -> std::string::String {
    std::format!("{}.{:07}", x / UNIT, (x % UNIT).abs())
}

impl W<'_> {
    /// Posts `price` once per ledger until `done` holds; (posts, seconds).
    fn flood(&self, price: i128, mut done: impl FnMut(&Self) -> bool) -> (u32, u64) {
        let start = self.now();
        let mut posts = 0;
        loop {
            self.next_ledger();
            self.feed.set_price(&self.asset, &price);
            posts += 1;
            if done(self) {
                return (posts, self.now() - start);
            }
            assert!(posts < 1_000, "flood never passed the band");
        }
    }
    fn guardian_pause(&self) {
        self.repo.guardian_set_pause(
            &self.tbenji,
            &Pause {
                no_new_repos: true,
                no_seize: true,
            },
        );
    }
}

/// S-A after: `set_price_at` is gone; 20 `set_price(0.50)` in one ledger
/// only replace the newest record, so 19 records of 1.00 still hold the
/// band and the repo refuses 0.50.
#[test]
fn same_ledger_reposts_cannot_rewrite_the_window() {
    let w = world();
    let repo_id = w.repo.take_offer(&w.borrower, &w.offer(), &false);
    w.next_ledger();
    for _ in 0..20 {
        w.feed.set_price(&w.asset, &(ONE / 2));
    }
    let window = w.feed.prices(&w.asset, &20).unwrap();
    let good = window.iter().filter(|r| r.price == ONE).count();
    assert_eq!((window.len(), good), (20, 19));
    assert_eq!(w.fresh_nav(), Err(Error::NavOutOfBand));
    assert_eq!(
        w.repo.try_check_margin(&repo_id),
        Err(Ok(Error::NavOutOfBand))
    );
    println!("FR|S-A after|reposts 20 in one ledger|window 1.00 records left {good}/20|fresh_nav NavOutOfBand|check_margin NavOutOfBand|lender_loss 0");
}

/// S-A after, flush race: a 0.50 post every 5 s ledger passes the band only
/// once 20 resolution slots hold it (> 18 min at testnet resolution 60 s).
/// If nobody reacts, the lender loses as before; a guardian `no_seize`
/// any time inside that window holds the seizure.
#[test]
fn flood_needs_twenty_slots_and_the_guardian_can_hold_seizure() {
    let w = world();
    let repo_id = w.repo.take_offer(&w.borrower, &w.offer(), &false);
    let due = w.lender_due(repo_id);
    let (posts, secs) = w.flood(ONE / 2, |w| w.fresh_nav().is_ok());
    assert!(secs > 18 * u64::from(RESOLUTION));
    let recv = w.margin_call_to_liquidation(repo_id);
    println!(
        "FR|S-A after, nobody reacts|posts_until_band_passes {posts}|ledger_secs {secs}|lender_recv {}|lender_loss {}",
        usdc(recv),
        usdc(due - recv)
    );

    let w = world();
    let repo_id = w.repo.take_offer(&w.borrower, &w.offer(), &false);
    let mut paused_at = None;
    let (posts, secs) = w.flood(ONE / 2, |w| {
        // Guardian reacts 10 minutes into the flood.
        if paused_at.is_none() && w.now() >= T0 + 19 * 60 + 600 {
            w.guardian_pause();
            paused_at = Some(w.now());
        }
        w.fresh_nav().is_ok()
    });
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);
    let deadline = w.repo.repo(&repo_id).margin_call_deadline.unwrap();
    w.env.ledger().set_timestamp(deadline + 1);
    assert_eq!(w.repo.try_default(&repo_id), Err(Ok(Error::Paused)));
    assert_eq!(w.repo.repo(&repo_id).status, Status::MarginCall);
    println!(
        "FR|S-A after, guardian no_seize {} s into the flood|posts {posts}|ledger_secs {secs}|default Paused|status MarginCall|lender_loss 0 (no seizure until the price is fixed)",
        paused_at.unwrap() - (T0 + 19 * 60)
    );
}

/// S-B after (flash-crash S6): 10.00 posted every ledger; `take_offer` at
/// the inflated print is refused until 20 slots hold it. A guardian
/// `no_new_repos` inside that window keeps the take from landing.
#[test]
fn rapid_set_price_take_waits_twenty_slots() {
    let w = world();
    let offer = w.offer();
    let mut repo_id = None;
    let mut refused = 0;
    let (posts, secs) = w.flood(ONE * 10, |w| {
        match w.repo.try_take_offer(&w.borrower, &offer, &false) {
            Ok(Ok(id)) => {
                repo_id = Some(id);
                true
            }
            Err(Ok(Error::NavOutOfBand)) => {
                refused += 1;
                false
            }
            other => panic!("unexpected {other:?}"),
        }
    });
    assert!(secs > 18 * u64::from(RESOLUTION));
    let repo_id = repo_id.unwrap();
    let coll = w.repo.repo(&repo_id).collateral_amount;
    let due = w.lender_due(repo_id);
    let (fix_posts, fix_secs) = w.flood(ONE, |w| w.fresh_nav() == Ok((ONE, MOCK_DECIMALS)));
    let recv = w.margin_call_to_liquidation(repo_id);
    println!(
        "FR|S-B after, nobody reacts|posts_until_take {posts}|takes_refused {refused} (NavOutOfBand)|ledger_secs {secs}|coll {}|correction_posts {fix_posts} ({fix_secs} s)|lender_recv {}|lender_loss {}",
        usdc(coll),
        usdc(recv),
        usdc(due - recv)
    );

    let w = world();
    let offer = w.offer();
    let mut paused = false;
    let (posts, secs) = w.flood(ONE * 10, |w| {
        if !paused && w.now() >= T0 + 19 * 60 + 600 {
            w.guardian_pause();
            paused = true;
        }
        w.fresh_nav().is_ok()
    });
    assert_eq!(
        w.repo.try_take_offer(&w.borrower, &offer, &false),
        Err(Ok(Error::Paused))
    );
    println!("FR|S-B after, guardian no_new_repos at +600 s|posts {posts}|ledger_secs {secs}|take Paused|lender_loss 0");
}

/// Honest testnet cadence is unchanged: nav-keeper posts every ~60 s (one
/// slot each), the Admin slider adds a post in between (same slot,
/// replaces), and a 0.95 margin-call demo still passes the 2,500 bps band.
#[test]
fn honest_cadence_and_slider_still_work() {
    let w = world();
    let repo_id = w.repo.take_offer(&w.borrower, &w.offer(), &false);
    w.env.ledger().set_timestamp(w.now() + 30);
    w.feed.set_price(&w.asset, &(ONE * 95 / 100)); // slider, same slot as the last keeper post
    assert_eq!(w.feed.prices(&w.asset, &20).unwrap().len(), 20);
    assert_eq!(w.fresh_nav(), Ok((ONE * 95 / 100, MOCK_DECIMALS)));
    w.env.ledger().set_timestamp(w.now() + 60);
    w.feed.set_price(&w.asset, &(ONE * 95 / 100)); // nav-keeper re-post
    assert_eq!(w.repo.check_margin(&repo_id), Status::MarginCall);
}

/// Correcting a bad push: inside its slot the correction replaces it and
/// the window is clean at once; in a later slot the bad record stays in the
/// window, so the correction is out of band for 20 slots (runbook step 3).
#[test]
fn correction_in_the_same_slot_is_instant_later_it_waits() {
    let w = world();
    let slot_start = (w.now() / 60 + 1) * 60;
    w.env.ledger().set_timestamp(slot_start);
    w.feed.set_price(&w.asset, &(ONE / 2)); // bad push, refused by the band
    assert_eq!(w.fresh_nav(), Err(Error::NavOutOfBand));
    w.env.ledger().set_timestamp(slot_start + 55);
    w.feed.set_price(&w.asset, &ONE); // same slot: replaces it
    assert_eq!(w.fresh_nav(), Ok((ONE, MOCK_DECIMALS)));
    assert!(w
        .feed
        .prices(&w.asset, &20)
        .unwrap()
        .iter()
        .all(|r| r.price == ONE));

    let w = world();
    let slot_start = (w.now() / 60 + 1) * 60;
    w.env.ledger().set_timestamp(slot_start);
    w.feed.set_price(&w.asset, &(ONE / 2));
    // First correction lands at the start of the next slot.
    w.env.ledger().set_timestamp(slot_start + 55);
    let (posts, secs) = w.flood(ONE, |w| w.fresh_nav().is_ok());
    assert!(secs > 18 * u64::from(RESOLUTION));
    println!("FR|correction after a bad push in a later slot|posts {posts}|ledger_secs {secs} until fresh_nav Ok");
}
