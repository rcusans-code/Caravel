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

**One config catch:** Reflector stamps prices to its 300 s resolution and publishes after the window, so a fresh price is typically 2–10 min old. The demo profile's `max_nav_age_secs` = 180 would make it `StaleNav` most of the time; use ≥ 600 against a live feed. Still config only.

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

## Bindings

`packages/caravel-repo` and `packages/caravel-oracle` are generated by `stellar contract bindings typescript`, with the testnet contract ID embedded (`networks.testnet.contractId`). In the app: `"caravel-repo": "file:../packages/caravel-repo"`, then `npm install` (runs `tsc` via the package's `build` script; run `npm run build` inside the package if your package manager skips it).
