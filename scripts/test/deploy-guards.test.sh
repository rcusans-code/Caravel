#!/usr/bin/env bash
# Offline checks for the Raven R4 deploy guards (no RPC, no tx, no secrets).
#   scripts/test/deploy-guards.test.sh
# Needs the stellar CLI (SAC id derivation is local) and python3.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); echo "ok   $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL $1"; [[ -n "${2:-}" ]] && sed 's/^/     /' <<<"$2"; }

# Public values only: SAC ids and classic assets from deployments/testnet.json,
# dummy keys (the guards run before any key is used).
read -r USDC_SAC TBENJI_SAC USDC_ASSET TBENJI_ASSET < <(python3 - "$ROOT/deployments/testnet.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(d["contracts"]["usdc"], d["contracts"]["tbenji"], d["assets"]["usdc"], d["assets"]["tbenji"])
PY
)
DUMMY_G="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
write_env() { # write_env FILE USDC_ASSET TBENJI_ASSET [extra lines]
  local f="$1"; shift
  {
    for v in ADMIN ISSUER LIQUIDATOR BORROWER LENDER; do echo "${v}_ADDRESS=$DUMMY_G"; done
    echo "ADMIN_SECRET=dummy"; echo "ISSUER_SECRET=dummy"
    echo "USDC_SAC=$USDC_SAC"; echo "TBENJI_SAC=$TBENJI_SAC"
    [[ -n "$1" ]] && echo "USDC_ASSET=$1"
    [[ -n "$2" ]] && echo "TBENJI_ASSET=$2"
    shift 2; printf '%s\n' "$@"
  } > "$f"
}
preflight() { ENV_FILE="$1" "$ROOT/scripts/deploy.sh" --preflight 2>&1; }

# --- AS-05: *_ASSET required and must derive to *_SAC ------------------------
write_env "$TMP/match.env" "$USDC_ASSET" "$TBENJI_ASSET"
out=$(preflight "$TMP/match.env"); rc=$?
[[ $rc == 0 && "$out" == *"preflight ok"* ]] && ok "AS-05 matching assets pass preflight" || bad "AS-05 matching assets pass preflight" "$out"

write_env "$TMP/swap.env" "$USDC_ASSET" "$USDC_ASSET"
out=$(preflight "$TMP/swap.env"); rc=$?
[[ $rc != 0 && "$out" == *"TBENJI_SAC $TBENJI_SAC does not match TBENJI_ASSET"* ]] && ok "AS-05 mismatched TBENJI_ASSET refused" || bad "AS-05 mismatched TBENJI_ASSET refused" "$out"

write_env "$TMP/usdc.env" "${TBENJI_ASSET}" "$TBENJI_ASSET"
out=$(preflight "$TMP/usdc.env"); rc=$?
[[ $rc != 0 && "$out" == *"USDC_SAC $USDC_SAC does not match USDC_ASSET"* ]] && ok "AS-05 mismatched USDC_ASSET refused" || bad "AS-05 mismatched USDC_ASSET refused" "$out"

write_env "$TMP/missing.env" "" "$TBENJI_ASSET"
out=$(preflight "$TMP/missing.env"); rc=$?
[[ $rc != 0 && "$out" == *"USDC_ASSET not set"* ]] && ok "AS-05 missing USDC_ASSET refused" || bad "AS-05 missing USDC_ASSET refused" "$out"

write_env "$TMP/junk.env" "USDC" "$TBENJI_ASSET"
out=$(preflight "$TMP/junk.env"); rc=$?
[[ $rc != 0 && "$out" == *"is not CODE:ISSUER"* ]] && ok "AS-05 malformed USDC_ASSET refused" || bad "AS-05 malformed USDC_ASSET refused" "$out"

# --- AS-06: repo-contract authorization fails hard, G-accounts WARN ----------
auth_case() { # auth_case AS_ISSUER_RC AUTHORIZED_AFTER REQUIRED -> prints rc + log
  (
    log() { echo "$*"; }; die() { echo "ERROR: $*"; exit 1; }
    STATE="$TMP/authorized"; echo false > "$STATE"
    view() { cat "$STATE"; }
    # shellcheck source=../lib/deploy-guards.sh
    source "$ROOT/scripts/lib/deploy-guards.sh"
    as_issuer() { [[ "$AS_RC" == 0 ]] && echo "$AFTER" > "$STATE"; return "$AS_RC"; }
    AS_RC="$1" AFTER="$2"
    authorize_holder tBENJI CTOKEN CREPO "$3"
  ) 2>&1
}
out=$(auth_case 1 false 1); rc=$?
[[ $rc != 0 && "$out" == *"ERROR: set_authorized(CREPO) on tBENJI failed"* ]] && ok "AS-06 failed set_authorized on the repo stops the deploy" || bad "AS-06 failed set_authorized on the repo stops the deploy" "$out"
out=$(auth_case 0 false 1); rc=$?
[[ $rc != 0 && "$out" == *"still false"* ]] && ok "AS-06 authorized(repo) still false stops the deploy" || bad "AS-06 authorized(repo) still false stops the deploy" "$out"
out=$(auth_case 0 true 1); rc=$?
[[ $rc == 0 ]] && ok "AS-06 repo authorized passes" || bad "AS-06 repo authorized passes" "$out"
out=$(auth_case 1 false 0); rc=$?
[[ $rc == 0 && "$out" == *"WARN: set_authorized failed for CREPO"* ]] && ok "AS-06 G-account failure stays a WARN" || bad "AS-06 G-account failure stays a WARN" "$out"
grep -q 'authorize_holder tBENJI "$TBENJI_SAC" "$REPO_ID" 1' "$ROOT/scripts/deploy.sh" \
  && ok "AS-06 deploy.sh marks the repo contract required" || bad "AS-06 deploy.sh marks the repo contract required"

# --- STD-05: SEP-46 meta on the build, reuse ignores it ----------------------
out=$( ( log() { echo "$*"; }; source "$ROOT/scripts/lib/deploy-guards.sh"; build_meta_args "$ROOT"; printf '%s\n' "${BUILD_META[@]}" ) )
sha=$(git -C "$ROOT" rev-parse HEAD)
[[ "$out" == *"source_repo=github:rcusans-code/Caravel"* && "$out" == *"commit_sha=$sha"* ]] \
  && ok "STD-05 build meta has source_repo and commit_sha" || bad "STD-05 build meta has source_repo and commit_sha" "$out"
grep -q 'stellar contract build "${BUILD_META\[@\]}"' "$ROOT/scripts/deploy.sh" \
  && ok "STD-05 deploy.sh builds with the meta" || bad "STD-05 deploy.sh builds with the meta"
out=$(PYTHONDONTWRITEBYTECODE=1 python3 - "$ROOT/scripts" <<'PY' 2>&1
import importlib.util, sys
spec = importlib.util.spec_from_file_location("wch", sys.argv[1] + "/wasm-code-hash.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def custom(name, payload):
    body = bytes([len(name)]) + name + payload
    return b"\x00" + bytes([len(body)]) + body
code = b"\x01\x04\x01\x60\x00\x00"           # type section: one () -> () func type
other_code = b"\x01\x05\x01\x60\x01\x7f\x00"  # (i32) -> ()
base = b"\0asm\x01\0\0\0"
a = base + code + custom(b"contractmetav0", b"commit_sha=aaaa")
b = base + code + custom(b"contractmetav0", b"commit_sha=bbbb") + custom(b"contractmetav0", b"x=y")
c = base + other_code + custom(b"contractmetav0", b"commit_sha=aaaa")
d = base + code + custom(b"contractspecv0", b"fn1") + custom(b"contractmetav0", b"m")
e = base + code + custom(b"contractspecv0", b"fn2") + custom(b"contractmetav0", b"m")
assert m.code_hash(a) == m.code_hash(b), "meta-only change must keep the hash"
assert m.code_hash(a) != m.code_hash(c), "code change must change the hash"
assert m.code_hash(d) != m.code_hash(e), "spec change must change the hash"
print("hash ok")
PY
)
[[ "$out" == "hash ok" ]] && ok "STD-05 code hash ignores contractmetav0 only" || bad "STD-05 code hash ignores contractmetav0 only" "$out"

# --- UA-05: winddown guards and the superseded list -------------------------
CURRENT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["contracts"]["repo"])' "$ROOT/deployments/testnet.json")
out=$(ENV_FILE="$TMP/match.env" "$ROOT/scripts/winddown.sh" --dry-run "$CURRENT" 2>&1); rc=$?
[[ $rc != 0 && "$out" == *"refusing to wind down the live repo"* ]] && ok "UA-05 winddown refuses the live repo" || bad "UA-05 winddown refuses the live repo" "$out"
write_env "$TMP/main.env" "$USDC_ASSET" "$TBENJI_ASSET" "NETWORK=mainnet"
out=$(ENV_FILE="$TMP/main.env" "$ROOT/scripts/winddown.sh" --dry-run CXXX 2>&1); rc=$?
[[ $rc != 0 && "$out" == *"testnet-only"* ]] && ok "UA-05 winddown is testnet-only" || bad "UA-05 winddown is testnet-only" "$out"
python3 - "$ROOT/deployments/testnet.json" <<'PY' && ok "UA-05 testnet.json lists superseded repos, not the live one" || bad "UA-05 testnet.json lists superseded repos, not the live one"
import json, re, sys
d = json.load(open(sys.argv[1]))
s = d.get("superseded", [])
assert s and d["contracts"]["repo"] not in s and len(set(s)) == len(s)
assert all(re.fullmatch(r"C[A-Z2-7]{55}", i) for i in s)
PY
grep -q 'scripts/winddown.sh" $SUPERSEDED_ADD' "$ROOT/scripts/deploy.sh" \
  && ok "UA-05 deploy.sh winds down the repo it replaces" || bad "UA-05 deploy.sh winds down the repo it replaces"

for f in deploy.sh winddown.sh lib/deploy-guards.sh test/deploy-guards.test.sh test/deploy-resume.test.sh; do
  bash -n "$ROOT/scripts/$f" && ok "bash -n scripts/$f" || bad "bash -n scripts/$f"
done

echo "$PASS passed, $FAIL failed"
(( FAIL == 0 ))
