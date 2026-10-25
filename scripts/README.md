# Scripts

## `deploy.sh`: one-command testnet deploy

Needs `stellar` CLI 28.x, `python3`, `curl`, and the burner keys in the repo-root `.env`.

```sh
scripts/deploy.sh                # build, deploy what changed, apply config (~50 s fresh, ~5 s no-op)
scripts/deploy.sh --fresh        # force a new oracle + repo contract
NAV=0.97 scripts/deploy.sh       # also push a tBENJI price (default 1.00, only if none is set)
SAFO_NAV=1.02 scripts/deploy.sh  # same for tSAFO
SKIP_BINDINGS=1 scripts/deploy.sh
```

What it does, idempotently (each step reads chain state first and only sends a tx if it differs):

1. `stellar contract build` (repo, oracle, and the tSAFO mock).
2. Tops ADMIN up to 6,000 XLM by merging a friendbot-funded throwaway account into it (testnet rent is steep: a wasm upload costs ~1,000–1,500 XLM).
3. Mock oracle: reused if the on-chain wasm matches the build, otherwise deployed with admin = ADMIN, base `Other("USD")`, 14 decimals, resolution 60. Sets tBENJI (`Stellar(TBENJI_SAC)`) to 1.00 if it has no price.
   tSAFO (collateral #2, issue #20): `contracts/spiko-mock`, a Spiko-style token (allowlist checked on every transfer, no `approve`/`transfer_from`, issuer pause, 5 decimals like Spiko's mainnet tokens). Reused if the wasm matches, otherwise deployed with admin = ISSUER; `TSAFO_ID` goes into `.env`. Priced at 1.00 if it has none.
4. Repo contract: reused if wasm and `config()` match, otherwise deployed with the demo profile (#5): fee 1000 bps (#3), liquidation discount 200 bps (#4), `day_secs` 60, margin window 120 s, grace 60 s. Treasury = ADMIN (override with `TREASURY_ADDRESS`).
5. `set_asset(tBENJI, { Stellar(TBENJI_SAC), haircut 300 bps, enabled, max NAV age 180 s })` (#18: haircut > discount; #25: staleness is per asset) and `set_asset(tSAFO, { Stellar(TSAFO_ID), haircut 3000 bps, enabled, max NAV age 180 s })` (testnet only, DECISIONS #29; override with `SAFO_HAIRCUT_BPS`, `SAFO_MAX_NAV_AGE_SECS`).
6. `set_liquidator(LIQUIDATOR, true)`.
7. Issuer `set_authorized(…, true)` on tBENJI for the repo contract, borrower and liquidator (AUTH_REQUIRED, see `spikes/auth`).
   Issuer `set_whitelisted(…, true)` on tSAFO for the repo contract, the liquidator, the borrower and lender wallets, plus any `TSAFO_HOLDERS` (space-separated). Without the repo contract and every liquidator on the list, takes and liquidations revert with the token's `NotWhitelisted` (#100). Then mints `TSAFO_BORROWER_MINT` (2,000) tSAFO to the borrower if it holds none.
8. Writes `ORACLE_ID`, `REPO_ID`, `TSAFO_ID`, `DEPLOYED_AT` into `.env` and the public `deployments/testnet.json` (IDs, addresses, params) for the app.
9. Regenerates TS bindings in `packages/caravel-repo` and `packages/caravel-oracle` when a contract ID changes.

Every param can be overridden from the environment (`HAIRCUT_BPS`, `SAFO_HAIRCUT_BPS`, `TSAFO_DECIMALS`, `MAX_NAV_AGE_SECS`, `SAFO_MAX_NAV_AGE_SECS`, …); see the top of the script.

Dry run, 25 Oct, on throwaway keys and a separate `ENV_FILE` (the app's deployment untouched): fresh deploy in 129 s (oracle, tSAFO, repo, both `set_asset`, allowlist, mint), a re-run in 14 s with no tx. On that deployment, with the CLI: tSAFO `take_offer` with no approve (100 USDC against 142.99413 tSAFO at 30%), `repay`, `default` → `liquidate` to the allowlisted liquidator; a borrower off the allowlist fails with `Error(Contract, #100)`, a paused token with `#101`, and the offer stays open.

The mock price goes stale after tBENJI's `max_nav_age_secs` (180 s, set per asset): `nav-keeper.sh` or the TypeScript keeper with `--refresh-nav` (both below) keep it fresh. By hand:
`stellar contract invoke --network testnet --source-account <admin> --id $ORACLE_ID -- set_price --asset '{"Stellar":"'$TBENJI_SAC'"}' --price 100000000000000`.

## `onboard.sh`: give a team wallet access and a test allowance

The public app is read-only for any wallet whose tBENJI trustline is not AUTHORIZED by the issuer; that on-chain flag is the only allowlist. With `TSAFO_ID` in `.env`, step 6 also puts the wallet on the tSAFO allowlist and mints it tSAFO (`TSAFO_AMOUNT`, default = `tbenji_amount`); tSAFO needs no trustline.

```sh
scripts/onboard.sh <G-address> [tbenji_amount=200] [usdc_amount=100]
```

Idempotent, amounts are targets (a re-run tops up to them, never beyond):

1. Unfunded account: friendbot funds it.
2. Missing tBENJI or USDC trustline: prints how to add it and exits 2. Only the wallet owner can sign a trustline: in the app, connect and press **Add … trustline** (one tx for both), then re-run.
3. Issuer `set_authorized(addr, true)` on the tBENJI SAC (skipped if `authorized(addr)` is already true).
4. Issuer pays tBENJI up to `tbenji_amount` (a payment from the issuer mints).
5. ADMIN pays USDC up to `usdc_amount`. If ADMIN holds too little, it first runs `buy-usdc.sh` for the shortfall (min 100).

Tested 25 Oct on fresh throwaway keys: unfunded -> funded + exit 2 (no trustlines) -> trustlines added with the throwaway key -> 200 tBENJI (authorized) + 100 USDC; a re-run sends nothing. Two onboarded throwaways then ran create_offer -> take_offer -> repay end to end.

## `buy-usdc.sh`: testnet USDC from the DEX

There is no Circle USDC faucet on testnet. `scripts/buy-usdc.sh [amount=100] [destination=ADMIN]` buys it on the SDEX with friendbot XLM: per 500 USDC chunk, friendbot funds a throwaway account, which sends a `path-payment-strict-receive` (XLM -> USDC, Horizon-quoted, 3% slippage) straight to the destination and then merges its leftover XLM into ADMIN. ADMIN's own XLM is not spent. Price on 25 Oct: ~1.15 XLM per USDC (500 USDC for ~572 XLM). The destination needs a USDC trustline.

## `nav-keeper.sh`: keep the collateral NAVs fresh

Takes and liquidations revert with `StaleNav` when the oracle price is older than 180 s. The keeper re-posts the oracle's current tBENJI price every 60 s, and tSAFO's too when `TSAFO_ID` is set (`NAV=0.97` / `SAFO_NAV=1.02` pin a value instead; with no price at all it posts 1.00), so a value set from the app's Admin tab sticks. A failed push is retried 3 times 5 s apart, then the next round starts after 15 s. (Back-to-back pushes sometimes fail simulation with `ResourceLimitExceeded` on write bytes; the retry lands.)

```sh
scripts/nav-keeper.sh --once     # one push
scripts/nav-keeper.sh            # loop (INTERVAL=60)
```

On sim-server it runs as a systemd user service (linger is on, so it survives logout and reboot):

```sh
install -Dm755 scripts/nav-keeper.sh ~/.local/lib/caravel/nav-keeper.sh   # copy: branch switches cannot break it
install -Dm644 scripts/caravel-nav-keeper.service ~/.config/systemd/user/caravel-nav-keeper.service
systemctl --user daemon-reload && systemctl --user enable --now caravel-nav-keeper
systemctl --user status caravel-nav-keeper; journalctl --user -u caravel-nav-keeper -f
```

It reads keys and `ORACLE_ID` from `~/src/caravel/.env` every round, so a redeploy is picked up without a restart. Re-run the `install` lines after editing the script.

**Cost:** each `set_price` costs ~9 XLM per asset in fees at today's testnet rates (the oracle rewrites its 20-entry price history). At one push per ~70 s that is ~11,000 XLM/day. The keeper merges a friendbot-funded account into ADMIN (+~10,000 XLM) whenever ADMIN drops below `MIN_ADMIN_XLM` (3,000).

The TypeScript keeper (`scripts/keeper`, below) sends `check_margin`, `default` and `liquidate`; on sim-server it runs as `caravel-keeper.service`. The testnet repo contract is deployed from main f07a8bf, before the tSAFO merge: margin calls, auto-repay and per-asset NAV staleness (DECISIONS #25) are live; tSAFO collateral (issue #20) needs the next redeploy. Against an older deployment `check_margin` may return `NotImplemented`; the keeper logs that once per repo and skips it.


## `keeper/`: keeper + NAV setter

TypeScript, Node 20+. Reads `REPO_ID`, `ORACLE_ID`, `TBENJI_SAC`, `TSAFO_ID` (optional), `USDC_SAC` and keys from the repo-root `.env` at start (no bindings rebuild needed; it talks to the contracts with `@stellar/stellar-sdk` directly). When `REPO_ID` in `.env` changes (redeploy, `seed --reset`) it logs one line and exits; the systemd unit restarts it on the new IDs. Run by hand, restart it yourself.

```sh
cd scripts/keeper && npm install
npm run keeper                      # poll every 10 s
npm run keeper -- --refresh-nav     # also re-post the last NAV once it is ≥120 s old (max age 180 s)
npm run repos                       # every repo: status, maturity, lender, debt; lender + liquidator USDC
npm run set-nav -- 0.97             # admin: oracle set_price(Stellar(TBENJI_SAC), 0.97 × 10^decimals())
npm run set-nav -- 1.02 tsafo       # same for Stellar(TSAFO_ID)
```

Each repo is priced and labelled by its own collateral (tBENJI or tSAFO); `--refresh-nav` refreshes every asset's price.

Each tick the keeper:

1. Walks repo ids `1, 2, …` via the `repo(id)` view until `RepoNotFound`. Only `Repaid` and `Liquidated` repos are remembered and not read again; `Defaulted` stays live because the lender is not paid until `liquidate`.
2. `default(id)` once the margin window has passed (`MarginCall` and now > `margin_call_deadline`) or now > maturity + grace, then `liquidate` in the same tick. Needs no NAV. Ledger time can lag the wall clock by a few seconds; a `NotDefaultable` simulation just means "next tick".
3. `liquidate(LIQUIDATOR, id)` on every `Defaulted` repo (defaulted by the keeper or by anyone else). The liquidator pays collateral × NAV × (1 − 2%) in USDC; the lender gets principal + interest − fee first, the treasury the fee, the borrower any rest. Before sending it checks NAV age ≤ tBENJI's `max_nav_age_secs` and the liquidator's USDC ≥ proceeds; if either fails it logs one line (with the `buy-usdc.sh` command to top up) and retries every tick.
4. For `Open` repos, simulates `check_margin(id)` and sends the tx only when it would return `MarginCall` (no fee spent on healthy repos). `StaleNav` is logged once and skipped (#17).
5. `MarginCall` repos wait for a top-up, repay or the deadline.

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

Demo: with a 100 USDC / 3600 s / 5% offer taken at NAV 1.00 (haircut 3%), the margin call triggers below NAV ≈ 0.9898; `set-nav 0.97` fires it on the next tick and `default` follows ~120 s later (margin window), then `liquidate`.

On sim-server it runs as a systemd user service next to `caravel-nav-keeper` (which keeps NAV fresh, so the unit has no `--refresh-nav`):

```sh
mkdir -p ~/.local/lib/caravel/keeper   # copy: branch switches cannot break it
cp -r scripts/keeper/{package.json,package-lock.json,tsconfig.json,src} ~/.local/lib/caravel/keeper/
(cd ~/.local/lib/caravel/keeper && npm ci --silent)
install -Dm644 scripts/caravel-keeper.service ~/.config/systemd/user/caravel-keeper.service
systemctl --user daemon-reload && systemctl --user enable --now caravel-keeper
systemctl --user status caravel-keeper; journalctl --user -u caravel-keeper -f
```

Re-run the `cp` + `npm ci` lines and `systemctl --user restart caravel-keeper` after editing the keeper. Liquidator USDC runs down by the proceeds of each liquidation (it gets tBENJI instead); top it up with `scripts/buy-usdc.sh <amount> <LIQUIDATOR address>`.

## Bad NAV push: admin runbook

A wrong `set_price` (fat finger, wrong decimals, future timestamp) is the real tail risk. Nothing bounds a push: the keeper raises margin calls on its next tick, then `default` and `liquidate` land about 121–140 s after the push, at the wrong price and irreversibly. A wrong price UP is as bad: a `take_offer` in that window locks in too little collateral. All the fixes below are admin calls, no redeploy. Act within 2 minutes, in this order (scenarios from the flash-crash tests: S2, S4b, S6, S7, O2).

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
   - Timestamp ≤ now: `cd scripts/keeper && npm run set-nav -- 1.00`.
   - Timestamp in the future (a `set_price_at` push): `set_price` records sort by timestamp, so a plain `set_price` lands before it and `lastprice` stays bad. That is also why `set-nav`, the app slider and `nav-keeper.sh` cannot fix it. Overwrite that exact record (an equal timestamp overwrites):
     `"${A[@]}" --id $ORACLE_ID -- set_price_at --asset "$TBENJI" --price 100000000000000 --timestamp <bad timestamp>`
     The corrected price then counts as fresh until that timestamp + 180 s.

   Check with `npm run feeds`. `nav-keeper.sh` re-posts whatever `lastprice` returns: until the price is corrected it keeps re-stamping the bad one as fresh, and afterwards it keeps the good one.
4. **Re-enable**, only after step 3 shows the right price: run step 2 again with `true`/`false` swapped (or with `$CFG` as read before step 2), then step 1 with `--allowed true`. The keeper liquidates any `Defaulted` repo on its next tick, at the corrected NAV.

What this does not undo:
- A margin call raised at the bad price stays (#20). An absent borrower still defaults and loses the 2% discount: -20.02 USDC on a 970 USDC repo (S2b).
- A take that landed at an inflated price leaves the lender short: -872.74 of 970.84 at a 10× push (S6). Only step 2 before the take prevents it.

Tested on testnet by simulation only (`--send=no`, nothing sent): steps 1, 2 (disable) and the `set_price_at` overwrite all simulate successfully against the current `REPO_ID` / `ORACLE_ID`.

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
4. BORROWER takes the short offer while LENDER posts the two open ones. With `TSAFO_ID` set, admin also prices tSAFO at 1.00 and LENDER posts a third open offer (7 d, 6.5%) against tSAFO (deploy.sh already allowlisted and funded the borrower).
5. Prints the contract links and a table with the ids and tx links.

Default seed (100 USDC each, `day_secs` read from `config()`):

| | term | APR | state after seeding |
|---|---|---|---|
| offer | 7 d (420 s) | 5% | open |
| offer | 30 d (1800 s) | 6% | open |
| repo | 3 d (180 s) | 5% | taken by BORROWER; matures ~175 s after seeding; defaultable 60 s (grace) later |

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

## Bindings

`packages/caravel-repo` and `packages/caravel-oracle` are generated by `stellar contract bindings typescript`, with the testnet contract ID embedded (`networks.testnet.contractId`). In the app: `"caravel-repo": "file:../packages/caravel-repo"`, then `npm install` (runs `tsc` via the package's `build` script; run `npm run build` inside the package if your package manager skips it).
