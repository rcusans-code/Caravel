// npm test: keeper and nav-keeper liveness (Raven R2: D-01 to D-04, AS-02).
// Runs against local fake RPC / Horizon servers only: no network, no tx.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Networks, StrKey, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { alertDue, StuckTracker, stuckFails } from "./alert.js";
import { collateralShortfalls, owedByAsset } from "./reconcile.js";
import { Watchdog } from "./watchdog.js";

// Fake JSON-RPC: "hang" never answers, "503" fails every request, "sim"
// answers simulateTransaction with a contract error and logs every method.
let mode: "hang" | "503" | "sim" = "sim";
const calls: { method: string; source?: string }[] = [];
const rpcSrv = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (mode === "hang") return;
    if (mode === "503") return void res.writeHead(503).end("injected 503");
    const body = JSON.parse(Buffer.concat(chunks).toString());
    let source: string | undefined;
    if (body.method === "simulateTransaction") {
      source = (TransactionBuilder.fromXDR(body.params.transaction, Networks.TESTNET) as { source: string }).source;
    }
    calls.push({ method: body.method, source });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { latestLedger: 1, error: "HostError: Error(Contract, #9)" } }));
  });
});
await new Promise<void>((r) => rpcSrv.listen(0, "127.0.0.1", r));
const rpcPort = (rpcSrv.address() as { port: number }).port;
process.env.RPC_URL = `http://127.0.0.1:${rpcPort}`;
process.env.RPC_TIMEOUT_MS = "400";
const chain = await import("./chain.js");
after(() => {
  rpcSrv.closeAllConnections();
  rpcSrv.close();
});
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
const ID = [nativeToScVal(1n, { type: "u64" })];

test("D-01: every RPC request is bounded by RPC_TIMEOUT_MS (default 15 s)", async () => {
  assert.equal(chain.server.httpClient.defaults.timeout, 400);
  assert.match(readFileSync(new URL("./chain.ts", import.meta.url), "utf8"), /RPC_TIMEOUT_MS \|\| 15_000/);
  mode = "hang";
  const t0 = Date.now();
  await assert.rejects(chain.view(CONTRACT, "repo", ID), /timeout of 400 ?ms exceeded/);
  assert.ok(Date.now() - t0 < 3000, `view gave up after ${Date.now() - t0} ms`);
});

test("D-01: the tick watchdog fires with no RPC answer, an answer pushes it back, clear stops it", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let fired = 0;
  const w = new Watchdog(120, () => fired++);
  w.arm();
  await sleep(80);
  w.kick(); // an RPC answered
  await sleep(80);
  assert.equal(fired, 0, "kicked at 80 ms, so not due before 200 ms");
  await sleep(100);
  assert.equal(fired, 1);
  w.arm();
  w.clear(); // tick ended
  await sleep(160);
  assert.equal(fired, 1);
  w.kick(); // between ticks a kick does not re-arm
  await sleep(160);
  assert.equal(fired, 1);
  assert.equal(w.armed, false);
});

test("D-01: chain.ts reports every RPC answer to the watchdog hook", async () => {
  mode = "sim";
  let answers = 0;
  chain.onRpcAnswer(() => answers++);
  await assert.rejects(chain.view(CONTRACT, "repo", ID));
  assert.equal(answers, 1);
  chain.onRpcAnswer(() => {});
});

test("D-03: failed ticks ALERT on the 2nd in a row, repeat every ALERT_REPEAT_SECS, reset on a good tick", () => {
  // keeper.ts main loop: a failed tick calls stuck("rpc", "blind", …, BLIND_AFTER = 1)
  // then tracker.skipTick(); a good tick calls tracker.end().
  const t = new StuckTracker();
  const failedTick = () => {
    const n = t.see("rpc", "blind");
    const r = { alert: alertDue(n, false, 3, 1), fails: stuckFails(n, false, 1) };
    t.skipTick();
    return r;
  };
  assert.deepEqual(failedTick(), { alert: false, fails: false });
  assert.deepEqual(failedTick(), { alert: true, fails: true });
  assert.deepEqual([failedTick(), failedTick(), failedTick()].map((r) => r.alert), [false, false, true]);
  t.end(); // good tick: RPC back
  assert.deepEqual(failedTick(), { alert: false, fails: false });
  // --once: the first failed tick alerts
  assert.equal(alertDue(1, true, 3, 1), true);
});

test("D-04: view simulates from NULL_ACCOUNT with no getAccount call", async () => {
  mode = "sim";
  calls.length = 0;
  await assert.rejects(chain.view(CONTRACT, "repo", ID), (e: Error) => e instanceof chain.ContractError && e.code === 9);
  assert.deepEqual(calls, [{ method: "simulateTransaction", source: chain.NULL_ACCOUNT }]);
});

test("D-04: an RPC outage reads as the RPC error, not 'Account not found'", async () => {
  mode = "503";
  await assert.rejects(chain.view(CONTRACT, "repo", ID), (e: Error) => /503/.test(e.message) && !/Account not found/.test(e.message));
});

const A = "CTBENJI", B = "CTSAFO";
const repo = (asset: string, amount: bigint) => ({ collateral_asset: asset, collateral_amount: amount });

test("AS-02: a balance below the live collateral is a shortfall", () => {
  const repos = [repo(A, 10_009_589_042n), repo(A, 10_009_589_042n), repo(B, 500n)];
  assert.deepEqual(owedByAsset(repos).get(A), { owed: 20_019_178_084n, repos: 2 });
  // the issuer clawed one repo's collateral back from the contract (assets-sac R1)
  const short = collateralShortfalls(repos, new Map([[A, 10_009_589_042n], [B, 500n]]));
  assert.deepEqual(short, [{ asset: A, held: 10_009_589_042n, owed: 20_019_178_084n, short: 10_009_589_042n, repos: 2 }]);
});

test("AS-02: equal or surplus balance, a failed read, or no live repo is not a shortfall", () => {
  const repos = [repo(A, 100n), repo(B, 50n)];
  assert.deepEqual(collateralShortfalls(repos, new Map([[A, 100n], [B, 70n]])), []); // surplus: parked claimable collateral
  assert.deepEqual(collateralShortfalls(repos, new Map([[A, null], [B, null]])), []);
  assert.deepEqual(collateralShortfalls([], new Map([[A, 0n]])), []);
});

test("D-02: nav-keeper keeps pushing while Horizon hangs (curl --max-time, stubbed stellar CLI)", async () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "navk-"));
  const horizon = http.createServer(() => {}); // accepts, never answers
  await new Promise<void>((r) => horizon.listen(0, "127.0.0.1", r));
  const hport = (horizon.address() as { port: number }).port;
  // Stub CLI: lastprice answers 1.00, set_price succeeds, every call is logged.
  writeFileSync(
    path.join(dir, "stellar"),
    `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$*" in *lastprice*) echo '{"price":"100000000000000","timestamp":1}';; esac\n`,
  );
  chmodSync(path.join(dir, "stellar"), 0o755);
  writeFileSync(
    path.join(dir, "env"),
    `NETWORK=testnet\nORACLE_ID=CORACLE\nTBENJI_SAC=CTBENJI\nADMIN_ADDRESS=GADMIN\nADMIN_SECRET=not-a-key\n`,
  );
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../nav-keeper.sh");
  const p = spawn("bash", [script], {
    detached: true,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      ENV_FILE: path.join(dir, "env"),
      STELLAR: path.join(dir, "stellar"),
      NAV_KEEPER_STATE: path.join(dir, "state"),
      HORIZON_URL: `http://127.0.0.1:${hport}`,
      HORIZON_TIMEOUT: "1",
      INTERVAL: "1",
    },
  });
  let out = "";
  p.stdout.on("data", (c) => (out += c));
  p.stderr.on("data", (c) => (out += c));
  await new Promise((r) => setTimeout(r, 7000));
  process.kill(-p.pid!, "SIGKILL");
  horizon.closeAllConnections();
  horizon.close();
  const pushes = (out.match(/set_price tBENJI=100000000000000/g) ?? []).length;
  // Before the fix the first top_up hung on curl forever: 1 push, then nothing.
  assert.ok(pushes >= 3, `expected >= 3 pushes in 7 s with Horizon hung, got ${pushes}:\n${out}`);
  assert.match(readFileSync(script, "utf8"), /curl -fsS --max-time "\$\{HORIZON_TIMEOUT:-10\}"/);
});

test("D-02: friendbot top-up CLI calls run under a timeout", () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../nav-keeper.sh"), "utf8");
  const topUp = src.slice(src.indexOf("top_up() {"), src.indexOf("\n}\n", src.indexOf("top_up() {")));
  assert.match(src, /slow_cli\(\) \{ timeout -k 5 "\$TOPUP_TIMEOUT" "\$STELLAR" "\$@"; \}/);
  assert.doesNotMatch(topUp, /"\$STELLAR"/, "top_up must call the CLI through slow_cli only");
  assert.equal((topUp.match(/slow_cli /g) ?? []).length, 3);
});
