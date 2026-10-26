//! NAV outage fallback (nav-review side 3): when the feed stops, `liquidate`
//! stays blocked on the stale NAV (DECISIONS.md Open item, kept as proposed),
//! so a Defaulted repo had no lender exit. Once the NAV has been stale for
//! more than [`NAV_OUTAGE_DAYS`] days the lender may take the collateral in
//! kind with `claim_in_kind`. A collateral push the token refuses
//! (permissioned token, frozen trustline) is parked for `claim_collateral`,
//! the in-kind twin of the USDC `pay_or_park` (payout.rs).

use soroban_sdk::{token, Address, Env};

use crate::{
    errors::Error,
    oracle, storage,
    types::{AssetConfig, Config},
};

/// Days (`Config.day_secs` each: 86_400 in production, 60 in the demo) a NAV
/// must have been stale before the lender may claim in kind. Counted from
/// the moment the NAV went stale (`timestamp + max_nav_age_secs`): with the
/// production 96 h age, the fallback opens 11 days after the last print.
pub const NAV_OUTAGE_DAYS: u64 = 7;

/// `Ok(nav_timestamp)` once the asset's latest NAV is older than
/// `max_nav_age_secs + NAV_OUTAGE_DAYS × day_secs`. A stale-but-not-yet
/// long enough or fresh NAV is `NoNavOutage`. A feed with no price (or a
/// price `<= 0`) is `NoPrice`: there is no timestamp to start the clock from.
/// A future-dated price counts as fresh. Reads the price only, never the band.
pub fn nav_outage(env: &Env, cfg: &Config, asset: &AssetConfig) -> Result<u64, Error> {
    let (_, _, timestamp) = oracle::nav(env, cfg, asset)?;
    let opens_after = timestamp
        .saturating_add(asset.max_nav_age_secs)
        .saturating_add(NAV_OUTAGE_DAYS.saturating_mul(cfg.day_secs));
    if env.ledger().timestamp() <= opens_after {
        return Err(Error::NoNavOutage);
    }
    Ok(timestamp)
}

/// Pushes `amount` of collateral `asset` the contract holds to `to`, or
/// parks it as `to`'s claimable collateral if the token refuses. Returns
/// `true` if pushed. Never fails itself.
pub fn push_or_park(env: &Env, asset: &Address, to: &Address, amount: i128) -> bool {
    if amount <= 0 {
        return true;
    }
    let this = env.current_contract_address();
    if matches!(
        token::Client::new(env, asset).try_transfer(&this, to, &amount),
        Ok(Ok(()))
    ) {
        return true;
    }
    storage::add_claimable_collateral(env, to, asset, amount);
    false
}
