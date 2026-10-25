# Stellar backing-chain map: what each material Stellar token ultimately rests on

As of 2026-10-25. Scope: every token with more than $5M on Stellar per rwa.xyz, plus selected smaller assets (EURC, USDGLO, WTGXX, CETES, TESOURO, SolvBTC, XLM). Companion to [rwa-collateral-gap-analysis.md](rwa-collateral-gap-analysis.md), which covers the protocol stack and lending gaps. n/f = not found. Supply figures are my sums of the Horizon or stellar.expert fields cited for each token. Hop counts and tiers are my structural reading of the cited documents, not a figure any source publishes.

## 0. Bottom line

- Stellar carries $3.75B of distributed RWAs and $524.58M of stablecoins.[42]
- Only a minority of that value ends in US T-bills by a short, audited path. The clean ones are BENJI, USDC, PYUSD, gBENJI, Spiko USTBL and WTGXX.[14][2][6]
- The largest Stellar RWA, Spiko's eurSAFO ($1.46B), does **not** end in T-bills. The fund holds a portfolio of equities and bonds and swaps it to €STR with G-SIB counterparties.[42][40] By my sum, the SAFO share classes are about $1.64B, roughly 44% of Stellar's distributed RWA value.
- The third-largest "RWA", TPT30 ($500M, one holder), is corporate credit of an OTC-listed company. It ends in credit, not anything safe.[42][32]
- Even USDC rests mostly on overnight Treasury repo, not on bills it owns outright: $52.5B of repo against $8.5B of bills on 30 June 2026.[2]
- XLM has no issuer and no backing.[36]

## 1. How to read the chain

- **Chain** = Stellar token → legal issuer or fund → (wrapper, feeder or note layer) → terminal instrument. Custodians are listed but not counted as hops.
- **Hops** = arrows from the token to the terminal instrument. Each hop is an entity whose solvency, operations or legal claim you depend on.
- **Terminal asset** = the instrument where the chain stops. For a USD lender the benchmark is short-dated US Treasury bills, or repo collateralised by Treasuries.
- **Flags** come from Horizon for classic assets. For Soroban-only tokens, admin powers live in contract code that I did not audit, so they are marked n/f unless a source states them.

## 2. Backing chains, asset by asset

### 2a. Dollar stablecoins

**USDC (Circle)**
- Stellar token: `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`. Horizon flags: `auth_revocable` only, so the issuer can freeze but cannot claw back. Supply is about 384.2M, of which about 136.9M sits in contracts.[43] rwa.xyz values it at $386,788,356.[42]
- Chain: token → Circle Internet Financial, LLC (issues and redeems USDC alongside Circle Internet Financial Europe SAS) → Circle Reserve Fund USDXX, a BlackRock SEC 2a-7 government MMF → T-bills plus overnight Treasury repo with global banks. The remaining reserve is cash at large banks.[2][1]
- Holdings on 30 June 2026: $8.52B of T-bills, $52.53B of Treasury repo, and $11.38B of cash at regulated financial institutions.[2] Repo is overnight lending of cash that is overcollateralised by Treasuries.[2] USDXX's weighted average maturity was 17 days on 23 October.[3]
- Terminal: US Treasuries, about 84% held via repo, plus about 16% bank deposits (my arithmetic from [2]).
- Assurance: a Big Four firm gives monthly assurance.[1] Hops: 3.
- Who can redeem, window, minimum: Circle Mint institutional customers. The redemption window and minimum for USDC were n/f this pass. For EURC, Circle says issuance runs only through Circle Mint, for institutions in supported jurisdictions.[4]
- Freeze: the issuer can freeze via `auth_revocable` on Stellar.[43]

**PYUSD (Paxos / PayPal)**
- Stellar token: `PYUSD:GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5`, confirmed by PayPal.[78] Flags: revocable + clawback. Supply is about 86.9M.[45]
- Chain: token → Paxos Trust Company, N.A. → reserves held "100% in US dollar deposits, US treasuries and cash equivalents".[5][6]
- Regulator: Paxos says the OCC oversees PYUSD issuance and its reserves.[6] PayPal's older Stellar blog still names Paxos Trust Company, LLC under NYDFS.[78] I weight the Paxos page as current.
- Assurance: monthly attestations by KPMG since February 2025.[5] Custodian banks and the latest composition split were n/f.
- Hops: 2. Redemption is 1:1 with Paxos for its customers.[6] Window and minimum were n/f.
- Freeze / clawback: both enabled on Stellar.[45]

**USDT0 (Tether, via Everdawn Labs / LayerZero)**
- Stellar token: `USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q`. Many look-alike codes exist, so pin this issuer.[76] Flags: revocable + clawback. Supply is about 7.28M.[46] rwa.xyz does not list it.
- Chain: token → USDT locked in the OFT Adapter on Ethereum, owned by a multisig and verified by a 3-of-3 DVN set → USDT, a liability of Tether International, S.A. de C.V. → Tether reserves.[7][12]
- Reserves on 30 June 2026, per the BDO report: T-bills $114.96B and overnight repo $18.63B out of $187.75B of assets. They also include precious metals $18.84B, Bitcoin $5.80B, public equities $3.76B, other investments $5.24B and secured loans $13.45B.[13]
- Terminal: mixed. By my arithmetic about 61% is T-bills and about 22% is gold, BTC, equities, other investments and loans.
- Hops: 3, plus a bridge. Weakest links: an offshore issuer, a non-cash share of reserves, and multisig/bridge risk.
- Redemption: burn on any chain to unlock USDT on Ethereum.[7] The USD redemption terms with Tether were n/f.
- Freeze / clawback: both enabled on Stellar.[46]

**USDGLO (Glo Dollar / Brale)**
- Stellar token: `USDGLO:GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV`.[77] Flags: revocable + clawback. Supply is only about 252.8K on Stellar, which is under $5M.[61]
- Chain: token → Brale Inc. → reserves. On 30 September 2026 these were cash and cash equivalents of $923,605 and US government-backed debt of $64,451, against 988,057 USDGLO issued across all chains.[9][8]
- Terminal: mostly bank cash and cash equivalents. Hops: 2.

**YLDS (Figure)**
- Stellar token: `YLDS:GAC7MOPTQLQUM3KC24AW4GHS3RLF72LPEZO54AH7EZ6TSMGRB5SOAVH3`. Flags: auth_required + revocable + clawback. Supply is about 25.2M across 12 accounts.[52]
- Chain: token → Figure Certificate Company, an SEC-registered face-amount certificate issuer that files reports with the SEC → segregated reserves at UMB Bank NA.[29]
- Reserve composition is "available on demand", not published; n/f. Hops: 2.

### 2b. Euro stablecoins

**EURC (Circle)**
- Stellar token: `EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2`. Flags: revocable only. Supply is about 4.38M.[44] rwa.xyz values it at $4,787,141.[42]
- Chain: token → Circle Internet Financial Europe SAS, an ACPR-licensed EMI → euro reserves. Circle's transparency page shows EURC reserves only as bank deposits, split between systemically important institutions and other banks.[4][1]
- Terminal: euro commercial-bank deposits, not sovereign bills. Hops: 2.
- Redemption: any holder that passes AML checks can redeem at any time at par. Issuance runs only through Circle Mint.[4]
- Freeze: Circle SAS may freeze EURC linked to suspected crime.[4]

**EURCV (SG-Forge)**
- Stellar token: `EURCV:GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G`. Flags: auth_required + revocable + clawback. Supply is 15.03M across 11 accounts, and no contracts hold any.[47]
- Chain: token → Société Générale-FORGE, an EMI and investment firm supervised by ACPR/AMF → a segregated account at Société Générale, the parent bank. The assets must follow MiCA Article 54 investment rules.[11]
- Terminal: a euro deposit at Société Générale, plus whatever MiCA-eligible assets are held. Holders carry Société Générale credit risk. Hops: 2.
- Redemption: EEA residents can redeem at any time at par. Payout can come as late as the last business day of the month after the controls clear.[11] The issuer may refuse to redeem to non-Permitted Transferees.[11]

### 2c. US government money funds and Treasury funds

**BENJI / FOBXX (Franklin Templeton)**
- Stellar token: `BENJI:GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5`. Flags: auth_required + revocable + clawback. Supply is about 434.7M across 1,385 authorized accounts, and no contracts hold any.[48]
- Chain: token, which is the fund share itself (the transfer agent keeps the official register on Stellar) → Franklin OnChain U.S. Government Money Fund, a 1940 Act fund that seeks a stable $1.00 → at least 99.5% Government securities, cash and fully collateralised repo.[14]
- Terminal: US government securities and govt repo. Hops: 2, the shortest path in this map.
- Redemption: through the Benji app or institutional portal, processed only during normal business hours on business days. The minimum initial purchase is $20.[14]
- Control: the transfer agent can correct errors or unauthorised transactions whoever holds the key.[14] Custodian name: n/f in the prospectus.

**gBENJI (Franklin, Luxembourg UCITS)**
- `gBENJI:GD5J73EKK5IYL5XS3FBTHHX7CZIYRP7QXDL57XFWGC2WVYWT326OBXRP`. Flags: auth_required + revocable + clawback. Supply is about 51.6M across 15 accounts.[49]
- Chain: token → Franklin OnChain U.S. Government Money Fund (Luxembourg UCITS) → U.S. money market instruments.[37] Hops: 2. Redemption terms: n/f.

**sgBENJI (Franklin, Singapore)**
- `sgBENJI:GAGICV3VBJSKKH5H5MQQIUTUP462YVHC23KUHZY6FJERRJFBDIVZBM5C`. Flags: auth_required + revocable + clawback. Supply is about 38.5M across 13 accounts.[50]
- Chain: token → a Franklin Templeton Investments VCC fund, MAS-supervised → money market instruments in global markets, held with DB International Trust (Singapore).[38]
- Terminal: global money-market paper, not purely US government. Redemption: accredited investors, at NAV with monthly settlement.[38] Hops: 2.

**WTGXX (WisdomTree)**
- `WTGX:GDMBNMFJ3TRFLASJ6UGETFME3PJPNKPU24C7KFDBEBPQFG2CI6UC3JG6`. Flags: auth_required + revocable + clawback. Supply is about 2.38M.[58] rwa.xyz values it at $2,338,661, so it is under $5M.[42]
- Chain: token → WisdomTree Treasury Money Market Digital Fund, which seeks a stable $1.00 NAV → US Treasury obligations.[25] Holdings and custodian were not read this pass. Hops: 2.

**Spiko USTBL**
- Soroban contract `CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO`, supply about 327.5K units.[66] rwa.xyz values it at $36,036,407.[42]
- Chain: token → Spiko US T-Bills MMF, an EU short-term VNAV sub-fund of Spiko SICAV → 100% US T-bills, repo secured by them, and cash.[39] Hops: 2.
- Depositary and permissioning: the same as EUTBL below.

**SWEEP (State Street / Galaxy)**
- Soroban contract `CB6PIAMD6VPZEI7CMS4PMN6RL5LBTRNAO2ICB7SFXATKKIETOWFZILW3`, with 1 trustline.[69] rwa.xyz values it at $74,973,313.[42] The raw supply field (14769636358118832 at 7 decimals) does not reconcile with that value. Unit or decimals: n/f.
- Chain: token → SWEEP, a private fund that is not an SEC-registered MMF and has a Master Fund → mostly treasury securities, plus repo and stablecoins. State Street Bank and Trust holds the securities and Anchorage holds the stablecoins.[24][23]
- Redemption: Qualified Purchasers only, minimum $5M for entities. Stablecoin redemption runs 24/7, subject to stablecoin availability in the portfolio.[24][23][41] Hops: 3.

**USDY (Ondo)**
- `USDY:GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6`. Flags: revocable + clawback, not auth_required. Supply is about 467.5M, of which about 5.88M sits in contracts.[51] rwa.xyz values it at $538,032,183 and lists the domicile as BVI.[42]
- Chain: token → tokenized note. Ondo USDY LLC issued it originally, and it was folded into the Ondo Stocks umbrella on 15 Dec 2025. USDC redemption runs through Ondo Global Markets (BVI) Limited.[16]
- Collateral: short-term US Treasuries, iShares Short Treasury Bond ETF shares, or bank demand deposits, depending on issuance date.[16][15]
- Terminal: T-bills, partly via an ETF, plus bank deposits. Hops: 2, or 3 via the ETF.
- Redemption: non-US holders only. USD goes by wire to non-US banks only. There is a $5,000 minimum on Stellar.[16] The marketing page says mint and redeem run 24/7, but the docs say the price updates each business day.[15][16]

**deJTRSY → JTRSY (Centrifuge / Janus Henderson Anemoy)**
- deJTRSY: Soroban contract `CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV`, about 10.52M units with 248 trustlines.[71] rwa.xyz values it at $8,022,539.[42]
- Native JTRSY on Stellar: `CBHOEKLWTB6HR2A3IXHIIMQG5FOXWXS6EG4Q5YJDRPMXPCX7M24CYR2O`, about 4.55M units with 1 trustline.[73]
- Chain: deJTRSY, a freely transferable deRWA wrapper carried over LayerZero OFT → JTRSY fund shares → Janus Henderson Anemoy Treasury Fund (BVI, FSC-licensed) → 0–6 month US T-bills held directly, with J.P. Morgan as custodian.[28][26]
- Terminal: US T-bills. Hops: 3, plus a bridge.
- Redemption: underlying redemption is open to non-US professional investors only, with a 500,000 USDC minimum. Settlement is daily, T+0 or T+1.[26] The wrapper's own redemption path: n/f.

### 2d. Non-US sovereign bills and bonds

**Spiko EUTBL / UKTBL**
- EUTBL: `CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF`, about 2.29M units.[63] rwa.xyz values it at $271,832,624.[42]
- UKTBL: `CDT3KU6TQZNOHKNOHNAFFDQZDURVC3MSTL4ML7TUTZGNOPBZCLABP4FR`, about 71.6K units, valued at $9,925,498.[67][42]
- Chain: token, a custom Soroban contract with a permission manager (gap analysis §2a) → Spiko EU T-Bills MMF, AMF-approved and managed by Twenty First Capital → short-term T-bills from core eurozone countries. CACEIS is the depositary.[21]
- Terminal: core-EZ sovereign bills. UKTBL's mandate was not read; by name it holds UK T-bills. Hops: 2. Minimum initial deposit is €1.[21] Instant withdrawal limits are in the gap analysis.

**Etherfuse USTRY / CETES / TESOURO**
- All three share the issuer `GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC`. Flags on all three: revocable + clawback, not auth_required.[53][54][55] WhaleHub reported no flags on 2 Oct, so they appear to have been set since.[19]
- Supplies: USTRY about 11.5M, CETES about 54.2M, TESOURO about 1.19M.[53][54][55] rwa.xyz values them at $12,413,080, $3,455,640 and $304,731.[42]
- Chain: token → Etherfuse. Etherfuse's own page calls it a Mexican corporation with a Swiss DLT registration, while rwa.xyz calls it a US corporation → bonds held "in administration" at regulated Mexican brokers (BBVA México, Actinver, Kuspit) → sovereign debt.[19][17]
- CETES custody runs through INDEVAL.[18] For USTRY, sources disagree on custody: Spiko SICAV per rwa.xyz versus the US Bureau of the Fiscal Service per Etherfuse.[19]
- Terminal: USTRY = US Treasury **notes**, CETES = Mexican federal bills, TESOURO = Brazilian short-term sovereign bonds.[17][19] Hops: 2, but custody is contested.
- Redemption: at NAV under each product's terms and settlement timing.[17] Minimums: n/f.

### 2e. Synthetic, credit, equity and crypto

**Spiko SAFO family (eurSAFO, SAFO, gbpSAFO, chfSAFO)**
- eurSAFO: `CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP`, about 12.91M units.[62] SAFO, gbpSAFO and chfSAFO have about 1.15M, 0.37M and 0.043M units.[64][65][68] Values per rwa.xyz: eurSAFO $1,464,692,684, SAFO $117,655,077, gbpSAFO $50,966,099 and chfSAFO $5,210,880.[42]
- Chain: token → Spiko Amundi Overnight Swap Fund, a sub-fund of Spiko SICAV under the AMF, with CACEIS as depositary → a diversified portfolio of equities and bonds → total return swaps with G-SIBs rated A- or above, starting with BNP Paribas, that exchange the portfolio's return for €STR.[22][20][40]
- Terminal: an equity/bond basket plus bank counterparty credit. Basket composition and collateral terms: n/f. Hops: 2, but the terminal is not a safe asset.
- Redemption: overnight liquidity, with subscriptions from 1 EUR/USD/GBP/CHF.[20]

**deJAAA → JAAA (Centrifuge / Janus Henderson Anemoy AAA CLO Fund)**
- deJAAA: `CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL`, about 11.65M units with 51 trustlines.[70] It is valued at $8,687,119.[42]
- Native JAAA: `CDV6U7OEVY6KUEJ4WNS63AYB6RFU3BAE7AZJOQ7LPH447C6NWUXEZZSO`, about 4.86M units with 1 trustline. It is valued at $5,119,617.[72][42]
- Chain: deJAAA OFT wrapper → JAAA fund (BVI) → a portfolio of high-quality CLOs → AAA CLO tranches → leveraged loans.[28][27] J.P. Morgan is listed as custodian.[27]
- Terminal: corporate credit. Hops: 4.
- Redemption: daily, for whitelisted investors approved by the fund administrator.[27]

**TPT30 (VuMe Bond 2030, Realiz)**
- `CBUBVYRKTQLMDRUBPP6SH4GO33KZCEEYBIWB5AWNGKODP4A6KPKM2VJ4`: 500M units, 1 trustline.[74] rwa.xyz shows $500.00M at a $1.00 NAV with 1 holder. The issuer is TPT Global Tech (OTC: TPTW), under the Luxembourg securitisation law.[32][42]
- Terminal: corporate credit of an OTC-listed issuer. Hops: 2.
- It is about 13% of Stellar's distributed RWA figure (my arithmetic), resting on one holder and a $1.00 mark.

**Other >$5M credit, equity and real-estate tokens.** One line each. All are terminal non-safe assets.
- SPX (Cometum, NYALA): an SPV holding SpaceX common stock. 20,000 units, auth_required + clawback, valued at $26,888,649.[33][59][42]
- RVL5 / RVL4 (Rivool): notes from Rivool Global SPV, backed by a senior FIAgro-FIDC position, which is Brazilian agri credit. RVL5 has no flags and 1 holder.[34][60][42]
- RSRB / RSR / LDVM (RedSwan): equity tranches in US hotels and multifamily property. RSRB is a 104-unit Chicago-area multifamily building.[35][42]
- SPXUX / TECHX (WisdomTree): equity funds. SPXU and TECH are auth_required + clawback.[56][57][42]
- LIQVID1037_S (TermMax): asset-backed credit under an HK professional-investor exemption, valued at $5,844,796. Backing details: n/f.[42]

**SolvBTC**
- The Stellar contract supports admin mint and burn, a blacklist, and pausable transfers.[31] The Stellar supply and canonical address were n/f; Horizon shows only look-alike codes.
- Chain: token → Solv vault and bridge → BTC deposited into protocol-managed Bitcoin addresses under FROST threshold signing.[30]
- Terminal: BTC. Hops: 2. BTC is not a safe asset in the T-bill sense.

**XLM**
- XLM is the native asset. It needs no issuer or trustline.[36]
- Chain: none. Terminal: nothing. Its value rests on demand for the network.

## 3. Ranking table

Tier definitions:
- **T1**: the terminal is US T-bills or govt repo, at most 3 hops, a regulated issuer, and public holdings or attestations.
- **T2**: the terminal is US T-bills, but one link is weak (offshore issuer, private fund, bridge, partly deposits, or composition not public).
- **T3**: a safe asset in another currency (EU/UK sovereign bills, or euro bank deposits).
- **T4**: emerging-market sovereign debt, or a mixed reserve that includes gold, BTC and loans.
- **T5**: credit, equity, synthetic or crypto.
- **T6**: no backing.

| Asset | Stellar value | Terminal asset | Hops | Weakest link | Tier |
|---|---|---|---|---|---|
| BENJI (FOBXX) | $434.6M | ≥99.5% US govt securities / govt repo | 2 | business-day redemption; auth_required, so only issuer-approved holders; clawback | T1 |
| USDC | $386.8M | US Treasuries (≈72% overnight repo, ≈12% bills) + ≈16% bank cash | 3 | bank-deposit slice; issuer freeze; redemption only via Circle Mint | T1 |
| PYUSD | $87.0M | USD deposits, US treasuries, cash equivalents | 2 | composition split not read; freeze + clawback | T1 |
| gBENJI | $51.6M | US money market instruments | 2 | auth_required; redemption terms n/f | T1 |
| Spiko USTBL | $36.0M | US T-bills, repo, cash | 2 | Soroban permission manager; EU-domiciled | T1 |
| WTGXX | $2.3M | US Treasury MMF | 2 | auth_required; holdings not read | T1 |
| SWEEP | $75.0M | mostly treasuries + repo + stablecoins | 3 | private fund, not a registered MMF; QP only, $5M minimum; 1 holder on Stellar | T2 |
| USDY | $538.0M | short UST / SHV ETF / bank deposits | 2–3 | BVI note issuer; non-US only; $5K minimum; business-day pricing | T2 |
| deJTRSY / JTRSY | $8.0M / $5.1M | 0–6 month US T-bills (J.P. Morgan) | 3 + bridge | BVI professional fund; LayerZero bridge; 500K USDC minimum | T2 |
| YLDS | $25.2M | reserves at UMB Bank (composition n/f) | 2 | composition not published; auth_required | T2 |
| sgBENJI | $38.5M | global money market instruments | 2 | not pure UST; monthly settlement | T2 |
| USDGLO | $0.25M | mostly cash and cash equivalents | 2 | bank cash; tiny | T2 |
| USTRY | $12.4M | US Treasury notes | 2 | Mexican issuer; custody sources conflict; notes, not bills | T2 |
| EUTBL / UKTBL | $271.8M / $9.9M | core-EZ / UK sovereign bills | 2 | EUR/GBP, not USD; permissioned | T3 (T1 in its own currency) |
| EURCV | $16.8M | deposit at Société Générale | 2 | single-bank credit; redemption can take until month-end + 1 | T3 |
| EURC | $4.8M | euro bank deposits | 2 | commercial-bank credit | T3 |
| USDT0 | ≈$7.3M | ≈61% T-bills; ≈22% gold, BTC, equities, loans, other | 3 + bridge | offshore issuer; non-cash reserves; multisig adapter | T4 |
| CETES | $3.5M | Mexican federal bills | 2 | MXN sovereign + FX; broker custody | T4 |
| TESOURO | $0.3M | Brazilian sovereign bonds | 2 | BRL sovereign + FX; custodian n/f | T4 |
| eurSAFO / SAFO / gbpSAFO / chfSAFO | $1,638.5M total | equity/bond basket + TRS with G-SIBs | 2 | the terminal is risk assets; swap counterparty | T5 |
| deJAAA / JAAA | $8.7M / $5.1M | AAA CLO tranches | 4 + bridge | credit risk; BVI fund; bridge | T5 |
| TPT30 | $500.0M | corporate bond of an OTC issuer | 2 | single-name credit; 1 holder; $1.00 mark | T5 |
| SPX, RVL4/5, RSRB/RSR/LDVM, SPXUX/TECHX, LIQVID1037 | $5.8–26.9M each | private equity, agri credit, real estate, listed equity, ABS | 2–3 | terminal is risk assets | T5 |
| SolvBTC | n/f | BTC | 2 | BTC price; multisig custody; admin blacklist | T5 |
| XLM | — | nothing | 0 | no backing | T6 |

Values are rwa.xyz figures,[42] except USDT0 and USDGLO, which are Horizon supply.[46][61] The SAFO total is my sum.

## 4. The "last safe asset" statement

- **What it is:** short-dated US Treasury bills, and overnight repo collateralised by Treasuries.
- **Why it is the floor:** these are the instruments the reserve chains converge on. USDXX holds them.[2][3] FOBXX holds at least 99.5% government paper.[14] JTRSY holds only 0–6 month bills.[26] Tether's largest line is T-bills.[13] USDXX's 7-day SEC yield of 3.87% (23 Oct 2026) is a usable on-chain proxy for the risk-free dollar rate.[3]
- **Why it is safe:** Treasuries are the main collateral the Fed accepts in its standing repo operations. Those operations supply liquidity to eligible counterparties and cap overnight rates.[75] So the Fed can always turn the terminal asset into cash. Bank deposits and fund shares lack that direct conversion.
- **Fewest, most auditable hops on Stellar:** BENJI (2 hops: share → 1940 Act govt MMF → govt paper).[14] USDC (3 hops, but with a CUSIP-level reserve list each month).[2] PYUSD (2 hops, OCC-supervised, KPMG attestations).[6][5] Spiko USTBL and gBENJI are close behind.[39][37]
- **Fewest hops, liquid on-chain:** USDC is the only one of these that is both T-bill-terminal and freely usable by contracts. It has about 136.9M in contracts against zero for BENJI.[43][48]
- **The wider Web3 point:** the same lens applies to DeFi as a whole. USDT rests about 61% on T-bills.[13] USDC rests on Treasury repo and bills.[2] Most "dollar" DeFi collateral therefore bottoms out in the same T-bill stack. The visible differences between tokens are mostly in the links above it: issuer, bridge and redemption gate.

## 5. Lending-protocol implications

**1. Score collateral as terminal quality × weakest link.** These are proposals, not sourced figures:

| Bucket | Members | Proposed max LTV | Condition |
|---|---|---|---|
| A | USDC, PYUSD | 85–90% | freeze/clawback accepted as issuer risk |
| B | BENJI, gBENJI, USTBL, WTGXX | 80–85% | **only** with an issuer-approved liquidation/redemption path; otherwise 0% |
| C | USDY, deJTRSY, SWEEP, YLDS, USTRY | 65–80% | scaled by redemption gate and bridge |
| D | EUTBL, EURC, EURCV | as A/B | plus an FX haircut against a USD debt |
| E | CETES, TESOURO, USDT0 | 50–65% | sovereign/FX or reserve-mix haircut |
| F | SAFO family, deJAAA, TPT30, equity/RE tokens, SolvBTC | ≤50% or excluded | — |
| — | XLM | volatility-based LTV only | — |

For comparison, XOXNO's live configuration uses USDC 88%, PYUSD 86%, EURC/USDT0 84%, USDY/Spiko 80% and USTRY/CETES 60% (gap analysis, its source [5]). Those values sit roughly inside these bands.

**2. Use the T-bill yield as the rate floor.** Supply rates for USDC should be benchmarked to the T-bill rate, for example USDXX's 3.87% 7-day SEC yield.[3] If borrow rates run well above it, T-bill collateral cannot loop profitably (gap #4).

**3. A safe terminal asset does not fix liquidation exit.**
- BENJI redeems only in business hours, on business days, to approved holders.[14]
- EURCV can take until the end of the following month.[11]
- USDY needs non-US status and a $5K minimum.[16]
- SWEEP's 24/7 redemption depends on stablecoin availability.[23]
- deJTRSY's underlying needs a 500K USDC minimum.[26]

The haircut must cover time-to-cash × price move + the chance the issuer freezes or refuses the liquidator. This is gap #2: liquidators need to be issuer-approved redeemers.

**4. Where the premise breaks:**
- EUR assets end in EU sovereigns or EU bank deposits, not T-bills.
- CETES and TESOURO end in Mexican and Brazilian sovereign risk plus FX.
- The SAFO family, Stellar's biggest RWA, ends in equities and bonds behind a swap.
- deJAAA ends in CLO credit.
- USDT0 carries about 22% non-T-bill reserves.
- SolvBTC ends in BTC.
- XLM ends in nothing.

A "T-bill lens" protocol should treat these as different currencies or risk assets, not as cash.

**5. Price fund shares at NAV with hard bounds, not at DEX prices.** The YieldBlox loss came from DEX-priced USTRY (gap analysis §2c).

## 6. Evidence gaps

- USDC redemption window and minimum; PYUSD custodians and current composition; FOBXX custodian.
- SAFO basket composition and swap collateral terms; UKTBL mandate text.
- SWEEP supply decimals; YLDS reserve composition.
- SolvBTC Stellar address and supply; TermMax backing.
- Admin and freeze powers in the Soroban contracts (Spiko, SWEEP, deJ*, TPT30).
- Whether the Stellar JTRSY/JAAA single holders are the deRWA vaults.

## Sources

[1] https://www.circle.com/transparency — https://www.circle.com/transparency
    > "The majority of the USDC reserve is held in the Circle Reserve Fund (USDXX), an SEC-registered 2a-7 government money market fund."
    > "The Circle Reserve Fund can contain cash, short-dated US Treasuries and overnight US Treasury repurchase agreements with leading global banks."
    > "The remainder of the reserve is held in cash, mostly among a handful of the world's largest banks with the highest capital, liquidity and supervisory requirements in the world."
    > "Additionally, a Big Four accounting firm provides monthly third-party assurance that the value of USDC reserves are greater than the amount of USDC in circulation."
    > "Total Reserves1  ### €436.5M  Reserves  Other Bank Deposits1  Deposits at Systemically Important Institutions2"
[2] https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/USDCAttestationReports/2026/2026%20USDC_Examination%20Report%20June%2026.pdf — https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/USDCAttestationReports/2026/2026%20USDC_Examination%20Report%20June%2026.pdf
    > "USDC is issued and redeemed by Circle Internet Financial, LLC and Circle Internet Financial Europe SAS (together, “Circle”)."
    > "U.S Treasury Repurchase Agreements within the Circle Reserve Fund involve the overnight lending of cash to global financial institutions which is overcollateralized by U.S. Treasury securities."
    > "TOTAL U.S. TREASURY SECURITIES 8,524,064,231 U.S. Treasury Repurchase Agreements 3 52,527,000,000"
    > "Cash held at regulated financial institutions 11,382,256,398"
[3] https://www.blackrock.com/cash/en-us/products/329365/circle-reserve-fund — https://www.blackrock.com/cash/en-us/products/329365/circle-reserve-fund
    > "Weighted Average Maturity  as of 23-Oct-2026  17 days"
    > "7-day SEC Yield  as of 23-Oct-2026  3.87%"
[4] https://www.circle.com/legal/mica-eurc-whitepaper — https://www.circle.com/legal/mica-eurc-whitepaper
    > "EURC holders have a legal claim against Circle SAS as the sole issuer of EURC."
    > "Such redemption will be made at any time and at par value, subject to complying with AML requirements."
    > "Circle SAS is a licensed Electronic Money Institution under n°737158 and a registered Digital Assets Services Provider in France under n°E2024-111."
    > "if Circle SAS determines that EURC transactions linked to public addresses are likely to be associated with criminal offenses, Circle SAS may decide to freeze the associated EURC (temporarily or permanently)."
    > "EURC is only available for issuance through the [Circle Mint](https://www.circle.com/legal/mica-redemption-policy)<br> service and it is accessible only to institutions located in supported jurisdictions."
[5] https://www.paxos.com/pyusd-transparency — https://www.paxos.com/pyusd-transparency
    > "Issued by Paxos Trust Company N.A., PayPal USD (PYUSD) is PayPal’s stablecoin designed for payments."
    > "Attestation reports posted on or after February 28, 2025 are issued by KPMG LLP, an independent third-party accounting firm."
[6] https://www.paxos.com/pyusd — https://www.paxos.com/pyusd
    > "Paxos’ issuance of the stablecoin PYUSD – and its reserves – are subject to strict regulatory oversight by the Office of the Comptroller of the Currency (OCC)."
    > "Reserves are held 100% in US dollar deposits, US treasuries and cash equivalents – meaning that customer funds are available for 1:1 redemption with Paxos."
[7] https://docs.usdt0.to — https://docs.usdt0.to/
    > "The original asset (USDT, XAUT or USAT) is locked in the OFT Adapter smart contract on Ethereum Mainnet."
    > "As a fiat-collateralized stablecoin, USDT is backed by reserves consisting primarily of cash, cash equivalents, and short-term U.S. Treasuries."
    > "The IOTA lockbox is owned by the same multisig as the main OFT Adapter and is verified by the same 3-of-3 DVN set."
[8] https://brale.xyz/stablecoins/USDGLO — https://brale.xyz/stablecoins/USDGLO
    > "Brale asserts that the balance of treasury assets is equal to or greater than the tokens issued."
[9] https://brale.xyz/assets/reports/USDGLO-Glo-Dollar-Reserve-Attestation-Report-09-2026.pdf — https://brale.xyz/assets/reports/USDGLO-Glo-Dollar-Reserve-Attestation-Report-09-2026.pdf
    > "Cash and cash equivalents $923,605 US government backed debt $64,451 Fair Value of Reserve Assets $988,057"
[11] https://www.sgforge.com/wp-content/uploads/2025/06/SG-Forge-EURCV-White-Paper-1.pdf — https://www.sgforge.com/wp-content/uploads/2025/06/SG-Forge-EURCV-White-Paper-1.pdf
    > "Société Générale - FORGE is a subsidiary of Société Générale and Société Générale will act as the Initial Collateral Custodian in the books of which the Initial Segregated Account are opened."
    > "THE ISSUER HAS THE RIGHT TO REFUSE TO REDEEM THE EURCV TO A PERSON THAT IS NOT A PERMITTED TRANSFEREE."
    > "The Holders of EURCV that are residents of the European Economic Area (EEA) have a right of redemption at any time and at par value."
    > "transfer the relevant redemption amount in Euro to the Holder’s cash account at the latest on the last Business Day of the month following the month the controls were successfully completed."
    > "will comply with investment rules of Article 54 of MiCA"
[12] https://tether.io/news/tether-posts-strong-q2-performance-generates-1-5b-net-operating-profit-maintains-4-11b-reserve-buffer-and-expands-gold-holdings-to-more-than-146-tons — https://tether.io/news/tether-posts-strong-q2-performance-generates-1-5b-net-operating-profit-maintains-4-11b-reserve-buffer-and-expands-gold-holdings-to-more-than-146-tons/
    > "Tether International, S.A. de C.V., today published its attestation for Q2 of 2026, prepared by BDO, a top-five global independent accounting firm."
    > "The majority of reserves remain in U.S. government-backed instruments and short-term liquidity facilities, providing the liquidity needed to manage redemptions across different market conditions."
    > "Tether also reduced its secured lending exposure by approximately $2.38 billion (15%)."
[13] https://assets.ctfassets.net/vyse88cgwfbl/2kYf7r64h3tzwiu6F0CbUB/2997abd2f11ecea74a21528048b50707/Opinion___Report_-_Tether_International_Financial_Figure_30-06-2026.pdf — https://assets.ctfassets.net/vyse88cgwfbl/2kYf7r64h3tzwiu6F0CbUB/2997abd2f11ecea74a21528048b50707/Opinion___Report_-_Tether_International_Financial_Figure_30-06-2026.pdf
    > "U.S. Treasury Bills 3 114,960,963,604 Overnight Reverse Repurchase Agreements 4 18,625,552,412"
    > "3. Precious Metals 9 18,838,357,171 4. Bitcoin 10 5,801,630,681 5. Public Equities 11 3,761,438,892 6. Other Investments 12 5,244,911,675 7. Secured Loans 13 13,453,749,726 Total Assets (1+2+3+4+5+6+7) 187,751,426,411"
[14] https://www.franklintempleton.com/forms-literature/download-preview/9001-P — https://www.franklintempleton.com/forms-literature/download-preview/9001-P
    > "The Fund invests at least 99.5% of its total assets in Government securities, cash and repurchase agreements collateralized fully by Government securities or cash."
    > "although purchases and redemptions of Fund shares will only be processed during normal business hours on business days."
    > "The minimum initial purchase for most accounts is $20, although you may be subject to a higher investment minimum."
    > "The Fund’s transfer agent will create a blockchain wallet for each investor on the Stellar blockchain network"
    > "As noted above, the Fund’s transfer agent maintains controls to correct errors or unauthorized transactions, regardless of whether the private key for an investor’s wallet is maintained by the Fund’s transfer agent, the investor, and/or third-party wallet custodian."
[15] https://ondo.finance/usdy — https://ondo.finance/usdy
    > "Underlying Assets  Bank Deposits; Short-Term US Treasuries"
    > "Mint and redeem USDY 24/7, even on weekends and bank holidays."
    > "Legal Structure  Debt Issued by Bankruptcy-Remote Entity"
[16] https://docs.ondo.finance/general-access-products/usdy/basics — https://docs.ondo.finance/general-access-products/usdy/basics
    > "USDY (**US** **D**ollar **Y**ield Token) is a tokenized note formerly issued by Ondo USDY LLC, which as of December 15, 2025 has been folded into the Ondo Stocks umbrella."
    > "Depending on the issuance date, USDY may be secured by either short-term US Treasuries, shares of iShares Short Treasury Bond ETF, or bank demand deposits."
    > "Ondo USDY LLC can only redeem USD via bank wire to non-US bank accounts."
    > "Please note that that there is a $5,000 minimum for minting and redeeming on these networks."
    > "To redeem for USDC through Ondo Global Markets (BVI) Limited"
[17] https://app.etherfuse.com/legal/stablebonds-overview — https://app.etherfuse.com/legal/stablebonds-overview
    > "Each Stablebond token represents a proportional economic claim whose value is based on the net asset value (NAV) of a segregated pool of sovereign-debt assets held in regulated custody."
    > "These financial assets backing the Stablebonds currently are: (i) Mexican government debt (CETES); (ii) US government debt (US Treasury Notes); and, (iii) UK Government liability (Gilt)"
    > "Redemption occurs at the applicable NAV, subject to the product’s disclosed terms, fees, and settlement timing."
[18] https://app.etherfuse.com/bonds/cetes — https://app.etherfuse.com/bonds/cetes
    > "All brokerages that Etherfuse works with use the Institute for the Deposit of Securities (Instituto para el Deposito de Valores, or INDEVAL) for safe and secure custody of CETES."
[19] https://whalehub.io/blog/etherfuse-stablebonds-stellar — https://whalehub.io/blog/etherfuse-stablebonds-stellar
    > "Etherfuse names BBVA México, Actinver Casa de Bolsa and Kuspit Casa de Bolsa as custodians, described as Category I regulated Mexican financial institutions."
    > "Etherfuse's asset-security page describes the issuer as a Mexican corporation operating primarily under Mexican law, with a Swiss DLT registration for blockchain transfers."
    > "rwa.xyz lists the Stablebond issuer as a "U.S. Corporation" and names Spiko SICAV as USTRY's custodian, while Etherfuse's USTRY page names the US Bureau of the Fiscal Service."
    > "| TESOURO | Brazilian short-term sovereign bonds | $0.7M | 552 | 1.50% |"
[20] https://www.spiko.io/blog/spiko-amundi-safo — https://www.spiko.io/blog/spiko-amundi-safo
    > "SAFO uses fully collateralized total return swaps with Tier 1 banking counterparties - starting with BNP Paribas - to deliver stable yields above risk-free benchmarks, with overnight liquidity."
    > "CACEIS acts as depositary bank and fund admin. Spiko serves as a transfer agent and broker, handling subscription and redemption orders."
    > "SAFO is a cash management product, a UCITS fund regulated by the French Financial Markets Authority (AMF), issued and operated on the Spiko"
[21] https://www.spiko.io/spiko-treasury-bills-euro — https://www.spiko.io/spiko-treasury-bills-euro
    > "Your cash is invested exclusively in the safest financial assets available: short-term Treasury bills from core Eurozone countries."
    > "CACEIS, a subsidiary of the Crédit Agricole Group, acts as depositary bank and handles the accounting for Spiko T-Bills."
    > "Asset manager  Twenty First Capital"
    > "Minimum initial deposit  €1"
[22] https://int.media.amundi.com/article/spiko-and-amundi-introduce-safo?language_content_entity=en — https://int.media.amundi.com/article/spiko-and-amundi-introduce-safo?language_content_entity=en
    > "SAFO is a tokenized sub-fund of SPIKO SICAV, a SICAV regulated under French law"
[23] https://stellar.org/press/state-street-galaxy-onchain-liquidity-sweep-fund-goes-live-on-stellar — https://stellar.org/press/state-street-galaxy-onchain-liquidity-sweep-fund-goes-live-on-stellar
    > "Anchorage provides digital asset custody, Chainlink supports fund pricing and reserve data, NAV Consulting serves as transfer agent, and State Street Bank and Trust Company holds the fund’s securities."
    > "SWEEP is a private placement available to Qualified Purchasers that meet certain eligibility criteria and minimum investment amounts."
    > "Eligible investors can subscribe and redeem in certain stablecoins, subject to availability from the fund’s portfolio, 24 hours a day, seven days a week"
[24] https://investors.statestreet.com/investor-news-events/press-releases/news-details/2026/State-Street-Investment-Management-and-Galaxy-Digital-Bring-Cash-Management-Onchain/default.aspx — https://investors.statestreet.com/investor-news-events/press-releases/news-details/2026/State-Street-Investment-Management-and-Galaxy-Digital-Bring-Cash-Management-Onchain/default.aspx
    > "The minimum initial subscription to the Fund is $5,000,000 for entity investors and $1,000,000 for individual/natural person investors."
    > "The Fund is expected to invest a large percentage of its assets in treasury securities"
    > "The Fund is not a “money market fund” registered with the U.S. Securities and Exchange Commission (“SEC”)"
[25] https://www.wisdomtreeprime.com/digital-funds/wtgxx — https://www.wisdomtreeprime.com/digital-funds/wtgxx/
    > "The WisdomTree Treasury Money Market Digital Fund seeks to provide investors with a high level of current income consistent with preservation of capital and liquidity and the maintenance of a stable $1.00 net asse"
[26] https://centrifuge-files.mypinata.cloud/ipfs/bafybeicdzle2bgqekmvnfqcxjhimnzlfrg7mkfvngxtmfvjzldmtoubneq — https://centrifuge-files.mypinata.cloud/ipfs/bafybeicdzle2bgqekmvnfqcxjhimnzlfrg7mkfvngxtmfvjzldmtoubneq
    > "It solely invests in and holds short-term U.S. Treasury Bills (T-bills) with a remaining maturity of 0 to 6 months"
    > "Min. investment500,000 USDC"
    > "CustodianJ. P. Morgan"
    > "open to non-US Professional Investors"
[27] https://app.rwa.xyz/assets/JAAA — https://app.rwa.xyz/assets/JAAA
    > "The tokenized Janus Henderson Anemoy Fund (JAAA) seeks to provide investors with a portfolio of high-quality CLOs"
    > "Once an investor completes onboarding and is approved by our Fund Admin, their wallet address is whitelisted in the Centrifuge app and they can invest in the pool."
[28] https://centrifuge.io/blog/derwa-on-stellar-with-20m-allocation — https://centrifuge.io/blog/derwa-on-stellar-with-20m-allocation
    > "beginning with deJTRSY, the DeFi version of the Janus Henderson Short-Term US Treasury strategy, and deJAAA, the DeFi AAA-rated CLO strategy."
    > "To ensure trust and transparency, Centrifuge has chosen LayerZero’s OFT Standard to bring these funds to Stellar."
[29] https://www.ylds.com/institutions — https://www.ylds.com/institutions/
    > "Figure Certificate Company, the issuer of YLDS files periodic reports with the SEC."
    > "Held at UMB Bank NA. Not commingled with operating capital."
[30] https://docs.solv.finance/solvbtc-mainnet-architecture — https://docs.solv.finance/solvbtc-mainnet-architecture
    > "Users deposit BTC into protocol-managed Bitcoin addresses and receive SolvBTC on Ethereum and other EVM-compatible chains at a 1:1 ratio."
[31] https://github.com/solv-finance/SolvBTC-Stellar-Contract — https://github.com/solv-finance/SolvBTC-Stellar-Contract
    > "Minting and burning capabilities *   Blacklist functionality *   Pausable transfers"
[32] https://app.rwa.xyz/assets/TPT30 — https://app.rwa.xyz/assets/TPT30
    > "Total Asset Value  $500.00M  Net Asset Value  $1.00  Holders  1"
    > "TPT Global Tech Inc. (OTC: TPTW) has built a revolutionary operating system for digital life."
[33] https://app.rwa.xyz/assets/SPX — https://app.rwa.xyz/assets/SPX
    > "COMETUM offers an exclusive opportunity to invest indirectly in SpaceX common stock via an SPV stru"
[34] https://app.rwa.xyz/assets/RVL5 — https://app.rwa.xyz/assets/RVL5
    > "Rivool Agriculture Notes – High Grade is an investment-grade tokenized credit note issued by Rivool Global SPV, backed by a senior position in structured FIAgro-FIDC"
[35] https://app.rwa.xyz/assets/RSRB — https://app.rwa.xyz/assets/RSRB
    > "Offering of a 104-unit multifamily property located in suburban Chicago"
[36] https://developers.stellar.org/docs/learn/fundamentals/lumens — https://developers.stellar.org/docs/learn/fundamentals/lumens
    > "The lumen is the only token that doesn’t require an issuer or trustline."
[37] https://tokenterminal.com/explorer/projects/franklintempleton/gbenji/metrics/all — https://tokenterminal.com/explorer/projects/franklintempleton/gbenji/metrics/all
    > "The fund invests in U.S. money market instruments."
[38] https://tokenterminal.com/explorer/projects/franklintempleton/sgbenji — https://tokenterminal.com/explorer/projects/franklintempleton/sgbenji
    > "Its assets sit with DB International Trust (Singapore) Limited, with Templeton Asset Management Ltd. as transfer agent."
    > "Accredited investors can subscribe and redeem, and holders have a right to redeem at net asset value with monthly settlement."
[39] https://app.rwa.xyz/assets/USTBL — https://app.rwa.xyz/assets/USTBL
    > "The Fund invests 100% of its total assets in U.S. Treasury Bills (T-Bills), repurchase agreements secured by such securities and cash."
[40] https://app.rwa.xyz/assets/eurSAFO — https://app.rwa.xyz/assets/eurSAFO
    > "It generates stable yields above the EUR Short-Term Rate (€STR) benchmark through fully collateralized total return swaps (TRS) with Tier 1 bank counterparties (G-SIBs rated A- or above)."
    > "The fund holds a diversified portfolio of equities and bonds"
[41] https://app.rwa.xyz/assets/SWEEP — https://app.rwa.xyz/assets/SWEEP
    > "The fund seeks to offer 24/7 near real-time Stablecoin redemption, subject to availability of Stablecoin in the fund’s portfolio."
[42] https://app.rwa.xyz/networks/stellar — https://app.rwa.xyz/networks/stellar
    > "Distributed Asset Value

$3.75B"
    > "Stablecoin Market Cap

$524.58M"
    > "eurSAFO | Login to Unlock | $1,464,692,684"
    > "USDY | Login to Unlock | $538,032,183"
    > "TPT30 | Login to Unlock | $500,000,000"
    > "BENJI | Login to Unlock | $434,589,739"
    > "USDC | Login to Unlock | $386,788,356"
    > "EUTBL | Login to Unlock | $271,832,624"
    > "SAFO | Login to Unlock | $117,655,077"
    > "PYUSD | Login to Unlock | $86,953,715"
    > "SWEEP | Login to Unlock | $74,973,313"
    > "gBENJI | Login to Unlock | $51,618,278"
    > "gbpSAFO | Login to Unlock | $50,966,099"
    > "sgBENJI | Login to Unlock | $38,490,045"
    > "USTBL | Login to Unlock | $36,036,407"
    > "SPX | Login to Unlock | $26,888,649"
    > "YLDS | Login to Unlock | $25,244,840"
    > "SPXUX | Login to Unlock | $18,726,709"
    > "EURCV | Login to Unlock | $16,837,801"
    > "USTRY | Login to Unlock | $12,413,080"
    > "UKTBL | Login to Unlock | $9,925,498"
    > "RVL5 | Login to Unlock | $9,191,582"
    > "deJAAA | Login to Unlock | $8,687,119"
    > "JTRSY deRWA deJTRSY | $ 8 022 539"
    > "EURC EURC | $ 4 787 141"
    > "Janus Henderson AAA CLO Fund JAAA | $ 5 119 617"
    > "Janus Henderson Treasury Fund JTRSY | $ 5 093 106"
    > "Etherfuse CETES CETES | $ 3 455 640"
    > "WisdomTree Treasury Money Market Digital Fund WTGXX | $ 2 338 661"
    > "Etherfuse TESOURO TESOURO | $ 304 731"
    > "Spiko Amundi Overnight Swap Fund (CHF) chfSAFO | $ 5 210 880"
    > "TermMax Fixed Income LP Deal LIQVID1037_S | $ 5 844 796"
    > "WisdomTree Technology & Innovation 100 Digital Fund TECHX | $ 6 274 103"
    > "LDV at the Maidstone - Equity Tranche 1 LDVM | $ 6 320 400"
[43] https://horizon.stellar.org/assets?asset_code=USDC&asset_issuer=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN — https://horizon.stellar.org/assets?asset_code=USDC&asset_issuer=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
    > ""balances": { "authorized": "244684581.7840175", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": false, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": false }"
[44] https://horizon.stellar.org/assets?asset_code=EURC&asset_issuer=GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2 — https://horizon.stellar.org/assets?asset_code=EURC&asset_issuer=GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2
    > ""balances": { "authorized": "3676585.8270606", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": false, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": false }"
[45] https://horizon.stellar.org/assets?asset_code=PYUSD&asset_issuer=GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5 — https://horizon.stellar.org/assets?asset_code=PYUSD&asset_issuer=GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5
    > ""balances": { "authorized": "77963520.1069442", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": false, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[46] https://horizon.stellar.org/assets?asset_code=USDT0&asset_issuer=GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q — https://horizon.stellar.org/assets?asset_code=USDT0&asset_issuer=GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q
    > ""balances": { "authorized": "3088964.9738595", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": false, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[47] https://horizon.stellar.org/assets?asset_code=EURCV&asset_issuer=GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G — https://horizon.stellar.org/assets?asset_code=EURCV&asset_issuer=GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G
    > ""balances": { "authorized": "15030600.0000000", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": true, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[48] https://horizon.stellar.org/assets?asset_code=BENJI&asset_issuer=GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 — https://horizon.stellar.org/assets?asset_code=BENJI&asset_issuer=GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5
    > ""balances": { "authorized": "434679174.5276656", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "25.0437137" }, "flags": { "auth_required": true, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[49] https://horizon.stellar.org/assets?asset_code=gBENJI&asset_issuer=GD5J73EKK5IYL5XS3FBTHHX7CZIYRP7QXDL57XFWGC2WVYWT326OBXRP — https://horizon.stellar.org/assets?asset_code=gBENJI&asset_issuer=GD5J73EKK5IYL5XS3FBTHHX7CZIYRP7QXDL57XFWGC2WVYWT326OBXRP
    > ""balances": { "authorized": "51626936.6647168", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": true, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[50] https://horizon.stellar.org/assets?asset_code=sgBENJI&asset_issuer=GAGICV3VBJSKKH5H5MQQIUTUP462YVHC23KUHZY6FJERRJFBDIVZBM5C — https://horizon.stellar.org/assets?asset_code=sgBENJI&asset_issuer=GAGICV3VBJSKKH5H5MQQIUTUP462YVHC23KUHZY6FJERRJFBDIVZBM5C
    > ""balances": { "authorized": "38485199.6983481", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": true, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[51] https://horizon.stellar.org/assets?asset_code=USDY&asset_issuer=GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6 — https://horizon.stellar.org/assets?asset_code=USDY&asset_issuer=GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6
    > ""balances": { "authorized": "461625054.2310655", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": false, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[52] https://horizon.stellar.org/assets?asset_code=YLDS&asset_issuer=GAC7MOPTQLQUM3KC24AW4GHS3RLF72LPEZO54AH7EZ6TSMGRB5SOAVH3 — https://horizon.stellar.org/assets?asset_code=YLDS&asset_issuer=GAC7MOPTQLQUM3KC24AW4GHS3RLF72LPEZO54AH7EZ6TSMGRB5SOAVH3
    > ""balances": { "authorized": "25244805.6884850", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "33.9500000" }, "flags": { "auth_required": true, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[53] https://horizon.stellar.org/assets?asset_code=USTRY&asset_issuer=GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC — https://horizon.stellar.org/assets?asset_code=USTRY&asset_issuer=GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC
    > ""balances": { "authorized": "10441502.4375328", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": false, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[54] https://horizon.stellar.org/assets?asset_code=CETES&asset_issuer=GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC — https://horizon.stellar.org/assets?asset_code=CETES&asset_issuer=GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC
    > ""balances": { "authorized": "36060876.3096788", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": false, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[55] https://horizon.stellar.org/assets?asset_code=TESOURO&asset_issuer=GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC — https://horizon.stellar.org/assets?asset_code=TESOURO&asset_issuer=GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC
    > ""balances": { "authorized": "951369.6152501", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": false, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[56] https://horizon.stellar.org/assets?asset_code=SPXU&asset_issuer=GDJBVX3QA5HJPBSAU5VIX2W6MC37NU4UFXPKEGK42SJCYN6AEQ4Z6COM — https://horizon.stellar.org/assets?asset_code=SPXU&asset_issuer=GDJBVX3QA5HJPBSAU5VIX2W6MC37NU4UFXPKEGK42SJCYN6AEQ4Z6COM
    > ""balances": { "authorized": "929227.0792279", "authorized_to_maintain_liabilities": "2118.8042925", "unauthorized": "0.0000000" }, "flags": { "auth_required": true, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[57] https://horizon.stellar.org/assets?asset_code=TECH&asset_issuer=GDSAW27GPR7EWKPTFDPGN2WWZYUHBFKVDBLOUUEKSNKHID4ZWUVOBF5R — https://horizon.stellar.org/assets?asset_code=TECH&asset_issuer=GDSAW27GPR7EWKPTFDPGN2WWZYUHBFKVDBLOUUEKSNKHID4ZWUVOBF5R
    > ""balances": { "authorized": "239656.1145935", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": true, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[58] https://horizon.stellar.org/assets?asset_code=WTGX&asset_issuer=GDMBNMFJ3TRFLASJ6UGETFME3PJPNKPU24C7KFDBEBPQFG2CI6UC3JG6 — https://horizon.stellar.org/assets?asset_code=WTGX&asset_issuer=GDMBNMFJ3TRFLASJ6UGETFME3PJPNKPU24C7KFDBEBPQFG2CI6UC3JG6
    > ""balances": { "authorized": "2378780.6953928", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": true, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[59] https://horizon.stellar.org/assets?asset_code=SPX&asset_issuer=GCYVGZHMNWII6F3JHBPERKFCRSPS7NOMKOCFXDP2QD62ZE3JKF3465FL — https://horizon.stellar.org/assets?asset_code=SPX&asset_issuer=GCYVGZHMNWII6F3JHBPERKFCRSPS7NOMKOCFXDP2QD62ZE3JKF3465FL
    > ""balances": { "authorized": "20000.0000000", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": true, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[60] https://horizon.stellar.org/assets?asset_code=RVL5&asset_issuer=GCHCHABG57ZC6RMWQK34Q7XPMXDHMTD6G22T5HDXOOIRGOBCAKHS3VMC — https://horizon.stellar.org/assets?asset_code=RVL5&asset_issuer=GCHCHABG57ZC6RMWQK34Q7XPMXDHMTD6G22T5HDXOOIRGOBCAKHS3VMC
    > ""balances": { "authorized": "50000000.0000000", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": false, "auth_revocable": false, "auth_immutable": false, "auth_clawback_enabled": false }"
[61] https://horizon.stellar.org/assets?asset_code=USDGLO&asset_issuer=GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV — https://horizon.stellar.org/assets?asset_code=USDGLO&asset_issuer=GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV
    > ""balances": { "authorized": "25490.8100490", "authorized_to_maintain_liabilities": "0.0000000", "unauthorized": "0.0000000" }, "flags": { "auth_required": false, "auth_revocable": true, "auth_immutable": false, "auth_clawback_enabled": true }"
[62] https://api.stellar.expert/explorer/public/asset/CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP — https://api.stellar.expert/explorer/public/asset/CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP
    > ""supply": "129073389185604", "trades": 0, "payments": 68630"
[63] https://api.stellar.expert/explorer/public/asset/CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF — https://api.stellar.expert/explorer/public/asset/CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF
    > ""supply": "22860237183840", "trades": 0, "payments": 199085"
[64] https://api.stellar.expert/explorer/public/asset/CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX — https://api.stellar.expert/explorer/public/asset/CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX
    > ""supply": "11476248138643", "trades": 0, "payments": 1414"
[65] https://api.stellar.expert/explorer/public/asset/CAGYRRKPFSWKM6SJOE4QAAVYMOSHMDS5WOQ4T5A2E6XNCU7LZZKUNQKP — https://api.stellar.expert/explorer/public/asset/CAGYRRKPFSWKM6SJOE4QAAVYMOSHMDS5WOQ4T5A2E6XNCU7LZZKUNQKP
    > ""supply": "3708917823681", "trades": 0, "payments": 533"
[66] https://api.stellar.expert/explorer/public/asset/CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO — https://api.stellar.expert/explorer/public/asset/CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO
    > ""supply": "3275099375866", "trades": 0, "payments": 1987"
[67] https://api.stellar.expert/explorer/public/asset/CDT3KU6TQZNOHKNOHNAFFDQZDURVC3MSTL4ML7TUTZGNOPBZCLABP4FR — https://api.stellar.expert/explorer/public/asset/CDT3KU6TQZNOHKNOHNAFFDQZDURVC3MSTL4ML7TUTZGNOPBZCLABP4FR
    > ""supply": "716362030196", "trades": 0, "payments": 23165"
[68] https://api.stellar.expert/explorer/public/asset/CAJD2IBSP7VO2VYJQUYJSOGPJINTUYV7MQITINXVPTIH3CCLCUENNMW4 — https://api.stellar.expert/explorer/public/asset/CAJD2IBSP7VO2VYJQUYJSOGPJINTUYV7MQITINXVPTIH3CCLCUENNMW4
    > ""supply": "427164224177", "trades": 0, "payments": 15"
[69] https://api.stellar.expert/explorer/public/asset/CB6PIAMD6VPZEI7CMS4PMN6RL5LBTRNAO2ICB7SFXATKKIETOWFZILW3 — https://api.stellar.expert/explorer/public/asset/CB6PIAMD6VPZEI7CMS4PMN6RL5LBTRNAO2ICB7SFXATKKIETOWFZILW3
    > ""supply": "14769636358118832", "trades": 0, "payments": 35"
[70] https://api.stellar.expert/explorer/public/asset/CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL — https://api.stellar.expert/explorer/public/asset/CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL
    > ""supply": "11652774097712493142825366", "trades": 0, "payments": 1208"
[71] https://api.stellar.expert/explorer/public/asset/CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV — https://api.stellar.expert/explorer/public/asset/CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV
    > ""supply": "10516889964172234898508352", "trades": 0, "payments": 168457"
[72] https://api.stellar.expert/explorer/public/asset/CDV6U7OEVY6KUEJ4WNS63AYB6RFU3BAE7AZJOQ7LPH447C6NWUXEZZSO — https://api.stellar.expert/explorer/public/asset/CDV6U7OEVY6KUEJ4WNS63AYB6RFU3BAE7AZJOQ7LPH447C6NWUXEZZSO
    > ""supply": "4860312028809000000000000", "trades": 0, "payments": 1"
[73] https://api.stellar.expert/explorer/public/asset/CBHOEKLWTB6HR2A3IXHIIMQG5FOXWXS6EG4Q5YJDRPMXPCX7M24CYR2O — https://api.stellar.expert/explorer/public/asset/CBHOEKLWTB6HR2A3IXHIIMQG5FOXWXS6EG4Q5YJDRPMXPCX7M24CYR2O
    > ""supply": "4547091586899000000000000", "trades": 0, "payments": 1"
[74] https://api.stellar.expert/explorer/public/asset/CBUBVYRKTQLMDRUBPP6SH4GO33KZCEEYBIWB5AWNGKODP4A6KPKM2VJ4 — https://api.stellar.expert/explorer/public/asset/CBUBVYRKTQLMDRUBPP6SH4GO33KZCEEYBIWB5AWNGKODP4A6KPKM2VJ4
    > ""supply": "500000000000000000000000000", "trades": 0, "payments": 8"
[75] https://www.federalreserve.gov/monetarypolicy/standing-overnight-repurchase-agreement-facility.htm — https://www.federalreserve.gov/monetarypolicy/standing-overnight-repurchase-agreement-facility.htm
    > "The securities accepted in SRP operations include Treasury securities, agency debt securities, and agency mortgage-backed securities."
    > "SRP operations supply liquidity to eligible counterparties and thereby limit upward pressure and help provide a ceiling on overnight money market rates"
[76] https://developers.stellar.org/docs/tokens/usdt0-layerzero — https://developers.stellar.org/docs/tokens/usdt0-layerzero
    > "Classic asset | `USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q`"
[77] https://www.glodollar.org/articles/smart-contract-addresses — https://www.glodollar.org/articles/smart-contract-addresses
    > "Glo Dollar (USDGLO) on Stellar ------------------------------  GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV"
[78] https://developer.paypal.com/community/blog/pyusd-on-stellar — https://developer.paypal.com/community/blog/pyusd-on-stellar/
    > "a limited purpose trust company regulated by the New York State Department of Financial Services"
    > "PYUSD Mainnet asset Issuer: GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5"
