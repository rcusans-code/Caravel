/**
 * Exit code of `keeper --once`: 1 when the tick threw or any action inside it
 * failed (refresh-nav, auto_repay, default, check_margin or liquidate error),
 * or a payout is stuck (a Defaulted repo the liquidator cannot pay or cannot
 * price, the token paused or the repo contract / liquidator off its
 * allowlist: alert.ts, these fail at once under --once), else 0. NAV jump
 * holds, StaleNav / NavOutOfBand skips outside liquidation, NotDefaultable /
 * NotDue "pending" and AutoRepayFailed "short" are expected states: 0.
 */
export function onceExitCode(tickThrew: boolean, failures: number): 0 | 1 {
  return tickThrew || failures > 0 ? 1 : 0;
}
