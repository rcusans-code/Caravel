# SCF interest form — Caravel draft (2026-10-26)

Target: SCF #46 Build, Open track. Interest form ASAP; round deadline 8 Nov 2026.
Source: caravel-pitch.pdf (11 slides). Field names guessed; map onto the real form.

**Project:** Caravel — repo for RWAs on Stellar
**One-liner:** Fixed-rate USDC loans against tokenized Treasury and money-market fund shares, priced off daily NAV, settled atomically on Soroban.

**Problem:** About $3B of fund shares sit on Stellar (Spiko, Ondo, Franklin BENJI); only about $133K of it is used in DeFi (DefiLlama, 25 Oct 2026). Pool lenders liquidate 24/7, but these shares are priced once a day, permissioned, and redeemable only through the issuer, so no on-chain lender takes them.

**Solution:** Term repo. Lender escrows USDC at a fixed rate and term; borrower's shares go into escrow and USDC comes out in one atomic transaction; a keeper checks margin once a day on NAV; at maturity, repay or default to a whitelisted liquidator who buys at NAV −2% and redeems with the issuer. Lenders never hold fund shares.

**Why Stellar:** The RWA issuers are already here; SAC authorization lets the issuer admit the contract, so liquidation stays compliant.

**Stage:** Working on testnet (Circle testnet USDC, tBENJI): take, margin call, top-up, default, liquidation. Built at HackMeridian 2026, Lisbon.
**Links:** caravel.fi/app · github.com/rcusans-code/Caravel · pitch deck (attach PDF)

**Team (all founders):**
- Denys Nichoha — CEO — about 10 years in crypto. [prior projects/companies + link]
- Mykhailo Benych — CTO — software engineer (BSc Computer Software Engineering, Lviv Polytechnic); builds production LLM/agent systems and cloud backends (AWS, Kubernetes, TypeScript/Python); wrote Caravel's Soroban contracts. [LinkedIn]
- Bohdan Chernenko — CPO — product marketing; designed and built Caravel's app. [LinkedIn] · github.com/rcusans-code
- Bohdan Protsiv — CBDO — software engineer; leads partner and issuer outreach. [link]

**What the award funds (draft milestones):**
1. Security audit (via Audit Bank) and hardening of the contracts.
2. First mainnet issuer integration (Spiko or Franklin BENJI), including liquidator onboarding.
3. Mainnet beta, with seeded first offers and wallet/DefiLlama listings.
4. Lender onboarding: market makers, DeFindex vaults.

**Ask:** [amount — Misha to set; Build max is $150K in XLM]
**Contact:** curiousradical@proton.me
