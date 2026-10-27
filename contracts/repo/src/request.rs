//! Borrow requests: the borrower-side mirror of offers.
//!
//! A borrower posts "lend me X USDC for T at Y% APR" and escrows its fund
//! tokens (`create_request`); a lender fills it (`fill_request`) in one
//! atomic DvP, the same way `take_offer` works with the roles swapped.
//!
//! - Posting needs no NAV: the collateral is checked against the asset's
//!   haircut at a fresh, in-band NAV when a lender fills (#6, #31). If the
//!   NAV has fallen so the escrow no longer covers `required_collateral`,
//!   the fill fails with `InsufficientCollateral` and the request stays
//!   posted; the borrower can cancel and repost.
//! - All escrowed collateral becomes the repo's collateral, cushion
//!   included: the borrower chose the amount (fewer margin calls).
//! - The repo opens with `auto_repay = false`; the borrower can turn it on
//!   with `set_auto_repay`. From then on it is an ordinary repo.
//! - `cancel_request` is never paused: an exit is never blocked (#30).

use soroban_sdk::{token, Address, Env};

use crate::{
    errors::Error,
    events, math, new_repos_allowed, oracle, payout, storage,
    types::{BorrowRequest, Repo, Status},
};

pub fn create(
    env: &Env,
    borrower: Address,
    collateral_asset: Address,
    collateral_amount: i128,
    principal: i128,
    apr_bps: u32,
    term_secs: u64,
) -> Result<u64, Error> {
    borrower.require_auth();
    if collateral_amount <= 0 || principal <= 0 || term_secs == 0 {
        return Err(Error::InvalidAmount);
    }
    match storage::read_asset(env, &collateral_asset) {
        Some(asset) if asset.enabled => {}
        _ => return Err(Error::AssetNotSupported),
    }
    new_repos_allowed(env, &collateral_asset)?;
    let config = storage::read_config(env);
    // Fail now, not at fill time, if the terms overflow the debt math.
    let interest = math::interest(principal, apr_bps, term_secs, config.day_secs)?;
    math::debt(principal, interest)?;

    let request = BorrowRequest {
        id: storage::next_request_id(env),
        borrower,
        collateral_asset,
        collateral_amount,
        principal,
        apr_bps,
        term_secs,
        created_at: env.ledger().timestamp(),
    };
    storage::write_request(env, &request);
    storage::extend_instance(env);

    token::Client::new(env, &request.collateral_asset).transfer(
        &request.borrower,
        env.current_contract_address(),
        &collateral_amount,
    );

    events::RequestCreated {
        request_id: request.id,
        borrower: request.borrower,
        collateral_asset: request.collateral_asset,
        collateral_amount,
        principal,
        apr_bps,
        term_secs,
    }
    .publish(env);
    Ok(request.id)
}

pub fn cancel(env: &Env, request_id: u64) -> Result<(), Error> {
    let request = storage::read_request(env, request_id).ok_or(Error::RequestNotFound)?;
    request.borrower.require_auth();

    storage::remove_request(env, request_id);
    storage::extend_instance(env);

    token::Client::new(env, &request.collateral_asset).transfer(
        &env.current_contract_address(),
        &request.borrower,
        &request.collateral_amount,
    );

    events::RequestCancelled {
        request_id,
        borrower: request.borrower,
        collateral_amount: request.collateral_amount,
    }
    .publish(env);
    Ok(())
}

pub fn fill(env: &Env, lender: Address, request_id: u64) -> Result<u64, Error> {
    lender.require_auth();
    let request = storage::read_request(env, request_id).ok_or(Error::RequestNotFound)?;
    let config = storage::read_config(env);
    // Raven AS-03 mirror: a frozen USDC account on either side cannot make
    // the payment leg; say so instead of failing inside the token.
    if !payout::usdc_authorized(env, &config.usdc, &lender)
        || !payout::usdc_authorized(env, &config.usdc, &request.borrower)
    {
        return Err(Error::UsdcFrozen);
    }
    let asset = match storage::read_asset(env, &request.collateral_asset) {
        Some(asset) if asset.enabled => asset,
        _ => return Err(Error::AssetNotSupported),
    };
    new_repos_allowed(env, &request.collateral_asset)?;
    let (nav, nav_decimals) =
        oracle::fresh_collateral_nav(env, &config, &request.collateral_asset, &asset)?;

    let interest = math::interest(
        request.principal,
        request.apr_bps,
        request.term_secs,
        config.day_secs,
    )?;
    let debt = math::debt(request.principal, interest)?;
    // Initial LTV gate (#14) at the current haircut: the escrow must cover
    // what `take_offer` would charge for the same debt.
    let required = math::required_collateral(debt, nav, nav_decimals, asset.haircut_bps)?;
    if request.collateral_amount < required
        || !math::ltv_ok(
            debt,
            request.collateral_amount,
            nav,
            nav_decimals,
            asset.haircut_bps,
        )?
    {
        return Err(Error::InsufficientCollateral);
    }
    // Exposure cap (#32), as in `take_offer`.
    let open_debt = storage::read_open_debt(env, &request.collateral_asset)
        .checked_add(debt)
        .ok_or(Error::MathOverflow)?;
    if open_debt > asset.max_open_debt {
        return Err(Error::CapExceeded);
    }

    let now = env.ledger().timestamp();
    let repo = Repo {
        id: storage::next_repo_id(env),
        offer_id: 0,
        lender,
        borrower: request.borrower,
        collateral_asset: request.collateral_asset,
        collateral_amount: request.collateral_amount,
        principal: request.principal,
        interest,
        haircut_bps: asset.haircut_bps,
        start_ts: now,
        maturity_ts: now
            .checked_add(request.term_secs)
            .ok_or(Error::MathOverflow)?,
        margin_call_deadline: None,
        status: Status::Open,
        auto_repay: false,
        request_id: Some(request_id),
    };
    // Gone once filled: no double fill, no cancel after fill.
    storage::remove_request(env, request_id);
    storage::write_repo(env, &repo);
    storage::write_open_debt(env, &repo.collateral_asset, open_debt);
    storage::extend_instance(env);

    // The collateral is already in the contract; the payment leg is the
    // lender's USDC straight to the borrower.
    token::Client::new(env, &config.usdc).transfer(&repo.lender, &repo.borrower, &repo.principal);

    events::RepoOpened {
        repo_id: repo.id,
        offer_id: 0,
        lender: repo.lender.clone(),
        borrower: repo.borrower.clone(),
        collateral_asset: repo.collateral_asset,
        collateral_amount: repo.collateral_amount,
        principal: repo.principal,
        interest,
        haircut_bps: repo.haircut_bps,
        maturity_ts: repo.maturity_ts,
        auto_repay: false,
    }
    .publish(env);
    events::RequestFilled {
        request_id,
        repo_id: repo.id,
        lender: repo.lender,
        borrower: repo.borrower,
    }
    .publish(env);
    Ok(repo.id)
}
