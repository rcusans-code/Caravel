# Soroban contract security audit

Commit audited: [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) (26 Oct 2026). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the audited commit.

Scope: the repo contract (`contracts/repo/src/*.rs`, non-test) and the mock oracle (`contracts/oracle/src/lib.rs`). The method was the Stellar Raven (https://raven.stellar.org) smart-contracts playbook from the [stellar-dev-skill](https://github.com/stellar/stellar-dev-skill): `security.md` (vulnerability classes, the contract checklist, the token-consumer review) and `SKILL.md` (platform constraints, before mainnet). Each finding was reproduced with a Rust unit test at the audited commit (5 tests in a scratch module; the full suite stayed green), and the live contracts and issuer flags were read on testnet without sending anything. An independent QA pass re-ran every repro, re-checked every cited line and re-rated severity.

Bottom line after QA: the contract core holds. Auth on every privileged and fund-moving call, single initialization, checked arithmetic, typed storage keys, state written before every token call, and bounded loops all pass. The one Medium is the shared pool on clawback-enabled collateral (the same root cause as AS-02). The auto-repay allowance bug, the USDC decimals check and the missing liquidator event are fixed on main and live on testnet since the redeploy in [2b5888d](https://github.com/rcusans-code/Caravel/commit/2b5888d); the clawback fix is partly in place (alert and docs), with the contract change on the roadmap.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| CS-01 | Low | A refunded auto-repay at default costs the borrower's other repo its allowance | Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae) |
| CS-02 | Medium | Clawback on pooled collateral lands on the last repo to settle | Partly fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4) and [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) |
| CS-03 | Low | Two colluding addresses can fill `max_open_debt` for the protocol fee only | Roadmap (R12 Production profile and contract roadmap) |
| CS-04 | Low | Auto-repay opt-in is accepted past the allowance horizon | Roadmap (R12 Production profile and contract roadmap) |
| CS-05 | Info | README said a live repo is never archived mid-term | Fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) |
| CS-06 | Low | `set_liquidator` and the oracle writes emit no event | Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843) |
| CS-07 | Low | USDC is assumed to have 7 decimals and never checked | Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae) |

Status counts: Fixed 4 · Partly fixed 1 · Roadmap 2 · Won't fix 0 · Open 0.

### CS-01: A refunded auto-repay at default costs the borrower's other repo its allowance

- Severity: Low (reported Medium; lowered on QA review)
- Status: Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae)
- Location: `contracts/repo/src/autorepay.rs:125-143`, `contracts/repo/src/lib.rs:709-716`, `contracts/repo/src/lib.rs:574-576`
- Finding: A borrower who opts two repos into auto-repay shares one USDC allowance between them. If `default` on repo A pulls the debt and then has to refund it (the collateral could not be returned, for example a frozen or closed trustline), the pull has already spent A's share, yet A is written as Defaulted with `auto_repay` still true. A later hand `repay` of A from Defaulted subtracts the debt from the allowance a second time. In the repro the allowance went 19,418,602,740 → 9,709,301,370 → 0, so repo B, due and opted in with 6,069 USDC in the wallet, could not auto-repay and defaulted. QA lowered it: only the borrower's own state can trigger it, B stays repayable by hand until a liquidation lands, and the loss is bounded by the 2% liquidation discount (about 21.60 USDC per 1,000).
- Fix: `try_settle` now returns `Settled`, `PullFailed` or `Refunded`. On `Refunded`, `default` sets `auto_repay = false` before writing Defaulted, so the later `repay` does not subtract the share again. Regression tests: `cs01_refunded_default_keeps_other_repos_allowance` (B auto-repays to Repaid) and `cs01_failed_pull_keeps_auto_repay` in `contracts/repo/src/test_raven_guards.rs`.

### CS-02: Clawback on pooled collateral lands on the last repo to settle

- Severity: Medium
- Status: Partly fixed in [98410f4](https://github.com/rcusans-code/Caravel/commit/98410f4) and [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3). The keeper alert and the README wording landed; clawback-safe accounting in the contract is roadmap R11. Same root cause as AS-02 in [assets-sac.md](assets-sac.md).
- Location: `contracts/repo/src/lib.rs:568-572`, `contracts/repo/src/lib.rs:787-791`, `contracts/repo/src/storage.rs` (no per-asset collateral total)
- Finding: Every repo of an asset is paid out of one pooled SAC balance, and the contract keeps no per-asset total to check it against. The live tBENJI issuer has `AUTH_CLAWBACK_ENABLED`, and a contract balance inherits that flag. In the repro the issuer clawed back one repo's worth (pool 20,019,178,084 → 10,009,589,042). The targeted borrower then repaid and got the full 10,009,589,042 back; the second borrower's `repay` reverted, and after default `liquidate` on that repo reverted too. The loss lands on whoever settles last, not on the target. The README said only that a clawback "stops repay and liquidation".
- Fix: Landed: each keeper tick compares the repo contract's balance of each collateral token with the sum of live repos' collateral and ALERTs `collateral short`, with a guardian runbook (`no_new_repos`) in `scripts/README.md`. The README "Issuer dependence" risk now says the first settlers are paid in full and the last repo can neither repay nor be liquidated. Roadmap ([R11](../../README.md#production-notes-raven-audit-roadmap)): a per-asset collateral total checked against `balance(this)` on every exit, blocking exits when short until the guardian writes the loss down.

### CS-03: Two colluding addresses can fill `max_open_debt` for the protocol fee only

- Severity: Low (root cause restated on QA review)
- Status: Roadmap (R12 Production profile and contract roadmap)
- Location: `contracts/repo/src/lib.rs:344-363`, `contracts/repo/src/lib.rs:467-472`
- Finding: A lender and a borrower acting together can recycle one principal to fill an asset's `max_open_debt`, so honest takes get `CapExceeded`. In the repro, two addresses filled a 2 × 970 USDC cap at 0% APR and unwound at zero cost. The report blamed the missing `apr_bps` floor; QA showed the root cause is different: at any APR the self-dealer pays only the protocol fee (a 5% APR probe cost exactly the fee), and the production fee is 0% at launch, so an APR floor alone prices nothing. It also needs collateral from an allowlisted holder, about 1.03 × the cap, returned on repay.
- Fix: Planned: a per-borrower share of `max_open_debt`, or a flat per-take fee. See [R12](../../README.md#production-notes-raven-audit-roadmap).

### CS-04: Auto-repay opt-in is accepted past the allowance horizon

- Severity: Low
- Status: Roadmap (R12 Production profile and contract roadmap)
- Location: `contracts/repo/src/autorepay.rs:85-99`, `contracts/repo/src/lib.rs:506-514`, `contracts/repo/src/lib.rs:607-613`
- Finding: The USDC allowance expiry is silently capped at the maximum entry TTL, but opting in is never refused. For a 365-day term the allowance expired at ledger 3,108,864 against a maturity ledger of 6,307,200, about 185 days short; the borrower shows as opted in, nothing can be pulled at maturity, and the repo defaults. It is reachable only for terms over about 180 days. Testnet uses minute-long terms, and the longest planned production term is 30 days, so it is latent.
- Fix: Planned: reject an opt-in when the allowance cannot reach the repo's maturity (a new error code appended), or document a maximum auto-repay term.

### CS-05: README said a live repo is never archived mid-term

- Severity: Info (reported Low; lowered on QA review)
- Status: Fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3)
- Location: `contracts/repo/src/storage.rs:26`, `contracts/repo/src/storage.rs:209-222`, `README.md:227`
- Finding: Repo entries get a 30-day TTL bump on every submitted touch (518,400 ledgers after a take), and simulated reads such as the keeper's `check_margin` do not persist a bump. An untouched 30-day production repo can therefore archive near maturity. QA found the impact is a restore fee, not a failure: since protocol 23, simulate and submit restore archived entries automatically, and both the keeper and the app take that path. What was wrong was the README claim "a live repo is never archived mid-term".
- Fix: The README "Storage TTL management" line now says reads do not extend the TTL, an untouched repo can archive after 30 days, and the next call restores it automatically for a fee.

### CS-06: `set_liquidator` and the oracle writes emit no event

- Severity: Low
- Status: Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843). Same root cause as OZ-03 in [openzeppelin-patterns.md](openzeppelin-patterns.md) and STD-03 in [standards-seps.md](standards-seps.md).
- Location: `contracts/repo/src/lib.rs:138-142`, `contracts/repo/src/storage.rs:235-243`, `contracts/oracle/src/lib.rs:155-175`
- Finding: Granting or revoking a liquidator, and the mock oracle's `set_price`, `set_price_at` and `set_admin`, publish nothing. Indexers, the app and lenders cannot see who may buy collateral or when the feed changed hands, and the liquidator list cannot be enumerated on-chain.
- Fix: The repo emits `LiquidatorSet { who, allowed }` on every grant (`execute_liquidator`) and revoke, plus `LiquidatorProposed` and `LiquidatorProposalCancelled`. The oracle emits `PriceSet` on every write and `AdminSet` on a handover. Regression tests: `oz03_liquidator_grant_and_revoke_emit_one_event_each` (repo) and `r6_admin_and_price_changes_emit_events` (oracle).

### CS-07: USDC is assumed to have 7 decimals and never checked

- Severity: Low
- Status: Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae)
- Location: `contracts/repo/src/oracle.rs:139`, `contracts/repo/src/lib.rs:966-977`
- Finding: All value maths uses `VALUE_DECIMALS = 7`, and `validate_config` never reads `usdc.decimals()`. Stellar USDC is 7 decimals, so nothing breaks today, but a 6-decimal stablecoin configured as `usdc` would misprice every LTV by 10×. The security playbook's token-consumer review says to query decimals, never assume 7. Config is written only in the constructor, so a constructor check is sufficient.
- Fix: The constructor requires `usdc.decimals() == 7`, else `InvalidConfig`. Regression test: `cs07_constructor_requires_7_decimal_usdc` (a 6-decimal token and a non-token are rejected, the SAC is accepted).

## What was checked

| Check | Result | Finding |
|---|---|---|
| Every privileged function requires auth from an address loaded from storage | pass | |
| Every fund mover authorizes the party whose funds move; permissionless calls move only escrow or the borrower's own allowance | pass | |
| Every `Address` parameter is re-authed (no middleware replay) | pass | |
| Initialization only once (`__constructor`) | pass | |
| External contracts allowlisted (collateral via admin `set_asset`; USDC and oracle fixed in Config) | pass | |
| Cross-contract return values sanity-checked (price sign, staleness, future skew, band) | partial: the feed's `base()` was never called (since fixed) | STD-01 |
| Checked arithmetic (`overflow-checks = true`), input sign and range validated | pass, with a gap | CS-03 |
| Storage keys typed, no collisions | pass | |
| Atomic checks and state changes; allowance overwrite safe | fail | CS-01 |
| Critical TTLs extended proactively; no TTL used as security | partial | CS-04, CS-05 |
| Loops and footprints bounded (take 1.09 M CPU, liquidate 1.75 M CPU against a 100 M limit) | pass | |
| Griefing or DoS on shared counters | fail | CS-03 |
| Events for auditable state changes; error codes append-only | partial | CS-06 |
| Upgrade path gated and tested | N/A: no upgrade entry point, every fix is a redeploy | |
| Emergency controls (per-asset pause; repay, top-up and claim never paused) | pass | |
| Reentrancy: state written before every external token call | pass | |
| Failed-transfer paths survivable (USDC legs park the payout) | pass for USDC, fail for clawback | CS-02 |
| Decimals queried, never assumed | partial | CS-07 |
| Received amount re-checked (fee-on-transfer) | pass (accepted: no listed token has a transfer fee) | |
| SAC quirks: missing trustline, AUTH_REQUIRED, frozen, clawback | fail on clawback | CS-02 |
| `transfer_from`: spender authed, allowance coordinated | fail | CS-01, CS-04 |
| Custom account `__check_auth` | N/A | |
| `#![no_std]`, wasm32v1-none, size limit (repo wasm 57,053 B), ledger time only | pass | |
| Before mainnet: static analyzers (Scout, OpenZeppelin detectors), threat model | not run (mainnet-only) | |

## Not re-reported

An earlier internal adversarial review had already fixed these, and they were re-checked at the audited commit: USDC payouts that fail are parked for the owner's `claim` instead of reverting the settlement, and an auto-repay that cannot return collateral refunds the USDC; a Defaulted repo stays repayable; a borrower cannot liquidate their own repo; config values are bounded; the oracle rejects future timestamps; and the 6-day instance TTL is documented in the README.
