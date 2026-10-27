# Who does what

Four people, four lanes. Each lane below is in order: finish the top task before starting the next. [TASKS.md](TASKS.md) stays the shared board; tick boxes there too. Rules for the code live in [DECISIONS.md](DECISIONS.md); read it before you start.

| Person | Lane | Owns | Board tag |
|---|---|---|---|
| **Den** | Contracts: core flows | `contracts/repo/src/lib.rs` flows: offers, take (DvP), repay, default, liquidate, hardening | **C** |
| **Misha** | Integration + price & margin | `contracts/oracle` (mock SEP-40), `contracts/repo/src/oracle.rs` (NAV client + staleness), `contracts/repo/src/margin.rs` (`check_margin`, `top_up`), deploy, keeper, seed, TS bindings, `.env` | **I** |
| **Bohdan Che** | Design + frontend | `design/` and the web app in `app/` (wallet, flows, positions, NAV slider, liquidator view) | **F** |
| **Bohdan Koldun** | Pitch, docs + QA | README, deck, video, submission, mentor round, UI testing, board updates | **P** |

Bohdan Koldun needs a short answer from each of you at the points marked **→ Bohdan Koldun**.

**Split inside the contract:** Den and Misha both work in `contracts/repo`, so stay in your own files. Den owns `lib.rs` flows, `storage.rs`, `events.rs`. Misha owns `oracle.rs` and `margin.rs`; the `check_margin` / `top_up` entry points in `lib.rs` are one-line calls into `margin.rs`. Shared files (`types.rs`, `errors.rs`, `math.rs`): small PRs, tell the other in chat before merging.

Deadline: submit **Mon 11:30**, feature freeze **Mon 08:00**.

---

## Status at Mon 06:50 WET (checked against `main` 96d4d61)

**Live on testnet** (redeployed Sun 22:59 UTC after the 8 attack fixes): repo `CDMLJAW5…`, oracle `CBMVY3VX…`, tSAFO `CBZOHBJ6…`, separate guardian. Full IDs in `deployments/testnet.json`; the README table is written from it. App: https://caravel-repo.pages.dev/app/ (landing at `/`).

**Done since Sun 18:20**
- PRs #33–#36 merged: per-asset pause switches, NAV sanity band, per-asset exposure cap, Settle now button.
- Attack fixes A1–A8 merged (claimable USDC payouts, guardian + timelock for loosening asset config, DECISIONS #33), then redeployed.
- Hardening: `take_offer_twice_is_rejected` test on main (e1898ca); `liquidate` stays blocked on stale NAV (DECISIONS #34, `## Open` now reads "None."). DECISIONS #20 matches the shipped rule (NAV recovery clears a missed margin call at default).
- Live SEP-40 feed shown in the app next to the mock NAVs, reference only (96d4d61).
- 242 tests pass (`cargo test --workspace`: oracle 14, repo 218, spiko-mock 10); app 23 tests.
- Demo video recorded.

**Still open**

| Owner | Item | State |
|---|---|---|
| Bohdan Che | G5 polish | Partial. Loading skeletons on the offers table, NAVs, live feed and repos; `fmtAmount` (2 dp for USDC) used throughout. Left: copy pass with Bohdan Koldun; at 390 px the Offers table clips its Collateral column. |
| Simon | Issue #41, guardian timelock follow-ups | PR #51 (`simon/issue-41`) open, not merged. |
| Simon | Issues #37 (tab in URL hash), #38 (split App.tsx) | Cards filed, not started on main. |
| Simon | NAV-side fixes on `simon/nav-feed-rewrite`, `simon/nav-nav-ux`, `simon/nav-keeper-launder`, `simon/nav-nav-outage` | Pushed, in QA/merge, not on main yet. |
| Misha | README `take_offer` DvP tx link | Contract IDs are in the README; no tx link yet. |
| Bohdan Koldun | Mentor round 1 | Monday morning. |
| Bohdan Koldun | Submission answers | Written after the mentor round. |
| Bohdan Koldun | Deck | Mostly done (`docs/caravel-pitch.pdf`). |
| Bohdan Koldun | Lock-in, rehearsals, README final sign-off, submit | Not recorded in the repo. |

---

## Status at Sun 18:20 (checked against `main` 0c284f0) (superseded by Mon 06:50 above)

**Done and live on testnet** (redeployed Sun 18:00: repo `CCFP3L7T…`, oracle `CAQK3QD4…`, tSAFO `CA75VXSU…`; full IDs in `deployments/testnet.json`)

- **Contract:** every flow is implemented, no stubs: create, cancel, take (DvP), repay, `top_up`, `check_margin`, `default`, `liquidate`, plus `auto_repay` (#27). 160 tests across the workspace. Per-asset NAV staleness (#25), compliance-agnostic SEP-41 tests (#24, `test_allowlist.rs`, `test_spiko.rs`), token decimals (#28), tSAFO as collateral #2 (#29).
- **Integration:** mock SEP-40 oracle, one-command deploy (`scripts/deploy.sh`, demo time profile as its defaults), TS bindings in `packages/caravel-repo` and `packages/caravel-oracle`, keeper (`auto_repay`, `check_margin`, `default`, `liquidate`, holds on a NAV jump), `set-nav` CLI, seed script, live SEP-40 feed read (`scripts/keeper/src/feeds.ts`).
- **App** (https://caravel-repo.pages.dev/app/, landing at `/`): offers board, create and take with the DvP collateral preview, positions with countdown and Top up, admin NAV slider, liquidator view, stellar.expert links. Spiko and weekend copy is on the landing and in the app.
- **Pitch:** deck PDF in `docs/caravel-pitch.pdf`; README has architecture, states, methods and parameters.

**Still open**

| Owner | Item | State |
|---|---|---|
| Den | Hardening sign-off | Auth on every mutating call, status checks, take-once (the offer is removed on take) and TTL bumps on read/write are in the code. Missing: a take-twice test and a sign-off. |
| Den + Misha | `liquidate` on stale NAV | The code blocks it (test `liquidate_rejects_stale_nav`); DECISIONS → Open is still undecided. Close it as "blocked" or change the code. |
| Den / Bohdan Che | Open PRs #33–#36 (pause flags #28, NAV band #26, exposure cap #29, Settle now #31) | Opened 18:10–18:20, not reviewed. Merge before the 08:00 freeze or cut. |
| Misha | README contract IDs | The repo and oracle rows still read "final deploy, Mon 06:00"; add one `take_offer` DvP tx link. |
| Bohdan Che | Live feed in the app | Read by the keeper only; the app does not show it next to the mock NAV. |
| Bohdan Che | G5 polish | Empty states exist; loading states, number formatting and the copy pass are not checked. |
| Bohdan Koldun | Lock-in, mentor round 1 | Not recorded anywhere. |
| Bohdan Koldun | Video script, submission answers, deck v1 sign-off, README final (3 REVIEW notes left), rehearsals, submit | Nothing in the repo yet. |

---

## Update Sun 16:35: Spiko, compliance, weekends

- **Pitch:** Spiko is the largest RWA issuer on Stellar ($1.97B across 9 funds vs BENJI $434.7M; DefiLlama, 25 Oct 2026; details in [docs/numbers.md](docs/numbers.md)). It sits next to BENJI at the center of the deck and the landing. Deck: 12 slides, [docs/pitch-deck.md](docs/pitch-deck.md); Teo drafts, Den owns the narrative and the final read. All numbers from [docs/numbers.md](docs/numbers.md), dated.
- **Misha:** per-asset NAV staleness (DECISIONS #25): `AssetConfig.max_nav_age_secs`, 96h prod / 180 s demo, then redeploy (issue #18 covers the redeploy).
- **Den:** compliance-agnostic test (DECISIONS #24) with a Spiko-style permissioned SEP-41 token that has no `approve`; decide with Misha whether `liquidate` stays blocked on stale NAV.
- **Bohdan Che:** landing and app copy updated for Spiko, compliance-agnostic and the weekend policy.

## Status at Sun 14:05, and what each of you does right now (superseded by Sun 18:20 above)

**Done on `main`**
- AUTH_REQUIRED spike: **GO**. The issuer can authorize a contract on tBENJI, and the freeze works (`spikes/auth/README.md`).
- 5 testnet accounts funded; tBENJI and USDC contract IDs in `spikes/auth/README.md`; burner keys in `.env`.
- Contract skeleton: types, storage, events, errors. Constructor, views, `set_asset` and `set_liquidator` work.
- `math.rs`: debt, LTV, margin trigger, required collateral, liquidation waterfall with fee and shortfall.
- Decisions #1–22 locked. **33 tests pass** (`cargo test`).

**Not started**
- The 8 contract flows are still stubs (`create_offer` … `liquidate`).
- No oracle, no deploy script, no keeper, no frontend. No other branches have been pushed.
- G0 left open: frontend scaffold (was due 13:00) and the 15-minute team lock-in.

Nobody needs to wait for anybody. Start these now, in parallel:

| Person | Right now (until ~16:00) | Then |
|---|---|---|
| **Den** | 1. `create_offer` + `cancel_offer` (no NAV needed). 2. `take_offer`, calling Misha's `oracle::fresh_nav`. 3. `repay`. | `default`, `liquidate` |
| **Misha** | 1. **By 14:45:** push `oracle.rs` in the repo contract: SEP-40 client (`lastprice(asset) → Option<PriceData>`, `decimals()`) and `fresh_nav(env, &AssetConfig) → Result<(price, decimals), Error>` that returns `StaleNav` past `max_nav_age_secs`, plus a test-only mock. Den builds `take_offer` on it. 2. Mock oracle as a second contract in `contracts/oracle` (workspace member), same interface, with `set_price` and tests. 3. **Deploy script v0 against today's skeleton**: deploy oracle + repo, set tBENJI, whitelist the liquidator, issuer `set_authorized(repo, true)` on tBENJI, IDs to `.env`. After that, each new flow is just a redeploy. 4. TS bindings for both contracts into the app. | `margin.rs`, keeper, seed |
| **Bohdan Che** | 1. Scaffold the app in `app/`: stellar-sdk, Freighter, testnet, design system. 2. Balances for USDC + tBENJI using the contract IDs in `spikes/auth/README.md`. 3. Role switcher using the public keys of the 5 demo accounts. 4. Offers board on **mock data** shaped like `Offer` in `types.rs`. | Swap in the bindings at 16:30 |
| **Bohdan Koldun** | 1. Run the 15-minute lock-in now: the one-liner, the 6 demo beats, the demo time profile. 2. Mentor round 1 (demand, issuer whitelisting, term vs perpetual). 3. Deck outline, numbers from `docs/collateral-research.md`. | README core, QA |

**Oracle interface** (Misha defines it, Den consumes it): `PriceData { price: i128, timestamp: u64 }` and the `Asset` enum from `types.rs`, so the mock and Reflector stay interchangeable (#2, #22).

---

## Handoffs: the only times you block each other

| When | From → To | What | Why it matters |
|---|---|---|---|
| Sun 14:45 | Misha → Den | `oracle.rs` with `fresh_nav` merged | Den's `take_offer` and `liquidate` read NAV through it |
| Sun 15:00 | Den + Misha → all | Contract method signatures frozen (the table at the bottom) | Bindings and forms get built against them |
| Sun 16:00 | Misha → Bohdan Che | Mock oracle deployed + its contract ID in `.env` | The app can show a real NAV |
| Sun 16:00 | Den → Misha | `create_offer`, `take_offer`, `repay` merged with tests | First real deploy |
| Sun 16:30 | Misha → Bohdan Che | Repo contract deployed, TS bindings generated, IDs in `.env` | The app switches from mock data to testnet |
| Sun 18:30 | Misha → Den | `check_margin` / `top_up` merged; `margin_call_deadline` set on breach | Den's `default` after the margin window reads it |
| Sun 19:30 | Den → Misha | `default`, `liquidate` merged | Keeper and seed scripts can run the full lifecycle |
| Sun 23:30 | all | Happy path in the UI: offer → take → repay | Gate G3 |
| Mon 06:00 | all | Margin call, default, liquidation in the UI (or by script on camera) | Gate G4 |

If a handoff slips by more than an hour, say so in chat right away and use the cut list in TASKS.md.

---

## Den · Contracts (core flows)

Work in `contracts/repo/src/lib.rs`. `math.rs` already has the formulas and tests; the flows are stubs that return `NotImplemented`. Read NAV only through Misha's `oracle::fresh_nav`, never call the oracle directly.

**G1 · by Sun 16:00**
- [x] Decide the open question in DECISIONS.md: `take_offer` on an offer whose asset was disabled after it was created. Suggested: reject with `AssetNotSupported`, so admin can stop new risk at once. Log it as #23.
- [x] `create_offer` / `cancel_offer`: lender escrows USDC; cancel returns it to the lender only. Reject a missing or disabled asset (#22). *Done when: balance test passes.*
- [x] `take_offer`: full take, the contract computes collateral (#16, #21), snapshots the haircut (#19), fixes debt = principal + full-term interest (#15), atomic DvP. Reject stale NAV and LTV breach. *Done when: success, LTV-reject and stale-reject tests pass.*
- [x] `repay`: fee taken from interest (#3), collateral back, works with stale NAV (#6), also from `MarginCall`. *Done when: lender receives exactly principal + interest − fee.*
- [x] Emit the event for every flow (`OfferCreated`, `RepoOpened`, `Repaid` ...). Bohdan Che reads them for history and Misha's keeper reads them to find open repos.

**G2 · by Sun 19:30**
- [x] `default` / `liquidate`: anyone can call `default` after maturity + grace, or once `margin_call_deadline` (set by Misha's `check_margin`) has passed; only whitelisted liquidators can `liquidate`; pays NAV × (1 − discount); waterfall; `Shortfall` event when proceeds fall short (#4). *Done when: made-whole, surplus and shortfall tests pass.*

**G4 · by Mon 06:00**
- [x] Hardening: auth on every state-changing call, no double take, only valid status transitions, TTL bumps on offers and repos. Take-twice test `take_offer_twice_is_rejected` merged in e1898ca (QA passed); attack fixes A1–A8 merged.

**→ Bohdan Koldun** by Sun 20:00: five lines on the state machine (which call moves a repo from which status to which), for the README diagram.

---

## Misha · Integration, price and margin

You own the price path end to end: oracle → NAV client → margin call → keeper, plus everything that turns the contract into something the app and the demo can use. The AUTH_REQUIRED spike, accounts and funding are done (see the status log in TASKS.md).

**G1 · by Sun 16:00**
- [x] `contracts/repo/src/oracle.rs` **by 14:45**: SEP-40 client, `fresh_nav` with the staleness check (#6, #17), test-only mock. *Done when: Den can call it from `take_offer` in a test.*
- [x] Mock SEP-40 oracle contract in `contracts/oracle`: full trait (`base`, `assets`, `decimals`, `resolution`, `price`, `prices`, `lastprice`) plus admin `set_price`. Same `Asset` shape as Reflector (#22). Deploy it and put the ID in `.env`. *Done when: `lastprice(tBENJI)` returns price + timestamp.*
- [x] Deploy script v0 + TS bindings (see "Right now").

**G2 · by Sun 19:30**
- [x] `contracts/repo/src/margin.rs`, by 18:30: `check_margin` (stale NAV blocks it (#17); a breach (#14) sets `margin_call_deadline` once and moves the repo to `MarginCall`; emits `MarginCall`) and `top_up` (works with stale NAV (#6); clears the call only at initial margin (#20)). *Done when: breach, clear, no-double-call and stale-block tests pass.*
- [x] One-command deploy: build, deploy oracle + repo, `set_asset(tBENJI)` with the demo haircut, `set_liquidator`, authorize the repo contract and liquidator on tBENJI, mint demo balances, write every ID to `.env`. *Done when: a clean deploy takes under 5 minutes.*
- [x] TS bindings: `stellar contract bindings typescript` for the repo and the oracle, committed where Bohdan Che imports them. Regenerate after every contract change and tell him.
- [x] Keeper script (TS): call `check_margin` on open repos every 10 s, then `default` once the margin window or maturity + grace passes; plus a NAV setter CLI (`set-nav 0.97`). *Done when: a margin call fires with nobody touching anything.*

**G3 · by Sun 23:30**
- [x] Read one live Reflector or RedStone testnet SEP-40 feed through the same client, to prove swapping feeds is config only (#2). *Done when: the live price shows next to the mock NAV.* Read by `scripts/keeper/src/feeds.ts` and shown in the app next to the mock NAV, reference only (96d4d61).

**G4 · by Mon 06:00**
- [x] Reset and seed script: 2 open offers + 1 repo close to maturity, so a demo restarts in under 2 minutes.
- [x] Demo time profile in the deploy config (#5): 1 day = 60 s, margin window 120 s, grace 60 s, NAV age 180 s.

**→ Bohdan Koldun** by Mon 06:00: final contract IDs and the run instructions for the README.

---

## Bohdan Che · Design + frontend

Use the design system in [design/](design/README.md): import `design/tokens.css`, then either the Tailwind theme (`design/tailwind.tokens.js`) or the `cv-*` classes. Every component has reference markup in `design/components/<Name>/preview.html`. Square corners, double layer bottom-right, numbers in Source Code Pro.

Until Misha's 16:30 handoff, build against mock data shaped like the contract types (`Offer`, `Repo`, `Status` in `contracts/repo/src/types.rs`), then swap in the bindings.

**G0 · now**
- [x] Scaffold: Next.js or Vite + `@stellar/stellar-sdk` + Freighter, testnet, a role switcher (lender / borrower / liquidator / admin) and the design system wired in. *Done when: the wallet connects and USDC + tBENJI balances show.*

**G1 · by Sun 16:00**
- [x] Offers board: amount, term, APR (also as "T-bill + x%"), asset, haircut from the asset config. *Done when: it reads testnet (mock until 16:30).*

**G2 · by Sun 19:30**
- [x] Create offer (lender) and take offer (borrower) flows. The take screen previews the collateral before signing: `debt = principal × (1 + apr × term / 365 days)`, `collateral = debt / (NAV × (1 − haircut))`, rounded up. *Done when: both transactions succeed from the UI.*

**G3 · by Sun 23:30**
- [x] My positions: maturity countdown, collateral cover bar, status pill, Repay and Top up buttons.
- [x] Admin NAV slider that calls the oracle's `set_price` and shows the feed timestamp. This is how we trigger the margin call on camera.

**G4 · by Mon 06:00**
- [x] Liquidator view: repos in default, Liquidate button. (Fallback: Misha liquidates from a script on camera.)
- [x] A stellar.expert link on every transaction, especially the `take_offer` DvP.

**G5 · by Mon 08:00**
- [ ] 🔄 Polish: empty and loading states, number formatting (7 decimals in, 2 shown for USDC), copy pass with Bohdan Koldun. Empty states, loading skeletons and `fmtAmount` are in; left: copy pass, Offers table clips its Collateral column at 390 px.

**→ Bohdan Koldun** by Mon 06:30: the app URL and a seeded state ready for the video.

---

## Bohdan Koldun · Pitch, docs + QA

You own everything judges see besides the app, and you are the team's first user. Board tag **P** in TASKS.md lists your items by gate.

**Now → Sun 16:00**
- [ ] 15-minute lock-in: one-liner, 6 demo beats, demo time profile. *Done when: everyone can say the one-liner.*
- [ ] Mentor round 1: demand, issuer whitelisting, term vs perpetual. Ask permission to quote. *Done when: one quotable line or a clear no.*
- [ ] Deck outline (9 slides), every number sourced from `docs/collateral-research.md`.

**Sun 16:00 → 23:30**
- [x] README core: architecture diagram, state machine (from Den's five lines), method table, parameters.
- [ ] Video script v1 (6 beats, target 2:30) and submission answers draft, one per rubric line.

**Sun 19:30 → Mon 06:00 · QA**
- [ ] Every 2 hours, click through each role in the app on testnet (lender, borrower, liquidator, admin). Post bugs in chat with role, step, and the stellar.expert link. *Done when: the 6 beats run end to end without help from a dev.*
- [ ] Deck v1 complete.

**Mon 06:00 → 11:30**
- [ ] README final (run steps and contract IDs from Misha), two rehearsals, video + backup take, deck PDF, submit by 11:30.

Throughout: run the status check every 1–2 hours, update TASKS.md, call cuts from the cut list when a handoff slips more than an hour.

---

## Shared reference

**Never cut:** create → take (DvP) → margin call → repay → default → liquidate. These are the 6 demo beats.

**Units:** amounts are `i128` with 7 decimals. NAV is scaled by the oracle's `decimals()`. Interest rounds up, LTV rounds down (#8).

**Contract methods** (`contracts/repo/src/lib.rs`):

| Method | Who calls it | Notes |
|---|---|---|
| `create_offer(lender, collateral_asset, principal, apr_bps, term_secs) → offer_id` | Lender | Escrows USDC |
| `cancel_offer(offer_id)` | Lender | Returns escrow |
| `take_offer(borrower, offer_id) → repo_id` | Borrower | Contract computes collateral; atomic DvP |
| `repay(repo_id)` | Borrower | Works with stale NAV |
| `top_up(repo_id, amount)` | Borrower | Works with stale NAV |
| `check_margin(repo_id) → Status` | Anyone (keeper) | Blocked on stale NAV |
| `default(repo_id)` | Anyone (keeper) | After maturity + grace, or after the margin window |
| `liquidate(liquidator, repo_id)` | Whitelisted liquidator | Blocked on stale NAV |
| `set_asset(asset, config)`, `set_liquidator(who, allowed)` | Admin | Config, no redeploy |
| `config()`, `offer(id)`, `repo(id)`, `asset(addr)`, `is_liquidator(who)` | Anyone | Read only |

**Status:** `Open → MarginCall → Open` (top-up) · `Open/MarginCall → Repaid` · `→ Defaulted → Liquidated`.

**Status updates:** post in chat every 1–2 hours: done, doing, blocked. Bohdan Koldun updates the board.
