# Pitch deck: 11 slides, English

**Owners:** Teo drafts the slides, Den owns the narrative and the final read. Numbers come only from [numbers.md](numbers.md) (DefiLlama RWA, dated 25 Oct 2026); put the date on each slide that shows one. Visuals: logos in `design/logos/`, landing screenshots in `docs/media/`, app screenshots from the seeded demo run.

**Spine:** Stellar's biggest RWA issuers (Spiko, Franklin) hold billions of permissioned fund shares that no on-chain lender can take. Caravel is a fixed-term repo that prices once a day, works with any issuer's compliance model, and settles both legs in one transaction.

| # | Slide | Content | Numbers / proof |
|---|---|---|---|
| 1 | **Caravel** | Repo for RWAs on Stellar. One-liner: fixed-rate USDC loans against tokenized Treasury and money-market funds, priced off daily NAV, settled atomically. | Logo lockup, *Per aspera ad Stellar* |
| 2 | **The idle fleet** | ≈$2.4B of RWAs on Stellar, almost none usable as collateral. Top issuers: **Spiko #1** (≈$1.78B: eurSAFO, EUTBL, USTBL), Franklin BENJI ($475M). | DefiLlama asset pages; 0 contracts hold BENJI (Horizon). Do not use "$4B" or "~$2M in Blend" (see numbers.md) |
| 3 | **Why DeFi lending fails here** | Daily NAV vs 24/7 liquidation bots. Nowhere to liquidate: eurSAFO has 0 trades and $0 DEX volume; the tokens are permissioned, so only approved holders can receive them. | stellar.expert, DefiLlama token page |
| 4 | **Insight: term repo** | A price is needed only three times: at open, once a day for margin, and at maturity. The asset is safe; the exit takes business days. | collateral-research.md §1 |
| 5 | **How it works** | Diagram: offer → atomic DvP → daily margin check → repay or default → whitelisted liquidator redeems with the issuer. | The landing "How it works" section |
| 6 | **Demo** | 3 screens (take with DvP receipt, margin call + top up, liquidation) and the video link. | App screenshots, video URL |
| 7 | **RWA-ready** | Compliance-agnostic core (any SEP-41 token; the issuer decides who may hold it), per-asset risk parameters, weekend NAV policy, eligible collateral table below. | DECISIONS #24–26 |
| 8 | **Why Stellar** | The assets already live here; SAC; authorized trustlines; atomic DvP; SEP-40 oracles; sub-cent fees. | |
| 9 | **Demand** | Binance × Franklin (BENJI as off-exchange collateral), BUIDL accepted on CEXs, Aave Horizon; Spiko itself offers its tokens as collateral for on-chain loans and invites partners. | Links to each announcement (add) |
| 10 | **Competition + model** | Table: Blend, Templar, Aave Horizon, CEX collateral programs vs Caravel (term, daily NAV, permissioned assets, atomic DvP). Revenue: fee on interest (DECISIONS #3). | |
| 11 | **GTM, roadmap, team** | First deals OTC: one issuer (Spiko or Etherfuse) + one market maker as liquidator. Roadmap: real NAV oracle → liquidation auction → lender vault. Team of four. | |

## Slide 7: eligible collateral (7-day term)

| Asset | Haircut | Why |
|---|---|---|
| USTBL, BENJI, USDY | 3% | US T-bill funds; NAV moves by hundredths of a percent a week |
| EUTBL | ~5% | EUR/USD risk against a USDC loan |
| CETES | 8–10% | Mexican sovereign and MXN risk |
| SAFO (swap-based fund) | after due diligence only | Returns come from a bank swap; counterparty risk to assess first |

## Two points the deck must get right

1. **Compliance-agnostic.** BENJI uses classic authorized trustlines (AUTH_REQUIRED). Spiko runs its own Soroban contracts (a permission manager and smart accounts; Halborn audited them, including the redemption contract, in Sept 2025). Caravel's core only calls the SEP-41 `token::Client`, so it works with both: each issuer admits the Caravel contract and its liquidators in whatever way its compliance requires.
2. **Weekend NAV.** Funds don't publish NAV on Saturday and Sunday. Staleness is set per asset (about 96h in production, which covers a weekend). A stale NAV pauses only new repos and margin calls; repay and top up always work.
