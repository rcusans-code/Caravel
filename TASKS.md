# Caravel — HackMeridian task board

Hard deadline **Mon 26 Oct 12:00** (no late submissions). Submit target **11:30**.
Tick boxes right in GitHub (edit file → change `[ ]` to `[x]`), or mark in-progress with `🔄` and blocked with `⛔ reason`.

Owners: **C** = Contracts (Soroban dev) · **I** = Integration (assets, oracle, keeper, deploy) · **F** = Frontend · **P** = Pitch & polish (Bohdan) · **T** = whole team

Read [DECISIONS.md](DECISIONS.md) before writing code. Tasks marked ⚠️ implement one of those fixes.

---

## G0 · Spike & setup — Sun 12:00–13:00
Exit: AUTH_REQUIRED go/no-go, repo public, decisions locked.

- [x] **I** ⚠️ AUTH_REQUIRED spike: issue tBENJI (AUTH_REQUIRED + REVOCABLE + CLAWBACK), deploy dummy contract, `set_authorized(contract)` via SAC, transfer in and out. *Done when: go/no-go posted by 13:00*
- [x] **I** ⚠️ Testnet accounts (admin, issuer, lender, borrower, liquidator) + trustlines to **Circle testnet USDC** and tBENJI. Testnet keys in `.env` (gitignored). *Done when: every demo account holds USDC or tBENJI*
- [ ] **C** Contract skeleton: `Offer`, `Repo`, `Status`, `Config`, storage keys (instance = config, persistent = offers/repos), TTL helper, events. *Done when: compiles with stubs*
- [ ] **C** ⚠️ `math.rs` with tests: interest, collateral value, margin threshold, liquidation waterfall incl. fee and shortfall. *Done when: the 3 brief scenarios pass*
- [ ] **F** Frontend scaffold: Scaffold Stellar or Next.js + `@stellar/stellar-sdk` + Freighter, testnet, role switcher (lender / borrower / liquidator / admin). *Done when: wallet connects, balances show*
- [x] **P** Public repo + README skeleton
- [ ] **T** 15-min lock-in on DECISIONS.md, demo time profile, 6 demo beats. *Done when: everyone can say the one-liner*

## G1 · Core DvP — 13:00–16:00
Exit: create / take / repay pass unit tests, mock oracle live.

- [ ] **C** `create_offer` / `cancel_offer` — lender escrows USDC; cancel returns it. *Done when: balance test passes*
- [ ] **C** ⚠️ `take_offer` — atomic DvP; LTV check with NAV; reject stale NAV and wrong asset. *Done when: success, LTV-reject, stale-reject tests*
- [ ] **C** ⚠️ `repay` — fee carved from interest; collateral back; works even with stale NAV. *Done when: lender gets exact offer terms*
- [ ] **I** ⚠️ Mock SEP-40 oracle: full trait (`base`, `assets`, `decimals`, `resolution`, `price`, `prices`, `lastprice`) + admin `set_price`, deployed. *Done when: `lastprice(tBENJI)` returns price + timestamp*
- [ ] **F** Offers board: amount, term, APR, haircut, asset. *Done when: reads testnet*
- [ ] **P** Mentor round 1: demand? issuer whitelisting? term vs perpetual? Ask permission to quote. *Done when: one quotable line or a clear no*
- [ ] **P** Deck outline (9 slides) + every number re-verified with a source

## G2 · Full contract — 16:00–19:30
Exit: margin, default, liquidate tested; one-command deploy.

- [ ] **C** `check_margin` / `top_up` — breach sets `margin_call_deadline` once; top-up clears when healthy. *Done when: breach, clear, no-double-call tests*
- [ ] **C** ⚠️ `default` / `liquidate` — whitelist, pays NAV × (1 − 2%), waterfall, collateral to liquidator, `Shortfall` event when short. *Done when: made-whole, surplus, shortfall tests*
- [ ] **I** One-command deploy: build, deploy oracle + repo, init demo config, authorize contract + liquidator on tBENJI, mint demo balances, write IDs to `.env`. *Done when: clean deploy < 5 min*
- [ ] **I** Keeper script (TS): `check_margin` on open repos every 10 s + NAV setter CLI. *Done when: margin call fires unattended*
- [ ] **F** Create offer + take offer flows, with collateral preview at current NAV and haircut. *Done when: both txs succeed from UI*
- [ ] **P** README core: architecture diagram, state machine, method table, parameters

## G3 · Happy path on testnet — 19:30–00:00
Exit: lender → borrower → repay works in the UI.

- [ ] **F** My positions: maturity countdown, health, status pill, repay + top-up buttons
- [ ] **F** Demo NAV slider (admin) → oracle `set_price`, shows feed timestamp
- [ ] **I** ⚠️ Read one live Reflector/RedStone testnet SEP-40 feed through the same client. *Done when: live price shown next to mock NAV*
- [ ] **P** Video script v1: 6 beats, exact screens, voiceover, timings (target 2:30)
- [ ] **P** Submission answers draft, one per rubric line

## G4 · Stress flows — 00:00–06:00
Exit: margin call, default, liquidation in the UI.

- [ ] **F** Liquidator view (fallback: liquidate from a script on camera)
- [ ] **F** stellar.expert links on every tx, especially the `take_offer` DvP
- [ ] **C** Hardening: auth on every mutating call, double-take guard, status transitions, TTL bumps
- [ ] **I** Reset & seed script: 2 offers + 1 open repo near maturity. *Done when: demo restart < 2 min*
- [ ] **P** Deck v1 complete

## G5 · Freeze — 06:00–08:00 (feature freeze 08:00)

- [ ] **F** UI polish + copy pass: empty/loading states, number formatting
- [ ] **P** README final: run instructions, contract IDs, built-during-hackathon log, risks, oracle swap guide
- [ ] **T** Two full rehearsals of all 6 beats on a fresh seed

## G6 · Ship — 08:00–11:30

- [ ] **P** Record video 2–3 min + backup take; unlisted link tested logged out
- [ ] **P** Final deck → PDF
- [ ] **P** Submit by **11:30**; open every link in a private window

---

## Cut list (cut from the top if a gate slips > 1h)
1. Passkey smart wallet
2. Dutch auction (keep fixed NAV − 2%)
3. Auto-roll
4. DeFindex lender vault / insurance fund
5. Liquidator UI (script on camera instead)
6. `cancel_offer` in UI (keep in contract)
7. Live SEP-40 feed read (keep strict interface + README swap guide)

**Never cut:** create → take (DvP) → margin call → repay → default → liquidate

## Status log
- **Sun 12:01** — Repo created, board pushed. All tasks to do.
- **Sun 13:05** — AUTH_REQUIRED spike: **GO** (contract authorized via SAC `set_authorized`, transfer in/out and freeze verified, see `spikes/auth/README.md`). 5 testnet accounts funded: lender 500 USDC, liquidator 500 USDC, borrower 100 USDC + 1000 tBENJI. Real Circle USDC bought on the testnet DEX (no faucet). Keys in `.env` (gitignored, share out of band).
