# Ecosystem claims in the landing page and docs audit

Commit audited: [6827168](https://github.com/rcusans-code/Caravel/tree/6827168115683ecc43f4ddcc8865e65160490210) (26 Oct 2026). Status checked against main at [ba3c054](https://github.com/rcusans-code/Caravel/commit/ba3c054). Line numbers are at the audited commit.

Scope: every ecosystem claim in the reviewer-facing copy: `site/index.html` (the landing page), `README.md`, `INTRO.md`, `docs/numbers.md`, `docs/pitch-deck.md` and the pitch deck PDF. The method was the stellar-content-auditor playbook served by Stellar Raven (https://raven.stellar.org): resolve every project named to its ecosystem directory entry, check names, and back every factual claim with a dated source or mark it unverified. Claims were checked against Raven's project directory and indexed content, its stablecoin and hackathon data, the Stellar docs, live Horizon and RPC reads (for example BENJI's holder counts and USDY's issuer flags) and the testnet fee history. An independent QA pass re-read every source live and re-rated severity.

Bottom line: most claims hold. All 13 Stellar projects named resolve to their directory entries, the sourced figures (RWA totals, Spiko and BENJI sizes, zero contracts holding BENJI) match live data, and no citation was invented. QA confirmed all 15 findings: one positioning gap (the Ascend × M1X repo on Stellar was not mentioned), four statements that were wrong as written, and a set of stale, unscoped or placeholder items. All copy fixes are on main, in the landing page, the README, INTRO, the deck notes and the deck PDF. The one code item, a per-asset oracle, is on the roadmap.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| H1 | Medium | Spiko and Franklin called "the two largest issuers" | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| H2 | High | No mention of the Ascend × M1X repo on Stellar | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) and [31b9102](https://github.com/rcusans-code/Caravel/commit/31b9102) |
| M1 | Medium | USDY grouped with permissioned money-market funds | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| M2 | Low | "Switching price providers is a setting" | Partly fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| M3 | Medium | "Every dollar token on Stellar" is backed by Treasuries | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| M4 | Low | Spiko's $1.97B presented as collateral eligible at launch | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| M5 | Medium | FAQ says the lender is always paid in full | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| L1 | Low | USDXX yield labelled as the yield the borrower keeps | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| L2 | Medium | Stale Blend rate from a pool closed to new borrowing | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| L3 | Low | "Under a cent" stated as an absolute | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| L4 | Low | Non-affiliation line covers only four names | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| L5 | Low | Placeholders and dead links on the landing page | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| L6 | Low | USDC described as "worth exactly $1" | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |
| L7 | Low | Deck says Spiko "offers" its tokens as loan collateral | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) and [31b9102](https://github.com/rcusans-code/Caravel/commit/31b9102) |
| L8 | Low | Hackathon category called a "path" | Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) |

Status counts: Fixed 14 · Partly fixed 1 · Roadmap 0 · Won't fix 0 · Open 0.

### H1: Spiko and Franklin called "the two largest issuers"

- Severity: Medium (reported High; lowered on QA review)
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:638`
- Finding: The landing FAQ called Spiko and Franklin Templeton "the two largest issuers on Stellar". The repo's own `docs/numbers.md:16-18` ranks Ondo second ($536.91M) ahead of Franklin ($507.39M), and Raven's stablecoin data gave USDY $537.6M. The deck had the right order, so the landing contradicted the deck. QA lowered it to Medium: a 6% gap in one FAQ answer.
- Fix: the FAQ now says "two of the three largest issuers on Stellar". Check: `git grep -n 'two of the three largest' ba3c054 -- site/index.html`.

### H2: No mention of the Ascend × M1X repo on Stellar

- Severity: High
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) (README, INTRO, `docs/pitch-deck.md`) and [31b9102](https://github.com/rcusans-code/Caravel/commit/31b9102) (pitch deck PDF)
- Location: `README.md:37`, `INTRO.md:10`, `docs/pitch-deck.md:18`, `site/index.html:409`, `site/index.html:418`
- Finding: On 23 Oct 2026 stellar.org published ["Ascend and M1X Global Complete First Institutional Repo on Stellar Using USDM1 Secured Sovereign Bond"](https://stellar.org/press/ascend-and-m1x-global-complete-first-institutional-repo-on-stellar-using-usdm1-secured-sovereign-bond): 72 automated hourly rolls, SOFR+10bp, a 2% haircut, SAC tokens on both legs. The repo and the deck did not mention it (`git grep -i 'ascend\|m1x\|usdm1'` found nothing), and the README and INTRO implied that repo on Stellar was new ("Caravel puts it on-chain", "We're bringing it on-chain"). No line was false, but the competition table left out the one live precedent, published by SDF three days before judging, and it uses the same 2% haircut.
- Fix: the README Insight, INTRO and deck slide 10 add one positioning line: Ascend × M1X is a bilateral institutional repo on one sovereign-bond token, rolled hourly; Caravel is the open order book (any USDC lender, multi-issuer permissioned fund collateral, daily-NAV margin, issuer-approved liquidation). No "first" claim. The README links the press release through `docs/numbers.md`. The deck PDF's slide 10 has the same line. Checks: `git grep -n 'Ascend' ba3c054 -- README.md INTRO.md docs/pitch-deck.md`; `git show ba3c054:docs/caravel-pitch.pdf > deck.pdf && pdftotext deck.pdf - | grep -n 'Ascend'`.

### M1: USDY grouped with permissioned money-market funds

- Severity: Medium
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:585`, `site/index.html:644`, `docs/pitch-deck.md:25`
- Finding: The collateral table listed Ondo USDY under "US T-bills, government money-market funds" with the main risk "Approved holders only", and the FAQ said fund tokens can only be held by approved wallets. Ondo describes USDY as a yield-bearing stablecoin backed by US Treasuries. Live Horizon showed its issuer with `auth_required: false` and 58 contracts holding 5,876,728.6 USDY, and RedStone already publishes a SEP-40 USDY feed for Stellar lending. USDY is freely transferable and already used as collateral.
- Fix: USDY has its own row on the landing page and in the deck notes ("Treasury-backed yield stablecoin; freely transferable (no issuer approval); priced by RedStone SEP-40"), and the FAQ line is scoped to "BENJI and Spiko fund tokens". Check: `git grep -n 'Treasury-backed yield stablecoin' ba3c054 -- site/index.html docs/pitch-deck.md`.

### M2: "Switching price providers is a setting"

- Severity: Low (reported Medium; lowered on QA review)
- Status: Partly fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037). The copy is fixed; a per-asset oracle in the contract is roadmap ([R12 Production profile and contract roadmap](../../README.md#production-notes-raven-audit-roadmap)).
- Location: `site/index.html:564`, `README.md:60`, `README.md:91`, `README.md:224`, `contracts/repo/src/lib.rs:50-55`
- Finding: The landing said switching providers "is a setting, not a rebuild", and the README called it "a config change". `Config.oracle` is written only in the constructor, with no setter, so switching feeds means deploying a new contract, and live repos stay on the old one. There is also one oracle for all assets. Per the Stellar docs, RedStone's SEP-40 contract covers BENJI, USDY and CETES but no Spiko asset, and the Chainlink proxy is not SEP-40 compatible. QA lowered it to Low: the wording is literally true at deploy time, and the misleading part is the implication that live repos can switch. QA added that Chainlink Data Feeds went live on Stellar on 14 Oct, so one global SEP-40 oracle cannot serve Spiko and BENJI at the same time.
- Fix: the landing and README now say "any SEP-40 feed, chosen at deploy (RedStone already publishes BENJI NAV on Stellar; Chainlink, live since 14 Oct, is not SEP-40)", and the README says a deployed contract keeps its feed. Check: `git grep -n 'chosen at deploy' ba3c054 -- site/index.html README.md`. The code half (a per-asset `oracle` in `AssetConfig`, changed only behind the timelock) is roadmap R12.

### M3: "Every dollar token on Stellar" is backed by Treasuries

- Severity: Medium
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:391`
- Finding: The lede of the "Our approach" section said "Every dollar token on Stellar is ultimately backed by short-dated US Treasuries." Raven's stablecoin data lists 15 live USD-pegged tokens on Stellar, including USDT0 (live since 2 Sep 2026; Tether's reserves are not T-bills only), and the directory indexes a synthetic dollar and a crypto-lending-backed USDC. The absolute "every" is false.
- Fix: "The largest dollar tokens on Stellar (USDC, PYUSD, USDY, BENJI) are backed mostly by short-dated US Treasuries." Check: `git grep -n 'The largest dollar tokens on Stellar' ba3c054 -- site/index.html`.

### M4: Spiko's $1.97B presented as collateral eligible at launch

- Severity: Low (reported Medium; lowered on QA review)
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:378`, `site/index.html:591`
- Finding: The headline statistic showed "$1.97B in Spiko's nine Treasury and money-market funds… No lender here accepts them". Per `docs/numbers.md:36`, $1.638B (83%) of that is the swap-based SAFO classes, which Caravel keeps disabled until due diligence; the T-bill funds eligible at launch are $307.9M. QA lowered it to Low: the collateral table and a nearby line already state the split, and SAFO is a money-market fund, so only the headline statistic lacked it.
- Fix: the headline statistic adds "($308M in T-bill funds eligible at launch; SAFO after due diligence)". Check: `git grep -n '308M in T-bill funds eligible at launch' ba3c054 -- site/index.html`.

### M5: FAQ says the lender is always paid in full

- Severity: Medium
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:642`
- Finding: The FAQ "What if the borrower doesn't repay?" said "The lender is paid the amount due, and anything left over goes back", with no condition. The same page, the README and INTRO describe the Shortfall case, where the lender gets all the proceeds but less than the debt. An earlier review had fixed the other places; this FAQ line was the one left.
- Fix: "The lender is paid first: in full while NAV stays within the haircut, otherwise all the proceeds, and a Shortfall is recorded on-chain." Check: `git grep -n 'in full while NAV stays within the haircut' ba3c054 -- site/index.html`.

### L1: USDXX yield labelled as the yield the borrower keeps

- Severity: Low
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:543`, `site/index.html:236`, `README.md:56`, `README.md:294`
- Finding: The carry box said "Treasury fund yield you keep (USDXX, 7-day)". USDXX is BlackRock's Circle Reserve Fund, which only Circle holds; a Caravel borrower holds BENJI or Spiko, never USDXX. The citation was for a different fund than the claim.
- Fix: the carry box reads "US T-bill yield (USDXX 7-day, proxy)", the header pill "US T-bill yield (USDXX proxy)" with a dated tooltip, and the README adds "(USDXX 7-day, a T-bill proxy)". Check: `git grep -n 'USDXX 7-day, proxy' ba3c054 -- site/index.html`.

### L2: Stale Blend rate from a pool closed to new borrowing

- Severity: Medium (reported Low; raised on QA review)
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:545`, `README.md:56`, `README.md:294`
- Finding: The landing and README quoted "6.69% USDC lending rate on Blend, 6 Oct", 20 days older than every other figure. The footnote said DefiLlama but linked to a secondary page (WhaleHub), and QA confirmed that the same page reports Blend's Fixed V2 pool "on ice" with new borrowing blocked since 8 Oct. The carry pitch quoted a pool its own source reported as frozen to new borrowing, which is why QA raised it.
- Fix: re-read on 26 Oct from DefiLlama (supply APY 5.70%, 30-day mean 6.71%). The landing shows "5.70%, USDC supply rate, Blend Fixed pool, 26 Oct; it floats", with the carry note adjusted to about 0.5%; the footnote links the DefiLlama pool page and the WhaleHub note on paused borrowing. The README says "Blend's Fixed pool paid 5.70% on 26 Oct per DefiLlama, and has blocked new borrowing since 8 Oct". Check: `git grep -n '6.69%' ba3c054 -- site/index.html README.md` finds nothing.

### L3: "Under a cent" stated as an absolute

- Severity: Low
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:507`, `site/index.html:565`, `site/index.html:645`, `INTRO.md:42`
- Finding: The copy said "Network fee under $0.01" and "under a cent per transaction". That holds for the current deploy, but on the testnet history 12 of 30 `take_offer` calls cost more than a cent (max 141.35 XLM, about $23.87), mostly restore and TTL fees, and the README itself cites about 240 testnet XLM a day for TTL extension.
- Fix: "typically under a cent / $0.01" in every place. Check: `git grep -n 'typically under' ba3c054 -- site/index.html INTRO.md`.

### L4: Non-affiliation line covers only four names

- Severity: Low
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:667`
- Finding: The disclaimer named only Franklin Templeton, Circle, Spiko and SDF, while the page also names Ondo, Etherfuse, BlackRock, Blend, Aave, DefiLlama and WhaleHub.
- Fix: it adds "or any other company or protocol named on this site". Check: `git grep -n 'any other company or protocol named on this site' ba3c054 -- site/index.html`.

### L5: Placeholders and dead links on the landing page

- Severity: Low
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `site/index.html:632`, `site/index.html:659-661`, `site/index.html:681`
- Finding: Template placeholders were visible on the live landing page: `mailto:[CONTACT EMAIL]`, `[LEGAL ENTITY NAME], [REGISTERED ADDRESS]`, and footer links to anchors that did not exist (`#x`, `#discord`, `#press`, `#docs`, `#contracts`, `#terms` and others).
- Fix: the contact link is filled; the Developers links go to existing README sections; the empty Legal and social columns are removed; the footer reads "© 2026 Caravel team". Every remaining in-page anchor has a target. Check: `git grep -n 'CONTACT EMAIL\|LEGAL ENTITY\|#discord' ba3c054 -- site/index.html` finds nothing.

### L6: USDC described as "worth exactly $1"

- Severity: Low
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `INTRO.md:34`
- Finding: INTRO described USDC as "a token worth exactly $1". USDC is redeemable 1:1 with Circle; its market price can and has moved (March 2023).
- Fix: "a dollar token Circle redeems 1:1". Check: `git grep -n 'Circle redeems 1:1' ba3c054 -- INTRO.md`.

### L7: Deck says Spiko "offers" its tokens as loan collateral

- Severity: Low
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037) (`docs/pitch-deck.md`) and [31b9102](https://github.com/rcusans-code/Caravel/commit/31b9102) (pitch deck PDF)
- Location: `docs/pitch-deck.md:17`
- Finding: The deck said "Spiko itself offers its tokens as collateral for on-chain loans and invites partners". Spiko's own page ([spiko.io/use-cases/web3](https://www.spiko.io/use-cases/web3)) says "you can use them for example as collateral… Please contact the Spiko team". Spiko permits and invites this use; it does not offer loans.
- Fix: "Spiko says its shares can be used as on-chain collateral and asks partners to get in touch", in the deck notes and on slide 11 of the deck PDF. Checks: `git grep -n 'Spiko says its shares' ba3c054 -- docs/pitch-deck.md`; `pdftotext deck.pdf - | grep -n 'Spiko says'`.

### L8: Hackathon category called a "path"

- Severity: Low
- Status: Fixed in [d454037](https://github.com/rcusans-code/Caravel/commit/d454037)
- Location: `README.md:10`
- Finding: The README said "Genesis path". HackMeridian 2026 lists Genesis as a category; the track names, dates and Lisbon venue all matched.
- Fix: "Genesis category". Check: `git grep -n 'Genesis category' ba3c054 -- README.md`.

## What was checked

| Check | Result | Finding |
|---|---|---|
| Every Stellar project named resolves to its directory entry (13 of 13) | pass | |
| Names match the canonical titles | pass | |
| Social handles match the directory | fail (footer links were placeholders) | L5 |
| Every factual claim has a source or is marked unverified | fail | H1, M1, M2, M3, L1, L2 |
| No invented citations (footnotes real; BENJI 0 contracts and 434,724,260.7 authorized re-read live) | pass | |
| Quotes are verbatim, not paraphrased | partial | L7 |
| Time-sensitive numbers dated | fail | L2 |
| SCF funding claims | N/A (none in scope) | |
| Live precedents in the same lane mentioned | fail | H2 |
| RWA totals ($3.03B on Stellar, $133K in DeFi) | pass (method-dependent, dated) | |
| Spiko $1.97B and fund sizes; BENJI $434.7M | pass (framing) | M4 |
| Issuer rankings | fail | H1 |
| USDY described correctly | fail | M1 |
| Oracle switching | fail | M2 |
| Dollar token backing | fail | M3 |
| Liquidation payout wording | fail | M5 |
| Fees, settlement time (about 5 s), protocol 23 auto-restore | pass (fees "typically") | L3 |
| Spiko token decimals (5), real Circle testnet USDC, Reflector 14 decimals | pass | |
| Aave Horizon model (issuer-allowlisted suppliers, whitelisted liquidators) | pass | |
| Blend size and rank; Blend rate | pass; fail (rate stale) | L2 |
| Hackathon details | pass (category wording) | L8 |
| Disclaimer and footer | fail | L4, L5 |

## Not re-reported

An earlier internal review had already fixed three copy issues before this audit: README contract IDs are generated from the deployment file, the landing page's ticker, hero and NAV come from the live order book, and the Shortfall case is stated on the landing page and in INTRO (only the FAQ line in M5 was left).
