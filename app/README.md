# Caravel app

Web front end for the Caravel repo contract on Stellar **testnet**: Vite + React + TypeScript, styled only with the design system in [`../design`](../design/README.md) (`tokens.css`, `components/bundle.css`, `bundle.js`, the `cv-*` markup).

## Run

Needs Node 20+ (tested on 26) and the repo checked out (the app reads `../deployments/testnet.json`, `../packages/*` and `../design`).

```sh
cd app
npm install                      # also installs + builds the bindings in ../packages (postinstall)
VITE_DEMO_SIGNER=1 npm run dev   # http://localhost:5173, bound to 0.0.0.0
npm run build                    # tsc + vite build into dist/ (demo signer off unless the flag is set)
npm test                         # node --test test/*.test.ts (pure modules, no bundler)
```

Contract IDs come from `deployments/testnet.json`, which `scripts/deploy.sh` writes. After a redeploy, restart the dev server; nothing in `src/` is hand-copied.

## Log in

- **Connect wallet**: Stellar Wallets Kit (`@creit.tech/stellar-wallets-kit` 2.x; Freighter, xBull, Albedo, Lobstr, Rabet, Hana …). The wallet must be on Testnet. A fresh wallet can fund itself with friendbot and add the USDC/tBENJI trustlines from the balances card. If the wallet declines the trustline transaction, the app re-reads the account and asks once more for the lines still missing; after a second decline or any error the *Add trustline* button stays for another try (`src/trustline.ts`).
- **Access gate**: anyone can browse offers and the NAV. Writes (post, cancel, take, repay, default, liquidate) are enabled only when the connected wallet's tBENJI trustline is AUTHORIZED by the issuer (Horizon `is_authorized`). Otherwise the app shows *"Access is limited to approved team wallets during the hackathon. Add the tBENJI trustline, then send your address to the team."* The team then runs `scripts/onboard.sh <G-address>` (authorizes it and tops it up to 200 tBENJI + 100 USDC). There is no allowlist in the frontend. The Admin tab only appears for the oracle admin address.
- **Demo account (testnet burner)**: only when started with `VITE_DEMO_SIGNER=1` and `NETWORK=testnet`. Vite injects the lender, borrower, liquidator and admin secrets from the repo-root `.env` (the committed testnet burner keys) and signs in the browser. Role switcher: Lender / Borrower / Liquidator / Admin. Never set the flag for a public build.

## Public deploy

Live at **https://caravel-repo.pages.dev/app/** (Cloudflare Pages project `caravel-repo`, static, no server). Wallet login only. The same project serves the landing page (`../site`) at https://caravel-repo.pages.dev/; the header logo goes there (`/`), and the landing's demo buttons come back to `/app/`.

```sh
cd app
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…   # token needs Pages edit
npm run deploy:pages
```

`deploy:pages` runs `build:pages`, then `wrangler pages deploy ../dist-pages --project-name caravel-repo --branch main`. `PAGES_PROJECT=…` deploys to another project. `build:pages` is:

1. `build:public`: production build with `VITE_DEMO_SIGNER` forced off and `base: "/app/"` (`vite.config.ts`; `npm run dev` stays at `/`), then `scripts/check-no-secrets.mjs`, which fails if `dist/` holds any secret value from the repo-root `.env`, any string shaped like a Stellar secret seed, or the demo-account UI.
2. `scripts/build-pages.mjs`: writes repo-root `dist-pages/` (gitignored) = `../site` at `/` + `dist/` at `/app/`, and rewrites the landing's demo CTAs (*Try the demo*, *Borrow against fund shares*, *Lend at a fixed rate*, *Or try the testnet demo*, footer *Testnet demo*) from `#launch` to `/app/`. It fails if none of them is found and warns for each one missing, so a landing re-export cannot silently drop the link to the app. It also bundles `src/landing.ts` (live testnet deals for the landing's ticker and hero card, read with the same `src/book.ts` reader as the app) into `dist-pages/assets/live-deals-*.js` and adds it to the landing with `defer`.
3. `check-no-secrets.mjs ../dist-pages`: the same scan over the combined output.

`.github/workflows/pages.yml` runs the same build and deploy on pushes to `main` (skipped while the repo has no Cloudflare secrets). There are no client routes, so no `_redirects`.

Takes need a NAV younger than 180 s: on the team's server the `caravel-nav-keeper` user service pushes one every minute (see `../scripts/README.md`).

## What it does

| Tab | Who | Calls |
|---|---|---|
| (header) | anyone | XLM / USDC / tBENJI balances (Horizon), tBENJI NAV + feed timestamp + fresh/stale (`oracle.lastprice`); next to it the live SEP-40 feed (`LIVE_ORACLE_ID` / `LIVE_ORACLE_ASSET` from the repo-root `.env`, `lastprice` + `decimals` by simulation), reference only, not used by the contract |
| Offers | borrower | Offers board read from ledger entries; Take shows debt and collateral at the current NAV and haircut, then `take_offer` and a DvP receipt |
| Lend | lender | `create_offer` (amount, term in demo days, APR, collateral asset) with interest and fee preview; `cancel_offer` for your open offers |
| My positions | borrower / lender | Repo cards: status pill, collateral cover vs the margin-call line, maturity countdown, `repay` with a DvP receipt. Repaid and Liquidated repos are hidden behind "Show closed (N)" and shown muted when on; Defaulted repos stay visible with an "Awaiting liquidation" note. Liquidator desk: `default`, `liquidate` |
| Admin | oracle admin | NAV slider → mock oracle `set_price` (pushing the same value refreshes the timestamp) |

Every confirmed transaction shows a TxHash chip linked to stellar.expert.

**Enumerating offers:** the contract has no list getter. The app reads `NextOfferId` / `NextRepoId` from the contract instance storage, then batch-reads every `Offer(i)` / `Repo(i)` persistent entry with one `getLedgerEntries` call each (`src/chain.ts`). Taken or cancelled offers are deleted on-chain, so they simply drop out.

**Errors** (`src/errors.ts`): the root-cause contract error in the simulation log is mapped to a sentence (stale NAV, offer gone, missing trustline, unauthorized tBENJI, insufficient balance, rejected signature, wrong network).

## Files

- `src/config.ts`: IDs and accounts from `deployments/testnet.json`, demo key gate, live reference feed (`LIVE_FEED`)
- `src/sep40.ts`: SEP-40 asset parsing and reading normalisation for the live feed (pure, unit-tested)
- `src/chain.ts`: reads (RPC, Horizon) and writes through the generated bindings (`caravel-repo`, `caravel-oracle`)
- `src/wallet.ts`: Wallets Kit signer and demo signer, same `Signer` shape
- `src/format.ts`: 7-decimal units and the contract math (interest, required collateral) with the same rounding as `math.rs`
- `src/ui.tsx`: TxHash, StatusPill, Alert, Field, DvpReceipt from `design/components`
- `vite.config.ts`: demo key and live-feed id injection, and makes `../packages/*` use the app's copy of `@stellar/stellar-sdk`

## Demo notes

- Demo time: 1 day = 60 s, NAV max age 180 s. Before a take, push a NAV from Admin if the feed shows Stale.
- The burner accounts are shared by the whole team. Balances move when someone else is testing.
- Testnet rent is high: `create_offer` and `take_offer` cost ~55 XLM each in fees (new persistent entries), `repay` ~0.4 XLM.
