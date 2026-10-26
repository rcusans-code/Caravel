// npm test: stuck-state failures and alerts (alert.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { alertDue, StuckTracker, stuckFails } from "./alert.js";

test("consecutive ticks per key and state", () => {
  const t = new StuckTracker();
  assert.equal(t.see("repo:8", "liq-usdc"), 1);
  t.end();
  assert.equal(t.see("repo:8", "liq-usdc"), 2);
  t.end();
  assert.equal(t.see("repo:8", "liq-usdc"), 3);
  t.end();
  // another stuck state restarts the count
  assert.equal(t.see("repo:8", "liq-stale"), 1);
  t.end();
});

test("a key not seen in a tick (recovered) starts again", () => {
  const t = new StuckTracker();
  t.see("repo:8", "liq-usdc");
  t.end();
  t.see("repo:8", "liq-usdc");
  t.end();
  t.end(); // tick without repo 8 stuck: it was liquidated or funded
  assert.equal(t.see("repo:8", "liq-usdc"), 1);
});

test("a tick that threw keeps the counts", () => {
  const t = new StuckTracker();
  t.see("repo:8", "liq-usdc");
  t.end();
  t.skipTick();
  assert.equal(t.see("repo:8", "liq-usdc"), 2);
});

test("liq-usdc / liq-stale fail only after more than 2 ticks", () => {
  assert.equal(stuckFails(1, false), false);
  assert.equal(stuckFails(2, false), false);
  assert.equal(stuckFails(3, false), true);
});

test("--once fails and alerts on the first tick", () => {
  assert.equal(stuckFails(1, true), true);
  assert.equal(alertDue(1, true, 180), true);
});

test("alert on the first failing tick, then every repeatTicks", () => {
  const due = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((n) => alertDue(n, false, 3));
  assert.deepEqual(due, [3, 6, 9]);
  assert.deepEqual([3, 4, 100].filter((n) => alertDue(n, false, 0)), [3]);
});

// keeper.ts actionFailed: a repo action (default, auto_repay, check_margin)
// that fails is tracked under `repo:<id>:<action>` in the constant state
// "fail"; the error text (new tx hash every tick) is only in the message.
test("an action failing every tick with a new message alerts on tick 3", () => {
  const t = new StuckTracker();
  const due: boolean[] = [];
  for (let tick = 1; tick <= 3; tick++) {
    // the ALERT text (tx …/tx/<hash>) differs each tick; the tracked state is always "fail"
    due.push(alertDue(t.see("repo:5:default", "fail"), false, 180));
    t.end();
  }
  assert.deepEqual(due, [false, false, true]);
});

test("an action failing one tick then gone (race, e.g. #7 InvalidStatus) resets and never alerts", () => {
  const t = new StuckTracker();
  assert.equal(alertDue(t.see("repo:5:default", "fail"), false, 180), false);
  t.end();
  t.end(); // next tick: repo 5 is Defaulted, the default branch is not reached
  t.end();
  assert.equal(t.see("repo:5:default", "fail"), 1);
});
