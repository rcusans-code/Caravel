#![no_std]

//! Caravel: fixed-term, fixed-rate USDC repo against tokenized Treasuries.
//!
//! State machine: Open → MarginCall → Open (top-up) | Repaid | Defaulted → Liquidated.

mod errors;
mod events;
pub mod math;
#[allow(dead_code)] // writers are wired up by the G1/G2 flows
mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, token, Address, Env};

pub use errors::Error;
pub use types::{Asset, AssetConfig, Config, Offer, Repo, Status};

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

    // --- admin ------------------------------------------------------------

    pub fn set_liquidator(env: Env, liquidator: Address, allowed: bool) {
        storage::read_config(&env).admin.require_auth();
        storage::extend_instance(&env);
        storage::set_liquidator(&env, &liquidator, allowed);
    }

    /// Adds or re-tiers a collateral asset (DECISIONS.md #13). Requires
    /// `liquidation_discount_bps < haircut_bps < 10_000`: a strictly larger
    /// haircut means a take at max LTV opens strictly below the margin trigger.
    pub fn set_asset(env: Env, asset: Address, config: AssetConfig) -> Result<(), Error> {
        let protocol = storage::read_config(&env);
        protocol.admin.require_auth();
        if config.haircut_bps <= protocol.liquidation_discount_bps
            || config.haircut_bps as i128 >= math::BPS
        {
            return Err(Error::InvalidConfig);
        }
        storage::extend_instance(&env);
        storage::write_asset(&env, &asset, &config);
        events::AssetConfigured {
            asset,
            haircut_bps: config.haircut_bps,
            enabled: config.enabled,
        }
        .publish(&env);
        Ok(())
    }

    // --- lender -----------------------------------------------------------

    /// Escrows `principal` USDC from the lender. Returns the offer id.
    /// The haircut comes from the asset's `AssetConfig`, not the lender.
    /// Rejects a missing or disabled asset with `AssetNotSupported` (#22).
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
    /// simulate and submit the tx fails instead of overcharging.
    pub fn take_offer(_env: Env, _borrower: Address, _offer_id: u64) -> Result<u64, Error> {
        Err(Error::NotImplemented)
    }

    /// Pays principal + interest; collateral back. Works with stale NAV.
    pub fn repay(_env: Env, _repo_id: u64) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }

    /// Adds collateral. Clears a margin call once
    /// `ltv_ok(debt, collateral, nav, dec, repo.haircut_bps)` holds, i.e. the
    /// initial margin is restored (TradFi convention). Works with stale NAV.
    pub fn top_up(_env: Env, _repo_id: u64, _amount: i128) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }

    // --- keeper (anyone) --------------------------------------------------

    /// Sets `margin_call_deadline` on the first `margin_breached`. Returns the
    /// status. Stale NAV returns `StaleNav` (DECISIONS.md #17).
    pub fn check_margin(_env: Env, _repo_id: u64) -> Result<Status, Error> {
        Err(Error::NotImplemented)
    }

    /// Moves a repo past maturity + grace, or past its margin deadline, to
    /// Defaulted. Needs no NAV (DECISIONS.md #17).
    pub fn default(_env: Env, _repo_id: u64) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }

    // --- liquidator (whitelisted) -----------------------------------------

    /// Liquidator pays NAV × (1 − discount) and receives the collateral.
    /// Stale NAV returns `StaleNav`.
    pub fn liquidate(_env: Env, _liquidator: Address, _repo_id: u64) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }
}

fn validate_config(config: &Config) -> Result<(), Error> {
    let bps = math::BPS as u32;
    if config.fee_bps > bps
        || config.liquidation_discount_bps >= bps
        || config.day_secs == 0
        || config.max_nav_age_secs == 0
    {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}
