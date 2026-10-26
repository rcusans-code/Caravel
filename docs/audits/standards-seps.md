# SEP and CAP standards conformance audit

Commit audited: [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) (26 Oct 2026). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the audited commit.

Scope: the repo contract's SEP-40 oracle client (`contracts/repo/src/oracle.rs`), the mock oracle and the tSAFO mock token, the repo contract's events and constructor, the keeper's SEP-40 reader, and the deploy script's build step. The method was Stellar Raven (https://raven.stellar.org) playbooks from the [stellar-dev-skill](https://github.com/stellar/stellar-dev-skill): the standards skill (high-value SEPs and CAPs, quick mapping by use case) and the smart-contracts skill (events, oracles, regulated tokens, security section 9 on trusting cross-contract return values), checked against the current SEP-40, SEP-41, SEP-8, CAP-67 and SEP-46/55 text. STD-01, STD-02 and STD-03 were reproduced with Rust unit tests at the audited commit; STD-04 and STD-05 were checked against the live testnet contracts with `stellar contract info interface` and `stellar contract info meta`. An independent QA pass re-ran every repro and re-rated severity.

Bottom line: the SEP-40 client, the SEP-41 usage and the event shapes conform. There were no Critical, High or Medium findings after QA: six Low and one Info. The three contract gaps (no `base()` check, no NAV age vs feed resolution check, a silent `set_liquidator`) and the missing SEP-46 provenance are fixed on main and live on testnet since the redeploy in [2b5888d](https://github.com/rcusans-code/Caravel/commit/2b5888d). Two mock-only Lows are on the roadmap, and the tSAFO "SEP-41 subset" item is Won't fix because the wording was already accurate.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| STD-01 | Low | Oracle `base()` is never checked | Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae) |
| STD-02 | Low | NAV age limit can be shorter than the feed resolution | Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae) |
| STD-03 | Low | `set_liquidator` emits no event | Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843) |
| STD-04 | Info | tSAFO mock implements only part of SEP-41 | Won't fix |
| STD-05 | Low | No SEP-46 contract meta or SEP-55 build attestation | Fixed in [78f6232](https://github.com/rcusans-code/Caravel/commit/78f6232) |
| STD-06 | Low | Mock oracle timestamps are not resolution-aligned | Roadmap (R15 Testnet mock hygiene) |
| STD-07 | Low | tSAFO mock does not extend TTLs on reads | Roadmap (R15 Testnet mock hygiene) |

Status counts: Fixed 4 · Partly fixed 0 · Roadmap 2 · Won't fix 1 · Open 0.

### STD-01: Oracle `base()` is never checked

- Severity: Low (reported Medium; lowered on QA review)
- Status: Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae)
- Location: `contracts/repo/src/oracle.rs:43`, `contracts/repo/src/lib.rs:50-55`, `contracts/repo/src/oracle.rs:54-61`
- Finding: The SEP-40 client declares `base()` but nothing in the contract, keeper or app calls it. A feed quoted in another base is accepted as if it were USD: in the repro a feed with `base() = Other(XLM)` returned `fresh_nav = Ok((8·10^14, 14))`, so a price in XLM would be valued as USDC. Reflector's own Stellar DEX feed has a non-USD base. QA lowered it to Low because `Config.oracle` has no setter and the deploy script hard-codes a USD base, so the only path is a one-time wrong oracle ID at deploy, which would show on the first NAV read.
- Repro:
  ```rust
  let oracle = real_oracle(&env, "XLM", 60);
  let mut cfg = demo_config(&env);
  cfg.oracle = oracle.clone();
  let repo = env.register(CaravelRepo, (cfg.clone(),));
  feed.set_price(&caravel_oracle::Asset::Stellar(token.clone()), &(ONE * 8));
  let r = env.as_contract(&repo, || fresh_nav(&env, &cfg, &acfg));
  assert_eq!(r, Ok((ONE * 8, 14))); // XLM-quoted price accepted
  ```
- Fix: the constructor now calls `oracle::config_feeds_ok`, which requires `try_base() == Asset::Other("USD")` (a feed that traps also fails) and returns `InvalidConfig` otherwise. Regression test `std01_constructor_requires_a_usd_feed` in `contracts/repo/src/test_raven_guards.rs`; the original repro now fails at the constructor.

### STD-02: NAV age limit can be shorter than the feed resolution

- Severity: Low
- Status: Fixed in [79b4fae](https://github.com/rcusans-code/Caravel/commit/79b4fae)
- Location: `contracts/repo/src/lib.rs:833-845` (`validate_asset`), `contracts/repo/src/oracle.rs:85-88`, `scripts/deploy.sh:60`
- Finding: SEP-40 stamps `PriceData.timestamp` as `floor(now / resolution) * resolution`, so a record is up to one resolution old the moment it is published. `validate_asset` never read `resolution()`. With a 300 s feed and the demo's `max_nav_age_secs` of 180, the feed's current record read `StaleNav` in 119 of every 300 seconds, and `set_asset` accepted that config. Against Reflector, which publishes after the window, every read would be stale. The demo mock runs at resolution 60, so the demo was not affected, and the README already flagged the trap in prose.
- Fix: `validate_asset` rejects `max_nav_age_secs < feed.resolution()` (and a feed whose `resolution()` fails) on all four write paths: `set_asset`, `guardian_set_asset`, `propose_asset` and `execute_asset`. Regression test `std02_nav_age_below_feed_resolution_is_rejected` (300 s feed: 299 is rejected, 300 is accepted).

### STD-03: `set_liquidator` emits no event

- Severity: Low
- Status: Fixed in [f398843](https://github.com/rcusans-code/Caravel/commit/f398843). Same root cause as OZ-03 in [openzeppelin-patterns](openzeppelin-patterns.md) and CS-06 in [contract-security](contract-security.md).
- Location: `contracts/repo/src/lib.rs:138-142`
- Finding: `set_liquidator` decides who may seize collateral, but it wrote or removed the whitelist entry without publishing anything. The repro set a liquidator and observed `is_liquidator = true` with 0 repo events. Every other admin or borrower setter emits an event, so this was the only silent policy change, invisible to the app and to indexers.
- Fix: the governance batch made liquidator additions timelocked (`propose_liquidator` / `execute_liquidator`) and emits `LiquidatorSet { #[topic] who, allowed }` on every grant and revoke, plus `LiquidatorProposed` and `LiquidatorProposalCancelled`. The oracle now emits `PriceSet` on every write. Regression test `oz03_liquidator_grant_and_revoke_emit_one_event_each` in `contracts/repo/src/test_governance.rs` (exactly one event per grant and per revoke).

### STD-04: tSAFO mock implements only part of SEP-41

- Severity: Info (reported Low; lowered on QA review)
- Status: Won't fix. The "SEP-41 subset" wording is already accurate, and adding stubs would make the mock less faithful to Spiko's token.
- Location: `contracts/spiko-mock/src/lib.rs:107-148`, `contracts/spiko-mock/src/lib.rs:111`
- Finding: The live tSAFO interface has `transfer`, `balance`, `decimals`, `name` and `symbol`, but not `allowance`, `approve`, `transfer_from`, `burn` or `burn_from` (5 of 10 SEP-41 functions missing), and `transfer.to` is `Address`, not `MuxedAddress`. This is deliberate: the mock copies Spiko's token (DECISIONS #29), and Caravel only calls `transfer` on collateral. QA found that the docs already describe it correctly: the code comment says "SEP-41 subset", TASKS.md and DEVS.md say "SEP-41 token with an allowlist and no `approve`", and `docs/numbers.md:50` says "only partly SEP-41".
- Fix: none planned. The code stays a faithful Spiko subset.

### STD-05: No SEP-46 contract meta or SEP-55 build attestation

- Severity: Low
- Status: Fixed in [78f6232](https://github.com/rcusans-code/Caravel/commit/78f6232)
- Location: `scripts/deploy.sh:146`, `.github/workflows/` (only `pages.yml` at the audited commit)
- Finding: The live repo contract's `contract info meta` showed only the toolchain keys (`rsver`, `rssdkver`, `rssdk_spec_shaking`, `cliver`), with no `source_repo` or `commit_sha`. The deploy script built with a plain `stellar contract build`, and there was no attestation workflow. Explorers and reviewers could not link the on-chain wasm to this repository.
- Repro: `stellar contract info meta --id <repo contract ID> --network testnet`
- Fix: `scripts/lib/deploy-guards.sh` builds with `--meta source_repo=github:rcusans-code/Caravel --meta commit_sha=<HEAD>` (with a `-dirty` suffix for uncommitted contract changes). Contract reuse now compares wasm with the meta section stripped (`scripts/wasm-code-hash.py`), so a new commit alone does not force a redeploy. New `.github/workflows/attest.yml` builds on a `v*` tag or by hand and runs `actions/attest-build-provenance`, so `stellar contract info build` can verify a deploy of those exact bytes. Checks in `scripts/test/deploy-guards.test.sh`: "STD-05 build meta has source_repo and commit_sha", "STD-05 deploy.sh builds with the meta", "STD-05 code hash ignores contractmetav0 only". After the redeploy in [2b5888d](https://github.com/rcusans-code/Caravel/commit/2b5888d), the live repo and oracle both report `source_repo` and `commit_sha`. The attestation workflow runs only on demand or on a release tag.

### STD-06: Mock oracle timestamps are not resolution-aligned

- Severity: Low
- Status: Roadmap ([R15 Testnet mock hygiene](../../README.md#production-notes-raven-audit-roadmap))
- Location: `contracts/oracle/src/lib.rs:155-158`, `contracts/oracle/src/lib.rs:162-164`, `contracts/oracle/src/lib.rs:113-127`
- Finding: The mock oracle's `set_price` stamps the raw ledger time, not `floor(now / resolution) * resolution` as SEP-40 specifies. Every test and the demo therefore see fresher prices than a real feed would give, which is why STD-02 stayed invisible until a live feed was considered. This affects the testnet mock only.
- Fix: planned: stamp `ts - ts % resolution` in `set_price` (keep `set_price_at` for staleness demos) and add a repo test at resolution 300.

### STD-07: tSAFO mock does not extend TTLs on reads

- Severity: Low
- Status: Roadmap ([R15 Testnet mock hygiene](../../README.md#production-notes-raven-audit-roadmap))
- Location: `contracts/spiko-mock/src/lib.rs:130-132`, `contracts/spiko-mock/src/lib.rs:174-191`, `contracts/spiko-mock/src/lib.rs:230-234`, `contracts/spiko-mock/src/lib.rs:83-89`
- Finding: Allowlist entries are bumped only by `set_whitelisted` (30 days), and `balance` and `is_whitelisted` reads do not extend them. After 30 days the repo contract's own allowlist entry archives and the next tSAFO move needs a restore. QA found a wider case: the tSAFO instance TTL is only 6 days, and read-only calls do not extend it, so an idle tSAFO archives the whole instance first. This matches the testnet rent policy used elsewhere and affects the mock only.
- Fix: planned: extend allowlist entry TTLs inside `transfer` and `mint` (or on reads) and use a longer instance TTL. A tSAFO redeploy resets its allowlist, so this waits for the next mock redeploy.

## What was checked

| Check | Result | Finding |
|---|---|---|
| SEP-40 read interface (`Asset`, `PriceData`, seven reads) matches Reflector's on-chain spec | pass | |
| Consumer checks `timestamp` against the ledger (staleness) | pass | |
| Safe integer math on `price / 10^decimals`; `decimals()` per feed | pass | |
| Sanity bounds on external returns (non-positive, floor, ceiling, band) | pass | |
| Timestamp semantics `floor(now / resolution) * resolution` respected | fail | STD-02, STD-06 |
| Price quoted in the expected base (`base()`) | fail | STD-01 |
| Multi-source or median feed | fail, already tracked by an earlier review (single feed) | |
| Keeper SEP-40 reader encodes `Asset` like the contract | pass | |
| Tokens moved are SEP-41; collateral uses only `transfer` (auto-repay uses USDC SAC `approve` / `transfer_from`, which is full SEP-41) | pass | |
| Stellar Asset + SAC preferred unless custom logic is needed (tSAFO custom on purpose) | pass | |
| A custom token implements the full SEP-41 interface | fail (deliberate subset) | STD-04 |
| SEP-41 / CAP-67 token event shapes | pass | |
| Events via `#[contractevent]`, ids in topics, amounts in data | pass | |
| An event for every state change worth indexing | fail | STD-03 |
| Regulated assets: SEP-8 per-transaction approval | N/A (a Soroban transaction carries one operation, so SEP-8 assets cannot be collateral; no doc claims SEP-8) | |
| SEP-57 (T-REX) regulated token pattern | N/A | |
| SEP-46 contract meta (`source_repo`, `commit_sha`) | fail | STD-05 |
| SEP-48 interface spec readable on-chain | pass | |
| SEP-49 upgrade process (contracts are immutable; redeploy with new IDs) | pass | |
| SEP-55 build verification | fail | STD-05 |
| CAP-58 constructors with validation | pass | |
| CAP-53 TTL extension on read and write | partial | STD-07 |
| Other CAPs (crypto) and anchor/auth SEPs (1, 6, 10, 12, 23, 24, 31) | N/A | |

## Not re-reported

An earlier internal design review had already handled four related issues, so they are not repeated here: oracle records with a future timestamp, the NAV band window and a second NAV source, the missing allowlist check in `set_liquidator`, and the SEP-40 wording and `Asset` enum in the docs.
