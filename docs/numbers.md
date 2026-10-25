# Numbers for the deck, landing and README

One source per figure, **DefiLlama RWA**, read on **25 Oct 2026**. Put the date on every slide that uses one. DefiLlama asset pages show no timestamp of their own; re-check on the morning of submission.

## Headline: Stellar chain page, default filters

[defillama.com/rwa/chain/stellar](https://defillama.com/rwa/chain/stellar), 25 Oct 2026, all filters at their defaults. DefiLlama calls the headline metric **Active AUM**.

| Figure | Value |
|---|---|
| **Stellar RWA Active AUM** (headline) | **$3.032B** (Total RWA Onchain AUM $3.05B) |
| **DeFi Active TVL** (Stellar RWAs working in DeFi) | **$133,043**, all of it in Aquarius |

| Top issuers on Stellar (same page) | Assets | Active AUM on Stellar |
|---|---|---|
| **Spiko** | 9 | **$1.965B** (≈65%, #1) |
| Ondo (USDY) | 1 | $536.91M |
| Franklin Templeton (BENJI, gBENJI, sgBENJI) | 3 | $507.39M |
| Etherfuse | 4 | $16.11M |
| Matrixdock | 1 | $4.23M |
| WisdomTree | 1 | $2.24M |

**Superseded:** "≈$2.4B" ("Total RWA Active Mcap $2.423b"). The page now shows Active AUM $3.032B, and no toggle on 25 Oct (Include in AUM, Category, Asset Group, Access Model) gives $2.42B. Use $3.03B.

## RWAs on Stellar (DefiLlama asset pages, Stellar share only)

| Asset | Issuer | On Stellar | Source |
|---|---|---|---|
| eurSAFO (Spiko Amundi Overnight Swap Fund, EUR) | Spiko | **$1.469B** (≈82% of its $1.795B total) | [defillama.com/rwa/asset/eurSAFO](https://defillama.com/rwa/asset/eurSAFO) |
| BENJI (Franklin OnChain US Gov MMF) | Franklin Templeton | **$434.68M** (≈64% of $681.04M) | [defillama.com/rwa/asset/BENJI](https://defillama.com/rwa/asset/BENJI) |
| EUTBL (Spiko EU T-Bills MMF) | Spiko | **$271.9M** (of $526.1M) | [defillama.com/rwa/asset/EUTBL](https://defillama.com/rwa/asset/EUTBL) |
| SAFO (same fund, USD class) | Spiko | **$117.7M** (of $225.9M) | [defillama.com/rwa/asset/SAFO](https://defillama.com/rwa/asset/SAFO) |
| gbpSAFO (same fund, GBP class) | Spiko | **$50.88M** (of $54.93M) | [defillama.com/rwa/asset/gbpSAFO](https://defillama.com/rwa/asset/gbpSAFO) |
| USTBL (Spiko US T-Bills MMF) | Spiko | **$36.0M** (of $169.4M) | [defillama.com/rwa/asset/USTBL](https://defillama.com/rwa/asset/USTBL) |

- **Spiko on Stellar = $1.965B** across 9 assets (the rows above plus UKTBL $9.9M, chfSAFO $5.2M, eurSPKCC $4.3M, SPKCC $0.6M): the largest RWA issuer on Stellar, about 4.5× BENJI. SAFO classes (eurSAFO + SAFO + gbpSAFO) are $1.638B; the T-bill funds EUTBL + USTBL are $307.9M.
- **Superseded:** "Spiko ≈ $1.78B" counted only eurSAFO + EUTBL + USTBL and missed the SAFO USD and GBP classes. "BENJI $474.9M of $701.1M" does not match the BENJI page on 25 Oct ($434.68M on Stellar of $681.04M).

## Numbers in the brief that do not match DefiLlama

| Brief | DefiLlama, 25 Oct | Use |
|---|---|---|
| SAFO ~$713M + T-Bills ~$536M | SAFO classes $1.638B on Stellar; EUTBL + USTBL $307.9M. $536.91M is **Ondo**'s Stellar total | DefiLlama |
| $4B RWA on Stellar | Active AUM $3.032B (the $3.75B / $4B figures are rwa.xyz / RedStone, a different method) | $3.03B, or say "rwa.xyz" if quoting $3.75B |
| ~$2M in Blend RWA pools | Not on DefiLlama. Team research: each Etherfuse pool on Blend is under $10K; the ~$2M figure (RedStone/Defiant) could not be re-checked. Stellar RWA DeFi Active TVL is $133,043 | Drop the number, or "$133K of $3.03B is used in DeFi" |
| EUTBL DEX + CEX volume $0 | **Confirmed.** EUTBL: 0 trades on Stellar ([stellar.expert](https://api.stellar.expert/explorer/public/asset/CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF)); $0 24h volume, "stopped trading on all exchanges listed" ([CoinGecko](https://www.coingecko.com/en/coins/spiko-eu-t-bills-money-market-fund)). eurSAFO: 0 trades, $0 DEX volume ([stellar.expert](https://api.stellar.expert/explorer/public/asset/CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP), [DefiLlama token](https://defillama.com/token/EURSAFO)) | Either; eurSAFO is the larger fund |

## Spiko facts the deck relies on (checked 25 Oct)

- **Token model:** a custom Soroban contract, not a classic asset or SAC, with 0 trustlines, so there is no `AUTH_REQUIRED` flag. A permission-manager contract checks `WHITELISTED_ROLE` on both `from` and `to` of every transfer. There is no `approve` / `transfer_from`, so it is only partly SEP-41. Caravel calls only `transfer` on collateral, so say **"Caravel needs only SEP-41 `transfer`"**, not "any SEP-41 token". [spiko-tech/stellar-contracts `token/src/contract.rs`](https://github.com/spiko-tech/stellar-contracts/blob/main/contracts/token/src/contract.rs), [`address/production.json`](https://github.com/spiko-tech/stellar-contracts/blob/main/address/production.json)
- **Audit:** Halborn reviewed the Stellar contracts (token, permission manager, redemption) 16–18 Sep 2025: 5 findings, including 1 Critical in the redemption contract, all fixed by 21 Sep 2025. Say **"audited, all findings fixed"**, not "clean audit". [Halborn](https://www.halborn.com/audits/spiko/stellar-contracts-879885)
- **NAV:** every business day; "On Mondays, the interest is tripled to cover the weekend." [spiko.io](https://www.spiko.io/spiko-treasury-bills-dollar). This is why staleness is ≈96h per asset (DECISIONS #25).
- **SAFO is swap-based:** it "uses fully collateralized total return swaps with Tier 1 banking counterparties - starting with BNP Paribas". [Spiko blog, 19 Mar 2026](https://www.spiko.io/blog/spiko-amundi-safo). This is why SAFO is "after due diligence only".
- **Spiko invites collateral use:** "Can I use my fund shares in DeFi? Yes, you can use them for example as collateral to take out on-chain loans. Please contact the Spiko team if you are interested in this use case." [spiko.io/use-cases/web3](https://www.spiko.io/use-cases/web3)

## Demand (slide 9)

- Binance × Franklin Templeton, 11 Feb 2026: Benji tokenized MMFs as off-exchange collateral on Binance. [Franklin Templeton press release](https://www.franklintempleton.com/press-releases/news-room/2026/franklin-templeton-and-binance-advance-strategic-collaboration-with-institutional-off-exchange-collateral-program)
- BlackRock BUIDL on Binance, 14 Nov 2025: "accepted as off-exchange collateral for trading on Binance". [Securitize via PR Newswire](https://www.prnewswire.com/news-releases/blackrocks-buidl-tokenized-by-securitize-now-accepted-as-collateral-for-trading-on-binance-and-launches-on-bnb-chain-302613374.html)
- Aave Horizon, launched 26 Aug 2025: permissioned market where qualified users borrow stablecoins against RWAs. [Aave blog](https://aave.com/blog/horizon-launch)

## Other figures already sourced

- 0 smart contracts hold BENJI: [Horizon](https://horizon.stellar.org/assets?asset_code=BENJI&asset_issuer=GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5)
- T-bill floor 3.87% (USDXX 7-day SEC yield, 23 Oct): [BlackRock](https://www.blackrock.com/cash/en-us/products/329365/circle-reserve-fund)
- Blend Fixed pool USDC supply 6.69% (6 Oct, DefiLlama via [WhaleHub](https://whalehub.io/blog/best-lending-protocols-stellar))
- More with quotes: [collateral-research.md](collateral-research.md), [research/](research/)
