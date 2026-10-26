# Caravel mechanics: design review of draft v1

Date: 2026-10-25. Input: the first-principles draft v1 (it is not kept in the repo; each finding quotes the v1 text it attacks). Output: this file plus [mechanics.md](mechanics.md), which is v2 and applies every accepted finding, marking each change inline with its finding ID.

The review kept 48 findings from nine standpoints: **34 accepted, 12 merged, 1 rejected, 1 deferred**. Rejected and merged findings stay in full with their reasons, so nobody re-raises them and the final README and artifacts can cite what was attacked, what was kept and what was thrown away.

## 1. Standpoints

| # | Standpoint | Why chosen | What it attacked | Accepted | Merged | Rejected | Deferred |
|---|---|---|---|---|---|---|---|
| R | Repo desk risk manager | The design borrows repo vocabulary; a desk veteran knows which repo protections it skipped | Haircut vs discount, margin cushion, lender yield vs alternatives, grace, day count | 4 | 0 | 1 | 1 |
| X | DeFi exploit researcher | Someone will try to drain it; better us first | Oracle manipulation, borrower–liquidator collusion, races, trustline tricks, stuck states | 5 | 1 | 0 | 0 |
| N | Money-market-fund / NAV oracle specialist | The whole design keys off "daily NAV"; a fund accountant knows what NAV means for this fund | Stable-$1 NAV semantics, dividends as new tokens, staleness, feed interfaces | 5 | 1 | 0 | 0 |
| K | Integration / keeper operator | The demo is recorded Monday morning; timings and balances were checked for one run only | Demo balances, 60 s days, 180 s NAV clock, keeper races, reset | 5 | 1 | 0 | 0 |
| C | In-house counsel at the fund issuer | One issuer call (`set_authorized`) is the hinge of the project, and it is a legal question | Contract as shareholder, dividends, freeze/clawback precedence, liquidator transfers, EU scope | 4 | 2 | 0 | 0 |
| B | Borrower (market-maker treasury) | The user who signs; at $5M the small examples become cliffs | Late-repay cost, true carry, top-up amount, stuck Defaulted, no early rebate | 3 | 3 | 0 | 0 |
| L | Lender (OTC desk with idle USDC) | The party whose principal is at risk | Post-call risk, no liquidator shows up, admin key, idle escrow, fee without backstop | 2 | 4 | 0 | 0 |
| A | Soroban contract auditor | A design review before code is the cheapest audit | State machine gaps, status guards, storage TTL, rounding consistency | 4 | 0 | 0 | 0 |
| J | Hackathon judge | The README is half the score; the judge reads it without us | Claims the README copy cannot back, precision that hides the story | 2 | 0 | 0 | 0 |
| | **Total** | | | **34** | **12** | **1** | **1** |

### How the review was run

Nine standpoints were chosen for their power to break the design, not from a fixed checklist. Each standpoint was played by a separate AI critic that saw only the v1 draft and the repo (`DECISIONS.md`, `INTRO.md`, `TASKS.md`, `README.md`, `docs/`, `spikes/auth`). Seven critics ran in two independent batches; the contract-auditor and judge standpoints were run by the adjudicator. The adjudicator then gave every finding a verdict and recomputed every number that survived. The point of keeping rejected and merged findings is that the reason a thing was thrown away is often as useful as the thing that was kept.

Verdicts. `accepted` = v2 applies it (three carry a qualifier in their reason: F-21 and F-28 "with modification", F-22 "in part"). `merged` = the same point was raised by another standpoint; it is kept in full under the winning finding. `rejected` = wrong, or not worth the change. `deferred` = right, but it conflicts with a locked decision and is not worth reopening before the deadline.

Severity. Critical = breaks the demo or loses money by design. High = misleads judges or users, or is a real-money bug. Medium / Low = worth fixing, in that order.

Every finding quotes the v1 text it attacks, with the v1 section. "v2 applies" names the [mechanics.md](mechanics.md) section. "README" names the README section the fix feeds. "DECISIONS" names a row of [DECISIONS.md](../DECISIONS.md) the fix would change (blank = none). `O` numbers (O1, O12, ...) are open items in [mechanics.md §9](mechanics.md). `D#n` and "row n" both mean row n of DECISIONS.md. Citations inside quoted v1 text are left as written and are not linked.

## 2. Finding index

All 48 findings on one screen. Standpoint letters are the ones in the table above. The detail (v1 quote, scenario, severity, fix class, README and DECISIONS tags) sits under each ID below.

| ID | Standpoint | Finding | Verdict and reason | Applied in |
|---|---|---|---|---|
| [F-01](#f-01) | K | Interest under 60-second days needs a `year_secs` config, not a renamed term | **accepted**: Demo interest was 1/1440 of intended; a `year_secs` config fixes it with no renames. | mechanics.md §4.3, §7 |
| [F-02](#f-02) | K | The funded balances run the demo once; both repos must be 240 USDC and the reset script must sweep balances back | **accepted**: Funded balances fit one run of one repo; size both demo repos at 240 USDC and reset by transfer. | mechanics.md §6.7, §11 |
| [F-03](#f-03) | K | The beat-3 NAV drop hits the seeded repo too; liquidating at the dropped NAV shows Shortfall, not "paid in full" | **accepted**: Beat-3 NAV drop hits the seeded repo too; liquidating at 0.985 shows Shortfall, so restore NAV 1.00 first. | mechanics.md §11 |
| [F-04](#f-04) | K | The 180 s NAV clock bites at beats 2 and 6 unless the keeper re-posts the price | **accepted**: The 180 s NAV clock expires during narration; the keeper re-posts NAV every 60 s. | mechanics.md §11 |
| [F-05](#f-05) | K | A keeper that also calls `default` kills beats 4 and 5 after one fumbled wallet prompt | **accepted**: An auto-defaulting keeper kills the top-up beat; the keeper only calls `check_margin`. | mechanics.md §11 |
| [F-06](#f-06) | N | For a stable-$1 fund the margin-call loop models a non-event; say what it is for | **accepted**: Stable-$1 NAV never drifts; the margin call is a break-the-buck and feed-fault guard, so say so. | mechanics.md §1, §2 (A4), §3 step 3, §4.5 |
| [F-07](#f-07) | N | BENJI pays yield as new tokens to the holder of record, which during the term is the contract | **accepted**: BENJI dividends land on the contract as new tokens; state it now, pass-through on the roadmap. | mechanics.md §2 (A4), §4.7, §6.2, §8 inv. 10, §12, §13 |
| [F-08](#f-08) | X | Whoever writes the price can drain the lender in three permissionless calls; the admin key also picks the liquidators | **accepted**: Price writer and whitelist admin are one key; name it a trust assumption, typed NAV bounds later. | mechanics.md §4.14, §12, §13 |
| [F-09](#f-09) | B | The borrower must sign a top-up with no on-chain number saying how much cures | **accepted**: The borrower needs the exact cure amount; store `required_collateral` at call time, expose `required_top_up`. | mechanics.md §4.6, §5.2, §6.3 |
| [F-10](#f-10) | B | One ledger late past grace costs 2% of all collateral; the borrower needs a guaranteed late-repay path | **accepted**: One late ledger costs 2% of all collateral; allow `repay` in Defaulted until `liquidate` lands. | mechanics.md §4.9, §5.1, §5.2, §8 inv. 14 |
| [F-11](#f-11) | X | A borrower who is also a whitelisted liquidator has a free option against the lender | **accepted**: A borrower who is a liquidator has a free option; `liquidate` rejects the borrower, README states non-affiliation. | mechanics.md §4.10, §8 inv. 12, §12 |
| [F-12](#f-12) | A | A margin call has no exit through NAV recovery | **accepted**: A call had no exit on NAV recovery; `check_margin` clears it on a healthy fresh NAV. | mechanics.md §4.5, §5.1, §5.2 |
| [F-13](#f-13) | C | A contract address as shareholder of record is unprecedented for this fund; present it as the central assumption, not a deploy step | **accepted**: A contract as shareholder of record is the central assumption; state it, not as a deploy step. | mechanics.md §4.2, §12 |
| [F-14](#f-14) | C | Issuer freeze, clawback and de-authorization override every contract promise; invariant 6 must say so in its headline | **accepted**: Issuer freeze, clawback and de-authorization override every path; invariant 6 says so first. | mechanics.md §4.14, §8 inv. 6, §12 |
| [F-15](#f-15) | C | The strongest compliance argument is never stated, and the EU scope is not addressed | **accepted**: The strongest compliance point (lenders never hold shares; since qualified by the DECISIONS #38 NAV-outage in-kind claim) and the EU scope were unstated. | mechanics.md §1, §12 |
| [F-16](#f-16) | J | "Paid in full" and "24/7" cannot both survive next to the shortfall path and business-day redemption | **accepted**: "Paid in full" and "24/7" contradict the shortfall path and business-day exit; reword the copy. | mechanics.md §3 step 6, §12 |
| [F-17](#f-17) | N | "Swapping to Chainlink is config only" is false; the oracle asset key is also the wrong type | **accepted**: Chainlink is not SEP-40; "config only" holds for SEP-40 feeds, `oracle_asset` is the SEP-40 `Asset` enum. | mechanics.md §4.14, §7 |
| [F-18](#f-18) | N | `now − oracle_timestamp` measures the relayer, not the NAV's age | **accepted**: Staleness measures relayer liveness, not the fund's as-of date; say so. | mechanics.md §4.14, §13 |
| [F-19](#f-19) | N | A 3-day production staleness window fails on every US holiday Monday; the margin window must survive a weekend | **accepted**: A 3-day staleness limit fails on US holiday Mondays; production intent 5-day NAV age and 3-day window. | mechanics.md §4.6, §7, §9 O20 |
| [F-20](#f-20) | R | The margin call should fire in front of the shortfall line, not on it | **accepted**: The trigger sat on the shortfall line; add `margin_trigger_bps` (demo 250) in front of it. | mechanics.md §4.5, §4.11, §6.3, §7 |
| [F-21](#f-21) | R | The 2% liquidator discount is sized like a DEX bonus, not like three days of carry | **accepted**: 2% is about 190 days of fund carry; with modification: the demo keeps 2%, production intent 50-100 bps. | mechanics.md §4.10, §4.11, §7 |
| [F-22](#f-22) | X | An open offer is a free option with no expiry | **accepted**: An open offer is a free option; in part: `expires_at` added, `min_nav` deferred to the band bound in F-08. | mechanics.md §4.1, §5.2, §7 |
| [F-23](#f-23) | R | The lender's own numbers say "lend elsewhere" unless the README names the lender's real alternative | **accepted**: The lender nets less than a variable pool; the README names the alternative and what the gap buys. | mechanics.md §6.2, §12 |
| [F-24](#f-24) | J | Seven-decimal numbers in "How it works" hide the story | **accepted**: Seven-decimal numbers hide the story; README text rounds to cents, the spec stays exact. | mechanics.md §3 |
| [F-25](#f-25) | C | The liquidator sale is a secondary transfer of fund shares for value; the issuer, not the admin, decides who may receive them | **accepted**: The liquidator sale is a secondary share transfer; the issuer has a veto and `add_liquidator` checks `authorized()`. | mechanics.md §4.10, §12 |
| [F-26](#f-26) | X | The lender can lock the borrower's collateral by removing its own USDC trustline | **accepted**: A lender removing its USDC trustline locks the borrower; `try_` transfer plus claimable balance, after submission. | mechanics.md §4.7, §5.2, §9 O16, §13 |
| [F-27](#f-27) | X | Defaulted has no exit if no liquidator shows up | **accepted**: Defaulted has no exit if no liquidator acts; name the risk, lender `claim_in_kind` on the roadmap. | mechanics.md §4.10, §8 inv. 14, §13 |
| [F-28](#f-28) | L | The fee goes to a treasury while the insurance fund is on the cut list | **accepted**: The fee has no backstop; with modification: label the fee address "reserve", demo fee illustrative. | mechanics.md §4.12, §7 |
| [F-29](#f-29) | L | The lender sees "5%" and is paid 4.50% | **accepted**: The lender sees 5% and is paid 4.50%; show the net rate. | mechanics.md §4.12 |
| [F-30](#f-30) | B | No early-repay rebate and no partial repay must be said in one sentence | **accepted**: No early-repay rebate and no partial repay; say it in one sentence. | mechanics.md §4.3, §13 |
| [F-31](#f-31) | R | Standard term-repo features are missing from the roadmap | **accepted**: Standard term-repo features are missing from the roadmap; list them. | mechanics.md §13 |
| [F-32](#f-32) | A | v1 rounds liquidation proceeds down in the examples and proposes rounding them up in O19 | **accepted**: Proceeds rounded down contradicted the rounding rule; round up, so §6.4-6.7 move one stroop. | mechanics.md §5.4, §6.4–6.7 |
| [F-33](#f-33) | A | Storage lifetime is not in the spec | **accepted**: Storage lifetime was not in the spec; every repo method extends its TTL. | mechanics.md §5.2 |
| [F-34](#f-34) | A | Every method must check status, including on terminal states | **accepted**: Methods must check status first; each wrong state reverts with a named error. | mechanics.md §5.2, §8 inv. 15 |
| [F-35](#f-35) | K | Balances survive exactly one run | **merged**: Same root cause as F-02: balances sized for one run of one repo. | see [F-02](#f-02) |
| [F-36](#f-36) | L | Every uncured call loses the lender money | **merged**: Same fix and numbers as F-20. | see [F-20](#f-20) |
| [F-37](#f-37) | C | Dividends land on the contract and have no owner | **merged**: Same fact as F-07; the tax-reporting angle is carried into its compliance text. | see [F-07](#f-07) |
| [F-38](#f-38) | B | True borrower cost ≈ 9% APR if dividends are not returned | **merged**: Same fact as F-07; the 9% APR figure is used there. | see [F-07](#f-07) |
| [F-39](#f-39) | N | "Max NAV move per print" is the wrong bound shape | **merged**: Refines F-08's fix: typed per-asset NAV bounds, not a max move per print. | see [F-08](#f-08) |
| [F-40](#f-40) | L | Admin prints 0.95 and a friendly liquidator takes 71 USDC | **merged**: Same attack as F-08 at a print of 0.95. | see [F-08](#f-08) |
| [F-41](#f-41) | C | One admin key sets price feed and liquidator list | **merged**: Same attack as F-08; the issuer-reputation angle and split keys are carried there. | see [F-08](#f-08) |
| [F-42](#f-42) | L | Listed USDC earns nothing, no expiry, cancel is on the cut list | **merged**: Same fix as F-22 (`expires_at`); keep the cancel button in the UI. | see [F-22](#f-22) |
| [F-43](#f-43) | X | Grace moves the keeper race to grace end; a liquidator can race a late repay | **merged**: F-10 removes the first race; `liq_delay_secs` is carried as the roadmap fix for the second. | see [F-10](#f-10) |
| [F-44](#f-44) | B | No borrower route out of a stuck Defaulted | **merged**: The borrower's route out is F-10; the no-liquidator case is F-27. | see [F-10](#f-10), [F-27](#f-27) |
| [F-45](#f-45) | B | A European desk cannot take a repo for most of a day after a US holiday | **merged**: Same fix as F-19; 5 days chosen over 4 for slack. | see [F-19](#f-19) |
| [F-46](#f-46) | L | If the liquidator does not act, principal is stuck with no self-help | **merged**: Identical fix to F-27 (lender as liquidator of last resort). | see [F-27](#f-27) |
| [F-47](#f-47) | R | Use ACT/360, the USD money-market convention | **rejected**: Correct, but every number in INTRO, the deck and the tests is on 365; ACT/360 stays one config value away. | mechanics.md §9 (O6), §7 (`year_secs`) |
| [F-48](#f-48) | R | Grace is a free one-day extension; interest should accrue through it | **deferred**: Correct, but it contradicts row 15 and needs a second interest formula before the deadline. | mechanics.md §4.8, §12, §13 |

## 3. Fix order before Mon 26 Oct 12:00

Demo blockers (contract math or runbook):
1. F-01 `year_secs` config so interest is not 1/1440 of intended in the demo.
2. F-02 Size both demo repos at 240 USDC; reset script sweeps balances back.
3. F-03 Demo NAV preset 0.985; set NAV back to 1.00 right before `liquidate`.
4. F-04 Keeper re-posts NAV every 60 s so the 180 s staleness clock never bites on camera.
5. F-05 Keeper calls `check_margin` only; `default` is a human button.

Small contract changes (one field or one check each):
6. F-09 Store `required_collateral` at call time; expose `required_top_up`.
7. F-10 `repay` allowed in Defaulted until `liquidate` lands.
8. F-11 `liquidate` reverts if the liquidator is the borrower.
9. F-12 `check_margin` clears a call when a fresh NAV shows the repo healthy.
10. F-22 `expires_at` on offers.

README wording (no code):
11. F-06 Say what a margin call means for a stable-$1 fund.
12. F-07 Say that BENJI dividends land on the contract and v1 does not pass them through.
13. F-16 Drop "paid in full" and "24/7" from the copy.
14. F-13, F-14, F-15, F-25 Compliance assumptions and the freeze/clawback precedence.
15. F-08, F-17, F-18 Trust assumptions: admin key, Chainlink needs an adapter, staleness is feed liveness.
16. F-23, F-24, F-28, F-29, F-30 Lender comparison, rounded numbers, fee framing, net APR, no early rebate.

Team decisions (section 7): F-20 maintenance trigger, F-21 production discount, F-01, F-17, F-02.

## 4. Accepted findings, ranked

<a id="f-01"></a>

### F-01. Interest under 60-second days needs a `year_secs` config, not a renamed term
- Standpoint: K (keeper operator). Resolves v1 open item O5 with a better default.
- v1 quote (§9 O5): "*Default:* interest uses `term_days / 365`; time checks use `term_days × day_secs`."
- Scenario: with `term_secs = 420` and a real year in seconds, a 480 USDC repo earns 480 × 500 × 420 / (10,000 × 31,536,000) = 0.0003196 USDC. The fee is 319 stroops; the waterfall beat is invisible. Renaming `term_secs` to `term_days` breaks the config names locked in DECISIONS row 5 and the per-offer term question.
- Severity: Critical (demo). Fix: CONTRACT, before submission.
- Verdict: accepted. Reason: recomputed: with `year_secs = 365 × 60 = 21,900` the demo gives 480 × 500 × 420 / (10,000 × 21,900) = 0.4602740 USDC, identical to the v1 figure; production sets 31,536,000. One config field, no renames.
- v2 applies: §4.3, §7. README: Contract spec, parameters. DECISIONS: row 5 (add `year_secs`).

<a id="f-02"></a>

### F-02. The funded balances run the demo once; both repos must be 240 USDC and the reset script must sweep balances back
- Standpoint: K. Merges F-35 (K1). Resolves O8.
- v1 quote (§6.7): "surplus liquidation at NAV 1.00 costs the liquidator 485.4134727 ≤ 500 ✓"
- Scenario: the lender holds 500 USDC. A seeded second repo at 480 USDC escrows 480, leaving 20; the on-camera `create_offer(480)` reverts. After one liquidation at P = 480 the liquidator has 14.59 USDC and the borrower 504.68 tBENJI; the second rehearsal fails at the seed step. The plan is two rehearsals plus a take and a backup (four runs).
- Severity: Critical (demo). Fix: PARAM + DOC, before submission.
- Verdict: accepted. Reason: recomputed at P = 240 for both repos: interest 0.2301370, debt 240.2301370, collateral 247.6599351 tBENJI; two repos escrow 480 ≤ 500 USDC and post 495.32 ≤ 1,000 tBENJI (504.68 spare for top-up); a liquidation at NAV 1.00 costs 242.7067364 ≤ 500. Balances still drift per run, so the reset script must do plain token transfers back (liquidator tBENJI → borrower; USDC back to 500 / 100 / 500) rather than redeploy; if it redeploys it must re-run the issuer's `set_authorized` on the new contract.
- v2 applies: §6.7, §11. README: Run it. DECISIONS: none.

<a id="f-03"></a>

### F-03. The beat-3 NAV drop hits the seeded repo too; liquidating at the dropped NAV shows Shortfall, not "paid in full"
- Standpoint: K.
- v1 quote (§4.5): "A keeper calls it every 10 s (TASKS.md:41). That is harmless, because only a new NAV print can change the outcome (A1)."
- Scenario: NAV 0.99 does not fire a call (v1 §6.3; threshold 0.98980). At 0.985 both open repos are margin-called within 10 s. If NAV stays at 0.985 until beat 6, liquidating the 240 USDC repo pays 247.6599351 × 0.985 × 0.98 = 239.0661354 < lender terms 240.2071233: a `Shortfall` on camera in the beat that is supposed to show the lender made whole. Paid in full needs NAV ≥ 240.2071233 / 242.7067364 = 0.9897.
- Severity: Critical (demo). Fix: DOC (runbook), before submission.
- Verdict: accepted. Reason: recomputed, both numbers hold. With F-20 (trigger at 2.5%) the call fires at NAV < 0.99487, so 0.985 still works as the slider preset.
- v2 applies: §11. README: Run it. DECISIONS: none.

<a id="f-04"></a>

### F-04. The 180 s NAV clock bites at beats 2 and 6 unless the keeper re-posts the price
- Standpoint: K.
- v1 quote (§4.14): "A NAV is stale when `now − oracle_timestamp > max_nav_age_secs` (demo 180 s = 3 days; D#5). Stale NAV blocks `take_offer`, `liquidate` (D#6) and `check_margin` (D#17)."
- Scenario: seed sets NAV at T; recording starts at T + 4 min; beat 2 `take_offer` reverts with StaleNav. Beat 3 sets NAV at T + 6 min; beat 6 `liquidate` at T + 10 min reverts.
- Severity: High (demo). Fix: PARAM/DOC, before submission.
- Verdict: accepted. Reason: 180 s is three demo days by design; the fix is a keeper `--heartbeat` that re-posts the current price every 60 s, plus a runbook `set_price` right before beats 2 and 6. Note this is exactly the behaviour F-18 criticises in production (a fresh timestamp on an old number); acceptable for a mock, said so in v2.
- v2 applies: §11. README: Run it. DECISIONS: none.

<a id="f-05"></a>

### F-05. A keeper that also calls `default` kills beats 4 and 5 after one fumbled wallet prompt
- Standpoint: K.
- v1 quote (§4.9): "Anyone may call `default` (D#7) when (a) `now > maturity + grace` (no NAV needed, D#17) or (b) the repo is in MarginCall and `now > margin_call_deadline`"
- Scenario: detect ≤ 10 s, transaction ≈ 5 s, UI poll and narration ≈ 20 s, wallet signing ≈ 10 s, ledger close ≈ 5 s: 50–60 s of a 120 s window. One RPC retry or a rehearsal pause and an auto-defaulting keeper moves the repo to Defaulted; `top_up` is then impossible and the take restarts.
- Severity: High (demo). Fix: DOC (runbook), before submission.
- Verdict: accepted. Reason: nothing in the design needs the keeper to default; permissionless `default` is for production keepers. Runbook rule: keeper calls `check_margin` only; `default` is pressed by a human in beat 5; never pause while a repo is in MarginCall.
- v2 applies: §11. README: Run it. DECISIONS: none.

<a id="f-06"></a>

### F-06. For a stable-$1 fund the margin-call loop models a non-event; say what it is for
- Standpoint: N (NAV specialist).
- v1 quote (§3 step 3): "If NAV falls more than ~1.02%, the repo goes into MarginCall and the borrower has a window (2 days; 120 s in the demo) to add collateral (D#14, D#5)."
- Scenario: FOBXX seeks a stable $1.00; its price is 1.0000 every day by construction. A −1% print is the fund "breaking the buck" (the one US government money fund that did, in 1994, paid about $0.96), after which the board suspends redemptions; the borrower cannot subscribe more shares in two days and the liquidator cannot redeem at NAV either. Accumulating funds (USTBL, USDY, USTRY) have a NAV that only rises; a fall is a feed error. A judge from fund land sees beat 3 as a demo of something that cannot happen.
- Severity: High. Fix: DOC, before submission.
- Verdict: accepted. Reason: correct on the facts (summary prospectus; BENJI pays yield as new tokens, so the price does not drift). The design still needs the check as a break-the-buck and feed-fault guard, and as the real margin mechanism for Tier 3 (FX) collateral. The README and the video must say that; the economic protections for Tier 1 are term, atomic settlement, haircut and issuer-approved liquidation.
- v2 applies: §1, §2 (A4), §3 step 3, §4.5. README: Insight, How it works, Risks and limits. DECISIONS: none (row 14 stays; its wording gains one sentence).

<a id="f-07"></a>

### F-07. BENJI pays yield as new tokens to the holder of record, which during the term is the contract
- Standpoint: N. Merges F-37 (C2) and F-38 (B2).
- v1 quote (§6.2): "Carry check (D#10): borrower pays 0.9589 interest; the collateral at the 3.87% T-bill yield (collateral-research.md:58) earns ≈ 1,031.92 × 3.87% × 7/365 = 0.7659. Negative carry ≈ 0.19 USDC for a passive holder"
- Scenario: each business day the fund declares a dividend and new BENJI tokens land in the holder's wallet. Over 7 days ≈ 0.7659 tBENJI arrive at the contract address. `repay` returns exactly the 1,031.9163961 posted; the new tokens belong to nobody in the contract's accounting (invariant 10 breaks upward), or go to the liquidator with "all collateral". The borrower's true cost is 0.9589 + 0.7659 = 1.7248 USDC per 1,000 per 7 days ≈ 9.0% APR, not 5%. On a 30-day $5M repo that is ≈ $16,400 of unowned tokens. INTRO's promise "keep earning bond interest" is the reason to use a repo instead of selling.
- Severity: High. Fix: DOC now, CONTRACT on roadmap. Before submission.
- Verdict: accepted. Reason: verified (Franklin: "Each business day the fund declares a dividend, and new BENJI tokens equal to that dividend land in each holder's wallet"); arithmetic recomputed. Whether the transfer agent airdrops to a contract address at all is unknown (no contract holds BENJI today): stated as needs checking. v2 states that the demo tBENJI pays no dividends, that real dividends belong to the borrower, and that v1 does not pass them through; roadmap: return `C + (contract balance − ΣC) × C/ΣC` at close.
- v2 applies: §2 (A4), §4.7, §6.2, §8 inv. 10, §12, §13. README: How it works, Risks and limits. DECISIONS: row 10 (carry slide numbers).

<a id="f-08"></a>

### F-08. Whoever writes the price can drain the lender in three permissionless calls; the admin key also picks the liquidators
- Standpoint: X (exploit researcher). Merges F-39 (N6), F-40 (L3), F-41 (C5). Extends O21.
- v1 quote (§4.10): "A fixed price at NAV makes the lender's recovery deterministic, and it removes DEX price manipulation (A1)."
- Scenario: print NAV 0.90 with a fresh timestamp. Anyone calls `check_margin` → MarginCall; after the window anyone calls `default`; a colluding whitelisted liquidator pays 1,031.9163961 × 0.90 × 0.98 = 910.1502613 USDC for shares worth 1,031.92 at the real $1.00 (+121.77). The lender receives 910.15, a loss of 90.71 against terms. The demo shows an admin slider doing step one, and the same admin key sets the oracle address and the whitelist.
- Severity: Critical in production, trust assumption on testnet. Fix: DOC before submission; CONTRACT (per-asset NAV bounds) after.
- Verdict: accepted. Reason: recomputed. On testnet this is a stated trust assumption, not a bug; the README must name it as one: oracle admin and liquidator whitelist are one key, target is split keys and a timelock. Bound shape (from F-39): a "max move per print" bound is wrong for this asset; for a stable fund accept only a band (0.995–1.005), and treat a print below the band as "disable new takes", not as a top-up request; for an accumulating fund reject any decrease. Status (Raven UA-08, 26 Oct 2026): the deploy script still uses one admin key for both the oracle and the whitelist; liquidator additions are timelocked since Raven R6 (DECISIONS #47); the feeder-key split is roadmap R10.
- v2 applies: §4.14, §12, §13. README: Risks and limits, Architecture. DECISIONS: none now (row 2 unchanged); risk register gains a row.

<a id="f-09"></a>

### F-09. The borrower must sign a top-up with no on-chain number saying how much cures
- Standpoint: B (borrower). Resolves O13.
- v1 quote (§6.3): "cure to the trigger line: ceil(D / (0.989 × 0.98)) − C = **0.8304563** tBENJI more (re-breaches on any further tick) [...] cure to the initial haircut: ceil(D / (0.989 × 0.97)) − C = **11.4773310** tBENJI more (O13 picks which)"
- Scenario: the two candidate targets differ 14×. A borrower sends 10 shares believing the trigger line applies; the contract uses the haircut line; the call stays open; the deadline passes; the borrower is defaulted and loses 2% of everything.
- Severity: High. Fix: CONTRACT (small), before submission.
- Verdict: accepted. Reason: recomputed (0.8304563 and 11.4773310 hold). Cure target = the initial haircut line (otherwise every further tick re-breaches and each cure buys a fresh window). Store `required_collateral = ceil(D / (NAV_call × (1 − h)))` at call time; `top_up` accepts any amount and cures when C ≥ required, with no NAV read, which keeps DECISIONS row 6; expose `required_top_up(repo)` as a read method and pre-fill it in the UI.
- v2 applies: §4.6, §5.2, §6.3. README: Contract spec, How it works. DECISIONS: none.

<a id="f-10"></a>

### F-10. One ledger late past grace costs 2% of all collateral; the borrower needs a guaranteed late-repay path
- Standpoint: B. Merges F-43 (X4) and part of F-44 (B4). Resolves O15.
- v1 quote (§4.8): "A single late block turns a solvent borrower into a defaulter and costs them 2% of the whole collateral (§6.5)."
- Scenario: P = 5,000,000: interest 4,794.5205480, debt 5,004,794.5205480, collateral 5,159,581.9799464 shares. The wire lands after grace; the liquidator pays 5,056,390.3403475; surplus 51,595.8197995; the borrower's cost is C − surplus − P = 107,986.16 USDC against 4,794.52 if on time, 22.5×.
- Severity: Critical for the borrower, High for the design. Fix: CONTRACT (small), before submission.
- Verdict: accepted. Reason: recomputed. `repay` at the same fixed `debt` stays allowed in Defaulted until `liquidate` lands: the lender then gets full terms instead of a discounted sale, so nobody is worse off. The exact-ledger race between `repay` and `liquidate` (F-43) remains; a `liq_delay_secs` after default is the roadmap fix. README and UI must state the cost of being late in plain words.
- v2 applies: §4.9, §5.1, §5.2, §8 inv. 14. README: How it works, Risks and limits. DECISIONS: none (adds to row 6's "borrower can always exit").

<a id="f-11"></a>

### F-11. A borrower who is also a whitelisted liquidator has a free option against the lender
- Standpoint: X.
- v1 quote (§6.5): "the borrower's cost of defaulting instead of repaying = C − surplus − P = 1,031.9163961 − 10.3191639 − 1,000 = 21.5972322, against 0.9589042 interest if they repaid"
- Scenario: at NAV 1.00 self-liquidation costs exactly the debt (pays 1,011.28, gets 10.32 back): defaulting is free. At NAV 0.985 (collateral still worth 1,016.44, an honest borrower repays) the self-liquidator pays 996.1088971; the lender takes it all and is short 4.754; the borrower keeps shares worth 1,016.44 and gains 4.85 over repaying. At 0.97 the gain is 20.02. The whitelist is a KYC list, not a non-affiliation list.
- Severity: High. Fix: CONTRACT (one check) + DOC, before submission.
- Verdict: accepted. Reason: recomputed. The one-line guard `liquidator != repo.borrower` stops the naive case; the real defence is that liquidators are a vetted set and the README says "assumed unaffiliated with borrowers". With F-20 the lender also has a cushion before the self-liquidation becomes profitable.
- v2 applies: §4.10, §8 inv. 12, §12. README: Risks and limits. DECISIONS: row 7 (one clause).

<a id="f-12"></a>

### F-12. A margin call has no exit through NAV recovery
- Standpoint: A (contract auditor).
- v1 quote (§4.6): "A cure clears the call (TASKS.md:38). A missed deadline lets anyone call `default` (docs/board.html:261)."
- Scenario: a glitch print at 0.985 fires a call; the next print is 1.00. With a stored cure target the only way out is to post 15.71 tBENJI the borrower does not owe; otherwise the repo defaults on a price that no longer exists.
- Severity: Medium. Fix: CONTRACT (small), before submission.
- Verdict: accepted. Reason: `check_margin` on a MarginCall repo with a fresh NAV that shows `debt ≤ C × NAV × (1 − trigger)` returns the repo to Open and clears the deadline. This is the "clears when healthy" in TASKS.md, made explicit; `top_up` keeps its no-NAV cure (F-09).
- v2 applies: §4.5, §5.1, §5.2. README: Contract spec. DECISIONS: none.

<a id="f-13"></a>

### F-13. A contract address as shareholder of record is unprecedented for this fund; present it as the central assumption, not a deploy step
- Standpoint: C (issuer counsel).
- v1 quote (§4.2): "Before launch the issuer must call `set_authorized(repo_contract, true)` on tBENJI (spikes/auth/README.md:15)."
- Scenario: the transfer agent keeps the register on Stellar; every entry is a shareholder with KYC, tax status and dividend reporting. The contract has no legal person, no tax ID and an admin key. Zero contracts hold BENJI today. Needs checking: prospectus shareholder eligibility; transfer-agent policy on contract-controlled accounts; whether Caravel's operating entity must be the registered holder.
- Severity: High (the critic said Critical; lowered because the testnet uses a team-issued token and the issue is disclosure, not a blocker). Fix: DOC, before submission.
- Verdict: accepted. Reason: it is the hinge of the project and the README must say so in one labelled sentence, with the Aave Horizon precedent, and never as a feature.
- v2 applies: §4.2, §12. README: Risks and limits, Stellar features used. DECISIONS: risk register (new row).

<a id="f-14"></a>

### F-14. Issuer freeze, clawback and de-authorization override every contract promise; invariant 6 must say so in its headline
- Standpoint: C. Extends O16.
- v1 quote (§9 O16): "*Default:* `repay` settles debt into contract-held claimable balances; lender and borrower `claim` separately."
- Scenario: the borrower's trustline is de-authorized mid-term (sanctions). The issuer's correct outcome is that the shares stay frozen wherever they are. Invariant 6 "Borrower can always exit" and the claimable-balance idea read as an attempt to deliver shares around a freeze. Needs checking: whether a claimable balance of an AUTH_REQUIRED asset can be claimed by an unauthorized trustline (likely not) and whether clawback reaches it (likely yes).
- Severity: High for the issuer relationship. Fix: DOC, before submission.
- Verdict: accepted. Reason: compatible with F-26, which concerns the lender's USDC leg (no issuer involved), not the fund shares. v2 rewrites invariant 6 with the caveat first, and states that the contract never routes around issuer action and that lenders bear collateral-freeze risk.
- v2 applies: §4.14, §8 inv. 6, §12. README: Risks and limits. DECISIONS: row 6 ("why" gains the caveat).

<a id="f-15"></a>

### F-15. The strongest compliance argument is never stated, and the EU scope is not addressed
- Standpoint: C.
- v1 quote (§1): "Caravel uses the model money markets already use for this asset: a **fixed-term repo**."
- Scenario: lenders receive only USDC in every path, so lenders need no issuer approval; that is what makes an open lender side possible (the Aave Horizon pattern), and it is unstated. Separately, the team is in Lisbon: tokenized fund shares are financial instruments, outside MiCA; USDC is an e-money token under MiCA; FOBXX is a US-registered fund (needs checking: whether non-US persons may hold BENJI; whether the Luxembourg class gBENJI is the EU-relevant share; whether matching USDC loans against fund shares needs a licence, with CMVM).
- Severity: Medium. Fix: DOC, before submission.
- Verdict: accepted. Reason: the first half is a free pitch point; the second half is three sentences under "Regulatory scope" that pre-empt a judge's question.
- v2 applies: §1, §12. README: Insight, Risks and limits. DECISIONS: none.

<a id="f-16"></a>

### F-16. "Paid in full" and "24/7" cannot both survive next to the shortfall path and business-day redemption
- Standpoint: J (judge).
- v1 quote (§2 A2): "**Business-day redemption, approved holders only.** BENJI redeems \"only during normal business hours on business days\"."
- Scenario: the intro copy says "The lender is paid in full from that" and closes with "Repo, like banks do it, but 24/7, atomic and open", while the draft's own §4.13 defines a shortfall path and §2 says exit is business-day only. A judge who reads both marks the pitch as overclaiming.
- Severity: High. Fix: DOC, before submission.
- Verdict: accepted. Reason: the draft is right and the copy is wrong. Say "the lender is paid first; a shortfall is possible and is emitted on-chain", and "atomic, on-chain and open" without "24/7" (the contract runs 24/7; the collateral does not).
- v2 applies: §3 step 6, §12. README: How it works, Risks and limits. DECISIONS: row 4 (README wording).

<a id="f-17"></a>

### F-17. "Swapping to Chainlink is config only" is false; the oracle asset key is also the wrong type
- Standpoint: N.
- v1 quote (§4.14): "The oracle is strict SEP-40 (`lastprice` returns price and timestamp), and swapping to RedStone or Chainlink is config only (D#2; TASKS.md:29)."
- Scenario: the repo's own gap analysis lists Chainlink on Stellar as "own interface (not SEP-40)"; a judge on the Composed track checks the swap guide and finds no `lastprice`. RedStone's fundamental feeds are keyed by symbol (SEP-40 `Asset::Other(symbol)`, e.g. `BENJI_FUNDAMENTAL/USD`), so an `oracle_asset` of type address cannot point at them (needs checking against the live feed's `assets()`).
- Severity: High. Fix: DOC, before submission; CONTRACT type change is trivial if done before the oracle client is written.
- Verdict: accepted. Reason: internally consistent with the repo's research and cheap to fix. Wording: "SEP-40 feeds (Reflector, RedStone) are config-only; Chainlink needs a thin SEP-40 adapter." `oracle_asset` is the SEP-40 `Asset` enum (Stellar address or symbol); read `decimals()` on every call.
- v2 applies: §4.14, §7. README: Stellar features used, oracle swap guide. DECISIONS: row 2 (wording).

<a id="f-18"></a>

### F-18. `now − oracle_timestamp` measures the relayer, not the NAV's age
- Standpoint: N.
- v1 quote (§4.14): "A NAV is stale when `now − oracle_timestamp > max_nav_age_secs` (demo 180 s = 3 days; D#5)."
- Scenario: push feeds update on deviation or heartbeat; a $1.00 fund never deviates, so every update is a heartbeat re-push of the same number with a new timestamp. If the fund stops publishing on Thursday, the relayer keeps pushing Wednesday's 1.0000 with Friday's timestamp and `take_offer` sees a "fresh" NAV for as long as the relayer runs. The BENJI_FUNDAMENTAL/USD SEP-40 feed page shows no cadence or decimals yet.
- Severity: Medium. Fix: DOC, before submission.
- Verdict: accepted. Reason: true of any push feed and worth one honest sentence: the rule is a feed-liveness guard; the fund's as-of date is not checked. Roadmap: require a strictly newer record per repo or a feed that carries the as-of date.
- v2 applies: §4.14, §13. README: Risks and limits. DECISIONS: none.

<a id="f-19"></a>

### F-19. A 3-day production staleness window fails on every US holiday Monday; the margin window must survive a weekend
- Standpoint: N. Merges F-45 (B5). Extends O20.
- v1 quote (§7): "`max_nav_age_secs` | global | 180 | 3 days = 259,200 (long weekends, O20)"
- Scenario: Friday 4 pm ET print → Monday holiday → next print Tuesday 4 pm ET = 96 h = 345,600 s > 259,200 s. From Monday 4 pm to Tuesday ≈ 4:30 pm `take_offer`, `check_margin` and `liquidate` all revert (about six times a year). A 2-day margin window opened on the Friday print expires Sunday with no new print to cure against. A Lisbon desk sees `take_offer` fail until 22:00 local on the Tuesday.
- Severity: Medium. Fix: PARAM (production intent column), before submission.
- Verdict: accepted. Reason: recomputed (96 h). Production intent: `max_nav_age_secs` = 5 days (432,000), `margin_window_secs` = 3 days (259,200). Demo values unchanged. Roadmap: window counted in NAV prints newer than the call.
- v2 applies: §4.6, §7, §9 O20. README: Contract spec, parameters. DECISIONS: row 5 (production intent only).

<a id="f-20"></a>

### F-20. The margin call should fire in front of the shortfall line, not on it
- Standpoint: R (repo desk). Merges F-36 (L1). Extends O12; rejects O12's "keep and state it" default.
- v1 quote (§4.5): "The trigger is *the shortfall line itself*, not a cushion in front of it. Any NAV fall after the call, through the margin window and liquidation latency, is lender loss"
- Scenario: call at 0.989; window 2 days plus a day of latency; liquidation at 0.985 pays 1,031.9163961 × 0.985 × 0.98 = 996.1088971, lender short 4.7541167 USDC, 5.5× the 0.863 it earns on the whole repo. With a separate maintenance trigger of 2.5% the call fires at NAV < 0.97/0.975 = 0.994872 (a 0.51% fall); a liquidation at that NAV pays 1,006.1205501, leaving 5.2575363 USDC of cushion before the lender is touched.
- Severity: High. Fix: CONTRACT (one config field); team decision because it changes DECISIONS row 14.
- Verdict: accepted. Reason: recomputed. Row 14's own "why" (avoid a call on the first tick after a max-LTV take) still holds with 2.5% < 3%. For a stable-$1 fund the extra calls cost nothing. v2 applies it as the default and lists it as decision 1.
- v2 applies: §4.5, §4.11, §6.3, §7. README: How it works, Contract spec. DECISIONS: row 14 (add `margin_trigger_bps`); row 13 (`AssetConfig` gains the field).

<a id="f-21"></a>

### F-21. The 2% liquidator discount is sized like a DEX bonus, not like three days of carry
- Standpoint: R.
- v1 quote (§4.10): "The discount pays the liquidator for carrying the share until redemption. A Dutch auction is on the cut list (TASKS.md:79)."
- Scenario: carry on 1,031.92 shares at 3.87% is 0.109 USDC a day; worst case Friday seizure to Monday redemption is 0.33 USDC. The liquidator is paid 20.64, 189 days of fund yield and 24× the lender's whole-term interest, on an asset it redeems at $1.00 with no price risk. At d = 0.5% the lender's buffer becomes 1 − 0.97/0.995 = 2.51% instead of 1.02%, at no cost to the lender, and a healthy-default borrower loses 5.16 instead of 20.64.
- Severity: High (economics), none for the demo. Fix: PARAM (production intent column); team decision.
- Verdict: accepted with modification. Reason: recomputed. The demo keeps 2% (DECISIONS row 4, and the liquidator beat must be visible on camera); the parameter table gains a production intent of 50–100 bps with this arithmetic, and the README says the demo discount is deliberately generous. The discount must also cover freeze risk and the liquidator's capital, so 50 bps is a floor, not a recommendation.
- v2 applies: §4.10, §4.11, §7. README: Contract spec, parameters, Risks and limits. DECISIONS: row 4 (production wording only).

<a id="f-22"></a>

### F-22. An open offer is a free option with no expiry
- Standpoint: X. Merges F-42 (L4). Resolves O22.
- v1 quote (§4.1): "The lender has committed in advance, so no lender action is needed at take time. That is what makes an order-book repo possible with one lender and one borrower"
- Scenario: a 3-day untaken offer forgoes 1,000 × 6.69% × 3/365 = 0.55 USDC at the alternative, 64% of the 0.863 the repo nets. An offer forgotten for three weeks is taken at a stale rate. In the half hour between a bad print and its correction a borrower takes every open offer at the old NAV: collateral 1,031.92 shares worth 1,000.96, liquidation value 980.94, each lender short 19.92 at settlement with no call ever fired.
- Severity: Medium. Fix: CONTRACT (one field + one check), before submission; `min_nav` on roadmap.
- Verdict: accepted in part. Reason: `expires_at` on `create_offer` (UI default 24 h) and `cancel_offer` kept in the UI. The `min_nav` idea is deferred: for a stable-$1 fund NAV at take is 1.00 by construction, and F-08's band bound covers the bad-print case better.
- v2 applies: §4.1, §5.2, §7. README: Contract spec. DECISIONS: none.

<a id="f-23"></a>

### F-23. The lender's own numbers say "lend elsewhere" unless the README names the lender's real alternative
- Standpoint: R.
- v1 quote (§6.2): "lender gets P + I − fee = **1,000.8630138** → net 4.50% APR (0.8630138 / 1,000 × 365/7). That is the 5% offer less the 10% fee share, and never more than the offer terms (D#3)."
- Scenario: 7 days on 1,000 USDC: Caravel lender 0.863; a Blend USDC supplier 1,000 × 6.69% × 7/365 = 1.283; T-bills 0.742. DECISIONS row 10 says the borrower's USDC "earns more than the repo costs", so the pitch's own numbers have the borrower earning 1.28 while the lender takes single-name risk for 0.86.
- Severity: Medium. Fix: DOC, before submission.
- Verdict: accepted. Reason: recomputed. The demo APR stays 5% (it is in the intro example). The README says what the lender gets for 2.2% less than a variable-rate pool: fixed term, fixed rate, T-bill collateral, a borrower who is by construction an issuer-approved shareholder, and a product that permissioned corporate cash (which cannot sit in a pool) can use: T-bill 3.87% → 4.50% net is +63 bps.
- v2 applies: §6.2, §12. README: Risks and limits (negative carry row). DECISIONS: row 10 (slide numbers).

<a id="f-24"></a>

### F-24. Seven-decimal numbers in "How it works" hide the story
- Standpoint: J.
- v1 quote (§3 step 2): "In one transaction the contract pulls 1,031.9163961 tBENJI from the borrower and pays out 1,000 USDC. Debt is fixed at 1,000.9589042 USDC (D#15)."
- Scenario: a judge reading the README sees stroop precision in the narrative and skims; the spec section is where precision belongs.
- Severity: Medium. Fix: DOC, before submission.
- Verdict: accepted. Reason: §3 is README copy; §6 is the test oracle. v2 rounds §3 to cents and keeps §6 exact.
- v2 applies: §3. README: How it works. DECISIONS: none.

<a id="f-25"></a>

### F-25. The liquidator sale is a secondary transfer of fund shares for value; the issuer, not the admin, decides who may receive them
- Standpoint: C. Extends O24.
- v1 quote (§4.10): "The liquidator therefore has to be an approved redeemer; this is not a demo shortcut."
- Scenario: a liquidator whose business is buying shares below NAV and redeeming at NAV is a distressed-buyer market in the fund's own shares. Needs checking: whether the fund's transfer policy allows peer-to-peer transfers for value at non-NAV prices; whether the fund treats the Caravel whitelist as subject to its approval; AML on the liquidator's USDC.
- Severity: Medium. Fix: DOC, before submission.
- Verdict: accepted. Reason: O24 covers only the technical list divergence; the issuer's veto is the real rule. v2: "liquidators are issuer-approved shareholders; the issuer has a veto over the whitelist; transfers at NAV − d are peer-to-peer transfers the issuer has permitted (needs issuer confirmation)"; `add_liquidator` checks `authorized()` at add time.
- v2 applies: §4.10, §12. README: Risks and limits. DECISIONS: row 7 (one clause).

<a id="f-26"></a>

### F-26. The lender can lock the borrower's collateral by removing its own USDC trustline
- Standpoint: X. Extends O16.
- v1 quote (§8 inv. 6): "**Borrower can always exit.** `repay` and `top_up` never read the oracle and never fail on staleness (D#6). Caveat: an issuer freeze can still block them (O16, O17)."
- Scenario: the lender escrows 1,000 USDC, moves its other USDC out and removes the USDC trustline (allowed at zero balance). `repay` pushes 1,000.863 USDC to the lender → the token transfer fails → the whole call reverts. The borrower cannot repay and is defaulted; `liquidate` also pushes to the lender and reverts. 1,031.92 tBENJI sit locked and the lender offers to re-add the trustline for an off-chain payment. No issuer involved.
- Severity: High in production. Fix: CONTRACT, after submission (hardening gate at the earliest).
- Verdict: accepted. Reason: valid without any issuer action, so it is a protocol bug, not an issuer risk. Fix: the lender leg uses a `try_` transfer; on failure the amount is credited to an in-contract claimable balance the lender can `claim()` later. Borrower and liquidator legs stay push. This is USDC, so F-14's "never route around the issuer" does not apply.
- v2 applies: §4.7, §5.2, §9 O16, §13. README: Risks and limits. DECISIONS: none.

<a id="f-27"></a>

### F-27. Defaulted has no exit if no liquidator shows up
- Standpoint: X. Merges F-46 (L2) and part of F-44 (B4). Extends O18.
- v1 quote (§5.1): "Terminal states: Cancelled, Repaid, Liquidated. Defaulted is not terminal. It can sit there while NAV is stale (O15, O20)."
- Scenario: on testnet the liquidator holds 500 USDC and a 1,000 USDC repo needs 1,011.28. In production a whole-collateral sale needs a liquidator willing to front 0.98 × C for every default at once; on a stress day with 50 defaults nobody has the USDC. The lender earns nothing and recovers nothing, and cannot take the shares itself even if issuer-approved; the borrower's surplus is stuck too.
- Severity: Medium (High for the lender). Fix: ROADMAP; README sentence before submission.
- Verdict: accepted. Reason: invariant 14 silently assumes a funded, willing liquidator. v2 says so and adds the roadmap: after `liquidator_timeout_secs` in Defaulted an issuer-authorized lender may `claim_in_kind` (collateral up to debt at NAV, remainder in kind to the borrower), and a debt-sized sale instead of whole-collateral.
- v2 applies: §4.10, §8 inv. 14, §13. README: Risks and limits. DECISIONS: risk register gains a row.

<a id="f-28"></a>

### F-28. The fee goes to a treasury while the insurance fund is on the cut list
- Standpoint: L (lender).
- v1 quote (§4.13): "The insurance fund itself is on the cut list (TASKS.md:81)."
- Scenario: fee per repo 0.0958904 USDC; one 3% event costs the lender 19.92; it would take 208 fee-paying repos to cover a single event, and the fee is not earmarked.
- Severity: Low. Fix: DOC/PARAM, before submission.
- Verdict: accepted with modification. Reason: recomputed (207.7). The business plan already sets launch fee to 0 for 3–6 months. v2: the demo fee is illustrative; the fee address is labelled "reserve" in the README with the insurance-fund roadmap; no contract change.
- v2 applies: §4.12, §7. README: Risks and limits. DECISIONS: row 3 (wording only).

<a id="f-29"></a>

### F-29. The lender sees "5%" and is paid 4.50%
- Standpoint: L.
- v1 quote (§6.2): "lender gets P + I − fee = **1,000.8630138** → net 4.50% APR"
- Scenario: a lender compares net rates; nothing on the offer screen shows the net.
- Severity: Low. Fix: DOC (UI copy), before submission.
- Verdict: accepted. Reason: one line in the offer form and in "How it works".
- v2 applies: §4.12. README: How it works. DECISIONS: none.

<a id="f-30"></a>

### F-30. No early-repay rebate and no partial repay must be said in one sentence
- Standpoint: B.
- v1 quote (§4.3): "Early repayment pays the same amount; nothing is pro-rata (D#15)."
- Scenario: a 30-day repo whose need ends on day 3 pays 30 days of interest; auto-roll is cut, so the borrower cannot extend either.
- Severity: Low. Fix: DOC, before submission.
- Verdict: accepted. Reason: it is the locked decision; users must be told to pick the shortest term that covers the need. Roadmap: lender-optional minimum term with pro-rata after it.
- v2 applies: §4.3, §13. README: How it works. DECISIONS: none.

<a id="f-31"></a>

### F-31. Standard term-repo features are missing from the roadmap
- Standpoint: R.
- v1 quote (§4.3): "`debt = principal + interest`, fixed at `take_offer`. Early repayment pays the same amount; nothing is pro-rata (D#15)."
- Scenario: a borrower who needs 200 shares back on day 4 must repay all 1,000.96 and re-borrow; a lender facing an issuer freeze on day 2 has no termination right.
- Severity: Low. Fix: ROADMAP.
- Verdict: accepted. Reason: free to list; shows the team knows the product. Substitution, partial unwind, roll, lender termination on an issuer event.
- v2 applies: §13. README: roadmap. DECISIONS: none.

<a id="f-32"></a>

### F-32. v1 rounds liquidation proceeds down in the examples and proposes rounding them up in O19
- Standpoint: A.
- v1 quote (§5.4): "This draft rounds the fee down (the lender keeps the extra stroop) and the proceeds down."
- Scenario: O19's default says "liquidation proceeds up (the liquidator pays the extra stroop)". Invariant 13 says rounding never favours the liquidator over the lender; rounding proceeds down does, by a stroop.
- Severity: Low. Fix: DOC, before submission.
- Verdict: accepted. Reason: pick one. v2 rounds proceeds up everywhere and recomputes §6.4–6.7 (each changes by one stroop).
- v2 applies: §5.4, §6.4–6.7. README: Contract spec. DECISIONS: row 8 (extends the rounding list).

<a id="f-33"></a>

### F-33. Storage lifetime is not in the spec
- Standpoint: A.
- v1 quote (§5.2): "| `repay(repo)` | borrower (O23) | Open / MarginCall → Repaid, until maturity + grace | no |"
- Scenario: offers and repos live in persistent storage with a time-to-live; a 30-day repo whose entry is archived mid-term cannot be repaid until someone restores it. The hardening task already lists TTL bumps.
- Severity: Low. Fix: CONTRACT, before submission (already planned).
- Verdict: accepted. Reason: one line in the spec: every method that touches a repo extends its TTL. Exact ledger numbers: needs checking against current testnet settings.
- v2 applies: §5.2. README: Contract spec. DECISIONS: none.

<a id="f-34"></a>

### F-34. Every method must check status, including on terminal states
- Standpoint: A.
- v1 quote (§5.2): "| `top_up(repo, amount)` | borrower (O23) | Open / MarginCall → (cure) Open |"
- Scenario: `top_up` on a Defaulted repo, `default` twice, `cancel_offer` on a taken offer, `liquidate` on Open: each must revert with a named error. v1 lists the happy transitions only.
- Severity: Low. Fix: CONTRACT, before submission.
- Verdict: accepted. Reason: it is the double-take guard generalised; one invariant line.
- v2 applies: §5.2, §8 inv. 15. README: Contract spec. DECISIONS: none.

## 5. Merged findings (kept in full)

<a id="f-35"></a>

### F-35. Balances survive exactly one run → merged into F-02
- Standpoint: K. v1 quote (§6.7): "surplus liquidation at NAV 1.00 costs the liquidator 485.4134727 ≤ 500 ✓"
- Scenario: at P = 480 each run the liquidator pays 485.41 USDC and the borrower loses 495.32 tBENJI; after run 1 the liquidator has 14.59 USDC and the borrower 504.68 tBENJI, so run 2 fails. Severity: Critical (demo).
- Reason for merge: same root cause as F-02 (balances sized for one run of one repo); F-02 carries both the sizing and the reset-script fix.

<a id="f-36"></a>

### F-36. Every uncured call loses the lender money → merged into F-20
- Standpoint: L. v1 quote (§4.5): "The trigger is *the shortfall line itself*, not a cushion in front of it."
- Scenario: call at 0.989, liquidated at the same NAV: 1,000.1540095 vs terms 1,000.8630138 → −0.709; each further 0.1% fall costs ≈ 1.01 USDC; at 0.984 short 5.77; a 3% event costs 19.92 = 23 weeks of net interest. Proposed `margin_trigger_bps` = 250. Severity: Critical (lender).
- Reason for merge: identical fix and numbers to F-20 (recomputed: 1.0113 per 0.1%, 5.7654 at 0.984). F-20 is primary because it also argues why O12's default was wrong.

<a id="f-37"></a>

### F-37. Dividends land on the contract and have no owner → merged into F-07
- Standpoint: C. v1 quote (§8 inv. 10): "The contract's collateral balance = Σ C over Open, MarginCall and Defaulted repos."
- Scenario: ≈ 0.77 USD of new shares per 7 days per 1,031.92 shares arrive at the contract and belong to nobody; on a 30-day $5M repo ≈ $16,400; the issuer asks who the beneficial owner is for tax reporting. Severity: High.
- Reason for merge: same fact as F-07; the tax-reporting angle is carried into F-07's compliance text.

<a id="f-38"></a>

### F-38. True borrower cost ≈ 9% APR if dividends are not returned → merged into F-07
- Standpoint: B. v1 quote (§6.2): "Negative carry ≈ 0.19 USDC for a passive holder, which is why the target user is active."
- Scenario: cost = 0.9589 + 0.7659 = 1.7248 per 1,000 per 7 days ≈ 9.0% APR. Severity: High.
- Reason for merge: same fact as F-07; recomputed (8.99%) and used in F-07's text.

<a id="f-39"></a>

### F-39. "Max NAV move per print" is the wrong bound shape → merged into F-08
- Standpoint: N. v1 quote (§9 O21): "*Default:* demo as is; README names the oracle admin as a trust assumption, with \"per-asset max NAV move per print\" on the roadmap."
- Scenario: with a 0.5%/print bound a faulty feed prints 0.995, 0.990, 0.985, 0.980 over four days, each passes, and a liquidation at 0.98 × 0.98 pays 991.06 for shares worth 1,031.92; meanwhile a genuine 0.96 break-the-buck print is rejected and the contract keeps taking offers at 1.00. Severity: Medium.
- Reason for merge: it refines F-08's fix (typed per-asset bounds: band for stable funds, no-decrease for accumulating funds); kept as the bound design in F-08.

<a id="f-40"></a>

### F-40. Admin prints 0.95 and a friendly liquidator takes 71 USDC → merged into F-08
- Standpoint: L. v1 quote (§9 O21): "The mock oracle's admin `set_price` (TASKS.md:29) can set any price and force margin calls or cheap liquidations."
- Scenario: at 0.95 the liquidator pays 960.7141647; the lender is short 40.1488491 against terms; the liquidator gains 71.2022314 at the real 1.00. Severity: High.
- Reason for merge: same attack as F-08 at a different price (recomputed, holds); the point that oracle and whitelist are one key is carried into F-08.

<a id="f-41"></a>

### F-41. One admin key sets price feed and liquidator list → merged into F-08
- Standpoint: C. v1 quote (§5.2): "`init` / `set_asset_config` / liquidator whitelist / oracle / params | admin | — | no | —"
- Scenario: the admin swaps the oracle to a feed it controls, prints 0.90, margin-calls every repo and its own liquidator buys at 0.882 per share; from the issuer's seat its shares move on a manipulated price through a contract it approved. Severity: High.
- Reason for merge: same attack as F-08; the issuer-reputation angle and the split-keys deploy step are carried into F-08.

<a id="f-42"></a>

### F-42. Listed USDC earns nothing, no expiry, cancel is on the cut list → merged into F-22
- Standpoint: L. v1 quote (§4.1): "`create_offer` requires the lender's auth and moves the full principal into the contract. [...] Silent on: offer expiry (O22)"
- Scenario: 3 days untaken = 0.55 USDC forgone (64% of the repo's net); taken 3 weeks later at a stale 5%; `cancel_offer` cut from the UI. Severity: Medium.
- Reason for merge: same fix as F-22 (`expires_at`); the "keep cancel in the UI" point is carried into F-22.

<a id="f-43"></a>

### F-43. Grace moves the keeper race to grace end; a liquidator can race a late repay → merged into F-10
- Standpoint: X. v1 quote (§4.8): "Grace also keeps a keeper from racing the borrower at maturity + 1 second."
- Scenario: `repay` and `default` land in the same ledger at grace end in an order the borrower does not control; without F-10 a healthy borrower loses 20.64. With F-10 a liquidator can still race `repay` in the exact ledger after default. Proposed `liq_delay_secs` after default. Severity: Medium.
- Reason for merge: F-10 removes the first race; the `liq_delay_secs` idea is carried into F-10 as the roadmap fix for the second.

<a id="f-44"></a>

### F-44. No borrower route out of a stuck Defaulted → merged into F-10 and F-27
- Standpoint: B. v1 quote (§5.1): "Terminal states: Cancelled, Repaid, Liquidated. Defaulted is not terminal."
- Scenario: a $5M repo defaults by a day; the single liquidator needs 5,056,390 USDC and is offline; 5,159,582 shares and a 51,595.82 surplus are stuck. Severity: High.
- Reason for merge: the borrower's route out is F-10 (repay in Defaulted); the no-liquidator case is F-27.

<a id="f-45"></a>

### F-45. A European desk cannot take a repo for most of a day after a US holiday → merged into F-19
- Standpoint: B. v1 quote (§7): "`max_nav_age_secs` | global | 180 | 3 days = 259,200 (long weekends, O20)"
- Scenario: Friday print ≈ 22:00 Lisbon; after a US Monday holiday, Tuesday 09:00 Lisbon is 83 h later; `take_offer` reverts until ≈ 22:00. Proposed 4 days; UI should show NAV age. Severity: Medium.
- Reason for merge: same fix as F-19; F-19 chose 5 days because 4 days (96 h) is exactly the Friday-to-Tuesday gap with no slack. The UI point (show NAV timestamp and whether take is allowed) is carried into v2 §11.

<a id="f-46"></a>

### F-46. If the liquidator does not act, principal is stuck with no self-help → merged into F-27
- Standpoint: L. v1 quote (§4.10): "`liquidate` is for whitelisted liquidators only (D#7) and needs a fresh NAV (D#6)."
- Scenario: one script account that needs 1,011.28 USDC, out of funds or offline; the lender cannot take the 1,031.92 shares even if issuer-approved. Proposed lender as liquidator of last resort after a timeout. Severity: High.
- Reason for merge: identical to F-27's fix; F-27 is primary because it also covers the stress-day capital problem.

## 6. Rejected and deferred findings (kept in full)

<a id="f-47"></a>

### F-47. Use ACT/360, the USD money-market convention → rejected
- Standpoint: R. v1 quote (§9 O6): "**O6. Day count.** 365 or 360 (USD money-market convention)? Silent (INTRO.md:19; DECISIONS.md:21). *Default:* 365 (used here)."
- Scenario: 1,000 × 5% × 7/360 = 0.9722 vs 0.9589 on 365: 0.0133 USDC per repo, 1.39% of interest; a TradFi judge checking a quote finds it off. Severity: Low.
- Verdict: rejected. Reason: recomputed and correct, but the intro example says "5% a year" and every number in INTRO, the deck and the tests is on 365; switching costs an hour of re-verification for 1.4% of interest and confuses the calendar-year intuition the README leans on. Stays an open item (O6) with 365 as the demo default and ACT/360 as a production option one config value away (`year_secs` from F-01 makes it a parameter).

<a id="f-48"></a>

### F-48. Grace is a free one-day extension; interest should accrue through it → deferred
- Standpoint: R. v1 quote (§4.8): "`default` for non-payment can't run before `maturity + grace_secs` (demo 60 s = 1 day; D#5). It needs no NAV (D#17)."
- Scenario: debt is the same on day 7 and day 8, so a rational borrower always pays on day 8: a "7-day 5%" repo is an 8-day 4.375% repo and the lender nets 3.94% ≈ T-bill. With F-10 the free extension runs until a liquidator acts. Severity: Medium.
- Verdict: deferred. Reason: recomputed and correct, but it contradicts DECISIONS row 15 (debt fixed at take, one number for everyone) and the fix (accrual through grace or a late fee) is a second interest formula and a second test set the night before the deadline. v2 states in plain words that grace is a free day and that the term should be read as "term + 1 day"; roadmap: `late_fee_bps` per grace day. Reopen after the hackathon.

## 7. Findings that need a DECISIONS.md change

Nothing here edits [DECISIONS.md](../DECISIONS.md). Each item is a proposal for the team chat, because locked rows change only after the team agrees ([DECISIONS.md:3](../DECISIONS.md#L3)). Every proposal carries the default that [mechanics.md](mechanics.md) already assumes, so the document stays consistent either way. Rows 18-22 landed on main after the draft was written; section 7.2 says where they meet v2.

### 7.1 The five team decisions

| # | Row | Proposal | Default (applied in mechanics.md) | If refused | Findings |
|---|---|---|---|---|---|
| 1 | 14 (and 13) | Add `margin_trigger_bps` to `AssetConfig`, set between the liquidation discount and the haircut. Row 14's trigger becomes `debt > collateral × NAV × (1 − margin_trigger_bps)`. | Yes. Demo 250 bps: the call fires at NAV < 0.99487 and leaves about 5.26 USDC of cushion per 1,000 before the lender loses anything. | The README says post-call NAV risk is 100% the lender's. | [F-20](#f-20), merges [F-36](#f-36) |
| 2 | 4 | Name a production discount intent; the demo keeps 2%. | 50-100 bps, with the carry arithmetic (a Friday-to-Monday hold costs 0.33 USDC against 20.64 paid to the liquidator). Row 4's text is unchanged. | Keep 2% and say it is deliberately generous. | [F-21](#f-21) |
| 3 | 5 | Add `year_secs` beside `term_secs`. | Demo 21,900 (365 × 60 s), production 31,536,000. ACT/360 later is one value. | Demo interest is 1/1440 of intended (0.0003196 against 0.4602740 USDC on 480 USDC). | [F-01](#f-01) |
| 4 | 2 | Reword to "SEP-40 feeds (Reflector, RedStone) are config-only; Chainlink needs a thin adapter". | Yes. Row 22 already makes `oracle_asset` a SEP-40 `Asset`, so only the wording is left. | A Composed-track judge checks the Chainlink interface and finds the claim false. | [F-17](#f-17) |
| 5 | none (demo plan in TASKS.md / DEVS.md) | Demo sizing. | Both demo repos at 240 USDC with a transfer-only reset script. The README's worked example stays at 1,000 USDC. | Top up the test accounts to run the 1,000 USDC example. | [F-02](#f-02) |

### 7.2 Where v2 meets rows 18-22

| Row | Meets | Proposal | Default |
|---|---|---|---|
| 18 | [F-20](#f-20) | Row 18 requires `liquidation_discount_bps < haircut_bps` so a max-LTV take opens below the trigger. With decision 1 the chain becomes `liquidation_discount_bps < margin_trigger_bps < haircut_bps < 10_000`, checked in `set_asset`. | Follow decision 1. Demo: 200 < 250 < 300. |
| 19 | O11 in [mechanics.md §9](mechanics.md) | Row 19 snapshots `haircut_bps` on the repo at take. Snapshot the other terms the same way: `margin_trigger_bps`, `liq_discount_bps`, `margin_window_secs`, `grace_secs`, `fee_bps`. | Yes. Admin changes never move a live repo. |
| 20 | [F-09](#f-09), [F-12](#f-12) | Row 20 clears a call once `ltv_ok(debt, collateral, nav, haircut_bps)` holds. That needs a NAV read inside `top_up`, while row 6 says a stale NAV never blocks `top_up`. F-09 keeps row 20's target (initial margin) but fixes it when the call fires: store `required_collateral = ceil(debt / (NAV_call × (1 − haircut)))`, let `top_up` cure once collateral reaches it with no NAV read, and expose `required_top_up(repo)` as the exact amount (row 20 shows it for info only). F-12 adds that `check_margin` clears a called repo when a fresh NAV is healthy again. | F-09 and F-12. This is the one place where v2 and a locked row differ in behaviour, so it needs a chat yes before `top_up` is coded (G2 in [TASKS.md](../TASKS.md)). |
| 21 | none | Consistent. The contract computes the collateral; F-09's stored value uses the same function. | No change. |
| 22 | [F-17](#f-17) | Consistent. `oracle_asset` is already the SEP-40 `Asset`. The new `margin_trigger_bps` (and `liq_discount_bps`, if O10's per-asset default is taken) fit row 22's instance storage as two more `AssetConfig` fields. | No change beyond the new fields. |
| Open item | v2 §4.2 | `take_offer` on an offer whose asset was disabled after `create_offer`. | Reject, as row 22 does for `create_offer`. Live repos are unaffected. |

### 7.3 Wording and additive changes

These extend a row without reversing it. They still go through team chat as wording changes.

| Row | Change | Findings |
|---|---|---|
| 3 | The fee address is labelled "reserve" in the README. The demo fee of 10% is illustrative; the launch fee is 0%. | [F-28](#f-28) |
| 4 | README wording: "the lender is paid first", never "paid in full"; no "24/7" claim. | [F-16](#f-16) |
| 5 | Production intent beside the demo values: `max_nav_age_secs` 5 days, `margin_window_secs` 3 days. | [F-19](#f-19) |
| 6 | "Why" gains the issuer-action caveat: freeze, clawback and de-authorization override every path. `repay` is also allowed in Defaulted until `liquidate` lands. | [F-14](#f-14), [F-10](#f-10) |
| 7 | `liquidate` reverts when the liquidator is the borrower. `add_liquidator` checks the asset's `authorized()` at add time. | [F-11](#f-11), [F-25](#f-25) |
| 8 | Rounding list: liquidation proceeds up, fee down, shortfall amount up. | [F-32](#f-32) |
| 10 | The carry slide uses the dividend-corrected numbers: borrower cost about 9.0% APR if dividends are not passed back; lender 4.50% net against a 6.69% pool and 3.87% T-bills. | [F-07](#f-07), [F-23](#f-23) |

Spec-only additions that touch no row: `expires_at` on offers ([F-22](#f-22)), status guards and TTL bumps ([F-33](#f-33), [F-34](#f-34)), the `try_` lender transfer with a claimable balance ([F-26](#f-26), after submission). Rows 1, 9, 15, 16 and 17 stay as they are. Row 15 is where [F-48](#f-48) was deferred.

### 7.4 Rows 3 and 4 disagree in a narrow band (O2, O3)

Row 4 gives the lender all proceeds whenever proceeds < debt. Between P + I − fee and debt (0.0958904 USDC wide at P = 1,000) that pays the lender more than row 3 allows. Proposed default: the shortfall condition becomes proceeds < P + I − fee, the fee takes what is left up to the fee, the borrower takes the rest, and `Shortfall.amount` is P + I − fee minus the lender's payout. `waterfall()` in [math.rs](../contracts/repo/src/math.rs) already works this way, so only the wording of row 4 lags. [mechanics.md §6.6](mechanics.md) keeps row 4 as locked and shows both amounts (20.0191780 against debt, 19.9232876 against offer terms).

### 7.5 Risk register: three proposed rows

| Risk | Sev | Mitigation / fallback | Owner | Check by |
|---|---|---|---|---|
| Issuer must authorize a contract address as holder of record ([F-13](#f-13)) | High | State it in the README as the central assumption, with the Aave Horizon precedent; the testnet uses a team-issued tBENJI; ask the issuer | P | Mon 06:00 |
| Oracle admin and liquidator whitelist are one key ([F-08](#f-08)) | High in production, stated assumption on testnet | README names it; on testnet one admin key holds both (Raven UA-08); whitelist additions timelocked since Raven R6 (DECISIONS #47); NAV band and settle time (#31, #41); feeder-key split and multisig on the roadmap (R10) | I | Mon 06:00 |
| No liquidator shows up, so a defaulted repo waits ([F-27](#f-27)) | Med | README names it and lists the liquidator count; lender `claim_in_kind` and a debt-sized sale on the roadmap | C / P | Mon 06:00 |

Owner letters follow TASKS.md. Severity, owner and check-by are proposals.

## 8. What each doc feeds in the README

Both docs are source material, not README text. README copy is cut from the [mechanics.md](mechanics.md) sections named below. This file gives the reason behind each choice and the objections a judge may raise. The finding lists are generated from the "README:" tag on each accepted finding.

| README section | Fed by mechanics.md | Fed by design-review.md |
|---|---|---|
| Insight | §1 (the fixed-term repo argument), §2 (four asset facts) | [F-06](#f-06), [F-15](#f-15) |
| How it works | §3 (six steps, rounded to cents), §4.3, §4.12, §6.1-6.2 | [F-06](#f-06), [F-07](#f-07), [F-09](#f-09), [F-10](#f-10), [F-16](#f-16), [F-20](#f-20), [F-24](#f-24), [F-29](#f-29), [F-30](#f-30), plus [F-48](#f-48) (grace is a free day) |
| Architecture | §4.2 (atomic DvP), §4.14 (oracle and who writes the price) | [F-08](#f-08) |
| Contract spec | §5 (states, methods, events, rounding), §7 (parameters), §8 (invariants), §9 (open items) | [F-01](#f-01), [F-09](#f-09), [F-12](#f-12), [F-19](#f-19), [F-20](#f-20), [F-21](#f-21), [F-22](#f-22), [F-32](#f-32), [F-33](#f-33), [F-34](#f-34) |
| Stellar features used | §4.2 (issuer authorization), §4.14 (SEP-40) | [F-13](#f-13), [F-17](#f-17) |
| Run it | §6.7 (demo-sized variant), §11 (demo runbook) | [F-02](#f-02), [F-03](#f-03), [F-04](#f-04), [F-05](#f-05) |
| Risks and limits | §12 (trust assumptions and compliance), §6.4-6.6 (cushion, default, shortfall), §6.2 (carry), §13 (roadmap) | [F-06](#f-06), [F-07](#f-07), [F-08](#f-08), [F-10](#f-10), [F-11](#f-11), [F-13](#f-13), [F-14](#f-14), [F-15](#f-15), [F-16](#f-16), [F-18](#f-18), [F-21](#f-21), [F-23](#f-23), [F-25](#f-25), [F-26](#f-26), [F-27](#f-27), [F-28](#f-28), plus [F-31](#f-31) (roadmap) |
| Built during HackMeridian | none | The whole file: one sentence and a link as evidence of an adversarial review (nine standpoints, 48 findings) |

Problem, Testnet deployment and Team draw on neither doc.

## 9. Numbers recomputed by the adjudicator

Exact rational arithmetic in stroops, interest rounded up, collateral rounded up, proceeds rounded up (F-32). Scenario text inside the findings attacks v1, which rounded proceeds down, so a few scenario figures (F-08, F-11, F-20, F-40) sit one stroop off this table.

| Item | Value |
|---|---|
| P = 1,000: interest / debt / collateral / fee / lender terms | 0.9589042 / 1,000.9589042 / 1,031.9163961 / 0.0958904 / 1,000.8630138 |
| Trigger NAV at 2.5% maintenance / at 2% discount | 0.9948718 (−0.51%) / 0.9897959 (−1.02%) |
| Liquidation at 0.9949 (just under the 2.5% trigger) | proceeds 1,006.1205501; cushion over terms 5.2575363 |
| Liquidation at 0.985 (uncured call) | proceeds 996.1088972; lender short 4.7541166 |
| Liquidation at 1.00 | proceeds 1,011.2780682; surplus 10.3191640; liquidator spread 20.6383279; borrower's cost of defaulting 21.5972321 |
| Liquidation at 0.97 | proceeds 980.9397262; short 19.9232876 vs terms, 20.0191780 vs debt, 19.0602738 vs principal |
| Self-liquidation gain at 0.985 / 0.97 (F-11) | 4.8500070 / 20.0191780 |
| Oracle print 0.90 (F-08) | proceeds 910.1502614; lender loss 90.7127524; liquidator gain 121.7661347 |
| Dividends over 7 days on 1,031.92 shares at 3.87% (F-07) | 0.7658799; borrower cost incl. lost yield 1.7248 ≈ 8.99% APR |
| 7-day alternatives on 1,000 USDC (F-23) | Blend 1.2830137; T-bill 0.7421918; Caravel net 0.8630138 |
| P = 240 (F-02): interest / debt / collateral / lender terms | 0.2301370 / 240.2301370 / 247.6599351 / 240.2071233 |
| P = 240 liquidation at 1.00 / 0.985 / 0.97 | 242.7067364 (surplus 2.4765994) / 239.0661354 (short 1.1409879) / 235.4255344 (short 4.7815889) |
| P = 240 cure to haircut line at 0.985 | 3.7714711 tBENJI |
| P = 5,000,000 late by a day (F-10) | cost 107,986.1601469 vs interest 4,794.5205480 |
| Friday 4 pm → Tuesday 4 pm (F-19) | 96 h = 345,600 s > 259,200 s |
| Interest at P = 480 with real-year seconds / with `year_secs` = 21,900 (F-01) | 0.0003196 / 0.4602740 |
