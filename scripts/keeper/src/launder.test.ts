// npm test: keeper-launder side (NAV review 2026-10-26). A bad NAV push that
// nav-keeper.sh re-posts 20 times fills the contract's 20-record band window
// and pushes the pre-jump price out of prices(asset, 20); a keeper restart then
// lost the navguard latch and released the bad price. Covers: the persisted
// guard state (navstate.ts) and nav-keeper.sh's refusal to re-post a jump.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { navHold, type NavGuardOpts, type PriceData } from "./navguard.js";
import { emptyNavState, loadNavState, navStatePath, parseNavState, saveNavState, serializeNavState, type NavState } from "./navstate.js";

const ONE = 10n ** 14n;
const px = (n: number) => (BigInt(Math.round(n * 1e6)) * ONE) / 1_000_000n;
const rec = (price: number, timestamp: number): PriceData => ({ price: px(price), timestamp: BigInt(timestamp) });
const opts = (s: NavState, acks: bigint[] = []): NavGuardOpts => ({
  asset: "TBENJI",
  jumpBps: 200n,
  ackBps: 1000n,
  holdSecs: 180n,
  acks: new Set(acks),
  trusted: s.trusted.get("TBENJI"),
});
/** One keeper tick as keeper.ts runs it: hold decision, then remember a released price. */
const tick = (s: NavState, h: PriceData[], now: number, acks: bigint[] = []) => {
  const r = navHold(h, BigInt(now), opts(s, acks), s.latch);
  if (!r.hold && r.current !== null) s.trusted.set("TBENJI", r.current);
  return r;
};
/** Keeper restart: the state goes through the file format and back. */
const restart = (s: NavState) => parseNavState(serializeNavState("CORACLE", s), "CORACLE");

const STEADY = Array.from({ length: 20 }, (_, i) => rec(1.0, 1000 - i * 60));
// QA2: a 0.50 fat-finger at 1005, re-posted by nav-keeper at 1065 and 1125.
const QA2 = [rec(0.5, 1125), rec(0.5, 1065), rec(0.5, 1005), ...STEADY.slice(0, 17)];
// 20 re-posts of 0.50, newest 2300: the 1.00 anchor is no longer in the history.
const TWENTY = Array.from({ length: 20 }, (_, i) => rec(0.5, 2300 - i * 60));

test("L1 base behaviour: with no state a restart releases the laundered 0.50 (why the state file exists)", () => {
  const h = tick(emptyNavState(), TWENTY, 2310);
  assert.equal(h.hold, false);
  assert.equal(h.reason, "none");
  assert.equal(h.anchor, null);
});

test("L2 keeper saw the bad push, restarts after 20 re-posts: still latched (persisted latch)", () => {
  const s = emptyNavState();
  assert.equal(tick(s, STEADY, 1001).hold, false);
  assert.equal(tick(s, QA2, 1130).reason, "needs-ack");
  const after = restart(s);
  assert.deepEqual(after.latch.get("TBENJI"), { anchor: px(1.0), bad: new Set([px(0.5)]) });
  const h = tick(after, TWENTY, 2310);
  console.log(`  restart after 20 re-posts, latch from file: hold=${h.hold} reason=${h.reason} jumpBps=${h.jumpBps} anchor=${h.anchor}`);
  assert.equal(h.hold, true);
  assert.equal(h.reason, "latched");
  assert.equal(h.needsAck, true);
  assert.equal(h.jumpBps, 5000n);
  assert.equal(h.anchor, px(1.0));
  // The ack still releases it, and the correction to 1.00 needs none.
  assert.equal(tick(restart(s), TWENTY, 2310, [px(0.5)]).hold, false);
  assert.equal(tick(restart(after), [rec(1.0, 2320), ...TWENTY.slice(0, 19)], 2330).hold, false);
});

test("L3 keeper was down for the whole bad push + 20 re-posts: the trusted 1.00 is the anchor", () => {
  const s = emptyNavState();
  assert.equal(tick(s, STEADY, 1001).hold, false);
  const after = restart(s); // never saw 0.50
  assert.equal(after.latch.size, 0);
  const h = tick(after, TWENTY, 2310);
  console.log(`  keeper down through the push + 20 re-posts, trusted 1.00 from file: hold=${h.hold} reason=${h.reason} jumpBps=${h.jumpBps}`);
  assert.equal(h.hold, true);
  assert.equal(h.reason, "needs-ack");
  assert.equal(h.anchor, px(1.0));
  assert.equal(h.jumpBps, 5000n);
  assert.equal(after.latch.get("TBENJI")?.anchor, px(1.0)); // and it latches from there
  // Variant: one 0.51 then 0.50 x19 (the history's own anchor would be 0.51, a 196 bps step).
  const salami = [...TWENTY.slice(0, 19), rec(0.51, 1100)];
  const v = tick(restart(s), salami, 2310);
  assert.equal(v.hold, true);
  assert.equal(v.anchor, px(1.0));
});

test("L4 no false hold: a real 1 bps drift while the keeper was down, or the trusted price still in history", () => {
  const s = emptyNavState();
  tick(s, STEADY, 1001);
  const drift = Array.from({ length: 20 }, (_, i) => rec(1.0001, 90_000 - i * 60));
  const h = tick(restart(s), drift, 90_010);
  assert.equal(h.hold, false);
  assert.equal(h.jumpBps, 1n);
  // A 3% move (demo set-nav 0.97) after a restart: the usual 180 s jump hold, then released.
  const s2 = restart(s);
  const moved = [rec(0.97, 1060), ...STEADY.slice(0, 19)];
  assert.equal(tick(s2, moved, 1100).reason, "jump");
  const s3 = restart(s2);
  assert.equal(tick(s3, moved, 1241).hold, false);
  assert.equal(s3.trusted.get("TBENJI"), px(0.97));
});

test("L5 state file: missing = clean start, round trip, other oracle or garbage = empty + error", () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "navstate-"));
  const file = path.join(dir, "sub", "navguard-CORACLE.json");
  assert.deepEqual(loadNavState(file, "CORACLE"), { state: emptyNavState() });
  const s = emptyNavState();
  tick(s, STEADY, 1001);
  tick(s, QA2, 1130);
  saveNavState(file, serializeNavState("CORACLE", s));
  const back = loadNavState(file, "CORACLE");
  assert.equal(back.error, undefined);
  assert.deepEqual(back.state, s);
  assert.match(loadNavState(file, "COTHER").error ?? "", /not COTHER/);
  writeFileSync(file, "{not json");
  const bad = loadNavState(file, "CORACLE");
  assert.ok(bad.error);
  assert.equal(bad.state.latch.size, 0);
  assert.equal(navStatePath("CX", { NAV_STATE_FILE: "/x/y.json" }), "/x/y.json");
  assert.equal(navStatePath("CX", { XDG_STATE_HOME: "/s" }), "/s/caravel/navguard-CX.json");
});

// nav-keeper.sh against a fake `stellar` CLI: lastprice / set_price on files.
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../nav-keeper.sh");
const FAKE = `#!/usr/bin/env bash
fn=""; asset=""; price=""
while (($#)); do case "$1" in --) shift; fn="$1";; --asset) asset="$2"; shift;; --price) price="$2"; shift;; esac; shift; done
f="$FAKE_DIR/$(printf %s "$asset" | md5sum | cut -c1-8)"
case "$fn" in
  lastprice) if [[ -f $f ]]; then read -r p t <"$f"; printf '{"price":"%s","timestamp":%s}\\n' "$p" "$t"; else echo null; fi ;;
  set_price) echo "$price $(date +%s)" >"$f"; echo "$price" >>"$FAKE_DIR/pushes.log" ;;
esac
`;
const BAD = 50_000_000_000_000n; // 0.50 at 14 decimals

function harness() {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "navkeeper-"));
  const fake = path.join(dir, "stellar");
  writeFileSync(fake, FAKE);
  chmodSync(fake, 0o755);
  const envFile = path.join(dir, ".env");
  const baseEnv = "NETWORK=testnet\nORACLE_ID=CORACLE\nTBENJI_SAC=CBENJI\nADMIN_ADDRESS=GADMIN\nADMIN_SECRET=SFAKE\n";
  writeFileSync(envFile, baseEnv);
  const state = path.join(dir, "state", "nav-keeper.state");
  const key = spawnSync("bash", ["-c", `printf %s '{"Stellar":"CBENJI"}' | md5sum | cut -c1-8`], { encoding: "utf8" }).stdout.trim();
  const pushes = () => (existsSync(path.join(dir, "pushes.log")) ? readFileSync(path.join(dir, "pushes.log"), "utf8").trim().split("\n") : []);
  return {
    /** Someone else (Admin slider, set-nav) pushes `price` straight to the oracle. */
    push: (price: bigint) => writeFileSync(path.join(dir, key), `${price} ${Math.floor(Date.now() / 1000)}\n`),
    /** One `nav-keeper.sh --once` round: a fresh process each time, i.e. a restart. */
    round: (extra: Record<string, string> = {}) => {
      const r = spawnSync("bash", [SCRIPT, "--once"], {
        env: { ...process.env, ENV_FILE: envFile, STELLAR: fake, FAKE_DIR: dir, ALERT_CMD: "", NAV_KEEPER_STATE: state, ...extra },
        encoding: "utf8",
      });
      return { status: r.status, out: r.stdout + r.stderr };
    },
    env: (extra: string) => writeFileSync(envFile, baseEnv + extra),
    pushes,
    state,
  };
}

test("N1 nav-keeper.sh refuses to re-post a 50% jump for 20 rounds (restarts included), ALERTs, keeps posting after a correction", () => {
  const k = harness();
  assert.equal(k.round().status, 0); // no price yet -> 1.00, remembered
  assert.equal(readFileSync(k.state, "utf8").trim(), `tBENJI ${ONE}`);
  k.push(BAD);
  let out = "";
  for (let i = 0; i < 20; i++) {
    const r = k.round();
    assert.equal(r.status, 0); // a refusal is not a failed push
    out += r.out;
  }
  const bad = k.pushes().filter((p) => p === String(BAD)).length;
  const alerts = (out.match(/ALERT tBENJI NAV 50000000000000 jumped 5000 bps/g) ?? []).length;
  console.log(`  20 rounds after a 0.50 push: ${bad} re-posts of 0.50, ${alerts} ALERT lines, 'set_price failed' alerts: ${(out.match(/set_price failed/g) ?? []).length}`);
  assert.equal(bad, 0);
  assert.equal(alerts, 20); // --once is a new process each round: an ALERT per run
  assert.doesNotMatch(out, /set_price failed/);
  assert.equal(readFileSync(k.state, "utf8").trim(), `tBENJI ${ONE}`); // reference kept: 1.00
  k.push(ONE); // correction
  k.round();
  assert.deepEqual(k.pushes().slice(-1), [String(ONE)]);
});

test("N2 nav-keeper.sh re-posts a jump once acked (NAV_JUMP_ACK) or pinned (NAV=), and a demo-sized 3% move at once", () => {
  const k = harness();
  k.round();
  k.push(97_000_000_000_000n); // Admin slider 0.97: 300 bps <= 1000
  k.round();
  assert.deepEqual(k.pushes().slice(-1), ["97000000000000"]);
  k.push(BAD);
  k.round();
  assert.deepEqual(k.pushes().slice(-1), ["97000000000000"]); // refused
  k.env(`NAV_JUMP_ACK=1,${BAD}\n`);
  k.round();
  assert.deepEqual(k.pushes().slice(-1), [String(BAD)]);
  assert.equal(readFileSync(k.state, "utf8").trim(), `tBENJI ${BAD}`);
  // A tighter threshold from .env, and a pin overrides the refusal.
  k.env("NAV_JUMP_ACK_BPS=100\n");
  k.push(52_000_000_000_000n); // +400 bps vs 0.50
  k.round();
  assert.deepEqual(k.pushes().slice(-1), [String(BAD)]);
  k.round({ NAV: "1.00" });
  assert.deepEqual(k.pushes().slice(-1), [String(ONE)]);
});
