# OpenZeppelin secure-contract patterns audit

Commit audited: [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) (26 Oct 2026). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the audited commit.

Scope: the hand-rolled access control in the repo contract (admin, guardian, timelock, per-asset pause, liquidator whitelist) and in the tSAFO mock (admin, pause, allowlist), compared with the OpenZeppelin Stellar library. The method was the Stellar Raven (https://raven.stellar.org) OpenZeppelin playbook ([openzeppelin-skills](https://github.com/OpenZeppelin/openzeppelin-skills), `develop-secure-contracts`: core workflow, pattern discovery and integration), with the library's module list from the [Stellar docs](https://developers.stellar.org/docs/tools/openzeppelin-contracts). Five findings were reproduced with Rust unit tests at the audited commit. An independent QA pass re-ran every repro, added one test and re-rated severity.

Bottom line after QA: every privileged function checks auth before it writes, nothing is copied from the library, and the per-asset pause has no OpenZeppelin equivalent, so custom code is justified there. The serious gaps were in role management: no rotation or revocation of the admin or guardian, and a guardian veto (two paths) that could lock collateral for good. Those, the trigger clamp, the guardian-equals-admin check, the liquidator event and proposal expiry are fixed on main and live on testnet since the redeploy in [2b5888d](https://github.com/rcusans-code/Caravel/commit/2b5888d). Migrating to OpenZeppelin crates and adding an upgrade path were declined; the check is recorded in DECISIONS #49.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| OZ-02 | High | No admin or guardian rotation; the guardian can veto a clear forever | Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843) |
| OZ-01 | Medium | A tighten-only key can margin-call every live repo at par | Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae) |
| OZ-03 | Low | Liquidator grant and revoke emit no event and cannot be enumerated | Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843) |
| OZ-04 | Low | No OpenZeppelin crate, and no record that the library was checked | Partly fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3) |
| OZ-05 | Low | The constructor accepts `guardian == admin` | Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae) |
| OZ-06 | Low | A loosening proposal stays executable forever after its eta | Fixed in [e8114f0](https://github.com/rcusans-code/Caravel/commit/e8114f0) |
| OZ-07 | Low | tSAFO mock: one key holds every role; allowlist reads never bump TTL | Roadmap (R15 Testnet mock hygiene) |
| OZ-08 | Info | Contracts are immutable; every fix is a new contract | Won't fix |

Status counts: Fixed 5 · Partly fixed 1 · Roadmap 1 · Won't fix 1 · Open 0.

### OZ-02: No admin or guardian rotation; the guardian can veto a clear forever

- Severity: High (production; needs a compromised or hostile guardian key)
- Status: Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843). Same root cause as UA-02 in [upgrade-admin.md](upgrade-admin.md).
- Location: `contracts/repo/src/types.rs:9-36`, `contracts/repo/src/lib.rs:209-213`, `contracts/repo/src/lib.rs:271-279`, `contracts/repo/src/lib.rs:327-336`, `contracts/repo/src/lib.rs:712`, `contracts/repo/src/lib.rs:878-891`
- Finding: OpenZeppelin's Ownable and AccessControl carry role transfer; the hand-rolled roles had none, so a leaked guardian or a lost admin key was permanent. The guardian can switch `no_seize` on instantly and then block every clear. Path 1: cancel each admin `propose_pause(clear)`; in the repro, after 3 rounds `execute_pause` returned NoProposal and at t=2480 (maturity 1420 plus 60 s grace) `default` returned Paused with the repo still Open. Path 2, added on QA review: re-asserting the same pause counted as a tightening, and `tighten_pause` dropped the pending clear, so making cancel admin-only alone would not have fixed it. The lender's collateral stayed locked unless the borrower repaid. Auto-repay repos still settled, since that runs before the seize check.
- Fix: Both paths are closed. The guardian can cancel or supersede each proposed change once; the admin's unchanged re-proposal then executes after the timelock (`VetoSpent` 27 for a second guardian cancel). A re-assert of the setting in force is a no-op. The admin rotates the guardian behind the timelock (`propose_guardian` / `execute_guardian`; the outgoing guardian cannot cancel it) and hands its own role over in two steps (`transfer_admin` / `accept_admin`, pending entry in temporary storage with an expiry, as OpenZeppelin does). Regression tests in `contracts/repo/src/test_governance.rs`: `ua02_oz02_guardian_cancel_veto_is_spent_on_the_reproposed_clear`, `qa_guardian_reassert_pause_drops_clear_proposal`, `ua02_admin_rotates_guardian_and_the_guardian_cannot_cancel`, `ua06_transfer_admin_needs_the_new_admins_acceptance`. Residual by design: a hostile guardian can re-pause after each executed clear until it is rotated out (one timelock).

### OZ-01: A tighten-only key can margin-call every live repo at par

- Severity: Medium
- Status: Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae). Same root cause as UA-01 in [upgrade-admin.md](upgrade-admin.md).
- Location: `contracts/repo/src/lib.rs:161-174`, `contracts/repo/src/lib.rs:194-206`, `contracts/repo/src/lib.rs:850-858`, `contracts/repo/src/margin.rs:54-60`, `contracts/repo/src/margin.rs:132-143`
- Finding: Raising haircut to 9,000 and trigger to 8,999 passes as a tightening, and the margin checks use the asset's live trigger, not bounded by the repo's snapshot haircut (300). With the guardian alone signing, NAV 1.00 gave MarginCall, a top-up of about 4× the posted collateral did not clear it, and past the window the repo defaulted. In a second test the admin did the same, whitelisted itself instantly, and bought 1,000.9589042 tBENJI for 980.9397262 USDC: a 20.02 USDC (199 bps) gain taken from the borrower's surplus. QA noted the live trigger is a documented design choice (a raised trigger binds live repos), so the defect is its unbounded value, and that the only mitigation against a hostile guardian, an instant `no_seize`, freezes the repo instead (OZ-02).
- Fix: `margin::effective_trigger = min(asset.margin_trigger_bps, repo.haircut_bps - 1)` in `check_margin`, the default recovery check and the top-up clear. Regression tests: `ua01_oz01_tightening_cannot_margin_call_at_par` and `oz01b_admin_tightening_cannot_force_a_sale` in `contracts/repo/src/test_raven_guards.rs`.

### OZ-03: Liquidator grant and revoke emit no event and cannot be enumerated

- Severity: Low
- Status: Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843). Same root cause as STD-03 in [standards-seps.md](standards-seps.md) and CS-06 in [contract-security.md](contract-security.md).
- Location: `contracts/repo/src/lib.rs:138-142`, `contracts/repo/src/storage.rs:235-243`
- Finding: OpenZeppelin AccessControl emits an event on every role grant and revoke. `set_liquidator` emitted none (the repro counted 0 events for a grant and a revoke), and the list is a persistent map keyed by address, so indexers, the app and lenders could not see who may buy collateral. Every other privileged change already emitted an event. QA noted this rests on event hygiene more than on a playbook rule.
- Fix: `LiquidatorSet { who, allowed }` on every grant (`execute_liquidator`) and revoke, plus `LiquidatorProposed` and `LiquidatorProposalCancelled`. Regression test: `oz03_liquidator_grant_and_revoke_emit_one_event_each` (exactly one event each).

### OZ-04: No OpenZeppelin crate, and no record that the library was checked

- Severity: Low
- Status: Partly fixed in [d8564c3](https://github.com/rcusans-code/Caravel/commit/d8564c3). The record of the check landed (DECISIONS #49); migrating to OpenZeppelin crates is Won't fix for now (team decision: not before the hackathon, revisit with the third-party audit).
- Location: `Cargo.toml` (`[workspace.dependencies]`), `contracts/*/Cargo.toml`
- Finding: The workspace depends only on `soroban-sdk`. The playbook's first rule is library first: import an exact match, and write custom code only after confirming there is none. Of 9 hand-rolled mechanisms, 5 have an exact OpenZeppelin match: protocol admin (Ownable), guardian and liquidator whitelist (AccessControl roles), tSAFO pause (Pausable) and tSAFO allowlist (fungible Allowlist). The per-asset pause, the tighten-instant/loosen-timelocked scheme and the tSAFO token base (Spiko has no `approve`) have no exact match. Nothing recorded the check, and fixes to OpenZeppelin's audited modules would never reach Caravel.
- Fix: DECISIONS #49 names the modules checked (`stellar-access` Ownable and AccessControl, `stellar-contract-utils` Pausable, `stellar-tokens` fungible Allowlist, `stellar-governance` timelock) and why each is kept custom; the role gaps were closed by hand in OZ-02 and OZ-03 instead of a migration, which would have meant a larger ABI change before the hackathon.

### OZ-05: The constructor accepts `guardian == admin`

- Severity: Low
- Status: Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae)
- Location: `contracts/repo/src/lib.rs:966-977`
- Finding: The guardian exists to be a second key, but `validate_config` did not enforce it; only the deploy script generated a separate guardian. The repro deployed with the same address in both roles.
- Fix: `validate_config` rejects `guardian == admin` with `InvalidConfig`, and the new rotation functions refuse to make the two roles equal. Regression test: `oz05_constructor_rejects_guardian_equal_admin`.

### OZ-06: A loosening proposal stays executable forever after its eta

- Severity: Low
- Status: Fixed in [e8114f0](https://github.com/rcusans-code/Caravel/commit/e8114f0)
- Location: `contracts/repo/src/lib.rs:255`, `contracts/repo/src/lib.rs:313`
- Finding: `execute_*` checked only `now < eta`, with no upper bound, so a loosening proposed months earlier under different conditions could be executed without notice unless the guardian remembered to cancel it. OpenZeppelin's governance timelock is a library alternative.
- Fix: Proposals execute only from `eta` through `eta + timelock_secs`; after that they return `ProposalExpired` (26). This landed with issue #41; the governance batch ([f398843](https://github.com/rcusans-code/Caravel/commit/f398843)) applies the same window to the new liquidator and guardian proposals. Regression tests: `execute_window_closes_at_eta_plus_timelock` and `oz06_liquidator_and_guardian_proposals_expire`.

### OZ-07: tSAFO mock: one key holds every role; allowlist reads never bump TTL

- Severity: Low (testnet mock only)
- Status: Roadmap (R15 Testnet mock hygiene) for the allowlist TTL half; Won't fix for the pause and role half, because the mock copies Spiko's own token on purpose.
- Location: `contracts/spiko-mock/src/lib.rs:96-105`, `contracts/spiko-mock/src/lib.rs:174-187`, `contracts/spiko-mock/src/lib.rs:193-221`, `contracts/spiko-mock/src/lib.rs:230-234`
- Finding: In the tSAFO mock one admin key mints, pauses and allowlists, with no rotation, and pause and allowlist are hand-rolled where OpenZeppelin has Pausable and an Allowlist extension. `is_whitelisted` never bumps the TTL, so an allowlist entry archives 30 days after it was set and later transactions carry a restore. Frequent testnet redeploys hide this today. QA found the pause half is a style point: the mock follows Spiko's token for fidelity.
- Fix: Planned ([R15](../../README.md#production-notes-raven-audit-roadmap)): bump the TTL on allowlist reads and lengthen the instance TTL if the mock lives past the hackathon. Pause and roles stay as Spiko has them.

### OZ-08: Contracts are immutable; every fix is a new contract

- Severity: Info
- Status: Won't fix. The contracts stay immutable on purpose: an upgrade entry point would add a code-replacement key on top of the admin keys. Fixes ship as versioned redeploys with a wind-down (DECISIONS #45).
- Location: `contracts/` (no `update_current_contract_wasm`)
- Finding: Immutability rules out an admin upgrade rug, but every fix means a new contract, and live repos stay on the old code with its admin.
- Fix: None to the contracts. The deploy script now pauses new repos on each replaced contract and cancels the offers the team's keys own (`scripts/winddown.sh`, UA-05 in [upgrade-admin.md](upgrade-admin.md)). If an upgrade path is ever added, it should be OpenZeppelin `Upgradeable` behind the timelock and AccessControl.

## What was checked

| Check | Result | Finding |
|---|---|---|
| Read the project first; integrate, don't replace | pass | |
| Library first: import an exact match | fail | OZ-04 |
| Close match: import and extend through hooks | pass (n/a: per-asset pause and tighten-only guardian have no match) | |
| Custom code only after browsing the library, with a record | fail | OZ-04 |
| Never copy or embed library source | pass | |
| No custom `paused` check where Pausable exists | fail (mock, style point); pass (repo, per-asset pause) | OZ-07 |
| No hand-written owner check where Ownable exists | fail (13 hand-rolled auth sites, no rotation) | OZ-02 |
| Interface detection | n/a on Soroban | |
| OpenZeppelin components already in use | none | OZ-04 |
| The dependency's guards on every privileged function | pass (11 repo and 4 mock functions auth before writing) | |
| Replicate the dependency's public API, including events | fail | OZ-03 |
| No conflicting access-control systems | pass in the repo, with a caveat: the admin could grant itself the liquidator role instantly | OZ-01, OZ-03 |
| Storage compatibility if upgradeable | n/a (immutable) | OZ-08 |
| Version-specific override points | n/a (no dependency) | |
| Import from the dependency so security updates arrive | fail | OZ-04 |

## Not re-reported

Known before this audit and re-checked at the audited commit: a borrower cannot liquidate their own repo; the testnet guardian and admin were already different keys (the contract-side gap is OZ-05); the repo's liquidator whitelist is not synced with the tSAFO issuer's allowlist (an accepted limit stated in the README risks); DECISIONS #33 already listed the liquidator whitelist and guardian rotation as not timelocked (the veto consequence in OZ-02 was new); and the shared oracle and admin key, covered as UA-03 in [upgrade-admin.md](upgrade-admin.md).
