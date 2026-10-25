// Stuck-state alerts. A state that blocks a payout (liquidator short of USDC,
// NAV stale or out of band at liquidation, issuer pause, contract or
// liquidator off the token allowlist) is logged once like any other state,
// and turns into a failure plus an ALERT once it has lasted more than
// STUCK_TICKS ticks (or at once with --once). The ALERT line goes to the
// journal and, when ALERT_CMD is set (the systemd unit points it at
// caravel-alert.sh), to that command as its argument.
import { spawn } from "node:child_process";

/** Ticks a stuck state may last before it fails and alerts. */
export const STUCK_TICKS = 2;

/**
 * Consecutive ticks each key (repo or issuer check) has been in its current
 * state. Call `see` for every key in a stuck state during a tick, then `end`.
 * A key not seen in a tick, or seen in another state, starts again at 1.
 */
export class StuckTracker {
  private cur = new Map<string, { state: string; ticks: number }>();
  private seen = new Set<string>();

  /** Record `key` in `state` this tick; returns the consecutive tick count (1 = first). */
  see(key: string, state: string): number {
    const prev = this.cur.get(key);
    const ticks = prev && prev.state === state ? prev.ticks + 1 : 1;
    this.cur.set(key, { state, ticks });
    this.seen.add(key);
    return ticks;
  }

  /** End of tick: forget keys that left their stuck state. */
  end() {
    for (const k of [...this.cur.keys()]) if (!this.seen.has(k)) this.cur.delete(k);
    this.seen.clear();
  }

  /** The tick threw part-way: keep every count (a failed read is not a recovery). */
  skipTick() {
    this.seen.clear();
  }
}

/** A stuck state fails (counts for the `--once` exit code) after `threshold` ticks, or at once with --once. */
export function stuckFails(ticks: number, once: boolean, threshold = STUCK_TICKS): boolean {
  return once || ticks > threshold;
}

/**
 * Whether to send the ALERT on this tick: the first failing tick, then every
 * `repeatTicks` while it lasts (0 = never repeat).
 */
export function alertDue(ticks: number, once: boolean, repeatTicks: number, threshold = STUCK_TICKS): boolean {
  if (once) return true;
  if (ticks <= threshold) return false;
  const over = ticks - (threshold + 1);
  return over === 0 || (repeatTicks > 0 && over % repeatTicks === 0);
}

/**
 * Run ALERT_CMD with the message (20 s cap). Never throws; resolves when the
 * command exited so `--once` can wait for it before exiting. Its output is
 * discarded (the journal already has the ALERT line).
 */
export function sendAlert(msg: string, log: (line: string) => void, cmd = process.env.ALERT_CMD): Promise<void> {
  if (!cmd) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, [msg], { stdio: "ignore", timeout: 20_000 });
      p.on("error", (e) => {
        log(`alert        ALERT_CMD ${cmd} failed: ${e.message}`);
        resolve();
      });
      p.on("exit", (code, signal) => {
        if (code || signal) log(`alert        ALERT_CMD ${cmd} exited ${code ?? signal}`);
        resolve();
      });
    } catch (e) {
      log(`alert        ALERT_CMD ${cmd} failed: ${(e as Error).message}`);
      resolve();
    }
  });
}
