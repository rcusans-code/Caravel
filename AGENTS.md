# Caravel Agent Brief

## Repo Map
- `contracts/repo`: Caravel repo loan contract (Soroban/Rust).
- `contracts/oracle`: SEP-40 mock oracle contract.
- `contracts/spiko-mock`: Spiko-style permissioned token mock.
- `packages/caravel-repo` & `packages/caravel-oracle`: generated TypeScript bindings.
- `app/`: Vite + React web interface.
- `scripts/keeper`: TypeScript keeper bot and CLI tools.
- `scripts/deploy.sh`: testnet deploy and configuration script.
- `deployments/testnet.json`: authoritative source of deployed contract IDs and parameters.
- `DECISIONS.md`: numbered architectural rulings (propose changes in chat first, then edit).
- `scripts/README.md`: deployment and keeper operational guide.

## Commands
Run all commands from the repo root unless specified otherwise:
- Rust tests: `cargo test --workspace`
- Soroban contracts build: `stellar contract build`
- Frontend dependencies & bindings build: `npm --prefix app ci` (or `cd app && npm ci`)
- Frontend typecheck: `cd app && npx tsc --noEmit`
- Keeper dependencies & typecheck: `cd scripts/keeper && npm ci && npx tsc --noEmit`
- Keeper tests: `cd scripts/keeper && npm test`
- Package execution: run `npx tsx` or `npx ts-node` from inside a directory containing `node_modules`.

## Traps & Practices
- Contract ABI changes: regenerate TypeScript bindings with `stellar contract bindings typescript --contract-id <id> --output-dir <dir> --overwrite` (matching `deployments/testnet.json` and `scripts/deploy.sh`), or run `scripts/deploy.sh`.
- GitHub CLI: always use `gh issue view <number> --json title,body,comments` (bare `gh issue view` queries deprecated classic projects and fails on older gh versions).
- Test snapshots: `contracts/*/test_snapshots/*.json` are tracked Soroban ledger snapshots rewritten by `cargo test`. Exclude them from review diffs (`git diff -- . ':!**/test_snapshots/**'`). Resolve merge conflicts by checking out either branch's snapshot version and re-running `cargo test --workspace`.
- Environment & keys: `.env` is committed intentionally with TESTNET burner keys. Never print `.env`, never commit mainnet keys, and never copy secret keys into documentation or PR descriptions.
- Keeper timing: do not wait on a live keeper to observe maturity or liquidation defaults in testing; configure short loan terms or use the scratch test harness.
