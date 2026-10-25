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

use soroban_sdk::{contract, contractimpl, Address, Env};

pub use errors::Error;
pub use types::{Config, Offer, Repo, Status};

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

    // --- admin ------------------------------------------------------------

    pub fn set_liquidator(env: Env, liquidator: Address, allowed: bool) {
        storage::read_config(&env).admin.require_auth();
        storage::extend_instance(&env);
        storage::set_liquidator(&env, &liquidator, allowed);
    }

    // --- lender -----------------------------------------------------------

    /// Escrows `principal` USDC from the lender. Returns the offer id.
    pub fn create_offer(
        _env: Env,
        _lender: Address,
        _collateral_asset: Address,
        _principal: i128,
        _apr_bps: u32,
        _haircut_bps: u32,
        _term_secs: u64,
    ) -> Result<u64, Error> {
        Err(Error::NotImplemented)
    }

    /// Returns the escrowed USDC to the lender.
    pub fn cancel_offer(_env: Env, _offer_id: u64) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }

    // --- borrower ---------------------------------------------------------

    /// Atomic DvP: collateral in, escrowed USDC out. Returns the repo id.
    pub fn take_offer(
        _env: Env,
        _borrower: Address,
        _offer_id: u64,
        _collateral_amount: i128,
    ) -> Result<u64, Error> {
        Err(Error::NotImplemented)
    }

    /// Pays principal + interest; collateral back. Works with stale NAV.
    pub fn repay(_env: Env, _repo_id: u64) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }

    /// Adds collateral; clears a margin call once healthy. Works with stale NAV.
    pub fn top_up(_env: Env, _repo_id: u64, _amount: i128) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }

    // --- keeper (anyone) --------------------------------------------------

    /// Sets `margin_call_deadline` on the first breach. Returns the status.
    pub fn check_margin(_env: Env, _repo_id: u64) -> Result<Status, Error> {
        Err(Error::NotImplemented)
    }

    /// Moves a repo past maturity + grace, or past its margin deadline, to Defaulted.
    pub fn default(_env: Env, _repo_id: u64) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }

    // --- liquidator (whitelisted) -----------------------------------------

    /// Liquidator pays NAV × (1 − discount) and receives the collateral.
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
