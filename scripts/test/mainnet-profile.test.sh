#!/usr/bin/env bash
# Checks for the mainnet plan-only profile and the untracked key loader
# (Raven R10, R12 UA-07). Nothing is sent: mainnet runs are --plan only and
# testnet is not touched.
#   scripts/test/mainnet-profile.test.sh            # offline + Horizon mainnet reads
#   OFFLINE=1 scripts/test/mainnet-profile.test.sh  # skip the Horizon checks
# Needs the stellar CLI (SAC / contract id derivation is local), python3, git;
# the online part reads https://horizon.stellar.org and builds the production wasm.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0 FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; [[ -n "${2:-}" ]] && sed 's/^/     /' <<<"$2"; }
check() { # check NAME WANT_RC(0|nonzero) NEEDLE OUTPUT RC
  local name="$1" want="$2" needle="$3" out="$4" rc="$5"
  if [[ "$want" == 0 && $rc != 0 ]] || [[ "$want" != 0 && $rc == 0 ]] || [[ "$out" != *"$needle"* ]]; then
    bad "$name (rc=$rc)" "$out"
  else ok "$name"; fi
}

# Public values only. Mainnet fixtures are public accounts read via Horizon:
# GCRYUGD5… is 3-of-5 and Circle's USDC issuer GA5ZSEJY… 2-of-4 (both
# multisig), GDQE7IXJ… is single-key, Franklin's BENJI issuer GBHNGLLI… has
# signers of weight 3 against a med threshold of 2 (one key signs alone).
MS3=GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC
MS2=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
SINGLE=GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5
HEAVY=GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5
DUMMY_G=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
mainnet_env() { # mainnet_env FILE [extra lines]: a complete plan input
  local f="$1"; shift
  {
    echo "ADMIN_ADDRESS=$MS3"; echo "GUARDIAN_ADDRESS=$MS2"
    echo "USDC_SAC=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
    echo "USDC_ASSET=USDC:$MS2"
    echo "ORACLE_ID=CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"   # format-only placeholder
    echo "FEED_DECIMALS=14"; echo 'COLLATERAL="BENJI"'
    echo "BENJI_TOKEN=CCDSDPD7FXB74PFB2SYCHGQRWLXQRYRTQSPCVSRJ7FAOLOUGWEYAXQ7A"
    echo "BENJI_ASSET=BENJI:$HEAVY"
    printf '%s\n' "$@"
  } > "$f"; chmod 600 "$f"
}
# A shell with no Caravel variables: the runs below must not inherit a key.
clean() { env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" "$@"; }
mn() { clean NETWORK=mainnet "$@" "$ROOT/scripts/deploy.sh" --plan 2>&1; }
TRACKED_ADMIN=$(grep -E '^ADMIN_ADDRESS=' "$ROOT/.env" | cut -d= -f2)

# --- key loader (scripts/lib/keys.sh), testnet --------------------------------
loader() { # loader ENV_FILE DEFAULT(0|1) [KEYS_FILE] -> "ADMIN=… ISSUER=… SECRET=set|unset rc"
  ( set +u; unset ADMIN_ADDRESS ADMIN_SECRET ISSUER_ADDRESS ISSUER_SECRET
    export HOME="$TMP/home"; [[ -n "${3:-}" ]] && export CARAVEL_KEYS_FILE="$3"
    set -a; source "$1"; set +a
    source "$ROOT/scripts/lib/keys.sh"
    load_private_keys "$1" "$2"; rc=$?
    echo "ADMIN=${ADMIN_ADDRESS:-} ISSUER=${ISSUER_ADDRESS:-} SECRET=${ADMIN_SECRET:+set} rc=$rc $KEYS_SOURCE" )
}
mkdir -p "$TMP/home/.local/lib/caravel"
printf 'ADMIN_ADDRESS=GTRACKEDADMIN\nADMIN_SECRET=tracked\nISSUER_ADDRESS=GTRACKEDISSUER\nISSUER_SECRET=tracked\n' > "$TMP/tracked.env"
printf 'ADMIN_ADDRESS=GUNTRACKED\nADMIN_SECRET="untracked"\n' > "$TMP/home/.local/lib/caravel/.env"
out=$(loader "$TMP/tracked.env" 1)
check "R10 default ENV_FILE: ADMIN from the untracked file, ISSUER from .env" 0 "ADMIN=GUNTRACKED ISSUER=GTRACKEDISSUER SECRET=set rc=0" "$out" 0
out=$(loader "$TMP/tracked.env" 0)
check "R10 explicit ENV_FILE (throwaway deploy) ignores the untracked file" 0 "ADMIN=GTRACKEDADMIN" "$out" 0
out=$(loader "$TMP/tracked.env" 0 "$TMP/home/.local/lib/caravel/.env")
check "R10 explicit ENV_FILE + CARAVEL_KEYS_FILE loads it" 0 "ADMIN=GUNTRACKED" "$out" 0
printf 'ADMIN_ADDRESS=GHALF\n' > "$TMP/half.env"
out=$(loader "$TMP/tracked.env" 0 "$TMP/half.env")
check "R10 a role is taken whole: no tracked ADMIN_SECRET next to an untracked ADMIN_ADDRESS" 0 "ADMIN=GHALF ISSUER=GTRACKEDISSUER SECRET= rc=0" "$out" 0
git -C "$TMP" init -q repo && cp "$TMP/half.env" "$TMP/repo/keys.env" \
  && git -C "$TMP/repo" add keys.env
out=$(loader "$TMP/tracked.env" 0 "$TMP/repo/keys.env")
check "R10 a keys file tracked in git is refused" 0 "rc=1 keys file $TMP/repo/keys.env is tracked in git" "$out" 0
printf 'NETWORK=mainnet\nADMIN_ADDRESS=%s\n' "$DUMMY_G" > "$TMP/mainnet-in-env.env"
out=$(clean ENV_FILE="$TMP/mainnet-in-env.env" "$ROOT/scripts/deploy.sh" --preflight 2>&1); rc=$?
check "NETWORK=mainnet inside a .env is refused (mainnet is a command-line choice)" 1 "never in a .env" "$out" $rc

# --- mainnet refusals (before any network read) ---------------------------------
out=$(clean NETWORK=mainnet "$ROOT/scripts/deploy.sh" 2>&1); rc=$?
check "mainnet without --plan refuses" 1 "supports only --plan" "$out" $rc
out=$(clean NETWORK=mainnet "$ROOT/scripts/deploy.sh" --plan --fresh 2>&1); rc=$?
check "mainnet --plan --fresh refuses" 1 "takes --plan only" "$out" $rc
out=$(mn HOME="$TMP/home"); rc=$?
check "mainnet with no untracked mainnet file refuses (tracked .env never read)" 1 "no untracked mainnet file" "$out" $rc
out=$(mn CARAVEL_KEYS_FILE="$ROOT/.env"); rc=$?
check "mainnet with CARAVEL_KEYS_FILE = tracked .env refuses" 1 "tracked repo .env" "$out" $rc
out=$(mn ENV_FILE="$ROOT/.env"); rc=$?
check "mainnet with ENV_FILE = tracked .env refuses" 1 "tracked in git" "$out" $rc
mainnet_env "$TMP/secret.env" "ADMIN_SECRET=SXXXX"
out=$(mn CARAVEL_KEYS_FILE="$TMP/secret.env"); rc=$?
check "mainnet file holding a *_SECRET refuses" 1 "holds a *_SECRET" "$out" $rc
mainnet_env "$TMP/ok.env"
out=$(cd "$ROOT" && env -i HOME="$HOME" PATH="$PATH" bash -c \
  'set -a; . ./.env; set +a; NETWORK=mainnet CARAVEL_KEYS_FILE="$1" scripts/deploy.sh --plan' _ "$TMP/ok.env" 2>&1); rc=$?
check "mainnet in a shell that sourced the tracked .env refuses its keys" 1 "is in the tracked .env" "$out" $rc
mainnet_env "$TMP/burner.env" "ADMIN_ADDRESS=$TRACKED_ADMIN"
out=$(mn CARAVEL_KEYS_FILE="$TMP/burner.env"); rc=$?
check "mainnet ADMIN_ADDRESS copied from the tracked .env refuses" 1 "ADMIN_ADDRESS: its value is in the tracked .env" "$out" $rc
mainnet_env "$TMP/same.env" "GUARDIAN_ADDRESS=$MS3"
out=$(mn CARAVEL_KEYS_FILE="$TMP/same.env"); rc=$?
check "mainnet admin == guardian refuses" 1 "ADMIN_ADDRESS == GUARDIAN_ADDRESS" "$out" $rc
mainnet_env "$TMP/nofeed.env" "ORACLE_ID="
out=$(mn CARAVEL_KEYS_FILE="$TMP/nofeed.env"); rc=$?
check "mainnet without an explicit feed id refuses" 1 "ORACLE_ID not set" "$out" $rc
mainnet_env "$TMP/badsac.env" "BENJI_TOKEN=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
mainnet_env "$TMP/safo.env" 'COLLATERAL="SAFO"' "SAFO_TOKEN=CCDSDPD7FXB74PFB2SYCHGQRWLXQRYRTQSPCVSRJ7FAOLOUGWEYAXQ7A"

if [[ -n "${OFFLINE:-}" ]]; then
  echo "OFFLINE=1: Horizon checks skipped"
else
  # --- mainnet checks that read Horizon ------------------------------------------
  out=$(mn CARAVEL_KEYS_FILE="$TMP/badsac.env"); rc=$?
  check "mainnet collateral token that is not the asset's SAC refuses" 1 "BENJI_SAC CCW67TSZ" "$out" $rc
  out=$(mn CARAVEL_KEYS_FILE="$TMP/safo.env"); rc=$?
  check "mainnet SAFO without explicit numbers refuses (disabled until due diligence)" 1 "SAFO has no production numbers" "$out" $rc
  mainnet_env "$TMP/single.env" "ADMIN_ADDRESS=$SINGLE"
  out=$(mn CARAVEL_KEYS_FILE="$TMP/single.env"); rc=$?
  check "mainnet single-key admin refuses" 1 "admin $SINGLE: not multisig" "$out" $rc
  mainnet_env "$TMP/heavy.env" "GUARDIAN_ADDRESS=$HEAVY"
  out=$(mn CARAVEL_KEYS_FILE="$TMP/heavy.env"); rc=$?
  check "mainnet guardian with a signer that meets the threshold alone refuses" 1 "meets the med threshold alone" "$out" $rc

  seq_of() { curl -fsS --max-time 10 "https://horizon.stellar.org/accounts/$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sequence"])'; }
  before="$(seq_of $MS3) $(seq_of $MS2)"
  out=$(mn CARAVEL_KEYS_FILE="$TMP/ok.env" HOME="$HOME"); rc=$?
  after="$(seq_of $MS3) $(seq_of $MS2)"
  check "mainnet --plan prints the plan" 0 "nothing was sent" "$out" $rc
  check "mainnet plan builds --build-only XDRs for upload, deploy, set_asset" 0 "set_asset --asset CCDSDPD7" "$out" $rc
  check "mainnet plan uses the production profile" 0 '"day_secs":86400,"margin_window_secs":259200,"grace_secs":86400' "$out" $rc
  cmds=$(grep -E '^ +stellar ' <<<"$out")
  [[ -n "$cmds" && "$cmds" != *friendbot* && "$cmds" != *"keys generate"* && "$cmds" == *--build-only* ]] \
    && ok "mainnet plan commands: --build-only, no friendbot, no key generation" \
    || bad "mainnet plan commands: --build-only, no friendbot, no key generation" "$cmds"
  [[ "$before" == "$after" ]] && ok "admin and guardian sequences unchanged ($before)" || bad "sequences changed: $before -> $after"
fi

echo "$PASS passed, $FAIL failed"
(( FAIL == 0 ))
