//! All repo arithmetic, in one place (DECISIONS.md #8).
//!
//! Units: USDC amounts and collateral values are i128 in 7-decimal Stellar
//! units. Collateral amounts are in the token's own units; NAV is USDC per
//! whole collateral token, and `nav_decimals` is the oracle's `decimals()`
//! with the token's decimals folded in by `oracle::scale_for_token`
//! (DECISIONS.md #8, #28), so `amount × nav / 10^nav_decimals` is 7-decimal
//! USDC for any token.
//!
//! Rounding always favours the lender / protocol:
//! - interest rounds up
//! - collateral value, and that value after a haircut or discount, round down
//! - required collateral rounds up
//! - liquidation proceeds (what the liquidator pays) round up
//! - protocol fee rounds down (lender keeps the dust)

use crate::errors::Error;

pub const BPS: i128 = 10_000;
pub const DAYS_PER_YEAR: i128 = 365;

fn mul_div_floor(a: i128, b: i128, d: i128) -> Result<i128, Error> {
    a.checked_mul(b)
        .and_then(|n| n.checked_div(d))
        .ok_or(Error::MathOverflow)
}

fn mul_div_ceil(a: i128, b: i128, d: i128) -> Result<i128, Error> {
    let n = a.checked_mul(b).ok_or(Error::MathOverflow)?;
    let q = n.checked_div(d).ok_or(Error::MathOverflow)?;
    Ok(if n % d != 0 { q + 1 } else { q })
}

fn pow10(decimals: u32) -> Result<i128, Error> {
    10i128.checked_pow(decimals).ok_or(Error::MathOverflow)
}

fn non_negative(x: i128) -> Result<i128, Error> {
    if x < 0 {
        Err(Error::InvalidAmount)
    } else {
        Ok(x)
    }
}

/// `BPS − bps`, the share of value kept after a haircut or discount.
fn bps_factor(bps: u32) -> Result<i128, Error> {
    let b = bps as i128;
    if b >= BPS {
        return Err(Error::InvalidAmount);
    }
    Ok(BPS - b)
}

/// `value × (1 − bps)`. Rounds down.
fn apply_bps(value: i128, bps: u32) -> Result<i128, Error> {
    non_negative(value)?;
    mul_div_floor(value, bps_factor(bps)?, BPS)
}

/// Simple interest for the whole term, fixed at take time. Rounds up.
///
/// `interest = principal × apr × term / (365 × day)`, where `day_secs` is the
/// configured day length so time-compressed demos still accrue a real
/// 7-day coupon over a 7-minute term.
pub fn interest(
    principal: i128,
    apr_bps: u32,
    term_secs: u64,
    day_secs: u64,
) -> Result<i128, Error> {
    non_negative(principal)?;
    if day_secs == 0 {
        return Err(Error::InvalidAmount);
    }
    let rate_time = (apr_bps as i128)
        .checked_mul(term_secs as i128)
        .ok_or(Error::MathOverflow)?;
    let year = BPS
        .checked_mul(DAYS_PER_YEAR)
        .and_then(|x| x.checked_mul(day_secs as i128))
        .ok_or(Error::MathOverflow)?;
    mul_div_ceil(principal, rate_time, year)
}

/// Protocol fee, carved out of interest (DECISIONS.md #3). Rounds down.
pub fn protocol_fee(interest: i128, fee_bps: u32) -> Result<i128, Error> {
    non_negative(interest)?;
    if fee_bps as i128 > BPS {
        return Err(Error::InvalidAmount);
    }
    mul_div_floor(interest, fee_bps as i128, BPS)
}

/// What the borrower owes: principal + full-term interest, fixed at take
/// time. Early repay pays the same amount (DECISIONS.md #15).
pub fn debt(principal: i128, interest: i128) -> Result<i128, Error> {
    non_negative(principal)?
        .checked_add(non_negative(interest)?)
        .ok_or(Error::MathOverflow)
}

/// USDC value of `amount` collateral at `nav`. Rounds down.
pub fn collateral_value(amount: i128, nav: i128, nav_decimals: u32) -> Result<i128, Error> {
    non_negative(amount)?;
    if nav <= 0 {
        return Err(Error::InvalidAmount);
    }
    mul_div_floor(amount, nav, pow10(nav_decimals)?)
}

/// Initial LTV check (DECISIONS.md #14): `debt ≤ value × (1 − haircut)`.
/// Used by `take_offer`, and by `top_up` with the repo's snapshotted haircut
/// to decide when a margin call clears.
pub fn ltv_ok(
    debt: i128,
    collateral_amount: i128,
    nav: i128,
    nav_decimals: u32,
    haircut_bps: u32,
) -> Result<bool, Error> {
    non_negative(debt)?;
    let value = collateral_value(collateral_amount, nav, nav_decimals)?;
    Ok(debt <= apply_bps(value, haircut_bps)?)
}

/// Margin trigger (DECISIONS.md #14, #26): `debt > value × (1 − trigger)`,
/// with the asset's `margin_trigger_bps`. Since discount ≤ trigger, up to the
/// trigger a liquidation at the discount still pays the lender in full; since
/// trigger < haircut, a take at max LTV opens below it.
pub fn margin_breached(
    debt: i128,
    collateral_amount: i128,
    nav: i128,
    nav_decimals: u32,
    margin_trigger_bps: u32,
) -> Result<bool, Error> {
    non_negative(debt)?;
    let value = collateral_value(collateral_amount, nav, nav_decimals)?;
    Ok(debt > apply_bps(value, margin_trigger_bps)?)
}

/// Smallest collateral amount with `debt ≤ value × (1 − bps)`. Rounds up.
///
/// With the asset haircut: the `take_offer` amount and the top-up target that
/// clears a margin call. With the margin trigger: the minimum that gets a
/// repo out of breach.
pub fn required_collateral(
    debt: i128,
    nav: i128,
    nav_decimals: u32,
    bps: u32,
) -> Result<i128, Error> {
    non_negative(debt)?;
    if nav <= 0 {
        return Err(Error::InvalidAmount);
    }
    let value_needed = mul_div_ceil(debt, BPS, bps_factor(bps)?)?;
    mul_div_ceil(value_needed, pow10(nav_decimals)?, nav)
}

/// What the liquidator pays for the collateral: NAV × (1 − discount). Rounds up.
pub fn liquidation_proceeds(
    collateral_amount: i128,
    nav: i128,
    nav_decimals: u32,
    discount_bps: u32,
) -> Result<i128, Error> {
    non_negative(collateral_amount)?;
    if nav <= 0 {
        return Err(Error::InvalidAmount);
    }
    let gross = collateral_amount
        .checked_mul(nav)
        .ok_or(Error::MathOverflow)?;
    let scale = pow10(nav_decimals)?
        .checked_mul(BPS)
        .ok_or(Error::MathOverflow)?;
    mul_div_ceil(gross, bps_factor(discount_bps)?, scale)
}

/// How an amount of USDC is split on repay or liquidation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Waterfall {
    /// To the lender. Never more than `principal + interest − fee`.
    pub lender: i128,
    /// To the treasury.
    pub fee: i128,
    /// Surplus back to the borrower.
    pub borrower: i128,
    /// What the lender is still owed. Non-zero means emit `Shortfall`.
    pub shortfall: i128,
}

/// Splits `available` USDC: lender first (capped at the offer terms), then
/// the protocol fee, then the borrower (DECISIONS.md #3, #4).
///
/// When proceeds fall short the lender takes everything up to what they are
/// owed, and the fee is waived before the lender loses a stroop.
pub fn waterfall(
    available: i128,
    principal: i128,
    interest: i128,
    fee_bps: u32,
) -> Result<Waterfall, Error> {
    non_negative(available)?;
    non_negative(principal)?;
    let fee_due = protocol_fee(interest, fee_bps)?;
    let lender_due = principal
        .checked_add(interest - fee_due)
        .ok_or(Error::MathOverflow)?;

    let lender = available.min(lender_due);
    let fee = (available - lender).min(fee_due);
    let borrower = available - lender - fee;
    Ok(Waterfall {
        lender,
        fee,
        borrower,
        shortfall: lender_due - lender,
    })
}

/// NAV is usable for `take_offer`, `check_margin` and `liquidate` if no older
/// than `max_age_secs` (DECISIONS.md #6, #17).
pub fn nav_is_fresh(now: u64, nav_timestamp: u64, max_age_secs: u64) -> bool {
    now.saturating_sub(nav_timestamp) <= max_age_secs
}

#[cfg(test)]
mod test {
    use super::*;

    const UNIT: i128 = 10_000_000; // 1.0 in 7-decimal units
    const NAV_DEC: u32 = 7;
    const DAY: u64 = 86_400;

    // The INTRO.md example: 970 USDC for 7 days at 5% APR against tBENJI at
    // NAV 1.00, 3% haircut, 2% liquidation discount. Fee = 10% of interest.
    const PRINCIPAL: i128 = 970 * UNIT;
    const COLLATERAL: i128 = 1_000 * UNIT;
    const APR_BPS: u32 = 500;
    const TERM: u64 = 7 * DAY;
    const HAIRCUT_BPS: u32 = 300;
    const DISCOUNT_BPS: u32 = 200;
    const FEE_BPS: u32 = 1_000;

    // 970 × 5% × 7/365 = 0.9301369863… → rounds up.
    const INTEREST: i128 = 9_301_370;
    const DEBT: i128 = PRINCIPAL + INTEREST; // 970.9301370
    const FEE: i128 = 930_137;
    const LENDER_DUE: i128 = DEBT - FEE; // 970.8371233
                                         // DEBT / (1.00 × 0.97), rounded up: 1000.9589042 tBENJI.
    const TAKE_COLLATERAL: i128 = 10_009_589_042;

    fn nav(x: f64) -> i128 {
        (x * UNIT as f64).round() as i128
    }

    fn breached(nav_price: i128) -> bool {
        margin_breached(DEBT, TAKE_COLLATERAL, nav_price, NAV_DEC, DISCOUNT_BPS).unwrap()
    }

    fn liquidate_at(nav_price: i128) -> (i128, Waterfall) {
        let proceeds =
            liquidation_proceeds(TAKE_COLLATERAL, nav_price, NAV_DEC, DISCOUNT_BPS).unwrap();
        (
            proceeds,
            waterfall(proceeds, PRINCIPAL, INTEREST, FEE_BPS).unwrap(),
        )
    }

    // --- interest and debt ------------------------------------------------

    #[test]
    fn interest_rounds_up() {
        assert_eq!(interest(PRINCIPAL, APR_BPS, TERM, DAY), Ok(INTEREST));
        assert_eq!(interest(1, 1, 1, DAY), Ok(1));
        assert_eq!(interest(0, APR_BPS, TERM, DAY), Ok(0));
    }

    #[test]
    fn interest_exact_needs_no_rounding() {
        // 365 USDC at 10% for 365 days = 36.5 USDC
        assert_eq!(
            interest(365 * UNIT, 1_000, 365 * DAY, DAY),
            Ok(365 * UNIT / 10)
        );
    }

    #[test]
    fn interest_is_invariant_under_time_compression() {
        // Demo profile: 1 day = 60 s, so a 7-day term is 7 minutes.
        let demo = interest(PRINCIPAL, APR_BPS, 7 * 60, 60).unwrap();
        assert_eq!(demo, INTEREST);
    }

    #[test]
    fn interest_rejects_bad_input() {
        assert_eq!(interest(-1, APR_BPS, TERM, DAY), Err(Error::InvalidAmount));
        assert_eq!(
            interest(PRINCIPAL, APR_BPS, TERM, 0),
            Err(Error::InvalidAmount)
        );
        assert_eq!(
            interest(i128::MAX, u32::MAX, u64::MAX, DAY),
            Err(Error::MathOverflow)
        );
    }

    #[test]
    fn debt_is_principal_plus_full_term_interest() {
        assert_eq!(debt(PRINCIPAL, INTEREST), Ok(9_709_301_370));
        assert_eq!(debt(i128::MAX, 1), Err(Error::MathOverflow));
        assert_eq!(debt(-1, INTEREST), Err(Error::InvalidAmount));
        assert_eq!(debt(PRINCIPAL, -1), Err(Error::InvalidAmount));
    }

    #[test]
    fn fee_comes_out_of_interest_and_rounds_down() {
        assert_eq!(protocol_fee(INTEREST, FEE_BPS), Ok(FEE));
        assert_eq!(protocol_fee(9, FEE_BPS), Ok(0));
        assert_eq!(protocol_fee(INTEREST, 0), Ok(0));
        assert_eq!(protocol_fee(INTEREST, 10_000), Ok(INTEREST));
        assert_eq!(protocol_fee(INTEREST, 10_001), Err(Error::InvalidAmount));
        assert_eq!(LENDER_DUE, 9_708_371_233);
    }

    // --- collateral value -------------------------------------------------

    #[test]
    fn collateral_value_rounds_down() {
        assert_eq!(
            collateral_value(COLLATERAL, nav(1.0), NAV_DEC),
            Ok(1_000 * UNIT)
        );
        assert_eq!(
            collateral_value(COLLATERAL, nav(0.99), NAV_DEC),
            Ok(990 * UNIT)
        );
        // 1 stroop × 0.9999999 → 0
        assert_eq!(collateral_value(1, UNIT - 1, NAV_DEC), Ok(0));
    }

    #[test]
    fn collateral_value_scales_with_oracle_decimals() {
        // Reflector feeds use 14 decimals; result must match the 7-decimal mock.
        let nav14 = 99_000_000_000_000; // 0.99
        assert_eq!(collateral_value(COLLATERAL, nav14, 14), Ok(990 * UNIT));
    }

    #[test]
    fn collateral_value_rejects_bad_nav() {
        assert_eq!(
            collateral_value(COLLATERAL, 0, NAV_DEC),
            Err(Error::InvalidAmount)
        );
        assert_eq!(
            collateral_value(COLLATERAL, -1, NAV_DEC),
            Err(Error::InvalidAmount)
        );
        assert_eq!(
            collateral_value(COLLATERAL, nav(1.0), 39),
            Err(Error::MathOverflow)
        );
    }

    #[test]
    fn apply_bps_rounds_down() {
        assert_eq!(apply_bps(1_000 * UNIT, HAIRCUT_BPS), Ok(PRINCIPAL));
        assert_eq!(apply_bps(1, HAIRCUT_BPS), Ok(0));
        assert_eq!(apply_bps(1_000 * UNIT, 0), Ok(1_000 * UNIT));
        assert_eq!(apply_bps(1_000 * UNIT, 10_000), Err(Error::InvalidAmount));
        assert_eq!(apply_bps(-1, HAIRCUT_BPS), Err(Error::InvalidAmount));
    }

    // --- take (initial LTV, #14 / #16) ------------------------------------

    #[test]
    fn take_posts_minimum_collateral_for_the_haircut() {
        assert_eq!(
            required_collateral(DEBT, nav(1.0), NAV_DEC, HAIRCUT_BPS),
            Ok(TAKE_COLLATERAL)
        );
        assert_eq!(
            ltv_ok(DEBT, TAKE_COLLATERAL, nav(1.0), NAV_DEC, HAIRCUT_BPS),
            Ok(true)
        );
        assert_eq!(
            ltv_ok(DEBT, TAKE_COLLATERAL - 1, nav(1.0), NAV_DEC, HAIRCUT_BPS),
            Ok(false)
        );
    }

    #[test]
    fn required_collateral_is_the_minimum_for_any_bps() {
        for (price, dec) in [
            (nav(0.99), NAV_DEC),
            (nav(1.0137), NAV_DEC),
            (99_123_456_789_012, 14),
        ] {
            let need = required_collateral(DEBT, price, dec, HAIRCUT_BPS).unwrap();
            assert_eq!(ltv_ok(DEBT, need, price, dec, HAIRCUT_BPS), Ok(true));
            assert_eq!(ltv_ok(DEBT, need - 1, price, dec, HAIRCUT_BPS), Ok(false));

            let need = required_collateral(DEBT, price, dec, DISCOUNT_BPS).unwrap();
            assert_eq!(
                margin_breached(DEBT, need, price, dec, DISCOUNT_BPS),
                Ok(false)
            );
            assert_eq!(
                margin_breached(DEBT, need - 1, price, dec, DISCOUNT_BPS),
                Ok(true)
            );
        }
    }

    // --- margin trigger (#14) ---------------------------------------------

    #[test]
    fn max_ltv_take_is_not_in_margin_call() {
        // The #14 fix: under the old rule one NAV tick after a max-LTV take
        // fired a margin call. The trigger now sits at the liquidation discount.
        assert!(!breached(nav(1.0)));
        assert!(!breached(nav(1.0) - 1));
    }

    #[test]
    fn margin_trigger_edge() {
        // At 0.9897960 the discounted value is 970.9302171 ≥ DEBT;
        // one tick lower it is 970.9301190 < DEBT.
        assert!(!breached(9_897_960));
        assert!(breached(9_897_959));
    }

    #[test]
    fn margin_call_top_up_amounts() {
        let price = 9_850_000; // NAV −1.5%
        assert!(breached(price));

        // Minimum to get out of breach.
        let clear = required_collateral(DEBT, price, NAV_DEC, DISCOUNT_BPS).unwrap();
        assert_eq!(clear, 10_058_325_257);
        assert_eq!(clear - TAKE_COLLATERAL, 48_736_215);
        assert_eq!(
            margin_breached(DEBT, clear, price, NAV_DEC, DISCOUNT_BPS),
            Ok(false)
        );

        // Top-up target that clears the margin call: initial margin restored.
        let target = required_collateral(DEBT, price, NAV_DEC, HAIRCUT_BPS).unwrap();
        assert_eq!(target - TAKE_COLLATERAL, 152_430_290);
        assert_eq!(ltv_ok(DEBT, target, price, NAV_DEC, HAIRCUT_BPS), Ok(true));
        assert_eq!(
            ltv_ok(DEBT, target - 1, price, NAV_DEC, HAIRCUT_BPS),
            Ok(false)
        );
    }

    #[test]
    fn margin_checks_reject_bad_input() {
        assert_eq!(
            ltv_ok(-1, TAKE_COLLATERAL, nav(1.0), NAV_DEC, HAIRCUT_BPS),
            Err(Error::InvalidAmount)
        );
        assert_eq!(
            margin_breached(DEBT, TAKE_COLLATERAL, 0, NAV_DEC, DISCOUNT_BPS),
            Err(Error::InvalidAmount)
        );
        assert_eq!(
            margin_breached(DEBT, TAKE_COLLATERAL, nav(1.0), NAV_DEC, 10_000),
            Err(Error::InvalidAmount)
        );
    }

    // --- liquidation waterfall --------------------------------------------

    #[test]
    fn liquidation_proceeds_apply_discount_and_round_up() {
        assert_eq!(
            liquidation_proceeds(COLLATERAL, nav(1.0), NAV_DEC, DISCOUNT_BPS),
            Ok(980 * UNIT)
        );
        assert_eq!(liquidation_proceeds(1, 1, NAV_DEC, DISCOUNT_BPS), Ok(1));
        assert_eq!(
            liquidation_proceeds(COLLATERAL, nav(1.0), NAV_DEC, 10_000),
            Err(Error::InvalidAmount)
        );
    }

    #[test]
    fn repay_pays_lender_exact_offer_terms() {
        let w = waterfall(DEBT, PRINCIPAL, INTEREST, FEE_BPS).unwrap();
        assert_eq!(
            w,
            Waterfall {
                lender: LENDER_DUE,
                fee: FEE,
                borrower: 0,
                shortfall: 0
            }
        );
    }

    /// Brief scenario 1 — surplus. Borrower misses maturity, NAV unchanged.
    /// Lender and treasury paid in full, borrower gets the rest.
    #[test]
    fn scenario_surplus() {
        let (proceeds, w) = liquidate_at(nav(1.0));
        assert_eq!(proceeds, 9_809_397_262);
        assert_eq!(
            w,
            Waterfall {
                lender: LENDER_DUE,
                fee: FEE,
                borrower: 100_095_892,
                shortfall: 0
            }
        );
    }

    /// Brief scenario 2 — lender made whole. NAV falls past the trigger and
    /// the margin call is missed. Proceeds cover the lender's terms but not
    /// the full fee: lender exact, fee partly waived, no Shortfall event.
    #[test]
    fn scenario_lender_made_whole() {
        let (proceeds, w) = liquidate_at(9_897_500);
        assert_eq!(proceeds, 9_708_850_940);
        assert_eq!(
            w,
            Waterfall {
                lender: LENDER_DUE,
                fee: 479_707,
                borrower: 0,
                shortfall: 0
            }
        );
    }

    /// Brief scenario 3 — shortfall. NAV falls 2%, beyond the buffer.
    /// Lender takes all proceeds, borrower and treasury get nothing.
    #[test]
    fn scenario_shortfall() {
        let (proceeds, w) = liquidate_at(9_800_000);
        assert_eq!(proceeds, 9_613_209_316);
        assert_eq!(
            w,
            Waterfall {
                lender: proceeds,
                fee: 0,
                borrower: 0,
                shortfall: 95_161_917
            }
        );
    }

    /// The #14 promise: while the margin trigger has not fired, liquidating
    /// at the same discount pays the lender in full.
    #[test]
    fn no_shortfall_before_margin_trigger() {
        let (mut healthy, mut breaches) = (0, 0);
        let mut price = nav(0.98);
        while price <= nav(1.01) {
            if breached(price) {
                breaches += 1;
            } else {
                healthy += 1;
                assert_eq!(liquidate_at(price).1.shortfall, 0, "nav {price}");
            }
            price += 13;
        }
        assert!(healthy > 0 && breaches > 0);
    }

    #[test]
    fn waterfall_never_overpays_lender() {
        for available in [
            0,
            1,
            LENDER_DUE - 1,
            LENDER_DUE,
            LENDER_DUE + 1,
            DEBT,
            2_000 * UNIT,
        ] {
            let w = waterfall(available, PRINCIPAL, INTEREST, FEE_BPS).unwrap();
            assert!(w.lender <= LENDER_DUE);
            assert!(w.fee <= FEE);
            assert_eq!(w.lender + w.fee + w.borrower, available);
            assert_eq!(w.lender + w.shortfall, LENDER_DUE);
        }
    }

    #[test]
    fn waterfall_rejects_negative_input() {
        assert_eq!(
            waterfall(-1, PRINCIPAL, INTEREST, FEE_BPS),
            Err(Error::InvalidAmount)
        );
        assert_eq!(
            waterfall(0, -1, INTEREST, FEE_BPS),
            Err(Error::InvalidAmount)
        );
        assert_eq!(
            waterfall(0, PRINCIPAL, -1, FEE_BPS),
            Err(Error::InvalidAmount)
        );
    }

    // --- NAV freshness ----------------------------------------------------

    #[test]
    fn nav_freshness() {
        assert!(nav_is_fresh(1_180, 1_000, 180));
        assert!(!nav_is_fresh(1_181, 1_000, 180));
        assert!(nav_is_fresh(1_000, 1_005, 180)); // feed slightly ahead of ledger
    }
}
