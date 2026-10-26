# Soroban testing practice audit

Commit audited: [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) (26 Oct 2026). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the audited commit.

Scope: the Rust tests of the three contracts (`contracts/*/src/test*.rs` and the in-module tests they rely on), the keeper tests (`scripts/keeper/src/*.test.ts`) and the app tests (`app/test/`). The method was the Stellar Raven (https://raven.stellar.org) smart-contracts playbook from the [stellar-dev-skill](https://github.com/stellar/stellar-dev-skill): `testing.md` (authorization, time and ledger state, events, storage TTL, cross-contract, integration, fuzz and property tests, snapshots, CI, checklist) and the minimal-test section of `SKILL.md`. Findings were reproduced by mutation probes in a scratch worktree of the audited commit: deleting each of the 24 `require_auth` calls one at a time and running that crate's tests, making the wrong address sign (7 mutants), turning the TTL extensions into no-ops, and a seeded 300,000-case invariant sweep over the money maths. An independent QA pass re-ran the probes and re-rated severity.

Bottom line after QA: the suite was broad at the audited commit (241 Rust, 40 keeper and 19 app tests, all green): every public function is called, error paths use `try_`, ledger-time boundaries are exact, and every repo event type is asserted. The gaps were missing layers: 3 of 24 `require_auth` deletions left every test green, nothing asserted a TTL, and no CI ran any test. Those three are fixed on main: the auth and TTL tests exist and a CI workflow runs on every push and PR with a snapshot drift check (green on [ba3c054](https://github.com/rcusans-code/Caravel/actions/runs/40304715427)). The contributor guide's snapshot rule is still unchanged, and the deeper test layers (property, fuzz, keeper decision loop, real oracle) are roadmap R13.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| CT-01 | Medium | Deleting 3 of 24 `require_auth` calls leaves every test green | Fixed in [1a803d5](https://github.com/rcusans-code/Caravel/commit/1a803d5) |
| CT-02 | Medium | No CI runs any test | Fixed in [1a803d5](https://github.com/rcusans-code/Caravel/commit/1a803d5) |
| CT-03 | Medium | No test asserts a TTL, and snapshot diffs are excluded from review | Partly fixed in [1a803d5](https://github.com/rcusans-code/Caravel/commit/1a803d5) |
| CT-04 | Medium | No fuzz or property tests on the value-moving maths | Roadmap (R13 Test depth) |
| CT-05 | Medium | The keeper's decision loop and the app's chain layer are untested | Roadmap (R13 Test depth) |
| CT-06 | Low | Repo tests price against a test mock, not the real oracle contract | Roadmap (R13 Test depth) |
| CT-07 | Low | Negative auth tests do not check that the failure is an auth error | Roadmap (R13 Test depth) |
| CT-08 | Low | tSAFO mock events are never asserted | Roadmap (R13 Test depth) |

Status counts: Fixed 2 · Partly fixed 1 · Roadmap 5 · Won't fix 0 · Open 0.

### CT-01: Deleting 3 of 24 `require_auth` calls leaves every test green

- Severity: Medium (reported High; lowered on QA review)
- Status: Fixed in [1a803d5](https://github.com/rcusans-code/Caravel/commit/1a803d5)
- Location: `contracts/oracle/src/lib.rs:172`, `contracts/repo/src/lib.rs:954`, `contracts/spiko-mock/src/lib.rs:158`; tests that missed them: `contracts/oracle/src/test.rs:229-237`, `contracts/repo/src/test.rs:2990-3034`, `contracts/spiko-mock/src/test.rs:47`
- Finding: Most tests run under `mock_all_auths`, which the playbook warns can hide a missing `require_auth` unless paired with `env.auths()` asserts. Deleting the auth call in the oracle's `set_admin`, in the repo's `admin_or_guardian` (used by `cancel_asset` and `cancel_pause`) or in tSAFO `mint` left the whole crate suite green (oracle 14/14, repo 217/217, spiko-mock 10/10). Had one regressed: anyone could take the oracle admin and set any NAV, cancel any timelocked proposal by naming the admin as caller, or mint tSAFO. The existing cancel test checked only a stranger's identity, never a missing signature. QA lowered it: the code has all three calls today, so the risk is a future regression; two of the sites are testnet stand-ins, and the production one would at worst let anyone cancel a pending proposal.
- Fix: Three tests that sign with nobody (or the wrong party) and assert failure: `audit_set_admin_requires_current_admin_auth` (oracle), `audit_cancel_requires_caller_signature` (repo, `set_auths(&[])`; proposals stay pending) and `audit_mint_requires_admin_auth` (spiko-mock); `set_admin_hands_over_control` now asserts `env.auths()` straight after `set_admin`. Re-running the deletion probe on the fix kills 24 of 24 mutants.

### CT-02: No CI runs any test

- Severity: Medium
- Status: Fixed in [1a803d5](https://github.com/rcusans-code/Caravel/commit/1a803d5)
- Location: `.github/workflows/pages.yml` (the only workflow)
- Finding: The only workflow built and deployed the site. No job ran `cargo test`, the wasm build, or the keeper and app tests; the only gate was someone re-running tests by hand before a merge. The playbook's CI section expects at least `cargo test` and the `wasm32v1-none` build.
- Fix: `.github/workflows/test.yml` runs on push, pull request and manual dispatch, with no secrets and read-only permissions. Jobs: contracts (`cargo fmt --check`, `cargo test --workspace --locked`, `stellar contract build`, then a check that fails if `cargo test` changed, deleted or added any file under `contracts/*/test_snapshots/`), keeper (`npm ci`, type check, `npm test`) and app (`npm ci`, `npm test`, `npm run build:public`). The "Tests" run on main at ba3c054 is green.

### CT-03: No test asserts a TTL, and snapshot diffs are excluded from review

- Severity: Medium
- Status: Partly fixed in [1a803d5](https://github.com/rcusans-code/Caravel/commit/1a803d5). The TTL test and the CI snapshot drift check landed. Open: the snapshot rule in `AGENTS.md:28` still says to exclude snapshots from review diffs and to resolve conflicts by taking either side; the planned wording change was not applied on main (DECISIONS #42 states the reviewed-snapshot policy).
- Location: `contracts/repo/src/storage.rs:56-66`, `AGENTS.md:28`, `contracts/repo/src/test.rs:1125-1133`
- Finding: No crate called `get_ttl`. Turning both `extend_ttl` calls into no-ops left 217/217 repo tests green; the only signal was 191 changed snapshot files (`live_until` 103,680 → 4,095 on the instance and 518,400 → 4,095 on persistent keys), which the contributor guide says to leave out of reviews. Advancing 7 days of ledgers and reading still returned the repo, because the test environment surfaced no archival, so expiry was invisible without explicit asserts.
- Fix: `ttl_is_bumped_on_every_touch` in `contracts/repo/src/test_attack_a1.rs` asserts exact TTLs on the instance, Offer, Repo, AllowanceUntil and Claimable keys after create, take, repay and a parked claim, and after an untouched read 29 days later; each TTL no-op mutant (both sites, instance only, persistent only) now fails it. The CI drift check (CT-02) makes snapshot changes visible again. Remaining: change `AGENTS.md:28` so snapshot diffs are reviewed when contract code changes.

### CT-04: No fuzz or property tests on the value-moving maths

- Severity: Medium
- Status: Roadmap (R13 Test depth)
- Location: `contracts/repo/src/math.rs:66-222`, `contracts/repo/src/lib.rs:437`, `contracts/repo/src/lib.rs:541`, `contracts/repo/src/lib.rs:740`, `contracts/repo/Cargo.toml:14-17`
- Finding: Interest, required collateral, liquidation proceeds and the payout waterfall are checked only at hand-picked points; there is no `proptest` and no `fuzz/` target. A seeded 300,000-case sweep found 0 violations of "required collateral passes the LTV check and is minimal" and "lender + fee + borrower = available, all non-negative" (both NAV scales, haircut 201-9,999). This is regression protection, not a live bug.
- Fix: Planned ([R13](../../README.md#production-notes-raven-audit-roadmap)): property tests on `math.rs`, then one cargo-fuzz target driving create, take, top-up, repay, default and liquidate with arbitrary amounts, NAV and times, asserting USDC and collateral conservation.

### CT-05: The keeper's decision loop and the app's chain layer are untested

- Severity: Medium
- Status: Roadmap (R13 Test depth)
- Location: `scripts/keeper/src/keeper.ts:249-416`, `scripts/keeper/src/keeper.ts:439`, `app/src/chain.ts`
- Finding: The keeper is the only thing that settles repos on chain, yet its tests cover only pure helpers (alerts, errors, funding, NAV guard, `--once`); the per-repo choice between auto-repay, margin check, default and liquidate has no test. App tests covered formatting, gates and trustlines only. There is no quickstart job and no ignored network test.
- Fix: Planned: move the per-repo choice into a pure `plan()` function with table tests (matured, missed call, auto-repay, held NAV, defaulted), and later a quickstart CI job that deploys, seeds, runs `keeper --once` and asserts statuses.

### CT-06: Repo tests price against a test mock, not the real oracle contract

- Severity: Low
- Status: Roadmap (R13 Test depth)
- Location: `contracts/repo/src/oracle.rs:205-280`, `contracts/repo/src/oracle.rs:526-545`, `contracts/repo/Cargo.toml:16-17`
- Finding: Every `World`-based repo test prices against an in-crate test mock whose history logic is separate from `contracts/oracle`. A drift in the real feed's `prices()` order or decimals would show only in the one test that uses the real oracle contract. No test registers a dependency from its WASM.
- Fix: Planned: build `World` on the real oracle contract (or its WASM) and keep the test mock for oracle unit tests only.

### CT-07: Negative auth tests do not check that the failure is an auth error

- Severity: Low
- Status: Roadmap (R13 Test depth)
- Location: bare `#[should_panic]` at `contracts/repo/src/test.rs:177` and `contracts/spiko-mock/src/test.rs:132`, `:149`, `:157`; `set_auths(&[])` plus `.is_err()` at `contracts/repo/src/test.rs:508`, `:653`, `:861`, `:1174`, `:1354`, `:1891`
- Finding: No negative test matches `Error(Auth`, and all 9 positive asserts compare only the signing address (`auths()[0].0`), not the full invocation tree the playbook asks for on security-critical paths. Each negative test kills its mutant today, but a later precondition change could make one pass for the wrong reason.
- Fix: Planned: assert the auth failure itself, and compare `env.auths()` with the full `AuthorizedInvocation` (function and arguments) on admin, guardian and fund-moving paths.

### CT-08: tSAFO mock events are never asserted

- Severity: Low
- Status: Roadmap (R13 Test depth)
- Location: `contracts/spiko-mock/src/lib.rs:126`, `:168`, `:186`, `:220`; `contracts/spiko-mock/src/test.rs`
- Finding: The mock publishes Transfer, Mint, Whitelisted and PausedSet events, and its tests make no `events()` call, so a change to their shape would go unnoticed.
- Fix: Planned: one `to_xdr` assert per event in the existing spiko-mock tests.

## What was checked

| Check | Result | Finding |
|---|---|---|
| Unit tests cover all public functions, including `try_` error paths | pass (repo); oracle `set_admin` had no error-path test | CT-01 |
| Edge cases: zero, negative, max values, empty state | pass | |
| Auth verified with `env.auths()` or specific `mock_auths`, not bare `mock_all_auths` | fail | CT-01, CT-07 |
| `env.auths()` asserted right after the call under test | fail | CT-01 |
| A wrong signer fails a test | pass (all 7 signer swaps killed, via the token's own auth) | |
| Time logic driven with `set_timestamp` / sequence, boundaries included | pass | |
| Events asserted with `to_xdr` | pass (repo, all 19 event types); fail (spiko-mock) | CT-08 |
| Storage TTL validated with `get_ttl` | fail | CT-03 |
| Cross-contract tests against the real dependency | partial | CT-06 |
| Fuzz targets for value-moving paths | fail | CT-04 |
| Property tests for invariants | fail (invariants hold in a 300,000-case sweep) | CT-04 |
| Test snapshots committed and their diffs reviewed | partial | CT-03 |
| Resource limits left on in tests | pass | |
| `mock_all_auths_allowing_non_root_auth` only when needed | pass (not used) | |
| Integration tests against a local or test network | fail | CT-05 |
| CI runs `cargo test` and the wasm32v1-none build | fail | CT-02 |
| Testnet rehearsal before mainnet | pass | |
| Mutation testing | n/a in the repo; done by hand in this audit | |

## Not re-reported

Design issues behind some of these gaps are reported in other areas and not repeated here: the instance and persistent TTL lengths (CS-05 in [contract-security.md](contract-security.md)), the one-step oracle `set_admin` (UA-06 in [upgrade-admin.md](upgrade-admin.md)), and the missing events on `set_liquidator` and the oracle writes (CS-06). This report covers only how the tests exercise that code.
