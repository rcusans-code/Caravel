/**
 * Exit code of `keeper --once`: 1 when the tick threw or any action inside it
 * failed (refresh-nav, auto_repay, default, check_margin or liquidate error),
 * else 0. Holds, StaleNav / no-NAV skips, NotDefaultable "pending",
 * AutoRepayFailed "short" and liquidator-USDC skips are expected states: 0.
 */
export function onceExitCode(tickThrew: boolean, failures: number): 0 | 1 {
  return tickThrew || failures > 0 ? 1 : 0;
}
