//! Margin calls: `check_margin` (anyone, keeper) and `top_up` (borrower).
//!
//! - Trigger (DECISIONS.md #14): `debt > collateral × NAV × (1 − liq_discount)`.
//! - `check_margin` needs a fresh NAV (#17). The first breach sets
//!   `margin_call_deadline = now + margin_window_secs` and moves the repo to
//!   `MarginCall`; later checks never move the deadline or re-emit.
//!   A margin call is never cleared by NAV recovering, only by a top-up (#20).
//! - `top_up` never needs a fresh NAV (#6). It clears a margin call only once
//!   the initial margin holds again: `ltv_ok` at the repo's snapshotted
//!   haircut (#19, #20). The clear decision uses the last known NAV, stale or
//!   not; if there is no price at all the collateral is still accepted and the
//!   call stays open.

use soroban_sdk::{token, Env};

use crate::{errors::Error, events, math, oracle, storage, types::Status};

/// Returns the repo's status after the check.
///
/// Settled repos (`Repaid`, `Defaulted`, `Liquidated`) return their status
/// unchanged without reading NAV, so a keeper can poll any id. Live repos
/// (`Open`, `MarginCall`) need a fresh NAV, else `StaleNav`.
pub fn check_margin(env: &Env, repo_id: u64) -> Result<Status, Error> {
    let mut repo = storage::read_repo(env, repo_id).ok_or(Error::RepoNotFound)?;
    if !matches!(repo.status, Status::Open | Status::MarginCall) {
        return Ok(repo.status);
    }
    // A disabled asset still margins; only new offers are blocked (#22).
    let asset = storage::read_asset(env, &repo.collateral_asset).ok_or(Error::AssetNotSupported)?;
    let config = storage::read_config(env);
    let (nav, nav_decimals) = oracle::fresh_nav(env, &config, &asset)?;
    storage::extend_instance(env);

    // Already called: keep the first deadline, no second event.
    if repo.status == Status::MarginCall {
        return Ok(repo.status);
    }

    let debt = math::debt(repo.principal, repo.interest)?;
    if !math::margin_breached(
        debt,
        repo.collateral_amount,
        nav,
        nav_decimals,
        config.liquidation_discount_bps,
    )? {
        return Ok(repo.status);
    }

    let deadline = env
        .ledger()
        .timestamp()
        .checked_add(config.margin_window_secs)
        .ok_or(Error::MathOverflow)?;
    repo.status = Status::MarginCall;
    repo.margin_call_deadline = Some(deadline);
    storage::write_repo(env, &repo);

    events::MarginCall { repo_id, deadline }.publish(env);
    Ok(repo.status)
}

/// Moves `amount` collateral from the borrower into the contract. From
/// `MarginCall`, returns the repo to `Open` (deadline cleared) once
/// `ltv_ok(debt, collateral, nav, dec, repo.haircut_bps)` holds.
pub fn top_up(env: &Env, repo_id: u64, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    let mut repo = storage::read_repo(env, repo_id).ok_or(Error::RepoNotFound)?;
    if !matches!(repo.status, Status::Open | Status::MarginCall) {
        return Err(Error::InvalidStatus);
    }
    repo.borrower.require_auth();

    repo.collateral_amount = repo
        .collateral_amount
        .checked_add(amount)
        .ok_or(Error::MathOverflow)?;

    let cleared = repo.status == Status::MarginCall && initial_margin_restored(env, &repo)?;
    if cleared {
        repo.status = Status::Open;
        repo.margin_call_deadline = None;
    }
    storage::write_repo(env, &repo);
    storage::extend_instance(env);

    token::Client::new(env, &repo.collateral_asset).transfer(
        &repo.borrower,
        env.current_contract_address(),
        &amount,
    );

    events::ToppedUp {
        repo_id,
        amount,
        collateral_amount: repo.collateral_amount,
        cleared,
    }
    .publish(env);
    Ok(())
}

/// `ltv_ok` at the snapshotted haircut, on the last known NAV (no staleness
/// check, #6). No price (or no asset config) means "cannot tell": not cleared,
/// but the top-up itself still goes through.
fn initial_margin_restored(env: &Env, repo: &crate::types::Repo) -> Result<bool, Error> {
    let Some(asset) = storage::read_asset(env, &repo.collateral_asset) else {
        return Ok(false);
    };
    let config = storage::read_config(env);
    let Ok((nav, nav_decimals, _)) = oracle::nav(env, &config, &asset) else {
        return Ok(false);
    };
    let debt = math::debt(repo.principal, repo.interest)?;
    math::ltv_ok(
        debt,
        repo.collateral_amount,
        nav,
        nav_decimals,
        repo.haircut_bps,
    )
}
