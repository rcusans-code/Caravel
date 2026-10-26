# Scripts

## `deploy.sh`: one-command testnet deploy

Needs `stellar` CLI 28.x, `python3`, `curl`, and the burner keys in the repo-root `.env`.

```sh
scripts/deploy.sh                # build, deploy what changed, apply config (~50 s fresh, ~5 s no-op)
scripts/deploy.sh --fresh        # force a new oracle + repo contract
NAV=0.97 scripts/deploy.sh       # also push a tBENJI price (default 1.00, only if none is set)
SAFO_NAV=1.02 scripts/deploy.sh  # same for tSAFO
SKIP_BINDINGS=1 scripts/deploy.sh
scripts/deploy.sh --preflight    # guards only: .env complete, *_ASSET derive to *_SAC; no build, no tx
scripts/deploy.sh --no-winddown  # leave the repo contract this run replaces open
PREBUILT_WASM_DIR=/tmp/wasm scripts/deploy.sh   # deploy attested wasm from attest.yml instead of building
scripts/test/deploy-guards.test.sh              # offline tests for the guards below (21 checks)
```

What it does, idempotently (each step reads chain state first and only sends a tx if it differs):

0. Guards (Raven R4): `USDC_ASSET` and `TBENJI_ASSET` are required, and each must derive to its `*_SAC` (`stellar contract id asset`, local), else the run stops before any build or tx (AS-05).
1. `stellar contract build --meta source_repo=github:rcusans-code/Caravel --meta commit_sha=<HEAD>` (repo, oracle, and the tSAFO mock; `-dirty` is appended when `contracts/` has uncommitted changes). The SEP-46 meta lands on-chain with the next deploy of each contract: `stellar contract info meta --id <REPO_ID> --network testnet` (STD-05). Reuse compares the on-chain wasm without its `contractmetav0` section (`scripts/wasm-code-hash.py`), because `commit_sha` changes the raw hash on every commit; compare wasm by hand the same way.
2. Tops ADMIN up to 6,000 XLM by merging a friendbot-funded throwaway account into it (testnet rent is steep: a wasm upload costs ~1,000–1,500 XLM).
3. Mock oracle: reused if the on-chain wasm matches the build, otherwise deployed with admin = ADMIN, base `Other("USD")`, 14 decimals, resolution 60. Sets tBENJI (`Stellar(TBENJI_SAC)`) to 1.00 if it has no price.
   tSAFO (collateral #2, issue #20): `contracts/spiko-mock`, a Spiko-style token (allowlist checked on every transfer, no `approve`/`transfer_from`, issuer pause, 5 decimals like Spiko's mainnet tokens). Reused if the wasm matches, otherwise deployed with admin = ISSUER; `TSAFO_ID` goes into `.env`. Priced at 1.00 if it has none.
4. Repo contract: reused if wasm and `config()` match, otherwise deployed with the demo profile (#5): fee 1000 bps (#3), liquidation discount 200 bps (#4), `day_secs` 60, margin window 120 s, grace 60 s. Treasury = ADMIN (override with `TREASURY_ADDRESS`). Guardian (#33) is a key of its own, not ADMIN: with no `GUARDIAN_ADDRESS` in `.env`, the run that deploys a new repo contract generates a funded testnet key and writes `GUARDIAN_ADDRESS` / `GUARDIAN_SECRET` to `.env` (never printed). `Config` has no setter, so a reused repo keeps its on-chain guardian and a no-op run stays a no-op; the separate guardian goes live with the next redeploy. Set `GUARDIAN_ADDRESS` yourself to pin one.
5. `set_asset(tBENJI, { Stellar(TBENJI_SAC), haircut 300 bps, margin trigger 200 bps, enabled, max NAV age 180 s, max NAV move 2,500 bps, max open debt 100,000 USDC, band settle 1,200 s })` (#26: discount ≤ trigger < haircut; #25: staleness is per asset; #31: NAV sanity band; #32: exposure cap) and `set_asset(tSAFO, { Stellar(TSAFO_ID), haircut 3000 bps, margin trigger 2000 bps, enabled, max NAV age 180 s, max NAV move 2,500 bps, max open debt 50,000 USDC, band settle 1,200 s })` (testnet only, DECISIONS #29; override with `MARGIN_TRIGGER_BPS`, `SAFO_MARGIN_TRIGGER_BPS`, `SAFO_HAIRCUT_BPS`, `SAFO_MAX_NAV_AGE_SECS`, `NAV_MOVE_BPS`, `SAFO_NAV_MOVE_BPS`, `MAX_OPEN_DEBT`, `SAFO_MAX_OPEN_DEBT`, in whole USDC; `BAND_SETTLE_SECS`, `SAFO_BAND_SETTLE_SECS`).
6. `set_liquidator(LIQUIDATOR, true)`.
7. Issuer `set_authorized(…, true)` on tBENJI for the repo contract, borrower and liquidator (AUTH_REQUIRED, see `spikes/auth`). For the repo contract a failed `set_authorized`, or `authorized` still false after it, stops the deploy (AS-06: otherwise every tBENJI take fails with the SAC's #11); the wallets only WARN (no trustline yet).
   Issuer `set_whitelisted(…, true)` on tSAFO for the repo contract, the liquidator, the borrower and lender wallets, plus any `TSAFO_HOLDERS` (space-separated). Without the repo contract and every liquidator on the list, takes and liquidations revert with the token's `NotWhitelisted` (#100). Then mints `TSAFO_BORROWER_MINT` (2,000) tSAFO to the borrower if it holds none, and `TSAFO_HOLDER_MINT` (200) to each `TSAFO_HOLDERS` address if it holds none.
8. Writes `ORACLE_ID`, `REPO_ID`, `TSAFO_ID`, `DEPLOYED_AT` (and a new `GUARDIAN_*`) into `.env` and the public `deployments/testnet.json` (IDs, addresses incl. guardian, params) for the app. The keepers run on a copy of `.env`: re-run the `install -Dm600 .env …` line below after every deploy that changed an ID.
   A replaced `REPO_ID` is prepended to `superseded` in `deployments/testnet.json` (newest first, kept across runs).
9. Regenerates TS bindings in `packages/caravel-repo` and `packages/caravel-oracle` when a contract ID changes.
10. Winds down the repo contract it replaced (`scripts/winddown.sh <old REPO_ID>`, below), after the new one is live; a failure there only WARNs. `--no-winddown` or `WINDDOWN=0` skips it.

Every param can be overridden from the environment (`HAIRCUT_BPS`, `SAFO_HAIRCUT_BPS`, `TSAFO_DECIMALS`, `MAX_NAV_AGE_SECS`, `SAFO_MAX_NAV_AGE_SECS`, `NAV_MOVE_BPS`, `SAFO_NAV_MOVE_BPS`, `MAX_OPEN_DEBT`, …); see the top of the script.

Dry run, 25 Oct, on throwaway keys and a separate `ENV_FILE` (the app's deployment untouched): fresh deploy in 129 s (oracle, tSAFO, repo, both `set_asset`, allowlist, mint), a re-run in 14 s with no tx. On that deployment, with the CLI: tSAFO `take_offer` with no approve (100 USDC against 142.99413 tSAFO at 30%), `repay`, `default` → `liquidate` to the allowlisted liquidator; a borrower off the allowlist fails with `Error(Contract, #100)`, a paused token with `#101`, and the offer stays open.

The mock price goes stale after tBENJI's `max_nav_age_secs` (180 s, set per asset): `nav-keeper.sh` or the TypeScript keeper with `--refresh-nav` (both below) keep it fresh. By hand:
`stellar contract invoke --network testnet --source-account <admin> --id $ORACLE_ID -- set_price --asset '{"Stellar":"'$TBENJI_SAC'"}' --price 100000000000000`.

## `winddown.sh`: close superseded repo contracts (UA-05)

Contracts are immutable (DECISIONS: versioned redeploys), so every redeploy leaves the old repo contract holding escrowed offers and maybe live repos that the app and keeper no longer show. `deploy.sh` calls this for the contract it replaces; run it by hand for older ones.

```sh
scripts/winddown.sh --dry-run          # every id in deployments/testnet.json "superseded"; simulate only
scripts/winddown.sh --dry-run C… C…    # just these
scripts/winddown.sh                    # send: pause + cancel our offers on every superseded contract
```

Per contract: (1) `no_new_repos` on every listed asset (admin `set_pause`, else `guardian_set_pause`, else admin `set_asset` with `enabled: false` on pre-#30 contracts), so nobody takes a stale offer; (2) `cancel_offer` for each open offer whose lender key is in `.env` (demo lender and the other burner wallets), which returns the escrowed USDC; (3) lists offers of other lenders (they must call `cancel_offer` on that contract themselves) and live repos (Open / MarginCall / Defaulted), which settle on their own terms: repay, top-up, default and liquidate are never paused by this. `--dry-run` simulates every tx with `--send=no` (simulation records auth instead of checking signatures, so it proves the call logic, not the key). Testnet only; refuses the live `REPO_ID`. Keys go to the CLI only, never printed.

Dry run, 26 Oct, on the 10 superseded contracts: 17 open offers / 1,445 USDC, 11 / 1,100 USDC cancellable with `.env` keys, 6 / 345 USDC held by GDFLRCV4…, 1 Defaulted repo (CCFP3L7T… #8).

## Build provenance (SEP-55): `.github/workflows/attest.yml`

On a `v*` tag or a manual run, the workflow builds the three wasm files with the same meta, attests them (`actions/attest-build-provenance`) and uploads the `contracts-wasm` artifact. To make the testnet contract verifiable, deploy those exact bytes: `gh run download <run-id> -n contracts-wasm -D /tmp/wasm`, then `PREBUILT_WASM_DIR=/tmp/wasm scripts/deploy.sh`; `stellar contract info build --id <REPO_ID> --network testnet` then finds the attestation. A local build carries the meta but no attestation.

## `onboard.sh`: give a team wallet access and a test allowance

The public app is read-only for any wallet whose tBENJI trustline is not AUTHORIZED by the issuer; that on-chain flag is the only allowlist. With `TSAFO_ID` in `.env`, step 6 also puts the wallet on the tSAFO allowlist and mints it tSAFO (`TSAFO_AMOUNT`, default = `tbenji_amount`); tSAFO needs no trustline.

```sh
scripts/onboard.sh <G-address> [tbenji_amount=200] [usdc_amount=100]
```

Idempotent, amounts are targets (a re-run tops up to them, never beyond). Step 7 prints the liquidator checklist (below); `LIQUIDATOR=1 scripts/onboard.sh <addr>` exits 3 when an item is missing.

1. Unfunded account: friendbot funds it.
2. Missing tBENJI or USDC trustline: prints how to add it and exits 2. Only the wallet owner can sign a trustline: in the app, connect and press **Add … trustline** (one tx for both), then re-run.
3. Issuer `set_authorized(addr, true)` on the tBENJI SAC (skipped if `authorized(addr)` is already true).
4. Issuer pays tBENJI up to `tbenji_amount` (a payment from the issuer mints).
5. ADMIN pays USDC up to `usdc_amount`. If ADMIN holds too little, it first runs `buy-usdc.sh` for the shortfall (min 100).
6. With `TSAFO_ID`: issuer allowlists the wallet on tSAFO and mints it up to `TSAFO_AMOUNT`.
7. Liquidator checklist, read only: tBENJI authorized, tSAFO allowlisted, USDC balance, `is_liquidator` on `REPO_ID`.

### Liquidator checklist

`set_liquidator` checks nothing (CMP-05, F-25): a whitelisted wallet that the issuer has not authorized or allowlisted makes every liquidation of that collateral revert (the token's `NotWhitelisted`, `#100`), and the repo sits `Defaulted` with the lender unpaid. Before `set_liquidator(addr, true)`:

1. tBENJI: issuer `set_authorized(addr, true)` (onboard step 3; needs the owner's trustline).
2. tSAFO: issuer `set_whitelisted(addr, true)` (onboard step 6, or `TSAFO_HOLDERS` in `.env` so every redeploy re-adds it).
3. Funded: USDC ≥ the funding floor that `npm run repos` prints: Σ debt × (1 − discount) / (1 − haircut) over the live repos, plus `LIQ_FLOOR_MARGIN_BPS` (default 10%). A liquidation sells the whole collateral, so per 100 USDC of debt the liquidator fronts 101.03 USDC on tBENJI (haircut 3%) and 140.00 on tSAFO (30%), before the margin. Top up with `scripts/buy-usdc.sh <amount> <addr>`.
4. `scripts/onboard.sh <addr>` shows all four; then admin `set_liquidator --liquidator <addr> --allowed true`.

The keeper also checks items 1–2 for the live liquidator every tick and alerts when one fails (Alerts, below).

Tested 25 Oct on fresh throwaway keys: unfunded -> funded + exit 2 (no trustlines) -> trustlines added with the throwaway key -> 200 tBENJI (authorized) + 100 USDC; a re-run sends nothing. Two onboarded throwaways then ran create_offer -> take_offer -> repay end to end.

## `buy-usdc.sh`: testnet USDC from the DEX

There is no Circle USDC faucet on testnet. `scripts/buy-usdc.sh [amount=100] [destination=ADMIN]` buys it on the SDEX with friendbot XLM: per 500 USDC chunk, friendbot funds a throwaway account, which sends a `path-payment-strict-receive` (XLM -> USDC, Horizon-quoted, 3% slippage) straight to the destination and then merges its leftover XLM into ADMIN. ADMIN's own XLM is not spent. Price on 25 Oct: ~1.15 XLM per USDC (500 USDC for ~572 XLM). The destination needs a USDC trustline.

## `nav-keeper.sh`: keep the collateral NAVs fresh

Takes and liquidations revert with `StaleNav` when the oracle price is older than 180 s. The keeper re-posts the oracle's current tBENJI price every 60 s, and tSAFO's too when `TSAFO_ID` is set (`NAV=0.97` / `SAFO_NAV=1.02` pin a value instead; with no price at all it posts 1.00), so a value set from the app's Admin tab sticks. Attempts are interleaved: tBENJI, tSAFO, then a retry of whichever failed, 3 attempts per asset 3 s apart, so one asset's failures never delay the other's push. Every CLI call is capped at `CLI_TIMEOUT` (20 s; a hung attempt used to take ~50 s, and tSAFO went stale for 220 s during the 25 Oct redeploy, KPR-03) and pays `INCLUSION_FEE` (100,000 stroops, like the TS keeper). After a failed round the next one starts after 15 s. An asset that fails `ALERT_AFTER` (2) rounds in a row logs `ALERT tSAFO set_price failed 2 rounds in a row …` and runs `ALERT_CMD`, again every 20 failed rounds. The two pushes cannot be sent in parallel: both are signed by the one oracle admin key, and the network queues one pending transaction per source account. (Back-to-back pushes sometimes fail simulation with `ResourceLimitExceeded` on write bytes; the retry lands.)

```sh
scripts/nav-keeper.sh --once     # one push
scripts/nav-keeper.sh            # loop (INTERVAL=60)
```

On sim-server it runs as a systemd user service (linger is on, so it survives logout and reboot):

```sh
install -Dm755 scripts/nav-keeper.sh ~/.local/lib/caravel/nav-keeper.sh   # copy: branch switches cannot break it
install -Dm600 .env ~/.local/lib/caravel/.env                             # copy of the keys + IDs (both keepers)
install -Dm755 scripts/caravel-alert.sh ~/.local/lib/caravel/caravel-alert.sh
install -Dm644 scripts/caravel-alert@.service ~/.config/systemd/user/caravel-alert@.service
install -Dm644 scripts/caravel-nav-keeper.service ~/.config/systemd/user/caravel-nav-keeper.service
systemctl --user daemon-reload && systemctl --user enable --now caravel-nav-keeper
systemctl --user status caravel-nav-keeper; journalctl --user -u caravel-nav-keeper -f
```

It reads keys and `ORACLE_ID` from `~/.local/lib/caravel/.env` (the unit's `ENV_FILE`, logged on the start line) every round, so after a redeploy re-running the `install -Dm600 .env` line is enough, no restart. The copy keeps a branch switch or a conflict marker in the checkout's tracked `.env` from repointing the service (KPR-02). Re-run the `install` lines after editing the script.

**Jump refusal (keeper-launder).** Re-posting is what would turn one bad push into an accepted price: 20 re-posts fill the contract's 20-record band window (#31), so `check_band` passes, and push the pre-jump price out of the keeper's `prices(asset, 20)` history. So `nav-keeper.sh` never re-posts a price more than `NAV_JUMP_ACK_BPS` (1000, the keeper's needs-ack class, below) away from the last price it posted, unless that exact price is in `NAV_JUMP_ACK` (no spaces: the script sources `.env`) or pinned with `NAV` / `SAFO_NAV`. It logs `tBENJI NOT re-posting 50000000000000: 5000 bps from the last posted 100000000000000 …` every round, sends an `ALERT` on the first refused round and every 20th, and lets the price go stale: after `max_nav_age_secs` the contract refuses takes, margin calls, missed-call defaults and liquidations; repay and top-up still work. Fix it the same way as for the keeper: push the corrected price (runbook below, it is re-posted at once), or ack the price if it is real. Moves up to 10% (the Admin slider's 0.90–1.10) are re-posted as before; the keeper's 180 s jump hold covers them. The last posted price per asset is kept in `NAV_KEEPER_STATE` (default `~/.local/state/caravel/nav-keeper-<ORACLE_ID>.state`, one file per oracle), so a restart keeps it; with no file yet it trusts the current price.

**Cost:** each `set_price` costs ~9 XLM per asset in fees at today's testnet rates (the oracle rewrites its 20-entry price history). At one push per ~70 s that is ~11,000 XLM/day. The keeper merges a friendbot-funded account into ADMIN (+~10,000 XLM) whenever ADMIN drops below `MIN_ADMIN_XLM` (3,000). The balance read is capped at `HORIZON_TIMEOUT` (10 s, `curl --max-time`) and each friendbot / merge CLI call at `TOPUP_TIMEOUT` (60 s), so a hung Horizon or friendbot skips the top-up and the next push still runs (Raven D-02: an uncapped `curl` used to stop every push after the first one).

The TypeScript keeper (`scripts/keeper`, below) sends `check_margin`, `default` and `liquidate`; on sim-server it runs as `caravel-keeper.service`. The testnet repo contract is deployed from main 72dd78a (all eight attack fixes, a guardian key of its own): margin calls, auto-repay, per-asset NAV staleness (DECISIONS #25), tSAFO collateral (issue #20), pause switches (#28), NAV sanity band (#26), exposure caps (#29) and the rule #20 change (a missed margin call clears at `default` when a fresh NAV shows the loan recovered) are live. Against an older deployment `check_margin` may return `NotImplemented`; the keeper logs that once per repo and skips it.


## `keeper/`: keeper + NAV setter

TypeScript, Node 20+. Reads `REPO_ID`, `ORACLE_ID`, `TBENJI_SAC`, `TSAFO_ID` (optional), `USDC_SAC` and keys from the repo-root `.env` at start (no bindings rebuild needed; it talks to the contracts with `@stellar/stellar-sdk` directly). From a worktree run it with `ENV_FILE=~/src/caravel/.env`; the systemd unit uses the install-time copy `~/.local/lib/caravel/.env`. The start line names the file (`env …`). The NAV jump latch and the last released price per asset are kept in `NAV_STATE_FILE` (default `~/.local/state/caravel/navguard-<ORACLE_ID>.json`, named on the start line), so a restart or a `--once` run on the same machine and user sees the live keeper's latch; `--dry-run` reads it but never writes it. A `--once` run as another user or host starts empty, so do not run it there while the live keeper logs a `needs-ack` / `latched` hold. When `REPO_ID` in its `.env` changes (redeploy or `seed --reset`, then the `install -Dm600 .env` line for the service copy) it logs one line and exits; the systemd unit restarts it on the new IDs. Run by hand, restart it yourself.

```sh
cd scripts/keeper && npm install
npm run keeper                      # poll every 10 s
npm run keeper -- --refresh-nav     # also re-post the last NAV once it is ≥120 s old (max age 180 s)
npm run keeper -- --once            # one tick (check_margin / default / liquidate / auto_repay as due), then exit; exit 1 if the tick threw (RPC/read error), any refresh-nav / auto_repay / default / check_margin / liquidate call failed, or a payout is stuck (ALERT, below); NAV jump holds, StaleNav / NavOutOfBand skips outside liquidation, NotDefaultable / NotDue (pending) and AutoRepayFailed (short) exit 0
npm run keeper -- --once --dry-run  # same, but only simulates: logs "would send …", never sends a tx
npm run repos                       # every repo: status, maturity, lender, debt; lender + liquidator USDC vs the funding floor (OK / SHORT + buy-usdc.sh command)
npm run set-nav -- 0.97             # admin: oracle set_price(Stellar(TBENJI_SAC), 0.97 × 10^decimals())
npm run set-nav -- 1.02 tsafo       # same for Stellar(TSAFO_ID)
```

Each repo is priced and labelled by its own collateral (tBENJI or tSAFO); `--refresh-nav` refreshes every asset's price.

Each tick the keeper:

1. Walks repo ids `1, 2, …` via the `repo(id)` view until `RepoNotFound`. Only `Repaid` and `Liquidated` repos are remembered and not read again; `Defaulted` stays live because the lender is not paid until `liquidate`.
2. `default(id)` once the margin window has passed (`MarginCall` and now > `margin_call_deadline`) or now > maturity + grace, then `liquidate` in the same tick. A maturity default needs no NAV. On a missed margin call the contract first re-checks the breach at a fresh NAV (DECISIONS #20): if the loan is back above the trigger, `default` clears the call and returns `Open`, the keeper logs `CLEARED` and liquidates nothing. An opted-in auto-repay repo with a missed call goes to `default` too, so the clear comes before the pull. Ledger time can lag the wall clock by a few seconds; a `NotDefaultable` simulation just means "next tick".
3. `liquidate(LIQUIDATOR, id)` on every `Defaulted` repo (defaulted by the keeper or by anyone else). The liquidator pays collateral × NAV × (1 − 1%) in USDC; the lender gets principal + interest − fee first, the treasury the fee, the borrower any rest. Before sending it checks NAV age ≤ the asset's `max_nav_age_secs` and the liquidator's USDC ≥ proceeds; if either fails it logs one line (with the `buy-usdc.sh` command to top up) and retries every tick. That repo is stuck (lender unpaid, borrower's collateral frozen): after 2 more ticks the keeper logs an `ALERT` line and runs `ALERT_CMD` (Alerts, below). A `StaleNav` or `NavOutOfBand` from the contract is treated the same way.
4. For `Open` repos, simulates `check_margin(id)` and sends the tx only when it would return `MarginCall` (no fee spent on healthy repos). `StaleNav` and `NavOutOfBand` (#31) are logged once and skipped (#17). Before the repos, each tick simulates `note_nav(asset)` per collateral asset and sends it only when the NAV level moved past the band (log line `nav-level`), so the repo's band settle clock starts one tick after a real move; a contract without `note_nav` is logged once and skipped. On `auto_repay`, `NotDue` (ledger clock lag) means "next tick", like `NotDefaultable`.
5. `MarginCall` repos wait for a top-up, repay or the deadline.

Before the repo actions it also reconciles collateral (Raven AS-02, `src/reconcile.ts`): per collateral token, the repo contract's `balance` against the sum of `collateral_amount` over `Open`, `MarginCall` and `Defaulted` repos. A deficit means the issuer clawed back (or burned) part of the pooled balance; the first repos to settle are still paid in full and the last one cannot repay or be liquidated. It logs `collateral   collateral short: …` at once and ALERTs from the second tick in a row (runbook "Collateral short", below). Collateral parked for a refused push (`claimable_collateral`) shows as surplus, so a clawback smaller than the parked amount is not seen; clawback-safe accounting in the contract is roadmap (R11).

Liveness (Raven D-01, D-03, D-04): every RPC request gives up after `RPC_TIMEOUT_MS` (15,000), and a tick watchdog exits the keeper (exit 1, after an `ALERT`) when no RPC call has answered for `TICK_WATCHDOG_SECS` (90) inside a tick, so systemd restarts it and a crash loop fires `OnFailure`. A slow tick that keeps getting answers (several sends in a row) is not killed. A tick that throws (RPC down, 503) logs `tick failed: …`, and the second failed tick in a row sends `ALERT keeper blind: …`. Views simulate from the SDK's `NULL_ACCOUNT` with no `getAccount` call (as the app's `book.ts` does): half the RPC calls of a tick (a `--once --dry-run` with 2 repos: 29 calls, was 54), and an outage reads as the RPC error instead of `Account not found: G<admin>`. Only a real send reads the signer's account.

NAV jump hold (flash-crash fixes #2 and #3, `src/navguard.ts`). The oracle accepts any price in one push, and `nav-keeper.sh` re-posts it every 60 s, so a fat-fingered NAV would turn into a margin call, a default and a liquidation within ~2 minutes. Each tick the keeper reads `prices(asset, 20)` (~19 min of history) per collateral asset and measures the current price against an anchor: the most recent earlier price that stood longer than the hold time (re-posts of one price count as one). While the price is held, the keeper does not send, for repos of that asset:

- `check_margin` on `Open` repos (the simulation still runs),
- `default` on a missed margin call, so a borrower called on a bad price can still top up after the correction,
- `liquidate` on `Defaulted` repos.

A maturity `default` still runs (it needs no NAV); its `liquidate` is held. Rules:

- Jump > `NAV_JUMP_BPS` (200): held until the new price has stood `NAV_JUMP_HOLD_SECS` (default margin window + 60 s, 180 s on the demo). A correction inside that time (1.00 → 0.50 → 1.00) is measured against 1.00 and not held; small steps (1.00 → 0.985 → 0.97) add up against 1.00.
- Jump > `NAV_JUMP_ACK_BPS` (1000): held until a human acks that exact price: add the oracle integer from the log line to `NAV_JUMP_ACK` in the keeper's `.env` (the service reads `~/.local/lib/caravel/.env`; comma-separated, e.g. `NAV_JUMP_ACK=97000000000000`). It is re-read every tick, no restart needed, and an acked price is not held at all. An ack never releases a different price. The first needs-ack jump latches the pre-jump price (persisted in `NAV_STATE_FILE`, so a restart keeps it; an unreadable file starts empty and sends an `ALERT`). While the latch lives, every later price is measured against that price, never against a latched bad one, so a second bad price (0.50 then 0.49) is held as well. The latch is dropped by an ack, or once no latched bad price is left in the 20-record history.
- A correction back to within `NAV_JUMP_BPS` of the latched pre-jump price is released without an ack, even after the bad price stood longer than the hold; a correction to 0.97 is a normal 300 bps jump hold.
- The keeper also remembers the last price it released per asset. If that price has left the 20-record history (the keeper was down while a bad price was re-posted 20 times), it is the anchor instead, so the jump is still seen: 1.00 → 0.50 × 20 is held for an ack after the restart. A real drift while it was down (1.0000 → 1.0001) is 1 bps and passes.
- `--refresh-nav` does not re-post a price held for an ack (or future-dated): it logs `refresh-nav  tBENJI not re-posted: …` and ALERTs after 2 ticks, and the price goes stale, like `nav-keeper.sh` above.
- A price timestamped more than 30 s in the future, a failed `prices` read, or a repo whose collateral is not a keeper asset: held, retried every tick.

Log lines, once per state change: `hold         repo 3 liquidate: NAV -50.00% vs 1.00 (stood 45s/180s), set NAV_JUMP_ACK=50000000000000 in .env to release`. The start line ends with `nav-jump hold 200bps/180s, ack >1000bps`. The cost: a real NAV move over 2% margin-calls up to 180 s later, and over 10% waits for a human, while the lender's exposure grows. Treasury NAVs move a few bps a day; the demo's `set-nav 0.97` margin call (-3%) fires ~180 s after the push. **The hold only binds our keeper.** `check_margin` and `default` are permissionless and `liquidate` is open to any whitelisted liquidator, so anyone else (the app's Check margin button, a script, another liquidator) acts on whatever price the contract accepts; navguard does not stop them. On-chain, only the staleness limit (#25), the sanity band (#31, which a 20-push window defeats), `nav_floor` / `nav_ceiling` and the guardian's `no_seize` pause apply to them. That is why `nav-keeper.sh` refuses to re-post a jump: a bad price left alone goes stale, and stale blocks every caller, ours or not. For a bad push, follow the runbook below (step 1 freezes liquidation for everyone).

Keys: signs `check_margin` / `default` with `KEEPER_SECRET` (falls back to `LIQUIDATOR_SECRET`); `liquidate` with `LIQUIDATOR_SECRET` (must be whitelisted with `set_liquidator`; the start line says so if it is not, and the liquidator receives the tBENJI); `--refresh-nav` and `set-nav` sign with `ADMIN_SECRET` (oracle admin). Flags: `--interval <s>` (10), `--refresh-secs <s>` (120). Logs one line per action, plus a line when a repo's state changes:

```
14:47:00 healthy      repo 1 Open debt 100.82 coll 103.94 ltv 97.00%
14:47:42 MARGIN CALL  repo 1 Open debt 100.82 coll 103.94 ltv 100.00% (trigger 98.00%)  https://stellar.expert/explorer/testnet/tx/2dd57f…
14:47:53 waiting      repo 1 MarginCall debt 100.82 coll 103.94 ltv 100.00%, default possible in 111s
14:49:37 refresh-nav  re-posted 0.97 (was 125s old)  https://stellar.expert/explorer/testnet/tx/056e74…
14:49:53 DEFAULT      repo 1 MarginCall … (margin window missed)  https://stellar.expert/explorer/testnet/tx/2b73b4…
16:25:27 DEFAULT      repo 2 Open debt 50.05 coll 51.60 ltv 97.00% (matured + grace)  https://stellar.expert/explorer/testnet/tx/7f8153…
16:25:32 LIQUIDATE    repo 2 Defaulted debt 50.05 coll 51.60 proceeds 50.57 USDC -> lender GB44DX…  https://stellar.expert/explorer/testnet/tx/db1924…
```

Demo: with a 100 USDC / 3600 s / 5% offer taken at NAV 1.00 (haircut 3%), the margin call triggers below NAV ≈ 0.9898; `set-nav 0.97` fires it once the -3% price has stood 180 s (NAV jump hold, above) and `default` follows ~120 s later (margin window), then `liquidate`. For a faster demo set `NAV_JUMP_HOLD_SECS=0` in `.env` and restart the keeper.

On sim-server it runs as a systemd user service next to `caravel-nav-keeper` (which keeps NAV fresh, so the unit has no `--refresh-nav`):

```sh
mkdir -p ~/.local/lib/caravel/keeper   # copy: branch switches cannot break it
cp -r scripts/keeper/{package.json,package-lock.json,tsconfig.json,src} ~/.local/lib/caravel/keeper/
(cd ~/.local/lib/caravel/keeper && npm ci --silent)
install -Dm600 .env ~/.local/lib/caravel/.env   # the service's ENV_FILE; re-run after every redeploy
install -Dm755 scripts/caravel-alert.sh ~/.local/lib/caravel/caravel-alert.sh
install -Dm644 scripts/caravel-alert@.service ~/.config/systemd/user/caravel-alert@.service
install -Dm644 scripts/caravel-keeper.service ~/.config/systemd/user/caravel-keeper.service
systemctl --user daemon-reload && systemctl --user enable --now caravel-keeper
systemctl --user status caravel-keeper; journalctl --user -u caravel-keeper -f   # start line: env /home/…/.local/lib/caravel/.env
```

The unit sets `SuccessExitStatus=143` because `tsx` relays `SIGTERM` on service stop and exits 143 (`128 + 15`), which systemd otherwise treats as abnormal exit-code failure.

Re-run the `cp` + `npm ci` lines and `systemctl --user restart caravel-keeper` after editing the keeper. CLIs run from the installed copy need its `.env` named: `cd ~/.local/lib/caravel/keeper && ENV_FILE=~/.local/lib/caravel/.env npm run repos` (without it they look for `~/.local/lib/.env` and stop with `REPO_ID not set in …`). Liquidator USDC runs down by the proceeds of each liquidation (it gets the collateral instead); keep it above the floor `npm run repos` prints (Liquidator checklist, above) with `scripts/buy-usdc.sh <amount> <LIQUIDATOR address>`.

## Alerts

Both keepers write an `ALERT …` line to their journal and run `ALERT_CMD "<message>"` (the units set it to `~/.local/lib/caravel/caravel-alert.sh`) when:

| Source | Trigger | Repeats |
|---|---|---|
| keeper | a `Defaulted` repo cannot be liquidated for > 2 ticks: liquidator USDC < proceeds (`liq-usdc`), NAV stale (`liq-stale`) or out of band (`liq-band`) | every `ALERT_REPEAT_SECS` (1800) |
| keeper | `auto_repay`, `default` or `check_margin` on a repo fails > 2 ticks in a row (any error the keeper does not treat as pending, short, stale, out of band or paused; e.g. `tx FAILED (txFailed/invokeHostFunctionResourceLimitExceeded)`). Every failing tick still logs its `FAILED` line and resends | every `ALERT_REPEAT_SECS` |
| keeper | tSAFO `paused()` while the repo's `no_seize` is off; the repo contract or the liquidator off the tSAFO allowlist / tBENJI authorization (> 2 ticks) | every `ALERT_REPEAT_SECS` |
| nav-keeper | an asset's `set_price` fails 2 rounds in a row | every 20 failed rounds |
| nav-keeper | it refuses to re-post a price that jumped > `NAV_JUMP_ACK_BPS` (jump refusal, above) | first round, then every 20 |
| keeper | `--refresh-nav` refuses to re-post a price held for an ack (> 2 ticks); the NAV jump state file is unreadable at start | every `ALERT_REPEAT_SECS`; once |
| keeper | `keeper blind`: 2 ticks in a row fail (RPC down or answering errors) | every `ALERT_REPEAT_SECS` |
| keeper | `keeper hung`: no RPC answer for `TICK_WATCHDOG_SECS` (90) inside a tick; the keeper then exits 1 and systemd restarts it | each time |
| keeper | `collateral short`: the repo contract holds less of a collateral token than its live repos (2 ticks in a row; runbook below) | every `ALERT_REPEAT_SECS` |
| systemd | either unit fails past its start limit (10 restarts in 600 s): `OnFailure=caravel-alert@%n.service` | once per failure |

Under `--once` every stuck state alerts and exits 1 at once; a failed action exits 1 without an ALERT. `caravel-alert.sh` always logs to the journal (`journalctl --user -t caravel-alert`); it also sends to Telegram when `~/.config/caravel/alert.env` (chmod 600, never in the repo) sets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Test it with `~/.local/lib/caravel/caravel-alert.sh "test"`.

## Under-simulated write bytes (RESOURCE_LIMIT_EXCEEDED)

Symptom: a tx passes simulation, then lands `FAILED` with `txFailed/invokeHostFunctionResourceLimitExceeded`; the tx's diagnostic events say `operation byte-write resources exceeds amount specified, <needed>, <declared>`.

Cause: when a token call inside the contract fails and is rolled back (`try_transfer_from` in the auto-repay pull, `try_transfer` in `push_or_park`), an entry that call touched (e.g. the borrower's `Allowance`, or the contract's own collateral `Balance`) stays in the read-write footprint but ends the tx unchanged. Simulation leaves those bytes out of `writeBytes`; on chain the host counts every existing read-write entry. The gap is exactly the size of those entries. Measured on testnet (CBWTB23F, 26 Oct 2026):

| Call | Path | Simulated | Needed | Gap |
|---|---|---|---|---|
| `default` (repo 3) | auto-repay on, borrower has no USDC trustline: pull fails | 660 | 956 | 296 = `Allowance` entry |
| `claim_in_kind` (CD4Q2QTO repo 2) | lender cannot hold tBENJI: push parked | 3,024 | 3,248 | 224 = contract tBENJI `Balance` |
| `repay` (repo 1) | lender has no USDC trustline: lender leg parked | 3,688 | lands | none (contract USDC balance changes anyway) |
| `liquidate` (repo 3) | borrower has no USDC trustline: surplus parked | 3,808 | lands | none |

So a parked USDC leg alone is safe (the contract's USDC balance is written anyway); the rollback of an entry nothing else writes is what breaks. A frozen (de-authorized but existing) recipient trustline probably adds its own size the same way (not testable here: Circle's USDC cannot be frozen by us). Fix: the keeper (`keeper/src/headroom.ts`) and the app (`padWrites` in `app/src/chain.ts`) add 2,048 write bytes and 0.02 XLM resource fee to every write before signing. Only the write-byte share is kept (the padded `default` cost 0.0011 XLM in total); the rest is refunded. To reproduce the under-count, run a keeper CLI with `NO_WRITE_PAD=1`. If a future path needs more than 2,048 extra bytes, raise both numbers together.

## Issuer pause or de-allowlist: guardian runbook

The contract cannot stop an issuer from blocking its own token (DECISIONS #24). Two cases, both alerted by the keeper:

- **Issuer pauses the token** (tSAFO `pause()`, CMP-04): every transfer fails (`#101`), so `top_up` and `repay` fail while the margin and maturity clocks keep running. Without action, `default` lands and the collateral is sold at the 1% discount once the token is unpaused.
- **Repo contract taken off the allowlist** (CMP-02): `repay`, `top_up` and `liquidate` fail (`#100`), `default` still lands, and `create_offer` keeps escrowing USDC on the dead asset.

Act as the guardian (instant, tighten only, #33), in this order:

```sh
cd ~/src/caravel && set -a && . ./.env && set +a
G=(stellar contract invoke --network testnet --source-account "$GUARDIAN_SECRET")   # $ADMIN_SECRET on a repo deployed before the separate guardian
ASSET=$TSAFO_ID   # or $TBENJI_SAC
# 1. No seizure, no new repos: default and liquidate wait, takes stop.
"${G[@]}" --id $REPO_ID -- guardian_set_pause --asset $ASSET --pause '{"no_new_repos":true,"no_seize":true}'
# 2. Disable the asset so no new offer escrows USDC against it.
CFG=$("${G[@]}" --send=no --id $REPO_ID -- asset --asset $ASSET)
"${G[@]}" --id $REPO_ID -- guardian_set_asset --asset $ASSET --config "${CFG/\"enabled\":true/\"enabled\":false}"
```

Then tell the issuer. When the token works again (unpaused, contract re-allowlisted), undo with the admin: switching off is a loosening, so `propose_pause --pause '{"no_new_repos":false,"no_seize":false}'` and `propose_asset` with `enabled:true`, then `execute_pause` / `execute_asset` after `timelock_secs` (120 s demo). While `no_seize` is on, the keeper logs `paused (no_seize)` for those repos and does not alert. Borrowers can repay again as soon as the token moves.

## Collateral short: guardian runbook

The keeper's `collateral short` ALERT (AS-02) means the repo contract's balance of that token is below what its live repos hold: an issuer clawback or burn on the contract. Every repo is paid from the one pooled balance, so the repos that settle first get their full collateral back and the last one cannot repay or be liquidated. New repos would refill the pool and move the loss onto their borrowers, so stop them at once (guardian, instant, tighten only):

```sh
cd ~/src/caravel && set -a && . ./.env && set +a
G=(stellar contract invoke --network testnet --source-account "$GUARDIAN_SECRET")
ASSET=$TBENJI_SAC   # or $TSAFO_ID, from the ALERT
"${G[@]}" --send=no --id $REPO_ID -- pause --asset $ASSET          # current switches
"${G[@]}" --id $REPO_ID -- guardian_set_pause --asset $ASSET --pause '{"no_new_repos":true,"no_seize":false}'   # keep no_seize true if it already is
```

Then ask the issuer why it clawed back and whether it returns the tokens, and tell the affected lenders. The contract has no write-down yet: clawback-safe accounting (a per-asset total checked on every exit) is roadmap R11. Undo `no_new_repos` with `propose_pause` / `execute_pause` once the balance matches again.

## Bad NAV push: admin runbook

A wrong `set_price` (fat finger, wrong decimals) is the real tail risk. The repo's NAV band (DECISIONS #31) refuses a price more than `max_nav_move_bps` from any of the feed's last 20 records, and the oracle keeps one record per `resolution` slot of ledger time (testnet 60 s), so re-posting a bad price passes the band only after about 18 minutes at the fastest (18 × `resolution` + 1 s; 20 posts). A move inside the band (demo 2,500 bps), or a bad price left in place for those 19 minutes, still drives margin calls on the keeper's next tick, then `default` and `liquidate` about 121–140 s later, at the wrong price and irreversibly. A wrong price UP is as bad: a `take_offer` in that window locks in too little collateral. All the fixes below are admin calls, no redeploy. Act within 2 minutes, in this order (scenarios from the flash-crash tests: S2, S4b, S6, S7, O2).

```sh
cd ~/src/caravel && set -a && . ./.env && set +a
A=(stellar contract invoke --network testnet --source-account "$ADMIN_SECRET")
TBENJI='{"Stellar":"'$TBENJI_SAC'"}'
```

The commands below are for tBENJI. For a bad tSAFO push (`TSAFO_ID` in `.env`), use `$TSAFO_ID` in place of `$TBENJI_SAC` in steps 2–3 (`TSAFO='{"Stellar":"'$TSAFO_ID'"}'` in place of `$TBENJI`) and `npm run set-nav -- 1.00 tsafo`. The price scale is the same (NAV × 10^14). Step 1 covers both assets.

1. **Freeze liquidation.** `liquidate` is whitelisted, so this stops every liquidation. Repos can still default; they wait as `Defaulted`.
   `"${A[@]}" --id $REPO_ID -- set_liquidator --liquidator $LIQUIDATOR_ADDRESS --allowed false`
2. **Stop takes.** `create_offer` and `take_offer` then return `AssetNotSupported`; live repos are unaffected. `set_asset` replaces the whole config, so flip `enabled` on the current one:
   `CFG=$("${A[@]}" --send=no --id $REPO_ID -- asset --asset $TBENJI_SAC)`
   `"${A[@]}" --id $REPO_ID -- set_asset --asset $TBENJI_SAC --config "${CFG/\"enabled\":true/\"enabled\":false}"`
3. **Correct the price.** Read the bad record: `"${A[@]}" --send=no --id $ORACLE_ID -- lastprice --asset "$TBENJI"` prints `{"price":…,"timestamp":…}`. Price = NAV × 10^14.
   `cd scripts/keeper && npm run set-nav -- 1.00`. Every record is stamped with ledger time (there is no `set_price_at`), so a future-dated price cannot exist. A correction inside the bad record's 60 s slot replaces it, and the window is clean at once. A later correction adds a record and the bad one stays in the band window for 20 slots (~19 min): takes, margin calls and liquidations return `NavOutOfBand` (error 18) until it rolls out, or until a widened band clears `propose_asset` / `execute_asset` (timelock, 120 s demo; narrow it again right after, narrowing is instant). Records cannot be overwritten any more: the power that let an admin erase a bad record also let a wrong key erase the good ones. The band settle clock (`band_settle_secs`, 1,200 s on testnet) does not shorten this: a bad price the keeper noted is accepted only after it stood that long, and any correction restarts the level at the corrected price, so the bad one never settles.

   Check with `npm run feeds`. `nav-keeper.sh` re-posts whatever `lastprice` returns within 10% of its last post; a bigger jump it refuses (and ALERTs), so the bad price goes stale after 180 s instead of being re-stamped as fresh. After the correction it re-posts the good one at once.
4. **Re-enable**, only after step 3 shows the right price. Enabling loosens risk, so `set_asset` fails with `Error(Contract, #20)` (`Loosens`, DECISIONS #33): queue the config read before step 2 with `"${A[@]}" --id $REPO_ID -- propose_asset --asset $TBENJI_SAC --config "$CFG"`, then after `timelock_secs` (120 s demo) run `execute_asset --asset $TBENJI_SAC`. Then step 1 with `--allowed true`. The keeper liquidates any `Defaulted` repo on its next tick, at the corrected NAV.

What this does not undo:
- A margin call raised at the bad price stays open until its deadline. Once the price is corrected, `default` after the deadline clears it instead of defaulting (#20), so an absent borrower no longer loses the 1% discount (S2b). If the price is still wrong at the deadline (or stale), the default goes ahead: -10.01 USDC on a 970 USDC repo.
- A take that landed at an inflated price leaves the lender short: -872.74 of 970.84 at a 10× push (S6). Only step 2 before the take prevents it.

Tested on testnet by simulation only (`--send=no`, nothing sent): steps 1 and 2 (disable) simulate successfully against repo `CAPUQPL7…` / oracle `CBKUZDTH…` (deployed from main f07a8bf), 25 Oct 2026. The one-record-per-slot oracle (no `set_price_at`) is covered by `contracts/repo/src/test_feed_rewrite.rs`.

## `npm run feeds`: mock NAV next to a live SEP-40 feed (#2)

Reads `lastprice(asset)` + `decimals()` (the two calls `contracts/repo/src/oracle.rs` makes) from the mock oracle and from one live Reflector testnet feed, through the same code (`scripts/keeper/src/sep40.ts`). The only difference between the two is the contract ID and asset in `.env`:

| | Contract | Asset |
|---|---|---|
| mock | `ORACLE_ID` | `Stellar(TBENJI_SAC)` |
| live | `LIVE_ORACLE_ID` = `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` (Reflector testnet, external CEXs & DEXs) | `LIVE_ORACLE_ASSET` = `Other:USDC` |

```sh
cd scripts/keeper
npm run feeds             # human-readable
npm run feeds -- --json   # for scripts / the app
```

```
mock NAV  tBENJI                   1.000000 USD  raw 100000000000000 @ 10^14  ts 2026-10-25T14:46:32Z (age 753s, resolution 60s)
live feed Other(USDC)              1.000548 USD  raw 100054828141309 @ 10^14  ts 2026-10-25T14:55:00Z (age 245s, resolution 300s)
```

Asset format: `Other:<SYMBOL>` or `Stellar:<C… token contract>` (or the CLI JSON form `{"Other":"BTC"}`). Other Reflector testnet feeds, all base `Other(USD)` / 14 decimals / 300 s unless noted: the same contract has `BTC ETH USDT XRP SOL USDC ADA AVAX DOT MATIC LINK DAI ATOM XLM UNI EURC`; FX feed `CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W` (`EUR GBP CHF CAD MXN ARS BRL THB XAU`); Stellar DEX feed `CAVLP5DH2GJPZMVO7IJY4CVOD5MWEFTJFVPD2YY2FQXOQHRGHK4D6HLP` (`Stellar(C…)` assets, base is a Stellar token, not USD). Source: [Stellar docs, oracle providers](https://developers.stellar.org/docs/data/oracles/oracle-providers).

**Same interface, checked on-chain.** `stellar contract info interface` for the mock and the Reflector feed: `Asset`, `PriceData` and all seven SEP-40 reads (`base`, `assets`, `decimals`, `resolution`, `price`, `prices`, `lastprice`) have identical specs, and the repo contract's `Asset` matches both. Only admin/write functions differ (`set_price`, `admin`, errors), and the repo never calls them. So pointing the repo at Reflector is `Config.oracle = <Reflector ID>` plus `AssetConfig.oracle_asset = Other("USDC")` (or whatever asset), no code change.

**One config catch:** Reflector stamps prices to its 300 s resolution and publishes after the window, so a fresh price is typically 2–10 min old. The demo tBENJI `max_nav_age_secs` = 180 would make it `StaleNav` most of the time; use ≥ 600 for an asset priced by a live feed. Still config only (`set_asset`, no redeploy).

Shell environment wins over `.env` (dotenv does not override), so an exported `ORACLE_ID` from another deploy will be used instead of the file's.

**For the app (live price next to mock NAV).** Same call for both, simulated with no signer (any funded address as source):

```ts
// oracle = ORACLE_ID | LIVE_ORACLE_ID (deployments/testnet.json / .env)
// asset  = { Stellar: TBENJI_SAC }  |  { Other: "USDC" }
const last = await view(oracle, "lastprice", [assetToScVal(asset)]); // Option<{ price: i128, timestamp: u64 }>
const decimals = await view(oracle, "decimals");                     // u32, 14 for both
const shown = Number(last.price) / 10 ** decimals;                   // display only; keep i128 for math
const age = Math.floor(Date.now() / 1000) - Number(last.timestamp);
```

`readFeed(oracle, asset)` in `src/sep40.ts` does exactly this and can be copied as is. With the generated bindings, `caravel-oracle`'s `lastprice` / `decimals` client also works against the Reflector ID (identical spec, tested): `new Client({ contractId: LIVE_ORACLE_ID, … }).lastprice({ asset: { tag: "Other", values: ["USDC"] } })` returns `{ price: 100054828141309n, timestamp: 1792940100n }`. Show "tBENJI NAV 1.0000 (mock, 12 s ago)" next to "USDC 1.0005 (Reflector live, 4 min ago)".

## `keeper/` seed: reset and seed a demo

```sh
cd scripts/keeper && npm install
npm run seed -- --reset    # deploy.sh --fresh (new oracle + repo), then seed: ~50 s, plus ~34 s if cargo builds from cold
npm run seed               # seed the contract already in .env (~15 s, the seed half of the run above)
SEED_PRINCIPAL=240 SEED_NEAR_DAYS=2 npm run seed
```

What it does:

1. `--reset` only: runs `scripts/deploy.sh --fresh` (new IDs into `.env`, `deployments/testnet.json`, bindings). In parallel, LENDER and BORROWER get their balances topped up (different signers, so no sequence clashes).
2. Balances. USDC: LENDER needs 3 × principal, BORROWER ≥ 20 for the repay interest. We can't mint Circle's testnet USDC, so the script buys it with XLM on the testnet DEX (`pathPaymentStrictReceive` to self, ~1.15 XLM per USDC right now); XLM comes from friendbot when an account is below 1,500. If the DEX has no path, it fails and points you to https://faucet.circle.com. tBENJI: the issuer `mint`s on the SAC to BORROWER whenever it holds less than the collateral for one repo plus 100.
3. Admin posts NAV 1.00 (fresh timestamp, so `take_offer` passes the 180 s staleness check). While that runs, LENDER creates the short offer.
4. BORROWER takes the short offer while LENDER posts the long offer and the two open ones. With `TSAFO_ID` set, admin also prices tSAFO at 1.00 and LENDER posts a third open offer (7 d, 6.5%) against tSAFO (deploy.sh already allowlisted and funded the borrower). Then BORROWER takes the long offer (`SEED_LONG_DAYS`, 30 demo days) with auto-repay on, so the positions table still shows a live repo after the short one is liquidated (KPR-06); the keeper repays it at maturity from the borrower's USDC.
5. Funds LIQUIDATOR (USDC bought on the DEX) up to the funding floor of every live repo plus the open offers, as if each were taken at max LTV (Liquidator checklist, above).
6. Prints the contract links and a table with the ids and tx links.

Default seed (100 USDC each, `day_secs` read from `config()`):

| | term | APR | state after seeding |
|---|---|---|---|
| offer | 7 d (420 s) | 5% | open |
| offer | 30 d (1800 s) | 6% | open |
| repo | 3 d (180 s) | 5% | taken by BORROWER; matures ~175 s after seeding; defaultable 60 s (grace) later |
| repo | 30 d (1800 s) | 5% | taken by BORROWER with auto-repay; repaid by the keeper at maturity (~30 min) |

```
Caravel demo seeded in 49.6s (incl. deploy.sh --fresh)
repo contract   CBVRCU…CNGR  https://stellar.expert/explorer/testnet/contract/CBVRCU…
oracle contract CD3HP7…NAHC  https://stellar.expert/explorer/testnet/contract/CD3HP7…  (tBENJI NAV 1.00)

kind   id  principal  apr    term            state                                         tx
offer   2     100.00  5%     7 d (420 s)     open                                          https://stellar.expert/explorer/testnet/tx/677f96…
offer   3     100.00  6%     30 d (1800 s)   open                                          https://stellar.expert/explorer/testnet/tx/2c9ca4…
repo    1     100.00  5%     3 d (180 s)     coll 103.14 tBENJI, debt 100.04; matures 15:04:12Z (in 175s), defaultable after 15:05:12Z  https://stellar.expert/explorer/testnet/tx/1fa7e2…
```

The old contract is left as is after `--reset`: its open offers keep their escrowed USDC and nothing cancels or repays them. The script buys new USDC instead. NAV goes stale 180 s after seeding, so run the keeper with `--refresh-nav` during the demo. After a reset, restart a hand-run keeper (the `caravel-keeper` service restarts itself on the new `REPO_ID`) and rebuild the app (new IDs).

## Recording the demo

Four things make the live demo look broken on camera. Check them before you press record:

1. **The seeded repo is gone in about 4 minutes.** Its term is 3 demo days (180 s) with auto-repay off, so the keeper defaults and liquidates it about 255 s after seeding. Just before recording, take the seeded 30-day offer in the app with auto-repay on (the default): it stays Open for 30 minutes and repays itself at maturity. For a longer taken repo from the seed itself, run `SEED_NEAR_DAYS=30 npm run seed`.
2. **The margin call after a NAV slide comes about 3 minutes late.** The keeper holds `check_margin` on any NAV move over 2% until the new price has stood 180 s (NAV jump hold, above). Right after the Admin slider, press **Check margin** on the repo in the app: it is permissionless and not held, so the MarginCall shows at once. The keeper's `default` and `liquidate` still wait out the hold (about 3 minutes after the slide).
3. **Keep the slider at 0.90 or above.** A move over 10% parks the keeper until someone adds the price to `NAV_JUMP_ACK` in `.env`. Before the liquidation beat, set the NAV back to 1.00 so the lender is paid in full on camera instead of showing a Shortfall; a move back of over 2% is held too, so leave 3 minutes before the liquidation. Show the liquidation on a maturity default (the seeded 3-day repo): at NAV 1.00 a missed margin call clears at `default` instead (rule #20).
4. **No admin loosening on camera.** Re-enabling an asset, lowering a haircut or clearing a pause fails with `Loosens` (error #20) and goes through `propose_*` / `execute_*` with the 120 s timelock (DECISIONS #33). Tightening (disable, raise a haircut, switch a pause on) is instant.

## Bindings

`packages/caravel-repo` and `packages/caravel-oracle` are generated by `stellar contract bindings typescript`, with the testnet contract ID embedded (`networks.testnet.contractId`). In the app: `"caravel-repo": "file:../packages/caravel-repo"`, then `npm install` (runs `tsc` via the package's `build` script; run `npm run build` inside the package if your package manager skips it).
