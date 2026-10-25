# Numbers for the deck, landing and README

One source per figure, **DefiLlama RWA**, read on **25 Oct 2026**. Put the date on every slide that uses one. DefiLlama asset pages show no timestamp of their own; re-check on the morning of submission.

## RWAs on Stellar (DefiLlama asset pages, Stellar share only)

| Asset | Issuer | On Stellar | Source |
|---|---|---|---|
| eurSAFO (Spiko Amundi Overnight Swap Fund, EUR) | Spiko | **$1.469B** (≈82% of its $1.795B total) | [defillama.com/rwa/asset/eurSAFO](https://defillama.com/rwa/asset/eurSAFO) |
| BENJI (Franklin OnChain US Gov MMF) | Franklin Templeton | **$474.9M** (≈68% of $701.1M) | [defillama.com/rwa/asset/BENJI](https://defillama.com/rwa/asset/BENJI) |
| EUTBL (Spiko EU T-Bills MMF) | Spiko | **$271.9M** (of $526.2M) | [defillama.com/rwa/asset/EUTBL](https://defillama.com/rwa/asset/EUTBL) |
| USTBL (Spiko US T-Bills MMF) | Spiko | **$36.0M** (of $169.4M) | [defillama.com/rwa/asset/USTBL](https://defillama.com/rwa/asset/USTBL) |
| SAFO (USD share class) | Spiko | not broken out by chain ($138.9M total) | [defillama.com/rwa/asset/SAFO](https://defillama.com/rwa/asset/SAFO) |

- **Spiko on Stellar ≈ $1.78B** (eurSAFO + EUTBL + USTBL): the largest RWA issuer on Stellar, about 3.7× BENJI.
- **Stellar RWA total ≈ $2.4B** active market cap ([defillama.com/rwa/chain/stellar](https://defillama.com/rwa/chain/stellar), "Total RWA Active Mcap $2.423b" on 25 Oct). The four assets above alone are $2.25B.

## Numbers in the brief that do not match DefiLlama

| Brief | DefiLlama, 25 Oct | Use |
|---|---|---|
| SAFO ~$713M + T-Bills ~$536M | eurSAFO $1.469B on Stellar; EUTBL $271.9M + USTBL $36.0M on Stellar ($526M is EUTBL's total across all chains) | DefiLlama |
| $4B RWA on Stellar | ≈ $2.4B active (the $3.75B / $4B figures are rwa.xyz / RedStone, a different method) | ≈ $2.4B, or say "rwa.xyz" if quoting $3.75B |
| ~$2M in Blend RWA pools | Not on DefiLlama. Team research: each Etherfuse pool on Blend is under $10K; the ~$2M figure (RedStone/Defiant) could not be re-checked | Drop the number, or "under $10K per RWA pool on Blend (Oct)" with the research link |
| EUTBL DEX + CEX volume $0 | Not checked for EUTBL. Checked: **eurSAFO** 0 trades and $0 DEX volume ([stellar.expert](https://api.stellar.expert/explorer/public/asset/CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP), [DefiLlama token](https://defillama.com/token/EURSAFO)) | Use eurSAFO, which is also the larger fund |

## Other figures already sourced

- 0 smart contracts hold BENJI: [Horizon](https://horizon.stellar.org/assets?asset_code=BENJI&asset_issuer=GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5)
- T-bill floor 3.87% (USDXX 7-day SEC yield, 23 Oct): [BlackRock](https://www.blackrock.com/cash/en-us/products/329365/circle-reserve-fund)
- Blend Fixed pool USDC supply 6.69% (6 Oct, DefiLlama via [WhaleHub](https://whalehub.io/blog/best-lending-protocols-stellar))
- More with quotes: [collateral-research.md](collateral-research.md), [research/](research/)
