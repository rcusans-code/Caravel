# shellcheck shell=bash
# Mainnet deploy profile, plan only (Raven R10 + R12 UA-07; docs/mainnet-readiness.md C1, C3).
# Sourced by scripts/deploy.sh for `NETWORK=mainnet scripts/deploy.sh --plan`.
# The caller defines log, die and check_sac (lib/deploy-guards.sh) and the
# key helpers (lib/keys.sh). scripts/test/mainnet-plan.test.sh tests it offline.
#
# Prints every transaction a mainnet deploy needs, as `stellar … --build-only`
# commands (each builds an unsigned XDR for the multisig signers), and sends
# nothing: no tx, no friendbot, no key generation, no file written. Reads:
# Horizon (signers, thresholds, sequence, trustlines) and the local build.
#
# Inputs come from one untracked file, CARAVEL_KEYS_FILE (default
# ~/.local/lib/caravel/mainnet.env, next to the testnet keepers' .env; it
# holds addresses and IDs, no secrets), plus the caller's environment. The
# tracked repo .env is never read, and a value copied from it is refused.
#
#   ADMIN_ADDRESS, GUARDIAN_ADDRESS   multisig G-accounts, admin != guardian
#   TREASURY_ADDRESS                  fee reserve (default ADMIN_ADDRESS)
#   USDC_SAC, USDC_ASSET              mainnet USDC SAC and CODE:ISSUER
#   ORACLE_ID, FEED_DECIMALS          the SEP-40 feed (e.g. RedStone) and its decimals()
#   COLLATERAL                        labels, e.g. "BENJI USTBL"
#   <L>_TOKEN                         collateral token contract (SAC or Soroban token)
#   <L>_ASSET                         CODE:ISSUER when <L> is a classic asset (checked)
#   <L>_HAIRCUT_BPS … <L>_MAX_OPEN_DEBT  override the DECISIONS #35 / #32 numbers
#   LIQUIDATORS                       G-accounts to whitelist (timelocked)
#   REPO_SALT                         32-byte hex; fixes the predicted REPO_ID

MAINNET_PASSPHRASE="Public Global Stellar Network ; September 2015"

# Production profile (README Parameters "Production intent"; DECISIONS #3,
# #33, #35, mechanics §7). Fixed: a mainnet contract with demo timers would
# run a 7-day repo in 7 minutes and let a loosening through in 2.
MN_FEE_BPS=1000                 # #3, #35
MN_LIQ_DISCOUNT_BPS=100         # #35
MN_DAY_SECS=86400
MN_MARGIN_WINDOW_SECS=259200    # 3 days: a Friday call survives to Monday's NAV
MN_GRACE_SECS=86400             # 1 day
MN_TIMELOCK_SECS=172800         # 2 days (#33); the production build refuses < 1 day
MN_MAX_NAV_AGE_SECS=345600      # 96 h (#25)
MN_BAND_SETTLE_SECS=86400       # 24 h (#41)

# Per-asset production numbers: haircut trigger band cap(USDC) floor ceiling
# (DECISIONS #35 risk numbers, #32 caps, BENJI bounds 0.90 / 1.10). SAFO has
# none: it stays disabled until due diligence (#35), so it needs explicit
# <L>_HAIRCUT_BPS / <L>_MARGIN_TRIGGER_BPS and lists with cap 0.
mn_asset_defaults() { # mn_asset_defaults LABEL -> "haircut trigger band cap floor ceiling"
  case "$1" in
    BENJI)       echo "300 200 50 2000000 0.90 1.10" ;;
    USTBL|USDY)  echo "300 200 50 2000000 - -" ;;
    EUTBL)       echo "1200 850 500 1000000 - -" ;;
    CETES)       echo "2350 1850 800 500000 - -" ;;
    SAFO)        echo "- - 1200 0 - -" ;;
    *)           echo "- - - - - -" ;;
  esac
}

# multisig_check LABEL ADDRESS: Horizon signers. Passes when no single signer
# can sign alone (every weight < med threshold), med and high thresholds are
# >= 2, and the signers together reach the high threshold (not bricked).
# Prints one line; returns 1 on failure.
multisig_check() {
  local label="$1" addr="$2" json
  if ! json=$(curl -fsS --max-time 10 "$MN_HORIZON/accounts/$addr" 2>/dev/null); then
    echo "FAIL $label $addr: not found on mainnet Horizon ($MN_HORIZON)"; return 1
  fi
  python3 - "$label" "$addr" "$json" <<'PY'
import json, sys
label, addr, d = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
t = d["thresholds"]; w = [s["weight"] for s in d["signers"] if s["weight"] > 0]
med, high = t["med_threshold"], t["high_threshold"]
top = max(w, default=0); total = sum(w)
desc = f"{len(w)} signer(s), weights {sorted(w, reverse=True)}, med {med}, high {high}, seq {d['sequence']}"
problems = []
if med < 2: problems.append("med threshold < 2")
if high < 2: problems.append("high threshold < 2")
if top >= max(med, 1): problems.append(f"one signer (weight {top}) meets the med threshold alone")
if total < high: problems.append("signers cannot reach the high threshold")
if problems:
    print(f"FAIL {label} {addr}: not multisig ({'; '.join(problems)}): {desc}"); sys.exit(1)
print(f"ok   {label} {addr}: multisig, {desc}")
PY
}

# has_trustline ADDRESS CODE:ISSUER
has_trustline() {
  curl -fsS --max-time 10 "$MN_HORIZON/accounts/$1" 2>/dev/null | python3 -c '
import json, sys
code, issuer = sys.argv[1].split(":")
bs = json.load(sys.stdin)["balances"]
sys.exit(0 if any(b.get("asset_code") == code and b.get("asset_issuer") == issuer for b in bs) else 1)' "$2"
}

mainnet_plan() {
  local f fails=() v role
  MN_HORIZON="${MAINNET_HORIZON_URL:-https://horizon.stellar.org}"
  MN_RPC="${MAINNET_RPC_URL:-https://mainnet.sorobanrpc.com}"
  export STELLAR_NETWORK_PASSPHRASE="$MAINNET_PASSPHRASE" STELLAR_RPC_URL="$MN_RPC"
  unset STELLAR_NETWORK

  # --- 1. inputs: an untracked file, never the tracked .env (R10) -------------
  if [[ "$ENV_FILE_DEFAULT" == 0 ]]; then
    git_tracked "$ENV_FILE" && die "mainnet refuses ENV_FILE=$ENV_FILE: it is tracked in git (testnet burner keys). Put mainnet inputs in an untracked CARAVEL_KEYS_FILE"
    die "mainnet ignores ENV_FILE; set CARAVEL_KEYS_FILE=$ENV_FILE instead"
  fi
  f="$(caravel_keys_file mainnet)"
  [[ -f "$f" ]] || die "mainnet refuses: no untracked mainnet file at $f, and the tracked .env is never read on mainnet. Write it (scripts/README.md, Mainnet runbook), chmod 600, outside git"
  [[ "$(realpath "$f")" == "$(realpath "$ROOT/.env")" ]] && die "mainnet refuses $f: it is the tracked repo .env (testnet burner keys)"
  git_tracked "$f" && die "mainnet refuses $f: it is tracked in git"
  grep -qE '^[A-Z0-9_]*_SECRET=' "$f" \
    && die "mainnet refuses $f: it holds a *_SECRET. Mainnet admin and guardian are multisig accounts; their signers sign the XDRs this plan prints with their own wallets, no key lives in a file"
  set -a; # shellcheck disable=SC1090
  source "$f"; set +a
  log "mainnet inputs: $f (untracked)"

  # Any key or address that is also in the tracked .env is a testnet burner
  # (e.g. a shell that ran `. ./.env` first): refuse it.
  if [[ -f "$ROOT/.env" ]]; then
    for v in $(compgen -v | grep -E '_SECRET$|^(ADMIN|GUARDIAN|ISSUER|FEEDER|TREASURY)_ADDRESS$' || true); do
      [[ -n "${!v:-}" ]] || continue
      grep -qF "=${!v}" "$ROOT/.env" \
        && die "mainnet refuses $v: its value is in the tracked .env (a testnet burner key). Mainnet keys never come from git"
    done
  fi
  for v in $(compgen -v | grep -E '_SECRET$' || true); do unset "$v"; done

  # --- 2. required inputs --------------------------------------------------------
  TREASURY_ADDRESS="${TREASURY_ADDRESS:-${ADMIN_ADDRESS:-}}"
  for v in ADMIN_ADDRESS GUARDIAN_ADDRESS TREASURY_ADDRESS USDC_SAC USDC_ASSET ORACLE_ID FEED_DECIMALS COLLATERAL; do
    [[ -n "${!v:-}" ]] || fails+=("$v not set (mainnet has no default for it)")
  done
  for v in ADMIN_ADDRESS GUARDIAN_ADDRESS; do
    [[ -z "${!v:-}" || "${!v}" =~ ^G[A-Z2-7]{55}$ ]] || fails+=("$v '${!v}' is not a G-account")
  done
  for v in USDC_SAC ORACLE_ID; do
    [[ -z "${!v:-}" || "${!v}" =~ ^C[A-Z2-7]{55}$ ]] || fails+=("$v '${!v}' is not a contract id")
  done
  [[ -z "${FEED_DECIMALS:-}" || "$FEED_DECIMALS" =~ ^[0-9]+$ ]] || fails+=("FEED_DECIMALS '$FEED_DECIMALS' is not a number")
  [[ -n "${ADMIN_ADDRESS:-}" && "${ADMIN_ADDRESS}" == "${GUARDIAN_ADDRESS:-}" ]] \
    && fails+=("ADMIN_ADDRESS == GUARDIAN_ADDRESS: the guardian is a second key (#33, OZ-05)")
  (( ${#fails[@]} )) && { printf 'FAIL %s\n' "${fails[@]}" >&2; die "mainnet refuses: ${#fails[@]} input(s) missing or invalid"; }

  # --- 3. checks (reads only) ----------------------------------------------------
  local checks=() line label tok asset d hc tr band cap floor ceil enabled
  local -a LABELS=() TOKENS=() ASSET_JSONS=()
  if line=$(check_sac USDC "$USDC_ASSET" "$USDC_SAC" 2>&1); then checks+=("ok   USDC_SAC matches $USDC_ASSET on mainnet")
  else fails+=("${line##*ERROR: }"); fi
  for label in $COLLATERAL; do
    [[ "$label" =~ ^[A-Z][A-Z0-9]*$ ]] || { fails+=("COLLATERAL label '$label' is not UPPERCASE"); continue; }
    v="${label}_TOKEN"; tok="${!v:-}"
    [[ "$tok" =~ ^C[A-Z2-7]{55}$ ]] || { fails+=("${label}_TOKEN not set or not a contract id"); continue; }
    v="${label}_ASSET"; asset="${!v:-}"
    if [[ -n "$asset" ]]; then
      if line=$(check_sac "$label" "$asset" "$tok" 2>&1); then checks+=("ok   ${label}_TOKEN matches $asset on mainnet")
      else fails+=("${line##*ERROR: }"); fi
    fi
    read -r hc tr band cap floor ceil <<<"$(mn_asset_defaults "$label")"
    v="${label}_HAIRCUT_BPS";        hc="${!v:-$hc}"
    v="${label}_MARGIN_TRIGGER_BPS"; tr="${!v:-$tr}"
    v="${label}_NAV_MOVE_BPS";       band="${!v:-$band}"
    v="${label}_MAX_OPEN_DEBT";      cap="${!v:-$cap}"
    v="${label}_NAV_FLOOR";          floor="${!v:-$floor}"
    v="${label}_NAV_CEILING";        ceil="${!v:-$ceil}"
    if ! [[ "$hc" =~ ^[0-9]+$ && "$tr" =~ ^[0-9]+$ && "$band" =~ ^[0-9]+$ && "$cap" =~ ^[0-9]+$ ]]; then
      fails+=("$label has no production numbers in DECISIONS #35/#32: set ${label}_HAIRCUT_BPS, ${label}_MARGIN_TRIGGER_BPS, ${label}_NAV_MOVE_BPS, ${label}_MAX_OPEN_DEBT"); continue
    fi
    # Contract bounds (#35): discount < trigger < haircut < 10,000; band > 0.
    if ! (( MN_LIQ_DISCOUNT_BPS < tr && tr < hc && hc < 10000 && band > 0 )); then
      fails+=("$label: needs discount $MN_LIQ_DISCOUNT_BPS < trigger $tr < haircut $hc < 10000 and band $band > 0"); continue
    fi
    enabled=true; (( cap == 0 )) && enabled=false
    d=$(python3 - "$tok" "$hc" "$tr" "$enabled" "$MN_MAX_NAV_AGE_SECS" "$band" "$floor" "$ceil" "$cap" "$MN_BAND_SETTLE_SECS" "$FEED_DECIMALS" <<'PY'
import json, sys
from decimal import Decimal as D
tok, hc, tr, en, age, band, floor, ceil, cap, settle, dec = sys.argv[1:12]
px = lambda x: None if x in ("-", "") else str(int(D(x) * 10 ** int(dec)))
print(json.dumps({"oracle_asset": {"Stellar": tok}, "haircut_bps": int(hc), "margin_trigger_bps": int(tr),
  "enabled": en == "true", "max_nav_age_secs": int(age), "max_nav_move_bps": int(band),
  "nav_floor": px(floor), "nav_ceiling": px(ceil), "max_open_debt": str(int(cap) * 10**7),
  "band_settle_secs": int(settle)}, separators=(",", ":")))
PY
) || { fails+=("$label: bad NAV floor/ceiling"); continue; }
    LABELS+=("$label"); TOKENS+=("$tok"); ASSET_JSONS+=("$d")
  done
  for v in ${LIQUIDATORS:-}; do
    [[ "$v" =~ ^G[A-Z2-7]{55}$ ]] || fails+=("LIQUIDATORS entry '$v' is not a G-account")
  done
  for role in admin guardian; do
    v="${role^^}_ADDRESS"
    if line=$(multisig_check "$role" "${!v}"); then checks+=("$line"); else fails+=("${line#FAIL }"); fi
  done
  if (( ${#fails[@]} )); then
    printf '%s\n' "${checks[@]}" >&2
    printf 'FAIL %s\n' "${fails[@]}" >&2
    die "mainnet refuses: ${#fails[@]} check(s) failed, no plan printed"
  fi

  # --- 4. production build (local, nothing sent) ---------------------------------
  local wasm sha salt repo_id commit
  if [[ -n "${MAINNET_WASM:-}" ]]; then
    wasm="$MAINNET_WASM"; [[ -f "$wasm" ]] || die "MAINNET_WASM $wasm not found"
    log "using prebuilt production wasm $wasm (attest.yml, built --features production)"
  else
    build_meta_args "$ROOT"
    log "building caravel-repo --features production (${BUILD_META[*]}) in target/production"
    (cd "$ROOT" && CARGO_TARGET_DIR="$ROOT/target/production" stellar contract build \
       --package caravel-repo --features production "${BUILD_META[@]}" >/dev/null 2>&1) \
      || die "production build failed (run: CARGO_TARGET_DIR=target/production stellar contract build --package caravel-repo --features production)"
    wasm="$ROOT/target/production/wasm32v1-none/release/caravel_repo.wasm"
  fi
  sha=$(sha256sum "$wasm" | cut -d' ' -f1)
  commit=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
  salt="${REPO_SALT:-$(printf 'caravel-repo:%s' "$sha" | sha256sum | cut -d' ' -f1)}"
  [[ "$salt" =~ ^[0-9a-f]{64}$ ]] || die "REPO_SALT must be 32 bytes of hex"
  repo_id=$(stellar contract id wasm --salt "$salt" --source-account "$ADMIN_ADDRESS" \
              --network-passphrase "$MAINNET_PASSPHRASE" --rpc-url "$MN_RPC" 2>/dev/null) \
    || die "cannot derive the repo contract id (stellar CLI?)"

  local config_json
  config_json=$(printf '{"admin":"%s","usdc":"%s","oracle":"%s","treasury":"%s","fee_bps":%s,"liquidation_discount_bps":%s,"day_secs":%s,"margin_window_secs":%s,"grace_secs":%s,"guardian":"%s","timelock_secs":%s}' \
    "$ADMIN_ADDRESS" "$USDC_SAC" "$ORACLE_ID" "$TREASURY_ADDRESS" "$MN_FEE_BPS" "$MN_LIQ_DISCOUNT_BPS" \
    "$MN_DAY_SECS" "$MN_MARGIN_WINDOW_SECS" "$MN_GRACE_SECS" "$GUARDIAN_ADDRESS" "$MN_TIMELOCK_SECS")

  # --- 5. the plan (stdout) --------------------------------------------------------
  local n=0 cli=stellar i
  local net="--network-passphrase \"$MAINNET_PASSPHRASE\" --rpc-url $MN_RPC"
  tx() { n=$((n + 1)); printf '\n  %2d. %s\n      %s\n' "$n" "$1" "$2"; }
  cat <<EOF
PLAN mainnet: nothing is sent. Every command builds an unsigned XDR (--build-only);
sign it with the account's multisig signers, then \`stellar tx send\`.

Checks (reads only):
$(printf '  %s\n' "${checks[@]}")

Build      caravel_repo.wasm --features production (timelock floor 1 day, instance TTL 30 days)
           sha256 $sha  commit $commit
Repo id    $repo_id  (admin + salt $salt)
Profile    day_secs $MN_DAY_SECS, margin window $MN_MARGIN_WINDOW_SECS s, grace $MN_GRACE_SECS s, timelock $MN_TIMELOCK_SECS s,
           fee $MN_FEE_BPS bps, liquidation discount $MN_LIQ_DISCOUNT_BPS bps, NAV age $MN_MAX_NAV_AGE_SECS s, band settle $MN_BAND_SETTLE_SECS s
Feed       $ORACLE_ID ($FEED_DECIMALS decimals; the constructor requires base USD, STD-01)

Signed by the admin multisig ($ADMIN_ADDRESS):
EOF
  tx "upload the production wasm" \
     "$cli contract upload $net --source-account $ADMIN_ADDRESS --wasm $wasm --build-only"
  tx "deploy the repo contract -> $repo_id (constructor checks 7-decimal USDC, USD feed, guardian != admin, timelock >= 1 day)" \
     "$cli contract deploy $net --source-account $ADMIN_ADDRESS --wasm-hash $sha --salt $salt --build-only -- --config '$config_json'"
  for i in "${!LABELS[@]}"; do
    tx "set_asset ${LABELS[$i]} (first listing; instant, R12 UA-09 would timelock it)" \
       "$cli contract invoke $net --source-account $ADMIN_ADDRESS --id $repo_id --build-only -- set_asset --asset ${TOKENS[$i]} --config '${ASSET_JSONS[$i]}'"
  done
  for v in ${LIQUIDATORS:-}; do
    tx "propose_liquidator $v (UA-03: executable after timelock_secs, $MN_TIMELOCK_SECS s)" \
       "$cli contract invoke $net --source-account $ADMIN_ADDRESS --id $repo_id --build-only -- propose_liquidator --liquidator $v"
    tx "execute_liquidator $v, between eta and eta + $MN_TIMELOCK_SECS s (the guardian can cancel before)" \
       "$cli contract invoke $net --source-account $ADMIN_ADDRESS --id $repo_id --build-only -- execute_liquidator --liquidator $v"
  done
  local treasury_trust=1
  [[ "$TREASURY_ADDRESS" =~ ^G ]] && ! has_trustline "$TREASURY_ADDRESS" "$USDC_ASSET" && treasury_trust=0
  if (( ! treasury_trust )) && [[ "$TREASURY_ADDRESS" == "$ADMIN_ADDRESS" ]]; then
    tx "treasury (admin) USDC trustline: without it every repay with a fee reverts (#13)" \
       "$cli tx new change-trust $net --source-account $ADMIN_ADDRESS --line $USDC_ASSET --build-only"
  fi
  echo
  echo "Signed by other parties (not ours to send):"
  for i in "${!LABELS[@]}"; do
    v="${LABELS[$i]}_ASSET"
    if [[ -n "${!v:-}" ]]; then
      echo "  - ${!v#*:} (${LABELS[$i]} issuer): set_authorized($repo_id, true) on ${TOKENS[$i]}, and for every liquidator (AUTH_REQUIRED, scripts/README.md Liquidator checklist)"
    else
      echo "  - ${LABELS[$i]} token admin: allowlist $repo_id and every liquidator on ${TOKENS[$i]} (Spiko-style allowlist)"
    fi
  done
  if (( ! treasury_trust )) && [[ "$TREASURY_ADDRESS" != "$ADMIN_ADDRESS" ]]; then
    echo "  - treasury $TREASURY_ADDRESS: change-trust $USDC_ASSET (no USDC trustline: every repay with a fee would revert)"
  fi
  cat <<EOF

Not on mainnet (testnet only): mock oracle deploy and set_price, the tSAFO mock,
friendbot top-ups, guardian key generation, demo mints and allowlists, winddown,
writes to .env / deployments/testnet.json / bindings.

$n tx(s) for the admin multisig; nothing was sent.
EOF
  return 0
}
