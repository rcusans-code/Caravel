//! Auto-repay (DECISIONS.md #27): a borrower who forgets to press Repay is not
//! defaulted as long as the USDC is in their wallet.
//!
//! - Opt in at `take_offer(.., auto_repay = true)` or later with
//!   `set_auto_repay`. Either way the borrower signs a USDC (SAC) allowance to
//!   this contract for the debt; it never covers collateral, so it works with
//!   collateral tokens that have no `approve` at all.
//! - From maturity anyone (in practice the keeper) can call `auto_repay`, and
//!   `default` tries it first, so nobody can default an opted-in borrower who
//!   holds the debt, not even by racing the keeper.
//! - The debt is pulled in one `transfer_from` into the contract and paid out
//!   from there, so a failed pull (short balance, allowance expired, frozen
//!   trustline) moves nothing and the repo stays live: it defaults as before.
//!
//! One SAC allowance per borrower covers all their opted-in repos: it is sized
//! to the sum of their debts, and its expiry is the latest any of them needs.
//! The contract pulls exactly one repo's debt per settlement. An allowance left
//! over after a default lapses on its own and is never spent.

use soroban_sdk::{token, Address, Env};

use crate::{
    errors::Error,
    events, math, storage,
    types::{Config, Repo, Status},
};

/// Ledgers close every ~5-6 s; counting 4 s keeps the estimate on the long side.
const MIN_LEDGER_SECS: u64 = 4;
/// Allowance outlives maturity + grace by ~1 day, so a late `default` still
/// finds it.
const AFTER_GRACE_LEDGERS: u32 = 17_280;
/// The borrower signs the exact `approve` arguments at simulation, and the tx
/// lands a few ledgers later. Rounding the expiry up to a bucket keeps it the
/// same across that gap; it only shifts when a bucket boundary falls in
/// between (~0.1% of takes), and then the tx fails and is re-simulated, like
/// a NAV move (#21). 4,096 ledgers ≈ 5.7 h.
const EXPIRY_BUCKET: u32 = 4_096;

/// Moves the borrower's allowance to this contract by `delta` (≥ 0 when opting
/// in, < 0 when a repo no longer needs it). The SAC requires the borrower's auth.
/// `needed_until_ts` is the last second this repo may be auto-repaid (maturity
/// plus grace); the expiry is only ever pushed out, never pulled in, so other
/// opted-in repos keep their cover.
pub fn adjust_allowance(
    env: &Env,
    usdc: &Address,
    borrower: &Address,
    delta: i128,
    needed_until_ts: u64,
) -> Result<(), Error> {
    let this = env.current_contract_address();
    let usdc = token::Client::new(env, usdc);
    let amount = usdc
        .allowance(borrower, &this)
        .checked_add(delta)
        .ok_or(Error::MathOverflow)?
        .max(0);

    let seq = env.ledger().sequence();
    let mut live_until = storage::read_allowance_until(env, borrower)
        .filter(|ledger| *ledger >= seq)
        .unwrap_or(seq);
    if delta > 0 {
        let secs = needed_until_ts.saturating_sub(env.ledger().timestamp());
        live_until = live_until.max(expiry(seq, secs, env.storage().max_ttl()));
    }

    usdc.approve(borrower, &this, &amount, &live_until);
    if amount > 0 {
        storage::write_allowance_until(env, borrower, live_until);
    } else {
        storage::remove_allowance_until(env, borrower);
    }
    Ok(())
}

/// Last ledger an allowance needed `secs` from now must live to: the estimate
/// plus a day, rounded up to a bucket, capped (rounded down) at the longest
/// expiry the network accepts.
pub fn expiry(seq: u32, secs: u64, max_ttl: u32) -> u32 {
    let ledgers = u32::try_from(secs / MIN_LEDGER_SECS + 1).unwrap_or(u32::MAX);
    let want = seq
        .saturating_add(ledgers)
        .saturating_add(AFTER_GRACE_LEDGERS)
        .div_ceil(EXPIRY_BUCKET)
        .saturating_mul(EXPIRY_BUCKET);
    let max = seq.saturating_add(max_ttl.saturating_sub(1));
    let max_bucketed = max / EXPIRY_BUCKET * EXPIRY_BUCKET;
    want.min(if max_bucketed >= seq {
        max_bucketed
    } else {
        max
    })
}

/// True from maturity, or once a margin call's deadline has passed: the two
/// points where the alternative is a default.
pub fn due(repo: &Repo, now: u64) -> bool {
    now >= repo.maturity_ts || margin_missed(repo, now)
}

pub fn margin_missed(repo: &Repo, now: u64) -> bool {
    repo.status == Status::MarginCall
        && repo
            .margin_call_deadline
            .is_some_and(|deadline| now > deadline)
}

/// Pulls the debt from the borrower and settles the repo as `Repaid`, exactly
/// like `repay`. Returns `false`, having moved nothing, if the pull fails.
pub fn try_settle(env: &Env, repo: &mut Repo, config: &Config) -> Result<bool, Error> {
    let debt = math::debt(repo.principal, repo.interest)?;
    let split = math::waterfall(debt, repo.principal, repo.interest, config.fee_bps)?;
    let this = env.current_contract_address();
    let usdc = token::Client::new(env, &config.usdc);

    if !matches!(
        usdc.try_transfer_from(&this, &repo.borrower, &this, &debt),
        Ok(Ok(()))
    ) {
        return Ok(false);
    }

    repo.status = Status::Repaid;
    storage::write_repo(env, repo);
    storage::release_open_debt(env, &repo.collateral_asset, debt);
    storage::extend_instance(env);

    usdc.transfer(&this, &repo.lender, &split.lender);
    if split.fee > 0 {
        usdc.transfer(&this, &config.treasury, &split.fee);
    }
    token::Client::new(env, &repo.collateral_asset).transfer(
        &this,
        &repo.borrower,
        &repo.collateral_amount,
    );

    events::Repaid {
        repo_id: repo.id,
        lender_amount: split.lender,
        fee: split.fee,
        automatic: true,
    }
    .publish(env);
    Ok(true)
}
