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

The mock price goes stale after `max_nav_age_secs` (180 s); `nav-keeper.sh` (below) keeps it fresh. By hand:
`stellar contract invoke --network testnet --source-account <admin> --id $ORACLE_ID -- set_price --asset '{"Stellar":"'$TBENJI_SAC'"}' --price 100000000000000`.

## `onboard.sh`: give a team wallet access and a test allowance

The public app is read-only for any wallet whose tBENJI trustline is not AUTHORIZED by the issuer; that on-chain flag is the only allowlist.

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

## `nav-keeper.sh`: keep the tBENJI NAV fresh

Takes and liquidations revert with `StaleNav` when the oracle price is older than 180 s. The keeper re-posts the oracle's current tBENJI price every 60 s (`NAV=0.97` pins a value instead; with no price at all it posts 1.00), so a value set from the app's Admin tab sticks. A failed push is retried 3 times 5 s apart, then the next round starts after 15 s. (Back-to-back pushes sometimes fail simulation with `ResourceLimitExceeded` on write bytes; the retry lands.)

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

**Cost:** each `set_price` costs ~9 XLM in fees at today's testnet rates (the oracle rewrites its 20-entry price history). At one push per ~70 s that is ~11,000 XLM/day. The keeper merges a friendbot-funded account into ADMIN (+~10,000 XLM) whenever ADMIN drops below `MIN_ADMIN_XLM` (3,000).

`origin/misha/keeper` has a TypeScript keeper (`scripts/keeper`, `--refresh-nav`) that also sends `check_margin` and `default`. It is not used here: the deployed repo contract (from main) still returns `NotImplemented` for `check_margin`, and it would auto-default repos during demos.

## Bindings

`packages/caravel-repo` and `packages/caravel-oracle` are generated by `stellar contract bindings typescript`, with the testnet contract ID embedded (`networks.testnet.contractId`). In the app: `"caravel-repo": "file:../packages/caravel-repo"`, then `npm install` (runs `tsc` via the package's `build` script; run `npm run build` inside the package if your package manager skips it).
