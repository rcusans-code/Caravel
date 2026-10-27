#!/usr/bin/env bash
# Offline test: a deploy.sh run that dies after it replaced REPO_ID must not
# lose the replaced repo (UA-05). No RPC, no tx, no secrets: a fake `stellar`
# CLI keeps contract state in a temp dir, a fake `curl` answers Horizon, and
# winddown.sh is stubbed to log its arguments.
#   scripts/test/deploy-resume.test.sh
# Needs python3 and the real stellar CLI (only for the local SAC derivation).
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); echo "ok   $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL $1"; [[ -n "${2:-}" ]] && sed 's/^/     /' <<<"$2"; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi }

REAL_STELLAR="$(command -v stellar)" || { echo "needs the stellar CLI"; exit 1; }
ROOT="$TMP/repo" STATE="$TMP/chain" BIN="$TMP/bin" WASM="$TMP/wasm"
mkdir -p "$ROOT/deployments" "$STATE/c" "$BIN" "$WASM"; : > "$STATE/winddown.log"
cp -r "$SRC/scripts" "$ROOT/scripts"
cp "$SRC/README.md" "$ROOT/README.md"
cat > "$ROOT/scripts/winddown.sh" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$STATE/winddown.log"
EOF

# Tiny valid wasm modules: one custom section each, so code hashes differ.
mkwasm() { python3 -c 'import sys; n=sys.argv[2].encode(); body=bytes([len(n)])+n; open(sys.argv[1],"wb").write(b"\0asm\x01\0\0\0"+bytes([0,len(body)])+body)' "$1" "$2"; }
mkwasm "$WASM/caravel_oracle.wasm" oracle
mkwasm "$WASM/caravel_repo.wasm" repo-v2
mkwasm "$WASM/caravel_spiko_mock.wasm" spiko
mkwasm "$TMP/old_repo.wasm" repo-v1

# Fake stellar: contracts live in $STATE/c/<id>.wasm (+ .config, .assets.json).
# set_asset on the token named in $STATE/fail_set_asset fails once (TxBadSeq).
cat > "$BIN/stellar" <<'EOF'
#!/usr/bin/env python3
import json, os, shutil, sys, hashlib
S = os.environ["FAKE_STATE"]; a = sys.argv[1:]
def opt(name, args):
    return args[args.index(name) + 1] if name in args else None
if a[:3] == ["contract", "id", "asset"]:
    os.execv(os.environ["REAL_STELLAR"], [os.environ["REAL_STELLAR"]] + a)
if a[:2] == ["keys", "address"]: print(os.environ["FAKE_G"]); sys.exit(0)
if a[:2] == ["keys", "secret"]: print("S" + "A" * 55); sys.exit(0)
if a[:2] == ["contract", "fetch"]:
    src = f"{S}/c/{opt('--id', a)}.wasm"
    if not os.path.exists(src): sys.exit(1)
    shutil.copy(src, opt("-o", a)); sys.exit(0)
if a[:2] == ["contract", "deploy"]:
    n = len(os.listdir(f"{S}/c"))
    cid = ("C" + hashlib.sha256(f"{n}".encode()).hexdigest().upper().translate(str.maketrans("0189", "2345")))[:56]
    shutil.copy(opt("--wasm", a), f"{S}/c/{cid}.wasm")
    ctor = a[a.index("--") + 1:]
    if "--config" in ctor: open(f"{S}/c/{cid}.config", "w").write(opt("--config", ctor))
    open(f"{S}/deploys.log", "a").write(cid + "\n")
    print(cid); sys.exit(0)
if a[:2] == ["contract", "invoke"]:
    cid = opt("--id", a); fn, args = a[a.index("--") + 1], a[a.index("--") + 2:]
    if fn == "config":
        p = f"{S}/c/{cid}.config"
        if not os.path.exists(p): sys.exit(1)
        print(open(p).read()); sys.exit(0)
    assets_p = f"{S}/c/{cid}.assets.json"
    assets = json.load(open(assets_p)) if os.path.exists(assets_p) else {}
    if fn == "asset":
        tok = opt("--asset", args)
        if tok not in assets: sys.exit(1)
        print(json.dumps(assets[tok])); sys.exit(0)
    if fn == "set_asset":
        tok = opt("--asset", args); fp = f"{S}/fail_set_asset"
        if os.path.exists(fp) and open(fp).read().strip() == tok:
            os.remove(fp); print("error: TxBadSeq", file=sys.stderr); sys.exit(1)
        assets[tok] = json.loads(opt("--config", args)); json.dump(assets, open(assets_p, "w")); sys.exit(0)
    if fn == "lastprice": print('{"price":"100000000000000","timestamp":1}'); sys.exit(0)
    if fn == "decimals": print("7"); sys.exit(0)
    if fn in ("is_liquidator", "is_whitelisted", "authorized"): print("true"); sys.exit(0)
    if fn == "balance": print('"500000"'); sys.exit(0)
    if fn == "pending_liquidator": sys.exit(1)
    sys.exit(0)   # any other send: accepted
sys.exit(0)
EOF
# Fake curl: every Horizon account has 10k XLM and a USDC trustline.
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env python3
import json, os
code, issuer = os.environ["FAKE_USDC"].split(":")
print(json.dumps({"balances": [{"asset_type": "native", "balance": "10000.0"},
                               {"asset_type": "credit_alphanum4", "asset_code": code, "asset_issuer": issuer}]}))
EOF
chmod +x "$BIN/stellar" "$BIN/curl"

read -r USDC_SAC TBENJI_SAC USDC_ASSET TBENJI_ASSET < <(python3 - "$SRC/deployments/testnet.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(d["contracts"]["usdc"], d["contracts"]["tbenji"], d["assets"]["usdc"], d["assets"]["tbenji"])
PY
)
G="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
export FAKE_STATE="$STATE" REAL_STELLAR FAKE_USDC="$USDC_ASSET" FAKE_G="$G"

# Chain before the redeploy: oracle and tSAFO match the build, the repo is v1.
ORACLE="CORACLEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
TSAFO="CTSAFOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
OLD="COLDREPOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
PREV="CPREVREPOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
cp "$WASM/caravel_oracle.wasm" "$STATE/c/$ORACLE.wasm"
cp "$WASM/caravel_spiko_mock.wasm" "$STATE/c/$TSAFO.wasm"
cp "$TMP/old_repo.wasm" "$STATE/c/$OLD.wasm"
OLD_AT="2026-10-01T00:00:00Z"
{
  for v in ADMIN ISSUER LIQUIDATOR BORROWER LENDER GUARDIAN; do echo "${v}_ADDRESS=$G"; done
  echo "ADMIN_SECRET=dummy"; echo "ISSUER_SECRET=dummy"
  echo "USDC_SAC=$USDC_SAC"; echo "TBENJI_SAC=$TBENJI_SAC"
  echo "USDC_ASSET=$USDC_ASSET"; echo "TBENJI_ASSET=$TBENJI_ASSET"
  echo "NETWORK=testnet"
  echo "ORACLE_ID=$ORACLE"; echo "TSAFO_ID=$TSAFO"; echo "REPO_ID=$OLD"; echo "DEPLOYED_AT=$OLD_AT"
} > "$ROOT/.env"
cp "$ROOT/.env" "$TMP/env.initial"
python3 - "$ROOT/deployments/testnet.json" "$PREV" <<'PY'
import json, sys
json.dump({"superseded": [sys.argv[2]]}, open(sys.argv[1], "w"))
PY

envval() { sed -n "s/^$1=//p" "$ROOT/.env"; }
deploy() { env -u CARAVEL_KEYS_FILE PATH="$BIN:$PATH" ENV_FILE="$ROOT/.env" PREBUILT_WASM_DIR="$WASM" SKIP_BINDINGS=1 "$ROOT/scripts/deploy.sh" "$@" 2>&1; }
json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$ROOT/deployments/testnet.json" "$1"; }

# --- plan on the normal path: no pending marker, no change in the output ----
out=$(deploy --plan); rc=$?
check "plan: a replaced repo is planned for wind-down" '[[ $rc == 0 && "$out" == *"scripts/winddown.sh $OLD "* ]]' "$out"
check "plan: no SUPERSEDED_PENDING in the files list" '[[ "$out" != *SUPERSEDED_PENDING* ]]' "$out"
check "plan: the USD repo is deployed with quote USD" '[[ "$out" == *'"'"'"quote":"USD"'"'"'* ]]' "$out"

# --- EUR market plan (LOAN_ASSET=EURC, DECISIONS #52): sends and writes nothing ---
cp "$ROOT/.env" "$TMP/env.eur-before"; cp "$ROOT/deployments/testnet.json" "$TMP/json.eur-before"
out=$(env -u CARAVEL_KEYS_FILE LOAN_ASSET=EURC PATH="$BIN:$PATH" ENV_FILE="$ROOT/.env" PREBUILT_WASM_DIR="$WASM" SKIP_BINDINGS=1 "$ROOT/scripts/deploy.sh" --plan 2>&1); rc=$?
check "EUR plan: a EUR oracle and a repo with quote EUR" \
  '[[ $rc == 0 && "$out" == *'"'"'--base {"Other":"EUR"}'"'"'* && "$out" == *'"'"'"quote":"EUR"'"'"'* ]]' "$out"
check "EUR plan: tSAFO reused and priced from Spiko in EUR, tBENJI not listed" \
  '[[ "$out" == *"lists the USD market'"'"'s tSAFO $TSAFO"* && "$out" == *"EUR NAV, no FX"* && "$out" != *"set_asset --asset $TBENJI_SAC"* ]]' "$out"
check "EUR plan: tEURC issuer, SAC, trustlines and mints to lender, liquidator and borrower" \
  '[[ "$out" == *"tEURC issuer key"* && "$out" == *"contract asset deploy --asset tEURC:"* && "$out" == *"borrower  tx new change-trust"* && $(grep -c "teurc-issuer contract invoke --id PLANNED_teurc_sac -- mint --to $G" <<<"$out") == 3 ]]' "$out"
check "EUR plan: never .env, testnet.json, .env.eur or testnet-eur.json" \
  'cmp -s "$ROOT/.env" "$TMP/env.eur-before" && cmp -s "$ROOT/deployments/testnet.json" "$TMP/json.eur-before" && [[ ! -e "$ROOT/.env.eur" && ! -e "$ROOT/deployments/testnet-eur.json" && "$out" == *"testnet-eur.json (never .env"* ]]' "$out"

# --- run 1: deploys the new repo, then dies on set_asset tSAFO ---------------
echo "$TSAFO" > "$STATE/fail_set_asset"
out=$(deploy); rc=$?
NEW=$(envval REPO_ID)
check "run 1 fails mid-run" '[[ $rc != 0 && "$out" == *TxBadSeq* ]]' "$out"
check "run 1 wrote the new REPO_ID" '[[ -n "$NEW" && "$NEW" != "$OLD" ]]'
check "run 1 left SUPERSEDED_PENDING=<old repo>" '[[ "$(envval SUPERSEDED_PENDING)" == "$OLD" ]]' "$(cat "$ROOT/.env")"
check "run 1 bumped DEPLOYED_AT before dying" '[[ "$(envval DEPLOYED_AT)" != "$OLD_AT" ]]'
check "run 1 did not wind down" '[[ ! -s "$STATE/winddown.log" ]]'
RUN1_AT=$(envval DEPLOYED_AT)

# --- plan between the runs: the pending repo is planned for wind-down --------
out=$(deploy --plan); rc=$?
check "plan after a failed run: winds down the pending repo" '[[ $rc == 0 && "$out" == *"scripts/winddown.sh $OLD "* ]]' "$out"

# --- run 2: reuses the new repo, records and winds down the old one ----------
out=$(deploy); rc=$?
check "run 2 succeeds" '[[ $rc == 0 ]]' "$out"
check "run 2 reuses the repo run 1 deployed" '[[ "$out" == *"repo unchanged, reusing $NEW"* && $(wc -l < "$STATE/deploys.log") == 1 ]]' "$out"
check "run 2 testnet.json: repo is the new one" '[[ "$(json "d[\"contracts\"][\"repo\"]")" == "$NEW" ]]'
check "run 2 testnet.json: superseded = [old, previous]" '[[ "$(json "\" \".join(d[\"superseded\"])")" == "$OLD $PREV" ]]' "$(json 'd["superseded"]')"
check "run 2 testnet.json: deployedAt is run 1's" '[[ "$(json "d[\"deployedAt\"]")" == "$RUN1_AT" ]]'
check "run 2 wound down the old repo" '[[ "$(cat "$STATE/winddown.log")" == "$OLD" ]]' "$(cat "$STATE/winddown.log" 2>/dev/null)"
check "run 2 cleared SUPERSEDED_PENDING" '! grep -q "^SUPERSEDED_PENDING=" "$ROOT/.env"'

# --- run 3: nothing changed, nothing sent, no file diff ---------------------
cp "$ROOT/.env" "$TMP/env.before"; cp "$ROOT/deployments/testnet.json" "$TMP/json.before"
out=$(deploy); rc=$?
check "run 3 no-op: no wind-down, .env and testnet.json unchanged" \
  '[[ $rc == 0 && $(wc -l < "$STATE/winddown.log") == 1 ]] && cmp -s "$ROOT/.env" "$TMP/env.before" && cmp -s "$ROOT/deployments/testnet.json" "$TMP/json.before"' "$out"

# --- a failed wind-down keeps the marker for the next run --------------------
printf '#!/usr/bin/env bash\nexit 1\n' > "$ROOT/scripts/winddown.sh"
echo "SUPERSEDED_PENDING=$OLD" >> "$ROOT/.env"
out=$(deploy); rc=$?
check "failed wind-down: WARN, marker kept" '[[ $rc == 0 && "$out" == *"winddown of $OLD failed"* && "$(envval SUPERSEDED_PENDING)" == "$OLD" ]]' "$out"

# --- two partial runs in a row: A->B dies, B->C dies, run 3 recovers ---------
# The marker then names two repos; .env must stay sourceable (every script,
# incl. the production nav-keeper, does `set -a; source .env`).
cat > "$ROOT/scripts/winddown.sh" <<EOF
#!/usr/bin/env bash
: > "$STATE/winddown.args"; for a in "\$@"; do echo "\$a" >> "$STATE/winddown.args"; done
EOF
cp "$TMP/env.initial" "$ROOT/.env"
python3 -c 'import json,sys; json.dump({"superseded": [sys.argv[2]]}, open(sys.argv[1], "w"))' "$ROOT/deployments/testnet.json" "$PREV"
A="$OLD"
echo "$TSAFO" > "$STATE/fail_set_asset"
out=$(deploy); rc=$?; B=$(envval REPO_ID)
check "double: run 1 (A->B) dies" '[[ $rc != 0 && -n "$B" && "$B" != "$A" ]]' "$out"
mkwasm "$WASM/caravel_repo.wasm" repo-v3
echo "$TSAFO" > "$STATE/fail_set_asset"
out=$(deploy); rc=$?; C=$(envval REPO_ID)
check "double: run 2 (B->C) dies" '[[ $rc != 0 && -n "$C" && "$C" != "$B" && "$C" != "$A" ]]' "$out"
check "double: marker is B,A (comma, no space)" '[[ "$(envval SUPERSEDED_PENDING)" == "$B,$A" ]]' "$(grep SUPERSEDED_PENDING "$ROOT/.env")"
srcerr=$(bash -c 'set -a; source "$1"' _ "$ROOT/.env" 2>&1 >/dev/null); rc=$?
check "double: .env still sources cleanly after run 2" '[[ $rc == 0 && -z "$srcerr" ]]' "$srcerr"
out=$(deploy); rc=$?
check "double: run 3 succeeds" '[[ $rc == 0 ]]' "$out"
check "double: superseded = [B, A, PREV]" '[[ "$(json "\" \".join(d[\"superseded\"])")" == "$B $A $PREV" ]]' "$(json 'd["superseded"]')"
check "double: winddown.sh got B and A as separate args" '[[ $(wc -l < "$STATE/winddown.args") == 2 && "$(paste -sd" " "$STATE/winddown.args")" == "$B $A" ]]' "$(cat "$STATE/winddown.args" 2>/dev/null)"
check "double: run 3 cleared the marker" '! grep -q "^SUPERSEDED_PENDING=" "$ROOT/.env"'

# --- EUR market real run (fake chain, DECISIONS #52): its own files only ------
cp "$TMP/env.initial" "$ROOT/.env"
printf '%s\n' LENDER_SECRET=dummy BORROWER_SECRET=dummy LIQUIDATOR_SECRET=dummy >> "$ROOT/.env"
cp "$ROOT/.env" "$TMP/env.eur-before"; cp "$ROOT/deployments/testnet.json" "$TMP/json.eur-before"
eur() { env -u CARAVEL_KEYS_FILE LOAN_ASSET=EURC PATH="$BIN:$PATH" ENV_FILE="$ROOT/.env" PREBUILT_WASM_DIR="$WASM" SKIP_BINDINGS=1 "$ROOT/scripts/deploy.sh" "$@" 2>&1; }
eurval() { sed -n "s/^$1=//p" "$ROOT/.env.eur"; }
ejson() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$ROOT/deployments/testnet-eur.json" "$1"; }
out=$(eur); rc=$?
EREPO=$(eurval REPO_ID); TEURC_SAC=$("$REAL_STELLAR" contract id asset --asset "tEURC:$G" --rpc-url https://soroban-testnet.stellar.org --network-passphrase "Test SDF Network ; September 2015" 2>/dev/null)
check "EUR run succeeds and never touches .env or testnet.json" \
  '[[ $rc == 0 ]] && cmp -s "$ROOT/.env" "$TMP/env.eur-before" && cmp -s "$ROOT/deployments/testnet.json" "$TMP/json.eur-before"' "$out"
check "EUR run: .env.eur is mode 600 and names the EUR market (tEURC as USDC_*, no tBENJI, tSAFO pinned)" \
  '[[ "$(stat -c %a "$ROOT/.env.eur")" == 600 && -n "$EREPO" && "$EREPO" != "$OLD" && "$(eurval USDC_ASSET)" == "tEURC:$G" && "$(eurval USDC_SAC)" == "$TEURC_SAC" && "$(grep -c "^TBENJI_SAC=$" "$ROOT/.env.eur")" == 1 && "$(eurval TSAFO_ID)" == "$TSAFO" && -n "$(eurval TEURC_ISSUER_SECRET)" ]]' "$(sed 's/SECRET=.*/SECRET=…/' "$ROOT/.env.eur")"
check "EUR run: repo config is quote EUR with usdc = tEURC SAC; only tSAFO listed" \
  '[[ "$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c[\"quote\"], c[\"usdc\"])" "$STATE/c/$EREPO.config")" == "EUR $TEURC_SAC" && "$(python3 -c "import json,sys; print(\" \".join(json.load(open(sys.argv[1]))))" "$STATE/c/$EREPO.assets.json")" == "$TSAFO" ]]'
EJ=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); c=d["contracts"]; print(c["repo"], c["usdc"], d["assets"]["usdc"], d["oracle"]["base"]["Other"], d["config"]["quote"], "tbenji" in c, "tbenjiAsset" in d)' "$ROOT/deployments/testnet-eur.json" 2>&1)
check "EUR run: testnet-eur.json keeps testnet.json's schema minus tBENJI, base EUR" \
  '[[ "$EJ" == "$EREPO $TEURC_SAC tEURC:$G EUR EUR False False" ]]' "$EJ"
check "EUR run: tEURC trustline and mint for lender, liquidator and borrower" \
  '[[ $(grep -c "adding the tEURC trustline" <<<"$out") == 3 && $(grep -c "tEURC issuer mints" <<<"$out") == 3 ]]' "$out"
cp "$ROOT/.env.eur" "$TMP/enveur.before"; cp "$ROOT/deployments/testnet-eur.json" "$TMP/jsoneur.before"
out=$(eur); rc=$?
check "EUR re-run reuses oracle and repo, no file diff" \
  '[[ $rc == 0 && "$out" == *"repo unchanged, reusing $EREPO"* && "$out" == *"oracle unchanged"* ]] && cmp -s "$ROOT/.env.eur" "$TMP/enveur.before" && cmp -s "$ROOT/deployments/testnet-eur.json" "$TMP/jsoneur.before" && cmp -s "$ROOT/.env" "$TMP/env.eur-before"' "$out"

echo "$PASS passed, $FAIL failed"
(( FAIL == 0 ))
