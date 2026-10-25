# Caravel app

Web front end for the Caravel repo contract on Stellar **testnet**: Vite + React + TypeScript, styled only with the design system in [`../design`](../design/README.md) (`tokens.css`, `components/bundle.css`, `bundle.js`, the `cv-*` markup).

## Run

Needs Node 20+ (tested on 26) and the repo checked out (the app reads `../deployments/testnet.json`, `../packages/*` and `../design`).

```sh
cd app
npm install                      # also installs + builds the bindings in ../packages (postinstall)
VITE_DEMO_SIGNER=1 npm run dev   # http://localhost:5173, bound to 0.0.0.0
npm run build                    # tsc + vite build into dist/ (demo signer off unless the flag is set)
```

Contract IDs come from `deployments/testnet.json`, which `scripts/deploy.sh` writes. After a redeploy, restart the dev server; nothing in `src/` is hand-copied.

## Log in

- **Connect wallet**: Stellar Wallets Kit (`@creit.tech/stellar-wallets-kit` 2.x; Freighter, xBull, Albedo, Lobstr, Rabet, Hana …). The wallet must be on Testnet. A fresh wallet can fund itself with friendbot and add the USDC/tBENJI trustlines from the balances card. tBENJI is AUTH_REQUIRED, so the issuer still has to authorize a new account before it can borrow.
- **Demo account (testnet burner)**: only when started with `VITE_DEMO_SIGNER=1` and `NETWORK=testnet`. Vite injects the lender, borrower, liquidator and admin secrets from the repo-root `.env` (the committed testnet burner keys) and signs in the browser. Role switcher: Lender / Borrower / Liquidator / Admin. Never set the flag for a public build.

## What it does

| Tab | Who | Calls |
|---|---|---|
| (header) | anyone | XLM / USDC / tBENJI balances (Horizon), tBENJI NAV + feed timestamp + fresh/stale (`oracle.lastprice`) |
| Offers | borrower | Offers board read from ledger entries; Take shows debt and collateral at the current NAV and haircut, then `take_offer` and a DvP receipt |
| Lend | lender | `create_offer` (amount, term in demo days, APR, collateral asset) with interest and fee preview; `cancel_offer` for your open offers |
| My positions | borrower / lender | Repo cards: status pill, collateral cover vs the margin-call line, maturity countdown, `repay` with a DvP receipt. Liquidator desk: `default`, `liquidate` |
| Admin | oracle admin | NAV slider → mock oracle `set_price` (pushing the same value refreshes the timestamp) |

Every confirmed transaction shows a TxHash chip linked to stellar.expert.

**Enumerating offers:** the contract has no list getter. The app reads `NextOfferId` / `NextRepoId` from the contract instance storage, then batch-reads every `Offer(i)` / `Repo(i)` persistent entry with one `getLedgerEntries` call each (`src/chain.ts`). Taken or cancelled offers are deleted on-chain, so they simply drop out.

**Errors** (`src/errors.ts`): the root-cause contract error in the simulation log is mapped to a sentence (stale NAV, offer gone, missing trustline, unauthorized tBENJI, insufficient balance, rejected signature, wrong network).

## Files

- `src/config.ts`: IDs and accounts from `deployments/testnet.json`, demo key gate
- `src/chain.ts`: reads (RPC, Horizon) and writes through the generated bindings (`caravel-repo`, `caravel-oracle`)
- `src/wallet.ts`: Wallets Kit signer and demo signer, same `Signer` shape
- `src/format.ts`: 7-decimal units and the contract math (interest, required collateral) with the same rounding as `math.rs`
- `src/ui.tsx`: TxHash, StatusPill, Alert, Field, DvpReceipt from `design/components`
- `vite.config.ts`: demo key injection, and makes `../packages/*` use the app's copy of `@stellar/stellar-sdk`

## Demo notes

- Demo time: 1 day = 60 s, NAV max age 180 s. Before a take, push a NAV from Admin if the feed shows Stale.
- The burner accounts are shared by the whole team. Balances move when someone else is testing.
- Testnet rent is high: `create_offer` and `take_offer` cost ~55 XLM each in fees (new persistent entries), `repay` ~0.4 XLM.
