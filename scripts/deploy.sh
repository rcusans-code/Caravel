#!/usr/bin/env bash
# Caravel one-command testnet deploy (v0).
#
#   scripts/deploy.sh            # build, deploy what changed, (re)apply config
#   scripts/deploy.sh --fresh    # force new oracle + repo contracts
#   NAV=0.97 scripts/deploy.sh   # also push a tBENJI price (default: 1.00, only if none set)
#   SAFO_NAV=1.02 scripts/deploy.sh   # same for tSAFO
#   SPIKO_FEED=1 scripts/deploy.sh    # tSAFO = eurSAFO mirror, priced from Spiko (see below)
#   scripts/deploy.sh --preflight     # run the .env guards only, no build, no tx
#   scripts/deploy.sh --no-winddown   # keep a superseded repo contract open
#   PREBUILT_WASM_DIR=dir scripts/deploy.sh  # deploy attested wasm (attest.yml), no build
#   scripts/deploy.sh --plan          # print every tx this run would send; send nothing
#   NETWORK=mainnet scripts/deploy.sh --plan  # mainnet profile, plan only (lib/mainnet-plan.sh)
#
# Keys (Raven R10): ADMIN_*, GUARDIAN_*, ISSUER_*, FEEDER_* come from the
# untracked ~/.local/lib/caravel/.env (CARAVEL_KEYS_FILE) when it exists,
# else from the tracked .env (testnet burner keys; scripts/lib/keys.sh).
# Mainnet never reads a tracked key and supports only --plan.
#
# Guards (Raven R4): USDC_ASSET / TBENJI_ASSET are required and must derive
# to USDC_SAC / TBENJI_SAC; a failed tBENJI authorization of the repo contract
# stops the run. Provenance: contracts are built with SEP-46 meta
# source_repo + commit_sha; reuse compares wasm hashes without that meta
# (scripts/wasm-code-hash.py). Wind-down: when a new repo contract replaces
# REPO_ID, the old one goes into testnet.json "superseded" and
# scripts/winddown.sh pauses new repos on it and cancels the offers our keys
# own (UA-05).
#
# Idempotent: an existing ORACLE_ID / REPO_ID from .env is kept when its
# on-chain wasm matches the fresh build; otherwise a new contract is deployed.
# Admin steps (price, set_asset, the liquidator whitelist, issuer authorization) are
# read first and only sent when the on-chain value differs.
#
# Collateral #2 is tSAFO (issue #20): a Spiko-style mock token
# (contracts/spiko-mock, allowlist on every transfer, no approve, 5 decimals)
# with ISSUER as its admin. The script allowlists the repo contract, the
# liquidator and the demo wallets (+ TSAFO_HOLDERS), mints demo tSAFO to the
# borrower (+ TSAFO_HOLDER_MINT to each holder), prices it and registers it with
# set_asset at SAFO_HAIRCUT_BPS.
#
# SPIKO_FEED=1 (command line or .env) makes tSAFO the testnet mirror of
# eurSAFO with a production-shaped feed (DECISIONS #39 draft): the oracle
# stamps it with Spiko's publication time (`set_source_timed`, then only
# `set_price_at`), the first price is Spiko's latest eurSAFO NAV x the
# same-day EUR/USD rate (`npm run spiko-nav -- eurSAFO --once`, needs
# `npm ci` in scripts/keeper), and its defaults follow
# docs/research/spiko-nav/size.py: NAV age 96 h, band 500, settle 1 day,
# trigger 2,050 (haircut 3,000 unchanged). nav-keeper.sh and
# `keeper --refresh-nav` skip it; caravel-spiko-nav.service feeds it.
#
# Reads keys and IDs from <repo>/.env; writes ORACLE_ID, REPO_ID, TSAFO_ID,
# DEPLOYED_AT back to it, writes the public deployments/testnet.json for the app
# (and the README "Testnet deployment" table from it, scripts/readme-ids.py) and
# regenerates TS bindings in packages/ when a contract ID changes.
#
# Guardian (#33): its own key, not ADMIN. With no GUARDIAN_ADDRESS in .env, the
# first run that deploys a repo contract generates a funded testnet key and
# writes GUARDIAN_ADDRESS / GUARDIAN_SECRET to .env. A reused repo keeps its
# on-chain guardian; rotating it on-chain (propose_guardian / execute_guardian,
# Raven R6) without updating .env makes the next run see a config mismatch and
# redeploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_DEFAULT=0; [[ -z "${ENV_FILE:-}" ]] && ENV_FILE_DEFAULT=1
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
REQ_NETWORK="${NETWORK:-}"   # the caller's, before the .env (NETWORK=testnet) is sourced
OUT_JSON="$ROOT/deployments/testnet.json"
WASM_DIR="$ROOT/target/wasm32v1-none/release"

FRESH=0 PREFLIGHT=0 PLAN=0 WINDDOWN="${WINDDOWN:-1}"
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --preflight) PREFLIGHT=1 ;;
    --plan) PLAN=1 ;;
    --no-winddown) WINDDOWN=0 ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

T0=$(date +%s)
log()  { printf '[%3ss] %s\n' "$(( $(date +%s) - T0 ))" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }
# shellcheck source=lib/deploy-guards.sh
source "$ROOT/scripts/lib/deploy-guards.sh"
# shellcheck source=lib/keys.sh
source "$ROOT/scripts/lib/keys.sh"

# --- mainnet: plan only, never the tracked .env (Raven R10, R12 UA-07) ----------
is_mainnet() { [[ "$1" =~ ^(mainnet|pubnet|public)$ ]]; }
if is_mainnet "$REQ_NETWORK"; then
  (( PLAN )) || die "NETWORK=$REQ_NETWORK supports only --plan: this script prints the mainnet txs and never sends one"
  (( FRESH || PREFLIGHT )) && die "NETWORK=$REQ_NETWORK takes --plan only"
  # shellcheck source=lib/mainnet-plan.sh
  source "$ROOT/scripts/lib/mainnet-plan.sh"
  mainnet_plan
  exit $?
fi

# --- params (demo time profile, DECISIONS.md #3 #4 #5 #18) ------------------
# Testnet only: set after the mainnet branch, which has its own profile.
FEE_BPS="${FEE_BPS:-1000}"                       # 10% of interest (#3)
LIQ_DISCOUNT_BPS="${LIQ_DISCOUNT_BPS:-100}"      # 1% liquidator discount, production value (#35, docs/config-tuning.md §4)
HAIRCUT_BPS="${HAIRCUT_BPS:-300}"                # 3% tBENJI haircut, > discount (#18)
# SPIKO_FEED is read from the .env too (it is sourced only after these defaults).
SPIKO_FEED="${SPIKO_FEED:-$(sed -n 's/^SPIKO_FEED=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)}"
if [[ "$SPIKO_FEED" == 1 ]]; then # eurSAFO params, docs/research/spiko-nav/size.py
  SAFO_MAX_NAV_AGE_SECS="${SAFO_MAX_NAV_AGE_SECS:-345600}" # 96 h of Spiko publication time (#25)
  SAFO_NAV_MOVE_BPS="${SAFO_NAV_MOVE_BPS:-500}"            # > 369 bps 20-print spread, > 473 bps EUR/USD day (#31)
  SAFO_BAND_SETTLE_SECS="${SAFO_BAND_SETTLE_SECS:-86400}"  # one NAV day (#41)
  SAFO_MARGIN_TRIGGER_BPS="${SAFO_MARGIN_TRIGGER_BPS:-2050}" # 100 + 1,885 worst week (S&P x EUR/USD) + 50
fi
SAFO_HAIRCUT_BPS="${SAFO_HAIRCUT_BPS:-3000}"     # 30% tSAFO, Tier 5 (testnet only, DECISIONS #29)
MARGIN_TRIGGER_BPS="${MARGIN_TRIGGER_BPS:-200}"  # tBENJI margin call at debt > value × 98%; discount ≤ trigger < haircut (#35)
SAFO_MARGIN_TRIGGER_BPS="${SAFO_MARGIN_TRIGGER_BPS:-2000}" # tSAFO margin call at debt > value × 80%: own value, not tBENJI's (#35)
TSAFO_DECIMALS="${TSAFO_DECIMALS:-5}"            # Spiko tokens use 5 (mainnet eurSAFO decimals())
TSAFO_BORROWER_MINT="${TSAFO_BORROWER_MINT:-2000}" # whole tSAFO minted to BORROWER when it holds none
TSAFO_HOLDER_MINT="${TSAFO_HOLDER_MINT:-200}"       # whole tSAFO minted to each TSAFO_HOLDERS address when it holds none
DAY_SECS="${DAY_SECS:-60}"                       # 1 day = 60 s (#5)
MARGIN_WINDOW_SECS="${MARGIN_WINDOW_SECS:-120}"
GRACE_SECS="${GRACE_SECS:-60}"
TIMELOCK_SECS="${TIMELOCK_SECS:-120}"             # loosening risk settings waits 2 demo days (#33)
MAX_NAV_AGE_SECS="${MAX_NAV_AGE_SECS:-180}"     # tBENJI NAV staleness, per asset (#25)
SAFO_MAX_NAV_AGE_SECS="${SAFO_MAX_NAV_AGE_SECS:-$MAX_NAV_AGE_SECS}" # tSAFO NAV staleness (#25)
NAV_MOVE_BPS="${NAV_MOVE_BPS:-2500}"             # tBENJI NAV sanity band; demo wide enough for the 0.90-1.10 slider (#31)
SAFO_NAV_MOVE_BPS="${SAFO_NAV_MOVE_BPS:-$NAV_MOVE_BPS}" # tSAFO NAV sanity band (#31)
MAX_OPEN_DEBT="${MAX_OPEN_DEBT:-100000}"          # tBENJI exposure cap, whole USDC (#32)
SAFO_MAX_OPEN_DEBT="${SAFO_MAX_OPEN_DEBT:-50000}" # tSAFO exposure cap, whole USDC (#32)
BAND_SETTLE_SECS="${BAND_SETTLE_SECS:-1200}"      # tBENJI: a NAV past the band is accepted after it stood 20 min (prod 86400)
SAFO_BAND_SETTLE_SECS="${SAFO_BAND_SETTLE_SECS:-$BAND_SETTLE_SECS}" # tSAFO band settle time
ORACLE_DECIMALS=14                               # same as Reflector
ORACLE_RESOLUTION=60
ORACLE_BASE='{"Other":"USD"}'

[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE"
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
is_mainnet "${NETWORK:-}" && die "NETWORK=$NETWORK in $ENV_FILE: mainnet is set on the command line (NETWORK=mainnet scripts/deploy.sh --plan), never in a .env"
load_private_keys "$ENV_FILE" "$ENV_FILE_DEFAULT" || die "$KEYS_SOURCE"
log "$KEYS_SOURCE"
for v in ADMIN_ADDRESS ADMIN_SECRET ISSUER_ADDRESS ISSUER_SECRET LIQUIDATOR_ADDRESS \
         BORROWER_ADDRESS LENDER_ADDRESS TBENJI_SAC USDC_SAC USDC_ASSET TBENJI_ASSET; do
  [[ -n "${!v:-}" ]] || die "$v not set in $ENV_FILE"
done
TREASURY_ADDRESS="${TREASURY_ADDRESS:-$ADMIN_ADDRESS}"
# GUARDIAN_ADDRESS: tighten-only key (#33), separate from ADMIN (KPR-05). Empty
# = keep the live repo's guardian when it is reused, else generate one (step 3).
GUARDIAN_ADDRESS="${GUARDIAN_ADDRESS:-}"
# FEEDER (R10): the oracle admin that signs set_price, when split from ADMIN.
# Unset = ADMIN, as before.
FEEDER_ADDRESS="${FEEDER_ADDRESS:-$ADMIN_ADDRESS}"
FEEDER_SECRET="${FEEDER_SECRET:-$ADMIN_SECRET}"
export STELLAR_NETWORK="${REQ_NETWORK:-${NETWORK:-testnet}}"
[[ -n "${RPC_URL:-}" ]] && export STELLAR_RPC_URL="$RPC_URL"
[[ "$STELLAR_NETWORK" == testnet ]] && export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
OLD_REPO_ID="${REPO_ID:-}"   # wound down below if this run replaces it (UA-05)
# Repos replaced by an earlier run that died before step 7: that run wrote the
# new REPO_ID at once, so this run reads it as OLD_REPO_ID and would forget the
# one it replaced. Steps 7-9 record and wind these down, then clear the marker.
# Stored comma-separated (no spaces: every script `source`s .env, and an
# unquoted space would run the second id as a command); spaces still accepted.
PENDING_SUPERSEDED="${SUPERSEDED_PENDING:-}"
PENDING_SUPERSEDED="${PENDING_SUPERSEDED//,/ }"

# --- 0. guards (Raven R4) -------------------------------------------------------
check_sac USDC "$USDC_ASSET" "$USDC_SAC"
check_sac TBENJI "$TBENJI_ASSET" "$TBENJI_SAC"
if (( PREFLIGHT )); then log "preflight ok"; exit 0; fi

# Secrets go to the CLI only, never to stdout. CLI logs are kept quiet and
# shown only when a command fails.
ERR_LOG="$(mktemp)"; trap 'rm -f "$ERR_LOG"' EXIT
loud() { "$@" 2>"$ERR_LOG" || { cat "$ERR_LOG" >&2; return 1; }; }

# --plan: every sending call below prints a numbered line (role + the CLI
# call, addresses and IDs only, never a secret) and sends nothing. Reads
# (views, fetches, Horizon) still run, so the plan is what this run would
# send against the live state. A contract the plan would deploy gets the
# placeholder id PLANNED_<wasm>; views on it return nothing.
exec 3>&1   # plan lines reach the terminal even from inside $(...)
PLAN_LOG="$(mktemp)" PLAN_FILES=()
trap 'rm -f "$ERR_LOG" "$PLAN_LOG"' EXIT
plan() { # numbered across subshells: the count lives in PLAN_LOG
  printf '%s\n' "$*" >> "$PLAN_LOG"
  printf '  %2d. %s\n' "$(wc -l < "$PLAN_LOG")" "$*" >&3
}
if (( PLAN )); then
  printf 'PLAN %s (nothing is sent; reads only)\n' "$STELLAR_NETWORK" >&3
  as_admin()  { plan "admin   contract invoke $*"; }
  as_issuer() { plan "issuer  contract invoke $*"; }
  as_feeder() { plan "feeder  contract invoke $*"; }
  admin_tx()  { plan "admin   tx new $*"; }
  deploy()    { local w; w=$(sed -n 's/.*--wasm \([^ ]*\).*/\1/p' <<<"$*"); w=$(basename "$w" .wasm)
                plan "admin   contract deploy $*"; echo "PLANNED_$w"; }
else
  as_admin()  { loud stellar contract invoke --source-account "$ADMIN_SECRET"  "$@"; }
  as_issuer() { loud stellar contract invoke --source-account "$ISSUER_SECRET" "$@"; }
  as_feeder() { loud stellar contract invoke --source-account "$FEEDER_SECRET" "$@"; }
  admin_tx()  { loud stellar tx new "$@" --source-account "$ADMIN_SECRET"; }
  deploy()    { loud stellar contract deploy --source-account "$ADMIN_SECRET"  "$@"; }
fi
view() {
  [[ " $* " == *" PLANNED_"* ]] && return 0   # a contract this plan has not deployed
  stellar contract invoke -q --source-account "$ADMIN_ADDRESS" --send=no "$@"
}

unset_env() { # unset_env KEY: drop the line (no-op when absent or under --plan)
  (( PLAN )) && return 0
  grep -q "^${1}=" "$ENV_FILE" || return 0
  sed -i.bak "/^${1}=/d" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
}
# A contract was deployed: write DEPLOYED_AT now, not only at step 7, so a run
# that dies later still leaves the new timestamp for the re-run to keep.
mark_deployed() {
  DEPLOYED_NEW=1
  (( PLAN )) || set_env DEPLOYED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
set_env() { # set_env KEY VALUE: replace in place or append
  local k="$1" v="$2"
  if (( PLAN )); then
    grep -qxF "${k}=${v}" "$ENV_FILE" || PLAN_FILES+=("$k")
    return 0
  fi
  if grep -q "^${k}=" "$ENV_FILE"; then
    # -i.bak, not -i: GNU and BSD (macOS) sed both accept it.
    sed -i.bak "s|^${k}=.*|${k}=${v}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}
# set_key KEY VALUE: a role key (GUARDIAN_*) goes to .env as before and, when
# that role was read from the untracked keys file, there too, so the next
# run does not read a stale key from it (R10).
set_key() {
  set_env "$1" "$2"
  if (( ! PLAN )) && key_in_keys_file "$1"; then
    ENV_FILE="$(caravel_keys_file testnet)" set_env "$1" "$2"
  fi
}

# Reuse an existing contract iff its on-chain code equals the local build.
# Compared without the contractmetav0 section: commit_sha differs per commit.
same_wasm() { # same_wasm CONTRACT_ID LOCAL_WASM
  local id="$1" wasm="$2" tmp
  [[ -n "$id" ]] || return 1
  tmp="$(mktemp)"
  if stellar contract fetch -q --id "$id" -o "$tmp" 2>/dev/null \
     && [[ "$(code_hash "$tmp")" == "$(code_hash "$wasm")" ]]; then
    rm -f "$tmp"; return 0
  fi
  rm -f "$tmp"; return 1
}

# Testnet rent is steep right now: a wasm upload is ~1,000-1,500 XLM and a
# fresh oracle deploy was ~3,500 XLM. Keep ADMIN topped up by funding a
# throwaway account with friendbot and merging it into ADMIN (+~10k XLM each).
MIN_ADMIN_XLM="${MIN_ADMIN_XLM:-6000}"
xlm_balance() {
  curl -fsS "${HORIZON_URL:-https://horizon-testnet.stellar.org}/accounts/$1" | python3 -c \
    'import json,sys; print(int(float(next(b["balance"] for b in json.load(sys.stdin)["balances"] if b["asset_type"]=="native"))))'
}
ensure_admin_xlm() {
  local bal tries=0 gas
  bal=$(xlm_balance "$ADMIN_ADDRESS")
  if (( PLAN )); then
    (( bal < MIN_ADMIN_XLM )) && plan "friendbot  fund a throwaway account and account-merge it into admin (admin has $bal XLM < $MIN_ADMIN_XLM; up to 3 times)"
    log "admin balance $bal XLM"; return 0
  fi
  while (( bal < MIN_ADMIN_XLM && tries < 3 )); do
    tries=$((tries + 1)); gas="caravel-gas-$$-$tries"
    log "admin has $bal XLM < $MIN_ADMIN_XLM, merging a friendbot account in"
    loud stellar keys generate "$gas" --fund --overwrite \
      && loud stellar tx new account-merge --source-account "$gas" --account "$ADMIN_ADDRESS" >/dev/null \
      || log "WARN: XLM top-up failed (friendbot down?)"
    stellar keys rm "$gas" >/dev/null 2>&1 || true
    bal=$(xlm_balance "$ADMIN_ADDRESS")
  done
  log "admin balance $bal XLM"
}


# --- 1. build ------------------------------------------------------------------
if [[ -n "${PREBUILT_WASM_DIR:-}" ]]; then
  # Attested artifacts from .github/workflows/attest.yml: deploying these exact
  # bytes is what lets `stellar contract info build` verify the contract (SEP-55).
  WASM_DIR="$PREBUILT_WASM_DIR"
  log "using prebuilt wasm from $WASM_DIR (no build)"
else
  build_meta_args "$ROOT"
  log "building contracts (${BUILD_META[*]})"
  (cd "$ROOT" && stellar contract build "${BUILD_META[@]}" >/dev/null 2>&1) || die "stellar contract build failed (run it in $ROOT to see why)"
fi
ORACLE_WASM="$WASM_DIR/caravel_oracle.wasm"
REPO_WASM="$WASM_DIR/caravel_repo.wasm"
SPIKO_WASM="$WASM_DIR/caravel_spiko_mock.wasm"
[[ -f "$ORACLE_WASM" && -f "$REPO_WASM" && -f "$SPIKO_WASM" ]] || die "wasm not found in $WASM_DIR"
ensure_admin_xlm

# --- 2. oracle -------------------------------------------------------------------
if [[ $FRESH == 0 ]] && same_wasm "${ORACLE_ID:-}" "$ORACLE_WASM"; then
  log "oracle unchanged, reusing $ORACLE_ID"
else
  log "deploying mock oracle"
  ORACLE_ID=$(deploy --wasm "$ORACLE_WASM" -- \
    --admin "$FEEDER_ADDRESS" --base "$ORACLE_BASE" \
    --decimals "$ORACLE_DECIMALS" --resolution "$ORACLE_RESOLUTION")
  log "oracle $ORACLE_ID"
  REDEPLOY_REPO=1   # repo config points at the oracle
  mark_deployed
fi
set_env ORACLE_ID "$ORACLE_ID"

TBENJI_ORACLE_ASSET="{\"Stellar\":\"$TBENJI_SAC\"}"
LAST=$(view --id "$ORACLE_ID" -- lastprice --asset "$TBENJI_ORACLE_ASSET")
if [[ -n "${NAV:-}" || "$LAST" == "null" || -z "$LAST" ]]; then
  NAV_VALUE="${NAV:-1.00}"
  PRICE=$(python3 -c "from decimal import Decimal as D; print(int(D('$NAV_VALUE') * 10**$ORACLE_DECIMALS))")
  log "set_price tBENJI = $NAV_VALUE ($PRICE)"
  as_feeder --id "$ORACLE_ID" -- set_price --asset "$TBENJI_ORACLE_ASSET" --price "$PRICE" >/dev/null
else
  log "tBENJI price already set: $LAST"
fi

# --- 2b. tSAFO: Spiko-style mock token, ISSUER is its admin ----------------------
if [[ $FRESH == 0 ]] && same_wasm "${TSAFO_ID:-}" "$SPIKO_WASM"; then
  log "tSAFO unchanged, reusing $TSAFO_ID"
else
  log "deploying tSAFO (Spiko mock, $TSAFO_DECIMALS decimals)"
  TSAFO_ID=$(deploy --wasm "$SPIKO_WASM" -- \
    --admin "$ISSUER_ADDRESS" --name "Test Spiko SAFO (USD)" --symbol tSAFO --decimals "$TSAFO_DECIMALS")
  log "tSAFO $TSAFO_ID"
  mark_deployed
fi
set_env TSAFO_ID "$TSAFO_ID"

TSAFO_ORACLE_ASSET="{\"Stellar\":\"$TSAFO_ID\"}"
LAST=$(view --id "$ORACLE_ID" -- lastprice --asset "$TSAFO_ORACLE_ASSET")
if [[ "$SPIKO_FEED" == 1 ]]; then
  [[ -z "${SAFO_NAV:-}" ]] || die "SAFO_NAV cannot pin tSAFO under SPIKO_FEED=1: its price is Spiko's published NAV"
  if [[ "$(view --id "$ORACLE_ID" -- source_timed --asset "$TSAFO_ORACLE_ASSET" 2>/dev/null)" != true ]]; then
    log "tSAFO: source-timed on the oracle (Spiko eurSAFO feed, set_price_at only)"
    as_feeder --id "$ORACLE_ID" -- set_source_timed --asset "$TSAFO_ORACLE_ASSET" --source_timed true >/dev/null
  fi
  if [[ "$LAST" != "null" && -n "$LAST" ]]; then
    log "tSAFO price already set: $LAST"
  elif (( PLAN )); then
    plan "feeder  spiko-nav eurSAFO --once (set_price_at at Spiko's NAV x EUR/USD and publication time)"
  elif [[ -d "$ROOT/scripts/keeper/node_modules" ]]; then
    log "first tSAFO price from Spiko: npm run spiko-nav -- eurSAFO --once"
    ( cd "$ROOT/scripts/keeper" && ENV_FILE="$ENV_FILE" ORACLE_ID="$ORACLE_ID" TSAFO_ID="$TSAFO_ID" \
        SPIKO_NAV_ASSET="Stellar:$TSAFO_ID" FEEDER_SECRET="$FEEDER_SECRET" npm run -s spiko-nav -- eurSAFO --once ) \
      || log "WARN: first Spiko post failed; tSAFO has no price until caravel-spiko-nav posts one"
  else
    log "WARN: tSAFO has no price: run npm ci in scripts/keeper, then npm run spiko-nav -- eurSAFO --once"
  fi
elif [[ -n "${SAFO_NAV:-}" || "$LAST" == "null" || -z "$LAST" ]]; then
  NAV_VALUE="${SAFO_NAV:-1.00}"
  PRICE=$(python3 -c "from decimal import Decimal as D; print(int(D('$NAV_VALUE') * 10**$ORACLE_DECIMALS))")
  log "set_price tSAFO = $NAV_VALUE ($PRICE)"
  as_feeder --id "$ORACLE_ID" -- set_price --asset "$TSAFO_ORACLE_ASSET" --price "$PRICE" >/dev/null
else
  log "tSAFO price already set: $LAST"
fi

# --- 3. repo -------------------------------------------------------------------
config_json() {
  cat <<EOF
{"admin":"$ADMIN_ADDRESS","usdc":"$USDC_SAC","oracle":"$ORACLE_ID","treasury":"$TREASURY_ADDRESS","fee_bps":$FEE_BPS,"liquidation_discount_bps":$LIQ_DISCOUNT_BPS,"day_secs":$DAY_SECS,"margin_window_secs":$MARGIN_WINDOW_SECS,"grace_secs":$GRACE_SECS,"guardian":"$GUARDIAN_ADDRESS","timelock_secs":$TIMELOCK_SECS}
EOF
}
# A guardian of its own (KPR-05): a funded testnet key, written to .env and
# never printed. Only called when a new repo contract is deployed.
new_guardian() {
  local name="caravel-guardian-$$" secret
  if (( PLAN )); then
    plan "friendbot  generate a guardian key, fund it, write GUARDIAN_ADDRESS / GUARDIAN_SECRET to $ENV_FILE"
    GUARDIAN_ADDRESS="PLANNED_guardian"; return 0
  fi
  loud stellar keys generate "$name" --fund --overwrite >/dev/null || die "guardian key generation failed (friendbot down?)"
  GUARDIAN_ADDRESS=$(stellar keys address "$name")
  secret=$(stellar keys secret "$name")
  stellar keys rm "$name" >/dev/null 2>&1 || true
  [[ "$GUARDIAN_ADDRESS" =~ ^G[A-Z2-7]{55}$ && "$secret" =~ ^S[A-Z2-7]{55}$ ]] || die "guardian key generation returned no key"
  set_key GUARDIAN_ADDRESS "$GUARDIAN_ADDRESS"
  set_key GUARDIAN_SECRET "$secret"
  log "guardian: new key $GUARDIAN_ADDRESS (GUARDIAN_SECRET in $ENV_FILE)"
}
NEED_GUARDIAN=0
if [[ -z "$GUARDIAN_ADDRESS" ]]; then
  NEED_GUARDIAN=1
  # Compare against the live repo's own guardian so a no-op run stays a no-op.
  GUARDIAN_ADDRESS=$(view --id "${REPO_ID:-}" -- config 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["guardian"])' 2>/dev/null || true)
fi
CONFIG_JSON=$(config_json)
config_matches() { # on-chain config == wanted config (no setter, so mismatch => redeploy)
  local got
  got=$(view --id "$REPO_ID" -- config 2>/dev/null) || return 1
  python3 - "$got" "$CONFIG_JSON" <<'PY'
import json, sys
a, b = (json.loads(x) for x in sys.argv[1:3])
norm = lambda d: {k: str(v) for k, v in d.items()}
sys.exit(0 if norm(a) == norm(b) else 1)
PY
}
if [[ $FRESH == 0 && -z "${REDEPLOY_REPO:-}" ]] && same_wasm "${REPO_ID:-}" "$REPO_WASM" && config_matches; then
  log "repo unchanged, reusing $REPO_ID"
else
  if (( NEED_GUARDIAN )); then new_guardian; CONFIG_JSON=$(config_json); fi
  log "deploying repo contract"
  REPO_ID=$(deploy --wasm "$REPO_WASM" -- \
    --config "$CONFIG_JSON")
  log "repo $REPO_ID"
  # Record the replaced repo before REPO_ID moves, so a failure before step 7
  # does not lose it (the re-run would see this new repo as OLD_REPO_ID).
  if [[ -n "$OLD_REPO_ID" && "$OLD_REPO_ID" != "$REPO_ID" ]]; then
    PENDING_SUPERSEDED="$OLD_REPO_ID${PENDING_SUPERSEDED:+ $PENDING_SUPERSEDED}"
    # shellcheck disable=SC2086  # unquoted echo collapses the spaces; join with commas
    (( PLAN )) || set_env SUPERSEDED_PENDING "$(echo $PENDING_SUPERSEDED | tr ' ' ,)"
  fi
  mark_deployed
fi
set_env REPO_ID "$REPO_ID"

# --- 4. collateral assets ------------------------------------------------------
ensure_asset() { # ensure_asset LABEL TOKEN_ID ASSET_JSON
  local label="$1" token="$2" want="$3" got
  got=$(view --id "$REPO_ID" -- asset --asset "$token" 2>/dev/null || true)
  if python3 - "$got" "$want" <<'PY'
import json, sys
try: sys.exit(0 if json.loads(sys.argv[1]) == json.loads(sys.argv[2]) else 1)
except Exception: sys.exit(1)
PY
  then
    log "$label asset config already set"
  else
    # Instant only for a first listing or a pure tightening (#33); a loosening
    # fails with Error #20 and needs propose_asset + execute_asset after the timelock.
    log "set_asset $label $want"
    as_admin --id "$REPO_ID" -- set_asset --asset "$token" --config "$want" >/dev/null
  fi
}
ASSET_JSON="{\"oracle_asset\":$TBENJI_ORACLE_ASSET,\"haircut_bps\":$HAIRCUT_BPS,\"margin_trigger_bps\":$MARGIN_TRIGGER_BPS,\"enabled\":true,\"max_nav_age_secs\":$MAX_NAV_AGE_SECS,\"max_nav_move_bps\":$NAV_MOVE_BPS,\"nav_floor\":null,\"nav_ceiling\":null,\"max_open_debt\":\"$(( MAX_OPEN_DEBT * 10000000 ))\",\"band_settle_secs\":$BAND_SETTLE_SECS}"
TSAFO_ASSET_JSON="{\"oracle_asset\":$TSAFO_ORACLE_ASSET,\"haircut_bps\":$SAFO_HAIRCUT_BPS,\"margin_trigger_bps\":$SAFO_MARGIN_TRIGGER_BPS,\"enabled\":true,\"max_nav_age_secs\":$SAFO_MAX_NAV_AGE_SECS,\"max_nav_move_bps\":$SAFO_NAV_MOVE_BPS,\"nav_floor\":null,\"nav_ceiling\":null,\"max_open_debt\":\"$(( SAFO_MAX_OPEN_DEBT * 10000000 ))\",\"band_settle_secs\":$SAFO_BAND_SETTLE_SECS}"
ensure_asset tBENJI "$TBENJI_SAC" "$ASSET_JSON"
ensure_asset tSAFO "$TSAFO_ID" "$TSAFO_ASSET_JSON"

# --- 5. liquidator whitelist ---------------------------------------------------
# Additions are timelocked (Raven R6, UA-03): propose_liquidator, wait out
# timelock_secs (120 s on testnet), then execute_liquidator. A re-run reuses a
# proposal still inside its window instead of restarting the clock.
ETA=""
if [[ "$(view --id "$REPO_ID" -- is_liquidator --who "$LIQUIDATOR_ADDRESS")" == true ]]; then
  log "liquidator already whitelisted"
else
  ETA=$(view --id "$REPO_ID" -- pending_liquidator --who "$LIQUIDATOR_ADDRESS" 2>/dev/null | tr -d '"' || true)
  if ! [[ "$ETA" =~ ^[0-9]+$ ]] || (( $(date +%s) + 30 > ETA + TIMELOCK_SECS )); then
    log "propose_liquidator $LIQUIDATOR_ADDRESS"
    if (( PLAN )); then as_admin --id "$REPO_ID" -- propose_liquidator --liquidator "$LIQUIDATOR_ADDRESS"; ETA=planned
    else ETA=$(as_admin --id "$REPO_ID" -- propose_liquidator --liquidator "$LIQUIDATOR_ADDRESS" | tr -d '"'); fi
  fi
fi
if (( PLAN )) && [[ "${ETA:-}" ]]; then
  plan "wait   timelock_secs ($TIMELOCK_SECS s) after the proposal's eta (${ETA}), then:"
  as_admin --id "$REPO_ID" -- execute_liquidator --liquidator "$LIQUIDATOR_ADDRESS"
elif [[ "${ETA:-}" ]]; then
  [[ "$ETA" =~ ^[0-9]+$ ]] || die "propose_liquidator returned no eta"
  WAIT=$(( ETA - $(date +%s) + 6 ))   # ledger time trails the wall clock a little
  if (( WAIT > 0 )); then log "waiting ${WAIT}s for the liquidator timelock (eta $ETA)"; sleep "$WAIT"; fi
  for try in 1 2 3 4 5 6; do
    as_admin --id "$REPO_ID" -- execute_liquidator --liquidator "$LIQUIDATOR_ADDRESS" >/dev/null && break
    (( try < 6 )) || die "execute_liquidator failed 6 times (Error #21 = ledger clock still before eta $ETA)"
    sleep 5
  done
  [[ "$(view --id "$REPO_ID" -- is_liquidator --who "$LIQUIDATOR_ADDRESS")" == true ]] \
    || die "liquidator not whitelisted after execute_liquidator"
  log "liquidator whitelisted after the timelock"
fi

# --- 5b. treasury can receive USDC ----------------------------------------------
# repay/liquidate transfer the protocol fee to Config.treasury. A G-account
# without a USDC trustline makes that SAC transfer fail (TrustlineMissing, #13),
# so every repay with a non-zero fee reverts. Treasury defaults to ADMIN.
if [[ -n "${USDC_ASSET:-}" ]]; then
  if curl -fsS "${HORIZON_URL:-https://horizon-testnet.stellar.org}/accounts/$TREASURY_ADDRESS" | python3 -c '
import json, sys
code, issuer = sys.argv[1].split(":")
bs = json.load(sys.stdin)["balances"]
sys.exit(0 if any(b.get("asset_code") == code and b.get("asset_issuer") == issuer for b in bs) else 1)' "$USDC_ASSET"; then
    log "treasury has a USDC trustline"
  elif [[ "$TREASURY_ADDRESS" == "$ADMIN_ADDRESS" ]]; then
    log "adding USDC trustline to treasury (admin)"
    admin_tx change-trust --line "$USDC_ASSET" >/dev/null
  else
    log "WARN: treasury $TREASURY_ADDRESS has no USDC trustline; repay will fail until it adds one"
  fi
fi

# --- 6. issuer authorizes holders on tBENJI (AUTH_REQUIRED, spikes/auth) -------
# The repo contract is required (AS-06: a failure stops the deploy); the
# G-accounts only WARN (no trustline yet).
authorize_holder tBENJI "$TBENJI_SAC" "$REPO_ID" 1
for who in "$BORROWER_ADDRESS" "$LIQUIDATOR_ADDRESS"; do
  authorize_holder tBENJI "$TBENJI_SAC" "$who" 0
done

# --- 6b. Spiko-style allowlist on tSAFO ----------------------------------------
# Every transfer checks both sides, so the repo contract and every liquidator
# must be on it, not only borrowers (issue #20). The lender holds tSAFO only via the
# #38 NAV-outage in-kind claim; it is allowlisted for that and so the demo
# lender wallet can also borrow.
for who in "$REPO_ID" "$LIQUIDATOR_ADDRESS" "$BORROWER_ADDRESS" "$LENDER_ADDRESS" ${TSAFO_HOLDERS:-}; do
  if [[ "$(view --id "$TSAFO_ID" -- is_whitelisted --account "$who" 2>/dev/null || echo false)" == true ]]; then
    log "tSAFO allowlisted: $who"
  else
    log "issuer allowlists $who on tSAFO"
    as_issuer --id "$TSAFO_ID" -- set_whitelisted --account "$who" --allowed true >/dev/null
  fi
done
BAL=$(view --id "$TSAFO_ID" -- balance --id "$BORROWER_ADDRESS" 2>/dev/null | tr -d '"' || echo 0)
if [[ "${BAL:-0}" == 0 ]]; then
  AMT=$(python3 -c "print($TSAFO_BORROWER_MINT * 10**$TSAFO_DECIMALS)")
  log "issuer mints $TSAFO_BORROWER_MINT tSAFO to borrower"
  as_issuer --id "$TSAFO_ID" -- mint --to "$BORROWER_ADDRESS" --amount "$AMT" >/dev/null
else
  log "borrower holds $BAL tSAFO units"
fi
for who in ${TSAFO_HOLDERS:-}; do
  BAL=$(view --id "$TSAFO_ID" -- balance --id "$who" 2>/dev/null | tr -d '"' || echo 0)
  if [[ "${BAL:-0}" == 0 ]]; then
    AMT=$(python3 -c "print($TSAFO_HOLDER_MINT * 10**$TSAFO_DECIMALS)")
    log "issuer mints $TSAFO_HOLDER_MINT tSAFO to holder $who"
    as_issuer --id "$TSAFO_ID" -- mint --to "$who" --amount "$AMT" >/dev/null
  else
    log "holder $who holds $BAL tSAFO units"
  fi
done

# --- 7. outputs ------------------------------------------------------------------
# DEPLOYED_AT moves only when a contract was (re)deployed, so no-op runs leave no diff.
[[ -n "${DEPLOYED_NEW:-}" || -z "${DEPLOYED_AT:-}" ]] && DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
set_env DEPLOYED_AT "$DEPLOYED_AT"
# "superseded": earlier repo contracts, newest first, kept across runs; this
# run's replaced REPO_ID joins it, and so do SUPERSEDED_PENDING ids left by a
# run that died after replacing REPO_ID (UA-05: scripts/winddown.sh reads the list).
SUPERSEDED_ADD=""
for id in "$OLD_REPO_ID" $PENDING_SUPERSEDED; do
  if [[ -n "$id" && "$id" != "$REPO_ID" && " $SUPERSEDED_ADD " != *" $id "* ]]; then
    SUPERSEDED_ADD="${SUPERSEDED_ADD:+$SUPERSEDED_ADD }$id"
  fi
done

# --plan stops here: no file is written, no bindings, no wind-down tx.
if (( PLAN )); then
  if [[ -n "$SUPERSEDED_ADD" ]] && (( WINDDOWN )); then
    plan "admin   scripts/winddown.sh $SUPERSEDED_ADD (no_new_repos pause on each asset, cancel_offer for the offers .env keys own)"
  fi
  N=$(wc -l < "$PLAN_LOG")
  if (( N == 0 )); then echo "  nothing to send: chain state matches this build and .env" >&3; fi
  if (( ${#PLAN_FILES[@]} )); then
    echo "  files a real run would write: $ENV_FILE (${PLAN_FILES[*]}), deployments/testnet.json, README table, bindings if an ID changed" >&3
  fi
  log "plan done in $(( $(date +%s) - T0 ))s: $N tx(s) planned, nothing sent, no file written"
  exit 0
fi

mkdir -p "$(dirname "$OUT_JSON")"
python3 - "$OUT_JSON" "$SUPERSEDED_ADD" "$REPO_ID" <<PY
import json, os, sys
prev = []
if os.path.exists(sys.argv[1]):
    try: prev = json.load(open(sys.argv[1])).get("superseded", [])
    except Exception: prev = []
superseded = [i for i in sys.argv[2].split() + prev if i and i != sys.argv[3]]
superseded = list(dict.fromkeys(superseded))
out = {
  "network": "$STELLAR_NETWORK",
  "rpcUrl": "${RPC_URL:-}",
  "horizonUrl": "${HORIZON_URL:-}",
  "deployedAt": "$DEPLOYED_AT",
  "contracts": {
    "repo": "$REPO_ID",
    "oracle": "$ORACLE_ID",
    "usdc": "$USDC_SAC",
    "tbenji": "$TBENJI_SAC",
    "tsafo": "$TSAFO_ID",
  },
  "assets": {"usdc": "${USDC_ASSET:-}", "tbenji": "${TBENJI_ASSET:-}"},
  "accounts": {
    "admin": "$ADMIN_ADDRESS",
    "issuer": "$ISSUER_ADDRESS",
    "lender": "$LENDER_ADDRESS",
    "borrower": "$BORROWER_ADDRESS",
    "liquidator": "$LIQUIDATOR_ADDRESS",
    "treasury": "$TREASURY_ADDRESS",
    "guardian": "$GUARDIAN_ADDRESS",
  },
  "config": json.loads('''$CONFIG_JSON'''),
  "tbenjiAsset": json.loads('''$ASSET_JSON'''),
  "tsafoAsset": json.loads('''$TSAFO_ASSET_JSON'''),
  "tsafo": {"symbol": "tSAFO", "decimals": $TSAFO_DECIMALS, "kind": "spiko-mock",
            "feed": "$( [[ "$SPIKO_FEED" == 1 ]] && echo "spiko:eurSAFO" || echo "mock" )"},
  "oracle": {"base": json.loads('''$ORACLE_BASE'''), "decimals": $ORACLE_DECIMALS, "resolution": $ORACLE_RESOLUTION},
  "superseded": superseded,
}
with open(sys.argv[1], "w") as f:
    json.dump(out, f, indent=2); f.write("\n")
PY
# README "Testnet deployment" table follows testnet.json, so the redeploy commit carries it.
python3 "$ROOT/scripts/readme-ids.py" || log "WARN: README testnet table not updated"

# --- 8. TS bindings for the app (packages/caravel-{repo,oracle}) ---------------
if [[ -z "${SKIP_BINDINGS:-}" ]]; then
  for pair in "caravel-repo:$REPO_ID" "caravel-oracle:$ORACLE_ID"; do
    name="${pair%%:*}" id="${pair#*:}"
    if grep -qs "contractId: \"$id\"" "$ROOT/packages/$name/src/index.ts"; then
      log "bindings $name up to date"
    else
      log "generating bindings packages/$name"
      loud stellar contract bindings typescript --contract-id "$id" \
        --output-dir "$ROOT/packages/$name" --overwrite >/dev/null \
        || log "WARN: bindings for $name failed"
    fi
  done
fi

# --- 9. wind down the repo contract this run replaced (UA-05) ------------------
# After the new one is live, never before: a failed deploy must not leave the
# demo with no open book. Best effort: a failure here only WARNs.
if [[ -n "$SUPERSEDED_ADD" ]]; then
  if (( WINDDOWN )); then
    log "winding down superseded repo $SUPERSEDED_ADD"
    # Same keys as this run: pass the untracked keys file on when it was used.
    KF=""; (( ${#KEYS_FILE_ROLES[@]} )) && KF="$(caravel_keys_file testnet)"
    # shellcheck disable=SC2086  # one argument per id
    if ENV_FILE="$ENV_FILE" CARAVEL_KEYS_FILE="$KF" "$ROOT/scripts/winddown.sh" $SUPERSEDED_ADD >&2; then
      unset_env SUPERSEDED_PENDING
    else
      # Keep the marker: the next run (or scripts/winddown.sh) retries.
      log "WARN: winddown of $SUPERSEDED_ADD failed; re-run scripts/winddown.sh $SUPERSEDED_ADD"
    fi
  else
    unset_env SUPERSEDED_PENDING   # recorded in testnet.json; the caller chose to keep it open
    log "--no-winddown: $SUPERSEDED_ADD stays open (scripts/winddown.sh $SUPERSEDED_ADD later)"
  fi
else
  unset_env SUPERSEDED_PENDING   # a stale marker naming only the live repo
fi

log "done in $(( $(date +%s) - T0 ))s"
echo "ORACLE_ID=$ORACLE_ID"
echo "REPO_ID=$REPO_ID"
echo "TSAFO_ID=$TSAFO_ID"
echo "https://stellar.expert/explorer/testnet/contract/$ORACLE_ID"
echo "https://stellar.expert/explorer/testnet/contract/$REPO_ID"
