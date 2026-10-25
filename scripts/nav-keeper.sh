#!/usr/bin/env bash
# NAV keeper: keeps the mock oracle's collateral prices fresh (tBENJI, and
# tSAFO when TSAFO_ID is set) so takes and liquidations never hit StaleNav
# (each asset's own max_nav_age_secs; demo 180 s).
#
#   scripts/nav-keeper.sh           # loop forever, every INTERVAL s (default 60)
#   scripts/nav-keeper.sh --once    # one push per asset, then exit
#   NAV=1.00 scripts/nav-keeper.sh  # pin the tBENJI price instead of re-posting the last one
#   SAFO_NAV=1.02 scripts/nav-keeper.sh  # same for tSAFO
#
# Each round re-posts each asset's current price (so a value set from the
# app's Admin tab sticks), or NAV / SAFO_NAV if set, or 1.00 when there is none.
# Signs set_price with ADMIN_SECRET from ENV_FILE (the oracle admin), passed
# to the CLI through STELLAR_ACCOUNT so it never shows up in `ps`.
#
# Attempts are interleaved (tBENJI, tSAFO, then a retry of whichever failed),
# so one asset's failures never delay the other's push; every CLI call is
# capped at CLI_TIMEOUT (20 s). Truly parallel sends are not possible: both
# are signed by the one oracle admin, and the network queues one pending tx
# per source account. An asset that fails ALERT_AFTER (2) rounds in a row
# logs an ALERT line and runs ALERT_CMD (caravel-alert.sh in the unit).
# Cost: ~8 XLM per push at today's testnet fees; tops ADMIN up from friendbot
# when it drops below MIN_ADMIN_XLM (see scripts/README.md).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
STELLAR="${STELLAR:-$(command -v stellar || echo "$HOME/.local/bin/stellar")}"
INTERVAL="${INTERVAL:-60}"
ONCE=0
[[ "${1:-}" == "--once" ]] && ONCE=1

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

load_env() {
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
  export STELLAR_NETWORK="${NETWORK:-testnet}"
  [[ -n "${RPC_URL:-}" ]] && export STELLAR_RPC_URL="$RPC_URL"
  [[ "$STELLAR_NETWORK" == testnet ]] && export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
}

CLI_TIMEOUT="${CLI_TIMEOUT:-20}"         # s per CLI call: < 30 s, so a failing asset cannot stall a round (KPR-03)
INCLUSION_FEE="${INCLUSION_FEE:-100000}" # stroops, same as the TS keeper: testnet inclusion fees spike
ALERT_AFTER="${ALERT_AFTER:-2}"           # consecutive failed rounds per asset before an ALERT
declare -A FAILS=()                        # asset label -> consecutive failed rounds

cli() { timeout -k 5 "$CLI_TIMEOUT" "$STELLAR" "$@"; }

alert() { # ALERT line in the journal, plus ALERT_CMD (fire and forget) when set
  log "ALERT $*"
  if [[ -n "${ALERT_CMD:-}" ]]; then
    ( timeout 20 "$ALERT_CMD" "caravel-nav-keeper: $*" >/dev/null 2>&1 || log "alert: ALERT_CMD $ALERT_CMD failed" ) &
  fi
}

push() { # one round: every collateral asset in .env, attempts interleaved
  load_env   # re-read every round: a redeploy changes ORACLE_ID / TSAFO_ID
  local -a labels=(tBENJI) assets=("{\"Stellar\":\"$TBENJI_SAC\"}") pins=("${NAV:-}") prices=() ok=()
  if [[ -n "${TSAFO_ID:-}" ]]; then
    labels+=(tSAFO); assets+=("{\"Stellar\":\"$TSAFO_ID\"}"); pins+=("${SAFO_NAV:-}")
  fi
  local i try left rc=0 n
  for i in "${!labels[@]}"; do prices[i]=$(price_for "${labels[i]}" "${assets[i]}" "${pins[i]}") || prices[i]=""; done
  for try in 1 2 3; do
    left=0
    for i in "${!labels[@]}"; do
      [[ -n "${ok[i]:-}" || -z "${prices[i]}" ]] && continue
      if set_price "${labels[i]}" "${assets[i]}" "${prices[i]}" "$try"; then ok[i]=1; else left=1; fi
    done
    (( left && try < 3 )) || break
    sleep 3
  done
  for i in "${!labels[@]}"; do
    if [[ -n "${ok[i]:-}" ]]; then FAILS[${labels[i]}]=0; continue; fi
    rc=1; n=$(( ${FAILS[${labels[i]}]:-0} + 1 )); FAILS[${labels[i]}]=$n
    if (( n == ALERT_AFTER || (n > ALERT_AFTER && (n - ALERT_AFTER) % 20 == 0) )); then
      alert "${labels[i]} set_price failed $n rounds in a row (oracle ${ORACLE_ID:0:8}…): its NAV goes stale max_nav_age_secs after the last push; takes, margin calls and liquidations stop"
    fi
  done
  return $rc
}

price_for() { # price_for LABEL ASSET_JSON PINNED_NAV -> price to post (stdout)
  local label="$1" asset="$2" pin="$3" last
  last=$(cli contract invoke -q --source-account "$ADMIN_ADDRESS" --send=no \
           --id "$ORACLE_ID" -- lastprice --asset "$asset" 2>&1) || { log "$label lastprice failed: ${last##*$'\n'}" >&2; return 1; }
  if [[ -n "$pin" ]]; then
    python3 -c "from decimal import Decimal as D; print(int(D('$pin') * 10**14))"
  elif [[ "$last" == "null" || -z "$last" ]]; then
    echo 100000000000000          # 1.00 at 14 decimals
  else
    python3 -c 'import json,sys; print(json.loads(sys.argv[1])["price"])' "$last"
  fi
}

set_price() { # set_price LABEL ASSET_JSON PRICE TRY: one attempt
  local label="$1" asset="$2" price="$3" try="$4" out ts
  if ! out=$(STELLAR_ACCOUNT="$ADMIN_SECRET" cli contract invoke -q --inclusion-fee "$INCLUSION_FEE" \
               --id "$ORACLE_ID" -- set_price --asset "$asset" --price "$price" 2>&1); then
    [[ -z "$out" ]] && out="no output (timed out after ${CLI_TIMEOUT}s?)"
    log "$label set_price attempt $try FAILED: $(grep -v '^[[:space:]]*$' <<<"$out" | tail -n 3 | tr '\n' ' ')"
    return 1
  fi
  ts=$(cli contract invoke -q --source-account "$ADMIN_ADDRESS" --send=no \
         --id "$ORACLE_ID" -- lastprice --asset "$asset" 2>/dev/null)
  log "set_price $label=$price oracle=${ORACLE_ID:0:8}… now $ts"
}

# Each push costs ~8 XLM (per asset) on testnet today (~11.7k XLM/day at 60 s), so keep
# ADMIN above MIN_ADMIN_XLM by merging a friendbot-funded throwaway account
# into it (+~10k XLM), the same trick scripts/deploy.sh uses.
MIN_ADMIN_XLM="${MIN_ADMIN_XLM:-3000}"
xlm_balance() {
  curl -fsS "${HORIZON_URL:-https://horizon-testnet.stellar.org}/accounts/$1" | python3 -c \
    'import json,sys; print(int(float(next(b["balance"] for b in json.load(sys.stdin)["balances"] if b["asset_type"]=="native"))))'
}
top_up() {
  local bal gas
  bal=$(xlm_balance "$ADMIN_ADDRESS") || return 0
  (( bal >= MIN_ADMIN_XLM )) && return 0
  gas="caravel-gas-keeper-$$"
  log "admin has $bal XLM < $MIN_ADMIN_XLM, merging a friendbot account in"
  if "$STELLAR" keys generate "$gas" --fund --overwrite >/dev/null 2>&1 \
     && "$STELLAR" tx new account-merge -q --source-account "$gas" --account "$ADMIN_ADDRESS" >/dev/null 2>&1; then
    log "admin now $(xlm_balance "$ADMIN_ADDRESS") XLM"
  else
    log "WARN: XLM top-up failed (friendbot down?)"
  fi
  "$STELLAR" keys rm "$gas" >/dev/null 2>&1 || true
}

[[ -f "$ENV_FILE" ]] || { log "missing $ENV_FILE"; exit 1; }
if (( ONCE )); then push; exit $?; fi
log "nav-keeper every ${INTERVAL}s, env $ENV_FILE"
while true; do
  if push; then pause="$INTERVAL"; else pause=15; fi   # retry soon after a failed round
  top_up || true
  sleep "$pause"
done
