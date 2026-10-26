//! Raven audit angle R6, governance: the guardian's veto is bounded, the
//! admin rotates both roles, liquidator additions are timelocked and
//! evented. One test (or more) per finding id: UA-02 (= OZ-02, both veto
//! paths), UA-06, UA-03 (whitelist half), OZ-06, STD-03 (= OZ-03 = CS-06).
//! The `ua02` / `oz02` / `qa_guardian_reassert_pause_drops_clear_proposal`
//! / `ua03` / `oz03` names match the audit repros they flip.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Event as _, IntoVal,
};

use crate::{
    events,
    oracle::mock::{setup_mock_oracle, MockOracleClient, ONE},
    test::{
        demo_config, whitelist, APR_BPS, DEMO_NAV_AGE, NOW, NO_CAP, PRINCIPAL, SETTLE_SECS,
        TERM_SECS, TIMELOCK, TRIGGER_BPS, UNIT, WIDE_BAND_BPS,
    },
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Error, Pause, Status,
};

const GRACE_SECS: u64 = 60;
const WINDOW_SECS: u64 = 120;
const MATURED: u64 = NOW + TERM_SECS + GRACE_SECS + 1;
const NO_SEIZE: Pause = Pause {
    no_new_repos: false,
    no_seize: true,
};
const CLEAR: Pause = Pause {
    no_new_repos: false,
    no_seize: false,
};

struct W<'a> {
    env: Env,
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    tbenji: Address,
    oracle: MockOracleClient<'a>,
    admin: Address,
    guardian: Address,
    lender: Address,
    borrower: Address,
    liquidator: Address,
}

fn world<'a>() -> W<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    env.ledger().set_sequence_number(100);

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
    let (admin, guardian) = (config.admin.clone(), config.guardian.clone());
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
            band_settle_secs: SETTLE_SECS,
        },
    );

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let mint = StellarAssetClient::new(&env, &usdc);
    mint.mint(&lender, &(10_000 * UNIT));
    mint.mint(&borrower, &(100 * UNIT));
    mint.mint(&liquidator, &(2_000 * UNIT));
    StellarAssetClient::new(&env, &tbenji).mint(&borrower, &(5_000 * UNIT));
    whitelist(&env, &repo, &liquidator);

    W {
        usdc: TokenClient::new(&env, &usdc),
        env,
        repo,
        tbenji,
        oracle,
        admin,
        guardian,
        lender,
        borrower,
        liquidator,
    }
}

impl W<'_> {
    fn at(&self, ts: u64) {
        self.env.ledger().set_timestamp(ts);
    }
    /// Moves the clock to `ts` with a fresh NAV stamped then.
    fn nav(&self, ts: u64, price: i128) {
        self.at(ts);
        self.oracle
            .set_price(&Asset::Stellar(self.tbenji.clone()), &price, &ts);
    }
    fn take(&self) -> u64 {
        let offer =
            self.repo
                .create_offer(&self.lender, &self.tbenji, &PRINCIPAL, &APR_BPS, &TERM_SECS);
        self.repo.take_offer(&self.borrower, &offer, &false)
    }
    /// Authorizes exactly one call, signed by `who` only.
    fn sign_as(
        &self,
        who: &Address,
        fn_name: &'static str,
        args: soroban_sdk::Vec<soroban_sdk::Val>,
    ) {
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.repo.address,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }
    fn events(&self) -> std::vec::Vec<soroban_sdk::xdr::ContractEvent> {
        self.env
            .events()
            .all()
            .filter_by_contract(&self.repo.address)
            .events()
            .to_vec()
    }
}

// --- UA-02 / OZ-02: the guardian cannot veto a clear forever ----------------

/// Flips audit repro `ua02_guardian_cancel_veto_freezes_seizure_permanently`
/// and `oz02_guardian_veto_locks_seizure_forever`: the guardian's first
/// cancel holds, the admin's unchanged re-proposal cannot be cancelled by
/// it (`VetoSpent`), executes after the timelock, and the default lands.
#[test]
fn ua02_oz02_guardian_cancel_veto_is_spent_on_the_reproposed_clear() {
    let w = world();
    let id = w.take();
    w.repo.guardian_set_pause(&w.tbenji, &NO_SEIZE);
    w.nav(MATURED, ONE);
    assert_eq!(w.repo.try_default(&id), Err(Ok(Error::Paused)));

    // Round 1: the guardian's veto holds.
    w.repo.propose_pause(&w.tbenji, &CLEAR);
    w.repo.cancel_pause(&w.guardian, &w.tbenji);
    assert_eq!(w.env.auths()[0].0, w.guardian);
    assert_eq!(w.repo.pending_pause(&w.tbenji), None);

    // Round 2: same clear again; the guardian's cancel is refused.
    let eta = w.repo.propose_pause(&w.tbenji, &CLEAR);
    assert_eq!(
        w.repo.try_cancel_pause(&w.guardian, &w.tbenji),
        Err(Ok(Error::VetoSpent))
    );
    // The guardian cannot drop it by re-asserting the pause either.
    w.repo.guardian_set_pause(&w.tbenji, &NO_SEIZE);
    assert!(w.repo.pending_pause(&w.tbenji).is_some());

    w.nav(eta, ONE);
    w.repo.execute_pause(&w.tbenji);
    assert_eq!(w.repo.pause(&w.tbenji), CLEAR);
    assert_eq!(w.repo.default(&id), Status::Defaulted);
}

/// Same bound on `cancel_asset`: once per change; a different change gets
/// a fresh veto; the admin can always cancel its own proposal.
#[test]
fn ua02_guardian_cancel_asset_once_per_change() {
    let w = world();
    let mut loose = w.repo.asset(&w.tbenji);
    loose.max_nav_age_secs = DEMO_NAV_AGE + 60;

    w.repo.propose_asset(&w.tbenji, &loose);
    w.repo.cancel_asset(&w.guardian, &w.tbenji);
    w.repo.propose_asset(&w.tbenji, &loose);
    assert_eq!(
        w.repo.try_cancel_asset(&w.guardian, &w.tbenji),
        Err(Ok(Error::VetoSpent))
    );
    // A different change: the guardian may veto it once. Only the last
    // vetoed change is remembered, and only the admin picks what is
    // proposed, so the admin gets its change through by proposing it
    // twice in a row.
    let mut other = loose.clone();
    other.max_open_debt = NO_CAP - 1;
    w.repo.propose_asset(&w.tbenji, &other);
    w.repo.cancel_asset(&w.guardian, &w.tbenji);
    // The admin cancels whatever it likes.
    w.repo.propose_asset(&w.tbenji, &other);
    w.repo.cancel_asset(&w.admin, &w.tbenji);
    assert_eq!(w.repo.pending_asset(&w.tbenji), None);

    // The spent change executes after the timelock, the guardian watching.
    w.repo.propose_asset(&w.tbenji, &loose);
    w.repo.cancel_asset(&w.guardian, &w.tbenji);
    let eta = w.repo.propose_asset(&w.tbenji, &loose);
    assert_eq!(
        w.repo.try_cancel_asset(&w.guardian, &w.tbenji),
        Err(Ok(Error::VetoSpent))
    );
    w.at(eta);
    w.repo.execute_asset(&w.tbenji);
    assert_eq!(w.repo.asset(&w.tbenji), loose);

    // Executing clears the record: the next proposal of that change is
    // vetoable again.
    let mut tight = loose.clone();
    tight.max_nav_age_secs = DEMO_NAV_AGE;
    w.repo.set_asset(&w.tbenji, &tight);
    w.repo.propose_asset(&w.tbenji, &loose);
    w.repo.cancel_asset(&w.guardian, &w.tbenji);
}

/// Flips QA repro `qa_guardian_reassert_pause_drops_clear_proposal`: a
/// guardian re-assert of the pause in force is a no-op and keeps the
/// admin's pending clear, which then executes.
#[test]
fn qa_guardian_reassert_pause_drops_clear_proposal() {
    let w = world();
    w.repo.guardian_set_pause(&w.tbenji, &NO_SEIZE);
    let eta = w.repo.propose_pause(&w.tbenji, &CLEAR);
    w.repo.guardian_set_pause(&w.tbenji, &NO_SEIZE);
    assert!(w.repo.pending_pause(&w.tbenji).is_some());
    // The same for an asset config re-sent unchanged.
    let mut loose = w.repo.asset(&w.tbenji);
    loose.max_open_debt = NO_CAP - 1;
    w.repo.set_asset(&w.tbenji, &loose);
    loose.max_open_debt = NO_CAP;
    w.repo.propose_asset(&w.tbenji, &loose);
    w.repo
        .guardian_set_asset(&w.tbenji, &w.repo.asset(&w.tbenji));
    assert!(w.repo.pending_asset(&w.tbenji).is_some());

    w.at(eta);
    w.repo.execute_pause(&w.tbenji);
    w.repo.execute_asset(&w.tbenji);
    assert_eq!(w.repo.pause(&w.tbenji), CLEAR);
    assert_eq!(w.repo.asset(&w.tbenji), loose);
}

/// A real guardian tightening still supersedes a pending loosening (so a
/// queued change cannot undo an emergency), but only once per change: a
/// creeping run of tiny tightenings cannot cancel every re-proposal.
#[test]
fn ua02_guardian_tightening_supersedes_a_proposal_once() {
    let w = world();
    let mut loose = w.repo.asset(&w.tbenji);
    loose.max_nav_age_secs = DEMO_NAV_AGE + 60;
    w.repo.propose_asset(&w.tbenji, &loose);
    let mut tight = w.repo.asset(&w.tbenji);
    tight.haircut_bps += 1;
    w.repo.guardian_set_asset(&w.tbenji, &tight);
    assert_eq!(w.repo.pending_asset(&w.tbenji), None);

    let eta = w.repo.propose_asset(&w.tbenji, &loose);
    tight.haircut_bps += 1;
    w.repo.guardian_set_asset(&w.tbenji, &tight);
    assert_eq!(
        w.repo.asset(&w.tbenji),
        tight,
        "the tightening still applies"
    );
    assert!(w.repo.pending_asset(&w.tbenji).is_some(), "veto spent");
    w.at(eta);
    w.repo.execute_asset(&w.tbenji);
    assert_eq!(w.repo.asset(&w.tbenji), loose);

    // Pause: switching on a second switch drops a clear once.
    w.repo.guardian_set_pause(&w.tbenji, &NO_SEIZE);
    w.repo.propose_pause(&w.tbenji, &CLEAR);
    let all = Pause {
        no_new_repos: true,
        no_seize: true,
    };
    w.repo.guardian_set_pause(&w.tbenji, &all);
    assert_eq!(w.repo.pending_pause(&w.tbenji), None);
    w.repo.propose_pause(&w.tbenji, &CLEAR);
    assert_eq!(
        w.repo.try_cancel_pause(&w.guardian, &w.tbenji),
        Err(Ok(Error::VetoSpent))
    );
}

/// Dropping a proposal whose window closed is cleanup, not a veto.
#[test]
fn ua02_cancelling_an_expired_proposal_spends_no_veto() {
    let w = world();
    w.repo.guardian_set_pause(&w.tbenji, &NO_SEIZE);
    let eta = w.repo.propose_pause(&w.tbenji, &CLEAR);
    w.at(eta + TIMELOCK + 1);
    w.repo.cancel_pause(&w.guardian, &w.tbenji);
    w.repo.propose_pause(&w.tbenji, &CLEAR);
    w.repo.cancel_pause(&w.guardian, &w.tbenji);
}

/// UA-02 / OZ-02 rotation: the admin replaces the guardian after the
/// timelock; the outgoing guardian cannot cancel it, and loses its powers.
#[test]
fn ua02_admin_rotates_guardian_and_the_guardian_cannot_cancel() {
    let w = world();
    let id = w.take();
    w.repo.guardian_set_pause(&w.tbenji, &NO_SEIZE);
    let next = Address::generate(&w.env);
    let eta = w.repo.propose_guardian(&next);
    assert_eq!(eta, NOW + TIMELOCK);
    assert_eq!(w.events().len(), 1);
    assert_eq!(
        w.events(),
        [events::GuardianChangeProposed {
            guardian: next.clone(),
            eta
        }
        .to_xdr(&w.env, &w.repo.address)]
    );

    // The guardian cannot cancel or execute it.
    w.sign_as(&w.guardian, "cancel_guardian", ().into_val(&w.env));
    assert!(w.repo.try_cancel_guardian().is_err());
    w.at(eta);
    w.sign_as(&w.guardian, "execute_guardian", ().into_val(&w.env));
    assert!(w.repo.try_execute_guardian().is_err());
    w.env.mock_all_auths();
    let roles = w.repo.roles();
    assert_eq!(roles.pending_guardian, Some(next.clone()));
    assert_eq!(roles.pending_guardian_eta, Some(eta));

    w.repo.execute_guardian();
    assert_eq!(
        w.events(),
        [events::GuardianSet {
            guardian: next.clone(),
            previous: w.guardian.clone(),
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
    assert_eq!(w.repo.config().guardian, next);
    assert_eq!(w.repo.roles().guardian, next);
    assert_eq!(w.repo.roles().pending_guardian, None);

    // The old guardian is a stranger now; the new one acts.
    w.sign_as(
        &w.guardian,
        "guardian_set_pause",
        (w.tbenji.clone(), NO_SEIZE).into_val(&w.env),
    );
    assert!(w.repo.try_guardian_set_pause(&w.tbenji, &NO_SEIZE).is_err());
    w.env.mock_all_auths();
    let eta = w.repo.propose_pause(&w.tbenji, &CLEAR);
    assert_eq!(
        w.repo.try_cancel_pause(&w.guardian, &w.tbenji),
        Err(Ok(Error::NotAdminOrGuardian))
    );
    w.at(eta);
    w.repo.execute_pause(&w.tbenji);
    w.nav(MATURED, ONE);
    assert_eq!(w.repo.default(&id), Status::Defaulted);
}

#[test]
fn ua02_guardian_rotation_rules() {
    let w = world();
    // Never onto the admin.
    assert_eq!(
        w.repo.try_propose_guardian(&w.admin),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(w.repo.try_execute_guardian(), Err(Ok(Error::NoProposal)));
    assert_eq!(w.repo.try_cancel_guardian(), Err(Ok(Error::NoProposal)));
    let a = Address::generate(&w.env);
    let eta = w.repo.propose_guardian(&a);
    w.at(eta - 1);
    assert_eq!(
        w.repo.try_execute_guardian(),
        Err(Ok(Error::TimelockNotDone))
    );
    // A re-proposal replaces it (with a cancel event) and restarts the clock.
    let b = Address::generate(&w.env);
    let eta_b = w.repo.propose_guardian(&b);
    assert_eq!(
        w.events()[0],
        events::GuardianChangeCancelled { guardian: a }.to_xdr(&w.env, &w.repo.address)
    );
    w.repo.cancel_guardian();
    assert_eq!(w.env.auths()[0].0, w.admin);
    assert_eq!(w.repo.roles().pending_guardian, None);
    w.at(eta_b);
    assert_eq!(w.repo.try_execute_guardian(), Err(Ok(Error::NoProposal)));
    assert_eq!(w.repo.config().guardian, w.guardian);
}

// --- UA-06: two-step admin handover -------------------------------------------

#[test]
fn ua06_transfer_admin_needs_the_new_admins_acceptance() {
    let w = world();
    let next = Address::generate(&w.env);
    w.repo.transfer_admin(&next, &200);
    assert_eq!(w.env.auths()[0].0, w.admin);
    assert_eq!(
        w.events(),
        [events::AdminTransferStarted {
            new_admin: next.clone(),
            live_until_ledger: 200,
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
    // Nothing moves until `next` accepts.
    assert_eq!(w.repo.config().admin, w.admin);
    let roles = w.repo.roles();
    assert_eq!(roles.pending_admin, Some(next.clone()));
    assert_eq!(roles.pending_admin_live_until, Some(200));

    // Nobody but `next` can accept.
    w.sign_as(&w.admin, "accept_admin", ().into_val(&w.env));
    assert!(w.repo.try_accept_admin().is_err());
    w.env.mock_all_auths();
    w.repo.accept_admin();
    assert_eq!(w.env.auths()[0].0, next);
    assert_eq!(
        w.events(),
        [events::AdminSet {
            admin: next.clone(),
            previous: w.admin.clone(),
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
    assert_eq!(w.repo.config().admin, next);
    assert_eq!(w.repo.roles().pending_admin, None);

    // The old admin key is powerless; the new one runs the timelock.
    let mut c = w.repo.asset(&w.tbenji);
    c.haircut_bps = 400;
    w.sign_as(
        &w.admin,
        "set_asset",
        (w.tbenji.clone(), c.clone()).into_val(&w.env),
    );
    assert!(w.repo.try_set_asset(&w.tbenji, &c).is_err());
    w.sign_as(
        &next,
        "set_asset",
        (w.tbenji.clone(), c.clone()).into_val(&w.env),
    );
    w.repo.set_asset(&w.tbenji, &c);
    assert_eq!(w.repo.asset(&w.tbenji).haircut_bps, 400);
}

#[test]
fn ua06_admin_handover_expires_cancels_and_validates() {
    let w = world();
    let next = Address::generate(&w.env);
    // Past ledger, the guardian, beyond the max TTL: refused.
    assert_eq!(
        w.repo.try_transfer_admin(&next, &99),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(
        w.repo.try_transfer_admin(&w.guardian, &200),
        Err(Ok(Error::InvalidConfig))
    );
    let too_far = 100 + w.env.storage().max_ttl() + 1;
    assert_eq!(
        w.repo.try_transfer_admin(&next, &too_far),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(w.repo.try_accept_admin(), Err(Ok(Error::NoProposal)));

    // Lapses after live_until_ledger.
    w.repo.transfer_admin(&next, &110);
    w.env.ledger().set_sequence_number(111);
    assert_eq!(w.repo.roles().pending_admin, None);
    assert_eq!(w.repo.try_accept_admin(), Err(Ok(Error::NoProposal)));
    assert_eq!(w.repo.config().admin, w.admin);

    // live_until_ledger = 0 cancels.
    w.repo.transfer_admin(&next, &300);
    w.repo.transfer_admin(&next, &0);
    assert_eq!(w.repo.try_accept_admin(), Err(Ok(Error::NoProposal)));
    assert_eq!(
        w.repo.try_transfer_admin(&next, &0),
        Err(Ok(Error::NoProposal))
    );

    // A pending admin that has become the guardian cannot accept.
    let g2 = Address::generate(&w.env);
    w.repo.transfer_admin(&g2, &300);
    let eta = w.repo.propose_guardian(&g2);
    w.at(eta);
    w.repo.execute_guardian();
    assert_eq!(w.repo.try_accept_admin(), Err(Ok(Error::InvalidConfig)));
}

// --- UA-03 whitelist half: liquidator additions wait out the timelock --------

/// Flips audit repro `ua03_admin_key_drains_lender_without_touching_the_timelock`:
/// the admin key alone can no longer whitelist a buyer and sell the
/// collateral to it within the margin window; the addition is visible for
/// a whole timelock, and the guardian can cancel it.
#[test]
fn ua03_new_liquidator_cannot_act_before_the_timelock() {
    let w = world();
    let id = w.take();
    let attacker = Address::generate(&w.env);
    StellarAssetClient::new(&w.env, &w.usdc.address).mint(&attacker, &(1_000 * UNIT));

    // `set_liquidator` keeps its void signature, so Loosens comes back as a
    // plain contract error code (#20).
    assert_eq!(
        w.repo.try_set_liquidator(&attacker, &true),
        Err(Ok(soroban_sdk::Error::from_contract_error(
            Error::Loosens as u32
        )))
    );
    let eta = w.repo.propose_liquidator(&attacker);
    assert_eq!(w.repo.pending_liquidator(&attacker), Some(eta));
    assert!(!w.repo.is_liquidator(&attacker));

    // NAV 0.80 prints a margin call; until eta the addition cannot land.
    w.nav(NOW + 1, 80 * ONE / 100);
    assert_eq!(w.repo.check_margin(&id), Status::MarginCall);
    w.at(eta - 1);
    assert_eq!(
        w.repo.try_execute_liquidator(&attacker),
        Err(Ok(Error::TimelockNotDone))
    );
    // The addition was public for the whole timelock (LiquidatorProposed),
    // so the guardian cancels it.
    w.repo.cancel_liquidator(&w.guardian, &attacker);
    assert_eq!(w.repo.pending_liquidator(&attacker), None);

    // Default after the window: the attacker never became a buyer.
    let t = NOW + 1 + WINDOW_SECS + 1;
    w.nav(t, 80 * ONE / 100);
    assert_eq!(w.repo.default(&id), Status::Defaulted);
    assert_eq!(
        w.repo.try_execute_liquidator(&attacker),
        Err(Ok(Error::NoProposal))
    );
    assert_eq!(
        w.repo.try_liquidate(&attacker, &id),
        Err(Ok(Error::NotLiquidator))
    );
    w.repo.liquidate(&w.liquidator, &id);
    assert_eq!(w.repo.repo(&id).status, Status::Liquidated);
}

#[test]
fn ua03_liquidator_timelock_rules() {
    let w = world();
    let who = Address::generate(&w.env);
    // Guardian cannot propose or execute.
    w.sign_as(
        &w.guardian,
        "propose_liquidator",
        (who.clone(),).into_val(&w.env),
    );
    assert!(w.repo.try_propose_liquidator(&who).is_err());
    w.env.mock_all_auths();
    let eta = w.repo.propose_liquidator(&who);
    w.at(eta);
    w.sign_as(
        &w.guardian,
        "execute_liquidator",
        (who.clone(),).into_val(&w.env),
    );
    assert!(w.repo.try_execute_liquidator(&who).is_err());
    w.env.mock_all_auths();
    // Strangers cannot cancel.
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.repo.try_cancel_liquidator(&stranger, &who),
        Err(Ok(Error::NotAdminOrGuardian))
    );
    // Guardian vetoes an address once; the re-proposal it cannot cancel.
    w.repo.cancel_liquidator(&w.guardian, &who);
    let eta = w.repo.propose_liquidator(&who);
    assert_eq!(
        w.repo.try_cancel_liquidator(&w.guardian, &who),
        Err(Ok(Error::VetoSpent))
    );
    w.at(eta);
    w.repo.execute_liquidator(&who);
    assert!(w.repo.is_liquidator(&who));
    // Re-sending an existing addition is a no-op; removal is instant and
    // drops a pending addition.
    w.repo.set_liquidator(&who, &true);
    w.repo.set_liquidator(&who, &false);
    assert!(!w.repo.is_liquidator(&who));
    w.repo.propose_liquidator(&who);
    w.repo.set_liquidator(&who, &false);
    assert_eq!(w.repo.pending_liquidator(&who), None);
}

// --- OZ-06: every proposal kind expires --------------------------------------

/// OZ-06 for asset/pause proposals was fixed by issue #41
/// (`execute_window_closes_at_eta_plus_timelock` in test.rs); the new
/// proposal kinds use the same window.
#[test]
fn oz06_liquidator_and_guardian_proposals_expire() {
    let w = world();
    let who = Address::generate(&w.env);
    let eta = w.repo.propose_liquidator(&who);
    let next = Address::generate(&w.env);
    w.repo.propose_guardian(&next);
    w.at(eta + TIMELOCK + 1);
    assert_eq!(
        w.repo.try_execute_liquidator(&who),
        Err(Ok(Error::ProposalExpired))
    );
    assert_eq!(
        w.repo.try_execute_guardian(),
        Err(Ok(Error::ProposalExpired))
    );
    assert!(!w.repo.is_liquidator(&who));
    assert_eq!(w.repo.config().guardian, w.guardian);
}

// --- STD-03 / OZ-03 / CS-06: whitelist changes are evented --------------------

/// Flips audit repro `oz03_set_liquidator_emits_no_event`: each grant and
/// each revoke emits exactly one `LiquidatorSet`.
#[test]
fn oz03_liquidator_grant_and_revoke_emit_one_event_each() {
    let w = world();
    let who = Address::generate(&w.env);
    let eta = w.repo.propose_liquidator(&who);
    assert_eq!(
        w.events(),
        [events::LiquidatorProposed {
            who: who.clone(),
            eta
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
    w.at(eta);
    w.repo.execute_liquidator(&who);
    assert_eq!(
        w.events(),
        [events::LiquidatorSet {
            who: who.clone(),
            allowed: true
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
    w.repo.set_liquidator(&who, &false);
    assert_eq!(
        w.events(),
        [events::LiquidatorSet {
            who: who.clone(),
            allowed: false
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
    w.repo.propose_liquidator(&who);
    w.repo.cancel_liquidator(&w.guardian, &who);
    assert_eq!(
        w.events(),
        [events::LiquidatorProposalCancelled {
            who,
            by: w.guardian.clone()
        }
        .to_xdr(&w.env, &w.repo.address)]
    );
}
