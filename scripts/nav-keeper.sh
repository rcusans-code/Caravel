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
# It never re-posts a price that jumped more than NAV_JUMP_ACK_BPS (default
# 1000, the keeper's needs-ack class) from the last price it posted, unless
# the exact price is in NAV_JUMP_ACK (or pinned with NAV / SAFO_NAV): 20
# re-posts would fill the contract's 20-record band window and push the
# pre-jump price out of the keeper's history (keeper-launder). It logs, ALERTs
# (first round, then every 20) and lets the price go stale instead, so the
# contract stops takes, margin calls and liquidations; repay and top-up still
# work. The last posted price per asset lives in NAV_KEEPER_STATE (default
# ${XDG_STATE_HOME:-~/.local/state}/caravel/nav-keeper-<ORACLE_ID>.state), so
# a restart keeps it; with no state yet the current price is trusted.
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
  local -a refused=()
  load_refs
  for i in "${!labels[@]}"; do
    prices[i]=$(price_for "${labels[i]}" "${assets[i]}" "${pins[i]}") || { prices[i]=""; continue; }
    if ! guard_price "${labels[i]}" "${prices[i]}" "${pins[i]}"; then prices[i]=""; refused[i]=1; fi
  done
  save_refs
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
    [[ -n "${refused[i]:-}" ]] && continue   # refused on purpose: guard_price logged and alerted
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

# Jump refusal (keeper-launder). REF: asset label -> last price posted (or
# accepted), persisted per oracle; REFUSED: consecutive refused rounds.
declare -A REF=() REFUSED=()
state_file() { echo "${NAV_KEEPER_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/caravel/nav-keeper-${ORACLE_ID}.state}"; }
load_refs() { # re-read every round: ORACLE_ID can change under us (redeploy)
  local f label price
  REF=(); f=$(state_file)
  [[ -f "$f" ]] || return 0
  while read -r label price; do
    [[ "$label" =~ ^[A-Za-z0-9_]+$ && "$price" =~ ^[0-9]+$ ]] && REF[$label]=$price
  done <"$f"
}
save_refs() { # atomic: tmp + rename
  local f label tmp
  f=$(state_file); tmp="$f.$$.tmp"
  mkdir -p "$(dirname "$f")" || { log "WARN: cannot create $(dirname "$f"): jump refusal forgets its reference on restart"; return 0; }
  { for label in "${!REF[@]}"; do printf '%s %s\n' "$label" "${REF[$label]}"; done; } >"$tmp" && mv -f "$tmp" "$f" \
    || log "WARN: cannot write $f: jump refusal forgets its reference on restart"
}
jump_bps() { # jump_bps PRICE REF -> |PRICE - REF| in bps of REF (floor)
  python3 -c 'import sys; p,r=int(sys.argv[1]),int(sys.argv[2]); print(abs(p-r)*10000//r if r>0 else (0 if p==r else 10000))' "$1" "$2"
}
acked() { # acked PRICE: PRICE is listed in NAV_JUMP_ACK (comma-separated oracle integers)
  local x; local -a list
  IFS=',' read -ra list <<<"${NAV_JUMP_ACK:-}"
  for x in "${list[@]}"; do [[ "${x//[[:space:]]/}" == "$1" ]] && return 0; done
  return 1
}
guard_price() { # guard_price LABEL PRICE PIN: 0 = post it (and remember it), 1 = refuse
  local label="$1" price="$2" pin="$3" ref="${REF[$1]:-}" bps max="${NAV_JUMP_ACK_BPS:-1000}" n
  if [[ -n "$pin" || -z "$ref" || "$price" == "$ref" ]] || acked "$price"; then
    REF[$label]=$price; REFUSED[$label]=0; return 0
  fi
  bps=$(jump_bps "$price" "$ref") || { log "$label jump check failed, not re-posting $price"; return 1; }
  if (( bps <= max )); then REF[$label]=$price; REFUSED[$label]=0; return 0; fi
  n=$(( ${REFUSED[$label]:-0} + 1 )); REFUSED[$label]=$n
  log "$label NOT re-posting $price: $bps bps from the last posted $ref (> NAV_JUMP_ACK_BPS $max), letting it go stale"
  if (( n == 1 || n % 20 == 0 )); then
    alert "$label NAV $price jumped $bps bps from $ref (oracle ${ORACLE_ID:0:8}…), not re-posted ($n rounds): it goes stale, takes, margin calls and liquidations stop. Push the corrected price, or add $price to NAV_JUMP_ACK in $ENV_FILE if it is real"
  fi
  return 1
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
HORIZON_TIMEOUT="${HORIZON_TIMEOUT:-10}"   # s per Horizon request: a hung Horizon must not stall the loop (Raven D-02)
TOPUP_TIMEOUT="${TOPUP_TIMEOUT:-60}"       # s per friendbot / merge CLI call (outside the 20 s `cli` cap: friendbot is slow)
slow_cli() { timeout -k 5 "$TOPUP_TIMEOUT" "$STELLAR" "$@"; }
xlm_balance() {
  curl -fsS --max-time "${HORIZON_TIMEOUT:-10}" "${HORIZON_URL:-https://horizon-testnet.stellar.org}/accounts/$1" | python3 -c \
    'import json,sys; print(int(float(next(b["balance"] for b in json.load(sys.stdin)["balances"] if b["asset_type"]=="native"))))'
}
top_up() {
  local bal gas
  bal=$(xlm_balance "$ADMIN_ADDRESS") || return 0
  (( bal >= MIN_ADMIN_XLM )) && return 0
  gas="caravel-gas-keeper-$$"
  log "admin has $bal XLM < $MIN_ADMIN_XLM, merging a friendbot account in"
  if slow_cli keys generate "$gas" --fund --overwrite >/dev/null 2>&1 \
     && slow_cli tx new account-merge -q --source-account "$gas" --account "$ADMIN_ADDRESS" >/dev/null 2>&1; then
    log "admin now $(xlm_balance "$ADMIN_ADDRESS") XLM"
  else
    log "WARN: XLM top-up failed (friendbot down or timed out after ${TOPUP_TIMEOUT}s?)"
  fi
  slow_cli keys rm "$gas" >/dev/null 2>&1 || true
}

[[ -f "$ENV_FILE" ]] || { log "missing $ENV_FILE"; exit 1; }
if (( ONCE )); then push; exit $?; fi
log "nav-keeper every ${INTERVAL}s, env $ENV_FILE"
while true; do
  if push; then pause="$INTERVAL"; else pause=15; fi   # retry soon after a failed round
  top_up || true
  sleep "$pause"
done
