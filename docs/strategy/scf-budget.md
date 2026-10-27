# Caravel: SCF #46 Build budget, milestones and ask

Card the SAFO branch, 2026-10-26. For Misha to decide the amount. Nothing here has been submitted.
Tags: **[S#]** = sourced (list at the end, all read 2026-10-26), **[D]** = derived by arithmetic from sourced numbers, **[E]** = my estimate.

## Decide first

- **Recommended ask: $134,300 (option B).** It pays 4 people full-time for 5 months at EUR 5,800/month gross each. It sits at the $135K median of the 8 awarded lending/RWA comparables below [D].
- **Two items in the interest-form draft cannot be paid from a Build budget**: the audit (milestone 1) and lender onboarding with market makers (milestone 4, which counts as user acquisition) [S1]. Reword them before the form goes in (see "Fixes to the interest-form draft").
- **Cash arrives after the work.** Only 10% is paid at award. Under B the team floats up to $53,720 before the last payment [D]. Two months of savings per person, or pay in arrears, is the real cushion.

## 1. Rules (SCF Build, Open Track)

**Size and time**
- The cap is $150,000 worth of XLM per award [S1]. The handbook's general SCF 7.0 rules also cap the total across Build awards at $150K: after finishing all tranches, a project "may submit for additional Build Awards up to a total of $150,000", and above that only "on a case-by-case basis" [S5]. This applies to Caravel. The wording is slightly ambiguous ("additional Build Awards up to a total of $150,000"), so the likely reading is a $150K total. The $300K ceiling is stated only for "Previously Funded Projects" (funded before SCF #41), so it is unconfirmed for Caravel [S5].
- The timeline must not exceed 6 months [S1]. The Build Award page says awards are "intended to cover (up to ~4 months of) development costs" and target teams "ready to deliver and ship in 3–5 months" [S2]. These two pages disagree; plan for 4–5 months.
- "Requesting the maximum award amount is not expected. Proposals that overreach in cost relative to their scope often perform poorly in review and voting." [S1]
- Payment is in XLM at its USD value on the day each payment is made (CF Benchmarks XLMUSD_RR) [S5]. The price risk starts only once the team holds the XLM. At $0.1678/XLM, $134,300 is about 800,267 XLM [S17][D].

**What the budget may pay for** [S1]
- Allowed: Soroban contract work and tests, adapters and integrations, backend/indexers, the dApp, QA and testnet simulation, monitoring and alerting, mainnet deployment, SDKs, APIs, docs, and infrastructure such as NAV APIs.
- Not allowed: **audit costs** (the Audit Bank covers these), **marketing and user acquisition**, bounties, giveaways or prize pools, **legal fees and entity registration**, and pay for past work. "Costs must support future development, not past work or general operations."
- **Salaries:** the handbook does not name salaries or contractor fees, either to allow or to ban them. What it says is that the budget "should reflect the actual hours of engineering and product work required to deliver the milestones, not operational overhead" [S1], and that it must "only cover development costs for the Stellar-integrated components" [S4]. No rate cap is stated. None of the 10 comparables I read shows salaries or day rates; every one prices deliverables in dollars. **Variant without salaries:** keep the same numbers, framed as fixed prices per deliverable (the tables below already are), and pay team members from tranche receipts as contractors. If SCF ever rejected labour outright, the eligible remainder would be about $4.5K of infrastructure, which is not a grant worth applying for.
- Liquidity: the Build pages do not list it as allowed or banned. The Official Rules bar using award money for speculation [S9]. Lucent was awarded with a $6K line for "limited mainnet operational balances for fees, reserves, TTL/storage, and live validation" [S12]. Seeding lender offers with grant USDC is not listed anywhere; keep that out of the budget and use the Liquidity Award or the team's own money.

**Tranches** [S1][S10]
- There are 4 payments: **T0 10%** on award acceptance, **T1 20%** for the MVP, **T2 30%** for testnet, **T3 40%** for mainnet launch. These percentages are fixed. The deliverables in each tranche are yours to set, and each one needs a dollar amount and a way for reviewers to verify it.
- "Tranche 1 should focus on actual development—not planning, research, or system design." The architecture must be complete when you submit.
- **T2 must include a STRIDE threat model and an on-chain monitoring plan** [S4].
- Each tranche must be submitted within 90 calendar days of the previous payment. If it is late and SCF was not told beforehand, the rest of the award is forfeited [S1][S9].
- The final tranche is a mainnet launch. SCF may limit some jurisdictions to testnet and will say so after reading the interest form [S1][S2].

**Open Track specifics** [S2][S3][S4]
- Review is by 2 panel reviewers, then a revision window, then a community vote. Integration and RFP tracks have no vote.
- The Open Track is for experienced teams with novel primitives. It names "builders without much prior experience in domain or the Stellar ecosystem" as a better fit for Instawards.
- Reviewers want: milestones mapped to mainnet; "how your proposed solution will drive onchain growth, and how that growth will be measured"; a market analysis; one documentation source (e.g. a Gitbook); a team video; and **"full-disclosure on the use of AI-generated and AI-assisted artifacts (docs, code, etc.)"**.
- "No external materials are considered": the submission must stand on its own [S4].
- Every individual contributor completes KYC [S2].

**Support programmes (outside the Build budget)**
- **Audit Bank** [S6][S7]. Open to SCF-funded financial protocols, a priority category, so Caravel qualifies once awarded. The project pays a 5% co-pay up front, refunded if all critical, high and medium findings are fixed within 20 business days. A 2nd audit carries a 20% co-pay and a 3rd 50%; audits are free at $10M and $100M TVL. Timing: readiness review under 4 weeks, matching about 2 weeks later, scheduling 3–6 weeks after that, and an audit of 2–8 weeks. **That is 7–20 weeks from request to report [D].** S7's own phase table gives different durations (audit 1–6 weeks, then 1–4 weeks of resolution and 2–3 weeks of verification) [S7].
- **When Caravel can request it.** Eligibility requires the code in audit scope to be complete, the project close to mainnet, an audit needed within 4–6 weeks, and a Testnet deployment; the intake form only goes to projects at Testnet [S7]. The FAQ says to request "typically after completing the SCF Build Testnet tranche" [S6]. The T2 contracts (auction, lender vault) do not exist at award, so the earliest real request is the end of T2 (month 3 under B). The report then lands around **month 4.6–7.6** [D], often after T3 (month 5). That is why the plan below does not make the audit report a T3 deliverable.
- The average audit cost is about $75K: over 40 audits for more than $3M [S16][D]. So the co-pay to float is about $3.75K [D], refundable.
- **Liquidity Award** [S8]. Up to $100K in XLM: a $50K base, plus $50K more after 7 consecutive days of TVL above $250K. It requires a completed audit, a live mainnet protocol, and KYC and due diligence. This is the funding route for seeding offers, after T3.
- After the award, SCF may also provide a UX audit and user testing [S5].

## 2. Comparables (cited)

Pages were read on communityfund.stellar.org on 2026-10-26. "Team" is the project page's Team Size field. The round pages do not show the track. Pages with a "Tranche 3 Onchain Metric" section are Integration-style.

| Project (round) | Ask, outcome | Tranches T1 / T2 / T3 | Shape worth copying | Source |
|---|---|---|---|---|
| Liqvid X, RWA lending market on Alula (#45) | $97.5K, awarded. The same ask in #44 was not awarded | $19,500 / $29,250 / $39,000 (exactly 20/30/40% of the ask; T0 not allocated) | NAV oracle + SEP-40 adaptor, allowlisted liquidators, CCTP. T2 includes the threat model and monitoring plan. T3 is released against $150K of USDC borrowed in any rolling 30 days | [S11] |
| Lucent, fixed-rate stablecoin credit (#44) | $135K, awarded. The same ask in #43 was not awarded | $27,000 / $40,500 / $54,000 (20/30/40%) | Bots and keepers as lines. $6K for mainnet operational balances. "Not publicly launched until the audit is completed." Team 3 | [S12] |
| XOXNO, enterprise lending (#43) | $135K, awarded | $27,000 / $40,500 / $54,000 (20/30/40%) | Durations stated: T1 2–4 weeks, T2 4 weeks, T3 4–6 weeks. $5–12K per deliverable. Team 2 | [S13] |
| XCCY, fixed-rate layer on Blend (#43) | $141.1K, awarded | $37,125 / $57,000 / $47,000 (sums to 100%) | Three 4-week tranches (12 weeks in all). Mainnet under multisig with caps. Targets of $100K TVL and 10,000 txs one month after mainnet. Team 4 | [S14] |
| Octarine, RFQ for RWA instant redemptions (#44) | $129.7K, awarded | $39,700 / $44,100 / $45,600 (sum $129.4K, $300 short of the ask on the page) | A dated deliverable roughly every 10 days, Jul–Oct 2026. Keeper bots are a T3 line. Has a T3 on-chain metric. Team 2 | [S15] |
| Talwex, vault for real-world bonds (#43) | $150K (cap), awarded | $45,000 / $55,000 / $50,000 | T3 = "security hardening and audit remediation" + mainnet. Audit via separate credits. Team 1 | [S18] |
| Pipeline, commodity trade finance (#43) | $140K, awarded | $40,000 / $45,000 / $55,000 | Each tranche is split into contracts / backend / frontend. Its yield mint uses BENJI NAV. Team 1 | [S19] |
| Turbolong, leveraged DeFi (#43) | $99K, awarded | about $20K / $30K / $39K (about 90% of the ask allocated) | Many $2–10K deliverables, each with an acceptance test. Team 3 | [S20] |
| Juncta, DLMM + RWA lending (#44) | $140K, **not awarded** | $31,000 / $47,000 / $62,000 | Negative datapoint | [S21] |
| Agama, private-credit yield vaults (#44) | $124.6K, **not awarded** | $35,700 / $39,000 / $49,900 | Negative datapoint | [S22] |

**Base rates [D from S23].** I scraped the round pages for #41–#44: 134 "Build Awarded" submissions (34/26/28/46), median $101.5K, mean $103.7K. #45 Open Track: 8 awards totalling $838K, about $105K each [S24].
**Lending/RWA awarded set** (first 8 rows): median $135K, range $97.5K–$150K [D].

**What the comparables show**
- Two conventions exist. Either deliverables sum to the whole ask (XCCY, Octarine, Talwex, Pipeline), or each tranche's deliverables are sized at exactly 20/30/40% of the ask (Liqvid X, Lucent, XOXNO).
- I use a third, consistent with both: T1 deliverables ≈ 30% of the ask (T0 + T1 payments), T2 ≈ 30%, T3 ≈ 40%. The money then follows the work, and the deliverables sum to the ask.
- Lucent and Liqvid X both won on resubmission at the same amount. The amount was probably not what failed them the first time [D], though the pages do not give reasons.
- No comparable budgets for audits, legal or marketing.

## 3. Milestones and tranches

**Starting point** (mainnet-readiness/submission-blurb.md). The testnet build is done: DvP takes, daily-NAV margin, auto-repay, liquidation, claimable payouts, a guardian with timelock, exposure caps, and 281 tests. That is past work, so it is not billable [S1]. It does serve as traction evidence and proves the architecture is complete. T1 therefore starts at mainnet hardening, not at an MVP.

**Timing [D].** #45 closed on 16 Aug [S23] and published results on 23 Sep [S24], about 5.5 weeks later. #46 closes on 8 Nov [S23]; at the same pace the award arrives around **mid-December 2026** [D]. T0 also needs award acceptance and KYC, so the payment may trail by a few weeks [E]. Month 0 below is mid-December 2026.

| Tranche | Goal | Ends (B) | Reviewer verifies |
|---|---|---|---|
| T1 "mainnet-grade core" | Admin hardening, real NAV feed adapter, redundant keepers, production app flows, one docs site | Month 1.5 | Testnet contract IDs; multisig and timelock tx hashes; a stale-NAV rejection tx; keeper failover video; docs URL |
| T2 "depth + security" | Liquidation auction, lender vault, distribution pass-through, threat model + monitoring plan, Audit Bank readiness | Month 3.0 | Auction and vault txs on testnet; STRIDE doc; monitoring plan; frozen audit commit hash; Audit Bank request filed at the end of T2, the earliest it is eligible [S6][S7] |
| T3 "mainnet beta" | Audit readiness fixes and pre-audit hardening, capped mainnet deploy with one Tier 1 asset (cap $2M), monitoring live, indexer/API/DefiLlama adapter, open source | Month 5.0 | Mainnet contract IDs; first repo opened and closed on mainnet (tx hashes); Audit Bank readiness-review outcome and fix commits; DefiLlama adapter PR; repo licence |

**The audit is not a T3 gate.** The report may land after month 5 (see Audit Bank above), so T3 does not list it. Mainnet is not publicly launched until the report is in and the critical/high/medium findings are fixed, as Lucent committed ("will not be publicly launched until the audit is completed and any fixes are implemented") [S12]. Until then Caravel runs mainnet as a capped, invite-only beta, its own choice [E]. Remediation of findings that arrive after T3 is team time outside the budget (see "Costs outside the SCF budget"). The alternative, lengthening T3 to wait for the report, could push B to month 7.6 or later in the worst case and break the 6-month limit [S1][D].

**Growth measure for the Open Track ask [E].** One issuer live, 1 liquidator whitelisted, and at least 3 repos closed on mainnet within 30 days of launch. The SCF lending comparables used $100K–$150K volume or TVL targets [S11][S14]. Commit to a number only if issuer and lender talks support it.

**Risks to the 90-day clock**
1. **The audit wait** (7–20 weeks [D]). The request cannot go in before the end of T2 [S6][S7], so freeze the audit commit and file the request on the day T2 is submitted. T3 does not depend on the report; public launch does. If the 90-day clock for T3 is at risk for any reason, tell SCF before the deadline [S1].
2. **Issuer authorisation** of the contract and liquidator (Franklin or Spiko). Nothing has been sent yet (mainnet-outreach/README.md). T3 cannot be verified without it.
3. **The BENJI feed.** RedStone has no SEP-40 BENJI feed yet (feed-probe.md: FAIL), so 1.2 includes the adapter.

## 4. Three budget options

**Rates.** The rates are the main assumption. EUR→USD 1.1188 (ECB reference, 2026-10-26) [S17].
- Portugal Rust salaries, local companies: mid-level EUR 55–75K/yr, senior EUR 70–90K/yr. Remote roles for international companies: EUR 95–130K [S25].
- Levels.fyi Portugal senior SWE median: $72.2K [S26].
- Portugal contractor day rates: software engineer benchmark EUR 323/day (range EUR 314–335), principal EUR 427/day [S27].
- Independent workers' social security is 21.4% on 70% of income, about 15% of gross [S28]. All figures below are gross invoice amounts before IRS and social security.

| | A Lean | **B Realistic** | C With cushion |
|---|---|---|---|
| **Ask** | **$86,300** | **$134,300** | **$147,500** |
| Months full-time, 4 people | 4.0 | 5.0 | 5.5 |
| Gross per person per month | EUR 4,600 ($5,146), the low end of the local mid-level band (EUR 55K/yr) [S25][D] | EUR 5,800 ($6,489) ≈ EUR 70K/yr, the local senior floor; ≈ 18 days at the EUR 323/day contractor benchmark [S25][S27][D] | Same rate as B; the cushion is time and scope, not rate |
| Team burn per month | $20,586 | $25,956 | $25,956 |
| Scope | B minus the lender vault; thinner audit-fix, ops and docs time | Full plan above | B + a second issuer on mainnet + a half month spanning the audit wait |
| Largest float before the last payment [D] | $34,520 | $53,720 | $59,000 |
| Versus the comparables | Below the round median ($101.5K) | At the lending/RWA median ($135K) | Near the cap; only Talwex asked $150K |

In each table below, the person-month split per line is my estimate [E]; each line is person-months × rate [D]. "Team floats" means cost of work done minus money received, just before that payment arrives [D].

### A Lean, $86,300
Changes from B: lender vault dropped (it becomes a follow-on); keepers move to T2; audit-fix, ops, indexer and docs time trimmed.

| Tranche | # | Line | Person-months | USD | Basis |
|---|---|---|---|---|---|
| T1 | 1.1 | Admin hardening: multisig admin and guardian, keys out of git, split admin keys, timelocked liquidator whitelist | 1.5 | $7,700 | E: pm estimate x rate |
| T1 | 1.2 | Mainnet NAV feed: SEP-40 adapter for the issuer NAV feed (RedStone MultiFeed) with source-time staleness check and per-asset NAV bounds | 2 | $10,300 | E: pm estimate x rate |
| T1 | 1.4 | App: production wallet flows (Stellar Wallets Kit), position view; one docs site for the project | 1 | $5,100 | E: pm estimate x rate |
| T1 | N1 | Infra share: RPC provider, two keeper hosts, indexer DB (est. $400/month) | - | $500 | E |
| T1 | N2 | CI and fuzzing compute | - | $400 | E |
| **T1 total** | | | 4.5 | **$24,000** | 27.8% of ask |
| T2 | 1.3 | Production deploy profile and redundant keepers (two hosts, failover) on testnet | 1.25 | $6,400 | E: pm estimate x rate |
| T2 | 2.1 | Liquidation auction among whitelisted liquidators (replaces fixed NAV -2%) | 2 | $10,300 | E: pm estimate x rate |
| T2 | 2.3 | Distribution pass-through for yield-paying fund shares | 0.75 | $3,900 | E: pm estimate x rate |
| T2 | 2.4 | STRIDE threat model, on-chain monitoring plan (required for tranche 2), Audit Bank readiness, frozen audit commit | 1.25 | $6,400 | E: pm estimate x rate |
| T2 | N1 | Infra share (as above) | - | $500 | E |
| T2 | N3 | Alerting/paging seats for the monitoring plan | - | $600 | E |
| **T2 total** | | | 5.25 | **$28,100** | 32.6% of ask |
| T3 | 3.1 | Audit readiness and pre-audit hardening: fix Audit Bank readiness-review feedback, fuzz and invariant campaign, fix any findings received before T3 submission | 1.5 | $7,700 | E: pm estimate x rate |
| T3 | 3.2 | Mainnet deploy with one Tier 1 asset (BENJI or USTBL), capped at $2M; issuer authorizes contract and liquidator | 1.5 | $7,700 | E: pm estimate x rate |
| T3 | 3.3 | Monitoring and alerting live, incident runbooks, keeper operations | 1.25 | $6,400 | E: pm estimate x rate |
| T3 | 3.4 | Indexer, public API, DefiLlama adapter, production app | 1.5 | $7,700 | E: pm estimate x rate |
| T3 | 3.5 | Open-source release, user and integrator docs | 0.5 | $2,600 | E: pm estimate x rate |
| T3 | N1 | Infra share (as above) | - | $600 | E |
| T3 | N4 | Mainnet operational balances: XLM for fees, TTL rent, keeper and multisig reserves | - | $1,500 | E |
| **T3 total** | | | 6.25 | **$34,200** | 39.6% of ask |
| **Ask** | | | 16 | **$86,300** | T1+T2+T3 = ask |

| Payment | Unlocks on | % | USD | Cumulative cost of work by then | Received before that payment | Team floats |
|---|---|---|---|---|---|---|
| T0 | award acceptance | 10% | $8,630 | $0 | $0 | $0 |
| T1 | T1 deliverables verified (month 1.1) | 20% | $17,260 | $24,000 | $8,630 | $15,370 |
| T2 | T2 deliverables verified (month 2.4) | 30% | $25,890 | $52,100 | $25,890 | $26,210 |
| T3 | T3 deliverables verified (month 4.0) | 40% | $34,520 | $86,300 | $51,780 | $34,520 |
| **Sum** | | 100% | **$86,300** | | | |

### B Realistic, $134,300 (recommended)

| Tranche | # | Line | Person-months | USD | Basis |
|---|---|---|---|---|---|
| T1 | 1.1 | Admin hardening: multisig admin and guardian, keys out of git, split admin keys, timelocked liquidator whitelist | 1.5 | $9,700 | E: pm estimate x rate |
| T1 | 1.2 | Mainnet NAV feed: SEP-40 adapter for the issuer NAV feed (RedStone MultiFeed) with source-time staleness check and per-asset NAV bounds | 2 | $13,000 | E: pm estimate x rate |
| T1 | 1.3 | Production deploy profile and redundant keepers (two hosts, failover) on testnet | 1.25 | $8,100 | E: pm estimate x rate |
| T1 | 1.4 | App: production wallet flows (Stellar Wallets Kit), position view; one docs site for the project | 1.25 | $8,100 | E: pm estimate x rate |
| T1 | N1 | Infra share: RPC provider, two keeper hosts, indexer DB (est. $400/month) | - | $600 | E |
| T1 | N2 | CI and fuzzing compute | - | $400 | E |
| **T1 total** | | | 6 | **$39,900** | 29.7% of ask |
| T2 | 2.1 | Liquidation auction among whitelisted liquidators (replaces fixed NAV -2%) | 2 | $13,000 | E: pm estimate x rate |
| T2 | 2.2 | Lender vault: pooled USDC that fills offers; idle USDC parked in Blend | 2 | $13,000 | E: pm estimate x rate |
| T2 | 2.3 | Distribution pass-through for yield-paying fund shares | 0.75 | $4,900 | E: pm estimate x rate |
| T2 | 2.4 | STRIDE threat model, on-chain monitoring plan (required for tranche 2), Audit Bank readiness, frozen audit commit | 1.25 | $8,100 | E: pm estimate x rate |
| T2 | N1 | Infra share (as above) | - | $600 | E |
| T2 | N3 | Alerting/paging seats for the monitoring plan | - | $600 | E |
| **T2 total** | | | 6 | **$40,200** | 29.9% of ask |
| T3 | 3.1 | Audit readiness and pre-audit hardening: fix Audit Bank readiness-review feedback, fuzz and invariant campaign, fix any findings received before T3 submission | 2 | $13,000 | E: pm estimate x rate |
| T3 | 3.2 | Mainnet deploy with one Tier 1 asset (BENJI or USTBL), capped at $2M; issuer authorizes contract and liquidator | 1.5 | $9,700 | E: pm estimate x rate |
| T3 | 3.3 | Monitoring and alerting live, incident runbooks, keeper operations | 1.5 | $9,700 | E: pm estimate x rate |
| T3 | 3.4 | Indexer, public API, DefiLlama adapter, production app | 2 | $13,000 | E: pm estimate x rate |
| T3 | 3.5 | Open-source release, user and integrator docs | 1 | $6,500 | E: pm estimate x rate |
| T3 | N1 | Infra share (as above) | - | $800 | E |
| T3 | N4 | Mainnet operational balances: XLM for fees, TTL rent, keeper and multisig reserves | - | $1,500 | E |
| **T3 total** | | | 8 | **$54,200** | 40.4% of ask |
| **Ask** | | | 20 | **$134,300** | T1+T2+T3 = ask |

| Payment | Unlocks on | % | USD | Cumulative cost of work by then | Received before that payment | Team floats |
|---|---|---|---|---|---|---|
| T0 | award acceptance | 10% | $13,430 | $0 | $0 | $0 |
| T1 | T1 deliverables verified (month 1.5) | 20% | $26,860 | $39,900 | $13,430 | $26,470 |
| T2 | T2 deliverables verified (month 3.0) | 30% | $40,290 | $80,100 | $40,290 | $39,810 |
| T3 | T3 deliverables verified (month 5.0) | 40% | $53,720 | $134,300 | $80,580 | $53,720 |
| **Sum** | | 100% | **$134,300** | | | |

### C With cushion, $147,500
This is B plus 3.6. The extra 2 person-months keep the team paid through the audit wait and add a second issuer.

| Tranche | # | Line | Person-months | USD | Basis |
|---|---|---|---|---|---|
| T1 | 1.1 | Admin hardening: multisig admin and guardian, keys out of git, split admin keys, timelocked liquidator whitelist | 1.5 | $9,700 | E: pm estimate x rate |
| T1 | 1.2 | Mainnet NAV feed: SEP-40 adapter for the issuer NAV feed (RedStone MultiFeed) with source-time staleness check and per-asset NAV bounds | 2 | $13,000 | E: pm estimate x rate |
| T1 | 1.3 | Production deploy profile and redundant keepers (two hosts, failover) on testnet | 1.25 | $8,100 | E: pm estimate x rate |
| T1 | 1.4 | App: production wallet flows (Stellar Wallets Kit), position view; one docs site for the project | 1.25 | $8,100 | E: pm estimate x rate |
| T1 | N1 | Infra share: RPC provider, two keeper hosts, indexer DB (est. $400/month) | - | $700 | E |
| T1 | N2 | CI and fuzzing compute | - | $400 | E |
| **T1 total** | | | 6 | **$40,000** | 27.1% of ask |
| T2 | 2.1 | Liquidation auction among whitelisted liquidators (replaces fixed NAV -2%) | 2 | $13,000 | E: pm estimate x rate |
| T2 | 2.2 | Lender vault: pooled USDC that fills offers; idle USDC parked in Blend | 2 | $13,000 | E: pm estimate x rate |
| T2 | 2.3 | Distribution pass-through for yield-paying fund shares | 0.75 | $4,900 | E: pm estimate x rate |
| T2 | 2.4 | STRIDE threat model, on-chain monitoring plan (required for tranche 2), Audit Bank readiness, frozen audit commit | 1.25 | $8,100 | E: pm estimate x rate |
| T2 | N1 | Infra share (as above) | - | $700 | E |
| T2 | N3 | Alerting/paging seats for the monitoring plan | - | $600 | E |
| **T2 total** | | | 6 | **$40,300** | 27.3% of ask |
| T3 | 3.1 | Audit readiness and pre-audit hardening: fix Audit Bank readiness-review feedback, fuzz and invariant campaign, fix any findings received before T3 submission | 2 | $13,000 | E: pm estimate x rate |
| T3 | 3.2 | Mainnet deploy with one Tier 1 asset (BENJI or USTBL), capped at $2M; issuer authorizes contract and liquidator | 1.5 | $9,700 | E: pm estimate x rate |
| T3 | 3.3 | Monitoring and alerting live, incident runbooks, keeper operations | 1.5 | $9,700 | E: pm estimate x rate |
| T3 | 3.4 | Indexer, public API, DefiLlama adapter, production app | 2 | $13,000 | E: pm estimate x rate |
| T3 | 3.5 | Open-source release, user and integrator docs | 1 | $6,500 | E: pm estimate x rate |
| T3 | 3.6 | Second issuer on mainnet (Spiko USTBL if 3.2 is BENJI, or the reverse): allowlist, NAV feed, liquidator | 2 | $13,000 | E: pm estimate x rate |
| T3 | N1 | Infra share (as above) | - | $800 | E |
| T3 | N4 | Mainnet operational balances: XLM for fees, TTL rent, keeper and multisig reserves | - | $1,500 | E |
| **T3 total** | | | 10 | **$67,200** | 45.6% of ask |
| **Ask** | | | 22 | **$147,500** | T1+T2+T3 = ask |

| Payment | Unlocks on | % | USD | Cumulative cost of work by then | Received before that payment | Team floats |
|---|---|---|---|---|---|---|
| T0 | award acceptance | 10% | $14,750 | $0 | $0 | $0 |
| T1 | T1 deliverables verified (month 1.5) | 20% | $29,500 | $40,000 | $14,750 | $25,250 |
| T2 | T2 deliverables verified (month 3.0) | 30% | $44,250 | $80,300 | $44,250 | $36,050 |
| T3 | T3 deliverables verified (month 5.5) | 40% | $59,000 | $147,500 | $88,500 | $59,000 |
| **Sum** | | 100% | **$147,500** | | | |

### Costs outside the SCF budget (all options)

| Item | Amount | Who pays |
|---|---|---|
| Audit | About $75K value [D], paid by the Audit Bank | SDF |
| Audit co-pay, 5%, refundable | About $3.75K [D] | Team float |
| Audit remediation for findings that arrive after T3 (report at month 4.6–7.6 [D]) | Team time [E] | Team, before public launch |
| Legal analysis per issuer (whether intermediating repo needs a licence in PT/EU; issuer terms) | EUR 8–20K [E] | Team, or a later raise. Not SCF-eligible [S1] |
| Entity (if applying as a company) | Small [E] | Team. Not SCF-eligible [S1] |
| Seed offers for the mainnet beta | Team choice [E] | Own funds, then the Liquidity Award ($50K + $50K) after audit and mainnet [S8] |
| Lender outreach / BD / market makers | Time | Team. Marketing is not SCF-eligible [S1] |
| Living costs between award and T1 payment, and the float above | Up to $53,720 under B [D] | Team savings or pay in arrears |

## 5. Recommendation

**Ask $134,300 (option B).**
- Every line maps to a deliverable a reviewer can verify. The amount equals the median of awarded lending/RWA peers, and it pays 4 people for 5 months at a local-senior rate.
- **Why not C:** its extra deliverable, a second issuer on mainnet, depends on an issuer that has not answered yet. An unverifiable T3 deliverable risks the 40% tranche. C fits better if Spiko or Franklin say yes before 8 Nov, the #46 deadline [S23].
- **Why not A:** it saves about $48K and gives up a month of pay. The guidelines punish overreach, not a full-time team that is costed per deliverable.
- **Lifetime cap:** the handbook's general rules cap the total across Build awards at $150K, case by case above it [S5]. On the likely reading (a $150K total), B uses $134.3K of it and any later Build award is limited to about $15.7K unless SCF grants an exception [D]. The wording is slightly ambiguous, and the $300K ceiling is stated only for pre-#41 projects, so confirm with SCF. Either way, plan follow-on money from the Liquidity Award, the Growth Hack programme or a raise, not a second Build award.

**Fixes to the interest-form draft** (scf-interest-form-draft.md; I have not edited it)
1. Milestone 1 "Security audit (via Audit Bank)": change to "Mainnet hardening and audit readiness; audit via the Audit Bank, then remediation". The audit itself is not a budget line.
2. Milestone 4 "Lender onboarding: market makers, DeFindex vaults": change to "Lender vault contract + Blend parking for idle USDC". Market-maker onboarding is user acquisition and is not fundable.
3. Add a sentence that says plainly which parts are AI-assisted, as the Open Track asks.

## 6. Open questions for Misha

1. **Team and pay.** The team is Denys Nichoha, Mykhailo Benych, Bohdan Chernenko and Bohdan Protsiv (Misha, 2026-10-26 ; Protsiv replaces Bohdan Koldun from the deck). Roles: Nichoha CEO, Benych CTO, Chernenko CPO, Protsiv CBDO; all four are founders. Is each going full-time from about mid-December 2026, and is EUR 5,800/month gross acceptable? (B's numbers scale linearly: every EUR 500/month per person adds about $11.2K over 5 months [D].)
2. **Who floats the cash.** Payment trails delivery by up to $53,720 under B. Is the team paid in arrears from each tranche, or from savings? Who covers the off-budget legal work (EUR 8–20K [E]) and the audit co-pay (about $3.75K [D])?
3. **Track and disclosure.** Open Track (community vote; novel primitive, but "experienced teams" wording and zero users) or Integration Track (no vote, but T3 is tied to an on-chain metric and traction is expected)? I lean Open. Also: how much of the code and docs is AI-generated? The Open Track requires full disclosure.
4. First mainnet asset: BENJI (feed gap) or USTBL (Spiko allowlist)? This fixes 1.2 and 3.2.
5. Apply as individuals (each completes KYC) or as a company? Also, will a Portugal-based team face a jurisdiction restriction? SCF says this after reading the interest form.

## Sources

- [S1] SCF Handbook, Budget & Deliverable Guidelines: https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/budget-and-deliverable-guidelines
- [S2] Build Award: https://stellar.gitbook.io/scf-handbook/scf-awards/build-award
- [S3] Open Track: https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/open-track
- [S4] Submission Criteria: https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/submission-criteria
- [S5] Handbook home ("What's New": 10/20/30/40, UX audit; XLM valuation disclaimer; general rule: additional Build awards "up to a total of $150,000", case by case above it; the $300K ceiling is stated only under "Previously Funded Projects", i.e. funded before #41): https://stellar.gitbook.io/scf-handbook
- [S6] Audit Bank FAQ: https://stellar.gitbook.io/scf-handbook/supporting-programs/audit-bank/faq
- [S7] Audit Bank Official Rules (eligibility, readiness review <4 weeks, co-pay table): https://stellar.gitbook.io/scf-handbook/supporting-programs/audit-bank/official-rules
- [S8] Liquidity Award Official Rules: https://stellar.gitbook.io/scf-handbook/supporting-programs/stellar-liquidity-award/official-rules
- [S9] Official Rules for Submissions (§3 use of funds, §5.8 forfeiture): https://stellar.gitbook.io/scf-handbook/scf-awards/official-rules-for-submissions
- [S10] SCF FAQ (tranche %): https://stellar.gitbook.io/scf-handbook/additional-support/faq
- [S11] Liqvid X, SCF #45: https://communityfund.stellar.org/submissions/recLauVL3boo779AG (#44 not awarded: https://communityfund.stellar.org/submissions/recIPO2uN2oa0uitf)
- [S12] Lucent, SCF #44: https://communityfund.stellar.org/submissions/recZeITw6WJDXb0u8 (#43 not awarded: https://communityfund.stellar.org/submissions/recGaRnK3EInDexNy)
- [S13] XOXNO, SCF #43: https://communityfund.stellar.org/submissions/recEurBxz99NjcksC
- [S14] XCCY, SCF #43: https://communityfund.stellar.org/submissions/recYG4H2aBA5lJSnG
- [S15] Octarine, SCF #44: https://communityfund.stellar.org/submissions/recbRpXosPJ3lhhgr
- [S16] Lumen Loop on the Stellar blog post "Soroban Security Audit Bank: Raising the Standard" (40+ audits, $3M+): https://lumenloop.com/news/soroban-security-audit-bank-raising-standard-smart-contract
- [S17] FX: ECB reference rate via https://api.frankfurter.dev/v1/latest?from=EUR&to=USD (1.1188, 2026-10-26); XLM $0.167819 via the CoinGecko simple-price API, 2026-10-26
- [S18] Talwex, SCF #43: https://communityfund.stellar.org/submissions/recK1Xh6hgHosxmbt
- [S19] Pipeline, SCF #43: https://communityfund.stellar.org/submissions/recBY9t2rdEv609rl
- [S20] Turbolong, SCF #43: https://communityfund.stellar.org/submissions/rec3XPXsjkWBdR107
- [S21] Juncta, SCF #44: https://communityfund.stellar.org/submissions/recYavI5jCka5BBnL
- [S22] Agama, SCF #44: https://communityfund.stellar.org/submissions/recGuf9RKvCTgsTFN
- [S23] Round pages: #41 https://communityfund.stellar.org/awards/recTLIVf9LOTBtkld, #42 https://communityfund.stellar.org/awards/recweELi12M0ftBYZ, #43 https://communityfund.stellar.org/awards/reciQ16Y1ztmnmE3N, #44 https://communityfund.stellar.org/awards/rec4FnYypcsKpBRB4, #45 status on https://communityfund.stellar.org/awards
- [S24] Lumen Loop, SCF #45 recap: https://lumenloop.com/news/scf-45-round-recap
- [S25] Rustify, Rust developer salaries in Portugal 2026: https://rustify.rs/articles/rust-developer-salaries-portugal-2026
- [S26] Levels.fyi, Senior SWE Portugal: https://www.levels.fyi/t/software-engineer/levels/senior/locations/portugal
- [S27] Paymetric Labs, Portugal contractor day rates 2026: https://www.paymetriclabs.com/pt/contract-rates
- [S28] Especialista do IRS, social security for independent workers: https://especialistadoirs.pt/guias/seguranca-social-independentes


## QA verdict

**Verdict: FAIL. 2 material claims and 4 minor ones need fixing. The ask amounts and all the arithmetic hold.**

I re-fetched every source on 2026-10-26: handbook S1–S10 as .md, the 12 submission pages, round pages #41–#44 and /awards, and S16, S17, S24–S28 (Levels.fyi via web_extract, since curl gets a 403).

**Passed**
- Arithmetic, all 3 options: line items sum to the tranche totals and the tranche totals sum to the ask (A $86,300, B $134,300, C $147,500). Every line is person-months × rate (EUR 4,600 or 5,800 × 1.1188), within rounding to $100. The 10/20/30/40 payouts and every "team floats" figure recompute exactly. Person-months come to 16 / 20 / 22, which is 4.0 / 5.0 / 5.5 months for 4 people.
- All 10 comparables match their live pages: ask, awarded or not, T1/T2/T3 amounts, team size, and the "shape" notes. Also correct: Octarine's $129.4K vs $129.7K gap, Turbolong ≈90% allocated, XCCY W1–W12, the resubmission history of Liqvid X and Lucent, Lucent's $6K operational balances and its launch-after-audit clause, Pipeline's BENJI NAV, and Talwex's audit remediation in T3.
- Handbook rules: $150K cap, 6 months, the ~4-month and 3–5-month wording, the overreach quote, the allowed and banned lists, the "actual hours" and "Stellar-integrated components" quotes, the 10/20/30/40 split, 90-day forfeiture (S1 and S9 §5.8), the T2 threat model and monitoring plan, Open Track review/vote/AI disclosure/experience wording, KYC for each contributor, the jurisdiction notice coming after the interest form, the XLMUSD_RR valuation, and the S9 speculation ban.
- Audit Bank (5% co-pay refundable within 20 business days, 20%/50% follow-ups, free at $10M/$100M TVL, FAQ timings) and Liquidity Award ($50K + $50K after 7 days of TVL above $250K, audit and mainnet required) match.
- Market data: EUR/USD 1.1188 and XLM ≈ $0.1678 (live), Rustify bands, Levels.fyi $72,227, €323/€427 per day, SS 21.4% on 70%, #45 Open Track 8 awards for $838K, Audit Bank 40+ audits for $3M+.
- Unsourced numbers: every one is tagged [E] or [D], except the minor case in item 6.

**Failed claims**
1. **Material: "Request the audit at award" (§3 T2 row, Risk 1).** This contradicts the Audit Bank rules [S7]. Eligibility needs the code in audit scope to be finished, the project nearly mainnet-ready, an audit needed within 4–6 weeks, and Testnet deployment. The intake form only goes to projects that have reached Testnet. The FAQ says to request "typically after completing the SCF Build Testnet tranche" [S6]. At award, the T2 contracts (auction and lender vault) do not exist yet, so they cannot be in scope. If the audit is realistically requested at the end of T2 (month 3), 7–20 weeks puts the report at about month 4.6–7.7. That is often after T3 (month 5) and can break the 6-month cap. T3's verification list includes "audit report with fixes", so the 40% tranche depends on it. Fix: either (a) move the audit report out of T3's verifiable deliverables, as Lucent does by deferring the public launch until after the audit rather than gating the tranche on it, or (b) lengthen T3 and state the audit dependency, staying within 6 months. Also note that S7's own phase table gives different durations from the FAQ (audit 1–6 weeks, plus 1–4 weeks resolution and 2–3 weeks verification).
2. **Material: lifetime cap (§1 Size, §5 "Lifetime cap").** On the handbook home page [S5], the "$150,000 across all awards accumulated over its lifetime" and "$300,000 case-by-case" sentences sit under **"Previously Funded Projects"**, defined as projects funded before SCF #41. The page does not say this cap applies to a new project like Caravel. The $300K exception is only for projects that "have previously already received $150,000". Fix: call it "likely, not confirmed for new projects" and ask SCF. The "≈$15.7K left for a later Build award" conclusion is an inference, not a rule.
   - *Correction:* item 2 was partly wrong. The $150K total across Build awards is also stated in the general SCF 7.0 "What's New" section [S5], so it applies to Caravel; only the $300K ceiling is limited to pre-#41 projects.
3. Minor: the base rates do not reproduce [S23]. Scraping #41–#44 again finds **134** "Build Awarded" entries (34/26/28/46), median **$101.5K**, mean **$103.7K**. The doc says 132, $100K and $103.6K. The conclusion (round median ≈ $100K) still holds.
4. Minor: the timing estimate is contradicted by a source the doc already cites. S24 shows #45 results published on 23 Sep 2026, about 5.5 weeks after the 16 Aug deadline. At that pace #46 (deadline 8 Nov) awards around mid-December 2026, not late January 2027. This moves Month 0 and the float timing earlier. The doc tags it [E], but it should use the dated recap.
5. Minor: "EUR 323 contractor **median**" [S27]. The page gives €323/day as a benchmark with a €314–335 range and does not say median. Reword to "benchmark".
6. Minor: "C fits better if Spiko or Franklin say yes before 8 Nov" (§5). 8 Nov is the #46 submission deadline [S23] but has no tag. Add [S23].

**Omission (not counted as a fail):** S1 has an Integration Track exception: up to 1/3 of the budget, in T2/T3, may go to narrow validation user testing. That matters for Open question 3 (Open vs Integration). Under Integration, part of milestone 4's lender onboarding could become fundable.

**Fixes applied.** Items 1–6 above are fixed in place: the audit request moves to the end of T2 and the audit report leaves T3's deliverables (line 3.1 reworded, amounts unchanged; post-T3 remediation added to off-budget costs); the lifetime cap is restated as the general $150K total across Build awards [S5] (≈$15.7K left as the likely reading; the $300K ceiling is unconfirmed for Caravel); base rates are 134 / $101.5K / $103.7K; Month 0 is mid-December 2026 [S24]; EUR 323 is a benchmark; 8 Nov carries [S23]. Team names and roles updated per Misha. The Integration Track omission is not addressed here.
