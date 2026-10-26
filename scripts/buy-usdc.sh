#!/usr/bin/env bash
# Buy testnet USDC (Circle, USDC:GBBD47…LFLA5) on the testnet DEX with
# friendbot XLM. There is no USDC faucet; the SDEX has a deep XLM/USDC book
# (~9.3 XLM per USDC on 25 Oct 2026).
#
#   scripts/buy-usdc.sh [amount=100] [destination=ADMIN_ADDRESS]
#
# Per chunk of up to 500 USDC: friendbot funds a throwaway account (10,000
# XLM), it sends a strict-receive path payment XLM -> USDC straight to the
# destination (which needs a USDC trustline; the throwaway needs none), then
# merges its leftover XLM into ADMIN. ADMIN's own XLM is never spent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_DEFAULT=0; [[ -z "${ENV_FILE:-}" ]] && ENV_FILE_DEFAULT=1
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
STELLAR="${STELLAR:-$(command -v stellar || echo "$HOME/.local/bin/stellar")}"
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
# shellcheck source=lib/keys.sh
source "$ROOT/scripts/lib/keys.sh"   # R10: role keys from the untracked file when present
load_private_keys "$ENV_FILE" "$ENV_FILE_DEFAULT" || { echo "$KEYS_SOURCE" >&2; exit 1; }
export STELLAR_NETWORK="${NETWORK:-testnet}"
[[ -n "${RPC_URL:-}" ]] && export STELLAR_RPC_URL="$RPC_URL"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
HORIZON="${HORIZON_URL:-https://horizon-testnet.stellar.org}"

AMOUNT="${1:-100}"
DEST="${2:-$ADMIN_ADDRESS}"
CHUNK=500
log() { printf '[buy-usdc] %s\n' "$*" >&2; }
stroops() { python3 -c "from decimal import Decimal as D; print(int(D('$1') * 10**7))"; }

quote() { # quote USDC_AMOUNT -> XLM needed (Horizon path finder)
  curl -fsS "$HORIZON/paths/strict-receive?destination_asset_type=credit_alphanum4&destination_asset_code=${USDC_ASSET%%:*}&destination_asset_issuer=${USDC_ASSET##*:}&destination_amount=$1&source_assets=native" \
    | python3 -c 'import json,sys; r=json.load(sys.stdin)["_embedded"]["records"]; print(min(float(x["source_amount"]) for x in r) if r else "")'
}

left="$AMOUNT"
while python3 -c "import sys; sys.exit(0 if float('$left') > 0 else 1)"; do
  chunk=$(python3 -c "print(min(float('$left'), $CHUNK))")
  xlm=$(quote "$chunk")
  [[ -n "$xlm" ]] || { log "no XLM->USDC path on the testnet DEX for $chunk USDC"; exit 1; }
  max=$(python3 -c "print(round($xlm * 1.03 + 1, 7))")   # 3% slippage
  log "buying $chunk USDC for <= $max XLM (quote $xlm) -> $DEST"
  gas="caravel-usdc-$$"
  "$STELLAR" keys generate "$gas" --fund --overwrite >/dev/null 2>&1 || { log "friendbot failed"; exit 1; }
  if ! "$STELLAR" tx new path-payment-strict-receive -q --source-account "$gas" \
        --send-asset native --send-max "$(stroops "$max")" \
        --destination "$DEST" --dest-asset "$USDC_ASSET" --dest-amount "$(stroops "$chunk")" >/dev/null; then
    log "path payment failed"
    "$STELLAR" tx new account-merge -q --source-account "$gas" --account "$ADMIN_ADDRESS" >/dev/null 2>&1 || true
    "$STELLAR" keys rm "$gas" >/dev/null 2>&1 || true
    exit 1
  fi
  "$STELLAR" tx new account-merge -q --source-account "$gas" --account "$ADMIN_ADDRESS" >/dev/null 2>&1 \
    || log "WARN: merging leftover XLM into ADMIN failed"
  "$STELLAR" keys rm "$gas" >/dev/null 2>&1 || true
  left=$(python3 -c "print(float('$left') - $chunk)")
done
log "done: $AMOUNT USDC -> $DEST"
