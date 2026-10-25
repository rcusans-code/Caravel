# Caravel pitch deck: 11-slide outline (EN)

**Owners:** Teo drafts the slides · Den writes the narrative and does the final proofread.
**Number rule:** every market number comes from **DefiLlama RWA**, with "DefiLlama RWA, 25 Oct 2026" on the slide. Re-pull the morning of submission and update the date. Non-DefiLlama numbers are labelled with their source. ⚠️ = unverified or soft; don't say it on stage until it's checked.
Evidence and links for every figure: [collateral-research.md](collateral-research.md) §2–4.

Spiko sits at the center next to BENJI: Spiko is the largest RWA issuer on Stellar and publicly invites lending partners; BENJI is the demo asset.

---

### 1 · Title
- **Caravel**: fixed-term repo for tokenized T-bill funds on Stellar.
- One-liner: *Borrow USDC against tokenized fund shares for a fixed term, with atomic DvP, one daily NAV and a whitelisted liquidator.*
- Visual: logo + `docs/media/landing-hero.jpg` crop. Footer: HackMeridian, team names, repo URL.

### 2 · Problem: $3B of RWAs on Stellar, $133K working in DeFi
- **$3.03B** RWA active AUM on Stellar; **$133,043** of it in DeFi (utilization <0.1%). *(DefiLlama RWA · Stellar, 25 Oct 2026)*
- Top issuers on Stellar: **Spiko $1.97B (#1, ≈65%)** · Ondo $537M · Franklin Templeton $507M (BENJI $435M) · Etherfuse $16M. *(same page)*
- Blend, Stellar's biggest lender ($132.5M TVL), holds ≈$9.7K of RWA tokens (CETES + TESOURO). *(DefiLlama, 25 Oct 2026)*
- Optional sub-line, different source: "Blend pools that accept RWAs: just above $2M" *(RedStone, Aug 2026, July data)*. Use either the DefiLlama $9.7K or the RedStone $2M, labelled; never "$4B vs $2M".
- ⛔ Don't use: "~$4B on Stellar" (DefiLlama: $3.03B), "SAFO $713M / Spiko T-bills $536M" (DefiLlama: $1.64B / $308M).

### 3 · Why DeFi lending fails for these assets
- **Daily NAV vs 24/7 liquidations.** Spiko and BENJI strike NAV once per business day; Spiko's latest USTBL NAV on Sunday 25 Oct is Friday's (23 Oct). A lender that liquidates on every tick has no tick to use. *(data.spiko.io; spiko.io FAQ)*
- **Nowhere to liquidate.** EUTBL ($272M on Stellar): **0 trades** on Stellar, **$0** 24h volume on every exchange CoinGecko tracks. *(stellar.expert, CoinGecko, 25 Oct 2026)*
- **Permissioned tokens.** All 9 Spiko assets are "allowlisted to hold" *(DefiLlama compliance panel)*; Spiko's token checks the allowlist on both sides of every transfer. A pool contract that isn't on the list can't even receive the token.

### 4 · Insight: a term repo needs a price only three times
- At **open** (size the collateral), **once a day** (margin check), and at **repayment**. Exactly the cadence a fund NAV already has.
- "The underlying is safe; turning it back into cash takes business days." So: fixed term + margin window + issuer-approved liquidator, not 24/7 liquidation.
- Visual: `docs/media/landing-insight.jpg`.

### 5 · How it works
- Lender **offer** (USDC escrowed, term, APR, asset) → borrower **take_offer** = **atomic DvP** (collateral in, USDC out, one tx) → **daily margin** (`check_margin`, margin window, `top_up`) → **repay** (lender gets principal + interest − fee) / **default** after maturity + grace → **whitelisted liquidator** buys at NAV − 2%, waterfall: lender → fee → borrower surplus, `Shortfall` event if short.
- Worked example from README: 1,000 USDC, 7 days, 5% APR, 3% haircut → lender receives 1,000.86, fee 0.10.
- Visual: `docs/media/landing-how.jpg` or the README state machine.

### 6 · Demo
- 3 screenshots: (1) offers board, (2) `take_offer` DvP tx on stellar.expert, (3) liquidator view / `Liquidated` event.
- Until app screenshots exist (seeded testnet run, TASKS.md G5), use `docs/media/landing-hero.jpg`, `landing-how.jpg`, `landing-collateral.jpg` as placeholders. Landing shots are marketing, not the product: swap them before final.
- Video: **[VIDEO LINK, unlisted, test logged out]**.

### 7 · RWA-ready by design
- **Compliance-agnostic:** Caravel calls only SEP-41 `transfer` on collateral, so it works with a SAC behind `AUTH_REQUIRED` (BENJI-style, our tBENJI spike) **and** with Spiko's custom allowlist token (no `approve` needed). The issuer decides who may hold; Caravel never bypasses it.
- **Per-asset risk params** in contract config: haircut (snapshotted at take), oracle asset, enabled flag, NAV staleness.
- **Weekend NAV policy:** per-asset max NAV age ≈ **96h** (Friday NAV → Monday NAV, plus a holiday). Stale NAV blocks **new repos, margin calls and liquidation at a stale price** (Decisions 6, 17); **`repay` and `top_up` are never blocked**. Real case: DefiLlama notes Spiko's T-bill NAV oracles were frozen Jul 15 – Oct 15, 2026.
- Eligible collateral, 7-day term:

| Asset | Haircut |
|---|---|
| USTBL (Spiko), BENJI, USDY | 3% |
| EUTBL (Spiko) | ~5% (EUR/USD vs USDC loan) |
| CETES (Etherfuse) | 8–10% |
| SAFO (Spiko × Amundi) | after due diligence (swap-based fund) |

- ⚠️ Expect "why is USDY the same as BENJI?" (issuer note vs registered fund). Answer prepared in collateral-research.md §3.

### 8 · Why Stellar
- **The assets live here:** 82% of eurSAFO's onchain AUM and 64% of BENJI's are on Stellar. *(DefiLlama RWA, 25 Oct 2026)*
- **SAC + authorized trustlines:** issuer-level compliance a contract can be authorized into (our AUTH_REQUIRED spike: GO).
- **Atomic DvP** in one Soroban call; **SEP-40** oracle interface (Reflector / RedStone, swap is config only); sub-cent fees.
- Visual: `docs/media/landing-stellar.jpg`.

### 9 · Demand: institutions already use tokenized MMFs as collateral
- **Franklin Templeton × Binance** (11 Feb 2026): Benji-issued tokenized MMFs as off-exchange collateral on Binance via Ceffu custody. [press release](https://www.franklintempleton.com/press-releases/news-room/2026/franklin-templeton-and-binance-advance-strategic-collaboration-with-institutional-off-exchange-collateral-program)
- **BlackRock BUIDL × Binance** (14 Nov 2025): "accepted as off-exchange collateral for trading on Binance". [Securitize via PR Newswire](https://www.prnewswire.com/news-releases/blackrocks-buidl-tokenized-by-securitize-now-accepted-as-collateral-for-trading-on-binance-and-launches-on-bnb-chain-302613374.html)
- **Aave Horizon** (launched 26 Aug 2025): permissioned market, qualified users borrow stablecoins against RWAs; **$146M** RWA in DeFi. [Aave blog](https://aave.com/blog/horizon-launch) · DefiLlama RWA, 25 Oct 2026
- **Spiko itself:** "Can I use my fund shares in DeFi? Yes… as collateral to take out on-chain loans. Please contact the Spiko team." [spiko.io/use-cases/web3](https://www.spiko.io/use-cases/web3). Already live on Morpho/Ethereum for SAFO (22 Jul 2026), nothing on Stellar.

### 10 · Competition + business model

| | Blend | Templar | Aave Horizon | CEX (Binance) | **Caravel** |
|---|---|---|---|---|---|
| Chain | Stellar | Stellar + others | Ethereum | off-chain | Stellar |
| Model | pooled, perpetual | pooled lending | pooled, permissioned | off-exchange collateral | **fixed-term bilateral repo** |
| Permissioned collateral (allowlist) | no hook | n/a ⚠️ | yes | custodian | **yes, issuer-native** |
| Pricing | 24/7 oracle | RedStone 24/7 | 24/7 oracle | exchange | **daily NAV + staleness rule** |
| TVL (DefiLlama, 25 Oct 2026) | $132.5M | $11.9M on Stellar | $251.5M | — | testnet |

- ⚠️ Templar's collateral list (deJAAA, deJTRSY, CETES, USTRY) is from RedStone's Aug 2026 post; recheck on its app before the slide.
- **Model:** 10% protocol fee on interest (Decision 3); the lender never gets less than the offer terms minus that fee, never more than the terms.

### 11 · Go-to-market, roadmap, team
- **First deals OTC:** one issuer (Spiko or Etherfuse) allowlists the Caravel contract + one market maker as the whitelisted liquidator; a handful of bilateral repos with known counterparties.
- **Roadmap:** real NAV oracle (issuer-signed NAV or RedStone/Reflector SEP-40) → Dutch auction for liquidation → lender vault (DeFindex) for passive USDC.
- **Team:** Den (contracts), Misha (integration/keeper), Bohdan Che (design/frontend), Bohdan Koldun (pitch/docs/QA), Teo (deck), per TASKS.md owners. ⚠️ Confirm names and roles with the team. Contact + repo link.

---

## Checklist before export
- [ ] Every number carries "DefiLlama RWA, <date>" or its named source.
- [ ] Re-pull DefiLlama figures the morning of 26 Oct; update date.
- [ ] Replace the slide 6 landing placeholders with app screenshots; insert video link.
- [ ] Resolve the ⚠️ items or drop them.
