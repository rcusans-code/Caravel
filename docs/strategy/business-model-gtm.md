# Caravel: business model and go-to-market

As of 2026-10-25. Source: Misha's notes (shared in chat, Russian original), not yet checked against outside sources. Contract fee logic: repo `DECISIONS.md` #3 (fee carved from interest).

## Revenue

1. **Fee on interest (main income).** Take e.g. 10% of the interest the borrower pays the lender (Aave model). Already in the contract: fee → treasury on repay.
   - Avg $50M in repo at 5% → $2.5M interest/yr → $250k to Caravel.
   - $500M → $2.5M/yr.
   - Repo is a volume business with thin margin: without hundreds of millions outstanding, revenue is small.
2. **Share of liquidations.** Liquidator buys collateral at NAV −2%; Caravel keeps part of the discount (e.g. 0.5%). Small but free.
3. **B2B / white-label.** Wallets, fintechs and issuers embed Caravel repo via API; subscription or fee share (DeFindex model).
4. **RWA issuers.** Franklin, Etherfuse, Spiko benefit when their token is pledgeable (fewer redemptions, more useful token); they may pay for integration or subsidise rates.
- **Start-up funding:** SCF (Stellar Community Fund) grants. Not revenue; covers year one.

## First users

Core problem: need lenders and borrowers at once. Advantage: the first deal needs one lender and one borrower, not a multi-million pool. First deals done by hand, OTC-style.

**Borrowers (RWA holders)**
- One issuer partnership. Best start: Etherfuse (USTRY/CETES): tokens already in Stellar DeFi, active team, brings its holders.
- Anchors and payment companies on Stellar: hold cash reserves, regularly need settlement liquidity. Ideal 7–30 day borrower.

**Lenders (USDC holders)**
- Market makers and OTC desks: idle USDC. Misha works in market making → direct line to first lenders; show this to judges.
- DeFindex as a strategy: "fixed yield on RWA repo" inside their vault → reach their wallet partners without our own frontend.
- Stellar Development Foundation as first lender: SDF is pushing RWA in DeFi (~$3B tokenized vs ~$2M in lending). Asking it to seed the first $1–2M is realistic.

**Launch incentives:** 0% fee for the first 3–6 months. No token, no points (a minus for institutions).

## GTM slide

"First 90 days: 1 asset (USTRY), 1 issuer partner, 5 hand-picked counterparties, $1M in repo." Concrete and doable; judges prefer this to "capture a $3B market".

## Open tension (note, 2026-10-25)

USTRY is freely transferable and already accepted as collateral by XOXNO Lending and Orbit CDP (see `stellar-rwa-gap-analysis.md`). Starting with USTRY proves the repo mechanics but competes where others already are; the unserved gap is allowlisted assets (BENJI, Spiko). The slide could name USTRY as the launch asset and BENJI/Spiko as the next step that only Caravel serves.
