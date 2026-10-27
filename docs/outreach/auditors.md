# Soroban audit firms (quote requests)

Status: draft only. Misha submits the forms and sends the emails himself. No form has been filled in.

## Shortlist (5) and public quote-request routes

All five are "Trusted audit partners" of SDF's Soroban Security Audit Bank ([stellar.org/grants-and-funding/soroban-audit-bank](https://stellar.org/grants-and-funding/soroban-audit-bank), read 2026-10-26). Each URL returned HTTP 200 on 2026-10-26.

| # | Firm | Route | Stellar/Soroban evidence | Opening line for the draft |
|---|---|---|---|---|
| 1 | **Veridise** (recommended first) | https://veridise.com/request-audit/ | Audited RedStone's Stellar connector ([Stellar docs](https://developers.stellar.org/docs/data/oracles/oracle-providers#redstone)) and OrbitCDP (Audit Bank page) | "You audited RedStone's Stellar connector, the feed we plan to read." |
| 2 | **Certora** | https://www.certora.com/signup?plan=audit ("Request an audit" on certora.com) | Aquarius AMM report (Audit Bank page) | "We'd value formal verification of our margin and payout math." |
| 3 | **Runtime Verification** | https://runtimeverification.com/contact ("Contact us" form) | TokenOps report (Audit Bank page) | "We'd value your design and spec review before the code audit." |
| 4 | **Zellic** | https://www.zellic.io/contact | Audited Pyth Pro's Stellar contracts ([Stellar docs](https://developers.stellar.org/docs/data/oracles/oracle-providers#pyth)) | "You audited Pyth's Stellar contracts; ours consumes an oracle too." |
| 5 | **OtterSec** | https://osec.io/contact/ | Audit Bank partner. No specific Soroban report checked | "You're an Audit Bank partner; we'd like a quote for a Soroban lending contract." |

Also on the Audit Bank list but not shortlisted: Halborn, Oak Security, Spearbit + Cantina.

**Audit Bank route:** SDF covers the initial audit for eligible SCF-funded projects; the project pays 5% upfront, refunded if critical, high and medium findings are fixed within 20 business days of the report. Questions go to sorobanaudits@stellar.org, requests from funded projects to communityfund@stellar.org (same page). I have not checked whether Caravel has an SCF award. If it does, ask SDF before paying a firm directly, because the same firms charge pre-negotiated rates there.

## The ask
A price range, earliest start, duration and fix-review terms for the scope below.

## Scope (from origin/main e370b9a, 2026-10-26)
- In scope: `contracts/repo/src`, about 2,636 non-blank, non-comment Rust lines in 11 non-test files (lib, margin, payout, inkind, autorepay, oracle, math, storage, types, events, errors), on soroban-sdk.
- Out of scope: `contracts/oracle` (testnet mock), `contracts/spiko-mock` (testnet token), and the off-chain keeper and app. A MultiFeed→SEP-40 adapter, if built (feed-probe.md), would be added.
- Supporting material: 241 tests (README), DECISIONS.md (41 locked decisions), docs/design-review.md, and the `test_attack_*` suites.

## What we offer
A frozen commit, full docs and tests, a named single point of contact, and a public report credit.

## Draft (≤150 words; put the firm's opening line from the table in [brackets])

Subject: Quote request: Soroban term-repo contract (~2.6k lines of Rust)

Hello [firm] team,

[Opening line from the table.]

Caravel is an open-source term-repo protocol on Stellar. Borrowers post tokenized money-market fund shares (BENJI, USTBL) and borrow USDC for a fixed term. Margin is checked against the daily NAV, and defaults are sold to issuer-approved liquidators.

We'd like a quote before a mainnet pilot:
- Scope: `contracts/repo`, about 2,600 non-test Rust lines (soroban-sdk). It covers a SEP-40 oracle client, SEP-41 transfers, a guardian with a timelock, a NAV sanity band and an in-kind outage fallback.
- Material: 241 tests, the locked design decisions and internal attack tests, all in the repo.
- Repo: github.com/rcusans-code/Caravel. We will freeze a commit for you.

Could you share a price range, earliest start date, expected duration and your fix-review terms?

<name>, Caravel
