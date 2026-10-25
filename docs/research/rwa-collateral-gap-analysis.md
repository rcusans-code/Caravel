# Stellar RWA-as-collateral: protocol stack and gap analysis

As of 2026-10-25. Legend: ✅ covered · ◐ partial · ❌ missing · n/f = not found. TVL = Stellar-chain TVL from the DefiLlama API, read 2026-10-25, unless stated otherwise.[2]

## 0. Bottom line

- Stellar has about $3.75B of distributed RWAs and $524.58M of stablecoins, but its whole DeFi TVL is a few hundred million dollars.[42][1][35]
- The lending protocols that accept RWAs on Stellar hold single-digit millions of RWA collateral. The largest RWA-collateral position found is Templar's $3.8M of deJAAA, and Templar's markets run on NEAR, not Soroban.[4]
- The large funds (BENJI, Spiko, SWEEP, WisdomTree) are essentially unused as collateral. BENJI requires issuer authorization for every holder, and no Soroban contract holds any BENJI.[16][6]
- The assets that are used (USDY, Etherfuse stablebonds, deJAAA/deJTRSY) are the freely transferable ones.[17][18][31]

## 1. Size of the gap

| Metric | Value | Src |
|---|---|---|
| Distributed RWA value on Stellar | $3.75B | [42] |
| Represented RWA value | $78.22M | [42] |
| Stablecoin market cap | $524.58M | [42] |
| Stellar DeFi TVL (RedStone, July) | $213M against more than $3B of RWAs | [35] |
| Blend Pools V2 TVL / borrowed (6 Oct) | $162.8M / $43.8M; mostly XLM collateral, USDC borrowed | [3] |
| Blend Pools V2 TVL (25 Oct) | $132.2M | [2] |
| Blend RWA pools (CETES, TESOURO, etc.) | each under $10K (Oct). The earlier ~$2M figure from the RedStone/Defiant report could not be re-checked because the article body did not load. | [3][35] |
| BENJI held by Soroban contracts | 0 contracts, 0 BENJI (out of ~434.7M authorized balance) | [16] |
| USDY held by Soroban contracts | 57 contracts, ~5.88M USDY | [17] |
| USTRY held by Soroban contracts | 43 contracts, ~1.07M USTRY | [18] |

## 2. Inventory by layer

### 2a. Issuance / tokenization (how each token is built decides whether DeFi can use it)

| Issuer / token | Token model on Stellar | Permissioning | DeFi-usable today? | Src |
|---|---|---|---|---|
| Franklin BENJI | Classic asset + SAC | `auth_required` + revocable + clawback. 1,385 authorized and 1,072 unauthorized trustlines | ❌ no contract holds it. Used off-chain as Binance/Bybit off-exchange collateral | [16][6] |
| Ondo USDY | Classic asset | revocable + clawback, **not** auth_required | ✅ held by 57 contracts; listed by XOXNO | [17][5] |
| Etherfuse USTRY/CETES/TESOURO | Classic asset | revocable + clawback, not auth_required | ✅ Blend/YieldBlox, Orbit, XOXNO, DeFindex | [18][23][25] |
| Spiko (EUTBL/USTBL/eurSAFO etc.) | Custom Soroban contracts with a permission-manager contract | contract-level allowlist | ◐ XOXNO has a Spiko market configured but disabled | [19][6] |
| Centrifuge deJTRSY/deJAAA | deRWA wrapper, LayerZero OFT | freely transferable wrapper | ✅ Templar ($3.8M deJAAA), XOXNO | [28][31][4] |
| SSGA/Galaxy SWEEP, WisdomTree, Janus Henderson JTRSY | n/f in this pass (no DeFi integration found) | n/f | n/f | — |
| OpenZeppelin RWA suite | T-REX / ERC-3643 implementation for Soroban | identity + compliance modules | library, not a market | [12] |

### 2b. Compliance / permissioning standards

| Standard / tool | What it does | Status | Fit for collateral | Src |
|---|---|---|---|---|
| Asset flags (AUTH_REQUIRED / REVOCABLE / CLAWBACK) | issuer approves each holder; can freeze or claw back | live (protocol-level) | ◐ a pool contract and every liquidator need a trustline authorized by the issuer | [15] |
| SEP-8 Regulated Assets | issuer approves each transaction | Active (created 2018) | ❌ per-transaction approval predates Soroban. No lending protocol found that uses it | [13] |
| SEP-12 KYC API | KYC upload to anchors/services | Active | ◐ anchor onboarding; not a reusable on-chain credential | [14] |
| SEP-57 T-REX | permissioned-token standard (ERC-3643 port) | **Draft** (created 2025-11-26) | ◐ no major Stellar fund issuer found using it yet | [11] |
| Sanctions / AML oracle | screen wallets on-chain | RedStone's is live on Ethereum only | ❌ n/f on Stellar | [10] |
| KYC credential providers (on-chain identity registry) | — | n/f | ❌ | — |

### 2c. Oracles / NAV feeds

| Oracle | Model | RWA / NAV coverage | Used by | Src |
|---|---|---|---|---|
| Reflector | push, SEP-40; DEX, CEX and FX feeds | market prices only (this is the feed type used in the YieldBlox exploit) | Blend, Orbit, DeFindex, Slender, XOXNO | [8][7] |
| RedStone (Mar 2026) | push, 47 feeds (18 SEP-40) | "fundamental" NAV feeds for BENJI, USDY, USTRY, CETES, deJTRSY, deJAAA | Blend, Templar, XOXNO | [8][10] |
| Chainlink (29 Sep 2026) | push, 9 feeds, own interface (not SEP-40) | no RWA/NAV feeds except a FLHY feed; no NAV bounds service on Stellar | none yet | [9] |
| Pyth (Sep 2026) | pull | n/f for RWAs | Templar | [8] |
| Band (2024) | push | n/f | none found | [8] |
| DIA | testnet 2024; mainnet status n/f | n/f | n/f | — |

### 2d. DEX / secondary trading

| Venue | Type | TVL | Permissioned-RWA support | Src |
|---|---|---|---|---|
| Aquarius | AMM | $37.8M | ◐ USTRY/CETES/USDY pools exist but are thin: USTRY/USDC is about $2.28M, and selling 250K USTRY would lose ~20% | [2][6] |
| SDEX (order book) | native DEX | $14.8M | ◐ respects trustline auth; USTRY book was near-empty when it was exploited | [2][7] |
| Sushi Stellar | AMM | $15.4M | n/f | [2] |
| Soroswap | AMM + aggregator (routes Soroswap, Aquarius, Sushi V3, Comet, SDEX) | $1.16M | n/f | [2][27] |
| Phoenix | AMM | $47K | n/f | [2] |
| Permissioned RWA venue (allowlisted AMM or RFQ for BENJI/Spiko) | — | — | ❌ n/f | — |

### 2e. Lending / CDP

| Protocol | Design | TVL | RWA collateral today | Permissioned-RWA support | Src |
|---|---|---|---|---|---|
| Blend V2 (Script3) | permissionless isolated pools + backstop; flash-loan positions | $132.2M | Etherfuse pools under $10K each; YieldBlox lost ~$10M (Feb 2026); backstop paused after the Comet exploit (Aug) | ❌ no allowlist hook found; anyone deploys pools | [2][3][7] |
| Templar | markets on NEAR, Stellar assets via NEAR Intents/HOT bridge | $11.8M | $3.8M deJAAA; $3.2M USDC borrowed against it | ❌ wrapper assets only | [2][4] |
| XOXNO Lending | hub-and-spoke; RWAs collateral-only; dual oracle with bounds; `multiply` | $147K | USDY, USTRY, CETES, deJ*, Spiko (disabled) | ◐ best risk design; tiny; no audit published | [2][5][6] |
| Alula | permissioned RWA pools, KYC/regulated-asset primitives, flash leverage | $9 | none yet | ◐ designed for it, but has no liquidity | [2][22][3] |
| Orbit CDP | mints oUSD against XLM/USTRY/CETES, 150% min C-ratio | n/f | USTRY, CETES | ❌ | [23] |
| FxDAO | stablecoin CDP, XLM collateral only | $0 on DefiLlama | none | ❌ | [24][2] |
| Slender, Peridot, K2 | small lenders | Slender $88 | none | ❌ | [2][3] |

### 2f. Vaults / aggregators / curators

| Protocol | What | TVL | RWA angle | Src |
|---|---|---|---|---|
| DeFindex | vault infra for wallets/fintechs | $19.1M | Blend autocompound (incl. Etherfuse pool) + CETES "RWA Wrapper" that exits through Aquarius | [2][25] |
| Upshift | curated vaults; allowlisted strategies/wallets (max 10); Fordefi custody | $30.3M | n/f | [2][26] |
| Gami Labs (risk curator), Spectra V2 (yield) | — | $30.3M / $0.5M | n/f | [2] |

### 2g. Liquidation / redemption infrastructure

| Item | Status | Src |
|---|---|---|
| Blend backstop + auctions | live, but backstop paused after Aug 2026; v2.1 backstop deployed 4 Oct | [7][3] |
| Spiko instant withdrawal | €500K/day, 24/7, but **off-chain via SEPA** and euro products only; anything above that settles D+1 | [20] |
| Ondo USDY | price updated each business day; USD redemption only by wire to non-US bank accounts | [21] |
| Franklin FOBXX/BENJI | redemptions on business days in normal hours | [6] |
| Issuer redemption restricted to approved holders | blocks liquidation bots from redeeming seized collateral | [6] |
| On-chain 24/7 instant-redemption pool for any Stellar RWA | ❌ n/f | — |

### 2h. Cross-chain and custody

| Item | Status | Src |
|---|---|---|
| Circle CCTP | live (May 2026) | [36] |
| LayerZero | endpoint live; USDT0; Centrifuge deRWA uses OFT | [37][28] |
| Axelar | live (Feb 2026) | [38] |
| Allbridge Core | live (requires trustlines); $0 Stellar TVL on DefiLlama | [39][2] |
| NEAR Intents | $74K | [2] |
| Chainlink CCIP | announced, not live | [9] |
| Wormhole | n/f on Stellar | — |
| Institutional custody | Anchorage custodies CETES; Upshift uses Fordefi. Support for BENJI/Spiko DeFi positions: n/f | [40][26] |

## 3. Gap matrix (capability × protocol)

| Capability | Blend | Templar | XOXNO | Alula | Orbit | DeFindex/Upshift | Oracles (RedStone/Reflector/Chainlink) |
|---|---|---|---|---|---|---|---|
| Permissioned-collateral pool (issuer-allowlisted suppliers, open lenders) | ❌ | ❌ | ❌ (Spiko off) | ◐ design, no TVL | ❌ | ❌ | n/a |
| Whitelisted liquidators / issuer-approved liquidation path | ❌ | ❌ | ❌ | n/f | ❌ | n/a | n/a |
| NAV oracle + hard bounds | ◐ per-pool choice | ◐ RedStone | ✅ | ◐ median of SEP-40 feeds + circuit breaker | ◐ Reflector | n/a | ◐ RedStone NAV exists; Chainlink has no RWA feeds |
| Proof of reserve / NAVLink-style issuer attestation | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ n/f on Stellar |
| Instant redemption / liquidity backstop at NAV | ❌ | ❌ | ❌ | ◐ insurance fund | ❌ | ❌ | n/a |
| Secondary-market depth for liquidations | ❌ (relies on Aquarius/SDEX, ~$2M pools) | — | ◐ small caps sized to depth | ❌ | ❌ | ◐ CETES wrapper exits via Aquarius | n/a |
| Looping / leverage | ◐ flash positions | ❌ | ✅ multiply | ✅ multiply | ❌ | ❌ | n/a |
| Institutional custody integration | ❌ | ◐ MPC | ❌ | ◐ KYC primitives | ❌ | ◐ Fordefi (Upshift) | n/a |
| Cross-chain collateral | ❌ | ✅ (NEAR chain signatures) | ❌ | ❌ | ❌ | ❌ | CCIP not live |

Sources for the matrix: [3][4][5][6][7][8][9][22][23][25][26].

## 4. How Ethereum/Solana closed the same gaps

| Gap | What worked elsewhere | Src | Stellar equivalent needed |
|---|---|---|---|
| Permissioned collateral | **Aave Horizon**: issuer-allowlisted RWA collateral, permissionless stablecoin lenders, non-transferable aTokens. Peaked above $600M (Jan 2026), $256–296M by Jul 2026. Fully KYC'd **Aave Arc** failed. | [29][30] | A Horizon-style Soroban market. The issuer must authorize the pool contract's trustline (BENJI) or add it to its permission manager (Spiko). Lenders stay permissionless. |
| Liquidators | Horizon uses **whitelisted liquidators**. Securitize upgraded sTokens to allow **permissionless liquidations** (sBUIDL on Euler). | [29][32] | Either an issuer-approved liquidator set or an issuer-sanctioned liquidation and redemption path |
| Transferability | **DeFi wrappers**: Centrifuge deRWA, Securitize sToken (sBUIDL, sACRED) | [31][32][41] | Franklin/Spiko issue a DeFi-transferable share class or wrapper (the deJAAA model already works on Stellar) |
| NAV oracle safety | Chainlink DON checks issuer NAV against preset bounds before publishing; NAVLink/SmartData | [29][34] | RedStone NAV feeds plus in-contract bounds (XOXNO pattern); Chainlink NAV/SmartData feeds on Stellar: n/f |
| Instant liquidity | **EulerSwap** instant-redemption pool for sBUIDL | [32] | A USDC pool that buys RWA at NAV minus a haircut, 24/7, and redeems with the issuer as an approved holder |
| Looping | sACRED looping via Morpho/Drift (Polygon/Solana/Ethereum); Kamino's share of RWA lending rose from 2% to 18% | [41][33] | Possible only if borrow cost is below collateral yield (see Gap 4) |

## 5. Ranked gaps (biggest unlock first)

| # | Gap | Unlock size | Who must cooperate | Difficulty | New protocol or issuer action? |
|---|---|---|---|---|---|
| 1 | **No allowlisted-collateral market that the big funds will authorize.** BENJI requires issuer authorization for every holder and no contract holds any. XOXNO's Spiko market is disabled. Blend has no allowlist. | Largest. Covers roughly Spiko's ~$1.6B Active Strategies plus ~$435M BENJI (rwa.xyz class figures from the earlier read; BENJI's ~434.7M authorized balance is confirmed on Horizon [16]), plus SWEEP and WisdomTree. | Franklin, Spiko, SSGA/Galaxy, WisdomTree (authorize the pool contract and define eligible suppliers) | High: legal, operational and onboarding work per issuer | **Both.** A new protocol can build the Horizon-style market (Alula is closest). Only issuers can authorize it or issue a DeFi wrapper. |
| 2 | **No liquidation exit at NAV.** Redemption keeps business hours and is limited to approved holders. Selling 250K USTRY on Aquarius loses ~20%. Spiko's 24/7 instant exit is off-chain SEPA. | Without it, LTVs and caps stay tiny on every venue | Issuers (whitelist a redemption/liquidator contract); USDC market makers | Medium–high | **Mostly a new protocol:** an instant-redemption/backstop vault (EulerSwap-sBUIDL pattern). It needs issuer approval as a redeemer. |
| 3 | **Uneven NAV oracle coverage, and no bounded issuer-NAV attestation.** RedStone covers BENJI/USDY/Etherfuse/deJ*. Spiko/eurSAFO coverage was not found. Chainlink has no RWA feeds on Stellar. | Needed for #1 and #2. The YieldBlox $10M loss came from market-price pricing. | RedStone/Chainlink + issuers (signed NAV publication) | Low–medium | **New protocol / oracle vendor.** Bounds can live in the lending contract (XOXNO does this). |
| 4 | **Borrow economics and liquidity depth.** Blend USDC suppliers earned 6.69% (6 Oct), so borrowers paid more. Tokenized Treasuries yielded ~3.6%. Looping therefore has negative carry. Only $43.8M is borrowed on Blend. | Decides whether demand exists at all | SDF/stablecoin issuers (incentives), CDP designers | Medium | **New protocol:** e.g. a low-rate stablecoin minted against RWA (Horizon uses GHO; Orbit's oUSD already accepts USTRY/CETES) |
| 5 | **Cross-chain collateral and custody.** CCIP is not live. Custody support for DeFi positions was found only for CETES (Anchorage). Templar's cross-chain model runs through a NEAR bridge. | Moderate. Brings in collateral and borrowers from other chains. | Chainlink, LayerZero/Axelar, custodians (Anchorage, Fireblocks: n/f) | Medium | Mostly infrastructure vendors; a protocol can integrate LayerZero OFT (as deRWA does) |

Sources for this section: [16][5][6][19][20][21][8][9][7][3][23][9][40][4][29][32].

Notes / gaps in evidence:
- Spiko token holdings by contracts, eurSAFO oracle coverage, the SWEEP/WisdomTree token models, DIA mainnet status, and Fireblocks Soroban support: **not found**.
- The Blend borrow rate was not retrieved. "Borrow is above 6.69%" is inferred from the supply rate.
- WhaleHub is the source for many Stellar figures. It is a single secondary source that cites DefiLlama and on-chain configs. The key figures were cross-checked against the DefiLlama API and Horizon where possible.

## Sources

[1] https://whalehub.io/blog/stellar-defi-tvl-2026 — WhaleHub: Stellar DeFi TVL 2026
    > "About $919M of dollar stablecoins and $3.51B of RWAs live on Stellar, mostly outside DeFi."
[2] https://api.llama.fi/protocols — DefiLlama protocols API (Stellar TVL snapshot 2026-10-25)
    > "Blend Pools V2 | Lending | Stellar TVL 132,151,879"
    > "Templar Protocol | Lending | Stellar TVL 11,837,671"
    > "XOXNO Lending | Lending | Stellar TVL 147,271"
    > "Alula | Lending | Stellar TVL 9"
    > "Aquarius Stellar | Dexs | Stellar TVL 37,785,294"
    > "DeFindex | Yield Aggregator | Stellar TVL 19,124,941"
    > "Upshift | Onchain Capital Allocator | Stellar TVL 30,256,169"
    > "Soroswap AMM | Dexs | Stellar TVL 1,162,648"
    > "Phoenix DeFi Hub | Dexs | Stellar TVL 47,333"
    > "Stellar DEX | Dexs | Stellar TVL 14,791,969"
    > "Sushi Stellar | Dexs | Stellar TVL 15,351,507"
    > "Slender | Lending | Stellar TVL 88"
    > "FxDAO | Partially Algorithmic Stablecoin | Stellar TVL 0"
    > "Allbridge Core | Bridge | Stellar TVL 0"
    > "NEAR Intents | Bridge | Stellar TVL 74,155"
    > "Defa By InvoiceMate | RWA | Stellar TVL 4,013,209"
    > "Huma | RWA | Stellar TVL 2,726,084"
    > "Spectra V2 | Yield | Stellar TVL 501,459"
    > "Gami Labs | Risk Curators | Stellar TVL 30,262,514"
[3] https://whalehub.io/blog/best-lending-protocols-stellar — WhaleHub: Best lending protocols on Stellar (2026)
    > "Smaller pools list CETES, TESOURO, USDGLO, AQUA, PYUSD and SolvBTC, each holding under $10K."
    > "Blend's Fixed V2 pool is currently "on ice" on-chain, which blocks new borrowing while supplying, repaying and withdrawing still work"
    > "It is live but tiny, with TVL that rounds to zero on DefiLlama."
    > "Blend V2 includes a `flash_loan` function"
    > "Blend's interface added a v2.1 deployment with a new backstop on 4 October."
    > "Its Fixed pool paid 6.69% on USDC on 6 October (DefiLlama)."
    > "| Blend Pools V2 | $162.8M | $43.8M | XLM $151.1M, USDC $11.5M |"
[4] https://whalehub.io/blog/templar-protocol-stellar — WhaleHub: Templar Protocol on Stellar
    > "Templar's markets are NEAR contracts; Stellar assets appear inside them as tokens on NEAR Intents issued through HOT's omnichain bridge, which the user does not handle directly."
    > "Of $12.4M Stellar USDC borrowed, about $7.8M was borrowed against BTC and WBTC, $3.2M against deJAAA and $1.3M against XLM, by our reading of the market balances."
    > "Stellar TVL was $12.0M on 9 October 2026: about $6.6M of XLM, $3.8M of deJAAA and $1.6M of net USDC deposits, per DefiLlama."
[5] https://whalehub.io/blog/xoxno-lending-stellar — WhaleHub: XOXNO Lending on Stellar
    > "RWAs and Aquarius LPs are collateral-only and never borrowable, which limits how far a bad price can spread."
    > "Stellar TVL was $131K on 6 October 2026, the code is PolyForm Noncommercial, and no third-party audit report was published yet."
    > "`multiply` builds looped long or short positions in one transaction."
    > "**Borrowing one stablecoin against another:** Stables & FX gives the highest LTVs (USDC 88%, PYUSD 86%, EURC and USDT0 84%) and also accepts USDY, USST and Spiko funds at 80%."
[6] https://whalehub.io/blog/rwa-defi-collateral — WhaleHub: RWAs as DeFi collateral
    > "Permissioned tokens such as BENJI, whose Stellar issuer requires authorisation for every holder, cannot be held by a permissionless lending contract at all unless the issuer approves it."
    > "On 2 October 2026 Aquarius's USTRY/USDC pool held about 1.02M USTRY and 1.10M USDC, around $2.28M in total."
    > "selling 250,000 USTRY into it — the size of XOXNO's whole USTRY supply cap — would realise about 20% less than the spot price."
    > "A Spiko market is configured but disabled."
    > "Many funds will only redeem for approved holders, so a liquidation bot cannot simply redeem what it seized."
    > "Binance from February 2026 and Bybit from September 2026 accept Franklin Templeton's Benji shares as off-exchange collateral, per crypto.news."
    > "Franklin's FOBXX processes purchases and redemptions on business days during normal hours, per its prospectus."
    > "XOXNO Lending's published mainnet configuration for Stellar applies all of these tools."
    > "rwa.xyz showed a 3.6% seven-day yield across tokenised Treasury funds on 2 October 2026"
[7] https://whalehub.io/blog/blend-exploits-2026 — WhaleHub: Blend's 2026 incidents
    > "On **22 February 2026**, an attacker drained roughly **$10M** from the YieldBlox pool."
    > "Blend paused its backstop in response."
    > "On **25 August 2026**, the Comet BLND-USDC pool that holds Blend's backstop deposits was exploited for about **$717K**."
    > "The pool let users borrow XLM and USDC against **USTRY**, a tokenised Treasury product, and priced USTRY through a Reflector feed that sourced from the USTRY/USDC market on the Stellar DEX."
[8] https://whalehub.io/blog/stellar-oracles — WhaleHub: Oracles on Stellar
    > "RedStone reports 47 feeds on Stellar, 18 of them SEP-40 compliant."
    > "SEP-40 is a draft Stellar standard, created in 2023"
    > "RedStone's "fundamental" (NAV-style) feeds cover BENJI, USDY, USTRY and CETES; a DEX price for these tokens can be meaningless."
    > "Reflector runs three public mainnet oracles: Stellar DEX prices, external exchange prices and fiat exchange rates."
    > "Band, live since 2024; and Chainlink and Pyth, both added in September 2026."
    > "Templar (per DefiLlama)"
[9] https://whalehub.io/blog/chainlink-on-stellar — WhaleHub: Chainlink on Stellar
    > "CCIP, the piece that would move tokens across chains, is announced but not live."
    > "It does not cover Stellar-native or RWA tokens, it updates slowly on calm markets by design, and nobody has wired it into a live Stellar market yet."
    > "**Chainlink on Stellar** went live on 29 September 2026 as nine Data Feeds served through a single proxy contract"
[10] https://www.redstone.finance/blog/reliability-at-scale-redstone-and-the-data-standard-for-stellars-rwa-moment — RedStone: SEP-40 on Stellar
    > "RedStone’s implementation of SEP-40 is now in production across the RWA asset set on Stellar."
    > "RedStone Sanctions Oracle, live today on Ethereum mainnet"
[11] https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0057.md — SEP-57 T-REX
    > "T-REX tokens are **permissioned tokens**, ensuring secure and compliant transactions for all parties involved in the token transfer."
    > "Status: Draft Created: 2025-11-26"
[12] https://docs.openzeppelin.com/stellar-contracts/tokens/rwa/rwa — OpenZeppelin Stellar RWA token
    > "The RWA suite provides a comprehensive framework based on the T-REX (Token for Regulated Exchanges) standard, which implements the [ERC-3643](https://docs.erc3643.org/erc-3643) specification."
[13] https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md — SEP-8 Regulated Assets
    > "Regulated Assets are assets that require an issuer’s approval (or a delegated third party’s approval, such as a licensed securities exchange) on a per-transaction basis."
    > "Status: Active Created: 2018-08-22"
[14] https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md — SEP-12 KYC API
    > "This SEP defines a standard way for stellar clients to upload KYC (or other) information to anchors and other services."
[15] https://developers.stellar.org/docs/tokens/control-asset-access — Stellar docs: control asset access
    > "When `AUTH_REQUIRED_FLAG` is enabled, an issuer must approve an account before that account can hold its asset."
[16] https://horizon.stellar.org/assets?asset_code=BENJI&asset_issuer=GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 — Horizon: BENJI asset (Franklin issuer)
    > ""authorized": 1385, "authorized_to_maintain_liabilities": 0, "unauthorized": 1072"
    > ""num_contracts": 0, "contracts_amount": "0.0000000", "flags": { "auth_required": true, "auth_revocable": true,"
[17] https://horizon.stellar.org/assets?asset_code=USDY&asset_issuer=GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6 — Horizon: USDY asset (Ondo issuer)
    > ""num_contracts": 57, "contracts_amount": "5876718.0302884", "flags": { "auth_required": false, "auth_revocable": true,"
[18] https://horizon.stellar.org/assets?asset_code=USTRY&asset_issuer=GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC — Horizon: USTRY asset (Etherfuse issuer)
    > ""num_contracts": 43, "contracts_amount": "1070891.0807183", "flags": { "auth_required": false, "auth_revocable": true,"
[19] https://tech.spiko.io/posts/stellar-integration — Spiko tech blog: Stellar integration
    > "In October 2025, Spiko launched its tokenized funds on Stellar."
    > "in 2024, Soroban—a new smart contract platform—was deployed on top of it."
    > "We use it, for example, to store the address of the permission contract"
[20] https://www.spiko.io/blog/500-000-euros-instant-withdrawal — Spiko: €500k instant withdrawals
    > "As of July 16, 2026, the instant withdrawal cap has increased from **€100,000 to €500,000 per day**."
    > "This feature runs on instant SEPA transfers, which settle in under 10 seconds and credit your bank account instantly."
    > "Anything above €500,000 gets credited the next business day (D+1)."
[21] https://docs.ondo.finance/general-access-products/usdy/basics — Ondo: USDY basics
    > "Ondo USDY LLC can only redeem USD via bank wire to non-US bank accounts."
    > "This ‘rebasing’ happens automatically when the USDY price is updated each business day."
[22] https://docs.alula.finance/tech-docs — Alula docs
    > "Supply RWA as collateral into a permissioned pool → borrow stablecoins → hedge or diversify exposure through allow-listed venues"
    > "Built-in support for KYC, regulated assets, anchors, and fiat ramps enables policy-aligned participation and simpler institutional onboarding on Stellar."
[23] https://orbitcdp.finance — Orbit CDP
    > "Lock XLM, USTRY or CETES into a smart contract vault."
    > "Min. C-Ratio 150%"
[24] https://docs.fxdao.io/the-basics — FxDAO docs
    > "FxDAO is a decentralized borrowing protocol that allows the issuance of stablecoins by letting users lock Lumens into Vaults as collateral."
[25] https://whalehub.io/blog/defindex-explained — WhaleHub: DeFindex explained
    > "Published mainnet strategies on 8 October 2026: Blend Autocompound (Fixed and Etherfuse pools) and an RWA Wrapper for CETES."
    > "The RWA Wrapper exits through an Aquarius pool, so large withdrawals pay price impact."
[26] https://whalehub.io/blog/upshift-stellar-vaults — WhaleHub: Upshift vaults on Stellar
    > "The curator can only use whitelisted strategies and wallets, at most ten"
[27] https://docs.soroswap.finance — Soroswap docs
    > "The Soroswap Aggregator API quotes Soroswap, Aquarius, SushiSwap V3, Comet and the Stellar classic DEX (SDEX)"
[28] https://centrifuge.io/blog/derwa-on-stellar-with-20m-allocation — Centrifuge deRWA on Stellar
    > "To ensure trust and transparency, Centrifuge has chosen LayerZero’s OFT Standard to bring these funds to Stellar."
    > "**Blend** for lending and borrowing powered by deRWAs"
[29] https://aave.com/docs/aave-v3/horizon — Aave Horizon docs
    > "The core function of the Aave Horizon market is to allow users to supply permissioned, tokenized RWAs as collateral while borrowing permissionless stablecoins."
    > "A key characteristic of this market is that these receipt tokens are non-transferable"
    > "creating a window where whitelisted liquidators could exploit a faulty price and cause irreparable harm to borrowers."
    > "When an issuer reports a new NAV, the Chainlink DON validates it against these bounds before publishing it onchain."
[30] https://coinpaprika.com/education/aave-rwa — Coinpaprika: Aave & RWA
    > "Deposits crossed $600M by January 2026, making Horizon the largest permissioned RWA lending market on-chain, before pulling back to $256-296M by late July 2026."
    > "Arc wrapped an entire lending pool behind KYC — every depositor, borrower, and liquidator needed whitelisting before touching the market."
[31] https://morpho.org/stories/centrifuge — Morpho: Centrifuge story
    > "Through Centrifuge's deRWA standard, these tokens become freely transferable and DeFi-compatible."
[32] https://forum.euler.finance/t/accept-sbuidl-as-collateral-in-stablecoin-vaults-in-euler-prime-and-euler-yield/1467 — Euler forum: sBUIDL collateral
    > "Securitize’s wrapper makes BUIDL easily transferrable and a recent upgrade to the sToken system enables permissionless liquidations, thus making sBUIDL eligible as collateral on Euler."
    > "This addition intends to facilitate the pilot of an instant redemption pool for sBUIDL using Euler’s newly launched hybrid DEX, EulerSwap."
[33] https://solanacompass.com/news/kaminos-share-of-onchain-rwa-lending-has-climbed-from-2-to-18-since-october — Solana Compass: Kamino RWA lending share
    > "Blockworks Research shows Kamino Finance's share of onchain RWA lending rose from 2% to 18% since October 2025, with vaults now at 25% of all deposits."
[34] https://docs.chain.link/data-feeds/smartdata — Chainlink SmartData docs
    > "Chainlink NAVLink Feeds provide real-time, tamper-proof data on the Net Asset Value (NAV) of tokenized assets, funds, or portfolios."
[35] https://thedefiant.io/converge/defi/stellar-rwa-3-billion-defi-tvl-gap-redstone-report — The Defiant: Stellar RWA vs DeFi gap (RedStone report)
    > "RedStone puts tokenized real-world assets on Stellar above $3 billion in July, against DeFi value it measures at $213 million."
[36] https://stellar.org/blog/foundation-news/circle-cctp-is-live-on-stellar — Stellar: Circle CCTP live
    > "Circle CCTP (Cross-Chain Transfer Protocol) is live on the Stellar network."
[37] https://layerzero.network/blog/layerzero-endpoint-on-stellar-usdt0 — LayerZero endpoint on Stellar
    > "Now, the LayerZero endpoint is live on Stellar, and USDT0 is the first asset to deploy on it."
[38] https://www.axelar.network/blog/axelar-stellar-integration — Axelar integrates Stellar
    > "At launch, several projects are already live and building with Axelar and Stellar."
[39] https://docs-core.allbridge.io/sdk/guides/stellar/transfer — Allbridge Core Stellar transfer guide
    > "Finally, if you make a transfer to Stellar, you have to ensure that you have trustlines for the destination token."
[40] https://www.anchorage.com/press-room/anchorage-digital-supports-custody-for-tokenized-cetes-etherfuses-tokenized-mexican-government-debt-on-stellar — Anchorage: custody for CETES on Stellar
    > "today announced custody support for CETES, tokenized Mexican government debt issued by Etherfuse on the Stellar blockchain."
[41] https://www.redstone.finance/blog/sacred-goes-defi-the-first-private-credit-fund-earning-onchain-yield — RedStone: sACRED goes DeFi
    > "It is already deployed across leading money markets like Morpho and Drift Institutional on multiple blockchains, including Polygon, Solana, Ethereum, all secured by RedStone Oracles."
[42] https://app.rwa.xyz/networks/stellar — rwa.xyz: Stellar network
    > "Distributed Asset Value $3.75B"
    > "Represented Asset Value $78.22M"
    > "Stablecoin Market Cap $524.58M"
