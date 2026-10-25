//! USDC payouts to third parties: try, else park as claimable.
//!
//! A frozen account (Circle blacklist, issuer `set_authorized(false)`) or a
//! closed trustline makes a USDC push to it fail. Pushed directly, that one
//! failure reverted the whole settlement, so a frozen lender trapped the
//! borrower's collateral and a frozen borrower or treasury blocked the
//! lender's payout. Every USDC leg the contract pays out of a settlement
//! (lender, treasury, borrower surplus) goes through `pay_or_park`: the payer's
//! USDC first lands in the contract, then each leg is pushed with
//! `try_transfer`; a failed leg stays in the contract as the recipient's
//! claimable balance, collected later with `claim`. Collateral legs stay push
//! (DECISIONS.md #24).

use soroban_sdk::{token, Address, Env};

use crate::{events, storage};

/// Pays `amount` USDC the contract already holds to `to`, or parks it as
/// `to`'s claimable balance if the transfer fails. Never fails itself.
pub fn pay_or_park(env: &Env, usdc: &token::Client, to: &Address, amount: i128, repo_id: u64) {
    if amount <= 0 {
        return;
    }
    let this = env.current_contract_address();
    if matches!(usdc.try_transfer(&this, to, &amount), Ok(Ok(()))) {
        return;
    }
    storage::add_claimable(env, to, amount);
    events::PayoutParked {
        repo_id,
        to: to.clone(),
        amount,
    }
    .publish(env);
}
