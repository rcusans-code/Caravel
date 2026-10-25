<p align="center"><img src="assets/logo/caravel-mark-square.svg" alt="Caravel logo: a conquistador climbing a C, carrying a flag" width="160"></p>

# Caravel

**On-chain term repo for tokenized Treasuries on Stellar.**
Fixed-term, fixed-rate USDC loans against tokenized money-market funds, priced off daily NAV, settled with atomic DvP.

> DeFi tries to liquidate Treasuries at 3 a.m. on a Sunday. TradFi never does that. It does repo.

Built at HackMeridian 2026 (Lisbon, 25–26 Oct) · Genesis path · Stellar Unlocked + Stellar Composed.

> 🚧 Work in progress during the hackathon. New to the team? Start with [INTRO.md](INTRO.md) · Team board: [TASKS.md](TASKS.md) · Who does what: [DEVS.md](DEVS.md) · Locked decisions: [DECISIONS.md](DECISIONS.md) · Design system: [design/](design/README.md) · Collateral research (sourced numbers for Problem/Insight/Risks): [docs/collateral-research.md](docs/collateral-research.md)

## Problem
_TODO (P): RWA on Stellar vs RWA in lending pools, with sources._

## Insight
_TODO (P): daily-NAV assets need a term model, not 24/7 liquidations._

## How it works
_TODO (P): lender → borrower → margin → maturity → default flow._

## Architecture
_TODO (P + C): diagram — Repo contract, SAC (USDC, tBENJI), SEP-40 oracle, keeper, frontend._

## Contract spec
_TODO (C): methods, state machine (Open → MarginCall → Repaid / Defaulted → Liquidated), parameters, events._

## Stellar features used
_TODO: authorized trustlines (AUTH_REQUIRED), SAC, atomic DvP, SEP-40, Circle USDC._

## Run it
_TODO (I): prerequisites, deploy script, seed script, frontend._

## Testnet deployment
_TODO (I): contract IDs + stellar.expert links._

## Risks and limits
_TODO (P): shortfall buffer, negative carry, issuer dependence, regulatory scope._

## Built during HackMeridian
_TODO: everything in this repo was written 25–26 Oct 2026. Summary of what shipped._

## Team
_TODO_
