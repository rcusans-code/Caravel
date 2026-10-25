# Collateral research: what Caravel's collateral really rests on

As of 25 Oct 2026. Full evidence, with a source and quote for every figure:
- [research/backing-chain-map.md](research/backing-chain-map.md): what each Stellar token is backed by, link by link, ranked into trust tiers.
- [research/rwa-collateral-gap-analysis.md](research/rwa-collateral-gap-analysis.md): which Stellar protocols accept RWA collateral today, and what's missing.
- Deck outline built on this file: [deck-outline.md](deck-outline.md).

Items marked **Proposal** are team suggestions, not sourced facts. Per DECISIONS.md, agree on them in team chat before changing that file.

**Number rule (MB, 25 Oct):** every number on a slide comes from **one source, DefiLlama RWA**, with the retrieval date on the slide. rwa.xyz figures stay in this file only as a note where they disagree. Where DefiLlama has no figure, the slide says so and names the other source.

## 1. The lens: every dollar token ends in T-bills, and the weak link is exit, not the asset

- Following the backing chain down, almost every "dollar" asset on Stellar ends in **short-dated US T-bills and Treasury repo**. For example: USDC → Circle Reserve Fund (BlackRock USDXX) → T-bills + Treasury repo; BENJI → FOBXX → at least 99.5% US government paper.
- The safe assets are already at the bottom of the chain. **The risk sits in the links above them**: issuer freeze or clawback, redemption only on business days, redemption only for approved holders, bridges.
- That is Caravel's insight in one line: *the underlying asset is safe, but turning it back into cash takes business days*. So a fixed-term repo with a margin window fits the asset better than 24/7 liquidation does. Use this for README **Insight**.

## 2. Problem section, with numbers (README **Problem**)

DefiLlama RWA, retrieved **25 Oct 2026** ("Include in AUM" defaults, Active AUM):

| Fact | Value | Source |
|---|---|---|
| RWA active AUM on Stellar | **$3.032B** (onchain $3.05B) | [DefiLlama RWA · Stellar](https://defillama.com/rwa/chain/stellar) |
| Spiko on Stellar (9 assets) | **$1.965B**, ≈65% of Stellar RWA, **#1 issuer** | same |
| RWA in DeFi on Stellar ("DeFi Active TVL") | **$133,043**, all in Aquarius; utilization <0.1% | same |
| BENJI on Stellar | $434.68M (of $681.04M on all chains) | [DefiLlama · BENJI](https://defillama.com/rwa/asset/BENJI) |
| BENJI held by any smart contract | **0 contracts** | [Horizon](https://horizon.stellar.org/assets?asset_code=BENJI&asset_issuer=GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5) |
| RWA tokens supplied to Blend (V1 + V2) | ≈$9.7K (CETES $8,823 + TESOURO $858) of $132.5M Blend TVL | [DefiLlama API · blend-pools-v2](https://api.llama.fi/protocol/blend-pools-v2) |
| Blend pools that *accept* RWAs (whole pool TVL) | "just above $2M" (July 2026 data, not DefiLlama) | [RedStone, 26 Aug 2026](https://blog.redstone.finance/2026/08/26/from-issuance-to-markets-pricing-rwas-on-stellar/) |
| EUTBL trades on Stellar / 24h volume anywhere | 0 trades; $0 24h volume, "stopped trading on all exchanges listed" | [stellar.expert API](https://api.stellar.expert/explorer/public/asset/CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF), [CoinGecko](https://www.coingecko.com/en/coins/spiko-eu-t-bills-money-market-fund) |
| eurSAFO trades / DEX volume on Stellar | 0 trades; $0 DEX volume | [stellar.expert API](https://api.stellar.expert/explorer/public/asset/CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP), [DefiLlama](https://defillama.com/token/EURSAFO) |
| Spiko markets on Stellar lenders | XOXNO lists six, all disabled | [WhaleHub](https://whalehub.io/blog/spiko-stellar) |
| Largest Stellar lender (Blend V2) | $132.5M, of which XLM $118.3M; no allowlist hook | DefiLlama API above; gap analysis §2e |

**rwa.xyz conflicts (note only, not for slides):** rwa.xyz shows $3.75B distributed RWAs on Stellar vs DefiLlama's $3.03B. Its SAFO figure (≈$1.64B, ≈44% of Stellar RWAs) matches DefiLlama's SAFO classes on Stellar ($1.638B, see §4), but the 44% share does not: on DefiLlama it is 54% (SAFO) or 65% (all Spiko).

One-liner: **Stellar holds $3B of permissioned fund shares and $133K of them work in DeFi. Caravel's AUTH_REQUIRED spike shows an issuer can authorize a contract.**

## 3. Eligible collateral and haircuts, 7-day term (**decided 25 Oct**, replaces the tier proposal)

Haircut = quality of the underlying asset × the weakest link above it. Stored per asset in contract config (Decision 13), snapshotted at take (Decision 19), and must stay above the 2% liquidation discount (Decision 18). Buffer = haircut − 2%.

| Asset | Issuer | Haircut | Why | Caravel status |
|---|---|---|---|---|
| USTBL | Spiko | **3%** | US T-bill UCITS MMF; business-day NAV | asset #2 (custom Soroban token, see §4) |
| BENJI | Franklin Templeton | **3%** | FOBXX, ≥99.5% US govt paper | demo asset (tBENJI) |
| USDY | Ondo | **3%** | T-bills + bank deposits, open to non-US holders | listed; see note 1 |
| EUTBL | Spiko | **~5%** | Euro T-bills, but **EUR/USD risk** against a USDC loan | needs a EUR/USD feed |
| CETES | Etherfuse | **8–10%** | Mexican T-bills; MXN/USD risk | needs FX-adjusted feed (RedStone has one) |
| SAFO (all classes) | Spiko × Amundi | **not eligible yet** | swap-based fund; only after due diligence (§4) | issue #20 builds the mock only |

Notes where these numbers contradict earlier work:
1. **USDY at 3%** contradicts the earlier Tier 2 proposal (8–15%): USDY is a note issued by Ondo, not a registered fund, so the issuer is an extra credit link that BENJI and USTBL do not have. 3% leaves a 1% buffer. Keep 3% for the deck if the team wants, but be ready for the question.
2. **CETES at 8–10%** contradicts the earlier Tier 4 proposal (25–35%). 8–10% covers a normal week of MXN moves but not a shock week (MXN fell sharply in the June 2024 election week; size **unverified**, check before quoting).
3. **EUTBL ~5%** matches the earlier "Tier 1 + FX haircut" rule (3% + ~2% FX).
4. **SAFO:** issue #20 sets a placeholder default of 3000 bps for tSAFO. That is testnet config only; on mainnet SAFO stays `enabled = false` until due diligence is done.

## 4. Spiko: the #1 RWA issuer on Stellar (verified 25 Oct 2026)

### Figures (DefiLlama RWA, 25 Oct 2026)

| Spiko asset on Stellar | Onchain AUM on Stellar | Same asset, all chains | Source |
|---|---|---|---|
| eurSAFO | $1.469B | $1.795B | [eurSAFO](https://defillama.com/rwa/asset/eurSAFO) |
| SAFO (USD) | $117.7M | $225.86M | [SAFO](https://defillama.com/rwa/asset/SAFO) |
| gbpSAFO | $50.88M | $54.93M | [gbpSAFO](https://defillama.com/rwa/asset/gbpSAFO) |
| **SAFO classes, subtotal** | **$1.638B** | | sum of the three rows |
| EUTBL | $271.86M | $526.14M | [EUTBL](https://defillama.com/rwa/asset/EUTBL) |
| USTBL | $36.04M | $169.42M | [USTBL](https://defillama.com/rwa/asset/USTBL) |
| **T-bill funds, subtotal** | **$307.9M** | | sum of the two rows |
| eurSPKCC (crypto cash & carry) | $4.28M | $22.08M | [eurSPKCC](https://defillama.com/rwa/asset/eurSPKCC) |
| **Spiko on Stellar, platform total** | **$1.965B** | $2.825B | [Stellar](https://defillama.com/rwa/chain/stellar) |

Top RWA issuers on Stellar (same page): Spiko $1.965B · Ondo $536.91M (USDY) · Franklin Templeton $507.39M (3 assets; BENJI $434.68M) · Etherfuse $16.11M · Matrixdock $4.23M · WisdomTree $2.24M.

Figures that were circulating and are **wrong** on DefiLlama today: "SAFO ≈$713M" (actual $1.638B for SAFO classes on Stellar), "Spiko T-bills ≈$536M" (actual $307.9M; $536.91M is **Ondo**'s Stellar total), "Stellar RWA ≈$4B" (actual $3.03B).

### Compliance model (from Spiko's source and stellar.expert)

- **Custom Soroban token, not a classic asset or SAC.** Spiko's production addresses ([spiko-tech/stellar-contracts `address/production.json`](https://github.com/spiko-tech/stellar-contracts/blob/main/address/production.json)): EUTBL `CBGV2QFQ…DDOF`, USTBL `CARUUX2F…F4TO`, permission manager `CBGHLRSX…S26M`, redemption `CAVZK26E…EDBS`. stellar.expert shows them as Wasm contracts (same Wasm hash `f48f10d9…`, created 1 Oct 2025, source "unverified") with **0 trustlines** and **0 trades**. So there are no `AUTH_REQUIRED` flags to check: compliance is not done with trustlines.
- **Allowlist on every transfer.** [`token/src/contract.rs`](https://github.com/spiko-tech/stellar-contracts/blob/main/contracts/token/src/contract.rs): `transfer` and `safe_transfer` assert `WHITELISTED_ROLE` on **both** `from` and `to` in the permission manager; `mint` checks the receiver too. The token is `Pausable` and `Upgradeable` (owner-controlled).
- **SEP-41: partial.** It exposes `transfer(from, to, amount)`, `balance`, `decimals`, `name`, `symbol`, `total_supply` with SEP-41 signatures, but **no `allowance` / `approve` / `transfer_from` / `burn_from`**, and `burn(account, amount, caller)` has a non-standard signature. Caravel only calls `token::Client::transfer` on collateral (`contracts/repo/src/lib.rs`, `margin.rs`), so it works. Say "Caravel needs only SEP-41 `transfer`", not "any SEP-41 token".
- **What Spiko must do for Caravel:** grant `WHITELISTED_ROLE` to the Caravel contract and every liquidator. Borrowers are already whitelisted holders.
- **Audit:** Halborn assessed the Stellar contracts (token, permission-manager, redemption) on 16–18 Sep 2025. 5 findings, all solved by 21 Sep 2025, including a **Critical** (HAL-01) in the Redemption contract: execution burned from the user's account instead of the Redemption escrow, locking pending redemptions. [Halborn report](https://www.halborn.com/audits/spiko/stellar-contracts-879885). On stage say "audited by Halborn; all findings fixed", not "clean audit".

### NAV cadence (sets the weekend staleness policy)

- **Business days only.** Spiko: "Every business day, the fund's administrator calculates the value of the Treasury Bills in the portfolio… On Mondays, the interest is tripled to cover the weekend." ([Spiko T-Bills Dollar FAQ](https://www.spiko.io/spiko-treasury-bills-dollar)). On Sun 25 Oct 2026 the latest published USTBL NAV was 1.1003 dated **2026-10-23** (Fri) ([data.spiko.io](https://data.spiko.io/ustbl/)). DefiLlama's USTBL note agrees: "NAV is calculated on each business day".
- So Friday's NAV must stay valid until Monday's NAV lands: ≈72h normally, more with a holiday. **Per-asset `max_nav_age` ≈ 96h** for Spiko and BENJI covers a long weekend.
- **Oracle risk, real example:** DefiLlama's Spiko fee adapter notes "Spiko's T-bill and Cash & Carry NAV oracles were frozen Jul 15 – Oct 15, 2026 (only SAFO kept updating)" ([api.llama.fi/protocol/spiko](https://api.llama.fi/protocol/spiko)). A stale-NAV rule that blocks new risk but never blocks exit (Decisions 6, 17) is exactly what that case needs.

### SAFO: why it needs due diligence first

- SAFO (Spiko Amundi Overnight Swap Fund, UCITS, Amundi as delegated manager, CACEIS depositary) "uses fully collateralized total return swaps with Tier 1 banking counterparties - starting with BNP Paribas" ([Spiko blog, 19 Mar 2026](https://www.spiko.io/blog/spiko-amundi-safo)).
- The fund holds a basket (Spiko's collateral list shows US equities such as UnitedHealth, Valero, Rollins) and swaps its return with the bank for an overnight rate. "In the unlikely event of a bank default, Spiko Dollar would liquidate the portfolio" ([Spiko Dollar](https://www.spiko.io/spiko-dollar)). It behaves like cash until a swap bank fails; then the holder owns a risk-asset basket.
- Due diligence before listing: swap counterparties and collateral eligibility rules, daily collateral exchange with the bank, redemption gates, S&P's fund rating ([S1+ FVR on eurSAFO](https://www.spglobal.com/ratings/en/regulatory/article/-/view/sourceId/101707884)), and who prices NAV for a USD loan against eurSAFO / gbpSAFO.

### Spiko already wants this use case

- [spiko.io/use-cases/web3](https://www.spiko.io/use-cases/web3) FAQ: *"Can I use my fund shares in DeFi? Yes, you can use them for example as collateral to take out on-chain loans. Please contact the Spiko team if you are interested in this use case."*
- Same page: "Tokenized fund shares can be used as on-chain collateral to secure OTC transactions or with counterparties, such as spot/derivatives trading venues or prime brokers."
- They have done it on Ethereum: SAFO holders "can now pledge their shares as collateral to borrow EUR CoinVertible… 24/7" on a Steakhouse-curated Morpho market ([Spiko blog, 22 Jul 2026](https://www.spiko.io/blog/borrow-stablecoins-against-your-safo-shares)). DefiLlama shows $752,673 of eurSAFO in Morpho Blue (Ethereum). Nothing equivalent exists on Stellar, where 82% of eurSAFO lives.

### Integration order

USTBL first (3%, same permission manager as every Spiko token), EUTBL next (needs EUR/USD), SAFO classes only after due diligence. Spiko must allowlist the Caravel contract and every whitelisted liquidator; Spiko can pause or upgrade the token (issuer risk, list it in **Risks and limits**).

## 5. Rate benchmark (supports Decision 10)

- Risk-free floor: USDXX 7-day SEC yield **3.87%** (23 Oct 2026). FOBXX-type collateral yields about the same. USTBL 7d yield 4.20% annualised ([data.spiko.io](https://data.spiko.io/ustbl/), 25 Oct 2026).
- Blend USDC suppliers earned 6.69%. So a passive holder borrowing against T-bills runs negative carry, which confirms Decision 10's target user (traders/MMs).
- **Proposal:** show offer APR in the UI as a spread over the T-bill floor ("T-bill + 1.5%"), which is how repo desks quote.

## 6. Liquidation path (supports Decisions 4 and 7)

- Issuers redeem only for approved holders on business days, so a seized fund share can't be dumped 24/7. The Aquarius USTRY pool loses ≈20% on a 250K sale. EUTBL has never traded on Stellar (§2).
- So the **whitelisted liquidator** in Decision 7 isn't just a demo shortcut. It's required: the liquidator must be an issuer-approved holder who can redeem at NAV. Put this in the pitch, because Aave Horizon uses the same model.
