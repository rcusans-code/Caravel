# Caravel audits

Two internal reviews of Caravel, published with what we did about every finding.

- **Stellar Raven audit**: ten areas, from contract security to the claims on the landing page, each run against the matching playbook from [Stellar Raven](https://raven.stellar.org), Stellar's public MCP server for builders.
- **NAV risk review**: one deep pass over everything that depends on the fund price (NAV), from the oracle to the app badge.

These are our own reviews, not a third-party audit. A third-party audit is still outstanding before mainnet (see [mainnet-readiness.md](../mainnet-readiness.md)).

## Scope and commits

| | Raven audit | NAV risk review |
|---|---|---|
| Code reviewed | [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) | [5faee32](https://github.com/rcusans-code/Caravel/tree/5faee32) (same code; only `DECISIONS.md` wording differs) |
| Covers | contracts (`contracts/repo`, `contracts/oracle`, `contracts/spiko-mock`), keepers (`scripts/keeper`, `scripts/nav-keeper.sh`), deploy scripts, web app (`app/`), landing page (`site/`), README, INTRO, pitch deck | price checks in the repo contract, the mock oracle, both keepers, the app's price display |
| Status checked against | main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054) | main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054) |
| Contract fixes live on testnet | since redeploy [2b5888d](https://github.com/rcusans-code/Caravel/commit/2b5888d) | since redeploy [b19f4f2](https://github.com/rcusans-code/Caravel/commit/b19f4f2) |

Line numbers in each file are at the reviewed commit.

## Method

1. **One lens per area.** Each Raven area took one Raven playbook (the stellar-dev-skill smart-contracts, assets, standards, dApp and data sections; the OpenZeppelin secure-contract and upgrade skills; the ecosystem scout and content-auditor playbooks) and walked its checklist against the code. Raven playbooks for features Caravel does not use (agentic payments, cross-chain, ZK, escrow) were skipped.
2. **Reproduce every finding.** Each finding comes with a Rust test, a TypeScript test, a script run or a live read-only testnet query at the reviewed commit, with the numbers it produced. Nothing was sent on mainnet, and audits made no commits.
3. **Independent QA.** A second pass re-ran every repro, re-opened every cited line and re-rated severity. It lowered 13 severities, raised 1, added 1 finding (Q-01) and found no finding wrong or already fixed. The severities in these files are the QA ones.
4. **Fix, QA, merge.** Fixes were grouped into batches (R1-R9), each built on its own branch, checked again by a separate QA pass against the original repros, and merged to main with the full test suite green (309 contract tests, 71 keeper tests, 62 app tests at ba3c054). Lower-priority findings went to the roadmap (R10-R15) and are listed under [Production notes](../../README.md#production-notes-raven-audit-roadmap) in the README.
5. **Verify before publishing.** Every "Fixed in" commit below is on main, and the regression test or changed line it names exists at ba3c054.

The NAV review worked the same way, but by risk "side": a scenario test showing the loss at the reviewed commit, a fix, QA with extra variants, then merge. One side failed QA (a variant broke the first fix) and was reworked before merging.

Severity scale: High = a plausible path to locked or lost funds, or a claim a judge would catch as false; Medium = a real failure under realistic conditions; Low = an edge case, a production-only issue or wrong copy; Info = documentation only.

Status: **Fixed in &lt;commit&gt;** (on main, with a named test or line) · **Partly fixed** (the part that matters now landed; the rest is roadmap or open, as stated) · **Roadmap** (planned; R10-R15) · **Won't fix** (with the reason) · **Open** (not on main yet).

## Areas

| Area | File | Findings | High | Medium | Low | Info | Fixed | Partly fixed | Roadmap | Won't fix | Open |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Soroban contract security | [contract-security.md](contract-security.md) | 7 | 0 | 1 | 5 | 1 | 4 | 1 | 2 | 0 | 0 |
| Upgradeability and admin-key model | [upgrade-admin.md](upgrade-admin.md) | 9 | 2 | 4 | 3 | 0 | 4 | 3 | 2 | 0 | 0 |
| Stellar assets, SAC and trustlines | [assets-sac.md](assets-sac.md) | 8 | 0 | 2 | 6 | 0 | 4 | 3 | 1 | 0 | 0 |
| OpenZeppelin secure-contract patterns | [openzeppelin-patterns.md](openzeppelin-patterns.md) | 8 | 1 | 1 | 5 | 1 | 5 | 1 | 1 | 1 | 0 |
| Soroban testing practice | [contract-testing.md](contract-testing.md) | 8 | 0 | 5 | 3 | 0 | 2 | 1 | 5 | 0 | 0 |
| SEP and CAP standards conformance | [standards-seps.md](standards-seps.md) | 7 | 0 | 0 | 6 | 1 | 4 | 0 | 2 | 1 | 0 |
| dApp, wallet and transaction UX | [dapp-wallet.md](dapp-wallet.md) | 10 | 0 | 5 | 5 | 0 | 6 | 0 | 4 | 0 | 0 |
| Chain data and RPC usage | [data-rpc.md](data-rpc.md) | 11 | 1 | 2 | 8 | 0 | 5 | 0 | 6 | 0 | 0 |
| Ecosystem prior art | [ecosystem-prior-art.md](ecosystem-prior-art.md) | 6 | 0 | 3 | 3 | 0 | 4 | 0 | 2 | 0 | 0 |
| Ecosystem claims in the landing page and docs | [content-claims.md](content-claims.md) | 15 | 1 | 5 | 9 | 0 | 14 | 1 | 0 | 0 | 0 |
| **Raven audit total** | | **89** | **5** | **28** | **53** | **3** | **52** | **10** | **25** | **2** | **0** |
| NAV risk review | [nav-risk-review.md](nav-risk-review.md) | 9 | 2 | 4 | 3 | 0 | 5 | 0 | 1 | 0 | 3 |

Four root causes show up in two or three areas and are counted in each (CS-02 = AS-02, CS-06 = OZ-03 = STD-03, OZ-01 = UA-01, OZ-02 = UA-02), so the Raven audit has 84 unique findings: High 4, Medium 26, Low 51, Info 3.

## The findings that mattered most

- **A guardian veto could lock collateral forever** (UA-02 = OZ-02, High). The guardian could switch seizure off and then cancel every proposal to switch it back on. Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843): the veto can be used once per proposal, a re-asserted pause no longer drops the clear, and the admin can replace the guardian behind the timelock.
- **The NAV keeper could hang silently** (D-02, High). A stalled Horizon call had no timeout; within 3 minutes every NAV-gated action stopped and no alert fired. Fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4) with request timeouts, a tick watchdog and "blind" alerts.
- **The feeder could flush the NAV band, and our own keeper laundered a bad price** (NAV-1, NAV-2, High). Fixed in [393b471](https://github.com/rcusans-code/Caravel/commit/393b471) (one feed record per time slot, no backdating) and [602ee42](https://github.com/rcusans-code/Caravel/commit/602ee42) (keepers never re-post a jump, and remember a hold across restarts).
- **The pitch read as if repo on Stellar were new** (H2, High). Ascend × M1X had announced an institutional repo on Stellar three days earlier. Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) and the deck in [31b9102](https://github.com/rcusans-code/Caravel/commit/31b9102): we now say how Caravel differs and never claim "first".
- **The live demo's privileged keys are public** (AS-01, UA-04, Medium). Accepted for the testnet demo and stated in the README risks, with a one-transaction rotation runbook; moving the keys out of git is roadmap R10.

## Still open

- NAV-6: the in-kind fallback does not open when the feed has no usable timestamp. Fix on branch `simon/nav-outage-no-timestamp`, not merged yet (needs a repo redeploy).
- NAV-7: the app's "Price on hold" badge does not know the band settle path (testnet gap under a minute). Fix on branch `simon/app-band-settle`, not merged yet.
- NAV-8: a staircase of sub-10% pushes by the feeder key passes the keeper guards (production bands refuse it on-chain). No fix scheduled.
- CT-03: the CI snapshot check landed, but `AGENTS.md` (the brief for coding agents) still says to leave test snapshots out of review diffs.

## Not covered

- No third-party audit, formal verification or static analyzer run (Scout, OpenZeppelin detectors); these are mainnet steps.
- No legal review of the issuer, custody or lending model.
- Testnet only: the mock oracle and the tSAFO mock token stand in for the real fund feed and the Spiko token.
