# Chain data and RPC usage audit

Commit audited: [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) (26 Oct 2026). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the audited commit.

Scope: how the keeper (`scripts/keeper`), the NAV keeper (`scripts/nav-keeper.sh`), the web app and the landing page read chain data and talk to Stellar RPC and Horizon. The method was the Stellar Raven (https://raven.stellar.org) data playbook from the [stellar-dev-skill](https://github.com/stellar/stellar-dev-skill) (sections stellar-rpc, best-practices, historical-data-access and network-configuration) plus the Stellar docs page on migrating from Horizon to RPC. Findings were reproduced with keeper `--once --dry-run` runs, read-only RPC probes against testnet, and a local fault-injection proxy that forwards a set number of requests to the real RPC or Horizon and then either stops answering or returns HTTP 503. No transaction was sent. An independent QA pass re-ran every repro, re-rated severity and added one finding (Q-01).

Bottom line: the data model is sound. Nothing depends on events or transaction history, so the roughly 7-day RPC retention window does not matter: the keeper re-reads contract state every tick and catches up on its own after an outage of any length. The weak point was liveness: a hung or failing RPC or Horizon stalled the keeper and the NAV keeper with no alert, and the app had no read timeouts. Those five findings are fixed on main. Six Low robustness items are on the roadmap.

Live limits measured on the public testnet RPC (`soroban-testnet.stellar.org`): `getHealth` reports a `ledgerRetentionWindow` of 120,960 ledgers (7.0 days); `getLedgerEntries` accepts 200 keys and rejects 201; `rpc.Server` in SDK 16.4.1 sets no request timeout (the declared `Options.timeout` is ignored), so a stalled call ends only at the HTTP client's 300 s default.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| D-01 | Medium | Keeper RPC calls have no timeout; a hung RPC stalls it silently | Fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4) |
| D-02 | High | A hung Horizon stops every NAV push | Fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4) |
| D-03 | Medium | Failed keeper ticks never alert | Fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4) |
| D-04 | Low | Keeper reads spend a `getAccount` call and misreport outages | Fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4) |
| D-05 | Low | No backoff on 429/503; one failed repo read aborts the tick | Roadmap (R14 Client and RPC robustness) |
| D-06 | Low | Keeper reads repos one simulation at a time | Roadmap (R14 Client and RPC robustness) |
| D-07 | Low | Balances come from Horizon, the book from RPC | Roadmap (R14 Client and RPC robustness) |
| D-08 | Low | Network config is not per network | Roadmap (R14 Client and RPC robustness) |
| D-09 | Low | No RPC health or lag check | Roadmap (R14 Client and RPC robustness) |
| D-10 | Low | Poll budget is shorter than the transaction timebound | Roadmap (R14 Client and RPC robustness) |
| Q-01 | Low | App RPC and Horizon reads have no timeout | Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211) |

Status counts: Fixed 5 · Partly fixed 0 · Roadmap 6 · Won't fix 0 · Open 0.

### D-01: Keeper RPC calls have no timeout; a hung RPC stalls it silently

- Severity: Medium (reported High; lowered on QA review)
- Status: Fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4)
- Location: `scripts/keeper/src/chain.ts:35`, `scripts/keeper/src/chain.ts:62`, `scripts/keeper/src/chain.ts:76`, `scripts/keeper/src/keeper.ts:516-533`
- Finding: The keeper built `new rpc.Server` with no timeout. Against an RPC that accepts connections and never answers, `keeper --once --dry-run` printed nothing and was killed by the test cap at 75 s; a single stalled call returned only after about 300 s and then crashed as "Account not found". The process stayed alive, so the service manager did not restart it and no alert fired. A tick makes about seven sequential reads, so a fully hung RPC could keep it blind far longer than the demo's 120 s margin window. QA lowered it to Medium: the HTTP client does bound each call at about 300 s, the keeper recovers once the RPC answers, and the contract re-checks every action, so the result is a late action, never a wrong one.
- Fix: `server.httpClient.defaults.timeout = RPC_TIMEOUT_MS` (15 s) in `scripts/keeper/src/chain.ts`, plus a tick watchdog (`scripts/keeper/src/watchdog.ts`): with no RPC answer for 90 s inside a tick the keeper raises "ALERT keeper hung" and exits 1 so it is restarted. A startup failure is now one line and exit 1. Regression tests in `scripts/keeper/src/liveness.test.ts`: "D-01: every RPC request is bounded by RPC_TIMEOUT_MS (default 15 s)", "D-01: the tick watchdog fires with no RPC answer, an answer pushes it back, clear stops it" and "D-01: chain.ts reports every RPC answer to the watchdog hook". Re-running the fault injection: a hung RPC at startup now exits after 16 s, and a hang mid-run alerts and exits 90 s into the tick.

### D-02: A hung Horizon stops every NAV push

- Severity: High
- Status: Fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4)
- Location: `scripts/nav-keeper.sh:114-117`, `scripts/nav-keeper.sh:124-125`, `scripts/nav-keeper.sh:136-139`
- Finding: The NAV keeper's balance check ran `curl -fsS` with no `--max-time`, and curl has no default total timeout. Its friendbot top-up ran two `stellar` CLI calls outside the existing CLI timeout. The top-up runs on every loop pass, so a Horizon that accepts and never answers froze the loop before it reached `push` (the repro was killed by its 90 s cap; a 503 control returned at once). NAV then goes stale 180 s after the last push, and takes, margin checks and liquidations stop app-wide with `StaleNav`. The NAV keeper's own alert lives inside `push()` and never ran, and the keeper only alerts on stale NAV for repos that have already defaulted.
- Fix: `curl -fsS --max-time "${HORIZON_TIMEOUT:-10}"`, and every top-up CLI call goes through `slow_cli` (`timeout -k 5 60`). Regression tests "D-02: nav-keeper keeps pushing while Horizon hangs (curl --max-time, stubbed stellar CLI)" (at least 3 pushes in 7 s against a hung Horizon; the old script makes 1 and fails the test) and "D-02: friendbot top-up CLI calls run under a timeout". The Horizon-hang repro now returns after 10 s.

### D-03: Failed keeper ticks never alert

- Severity: Medium
- Status: Fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4)
- Location: `scripts/keeper/src/keeper.ts:516-526`, `scripts/keeper/src/keeper.ts:172-181`
- Finding: The main loop's catch only logged `tick failed`, and the alert helper `stuck()` was reachable only inside a tick. With the RPC returning 503 after 60 requests, the keeper daemon logged 17 `tick failed` lines in 50 s and raised 0 alerts; the alert command never ran. QA added that under a hang the startup path crashed only once every ~300 s, too slowly to trip the service manager's start limit, so its failure hook did not fire either.
- Fix: the loop counts consecutive failed ticks and raises "keeper blind: tick failed, cannot read the chain" on the second in a row, repeated every `ALERT_REPEAT_SECS` and reset by a good tick. Regression test "D-03: failed ticks ALERT on the 2nd in a row, repeat every ALERT_REPEAT_SECS, reset on a good tick". The 503 fault run now alerts on the second failed tick.

### D-04: Keeper reads spend a `getAccount` call and misreport outages

- Severity: Low (reported Medium; lowered on QA review)
- Status: Fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4)
- Location: `scripts/keeper/src/chain.ts:61-67`, `scripts/keeper/src/chain.ts:70-80`
- Finding: Every read-only `view` built a transaction from `server.getAccount(ADMIN_ADDRESS)`, although simulation needs no funded source (the app already uses `NULL_ACCOUNT`). One `--once --dry-run` made 48 RPC calls, 24 of them these `getAccount` reads. The SDK turns any `getAccount` failure into "Account not found", so during an RPC outage every log line read `tick failed: Account not found: G…`, pointing the operator at a testnet reset instead of the RPC. Impact is a misleading log and double the calls, with no wrong action, so QA rated it Low.
- Fix: `view` simulates from `new Account(NULL_ACCOUNT, "0")`; only `invokeOnce` calls `getAccount`. Regression tests "D-04: view simulates from NULL_ACCOUNT with no getAccount call" and "D-04: an RPC outage reads as the RPC error, not 'Account not found'". On the same live book, a dry run went from 50 calls to 27.

### D-05: No backoff on 429/503; one failed repo read aborts the tick

- Severity: Low
- Status: Roadmap ([R14 Client and RPC robustness](../../README.md#production-notes-raven-audit-roadmap))
- Location: `scripts/keeper/src/chain.ts:94-101`, `scripts/keeper/src/keeper.ts:224-245`, `app/src/App.tsx:86-101`
- Finding: The keeper retries only send errors, with a fixed 3 s wait, and the app does not retry at all. The playbook's `withRetry` backs off `2^i` seconds on 429. One failed `readRepo` aborts the whole tick for every repo. With a handful of live repos, one lost tick costs 10 s, so this is low today.
- Fix: planned: `withRetry` on 429/503 in `view`, and a per-repo try/catch so one bad read skips only that repo.

### D-06: Keeper reads repos one simulation at a time

- Severity: Low
- Status: Roadmap ([R14 Client and RPC robustness](../../README.md#production-notes-raven-audit-roadmap))
- Location: `scripts/keeper/src/keeper.ts:224-245`, `scripts/keeper/src/repos.ts:41-60`
- Finding: The keeper simulates one read per repo per tick, in sequence, and its set of settled repos lives in memory, so after every restart it reads every terminal repo again. The load grows with every repo ever created. Measured on the live book: 4 repos took 1 batched `getLedgerEntries` call in 281-374 ms against 10 calls in 1.5-3.1 s.
- Fix: planned: batch-read `Repo(i)` keys in chunks of at most 200, sharing the app's `book.ts` helper; keep simulation for `check_margin`.

### D-07: Balances come from Horizon, the book from RPC

- Severity: Low
- Status: Roadmap ([R14 Client and RPC robustness](../../README.md#production-notes-raven-audit-roadmap))
- Location: `app/src/chain.ts:166-195`, `scripts/nav-keeper.sh:114-117`
- Finding: The app reads XLM, USDC and tBENJI balances from Horizon `/accounts` and the order book from RPC, so the two can show different ledgers. The playbook prefers RPC for real-time account state, and the docs map balances to one account key plus trustline keys. QA noted the rule is soft, since the playbook still lists Horizon for rich account metadata.
- Fix: planned: one `getLedgerEntries` call with the account key and the two trustline keys.

### D-08: Network config is not per network

- Severity: Low
- Status: Roadmap ([R14 Client and RPC robustness](../../README.md#production-notes-raven-audit-roadmap))
- Location: `scripts/keeper/src/chain.ts:33-35`, `scripts/keeper/src/chain.ts:39`, `app/src/config.ts:6`, `app/src/config.ts:9`, `scripts/nav-keeper.sh:38-40`
- Finding: The keeper falls back to the testnet RPC for any `NETWORK` value and accepts unknown values; its explorer path uses `mainnet` where stellar.expert uses `public`. The app hard-codes the testnet passphrase and explorer while the network name comes from `testnet.json`. Everything runs on testnet today, so this is latent. QA corrected one detail: the keeper already throws when `NETWORK_PASSPHRASE` is missing off testnet, so only `RPC_URL` needs a required check there.
- Fix: planned: one `configs[network]` map in keeper and app; require `RPC_URL` and the passphrase off testnet; throw on an unknown network.

### D-09: No RPC health or lag check

- Severity: Low
- Status: Roadmap ([R14 Client and RPC robustness](../../README.md#production-notes-raven-audit-roadmap))
- Location: `scripts/keeper/src/keeper.ts:80`, `scripts/keeper/src/keeper.ts:296-297`
- Finding: Maturity and deadline checks use wall-clock time, and nothing calls `getHealth` or `getLatestLedger`. A lagging RPC node serves old state. The contract re-checks every action, so the cost is noise and a late action, not a wrong one.
- Fix: planned: call `getHealth` at tick start and skip the tick (counting toward the blind alert) when the latest ledger closed more than 30 s ago.

### D-10: Poll budget is shorter than the transaction timebound

- Severity: Low
- Status: Roadmap ([R14 Client and RPC robustness](../../README.md#production-notes-raven-audit-roadmap))
- Location: `scripts/keeper/src/chain.ts:65`, `scripts/keeper/src/chain.ts:121`, `app/src/chain.ts:394`, `app/src/chain.ts:404`
- Finding: Keeper transactions have a 60 s timebound but `pollTransaction` gives up after 30 attempts of about 1 s (35-40 s with round trips). A slow inclusion is logged as a failed transaction while it can still land. The next tick re-reads state, so the cost is a false failure. The app has the same gap (120 s timebound, 20 attempts).
- Fix: planned: poll attempts that cover the timebound, or a shorter timebound.

### Q-01: App RPC and Horizon reads have no timeout

- Severity: Low (added on QA review)
- Status: Fixed in [1b4c211](https://github.com/rcusans-code/Caravel/commit/1b4c211)
- Location: `app/src/book.ts:7`, `app/src/chain.ts:167`, `app/src/App.tsx:129`, `app/src/App.tsx:141`
- Finding: QA found the checklist's "every call is bounded elsewhere" row was wrong for the app. `new rpc.Server(RPC_URL)` and the Horizon `fetch` had no timeout; only the landing page bounded its load (5 s). On a hung RPC the app kept showing a stale book and stale balances with no error, while `setInterval` stacked a new read every 10 s.
- Fix: `app/src/net.ts` sets `httpClient.defaults.timeout` to 15 s on the shared server, and every contract client (reads and writes) uses it. Horizon reads use `fetchWithin` (`AbortSignal.timeout`, 10 s), friendbot 30 s. A timeout maps to "Testnet RPC did not answer". Regression test "Q-01 a hung RPC or Horizon fails the read within its timeout" in `app/test/raven-r3.test.ts`.

## What was checked

| Check | Result | Finding |
|---|---|---|
| RPC used for contract reads, simulation and submission | pass | |
| Testnet RPC endpoint `soroban-testnet.stellar.org` | pass | |
| Contract storage read with `getLedgerEntries` | pass (app), fail (keeper) | D-06 |
| At most 200 keys per `getLedgerEntries` call | pass (150 per call; 201 rejected live) | |
| Missing keys not treated as errors; entries matched by key | pass | |
| `isSimulationError` checked before using a result | pass | |
| Poll `getTransaction` until it leaves NOT_FOUND | partial | D-10 |
| No dependence on events or history older than about 7 days | pass (nothing reads events or history) | |
| `getLedgers` depth vs `oldestLedger` | N/A (not used) | |
| Poll for updates, no streaming | pass (10 s) | |
| RPC for real-time account state | fail | D-07 |
| 400 told apart from 503 | fail | D-03, D-04 |
| Exponential backoff on 429 | fail | D-05 |
| Cache responses where appropriate | partial | D-04 |
| One config per network; mainnet RPC from env; throw on unknown network | fail | D-08 |
| `getHealth` / `getLatestLedger` for node state | fail | D-09 |
| Every call to RPC or Horizon bounded | fail (keeper, NAV keeper and app); pass (landing, NAV keeper CLI) | D-01, D-02, Q-01 |
| Own node for high volume; history from an indexer | N/A (demo volume, no history feature) | |

## Not re-reported

An earlier internal review had already covered four related items: missing fields in the contract's events, the 6-day instance TTL on testnet, the NAV keeper re-posting the last price with a fresh timestamp after a restart (documented as accepted), and the NAV keeper's CLI timeout, which was already fixed. Not checked: keeper and app behaviour on archived entries (nothing on testnet was old enough) and real public RPC rate limits (none are published).
