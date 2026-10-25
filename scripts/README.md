# Scripts

## `deploy.sh`: one-command testnet deploy

Needs `stellar` CLI 28.x, `python3`, `curl`, and the burner keys in the repo-root `.env`.

```sh
scripts/deploy.sh                # build, deploy what changed, apply config (~50 s fresh, ~5 s no-op)
scripts/deploy.sh --fresh        # force a new oracle + repo contract
NAV=0.97 scripts/deploy.sh       # also push a tBENJI price (default 1.00, only if none is set)
SKIP_BINDINGS=1 scripts/deploy.sh
```

What it does, idempotently (each step reads chain state first and only sends a tx if it differs):

1. `stellar contract build` (both contracts).
2. Tops ADMIN up to 6,000 XLM by merging a friendbot-funded throwaway account into it (testnet rent is steep: a wasm upload costs ~1,000–1,500 XLM).
3. Mock oracle: reused if the on-chain wasm matches the build, otherwise deployed with admin = ADMIN, base `Other("USD")`, 14 decimals, resolution 60. Sets tBENJI (`Stellar(TBENJI_SAC)`) to 1.00 if it has no price.
4. Repo contract: reused if wasm and `config()` match, otherwise deployed with the demo profile (#5): fee 1000 bps (#3), liquidation discount 200 bps (#4), `day_secs` 60, margin window 120 s, grace 60 s, max NAV age 180 s. Treasury = ADMIN (override with `TREASURY_ADDRESS`).
5. `set_asset(tBENJI, { Stellar(TBENJI_SAC), haircut 300 bps, enabled })` (#18: haircut > discount).
6. `set_liquidator(LIQUIDATOR, true)`.
7. Issuer `set_authorized(…, true)` on tBENJI for the repo contract, borrower and liquidator (AUTH_REQUIRED, see `spikes/auth`).
8. Writes `ORACLE_ID`, `REPO_ID`, `DEPLOYED_AT` into `.env` and the public `deployments/testnet.json` (IDs, addresses, params) for the app.
9. Regenerates TS bindings in `packages/caravel-repo` and `packages/caravel-oracle` when a contract ID changes.

Every param can be overridden from the environment (`HAIRCUT_BPS`, `MAX_NAV_AGE_SECS`, …); see the top of the script.

The mock price goes stale after `max_nav_age_secs` (180 s): run the keeper with `--refresh-nav` (below), or refresh it with `NAV=1.00 scripts/deploy.sh` or
`stellar contract invoke --network testnet --source-account <admin> --id $ORACLE_ID -- set_price --asset '{"Stellar":"'$TBENJI_SAC'"}' --price 100000000000000`.

## `keeper/`: keeper + NAV setter

TypeScript, Node 20+. Reads `REPO_ID`, `ORACLE_ID`, `TBENJI_SAC` and keys from the repo-root `.env` at start, so restart it after a redeploy (no bindings rebuild needed; it talks to the contracts with `@stellar/stellar-sdk` directly).

```sh
cd scripts/keeper && npm install
npm run keeper                      # poll every 10 s
npm run keeper -- --refresh-nav     # also re-post the last NAV once it is ≥120 s old (max age 180 s)
npm run set-nav -- 0.97             # admin: oracle set_price(Stellar(TBENJI_SAC), 0.97 × 10^decimals())
```

Each tick the keeper:

1. Walks repo ids `1, 2, …` via the `repo(id)` view until `RepoNotFound`. Settled repos (`Repaid`, `Defaulted`, `Liquidated`) are remembered and not read again.
2. `default(id)` once the margin window has passed (`MarginCall` and now > `margin_call_deadline`) or now > maturity + grace. Needs no NAV. Ledger time can lag the wall clock by a few seconds; a `NotDefaultable` simulation just means "next tick".
3. For `Open` repos, simulates `check_margin(id)` and sends the tx only when it would return `MarginCall` (no fee spent on healthy repos). `StaleNav` is logged once and skipped (#17).
4. `MarginCall` repos wait for a top-up, repay or the deadline.

Keys: signs `check_margin` / `default` with `KEEPER_SECRET` (falls back to `LIQUIDATOR_SECRET`); `--refresh-nav` and `set-nav` sign with `ADMIN_SECRET` (oracle admin). Flags: `--interval <s>` (10), `--refresh-secs <s>` (120). Logs one line per action, plus a line when a repo's state changes:

```
14:47:00 healthy      repo 1 Open debt 100.82 coll 103.94 ltv 97.00%
14:47:42 MARGIN CALL  repo 1 Open debt 100.82 coll 103.94 ltv 100.00% (trigger 98.00%)  https://stellar.expert/explorer/testnet/tx/2dd57f…
14:47:53 waiting      repo 1 MarginCall debt 100.82 coll 103.94 ltv 100.00%, default possible in 111s
14:49:37 refresh-nav  re-posted 0.97 (was 125s old)  https://stellar.expert/explorer/testnet/tx/056e74…
14:49:53 DEFAULT      repo 1 MarginCall … (margin window missed)  https://stellar.expert/explorer/testnet/tx/2b73b4…
```

Demo: with a 100 USDC / 3600 s / 5% offer taken at NAV 1.00 (haircut 3%), the margin call triggers below NAV ≈ 0.9898; `set-nav 0.97` fires it on the next tick and `default` follows ~120 s later (margin window).

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
4. BORROWER takes the short offer while LENDER posts the two open ones.
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

The old contract is left as is after `--reset`: its open offers keep their escrowed USDC and nothing cancels or repays them. The script buys new USDC instead. NAV goes stale 180 s after seeding, so run the keeper with `--refresh-nav` during the demo. After a reset, restart the keeper and rebuild the app (new IDs).

## Bindings

`packages/caravel-repo` and `packages/caravel-oracle` are generated by `stellar contract bindings typescript`, with the testnet contract ID embedded (`networks.testnet.contractId`). In the app: `"caravel-repo": "file:../packages/caravel-repo"`, then `npm install` (runs `tsc` via the package's `build` script; run `npm run build` inside the package if your package manager skips it).
