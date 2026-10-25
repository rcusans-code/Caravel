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
# Signs set_price with ADMIN_SECRET from <repo>/.env (the oracle admin), passed
# to the CLI through STELLAR_ACCOUNT so it never shows up in `ps`.
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

push() { # one round: every collateral asset in .env
  load_env   # re-read every round: a redeploy changes ORACLE_ID / TSAFO_ID
  local rc=0
  push_asset tBENJI "$TBENJI_SAC" "${NAV:-}" || rc=1
  if [[ -n "${TSAFO_ID:-}" ]]; then push_asset tSAFO "$TSAFO_ID" "${SAFO_NAV:-}" || rc=1; fi
  return $rc
}

push_asset() { # push_asset LABEL TOKEN_ID PINNED_NAV
  local label="$1" ASSET="{\"Stellar\":\"$2\"}" pin="$3" last price ts out
  last=$("$STELLAR" contract invoke -q --source-account "$ADMIN_ADDRESS" --send=no \
           --id "$ORACLE_ID" -- lastprice --asset "$ASSET" 2>&1) || { log "$label lastprice failed: ${last##*$'\n'}"; return 1; }
  if [[ -n "$pin" ]]; then
    price=$(python3 -c "from decimal import Decimal as D; print(int(D('$pin') * 10**14))")
  elif [[ "$last" == "null" || -z "$last" ]]; then
    price=100000000000000          # 1.00 at 14 decimals
  else
    price=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["price"])' "$last")
  fi
  local try ok=0
  for try in 1 2 3; do
    if out=$(STELLAR_ACCOUNT="$ADMIN_SECRET" "$STELLAR" contract invoke -q \
               --id "$ORACLE_ID" -- set_price --asset "$ASSET" --price "$price" 2>&1); then
      ok=1; break
    fi
    log "$label set_price attempt $try FAILED: $(grep -v '^[[:space:]]*$' <<<"$out" | tail -n 3 | tr '\n' ' ')"
    (( try < 3 )) && sleep 5
  done
  (( ok )) || return 1
  ts=$("$STELLAR" contract invoke -q --source-account "$ADMIN_ADDRESS" --send=no \
         --id "$ORACLE_ID" -- lastprice --asset "$ASSET" 2>/dev/null)
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
