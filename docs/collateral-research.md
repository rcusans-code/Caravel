# Collateral research: what Caravel's collateral really rests on

As of 25 Oct 2026. Full evidence, with a source and quote for every figure:
- [research/backing-chain-map.md](research/backing-chain-map.md): what each Stellar token is backed by, link by link, ranked into trust tiers.
- [research/rwa-collateral-gap-analysis.md](research/rwa-collateral-gap-analysis.md): which Stellar protocols accept RWA collateral today, and what's missing.

Items marked **Proposal** are team suggestions, not sourced facts. Per DECISIONS.md, agree on them in team chat before changing that file.

> **Updated Sun 16:35.** Market figures now come from DefiLlama, dated: see [numbers.md](numbers.md) (Stellar RWA Active AUM $3.03B, Spiko $1.965B, BENJI $434.68M; corrected 25 Oct). Launch haircuts are decided in [DECISIONS #26](../DECISIONS.md). The rwa.xyz figures and tier proposal below are kept as research history.

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


## 7. Whitelist vs KYC on Stellar (supports Decision 7 and the Innovation pitch)

KYC checks a **person**, off-chain. A whitelist is an on-chain rule about which **addresses** may hold or move an asset. KYC is usually how an address gets onto the whitelist, but the two are separate, and either can exist without the other.

| | KYC | Whitelist (allowlist) |
|---|---|---|
| What it is | Identity check: documents, address, sanctions screening | List of approved accounts or contracts |
| Where it lives | Off-chain, run by the issuer or an anchor | On-chain, enforced by the network or the token contract |
| Stellar standard | [SEP-12](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md) (KYC data exchange), used by SEP-6/24/31 anchors | Classic assets: issuer flags `AUTH_REQUIRED`, `AUTH_REVOCABLE`, clawback, plus per-trustline authorization ([docs](https://developers.stellar.org/docs/tokens/control-asset-access)). [SEP-8](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md): an approval server co-signs every transfer. Soroban: a token contract with a role/allowlist check |
| What the protocol knows | Nothing | Everything: transfers to unapproved addresses fail |

Either one alone:
- **KYC without a whitelist:** a stablecoin that checks identity only at mint and redeem, after which the token moves freely.
- **Whitelist without KYC:** a contract address cannot pass KYC, yet an issuer can still allowlist it. That is how a lending or repo contract holds a gated fund share.

How this maps to the collateral we target:
- **BENJI:** classic asset with `AUTH_REQUIRED`. Franklin must authorize the trustline of every holder, including the Caravel contract.
- **Spiko:** a Soroban token whose `transfer` requires `WHITELISTED_ROLE` on **both** `from` and `to` ([contract.rs#L297-L302](https://github.com/spiko-tech/stellar-contracts/blob/main/contracts/token/src/contract.rs#L297-L302)). Spiko grants the role through its permission manager.
- **USDY, USTRY, CETES:** revocable and clawback, but no `AUTH_REQUIRED`. Anyone can hold them, which is why existing lenders already accept them.

What it means for Caravel:
1. **Gating is not our edge.** XOXNO already supports an issuer-allowlisted fund token in tested code: the pool, holders and liquidators must all be allowlisted ([liqvid_rwa_collateral.rs](https://github.com/XOXNO/rs-lending-xlm/blob/30d59905/tests/test-harness/tests/controller/liqvid_rwa_collateral.rs)). Its six Spiko markets are configured but `"enabled": false` on mainnet ([markets.json#L425](https://github.com/XOXNO/rs-lending-xlm/blob/main/configs/mainnet/markets.json#L425)), and no public reason was found.
2. **The barrier is issuer approval, not code.** Writing the whitelist check is cheap. What is hard is getting Franklin or Spiko to approve the contract and every liquidator: legal and onboarding work for each issuer.
3. **Our design keeps the approval small.** Lenders hold only USDC and never the fund share, so they need no KYC. The issuer approves one escrow contract, the borrowers (already its holders) and the whitelisted liquidators (Decision 7).
4. **Pitch line:** "gated *and* on the fund's clock". Fixed term and NAV-timed margin calls are what no live lender offers. Gating alone is not. The edge is the fixed term, not the fixed rate: see §8.

## 8. Our edge: a term that matches redemption time, not a fixed rate (supports the Innovation pitch)

**Pitch line:** "Fixed-term loans are the only safe way to lend against collateral that takes days to redeem."

Why rate certainty alone is a weak pitch:
- DeFi borrowers have mostly passed on fixed rates. Yield Protocol closed in Dec 2023, citing lack of demand and regulatory pressure ([CoinTurk](https://en.coin-turk.com/yield-protocol-a-defi-project-shuts-down-due-to-regulatory-pressure-and-lack-of-demand/)). Aave dropped its stable-rate mode and moved every position to variable after a 2023 bug report ([Aave governance](https://governance.aave.com/t/bgd-full-deprecation-of-stable-rate/16473)).
- On a 7–30 day loan, a floating rate seldom moves much unless the pool runs low on cash, so a locked rate is worth little.

Why a fixed term is the real edge:
- Variable-rate pools such as XOXNO and Blend let suppliers withdraw at any time. The rate rises with utilization (borrowed share of supply) to keep cash in the pool ([XOXNO rate model](https://xoxno.com/docs/stellar-lending/dev/interest-and-revenue)). That only works if seized collateral can be sold at any hour.
- BENJI and Spiko can't be sold that way. They redeem only through the issuer, to approved holders, on business days (§1, §6).
- A fixed term means lenders agree up front to wait. That leaves time to redeem through the issuer at NAV instead of dumping the collateral on a thin DEX.
- Repo, the institutional form of this loan, already works this way, so the funds' existing holders know it.

The fixed rate is a by-product of the fixed term, not a selling point by itself.
