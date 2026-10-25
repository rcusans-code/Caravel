# Spike: AUTH_REQUIRED asset held by a contract — **GO**

tBENJI issued with AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED. A minimal vault contract
(`contracts/vault`) moves it through the SAC on testnet.

| Step | Result |
|---|---|
| Borrower deposits 100 tBENJI **before** `set_authorized(vault)` | fails (contract balance starts unauthorized) |
| Issuer calls SAC `set_authorized(vault, true)` | ok |
| Deposit 100 tBENJI | ok, vault balance 100 |
| Withdraw 50 to borrower | ok |
| `set_authorized(vault, false)`, then withdraw 50 | fails (freeze works on contracts) |
| Re-authorize, withdraw 50 | ok, vault balance 0 |

Takeaway for the repo contract: after deploy, the issuer (SAC admin) must call `set_authorized(<repo contract>, true)`
on tBENJI; every G-account that receives tBENJI (borrower, liquidator) needs an issuer-authorized trustline.
Decision 9 fallback not needed.

Testnet IDs: tBENJI SAC `CBC7SGLXRLNFXK5S33XL7PQ2YBT3NMT5W5EOW5PLOMLIIGBNGACKXBXX` · USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` · vault `CBVZDOKRSBI7DKSH7XX5XZ5JM2AIINYU4PIFHAYJLMHB3QJDYCDZ2A4S`
