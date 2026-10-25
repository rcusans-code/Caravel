// npm test: node:test via tsx. Prices at 14 decimals (ONE = 1e14), fixtures
// from flash-crash qa-fix2-test.rs and report S2a/S2b/S4b/S6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { navHold, describeHold, type NavGuardOpts, type NavLatch, type PriceData } from "./navguard.js";

const ONE = 10n ** 14n;
const px = (n: number) => (BigInt(Math.round(n * 1e6)) * ONE) / 1_000_000n;
const rec = (price: number, timestamp: number): PriceData => ({ price: px(price), timestamp: BigInt(timestamp) });
const opts = (acks: bigint[] = []): NavGuardOpts => ({ asset: "TBENJI", jumpBps: 200n, ackBps: 1000n, holdSecs: 180n, acks: new Set(acks) });
const run = (h: PriceData[], now: number, o = opts(), latch: NavLatch = new Map()) => navHold(h, BigInt(now), o, latch);

// QA2: a 0.50 fat-finger at 1005, re-posted by nav-keeper at 1065 and 1125.
const QA2 = [rec(0.5, 1125), rec(0.5, 1065), rec(0.5, 1005), rec(1.0, 1000)];

test("T1 QA2 fixture: hold, needsAck, 5000 bps", () => {
  const h = run(QA2, 1130);
  assert.equal(h.hold, true);
  assert.equal(h.needsAck, true);
  assert.equal(h.jumpBps, 5000n);
  assert.equal(h.anchor, px(1.0));
  assert.equal(h.stoodSecs, 125n);
});

test("T2 QA2 fixture acked: no hold (the ack releases both rules)", () => {
  const h = run(QA2, 1130, opts([px(0.5)]));
  assert.equal(h.hold, false);
  assert.equal(h.reason, "acked");
  // An ack of another price does not release this one.
  assert.equal(run(QA2, 1130, opts([px(0.49)])).hold, true);
});

test("T3 0.97 after a long 1.00: hold until it stood > holdSecs", () => {
  const hist = [rec(0.97, 1005), rec(1.0, 0)];
  const a = run(hist, 1100);
  assert.equal(a.hold, true);
  assert.equal(a.reason, "jump");
  assert.equal(a.needsAck, false);
  assert.equal(a.jumpBps, 300n);
  assert.equal(run(hist, 1185).hold, true); // stood 180: still held
  const b = run(hist, 1186); // stood 181 > 180
  assert.equal(b.hold, false);
});

test("T4-T6 jump threshold: 150 and 200 bps pass, 201 bps holds", () => {
  const at = (p: bigint) => run([{ price: p, timestamp: 1005n }, rec(1.0, 0)], 1010);
  assert.equal(at(px(0.985)).hold, false); // T4 150 bps
  const t5 = at(px(0.98)); // T5 exactly 200 bps
  assert.equal(t5.jumpBps, 200n);
  assert.equal(t5.hold, false);
  const t6 = at(px(0.9799)); // T6 201 bps
  assert.equal(t6.jumpBps, 201n);
  assert.equal(t6.hold, true);
});

test("T7 a single record, or an empty history: no hold", () => {
  assert.equal(run([rec(0.5, 1000)], 1010).hold, false);
  assert.equal(run([], 1010).hold, false);
  assert.equal(run([rec(0.5, 1000), rec(0.5, 940)], 1010).hold, false);
});

test("T8 a future-dated current record: hold, whatever the jump or ack", () => {
  const big = run([rec(0.97, 1000 + 86400), rec(1.0, 0)], 1000);
  assert.equal(big.hold, true);
  assert.equal(big.reason, "future-dated");
  assert.equal(big.stoodSecs, -86400n);
  // A future-dated re-post of the same price (0 bps), acked: still held.
  const same = run([rec(1.0, 1000 + 86400), rec(1.0, 900), rec(1.0, 0)], 1000, opts([px(1.0)]));
  assert.equal(same.hold, true);
  assert.equal(same.reason, "future-dated");
  // A few seconds of ledger/wall clock skew is tolerated.
  assert.equal(run([rec(1.0, 1005), rec(1.0, 0)], 1000).hold, false);
});

test("T9 S6 up-jump 1.00 -> 10.00: hold, needsAck", () => {
  const h = run([rec(10, 1005), rec(1.0, 0)], 2000); // stood 995 s: only the ack rule holds
  assert.equal(h.hold, true);
  assert.equal(h.needsAck, true);
  assert.equal(h.jumpBps, 90000n);
});

test("T10 correction 1.00 (long) -> 0.50 (50 s) -> 1.00: no hold", () => {
  const h = run([rec(1.0, 1050), rec(0.5, 1000), rec(1.0, 0)], 1060);
  assert.equal(h.anchor, px(1.0));
  assert.equal(h.jumpBps, 0n);
  assert.equal(h.hold, false);
});

test("T11 salami 1.00 (long) -> 0.985 (20 s) -> 0.97: hold, 300 bps", () => {
  const h = run([rec(0.97, 1020), rec(0.985, 1000), rec(1.0, 0)], 1030);
  assert.equal(h.anchor, px(1.0));
  assert.equal(h.jumpBps, 300n);
  assert.equal(h.hold, true);
});

test("T12 latch: needs-ack hold survives the anchor leaving the history, clears on change", () => {
  const latch: NavLatch = new Map();
  assert.equal(run(QA2, 1130, opts(), latch).needsAck, true);
  assert.equal(latch.get("TBENJI"), px(0.5));
  const twenty = Array.from({ length: 20 }, (_, i) => rec(0.5, 2300 - i * 60)); // anchor gone
  const h = run(twenty, 2310, opts(), latch);
  assert.equal(h.hold, true);
  assert.equal(h.reason, "latched");
  assert.equal(h.needsAck, true);
  // Without the latch (keeper restart) the same history is released.
  assert.equal(run(twenty, 2310).hold, false);
  // The price changes: the 0.50 latch is cleared. The 0.50 stood past the
  // hold, so it is now the anchor and the correction to 1.00 (+100%) needs
  // its own ack (README: ack the correction too).
  const changed = [rec(1.0, 2320), ...twenty.slice(0, 19)];
  const c = run(changed, 2330, opts(), latch);
  assert.equal(c.anchor, px(0.5));
  assert.equal(c.reason, "needs-ack");
  assert.equal(latch.get("TBENJI"), px(1.0));
  assert.equal(run(changed, 2330, opts([px(1.0)]), latch).hold, false);
  assert.equal(latch.has("TBENJI"), false);
  // An ack also clears it.
  run(QA2, 1130, opts(), latch);
  assert.equal(run(twenty, 2310, opts([px(0.5)]), latch).hold, false);
  assert.equal(latch.has("TBENJI"), false);
});

test("T13 re-post walk: the anchor is found 6 records back past identical re-posts", () => {
  const hist = [rec(0.5, 1050), rec(0.5, 1040), rec(0.5, 1030), rec(0.5, 1020), rec(0.5, 1010), rec(1.0, 1000), rec(1.0, 700)];
  const h = run(hist, 1060);
  assert.equal(h.anchor, px(1.0)); // records[5]
  assert.equal(h.stoodSecs, 50n);
  assert.equal(h.jumpBps, 5000n);
  assert.equal(h.hold, true);
});

test("history order does not matter, and the log line reads well", () => {
  const h = run([...QA2].reverse(), 1130);
  assert.equal(h.jumpBps, 5000n);
  assert.equal(describeHold(h, 180n, 14), "NAV -50.00% vs 1.00 (stood 125s/180s)");
});
