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

/// `Ok(clock_start)` once `now > clock_start + max_nav_age_secs +
/// NAV_OUTAGE_DAYS × day_secs`, else `NoNavOutage`. Reads the price only,
/// never the band.
///
/// `clock_start` is the latest NAV's timestamp when the feed gives a usable
/// one. When it does not, it is `fallback_start` (the caller passes the
/// repo's `maturity_ts + grace_secs`): a feed with no price (or a price
/// `<= 0`), or a price dated more than [`oracle::MAX_FUTURE_SKEW_SECS`]
/// ahead, which `fresh_nav` rejects as `NoPrice` for ever (the real oracle
/// keeps history sorted, so a future-dated record stays `lastprice`). A
/// price up to the skew ahead counts as fresh, as in `fresh_nav`.
pub fn nav_outage(
    env: &Env,
    cfg: &Config,
    asset: &AssetConfig,
    fallback_start: u64,
) -> Result<u64, Error> {
    let now = env.ledger().timestamp();
    let clock_start = match oracle::nav(env, cfg, asset) {
        Ok((_, _, timestamp)) if timestamp <= now.saturating_add(oracle::MAX_FUTURE_SKEW_SECS) => {
            timestamp
        }
        Ok(_) | Err(Error::NoPrice) => fallback_start,
        Err(e) => return Err(e),
    };
    let opens_after = clock_start
        .saturating_add(asset.max_nav_age_secs)
        .saturating_add(NAV_OUTAGE_DAYS.saturating_mul(cfg.day_secs));
    if now <= opens_after {
        return Err(Error::NoNavOutage);
    }
    Ok(clock_start)
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
