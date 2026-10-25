#!/usr/bin/env bash
# Caravel one-command testnet deploy (v0).
#
#   scripts/deploy.sh            # build, deploy what changed, (re)apply config
#   scripts/deploy.sh --fresh    # force new oracle + repo contracts
#   NAV=0.97 scripts/deploy.sh   # also push a tBENJI price (default: 1.00, only if none set)
#   SAFO_NAV=1.02 scripts/deploy.sh   # same for tSAFO
#
# Idempotent: an existing ORACLE_ID / REPO_ID from .env is kept when its
# on-chain wasm matches the fresh build; otherwise a new contract is deployed.
# Admin steps (price, set_asset, set_liquidator, issuer authorization) are
# read first and only sent when the on-chain value differs.
#
# Collateral #2 is tSAFO (issue #20): a Spiko-style mock token
# (contracts/spiko-mock, allowlist on every transfer, no approve, 5 decimals)
# with ISSUER as its admin. The script allowlists the repo contract, the
# liquidator and the demo wallets (+ TSAFO_HOLDERS), mints demo tSAFO to the
# borrower (+ TSAFO_HOLDER_MINT to each holder), prices it and registers it with
# set_asset at SAFO_HAIRCUT_BPS.
#
# Reads keys and IDs from <repo>/.env; writes ORACLE_ID, REPO_ID, TSAFO_ID,
# DEPLOYED_AT back to it, writes the public deployments/testnet.json for the app and
# regenerates TS bindings in packages/ when a contract ID changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
OUT_JSON="$ROOT/deployments/testnet.json"
WASM_DIR="$ROOT/target/wasm32v1-none/release"

FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# --- params (demo time profile, DECISIONS.md #3 #4 #5 #18) ------------------
FEE_BPS="${FEE_BPS:-1000}"                       # 10% of interest (#3)
LIQ_DISCOUNT_BPS="${LIQ_DISCOUNT_BPS:-200}"      # 2% liquidator discount (#4)
HAIRCUT_BPS="${HAIRCUT_BPS:-300}"                # 3% tBENJI haircut, > discount (#18)
SAFO_HAIRCUT_BPS="${SAFO_HAIRCUT_BPS:-3000}"     # 30% tSAFO, Tier 5 (testnet only, DECISIONS #29)
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
ORACLE_DECIMALS=14                               # same as Reflector
ORACLE_RESOLUTION=60
ORACLE_BASE='{"Other":"USD"}'

T0=$(date +%s)
log()  { printf '[%3ss] %s\n' "$(( $(date +%s) - T0 ))" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE"
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
for v in ADMIN_ADDRESS ADMIN_SECRET ISSUER_ADDRESS ISSUER_SECRET LIQUIDATOR_ADDRESS \
         BORROWER_ADDRESS LENDER_ADDRESS TBENJI_SAC USDC_SAC; do
  [[ -n "${!v:-}" ]] || die "$v not set in $ENV_FILE"
done
TREASURY_ADDRESS="${TREASURY_ADDRESS:-$ADMIN_ADDRESS}"
GUARDIAN_ADDRESS="${GUARDIAN_ADDRESS:-$ADMIN_ADDRESS}" # tighten-only key (#33); set a separate one outside the demo
export STELLAR_NETWORK="${NETWORK:-testnet}"
[[ -n "${RPC_URL:-}" ]] && export STELLAR_RPC_URL="$RPC_URL"
[[ "$STELLAR_NETWORK" == testnet ]] && export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Secrets go to the CLI only, never to stdout. CLI logs are kept quiet and
# shown only when a command fails.
ERR_LOG="$(mktemp)"; trap 'rm -f "$ERR_LOG"' EXIT
loud() { "$@" 2>"$ERR_LOG" || { cat "$ERR_LOG" >&2; return 1; }; }
as_admin()  { loud stellar contract invoke --source-account "$ADMIN_SECRET"  "$@"; }
as_issuer() { loud stellar contract invoke --source-account "$ISSUER_SECRET" "$@"; }
deploy()    { loud stellar contract deploy --source-account "$ADMIN_SECRET"  "$@"; }
view()      { stellar contract invoke -q --source-account "$ADMIN_ADDRESS" --send=no "$@"; }

set_env() { # set_env KEY VALUE: replace in place or append
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE"; then
    # -i.bak, not -i: GNU and BSD (macOS) sed both accept it.
    sed -i.bak "s|^${k}=.*|${k}=${v}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}

# Reuse an existing contract iff its on-chain wasm equals the local build.
same_wasm() { # same_wasm CONTRACT_ID LOCAL_WASM
  local id="$1" wasm="$2" tmp
  [[ -n "$id" ]] || return 1
  tmp="$(mktemp)"
  if stellar contract fetch -q --id "$id" -o "$tmp" 2>/dev/null \
     && [[ "$(sha256sum < "$tmp")" == "$(sha256sum < "$wasm")" ]]; then
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
log "building contracts"
(cd "$ROOT" && stellar contract build >/dev/null 2>&1) || die "stellar contract build failed (run it in $ROOT to see why)"
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
    --admin "$ADMIN_ADDRESS" --base "$ORACLE_BASE" \
    --decimals "$ORACLE_DECIMALS" --resolution "$ORACLE_RESOLUTION")
  log "oracle $ORACLE_ID"
  REDEPLOY_REPO=1   # repo config points at the oracle
  DEPLOYED_NEW=1
fi
set_env ORACLE_ID "$ORACLE_ID"

TBENJI_ORACLE_ASSET="{\"Stellar\":\"$TBENJI_SAC\"}"
LAST=$(view --id "$ORACLE_ID" -- lastprice --asset "$TBENJI_ORACLE_ASSET")
if [[ -n "${NAV:-}" || "$LAST" == "null" || -z "$LAST" ]]; then
  NAV_VALUE="${NAV:-1.00}"
  PRICE=$(python3 -c "from decimal import Decimal as D; print(int(D('$NAV_VALUE') * 10**$ORACLE_DECIMALS))")
  log "set_price tBENJI = $NAV_VALUE ($PRICE)"
  as_admin --id "$ORACLE_ID" -- set_price --asset "$TBENJI_ORACLE_ASSET" --price "$PRICE" >/dev/null
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
  DEPLOYED_NEW=1
fi
set_env TSAFO_ID "$TSAFO_ID"

TSAFO_ORACLE_ASSET="{\"Stellar\":\"$TSAFO_ID\"}"
LAST=$(view --id "$ORACLE_ID" -- lastprice --asset "$TSAFO_ORACLE_ASSET")
if [[ -n "${SAFO_NAV:-}" || "$LAST" == "null" || -z "$LAST" ]]; then
  NAV_VALUE="${SAFO_NAV:-1.00}"
  PRICE=$(python3 -c "from decimal import Decimal as D; print(int(D('$NAV_VALUE') * 10**$ORACLE_DECIMALS))")
  log "set_price tSAFO = $NAV_VALUE ($PRICE)"
  as_admin --id "$ORACLE_ID" -- set_price --asset "$TSAFO_ORACLE_ASSET" --price "$PRICE" >/dev/null
else
  log "tSAFO price already set: $LAST"
fi

# --- 3. repo -------------------------------------------------------------------
CONFIG_JSON=$(cat <<EOF
{"admin":"$ADMIN_ADDRESS","usdc":"$USDC_SAC","oracle":"$ORACLE_ID","treasury":"$TREASURY_ADDRESS","fee_bps":$FEE_BPS,"liquidation_discount_bps":$LIQ_DISCOUNT_BPS,"day_secs":$DAY_SECS,"margin_window_secs":$MARGIN_WINDOW_SECS,"grace_secs":$GRACE_SECS,"guardian":"$GUARDIAN_ADDRESS","timelock_secs":$TIMELOCK_SECS}
EOF
)
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
  log "deploying repo contract"
  REPO_ID=$(deploy --wasm "$REPO_WASM" -- \
    --config "$CONFIG_JSON")
  log "repo $REPO_ID"
  DEPLOYED_NEW=1
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
ASSET_JSON="{\"oracle_asset\":$TBENJI_ORACLE_ASSET,\"haircut_bps\":$HAIRCUT_BPS,\"enabled\":true,\"max_nav_age_secs\":$MAX_NAV_AGE_SECS,\"max_nav_move_bps\":$NAV_MOVE_BPS,\"nav_floor\":null,\"nav_ceiling\":null,\"max_open_debt\":\"$(( MAX_OPEN_DEBT * 10000000 ))\"}"
TSAFO_ASSET_JSON="{\"oracle_asset\":$TSAFO_ORACLE_ASSET,\"haircut_bps\":$SAFO_HAIRCUT_BPS,\"enabled\":true,\"max_nav_age_secs\":$SAFO_MAX_NAV_AGE_SECS,\"max_nav_move_bps\":$SAFO_NAV_MOVE_BPS,\"nav_floor\":null,\"nav_ceiling\":null,\"max_open_debt\":\"$(( SAFO_MAX_OPEN_DEBT * 10000000 ))\"}"
ensure_asset tBENJI "$TBENJI_SAC" "$ASSET_JSON"
ensure_asset tSAFO "$TSAFO_ID" "$TSAFO_ASSET_JSON"

# --- 5. liquidator whitelist ---------------------------------------------------
if [[ "$(view --id "$REPO_ID" -- is_liquidator --who "$LIQUIDATOR_ADDRESS")" == true ]]; then
  log "liquidator already whitelisted"
else
  log "set_liquidator $LIQUIDATOR_ADDRESS"
  as_admin --id "$REPO_ID" -- set_liquidator --liquidator "$LIQUIDATOR_ADDRESS" --allowed true >/dev/null
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
    loud stellar tx new change-trust --source-account "$ADMIN_SECRET" --line "$USDC_ASSET" >/dev/null
  else
    log "WARN: treasury $TREASURY_ADDRESS has no USDC trustline; repay will fail until it adds one"
  fi
fi

# --- 6. issuer authorizes holders on tBENJI (AUTH_REQUIRED, spikes/auth) -------
for who in "$REPO_ID" "$BORROWER_ADDRESS" "$LIQUIDATOR_ADDRESS"; do
  if [[ "$(view --id "$TBENJI_SAC" -- authorized --id "$who" 2>/dev/null || echo false)" == true ]]; then
    log "tBENJI authorized: $who"
  else
    log "issuer set_authorized($who) on tBENJI"
    as_issuer --id "$TBENJI_SAC" -- set_authorized --id "$who" --authorize true >/dev/null \
      || log "WARN: set_authorized failed for $who (G-account without a tBENJI trustline?)"
  fi
done

# --- 6b. Spiko-style allowlist on tSAFO ----------------------------------------
# Every transfer checks both sides, so the repo contract and every liquidator
# must be on it, not only borrowers (issue #20). The lender never holds tSAFO
# but is allowlisted so the demo lender wallet can also borrow.
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
mkdir -p "$(dirname "$OUT_JSON")"
python3 - "$OUT_JSON" <<PY
import json, sys
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
  },
  "config": json.loads('''$CONFIG_JSON'''),
  "tbenjiAsset": json.loads('''$ASSET_JSON'''),
  "tsafoAsset": json.loads('''$TSAFO_ASSET_JSON'''),
  "tsafo": {"symbol": "tSAFO", "decimals": $TSAFO_DECIMALS, "kind": "spiko-mock"},
  "oracle": {"base": json.loads('''$ORACLE_BASE'''), "decimals": $ORACLE_DECIMALS, "resolution": $ORACLE_RESOLUTION},
}
with open(sys.argv[1], "w") as f:
    json.dump(out, f, indent=2); f.write("\n")
PY

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

log "done in $(( $(date +%s) - T0 ))s"
echo "ORACLE_ID=$ORACLE_ID"
echo "REPO_ID=$REPO_ID"
echo "TSAFO_ID=$TSAFO_ID"
echo "https://stellar.expert/explorer/testnet/contract/$ORACLE_ID"
echo "https://stellar.expert/explorer/testnet/contract/$REPO_ID"
