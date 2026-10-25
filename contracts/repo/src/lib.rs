#![no_std]

//! Caravel: fixed-term, fixed-rate USDC repo against tokenized Treasuries.
//!
//! State machine: Open → MarginCall → Open (top-up) | Repaid | Defaulted → Liquidated.

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
mod test_spiko;

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
    /// simulate and submit the tx fails instead of overcharging (#21).
    ///
    /// Rejects stale NAV (#6) and an asset disabled since the offer was
    /// posted (#23). The haircut is snapshotted on the repo (#19).
    pub fn take_offer(env: Env, borrower: Address, offer_id: u64) -> Result<u64, Error> {
        borrower.require_auth();
        let offer = storage::read_offer(&env, offer_id).ok_or(Error::OfferNotFound)?;
        let asset = match storage::read_asset(&env, &offer.collateral_asset) {
            Some(asset) if asset.enabled => asset,
            _ => return Err(Error::AssetNotSupported),
        };
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
        };
        // The offer is gone once taken: no double take, no cancel after take.
        storage::remove_offer(&env, offer_id);
        storage::write_repo(&env, &repo);
        storage::extend_instance(&env);

        let this = env.current_contract_address();
        token::Client::new(&env, &repo.collateral_asset).transfer(
            &repo.borrower,
            &this,
            &collateral,
        );
        token::Client::new(&env, &config.usdc).transfer(&this, &repo.borrower, &repo.principal);

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
        }
        .publish(&env);
        Ok(repo.id)
    }

    /// Borrower pays principal + full-term interest and gets the collateral
    /// back. The lender receives exactly `principal + interest − fee`, the
    /// treasury the fee (#3). Works from `Open` or `MarginCall`, before or
    /// after maturity until someone calls `default`, and needs no NAV (#6).
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

        events::Repaid {
            repo_id,
            lender_amount: split.lender,
            fee: split.fee,
        }
        .publish(&env);
        Ok(())
    }

    /// Adds collateral. Clears a margin call once
    /// `ltv_ok(debt, collateral, nav, dec, repo.haircut_bps)` holds, i.e. the
    /// initial margin is restored (TradFi convention). Works with stale NAV.
    pub fn top_up(env: Env, repo_id: u64, amount: i128) -> Result<(), Error> {
        margin::top_up(&env, repo_id, amount)
    }

    // --- keeper (anyone) --------------------------------------------------

    /// Sets `margin_call_deadline` on the first `margin_breached`. Returns the
    /// status. Stale NAV returns `StaleNav` (DECISIONS.md #17).
    pub fn check_margin(env: Env, repo_id: u64) -> Result<Status, Error> {
        margin::check_margin(&env, repo_id)
    }

    /// Moves a repo to `Defaulted` once it is past maturity + grace, or in
    /// `MarginCall` past its `margin_call_deadline` (set by `check_margin`).
    /// Anyone can call it (#7); it needs no NAV (#17). Both deadlines are
    /// strict: at the exact second the borrower can still repay or top up.
    pub fn default(env: Env, repo_id: u64) -> Result<(), Error> {
        let mut repo = storage::read_repo(&env, repo_id).ok_or(Error::RepoNotFound)?;
        if !matches!(repo.status, Status::Open | Status::MarginCall) {
            return Err(Error::InvalidStatus);
        }
        let config = storage::read_config(&env);
        let now = env.ledger().timestamp();
        let matured = now > repo.maturity_ts.saturating_add(config.grace_secs);
        let margin_missed = repo.status == Status::MarginCall
            && repo
                .margin_call_deadline
                .is_some_and(|deadline| now > deadline);
        if !matured && !margin_missed {
            return Err(Error::NotDefaultable);
        }

        repo.status = Status::Defaulted;
        storage::write_repo(&env, &repo);
        storage::extend_instance(&env);

        events::Defaulted { repo_id }.publish(&env);
        Ok(())
    }

    // --- liquidator (whitelisted) -----------------------------------------

    /// A whitelisted liquidator buys a defaulted repo's collateral at
    /// NAV × (1 − discount), rounded up. The USDC goes lender first (capped at
    /// principal + interest − fee), then the fee, then the borrower (#3, #4).
    /// If proceeds fall short of what the lender is owed, the lender takes
    /// everything and `Shortfall` is emitted. Stale NAV returns `StaleNav` (#6).
    pub fn liquidate(env: Env, liquidator: Address, repo_id: u64) -> Result<(), Error> {
        liquidator.require_auth();
        if !storage::is_liquidator(&env, &liquidator) {
            return Err(Error::NotLiquidator);
        }
        let mut repo = storage::read_repo(&env, repo_id).ok_or(Error::RepoNotFound)?;
        if repo.status != Status::Defaulted {
            return Err(Error::InvalidStatus);
        }
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
