#![no_std]

//! Caravel: fixed-term, fixed-rate USDC repo against tokenized Treasuries.
//!
//! State machine: Open → MarginCall → Open (top-up) | Repaid | Defaulted → Liquidated,
//! and Defaulted → Repaid while no liquidation has landed. Defaulted →
//! Liquidated is a sale (`liquidate`, fresh NAV) or, after a NAV outage,
//! the lender's in-kind claim (`claim_in_kind`).
//! An opted-in repo settles as Repaid instead of Defaulted when its USDC
//! allowance covers the debt (auto-repay, DECISIONS.md #27).

mod autorepay;
mod errors;
mod events;
mod inkind;
mod margin;
pub mod math;
mod oracle;
mod payout;
mod storage;
mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_allowlist;
#[cfg(test)]
mod test_attack_a1;
#[cfg(test)]
mod test_attack_a2;
#[cfg(test)]
mod test_attack_a3;
#[cfg(test)]
mod test_attack_a4;
#[cfg(test)]
mod test_attack_a8;
#[cfg(test)]
mod test_band_real_move;
#[cfg(test)]
mod test_feed_rewrite;
#[cfg(test)]
mod test_governance;
#[cfg(test)]
mod test_nav_outage;
#[cfg(test)]
mod test_production;
#[cfg(test)]
mod test_raven_guards;
#[cfg(test)]
mod test_spiko;

use soroban_sdk::{
    contract, contractimpl, panic_with_error, symbol_short, token, Address, Env, IntoVal,
    TryFromVal, Val,
};

pub use errors::Error;
use storage::DataKey;
pub use types::{
    Asset, AssetConfig, BandCandidate, Config, DefaultReason, Offer, Pause, PendingAdmin,
    PendingAsset, PendingGuardian, PendingPause, Repo, Roles, Status,
};

#[contract]
pub struct CaravelRepo;

#[contractimpl]
impl CaravelRepo {
    /// Stores `config` once. `InvalidConfig` unless `validate_config` holds,
    /// the feed quotes in USD (`base() == Other("USD")`, Raven STD-01) and
    /// `usdc.decimals() == 7`, the scale all value math assumes (CS-07).
    pub fn __constructor(env: Env, config: Config) -> Result<(), Error> {
        validate_config(&config)?;
        if !oracle::config_feeds_ok(&env, &config) {
            return Err(Error::InvalidConfig);
        }
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

    /// Admin and guardian in force (always equal to `config()`'s) and any
    /// handover in flight: `transfer_admin` waiting for `accept_admin`, a
    /// `propose_guardian` waiting out the timelock (Raven R6).
    pub fn roles(env: Env) -> Roles {
        storage::extend_instance(&env);
        let config = storage::read_config(&env);
        let admin = storage::read_pending_admin(&env);
        let guardian = storage::read_pending_guardian(&env);
        Roles {
            admin: config.admin,
            guardian: config.guardian,
            pending_admin_live_until: admin.as_ref().map(|p| p.live_until_ledger),
            pending_admin: admin.map(|p| p.admin),
            pending_guardian_eta: guardian.as_ref().map(|p| p.eta),
            pending_guardian: guardian.map(|p| p.guardian),
        }
    }

    /// The `eta` of a liquidator addition waiting out the timelock, if any
    /// (Raven UA-03).
    pub fn pending_liquidator(env: Env, who: Address) -> Option<u64> {
        storage::extend_instance(&env);
        storage::read_pending_liquidator(&env, &who)
    }

    /// Debt (principal + interest) of live repos on `asset`, the amount
    /// counted against `AssetConfig.max_open_debt` (#32). 0 for an unknown asset.
    pub fn open_debt(env: Env, asset: Address) -> i128 {
        storage::extend_instance(&env);
        storage::read_open_debt(&env, &asset)
    }

    /// USDC parked for `who` because a payout to it failed (frozen account,
    /// closed trustline); `claim` pays it out. 0 if none.
    pub fn claimable(env: Env, who: Address) -> i128 {
        storage::extend_instance(&env);
        storage::read_claimable(&env, &who)
    }

    /// Collateral of `asset` parked for `who` because an in-kind claim could
    /// not push it (permissioned token refused, frozen trustline);
    /// `claim_collateral` pays it out. 0 if none.
    pub fn claimable_collateral(env: Env, who: Address, asset: Address) -> i128 {
        storage::extend_instance(&env);
        storage::read_claimable_collateral(&env, &who, &asset)
    }

    /// The NAV level the repo has watched stand for `asset`'s oracle asset
    /// and since when (side band-real-move), if `note_nav` ever ran.
    pub fn band_candidate(env: Env, asset: Address) -> Result<Option<BandCandidate>, Error> {
        storage::extend_instance(&env);
        let config = storage::read_asset(&env, &asset).ok_or(Error::AssetNotSupported)?;
        Ok(storage::read_band_candidate(&env, &config.oracle_asset))
    }

    // --- anyone: NAV band settle clock (side band-real-move) --------------

    /// Starts or keeps the band settle clock for collateral `asset`. Anyone
    /// can call it; keeper and nav-keeper call it every tick. If the latest
    /// NAV (or a feed record since the clock started) has moved more than
    /// `max_nav_move_bps` from the stored level, the level restarts at the
    /// latest NAV with `since` = ledger now (`NavLevelNoted`); else nothing
    /// changes. A latest NAV outside the #31 window is then accepted by
    /// `take_offer`, `check_margin`, `default`, `liquidate` and `top_up`
    /// once the level has stood `band_settle_secs`. Returns the level in
    /// force. Errors: `AssetNotSupported`, `NoPrice`.
    pub fn note_nav(env: Env, asset: Address) -> Result<BandCandidate, Error> {
        let asset = storage::read_asset(&env, &asset).ok_or(Error::AssetNotSupported)?;
        let config = storage::read_config(&env);
        storage::extend_instance(&env);
        oracle::note_nav(&env, &config, &asset)
    }

    // --- anyone owed a parked payout --------------------------------------

    /// Pays `who` its whole parked USDC balance and returns the amount.
    /// `who` signs. Fails with `NothingToClaim` if nothing is parked; if the
    /// transfer still fails (account still frozen) the call reverts and the
    /// balance stays parked.
    pub fn claim(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();
        let amount = storage::read_claimable(&env, &who);
        if amount <= 0 {
            return Err(Error::NothingToClaim);
        }
        storage::remove_claimable(&env, &who);
        storage::extend_instance(&env);
        let usdc = storage::read_config(&env).usdc;
        token::Client::new(&env, &usdc).transfer(&env.current_contract_address(), &who, &amount);
        events::Claimed { who, amount }.publish(&env);
        Ok(amount)
    }

    /// Sends `who`'s whole parked balance of collateral `asset` to `to` and
    /// returns the amount. `who` signs; `to` may differ, so a lender a
    /// permissioned token never admits can route it to an admitted custody
    /// account. `NothingToClaim` if nothing is parked; if the token still
    /// refuses `to`, the call reverts and the balance stays parked.
    pub fn claim_collateral(
        env: Env,
        who: Address,
        asset: Address,
        to: Address,
    ) -> Result<i128, Error> {
        who.require_auth();
        let amount = storage::read_claimable_collateral(&env, &who, &asset);
        if amount <= 0 {
            return Err(Error::NothingToClaim);
        }
        storage::remove_claimable_collateral(&env, &who, &asset);
        storage::extend_instance(&env);
        token::Client::new(&env, &asset).transfer(&env.current_contract_address(), &to, &amount);
        events::CollateralClaimed {
            who,
            collateral_asset: asset,
            to,
            amount,
        }
        .publish(&env);
        Ok(amount)
    }

    // --- admin ------------------------------------------------------------

    /// Removes `liquidator` from the whitelist at once and drops a pending
    /// addition for it (`LiquidatorSet { allowed: false }`). Adding is
    /// timelocked (Raven UA-03): `allowed = true` fails with `Loosens` (20)
    /// unless `liquidator` is already whitelisted (then a no-op); use
    /// `propose_liquidator` + `execute_liquidator`. The signature is kept for
    /// existing clients, so that error is raised as a contract panic.
    pub fn set_liquidator(env: Env, liquidator: Address, allowed: bool) {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        storage::extend_instance(&env);
        if allowed {
            if !storage::is_liquidator(&env, &liquidator) {
                panic_with_error!(&env, Error::Loosens);
            }
            return;
        }
        drop_pending_liquidator(&env, &liquidator, &protocol.admin);
        storage::set_liquidator(&env, &liquidator, false);
        events::LiquidatorSet {
            who: liquidator,
            allowed: false,
        }
        .publish(&env);
    }

    /// Queues `liquidator` for the whitelist; `execute_liquidator` adds it
    /// in the same window as `execute_asset` (Raven UA-03). A re-proposal
    /// replaces the pending one and restarts the clock.
    pub fn propose_liquidator(env: Env, liquidator: Address) -> Result<u64, Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        let eta = eta(&env, &protocol)?;
        storage::extend_instance(&env);
        drop_pending_liquidator(&env, &liquidator, &protocol.admin);
        storage::write_pending_liquidator(&env, &liquidator, eta);
        events::LiquidatorProposed {
            who: liquidator,
            eta,
        }
        .publish(&env);
        Ok(eta)
    }

    /// Adds the proposed liquidator from its `eta` until
    /// `eta + timelock_secs` (`TimelockNotDone` before, `ProposalExpired`
    /// after). Emits `LiquidatorSet { allowed: true }`.
    pub fn execute_liquidator(env: Env, liquidator: Address) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        let eta = storage::read_pending_liquidator(&env, &liquidator).ok_or(Error::NoProposal)?;
        check_window(&env, &protocol, eta)?;
        storage::extend_instance(&env);
        storage::remove_pending_liquidator(&env, &liquidator);
        storage::remove_vetoed(&env, &DataKey::VetoedLiquidator(liquidator.clone()));
        storage::set_liquidator(&env, &liquidator, true);
        events::LiquidatorSet {
            who: liquidator,
            allowed: true,
        }
        .publish(&env);
        Ok(())
    }

    /// Drops a pending liquidator addition. The admin any time; the
    /// guardian once per address (`VetoSpent` on a re-proposal of one it
    /// already cancelled; Raven R6).
    pub fn cancel_liquidator(env: Env, caller: Address, liquidator: Address) -> Result<(), Error> {
        let protocol = admin_or_guardian(&env, &caller)?;
        let eta = storage::read_pending_liquidator(&env, &liquidator).ok_or(Error::NoProposal)?;
        if caller != protocol.admin {
            spend_veto(
                &env,
                &protocol,
                &DataKey::VetoedLiquidator(liquidator.clone()),
                &true,
                eta,
            )?;
        }
        storage::extend_instance(&env);
        drop_pending_liquidator(&env, &liquidator, &caller);
        Ok(())
    }

    // --- admin: role rotation (Raven R6) ----------------------------------

    /// Starts handing the admin role to `new_admin`, who must call
    /// `accept_admin` by ledger `live_until_ledger` (Raven UA-06; pending
    /// entry in temporary storage, as OpenZeppelin's Ownable does). A new
    /// call replaces the pending handover; `live_until_ledger = 0` cancels
    /// it (`NoProposal` if none). `InvalidConfig` if `new_admin` is the
    /// guardian or the ledger is in the past or beyond the max TTL.
    pub fn transfer_admin(
        env: Env,
        new_admin: Address,
        live_until_ledger: u32,
    ) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        storage::extend_instance(&env);
        if live_until_ledger == 0 {
            let pending = storage::read_pending_admin(&env).ok_or(Error::NoProposal)?;
            storage::remove_pending_admin(&env);
            events::AdminTransferStarted {
                new_admin: pending.admin,
                live_until_ledger: 0,
            }
            .publish(&env);
            return Ok(());
        }
        let now = env.ledger().sequence();
        if new_admin == protocol.guardian
            || live_until_ledger < now
            || live_until_ledger - now > env.storage().max_ttl()
        {
            return Err(Error::InvalidConfig);
        }
        storage::write_pending_admin(
            &env,
            &PendingAdmin {
                admin: new_admin.clone(),
                live_until_ledger,
            },
        );
        events::AdminTransferStarted {
            new_admin,
            live_until_ledger,
        }
        .publish(&env);
        Ok(())
    }

    /// The pending admin takes the role (it signs). `NoProposal` if no
    /// handover is pending or it lapsed; `InvalidConfig` if it has become
    /// the guardian meanwhile. Emits `AdminSet`.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending = storage::read_pending_admin(&env).ok_or(Error::NoProposal)?;
        pending.admin.require_auth();
        let mut protocol = storage::read_config(&env);
        if pending.admin == protocol.guardian {
            return Err(Error::InvalidConfig);
        }
        storage::extend_instance(&env);
        storage::remove_pending_admin(&env);
        let previous = core::mem::replace(&mut protocol.admin, pending.admin.clone());
        storage::write_config(&env, &protocol);
        events::AdminSet {
            admin: pending.admin,
            previous,
        }
        .publish(&env);
        Ok(())
    }

    /// Queues a new guardian behind the timelock (Raven UA-02). Only the
    /// admin can cancel it (`cancel_guardian`), so a lost or hostile
    /// guardian is replaced after one timelock. A re-proposal replaces the
    /// pending one. `InvalidConfig` if `guardian` is the admin.
    pub fn propose_guardian(env: Env, guardian: Address) -> Result<u64, Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        if guardian == protocol.admin {
            return Err(Error::InvalidConfig);
        }
        let eta = eta(&env, &protocol)?;
        storage::extend_instance(&env);
        if let Some(old) = storage::read_pending_guardian(&env) {
            events::GuardianChangeCancelled {
                guardian: old.guardian,
            }
            .publish(&env);
        }
        storage::write_pending_guardian(
            &env,
            &PendingGuardian {
                guardian: guardian.clone(),
                eta,
            },
        );
        events::GuardianChangeProposed { guardian, eta }.publish(&env);
        Ok(eta)
    }

    /// Makes the proposed guardian current, in the same window as
    /// `execute_asset`. Emits `GuardianSet`.
    pub fn execute_guardian(env: Env) -> Result<(), Error> {
        let mut protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        let pending = storage::read_pending_guardian(&env).ok_or(Error::NoProposal)?;
        check_window(&env, &protocol, pending.eta)?;
        if pending.guardian == protocol.admin {
            return Err(Error::InvalidConfig);
        }
        storage::extend_instance(&env);
        storage::remove_pending_guardian(&env);
        let previous = core::mem::replace(&mut protocol.guardian, pending.guardian.clone());
        storage::write_config(&env, &protocol);
        events::GuardianSet {
            guardian: pending.guardian,
            previous,
        }
        .publish(&env);
        Ok(())
    }

    /// Drops the pending guardian rotation. Admin only.
    pub fn cancel_guardian(env: Env) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        let pending = storage::read_pending_guardian(&env).ok_or(Error::NoProposal)?;
        storage::extend_instance(&env);
        storage::remove_pending_guardian(&env);
        events::GuardianChangeCancelled {
            guardian: pending.guardian,
        }
        .publish(&env);
        Ok(())
    }

    /// Adds or re-tiers a collateral asset (DECISIONS.md #13). Requires
    /// `liquidation_discount_bps ≤ margin_trigger_bps < haircut_bps < 10_000`
    /// (#26): a take at max LTV opens strictly below the margin trigger, and a
    /// liquidation at the trigger line still covers the debt.
    /// Requires `max_nav_age_secs > 0` (staleness is per asset, #25), a
    /// valid NAV sanity band (#31): `max_nav_move_bps > 0`, each bound > 0 if
    /// set, and `nav_floor <= nav_ceiling`, and `max_open_debt ≥ 0` (#32).
    /// Re-setting an asset keeps its open debt; a cap below it only stops new
    /// takes.
    ///
    /// Instant only for a first listing (no offer can exist on an unlisted
    /// asset) or a change that only tightens (#33: disable, raise the
    /// haircut or the margin trigger, lower the NAV age or the cap, narrow
    /// the NAV band, raise `band_settle_secs`). Requires
    /// `band_settle_secs > 0`. Anything
    /// that loosens fails with `Loosens`: use `propose_asset`. An instant
    /// change drops a pending proposal for the asset, so it cannot undo the
    /// change later.
    pub fn set_asset(env: Env, asset: Address, config: AssetConfig) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        validate_asset(&env, &protocol, &config)?;
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
        tighten_pause(&env, &protocol, false, asset, &pause)
    }

    // --- guardian (#33): instant, tighten only ----------------------------

    /// The guardian's instant `set_asset` on a listed asset: disable it,
    /// raise the haircut or the margin trigger, lower the NAV age or the cap,
    /// narrow the NAV band, raise `band_settle_secs`. Fails with
    /// `Loosens` if any field adds risk, `AssetNotSupported` if unlisted.
    /// A real change drops a pending admin proposal for the asset, but
    /// only once per proposed change (it spends the guardian's veto, see
    /// `cancel_asset`); re-sending the current config drops nothing (Raven
    /// R6, UA-02).
    pub fn guardian_set_asset(env: Env, asset: Address, config: AssetConfig) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.guardian.require_auth();
        validate_asset(&env, &protocol, &config)?;
        let old = storage::read_asset(&env, &asset).ok_or(Error::AssetNotSupported)?;
        if !asset_tightens(&old, &config) {
            return Err(Error::Loosens);
        }
        storage::extend_instance(&env);
        if config != old {
            if let Some(pending) = storage::read_pending_asset(&env, &asset) {
                let key = DataKey::VetoedAsset(asset.clone());
                if spend_veto(&env, &protocol, &key, &pending.config, pending.eta).is_ok() {
                    drop_pending_asset(&env, &asset, &protocol.guardian);
                }
            }
        }
        apply_asset(&env, asset, &config);
        Ok(())
    }

    /// The guardian's instant `set_pause`: can switch on, never off. Drops
    /// a pending pause proposal like `guardian_set_asset`: never on a
    /// no-op re-assert, once per proposed change otherwise.
    pub fn guardian_set_pause(env: Env, asset: Address, pause: Pause) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.guardian.require_auth();
        tighten_pause(&env, &protocol, true, asset, &pause)
    }

    // --- admin, timelocked (#33): every change that adds risk -------------

    /// Queues `config` for `asset`; `execute_asset` applies it from the
    /// returned `eta` (now + `timelock_secs`) until `eta + timelock_secs`,
    /// then it expires. A new proposal replaces the pending one (with a
    /// `ProposalCancelled` for it) and restarts the clock.
    pub fn propose_asset(env: Env, asset: Address, config: AssetConfig) -> Result<u64, Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        validate_asset(&env, &protocol, &config)?;
        let eta = eta(&env, &protocol)?;
        storage::extend_instance(&env);
        drop_pending_asset(&env, &asset, &protocol.admin);
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
            margin_trigger_bps: config.margin_trigger_bps,
            enabled: config.enabled,
            max_nav_age_secs: config.max_nav_age_secs,
            max_nav_move_bps: config.max_nav_move_bps,
            nav_floor: config.nav_floor,
            nav_ceiling: config.nav_ceiling,
            max_open_debt: config.max_open_debt,
            band_settle_secs: config.band_settle_secs,
        }
        .publish(&env);
        Ok(eta)
    }

    /// Applies the pending asset change from its `eta` until
    /// `eta + timelock_secs` (`TimelockNotDone` before, `ProposalExpired`
    /// after).
    pub fn execute_asset(env: Env, asset: Address) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        let pending = storage::read_pending_asset(&env, &asset).ok_or(Error::NoProposal)?;
        check_window(&env, &protocol, pending.eta)?;
        validate_asset(&env, &protocol, &pending.config)?;
        storage::extend_instance(&env);
        storage::remove_pending_asset(&env, &asset);
        storage::remove_vetoed(&env, &DataKey::VetoedAsset(asset.clone()));
        events::ProposalExecuted {
            asset: asset.clone(),
            kind: symbol_short!("asset"),
        }
        .publish(&env);
        apply_asset(&env, asset, &pending.config);
        Ok(())
    }

    /// Drops the pending asset change. The admin any time. The guardian
    /// once per change (Raven R6, UA-02): if the admin proposes the change
    /// it cancelled again, unchanged, the guardian gets `VetoSpent` and the
    /// change executes after the timelock unless the admin drops it. So
    /// the guardian can delay a change by one timelock, never block it for
    /// good. Cancelling a proposal whose window closed spends nothing.
    pub fn cancel_asset(env: Env, caller: Address, asset: Address) -> Result<(), Error> {
        let protocol = admin_or_guardian(&env, &caller)?;
        let pending = storage::read_pending_asset(&env, &asset).ok_or(Error::NoProposal)?;
        if caller != protocol.admin {
            let key = DataKey::VetoedAsset(asset.clone());
            spend_veto(&env, &protocol, &key, &pending.config, pending.eta)?;
        }
        storage::extend_instance(&env);
        drop_pending_asset(&env, &asset, &caller);
        Ok(())
    }

    /// Queues pause switches for `asset` (typically clearing one);
    /// `execute_pause` applies them from the returned `eta` until
    /// `eta + timelock_secs`. Replacing a pending one works as in
    /// `propose_asset`.
    pub fn propose_pause(env: Env, asset: Address, pause: Pause) -> Result<u64, Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        if storage::read_asset(&env, &asset).is_none() {
            return Err(Error::AssetNotSupported);
        }
        let eta = eta(&env, &protocol)?;
        storage::extend_instance(&env);
        drop_pending_pause(&env, &asset, &protocol.admin);
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

    /// Applies the pending pause change in the same window as `execute_asset`.
    pub fn execute_pause(env: Env, asset: Address) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        let pending = storage::read_pending_pause(&env, &asset).ok_or(Error::NoProposal)?;
        check_window(&env, &protocol, pending.eta)?;
        storage::extend_instance(&env);
        storage::remove_pending_pause(&env, &asset);
        storage::remove_vetoed(&env, &DataKey::VetoedPause(asset.clone()));
        events::ProposalExecuted {
            asset: asset.clone(),
            kind: symbol_short!("pause"),
        }
        .publish(&env);
        apply_pause(&env, asset, &pending.pause);
        Ok(())
    }

    /// Drops the pending pause change: the admin any time, the guardian
    /// once per change, as in `cancel_asset` (Raven R6, UA-02).
    pub fn cancel_pause(env: Env, caller: Address, asset: Address) -> Result<(), Error> {
        let protocol = admin_or_guardian(&env, &caller)?;
        let pending = storage::read_pending_pause(&env, &asset).ok_or(Error::NoProposal)?;
        if caller != protocol.admin {
            let key = DataKey::VetoedPause(asset.clone());
            spend_veto(&env, &protocol, &key, &pending.pause, pending.eta)?;
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
        let config = storage::read_config(&env);
        // Raven AS-03: a lender the USDC issuer has frozen cannot cancel its
        // offer, so its escrow must not be lent out either; the offer reads
        // as gone until the issuer re-authorizes the lender.
        if !payout::usdc_authorized(&env, &config.usdc, &offer.lender) {
            return Err(Error::OfferNotFound);
        }
        let asset = match storage::read_asset(&env, &offer.collateral_asset) {
            Some(asset) if asset.enabled => asset,
            _ => return Err(Error::AssetNotSupported),
        };
        new_repos_allowed(&env, &offer.collateral_asset)?;
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
    /// treasury the fee (#3). Works from `Open`, `MarginCall` or `Defaulted`,
    /// before or after maturity until a liquidation lands, at the same fixed
    /// debt, and needs no NAV (#6). No pause switch blocks it (#30). The
    /// borrower pays the debt into the contract; a lender or treasury payout
    /// that fails (frozen account) is parked for `claim` and the repay still
    /// lands.
    pub fn repay(env: Env, repo_id: u64) -> Result<(), Error> {
        let mut repo = storage::read_repo(&env, repo_id).ok_or(Error::RepoNotFound)?;
        // Defaulted stays repayable until `liquidate` lands: nothing obliges a
        // liquidator to buy, and the lender is paid in full instead of from a
        // discounted sale.
        if !matches!(
            repo.status,
            Status::Open | Status::MarginCall | Status::Defaulted
        ) {
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

        let this = env.current_contract_address();
        let usdc = token::Client::new(&env, &config.usdc);
        usdc.transfer(&repo.borrower, &this, &debt);
        payout::pay_or_park(&env, &usdc, &repo.lender, split.lender, repo_id);
        payout::pay_or_park(&env, &usdc, &config.treasury, split.fee, repo_id);
        token::Client::new(&env, &repo.collateral_asset).transfer(
            &this,
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
    /// called `repay`. If the pull fails, or the collateral cannot be returned
    /// to the borrower, the repo is untouched and the call returns
    /// `AutoRepayFailed`; the borrower can still repay by hand.
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
        // A refund here reverts with the error, so no allowance is spent.
        if autorepay::try_settle(&env, &mut repo, &config)? != autorepay::Settle::Settled {
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
    /// `MarginCleared`. Still past it, it defaults. With no price, a stale
    /// NAV or one outside the sanity band it returns `NoPrice` / `StaleNav` /
    /// `NavOutOfBand` and waits: a missed call defaults only on a fresh,
    /// in-band NAV that confirms the breach. Maturity defaults never read the
    /// NAV.
    ///
    /// An opted-in repo tries auto-repay first (#27) and settles as `Repaid`
    /// when the pull succeeds and the collateral can be returned; otherwise
    /// the pull is refunded and the repo defaults. Returns the resulting
    /// status.
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
        // instead of defaulting; a stale / missing / out-of-band NAV returns
        // the oracle error and the default waits. Maturity defaults never
        // look at the NAV.
        if !matured && missed && margin::recovered(&env, &config, &repo)? {
            repo.status = Status::Open;
            repo.margin_call_deadline = None;
            storage::write_repo(&env, &repo);
            storage::extend_instance(&env);
            events::MarginCleared { repo_id }.publish(&env);
            return Ok(repo.status);
        }
        if repo.auto_repay {
            match autorepay::try_settle(&env, &mut repo, &config)? {
                autorepay::Settle::Settled => return Ok(Status::Repaid),
                // Raven CS-01: the refunded pull spent this repo's share of
                // the shared allowance; with the flag still on, a hand
                // `repay` from Defaulted would take it off a second time and
                // strip the borrower's other opted-in repos of their cover.
                autorepay::Settle::Refunded => repo.auto_repay = false,
                autorepay::Settle::PullFailed => {}
            }
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
    /// never a liquidator of it (`NotLiquidator`), whitelisted or not. The
    /// liquidator pays the proceeds into the contract; a lender, treasury or
    /// borrower payout that fails (frozen account) is parked for `claim` and
    /// the liquidation still lands.
    ///
    /// A stale NAV stays blocking however long the outage lasts; the lender's
    /// way out of a long outage is `claim_in_kind`.
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

        let this = env.current_contract_address();
        let usdc = token::Client::new(&env, &config.usdc);
        usdc.transfer(&liquidator, &this, &proceeds);
        payout::pay_or_park(&env, &usdc, &repo.lender, split.lender, repo_id);
        payout::pay_or_park(&env, &usdc, &config.treasury, split.fee, repo_id);
        payout::pay_or_park(&env, &usdc, &repo.borrower, split.borrower, repo_id);
        token::Client::new(&env, &repo.collateral_asset).transfer(
            &this,
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

    // --- lender, NAV outage fallback --------------------------------------

    /// The lender takes a Defaulted repo's whole collateral in kind once the
    /// asset's NAV has been stale for more than `inkind::NAV_OUTAGE_DAYS`
    /// days (`day_secs` each) past `max_nav_age_secs`; `liquidate` stays
    /// blocked on a stale NAV. No sale: no fee, no borrower surplus, the
    /// whole debt leaves `open_debt` and the repo is `Liquidated`
    /// (`ClaimedInKind` event). If the token refuses the push to the lender
    /// (permissioned token, frozen trustline) the collateral is parked for
    /// `claim_collateral` and the claim still lands. Returns the collateral
    /// amount. Lender signs.
    ///
    /// `InvalidStatus` unless Defaulted, `Paused` under `no_seize` (#30),
    /// `NoNavOutage` while the NAV is fresh or not stale long enough. A feed
    /// with no usable timestamp (no price, a price `<= 0`, or one dated more
    /// than `oracle::MAX_FUTURE_SKEW_SECS` ahead) starts the same clock at
    /// `maturity_ts + grace_secs` instead (`inkind::nav_outage`). Until the
    /// claim lands the borrower can still `repay`, which needs no NAV.
    pub fn claim_in_kind(env: Env, repo_id: u64) -> Result<i128, Error> {
        let mut repo = storage::read_repo(&env, repo_id).ok_or(Error::RepoNotFound)?;
        if repo.status != Status::Defaulted {
            return Err(Error::InvalidStatus);
        }
        repo.lender.require_auth();
        seize_allowed(&env, &repo.collateral_asset)?;
        let asset =
            storage::read_asset(&env, &repo.collateral_asset).ok_or(Error::AssetNotSupported)?;
        let config = storage::read_config(&env);
        let nav_timestamp = inkind::nav_outage(
            &env,
            &config,
            &asset,
            repo.maturity_ts.saturating_add(config.grace_secs),
        )?;

        repo.status = Status::Liquidated;
        storage::write_repo(&env, &repo);
        storage::release_open_debt(
            &env,
            &repo.collateral_asset,
            repo.principal.saturating_add(repo.interest),
        );
        storage::extend_instance(&env);

        let pushed = inkind::push_or_park(
            &env,
            &repo.collateral_asset,
            &repo.lender,
            repo.collateral_amount,
        );
        events::ClaimedInKind {
            repo_id,
            lender: repo.lender,
            collateral_asset: repo.collateral_asset,
            collateral_amount: repo.collateral_amount,
            parked: !pushed,
            nav_timestamp,
        }
        .publish(&env);
        Ok(repo.collateral_amount)
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

fn validate_asset(env: &Env, protocol: &Config, config: &AssetConfig) -> Result<(), Error> {
    // Raven STD-02: a SEP-40 record is up to one `resolution` old when
    // fresh, so a shorter NAV age reads the feed as stale part of every
    // period. A feed whose `resolution()` fails is rejected too.
    let resolution_ok = oracle::feed_resolution(env, protocol)
        .is_some_and(|resolution| config.max_nav_age_secs >= u64::from(resolution));
    // #26: discount ≤ trigger < haircut < 100%.
    if !resolution_ok
        || config.margin_trigger_bps < protocol.liquidation_discount_bps
        || config.haircut_bps <= config.margin_trigger_bps
        || config.haircut_bps as i128 >= math::BPS
        || config.max_nav_age_secs == 0
        || !band_ok(config)
        || config.max_open_debt < 0
        || config.band_settle_secs == 0
    {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}

/// True when `new` adds no risk over `old`: same oracle mapping, not
/// re-enabled, haircut and margin trigger (#26) not lower, NAV age and cap
/// not higher, NAV band (#31) not wider, band settle time not shorter.
fn asset_tightens(old: &AssetConfig, new: &AssetConfig) -> bool {
    new.oracle_asset == old.oracle_asset
        && (old.enabled || !new.enabled)
        && new.haircut_bps >= old.haircut_bps
        && new.margin_trigger_bps >= old.margin_trigger_bps
        && new.max_nav_age_secs <= old.max_nav_age_secs
        && new.max_open_debt <= old.max_open_debt
        && new.band_settle_secs >= old.band_settle_secs
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

/// An instant pause switch-on. The admin's drops its own pending pause
/// proposal. The guardian's drops it only on a real change and once per
/// proposed change (`spend_veto`): re-asserting the pause in force must not
/// cancel the admin's clear (Raven R6, OZ-02 QA path).
fn tighten_pause(
    env: &Env,
    protocol: &Config,
    by_guardian: bool,
    asset: Address,
    pause: &Pause,
) -> Result<(), Error> {
    if storage::read_asset(env, &asset).is_none() {
        return Err(Error::AssetNotSupported);
    }
    let current = storage::read_pause(env, &asset);
    if !pause_tightens(&current, pause) {
        return Err(Error::Loosens);
    }
    storage::extend_instance(env);
    if !by_guardian {
        drop_pending_pause(env, &asset, &protocol.admin);
    } else if current != *pause {
        if let Some(pending) = storage::read_pending_pause(env, &asset) {
            let key = DataKey::VetoedPause(asset.clone());
            if spend_veto(env, protocol, &key, &pending.pause, pending.eta).is_ok() {
                drop_pending_pause(env, &asset, &protocol.guardian);
            }
        }
    }
    apply_pause(env, asset, pause);
    Ok(())
}

/// The guardian's veto on one proposed change (Raven R6, UA-02): the first
/// cancel or supersede of `change` records it under `key`; a second one on
/// the same change, re-proposed unchanged by the admin, fails with
/// `VetoSpent`. Without this a guardian could cancel every clear of its
/// own `no_seize` and freeze seizure for good. A proposal past its window
/// cannot execute anyway, so dropping it records nothing.
fn spend_veto<V>(
    env: &Env,
    protocol: &Config,
    key: &DataKey,
    change: &V,
    eta: u64,
) -> Result<(), Error>
where
    V: PartialEq + IntoVal<Env, Val> + TryFromVal<Env, Val>,
{
    if env.ledger().timestamp() > eta.saturating_add(protocol.timelock_secs) {
        return Ok(());
    }
    if storage::read_vetoed::<V>(env, key).as_ref() == Some(change) {
        return Err(Error::VetoSpent);
    }
    storage::write_vetoed(env, key, change);
    Ok(())
}

/// Removes a pending liquidator addition, if any, with a
/// `LiquidatorProposalCancelled`.
fn drop_pending_liquidator(env: &Env, who: &Address, by: &Address) {
    if storage::read_pending_liquidator(env, who).is_some() {
        storage::remove_pending_liquidator(env, who);
        events::LiquidatorProposalCancelled {
            who: who.clone(),
            by: by.clone(),
        }
        .publish(env);
    }
}

fn apply_asset(env: &Env, asset: Address, config: &AssetConfig) {
    storage::write_asset(env, &asset, config);
    events::AssetConfigured {
        asset,
        haircut_bps: config.haircut_bps,
        margin_trigger_bps: config.margin_trigger_bps,
        enabled: config.enabled,
        max_nav_age_secs: config.max_nav_age_secs,
        max_nav_move_bps: config.max_nav_move_bps,
        nav_floor: config.nav_floor,
        nav_ceiling: config.nav_ceiling,
        max_open_debt: config.max_open_debt,
        band_settle_secs: config.band_settle_secs,
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

/// A proposal executes from `eta` through `eta + timelock_secs` inclusive,
/// so a queued loosening cannot sit unused and fire long after the change
/// was announced (issue #41). Expiry is derived, not stored: `PendingAsset`
/// / `PendingPause` and `Config` keep their shape.
fn check_window(env: &Env, protocol: &Config, eta: u64) -> Result<(), Error> {
    let now = env.ledger().timestamp();
    if now < eta {
        return Err(Error::TimelockNotDone);
    }
    if now > eta.saturating_add(protocol.timelock_secs) {
        return Err(Error::ProposalExpired);
    }
    Ok(())
}

/// `caller` signs and holds a role; returns the config it was checked on.
fn admin_or_guardian(env: &Env, caller: &Address) -> Result<Config, Error> {
    caller.require_auth();
    let protocol = storage::read_config(env);
    if *caller != protocol.admin && *caller != protocol.guardian {
        return Err(Error::NotAdminOrGuardian);
    }
    Ok(protocol)
}

/// Shortest accepted `timelock_secs` in the default (demo/testnet) build: a
/// loosening must stay visible on-chain for at least a minute before it can
/// execute (#33).
#[allow(dead_code)]
pub(crate) const DEMO_MIN_TIMELOCK_SECS: u64 = 60;
/// Shortest accepted `timelock_secs` in the `production` build (Raven R12,
/// UA-07): one day, so a mainnet contract cannot be deployed with the 120 s
/// demo timelock. Production runs 172,800 s (DECISIONS #33).
#[allow(dead_code)]
pub(crate) const PRODUCTION_MIN_TIMELOCK_SECS: u64 = 86_400;
#[cfg(not(feature = "production"))]
pub(crate) const MIN_TIMELOCK_SECS: u64 = DEMO_MIN_TIMELOCK_SECS;
#[cfg(feature = "production")]
pub(crate) const MIN_TIMELOCK_SECS: u64 = PRODUCTION_MIN_TIMELOCK_SECS;

fn validate_config(config: &Config) -> Result<(), Error> {
    let bps = math::BPS as u32;
    if config.fee_bps >= bps
        || config.liquidation_discount_bps == 0
        || config.liquidation_discount_bps >= bps
        || config.day_secs == 0
        || config.timelock_secs < MIN_TIMELOCK_SECS
        // Raven OZ-05: the guardian is the second key (KPR-05); one key
        // holding both roles leaves no one to veto or tighten independently.
        || config.guardian == config.admin
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
