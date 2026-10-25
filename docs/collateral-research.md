# Collateral research: what Caravel's collateral really rests on

As of 25 Oct 2026. Full evidence, with a source and quote for every figure:
- [research/backing-chain-map.md](research/backing-chain-map.md): what each Stellar token is backed by, link by link, ranked into trust tiers.
- [research/rwa-collateral-gap-analysis.md](research/rwa-collateral-gap-analysis.md): which Stellar protocols accept RWA collateral today, and what's missing.

Items marked **Proposal** are team suggestions, not sourced facts. Per DECISIONS.md, agree on them in team chat before changing that file.

> **Updated Sun 16:35.** Market figures now come from DefiLlama, dated: see [numbers.md](numbers.md) (Spiko ≈$1.78B on Stellar, BENJI $475M, Stellar ≈$2.4B). Launch haircuts are decided in [DECISIONS #26](../DECISIONS.md). The rwa.xyz figures and tier proposal below are kept as research history.

## 1. The lens: every dollar token ends in T-bills, and the weak link is exit, not the asset

- Following the backing chain down, almost every "dollar" asset on Stellar ends in **short-dated US T-bills and Treasury repo**. For example: USDC → Circle Reserve Fund (BlackRock USDXX) → T-bills + Treasury repo; BENJI → FOBXX → at least 99.5% US government paper.
- The safe assets are already at the bottom of the chain. **The risk sits in the links above them**: issuer freeze or clawback, redemption only on business days, redemption only for approved holders, bridges.
- That is Caravel's insight in one line: *the underlying asset is safe, but turning it back into cash takes business days*. So a fixed-term repo with a margin window fits the asset better than 24/7 liquidation does. Use this for README **Insight**.

## 2. Problem section, with numbers (README **Problem**)

| Fact | Value | Source |
|---|---|---|
| Distributed RWAs on Stellar | $3.75B | [rwa.xyz](https://app.rwa.xyz/networks/stellar) |
| BENJI ($435M) held by any smart contract | **0 contracts** | [Horizon](https://horizon.stellar.org/assets?asset_code=BENJI&asset_issuer=GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5) |
| Spiko SAFO funds on Stellar | ≈$1.64B, ≈44% of Stellar RWAs | rwa.xyz, see backing-chain map §3 |
| eurSAFO trades / DEX volume on Stellar | 0 trades; $0 DEX volume | [stellar.expert API](https://api.stellar.expert/explorer/public/asset/CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP), [DefiLlama](https://defillama.com/token/EURSAFO) |
| Spiko markets on Stellar lenders | XOXNO lists six, all disabled | [WhaleHub](https://whalehub.io/blog/spiko-stellar) |
| eurSAFO used as collateral anywhere | ≈$618K, on Morpho (Ethereum) only | [DefiLlama](https://defillama.com/token/EURSAFO) |
| Largest Stellar lender (Blend V2) | $132M, mostly XLM collateral; no allowlist hook | gap analysis §2e |

One-liner: **Stellar holds billions in permissioned fund shares that no on-chain lender can hold. Caravel's AUTH_REQUIRED spike shows an issuer can authorize a contract.**

## 3. Collateral tiers for the asset config (**Proposal**)

Haircut = quality of the underlying asset × the weakest link above it. Caravel's demo uses a 3% haircut on tBENJI; these are the haircut ranges for a real asset list.

| Tier | Assets | Underlying asset | Weakest link | Proposed haircut | Caravel status |
|---|---|---|---|---|---|
| 1 | BENJI, gBENJI, Spiko USTBL, WTGXX | US T-bills / govt money-market fund | approved holders only; business-day redemption | 3–5% | **demo asset (tBENJI)**, launch target |
| 2 | USDY, USTRY, deJTRSY, SWEEP | US T-bills/notes | offshore issuer, bridge, minimums | 8–15% | open to anyone, so no permission problem to solve; XOXNO and Orbit already take USTRY |
| 3 | EUTBL, EURCV | euro sovereign bills / SG deposit | FX against a USDC loan | Tier 1 haircut + FX haircut | needs a EUR/USD price feed |
| 4 | CETES, TESOURO, USDT0 | EM sovereign debt / mixed reserves | sovereign + FX risk | 25–35% | later |
| 5 | **eurSAFO / SAFO**, deJAAA | stocks/bonds behind a bank swap; CLOs | bank-swap counterparty; risk-asset basket | 30–50% or excluded | see §4 |

Store the tier and haircut per asset in contract config, not per offer, so lenders can't undercut the floor.

## 4. Spiko / SAFO: the biggest idle collateral pool on Stellar (**Proposal**: asset #2 after BENJI)

How it works: Spiko (Paris, AMF-regulated SICAV, CACEIS depositary) records fund shares as custom Soroban tokens. A **permission-manager contract** checks every transfer against an allowlist. Shares are bought from €1 or $1. Redemption is overnight, and the payout is off-chain.

- **Why it matters:** ≈$1.64B sits in SAFO classes, ≈10K Stellar holders, and it's growing fast: eurSAFO went from $589M to $1.30B in 90 days, largely money moving out of EUTBL. Nobody can borrow against it on Stellar.
- **Why it's Tier 5, not Tier 1:** the fund holds stocks and bonds and swaps their return with banks (BNP Paribas first) for €STR + spread. It behaves like cash until a swap bank defaults; then the fund is left holding the stocks and bonds.
- **Order:** USTBL first (Tier 1, same permission manager), SAFO second with a larger haircut.
- **Integration needs:**
  1. Spiko adds the Caravel contract **and every whitelisted liquidator** to its permission manager. This is the same model as our AUTH_REQUIRED spike, except allowlist entries replace trustline authorization.
  2. Per WhaleHub's read of the contract, the token has **no allowance functions** (`approve` / `transfer_from`). Caravel doesn't need them: in `take_offer` the borrower signs the call, and that authorization covers the token transfer to the contract. **Check:** run one `take_offer` against a Spiko-style mock token that has no `approve`.
  3. Pricing: daily NAV, using the stale-NAV rule (Decision 6). A EUR/USD feed is also needed for eurSAFO against USDC.
  4. The contract can be paused or upgraded by Spiko. List this as issuer risk in **Risks and limits**.

## 5. Rate benchmark (supports Decision 10)

- Risk-free floor: USDXX 7-day SEC yield **3.87%** (23 Oct 2026). FOBXX-type collateral yields about the same.
- Blend USDC suppliers earned 6.69%. So a passive holder borrowing against T-bills runs negative carry, which confirms Decision 10's target user (traders/MMs).
- **Proposal:** show offer APR in the UI as a spread over the T-bill floor ("T-bill + 1.5%"), which is how repo desks quote.

## 6. Liquidation path (supports Decisions 4 and 7)

- Issuers redeem only for approved holders on business days, so a seized fund share can't be dumped 24/7. The Aquarius USTRY pool loses ≈20% on a 250K sale.
- So the **whitelisted liquidator** in Decision 7 isn't just a demo shortcut. It's required: the liquidator must be an issuer-approved holder who can redeem at NAV. Put this in the pitch, because Aave Horizon uses the same model.
