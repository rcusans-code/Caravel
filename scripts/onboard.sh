#!/usr/bin/env bash
# Onboard a team wallet: authorize it on tBENJI and top it up to a fixed
# testnet allowance of tBENJI and USDC.
#
#   scripts/onboard.sh <G-address> [tbenji_amount=200] [usdc_amount=100]
#
# Idempotent. Steps (each reads chain state first, sends a tx only if needed):
#   1. Account missing on testnet -> fund it with friendbot.
#   2. Missing tBENJI or USDC trustline -> print how to add it and exit 2.
#      Trustlines must be signed by the wallet owner (the app's "Add trustline"
#      button does both in one tx); the issuer cannot create them.
#   3. tBENJI SAC `authorized(id)` false -> issuer `set_authorized(id, true)`.
#      This flag is the app's access gate.
#   4. tBENJI balance < tbenji_amount -> issuer pays the difference (mint).
#   5. USDC balance < usdc_amount -> ADMIN pays the difference; if ADMIN holds
#      too little USDC it first buys more on the DEX (scripts/buy-usdc.sh).
#   6. TSAFO_ID set -> issuer allowlists the wallet on tSAFO (Spiko-style, no
#      trustline) and mints it up to TSAFO_AMOUNT (default = tbenji_amount).
#   7. Liquidator checklist (read only): tBENJI authorized, tSAFO allowlisted,
#      USDC vs the funding floor, set_liquidator on REPO_ID. set_liquidator
#      checks none of these, so check them before whitelisting a liquidator.
#      LIQUIDATOR=1 makes a missing item exit 3.
# Amounts are targets, not increments: a re-run tops up to them, never beyond.
# Keys come from <repo>/.env (role keys from the untracked ~/.local/lib/caravel/.env
# when present, scripts/lib/keys.sh) and reach the CLI via STELLAR_ACCOUNT (not argv).
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
[[ "$STELLAR_NETWORK" == testnet ]] || { echo "onboard.sh is testnet-only" >&2; exit 1; }
[[ -n "${RPC_URL:-}" ]] && export STELLAR_RPC_URL="$RPC_URL"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
HORIZON="${HORIZON_URL:-https://horizon-testnet.stellar.org}"

ADDR="${1:-}"
TBENJI_AMOUNT="${2:-200}"
USDC_AMOUNT="${3:-100}"
if [[ ! "$ADDR" =~ ^G[A-Z2-7]{55}$ ]]; then
  sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2
fi

log() { printf '[onboard] %s\n' "$*" >&2; }
stroops() { python3 -c "from decimal import Decimal as D; print(int(D('$1') * 10**7))"; }
account() { curl -sS -w '\n%{http_code}' "$HORIZON/accounts/$1"; }
# balance JSON CODE:ISSUER -> balance, or "none" without a trustline
balance_of() {
  python3 -c '
import json, sys
acc = json.loads(sys.argv[1]); code, issuer = sys.argv[2].split(":")
for b in acc["balances"]:
    if b.get("asset_code") == code and b.get("asset_issuer") == issuer:
        print(b["balance"]); break
else:
    print("none")' "$1" "$2"
}
lt() { python3 -c "import sys; sys.exit(0 if float('$1') < float('$2') else 1)"; }
diff_amt() { python3 -c "from decimal import Decimal as D; print(D('$2') - D('$1'))"; }
fetch() {
  local r; r=$(account "$ADDR"); CODE="${r##*$'\n'}"; ACC="${r%$'\n'*}"
}

# 1. account exists ---------------------------------------------------------------
fetch
if [[ "$CODE" == 404 ]]; then
  log "account not on testnet, funding with friendbot"
  curl -fsS "https://friendbot.stellar.org/?addr=$ADDR" >/dev/null
  fetch
fi
[[ "$CODE" == 200 ]] || { log "Horizon returned $CODE for $ADDR"; exit 1; }
log "account $ADDR exists"

# 2. trustlines (owner-signed) ---------------------------------------------------
TB=$(balance_of "$ACC" "$TBENJI_ASSET")
US=$(balance_of "$ACC" "$USDC_ASSET")
if [[ "$TB" == none || "$US" == none ]]; then
  missing=(); [[ "$TB" == none ]] && missing+=("$TBENJI_ASSET"); [[ "$US" == none ]] && missing+=("$USDC_ASSET")
  cat >&2 <<EOF
[onboard] $ADDR is missing trustline(s): ${missing[*]}
  Trustlines must be signed by the wallet owner. Either:
    - open the Caravel app, connect this wallet and press the "Add … trustline" button (one tx for both), or
    - stellar tx new change-trust --network testnet --source-account <owner key> --line <CODE:ISSUER>
      for each of: ${missing[*]}
  Then re-run: scripts/onboard.sh $ADDR $TBENJI_AMOUNT $USDC_AMOUNT
EOF
  exit 2
fi
log "trustlines present (tBENJI $TB, USDC $US)"

# 3. issuer authorizes on tBENJI (the app's access gate) ---------------------------
auth=$("$STELLAR" contract invoke -q --source-account "$ADMIN_ADDRESS" --send=no \
         --id "$TBENJI_SAC" -- authorized --id "$ADDR")
if [[ "$auth" == true ]]; then
  log "tBENJI already authorized"
else
  log "issuer set_authorized($ADDR, true) on tBENJI"
  STELLAR_ACCOUNT="$ISSUER_SECRET" "$STELLAR" contract invoke -q \
    --id "$TBENJI_SAC" -- set_authorized --id "$ADDR" --authorize true >/dev/null
fi

# 4. tBENJI allowance (issuer payment = mint) ---------------------------------------
if lt "$TB" "$TBENJI_AMOUNT"; then
  amt=$(diff_amt "$TB" "$TBENJI_AMOUNT")
  log "issuer pays $amt tBENJI"
  STELLAR_ACCOUNT="$ISSUER_SECRET" "$STELLAR" tx new payment -q \
    --destination "$ADDR" --asset "$TBENJI_ASSET" --amount "$(stroops "$amt")" >/dev/null
else
  log "tBENJI balance $TB >= $TBENJI_AMOUNT, nothing to pay"
fi

# 5. USDC allowance from ADMIN (buys on the DEX when short) -------------------------
if lt "$US" "$USDC_AMOUNT"; then
  amt=$(diff_amt "$US" "$USDC_AMOUNT")
  r=$(account "$ADMIN_ADDRESS"); admin_usdc=$(balance_of "${r%$'\n'*}" "$USDC_ASSET")
  [[ "$admin_usdc" == none ]] && { log "ADMIN has no USDC trustline (run scripts/deploy.sh)"; exit 1; }
  if lt "$admin_usdc" "$amt"; then
    buy=$(python3 -c "import math; print(max(100, math.ceil(float('$amt') - float('$admin_usdc'))))")
    log "ADMIN holds $admin_usdc USDC < $amt, buying $buy on the DEX"
    "$ROOT/scripts/buy-usdc.sh" "$buy" "$ADMIN_ADDRESS"
  fi
  log "ADMIN pays $amt USDC"
  STELLAR_ACCOUNT="$ADMIN_SECRET" "$STELLAR" tx new payment -q \
    --destination "$ADDR" --asset "$USDC_ASSET" --amount "$(stroops "$amt")" >/dev/null
else
  log "USDC balance $US >= $USDC_AMOUNT, nothing to pay"
fi

# 6. tSAFO: allowlist + mint (custom Soroban token, no trustline) ------------------
if [[ -n "${TSAFO_ID:-}" ]]; then
  tview() { "$STELLAR" contract invoke -q --source-account "$ADMIN_ADDRESS" --send=no --id "$TSAFO_ID" -- "$@"; }
  tissuer() { STELLAR_ACCOUNT="$ISSUER_SECRET" "$STELLAR" contract invoke -q --id "$TSAFO_ID" -- "$@" >/dev/null; }
  if [[ "$(tview is_whitelisted --account "$ADDR")" == true ]]; then
    log "tSAFO already allowlisted"
  else
    log "issuer allowlists $ADDR on tSAFO"
    tissuer set_whitelisted --account "$ADDR" --allowed true
  fi
  dec=$(tview decimals)
  have=$(tview balance --id "$ADDR" | tr -d '"')
  want=$(python3 -c "from decimal import Decimal as D; print(int(D('${TSAFO_AMOUNT:-$TBENJI_AMOUNT}') * 10**$dec))")
  if (( have < want )); then
    log "issuer mints $(( want - have )) tSAFO units"
    tissuer mint --to "$ADDR" --amount "$(( want - have ))"
  else
    log "tSAFO balance $have units >= $want, nothing to mint"
  fi
fi

# summary -------------------------------------------------------------------------
fetch
python3 -c '
import json, sys
acc = json.loads(sys.argv[1])
for b in acc["balances"]:
    name = b.get("asset_code", "XLM")
    auth = "" if name == "XLM" else ("  authorized" if b.get("is_authorized") else "  NOT authorized")
    bal = b["balance"]
    print(f"  {name:7} {bal:>20}{auth}")' "$ACC" >&2

# 7. liquidator checklist (read only: set_liquidator checks nothing, CMP-05) -------
if [[ -n "${REPO_ID:-}" ]]; then
  rview() { "$STELLAR" contract invoke -q --source-account "$ADMIN_ADDRESS" --send=no "$@" 2>/dev/null; }
  yn() { [[ "$1" == true ]] && echo yes || echo NO; }
  c_auth=$(yn "$(rview --id "$TBENJI_SAC" -- authorized --id "$ADDR")")
  c_tsafo=n/a; [[ -n "${TSAFO_ID:-}" ]] && c_tsafo=$(yn "$(rview --id "$TSAFO_ID" -- is_whitelisted --account "$ADDR")")
  c_liq=$(yn "$(rview --id "$REPO_ID" -- is_liquidator --who "$ADDR")")
  c_usdc=$(balance_of "$ACC" "$USDC_ASSET")
  log "liquidator checklist: tBENJI authorized $c_auth, tSAFO allowlisted $c_tsafo, USDC $c_usdc (needs >= the funding floor: cd scripts/keeper && npm run repos), set_liquidator $c_liq"
  missing=0
  if [[ "$c_auth" == NO || "$c_tsafo" == NO ]]; then missing=1; fi
  if [[ "$c_liq" == yes && $missing == 1 ]]; then
    log "WARN: $ADDR is a whitelisted liquidator but cannot receive every collateral token: those liquidations will fail"
  elif [[ "$c_liq" == NO ]]; then
    log "to make it a liquidator: admin propose_liquidator --liquidator $ADDR on $REPO_ID, then execute_liquidator after timelock_secs (Raven R6), once every item above is yes and USDC covers the floor"
  fi
  if [[ -n "${LIQUIDATOR:-}" && $missing == 1 ]]; then exit 3; fi
fi
log "done: $ADDR can use the app"
