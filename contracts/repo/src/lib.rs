#![no_std]

//! Caravel: fixed-term, fixed-rate USDC repo against tokenized Treasuries.
//!
//! State machine: Open → MarginCall → Open (top-up) | Repaid | Defaulted → Liquidated.
//! An opted-in repo settles as Repaid instead of Defaulted when its USDC
//! allowance covers the debt (auto-repay, DECISIONS.md #27).

mod autorepay;
mod errors;
mod events;
mod margin;
pub mod math;
mod oracle;
mod storage;
mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_allowlist;
#[cfg(test)]
mod test_attack_a8;
#[cfg(test)]
mod test_spiko;

use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env};

pub use errors::Error;
pub use types::{
    Asset, AssetConfig, Config, DefaultReason, Offer, Pause, PendingAsset, PendingPause, Repo,
    Status,
};

#[contract]
pub struct CaravelRepo;

#[contractimpl]
impl CaravelRepo {
    pub fn __constructor(env: Env, config: Config) -> Result<(), Error> {
        validate_config(&config)?;
        storage::write_config(&env, &config);
        storage::extend_instance(&env);
        Ok(())
    }

    // --- views ------------------------------------------------------------

    pub fn config(env: Env) -> Config {
        storage::extend_instance(&env);
        storage::read_config(&env)
    }

    pub fn offer(env: Env, offer_id: u64) -> Result<Offer, Error> {
        storage::extend_instance(&env);
        storage::read_offer(&env, offer_id).ok_or(Error::OfferNotFound)
    }

    pub fn repo(env: Env, repo_id: u64) -> Result<Repo, Error> {
        storage::extend_instance(&env);
        storage::read_repo(&env, repo_id).ok_or(Error::RepoNotFound)
    }

    pub fn is_liquidator(env: Env, who: Address) -> bool {
        storage::extend_instance(&env);
        storage::is_liquidator(&env, &who)
    }

    pub fn asset(env: Env, asset: Address) -> Result<AssetConfig, Error> {
        storage::extend_instance(&env);
        storage::read_asset(&env, &asset).ok_or(Error::AssetNotSupported)
    }

    /// The asset's pause switches; all off for an asset never paused (#30).
    pub fn pause(env: Env, asset: Address) -> Pause {
        storage::extend_instance(&env);
        storage::read_pause(&env, &asset)
    }

    /// The admin asset change waiting out the timelock, if any (#33).
    pub fn pending_asset(env: Env, asset: Address) -> Option<PendingAsset> {
        storage::extend_instance(&env);
        storage::read_pending_asset(&env, &asset)
    }

    /// The admin pause change waiting out the timelock, if any (#33).
    pub fn pending_pause(env: Env, asset: Address) -> Option<PendingPause> {
        storage::extend_instance(&env);
        storage::read_pending_pause(&env, &asset)
    }

    /// Debt (principal + interest) of live repos on `asset`, the amount
    /// counted against `AssetConfig.max_open_debt` (#32). 0 for an unknown asset.
    pub fn open_debt(env: Env, asset: Address) -> i128 {
        storage::extend_instance(&env);
        storage::read_open_debt(&env, &asset)
    }

    // --- admin ------------------------------------------------------------

    pub fn set_liquidator(env: Env, liquidator: Address, allowed: bool) {
        storage::read_config(&env).admin.require_auth();
        storage::extend_instance(&env);
        storage::set_liquidator(&env, &liquidator, allowed);
    }

    /// Adds or re-tiers a collateral asset (DECISIONS.md #13). Requires
    /// `liquidation_discount_bps < haircut_bps < 10_000`: a strictly larger
    /// haircut means a take at max LTV opens strictly below the margin trigger.
    /// Requires `max_nav_age_secs > 0` (staleness is per asset, #25), a
    /// valid NAV sanity band (#31): `max_nav_move_bps > 0`, each bound > 0 if
    /// set, and `nav_floor <= nav_ceiling`, and `max_open_debt ≥ 0` (#32).
    /// Re-setting an asset keeps its open debt; a cap below it only stops new
    /// takes.
    ///
    /// Instant only for a first listing (no offer can exist on an unlisted
    /// asset) or a change that only tightens (#33: disable, raise the
    /// haircut, lower the NAV age or the cap, narrow the NAV band). Anything
    /// that loosens fails with `Loosens`: use `propose_asset`. An instant
    /// change drops a pending proposal for the asset, so it cannot undo the
    /// change later.
    pub fn set_asset(env: Env, asset: Address, config: AssetConfig) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        validate_asset(&protocol, &config)?;
        if let Some(old) = storage::read_asset(&env, &asset) {
            if !asset_tightens(&old, &config) {
                return Err(Error::Loosens);
            }
        }
        storage::extend_instance(&env);
        drop_pending_asset(&env, &asset, &protocol.admin);
        apply_asset(&env, asset, &config);
        Ok(())
    }

    /// Sets an asset's pause switches (DECISIONS.md #30). Each one stops one
    /// action: `no_new_repos` blocks `create_offer` / `take_offer`,
    /// `no_seize` blocks `default` and `liquidate`. Nothing pauses `repay`
    /// or `top_up`. Stored apart from `AssetConfig`, so `set_asset` never
    /// clears a pause. Instant only for switching on (#33); clearing a
    /// switch fails with `Loosens`: use `propose_pause`.
    pub fn set_pause(env: Env, asset: Address, pause: Pause) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        tighten_pause(&env, &protocol.admin, asset, &pause)
    }

    // --- guardian (#33): instant, tighten only ----------------------------

    /// The guardian's instant `set_asset` on a listed asset: disable it,
    /// raise the haircut, lower the NAV age or the cap, narrow the NAV
    /// band. Fails with
    /// `Loosens` if any field adds risk, `AssetNotSupported` if unlisted.
    pub fn guardian_set_asset(env: Env, asset: Address, config: AssetConfig) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.guardian.require_auth();
        validate_asset(&protocol, &config)?;
        let old = storage::read_asset(&env, &asset).ok_or(Error::AssetNotSupported)?;
        if !asset_tightens(&old, &config) {
            return Err(Error::Loosens);
        }
        storage::extend_instance(&env);
        drop_pending_asset(&env, &asset, &protocol.guardian);
        apply_asset(&env, asset, &config);
        Ok(())
    }

    /// The guardian's instant `set_pause`: can switch on, never off.
    pub fn guardian_set_pause(env: Env, asset: Address, pause: Pause) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.guardian.require_auth();
        tighten_pause(&env, &protocol.guardian, asset, &pause)
    }

    // --- admin, timelocked (#33): every change that adds risk -------------

    /// Queues `config` for `asset`; `execute_asset` applies it from the
    /// returned `eta` (now + `timelock_secs`). A new proposal replaces the
    /// pending one and restarts the clock.
    pub fn propose_asset(env: Env, asset: Address, config: AssetConfig) -> Result<u64, Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        validate_asset(&protocol, &config)?;
        let eta = eta(&env, &protocol)?;
        storage::extend_instance(&env);
        storage::write_pending_asset(
            &env,
            &asset,
            &PendingAsset {
                config: config.clone(),
                eta,
            },
        );
        events::AssetChangeProposed {
            asset,
            eta,
            haircut_bps: config.haircut_bps,
            enabled: config.enabled,
            max_nav_age_secs: config.max_nav_age_secs,
            max_nav_move_bps: config.max_nav_move_bps,
            nav_floor: config.nav_floor,
            nav_ceiling: config.nav_ceiling,
            max_open_debt: config.max_open_debt,
        }
        .publish(&env);
        Ok(eta)
    }

    /// Applies the pending asset change once its `eta` has passed.
    pub fn execute_asset(env: Env, asset: Address) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        let pending = storage::read_pending_asset(&env, &asset).ok_or(Error::NoProposal)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockNotDone);
        }
        validate_asset(&protocol, &pending.config)?;
        storage::extend_instance(&env);
        storage::remove_pending_asset(&env, &asset);
        events::ProposalExecuted {
            asset: asset.clone(),
            kind: symbol_short!("asset"),
        }
        .publish(&env);
        apply_asset(&env, asset, &pending.config);
        Ok(())
    }

    /// Drops the pending asset change. Admin or guardian, any time.
    pub fn cancel_asset(env: Env, caller: Address, asset: Address) -> Result<(), Error> {
        admin_or_guardian(&env, &caller)?;
        if storage::read_pending_asset(&env, &asset).is_none() {
            return Err(Error::NoProposal);
        }
        storage::extend_instance(&env);
        drop_pending_asset(&env, &asset, &caller);
        Ok(())
    }

    /// Queues pause switches for `asset` (typically clearing one);
    /// `execute_pause` applies them from the returned `eta`.
    pub fn propose_pause(env: Env, asset: Address, pause: Pause) -> Result<u64, Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        if storage::read_asset(&env, &asset).is_none() {
            return Err(Error::AssetNotSupported);
        }
        let eta = eta(&env, &protocol)?;
        storage::extend_instance(&env);
        storage::write_pending_pause(
            &env,
            &asset,
            &PendingPause {
                pause: pause.clone(),
                eta,
            },
        );
        events::PauseChangeProposed {
            asset,
            eta,
            no_new_repos: pause.no_new_repos,
            no_seize: pause.no_seize,
        }
        .publish(&env);
        Ok(eta)
    }

    /// Applies the pending pause change once its `eta` has passed.
    pub fn execute_pause(env: Env, asset: Address) -> Result<(), Error> {
        storage::read_config(&env).admin.require_auth();
        let pending = storage::read_pending_pause(&env, &asset).ok_or(Error::NoProposal)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockNotDone);
        }
        storage::extend_instance(&env);
        storage::remove_pending_pause(&env, &asset);
        events::ProposalExecuted {
            asset: asset.clone(),
            kind: symbol_short!("pause"),
        }
        .publish(&env);
        apply_pause(&env, asset, &pending.pause);
        Ok(())
    }

    /// Drops the pending pause change. Admin or guardian, any time.
    pub fn cancel_pause(env: Env, caller: Address, asset: Address) -> Result<(), Error> {
        admin_or_guardian(&env, &caller)?;
        if storage::read_pending_pause(&env, &asset).is_none() {
            return Err(Error::NoProposal);
        }
        storage::extend_instance(&env);
        drop_pending_pause(&env, &asset, &caller);
        Ok(())
    }

    // --- lender -----------------------------------------------------------

    /// Escrows `principal` USDC from the lender. Returns the offer id.
    /// The haircut comes from the asset's `AssetConfig`, not the lender.
    /// Rejects a missing or disabled asset with `AssetNotSupported` (#22),
    /// and `Paused` while the asset's `no_new_repos` switch is on (#30).
    pub fn create_offer(
        env: Env,
        lender: Address,
        collateral_asset: Address,
        principal: i128,
        apr_bps: u32,
        term_secs: u64,
    ) -> Result<u64, Error> {
        lender.require_auth();
        if principal <= 0 || term_secs == 0 {
            return Err(Error::InvalidAmount);
        }
        match storage::read_asset(&env, &collateral_asset) {
            Some(asset) if asset.enabled => {}
            _ => return Err(Error::AssetNotSupported),
        }
        new_repos_allowed(&env, &collateral_asset)?;
        let config = storage::read_config(&env);
        // Fail now, not at take time, if the terms overflow the interest math.
        math::interest(principal, apr_bps, term_secs, config.day_secs)?;

        let offer = Offer {
            id: storage::next_offer_id(&env),
            lender,
            collateral_asset,
            principal,
            apr_bps,
            term_secs,
            created_at: env.ledger().timestamp(),
        };
        storage::write_offer(&env, &offer);
        storage::extend_instance(&env);

        token::Client::new(&env, &config.usdc).transfer(
            &offer.lender,
            env.current_contract_address(),
            &principal,
        );

        events::OfferCreated {
            offer_id: offer.id,
            lender: offer.lender,
            collateral_asset: offer.collateral_asset,
            principal,
            apr_bps,
            term_secs,
        }
        .publish(&env);
        Ok(offer.id)
    }

    /// Returns the escrowed USDC to the lender. Only the lender can cancel,
    /// and only while the offer is untaken (a take removes it).
    pub fn cancel_offer(env: Env, offer_id: u64) -> Result<(), Error> {
        let offer = storage::read_offer(&env, offer_id).ok_or(Error::OfferNotFound)?;
        offer.lender.require_auth();

        storage::remove_offer(&env, offer_id);
        storage::extend_instance(&env);

        let usdc = storage::read_config(&env).usdc;
        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &offer.lender,
            &offer.principal,
        );

        events::OfferCancelled {
            offer_id,
            lender: offer.lender,
            principal: offer.principal,
        }
        .publish(&env);
        Ok(())
    }

    // --- borrower ---------------------------------------------------------

    /// Atomic DvP: collateral in, escrowed USDC out. Returns the repo id.
    /// Full takes only (DECISIONS.md #16): the contract computes
    /// `collateral = required_collateral(debt, nav, dec, haircut)`, rounded up,
    /// and fixes debt = principal + full-term interest (#15). The borrower's
    /// auth on the SAC transfer pins the exact amount, so if NAV moves between
    /// simulate and submit the tx fails instead of overcharging (#21).
    ///
    /// Rejects stale NAV (#6), NAV outside the asset's sanity band (#31), an
    /// asset disabled since the offer was posted (#23) and an asset paused
    /// with `no_new_repos` (#30). The haircut is snapshotted on the repo (#19).
    /// Rejects with `CapExceeded` if the asset's open debt plus this debt
    /// would pass `max_open_debt` (#32); the offer stays on the board.
    ///
    /// `auto_repay` opts in to auto-repay (#27): the same signature also
    /// approves this contract to pull the debt in USDC from maturity.
    pub fn take_offer(
        env: Env,
        borrower: Address,
        offer_id: u64,
        auto_repay: bool,
    ) -> Result<u64, Error> {
        borrower.require_auth();
        let offer = storage::read_offer(&env, offer_id).ok_or(Error::OfferNotFound)?;
        let asset = match storage::read_asset(&env, &offer.collateral_asset) {
            Some(asset) if asset.enabled => asset,
            _ => return Err(Error::AssetNotSupported),
        };
        new_repos_allowed(&env, &offer.collateral_asset)?;
        let config = storage::read_config(&env);
        let (nav, nav_decimals) =
            oracle::fresh_collateral_nav(&env, &config, &offer.collateral_asset, &asset)?;

        let interest = math::interest(
            offer.principal,
            offer.apr_bps,
            offer.term_secs,
            config.day_secs,
        )?;
        let debt = math::debt(offer.principal, interest)?;
        let collateral = math::required_collateral(debt, nav, nav_decimals, asset.haircut_bps)?;
        // Holds by construction; kept as the explicit initial LTV gate (#14).
        if !math::ltv_ok(debt, collateral, nav, nav_decimals, asset.haircut_bps)? {
            return Err(Error::InsufficientCollateral);
        }
        // Exposure cap (#32): exactly at the cap passes, one unit over fails.
        let open_debt = storage::read_open_debt(&env, &offer.collateral_asset)
            .checked_add(debt)
            .ok_or(Error::MathOverflow)?;
        if open_debt > asset.max_open_debt {
            return Err(Error::CapExceeded);
        }

        let now = env.ledger().timestamp();
        let repo = Repo {
            id: storage::next_repo_id(&env),
            offer_id,
            lender: offer.lender,
            borrower,
            collateral_asset: offer.collateral_asset,
            collateral_amount: collateral,
            principal: offer.principal,
            interest,
            haircut_bps: asset.haircut_bps,
            start_ts: now,
            maturity_ts: now
                .checked_add(offer.term_secs)
                .ok_or(Error::MathOverflow)?,
            margin_call_deadline: None,
            status: Status::Open,
            auto_repay,
        };
        // The offer is gone once taken: no double take, no cancel after take.
        storage::remove_offer(&env, offer_id);
        storage::write_repo(&env, &repo);
        storage::write_open_debt(&env, &repo.collateral_asset, open_debt);
        storage::extend_instance(&env);

        let this = env.current_contract_address();
        token::Client::new(&env, &repo.collateral_asset).transfer(
            &repo.borrower,
            &this,
            &collateral,
        );
        token::Client::new(&env, &config.usdc).transfer(&this, &repo.borrower, &repo.principal);
        if auto_repay {
            autorepay::adjust_allowance(
                &env,
                &config.usdc,
                &repo.borrower,
                debt,
                repo.maturity_ts.saturating_add(config.grace_secs),
            )?;
        }

        events::RepoOpened {
            repo_id: repo.id,
            offer_id,
            lender: repo.lender,
            borrower: repo.borrower,
            collateral_asset: repo.collateral_asset,
            collateral_amount: collateral,
            principal: repo.principal,
            interest,
            haircut_bps: repo.haircut_bps,
            maturity_ts: repo.maturity_ts,
            auto_repay,
        }
        .publish(&env);
        Ok(repo.id)
    }

    /// Borrower pays principal + full-term interest and gets the collateral
    /// back. The lender receives exactly `principal + interest − fee`, the
    /// treasury the fee (#3). Works from `Open` or `MarginCall`, before or
    /// after maturity until someone calls `default`, and needs no NAV (#6).
    /// No pause switch blocks it (#30).
    pub fn repay(env: Env, repo_id: u64) -> Result<(), Error> {
        let mut repo = storage::read_repo(&env, repo_id).ok_or(Error::RepoNotFound)?;
        if !matches!(repo.status, Status::Open | Status::MarginCall) {
            return Err(Error::InvalidStatus);
        }
        repo.borrower.require_auth();

        let config = storage::read_config(&env);
        let debt = math::debt(repo.principal, repo.interest)?;
        let split = math::waterfall(debt, repo.principal, repo.interest, config.fee_bps)?;

        repo.status = Status::Repaid;
        storage::write_repo(&env, &repo);
        storage::release_open_debt(&env, &repo.collateral_asset, debt);
        storage::extend_instance(&env);

        let usdc = token::Client::new(&env, &config.usdc);
        usdc.transfer(&repo.borrower, &repo.lender, &split.lender);
        if split.fee > 0 {
            usdc.transfer(&repo.borrower, &config.treasury, &split.fee);
        }
        token::Client::new(&env, &repo.collateral_asset).transfer(
            &env.current_contract_address(),
            &repo.borrower,
            &repo.collateral_amount,
        );
        // Paid by hand: this repo no longer needs its share of the allowance.
        if repo.auto_repay {
            autorepay::adjust_allowance(&env, &config.usdc, &repo.borrower, -debt, 0)?;
        }

        events::Repaid {
            repo_id,
            lender_amount: split.lender,
            fee: split.fee,
            automatic: false,
        }
        .publish(&env);
        Ok(())
    }

    /// Turns auto-repay on or off for a live repo (#27). On approves this
    /// contract to pull the debt in USDC from maturity; off takes that
    /// approval back. Borrower only; setting the current value is a no-op.
    pub fn set_auto_repay(env: Env, repo_id: u64, enabled: bool) -> Result<(), Error> {
        let mut repo = storage::read_repo(&env, repo_id).ok_or(Error::RepoNotFound)?;
        if !matches!(repo.status, Status::Open | Status::MarginCall) {
            return Err(Error::InvalidStatus);
        }
        repo.borrower.require_auth();
        if repo.auto_repay == enabled {
            return Ok(());
        }

        let config = storage::read_config(&env);
        let debt = math::debt(repo.principal, repo.interest)?;
        repo.auto_repay = enabled;
        storage::write_repo(&env, &repo);
        storage::extend_instance(&env);

        autorepay::adjust_allowance(
            &env,
            &config.usdc,
            &repo.borrower,
            if enabled { debt } else { -debt },
            repo.maturity_ts.saturating_add(config.grace_secs),
        )?;

        events::AutoRepaySet { repo_id, enabled }.publish(&env);
        Ok(())
    }

    /// Adds collateral. Clears a margin call once
    /// `ltv_ok(debt, collateral, nav, dec, repo.haircut_bps)` holds, i.e. the
    /// initial margin is restored (TradFi convention). Works with stale NAV
    /// and with NAV outside the sanity band; an out-of-band NAV never clears
    /// a call (#31). No pause switch blocks it (#30).
    pub fn top_up(env: Env, repo_id: u64, amount: i128) -> Result<(), Error> {
        margin::top_up(&env, repo_id, amount)
    }

    // --- keeper (anyone) --------------------------------------------------

    /// Repays an opted-in repo from the borrower's USDC allowance (#27).
    /// Anyone can call it from maturity, or once a margin call's deadline has
    /// passed. On success the repo is `Repaid` exactly as if the borrower had
    /// called `repay`. If the pull fails the repo is untouched and the call
    /// returns `AutoRepayFailed`; the borrower can still repay by hand.
    pub fn auto_repay(env: Env, repo_id: u64) -> Result<(), Error> {
        let mut repo = storage::read_repo(&env, repo_id).ok_or(Error::RepoNotFound)?;
        if !matches!(repo.status, Status::Open | Status::MarginCall) {
            return Err(Error::InvalidStatus);
        }
        if !repo.auto_repay {
            return Err(Error::AutoRepayOff);
        }
        if !autorepay::due(&repo, env.ledger().timestamp()) {
            return Err(Error::NotDue);
        }
        let config = storage::read_config(&env);
        if !autorepay::try_settle(&env, &mut repo, &config)? {
            return Err(Error::AutoRepayFailed);
        }
        Ok(())
    }

    /// Sets `margin_call_deadline` on the first `margin_breached`. Returns the
    /// status. Stale NAV returns `StaleNav` (DECISIONS.md #17), NAV outside
    /// the asset's sanity band `NavOutOfBand` (#31).
    pub fn check_margin(env: Env, repo_id: u64) -> Result<Status, Error> {
        margin::check_margin(&env, repo_id)
    }

    /// Moves a repo to `Defaulted` once it is past maturity + grace, or in
    /// `MarginCall` past its `margin_call_deadline` (set by `check_margin`).
    /// Anyone can call it (#7); a maturity default needs no NAV (#17). Both
    /// deadlines are strict: at the exact second the borrower can still repay
    /// or top up.
    ///
    /// A missed call first re-checks the breach at a fresh, in-band NAV
    /// (#20): no longer past the trigger, it returns to `Open` and emits
    /// `MarginCleared`. A stale or out-of-band NAV defaults as before.
    ///
    /// An opted-in repo tries auto-repay first (#27) and settles as `Repaid`
    /// when the pull succeeds. Returns the resulting status.
    ///
    /// While the asset's `no_seize` switch is on (#30) a repo that would
    /// default returns `Paused` and stays `Open` / `MarginCall`, so the
    /// borrower can still repay or top up. The clock is not extended: once the
    /// switch clears, anyone can default it at once. Auto-repay still settles
    /// under the switch: it is a repayment, not a seizure.
    pub fn default(env: Env, repo_id: u64) -> Result<Status, Error> {
        let mut repo = storage::read_repo(&env, repo_id).ok_or(Error::RepoNotFound)?;
        if !matches!(repo.status, Status::Open | Status::MarginCall) {
            return Err(Error::InvalidStatus);
        }
        let config = storage::read_config(&env);
        let now = env.ledger().timestamp();
        let matured = now > repo.maturity_ts.saturating_add(config.grace_secs);
        let missed = autorepay::margin_missed(&repo, now);
        if !matured && !missed {
            return Err(Error::NotDefaultable);
        }
        // #20: a missed call on a loan a fresh NAV shows out of breach clears
        // instead of defaulting. Maturity defaults never look at the NAV.
        if !matured && missed && margin::recovered(&env, &config, &repo)? {
            repo.status = Status::Open;
            repo.margin_call_deadline = None;
            storage::write_repo(&env, &repo);
            storage::extend_instance(&env);
            events::MarginCleared { repo_id }.publish(&env);
            return Ok(repo.status);
        }
        if repo.auto_repay && autorepay::try_settle(&env, &mut repo, &config)? {
            return Ok(Status::Repaid);
        }
        seize_allowed(&env, &repo.collateral_asset)?;

        repo.status = Status::Defaulted;
        storage::write_repo(&env, &repo);
        storage::extend_instance(&env);

        let reason = if matured {
            DefaultReason::Maturity
        } else {
            DefaultReason::MarginCall
        };
        events::Defaulted { repo_id, reason }.publish(&env);
        Ok(repo.status)
    }

    // --- liquidator (whitelisted) -----------------------------------------

    /// A whitelisted liquidator buys a defaulted repo's collateral at
    /// NAV × (1 − discount), rounded up. The USDC goes lender first (capped at
    /// principal + interest − fee), then the fee, then the borrower (#3, #4).
    /// If proceeds fall short of what the lender is owed, the lender takes
    /// everything and `Shortfall` is emitted. Stale NAV returns `StaleNav` (#6),
    /// NAV outside the asset's sanity band `NavOutOfBand` (#31). The asset's
    /// `no_seize` switch returns `Paused` (#30). The repo's own borrower is
    /// never a liquidator of it (`NotLiquidator`), whitelisted or not.
    pub fn liquidate(env: Env, liquidator: Address, repo_id: u64) -> Result<(), Error> {
        liquidator.require_auth();
        if !storage::is_liquidator(&env, &liquidator) {
            return Err(Error::NotLiquidator);
        }
        let mut repo = storage::read_repo(&env, repo_id).ok_or(Error::RepoNotFound)?;
        // A whitelisted borrower must not buy back its own collateral at the
        // discount and leave the lender the shortfall.
        if liquidator == repo.borrower {
            return Err(Error::NotLiquidator);
        }
        if repo.status != Status::Defaulted {
            return Err(Error::InvalidStatus);
        }
        seize_allowed(&env, &repo.collateral_asset)?;
        // A disabled asset still liquidates; only new offers are blocked (#22).
        let asset =
            storage::read_asset(&env, &repo.collateral_asset).ok_or(Error::AssetNotSupported)?;
        let config = storage::read_config(&env);
        let (nav, nav_decimals) =
            oracle::fresh_collateral_nav(&env, &config, &repo.collateral_asset, &asset)?;

        let proceeds = math::liquidation_proceeds(
            repo.collateral_amount,
            nav,
            nav_decimals,
            config.liquidation_discount_bps,
        )?;
        let split = math::waterfall(proceeds, repo.principal, repo.interest, config.fee_bps)?;

        repo.status = Status::Liquidated;
        storage::write_repo(&env, &repo);
        // The whole debt leaves the book, shortfall or not: the lender's loss
        // is not exposure the protocol still carries.
        storage::release_open_debt(
            &env,
            &repo.collateral_asset,
            repo.principal.saturating_add(repo.interest),
        );
        storage::extend_instance(&env);

        let usdc = token::Client::new(&env, &config.usdc);
        usdc.transfer(&liquidator, &repo.lender, &split.lender);
        if split.fee > 0 {
            usdc.transfer(&liquidator, &config.treasury, &split.fee);
        }
        if split.borrower > 0 {
            usdc.transfer(&liquidator, &repo.borrower, &split.borrower);
        }
        token::Client::new(&env, &repo.collateral_asset).transfer(
            &env.current_contract_address(),
            &liquidator,
            &repo.collateral_amount,
        );

        events::Liquidated {
            repo_id,
            liquidator,
            proceeds,
            lender_amount: split.lender,
            fee: split.fee,
            borrower_amount: split.borrower,
            nav,
            nav_decimals,
        }
        .publish(&env);
        if split.shortfall > 0 {
            events::Shortfall {
                repo_id,
                amount: split.shortfall,
            }
            .publish(&env);
        }
        Ok(())
    }
}

/// `no_new_repos` stops new offers and takes (#30).
fn new_repos_allowed(env: &Env, asset: &Address) -> Result<(), Error> {
    if storage::read_pause(env, asset).no_new_repos {
        return Err(Error::Paused);
    }
    Ok(())
}

/// `no_seize` stops defaults and liquidations (#30).
fn seize_allowed(env: &Env, asset: &Address) -> Result<(), Error> {
    if storage::read_pause(env, asset).no_seize {
        return Err(Error::Paused);
    }
    Ok(())
}

// --- risk-parameter changes (#33) ---------------------------------------------

fn validate_asset(protocol: &Config, config: &AssetConfig) -> Result<(), Error> {
    if config.haircut_bps <= protocol.liquidation_discount_bps
        || config.haircut_bps as i128 >= math::BPS
        || config.max_nav_age_secs == 0
        || !band_ok(config)
        || config.max_open_debt < 0
    {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}

/// True when `new` adds no risk over `old`: same oracle mapping, not
/// re-enabled, haircut not lower, NAV age and cap not higher, NAV band
/// (#31) not wider.
fn asset_tightens(old: &AssetConfig, new: &AssetConfig) -> bool {
    new.oracle_asset == old.oracle_asset
        && (old.enabled || !new.enabled)
        && new.haircut_bps >= old.haircut_bps
        && new.max_nav_age_secs <= old.max_nav_age_secs
        && new.max_open_debt <= old.max_open_debt
        && band_tightens(old, new)
}

/// True when the NAV band (#31) is not wider: move limit not higher; a
/// floor added or raised, never removed or lowered; a ceiling added or
/// lowered, never removed or raised.
fn band_tightens(old: &AssetConfig, new: &AssetConfig) -> bool {
    let floor_ok = match (old.nav_floor, new.nav_floor) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(o), Some(n)) => n >= o,
    };
    let ceiling_ok = match (old.nav_ceiling, new.nav_ceiling) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(o), Some(n)) => n <= o,
    };
    new.max_nav_move_bps <= old.max_nav_move_bps && floor_ok && ceiling_ok
}

/// True when `new` only switches pauses on.
fn pause_tightens(old: &Pause, new: &Pause) -> bool {
    (new.no_new_repos || !old.no_new_repos) && (new.no_seize || !old.no_seize)
}

fn tighten_pause(env: &Env, by: &Address, asset: Address, pause: &Pause) -> Result<(), Error> {
    if storage::read_asset(env, &asset).is_none() {
        return Err(Error::AssetNotSupported);
    }
    if !pause_tightens(&storage::read_pause(env, &asset), pause) {
        return Err(Error::Loosens);
    }
    storage::extend_instance(env);
    drop_pending_pause(env, &asset, by);
    apply_pause(env, asset, pause);
    Ok(())
}

fn apply_asset(env: &Env, asset: Address, config: &AssetConfig) {
    storage::write_asset(env, &asset, config);
    events::AssetConfigured {
        asset,
        haircut_bps: config.haircut_bps,
        enabled: config.enabled,
        max_nav_age_secs: config.max_nav_age_secs,
        max_nav_move_bps: config.max_nav_move_bps,
        nav_floor: config.nav_floor,
        nav_ceiling: config.nav_ceiling,
        max_open_debt: config.max_open_debt,
    }
    .publish(env);
}

fn apply_pause(env: &Env, asset: Address, pause: &Pause) {
    storage::write_pause(env, &asset, pause);
    events::PauseSet {
        asset,
        no_new_repos: pause.no_new_repos,
        no_seize: pause.no_seize,
    }
    .publish(env);
}

/// Removes a pending asset proposal, if any, with a `ProposalCancelled`.
fn drop_pending_asset(env: &Env, asset: &Address, by: &Address) {
    if storage::read_pending_asset(env, asset).is_some() {
        storage::remove_pending_asset(env, asset);
        events::ProposalCancelled {
            asset: asset.clone(),
            kind: symbol_short!("asset"),
            by: by.clone(),
        }
        .publish(env);
    }
}

fn drop_pending_pause(env: &Env, asset: &Address, by: &Address) {
    if storage::read_pending_pause(env, asset).is_some() {
        storage::remove_pending_pause(env, asset);
        events::ProposalCancelled {
            asset: asset.clone(),
            kind: symbol_short!("pause"),
            by: by.clone(),
        }
        .publish(env);
    }
}

fn eta(env: &Env, protocol: &Config) -> Result<u64, Error> {
    env.ledger()
        .timestamp()
        .checked_add(protocol.timelock_secs)
        .ok_or(Error::MathOverflow)
}

fn admin_or_guardian(env: &Env, caller: &Address) -> Result<(), Error> {
    caller.require_auth();
    let protocol = storage::read_config(env);
    if *caller != protocol.admin && *caller != protocol.guardian {
        return Err(Error::NotAdminOrGuardian);
    }
    Ok(())
}

/// Shortest accepted `timelock_secs`: a loosening must stay visible on-chain
/// for at least a minute before it can execute (#33).
pub(crate) const MIN_TIMELOCK_SECS: u64 = 60;

fn validate_config(config: &Config) -> Result<(), Error> {
    let bps = math::BPS as u32;
    if config.fee_bps >= bps
        || config.liquidation_discount_bps == 0
        || config.liquidation_discount_bps >= bps
        || config.day_secs == 0
        || config.timelock_secs < MIN_TIMELOCK_SECS
    {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}

/// NAV sanity band settings for `set_asset` / `propose_asset` (DECISIONS.md #31).
fn band_ok(config: &AssetConfig) -> bool {
    let positive = |bound: Option<i128>| bound.is_none_or(|b| b > 0);
    let ordered = match (config.nav_floor, config.nav_ceiling) {
        (Some(floor), Some(ceiling)) => floor <= ceiling,
        _ => true,
    };
    config.max_nav_move_bps > 0
        && positive(config.nav_floor)
        && positive(config.nav_ceiling)
        && ordered
}
