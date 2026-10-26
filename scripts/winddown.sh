#!/usr/bin/env bash
# Wind down superseded Caravel repo contracts (Raven UA-05, testnet only).
#
#   scripts/winddown.sh --dry-run              # every id in deployments/testnet.json "superseded"
#   scripts/winddown.sh --dry-run C... C...    # these ids
#   scripts/winddown.sh C...                   # send the txs
#
# Contracts are immutable: a fix ships as a new repo contract, and the old one
# keeps its escrowed offers and live repos. Per contract this:
#   1. switches on no_new_repos for every listed asset (admin set_pause, else
#      guardian_set_pause, else admin set_asset enabled=false on an old ABI),
#      so nobody can take a stale offer or post a new one;
#   2. cancel_offer for every open offer whose lender key is in .env (the demo
#      lender and the other burner wallets), returning the escrowed USDC;
#   3. lists offers held by other lenders (they must cancel themselves) and
#      repos still live (Open / MarginCall / Defaulted): they settle on their
#      own terms; repay, top-up, default and liquidate keep working.
# --dry-run simulates every tx with --send=no (no signature, nothing sent) and
# reports whether it would succeed. Refuses the current deployments/testnet.json
# repo and any network but testnet. Keys come from ENV_FILE (default .env) and
# are passed to the CLI only, never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
case "${1:-}" in -h|--help) sed -n '2,21p' "$0"; exit 0 ;; esac
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
export STELLAR_NETWORK="${NETWORK:-testnet}"
[[ -n "${RPC_URL:-}" ]] && export STELLAR_RPC_URL="$RPC_URL"
[[ "$STELLAR_NETWORK" == testnet ]] || { echo "winddown.sh is testnet-only (NETWORK=$STELLAR_NETWORK)" >&2; exit 2; }
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
export CARAVEL_DEPLOYMENTS="$ROOT/deployments/testnet.json"

exec python3 - "$@" <<'PY'
import csv, io, json, os, subprocess, sys

args = sys.argv[1:]
dry = "--dry-run" in args
ids = [a for a in args if a != "--dry-run"]
bad = [a for a in ids if a.startswith("-")]
if bad:
    sys.exit(f"unknown option {bad[0]}")

dep = json.load(open(os.environ["CARAVEL_DEPLOYMENTS"]))
current = dep.get("contracts", {}).get("repo")
if not ids:
    ids = dep.get("superseded", [])
    if not ids:
        sys.exit("no ids given and deployments/testnet.json has no \"superseded\" list")
if current in ids:
    sys.exit(f"refusing to wind down the live repo {current} (deployments/testnet.json)")

USDC_UNIT = 10**7
LIVE = {"Open", "MarginCall", "Defaulted"}
# address -> name of the env var holding its secret (never the secret itself)
KEYS = {}
for role in ("ADMIN", "GUARDIAN", "LENDER", "BORROWER", "LIQUIDATOR", "ISSUER", "KEEPER"):
    a, s = os.environ.get(f"{role}_ADDRESS"), os.environ.get(f"{role}_SECRET")
    if a and s:
        KEYS.setdefault(a, f"{role}_SECRET")
ROLE = {a: v[:-len("_SECRET")].lower() for a, v in KEYS.items()}


def short(a): return f"{a[:8]}…"
def usdc(x): return f"{int(x) / USDC_UNIT:,.2f}"


def cli(*a, timeout=90):
    p = subprocess.run(["stellar", *a], capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def view(cid, fn, *fa):
    src = os.environ["ADMIN_ADDRESS"]
    rc, out, _ = cli("contract", "invoke", "-q", "--id", cid, "--source-account", src, "--send=no", "--", fn, *fa)
    if rc != 0 or not out:
        return None
    try:
        return json.loads(out.splitlines()[-1])
    except json.JSONDecodeError:
        return out


def send(cid, who, fn, *fa):
    """Simulate (dry run, source = public address) or sign and send (source = secret)."""
    if dry:
        rc, _, err = cli("contract", "invoke", "-q", "--id", cid, "--source-account", who, "--send=no", "--", fn, *fa)
    else:
        rc, _, err = cli("contract", "invoke", "-q", "--id", cid, "--source-account", os.environ[KEYS[who]], "--", fn, *fa)
    if rc == 0:
        return "would succeed" if dry else "sent"
    last = (err.splitlines() or ["failed"])[-1]
    for line in err.splitlines():
        if "Error(" in line:
            last = line.strip()
            break
    return f"{'would fail' if dry else 'FAILED'}: {last[:140]}"


def scval(v):
    """Minimal ScVal-JSON → python (what the instance storage dump contains)."""
    if not isinstance(v, dict) or len(v) != 1:
        return v
    (t, x), = v.items()
    if t == "map":
        return {scval(e["key"]): scval(e["val"]) for e in x}
    if t == "vec":
        return [scval(e) for e in x]
    if t in ("u32", "i32", "u64", "i64", "u128", "i128"):
        return int(x)
    return x


def freeze(k):
    """Hashable storage key: DataKey vecs become tuples, nested ones too."""
    if isinstance(k, list):
        return tuple(freeze(x) for x in k)
    if isinstance(k, dict):
        return tuple(sorted((freeze(a), freeze(b)) for a, b in k.items()))
    return k


def instance(cid):
    rc, out, err = cli("contract", "read", "--id", cid, "--durability", "persistent",
                       "--key-xdr", "AAAAFA==", "--output", "json")
    if rc != 0:
        return None
    for row in csv.reader(io.StringIO(out)):
        if len(row) >= 2 and "contract_instance" in row[1]:
            inst = json.loads(row[1])["contract_instance"]
            store = {}
            for e in inst.get("storage") or []:
                store[freeze(scval(e["key"]))] = scval(e["val"])
            return store
    return None


def functions(cid):
    rc, out, _ = cli("contract", "info", "interface", "--id", cid, "--output", "json-formatted")
    if rc != 0:
        return set()
    return {e["function_v0"]["name"] for e in json.loads(out) if "function_v0" in e}


totals = {"offers": 0, "usdc": 0, "ours": 0, "ours_usdc": 0, "theirs": 0, "theirs_usdc": 0, "live": 0}
print(f"winddown {'DRY RUN (simulated, nothing sent)' if dry else 'LIVE (sending txs)'}; live repo {short(current or '?')} untouched")
for cid in ids:
    print(f"== {cid}")
    store = instance(cid)
    if store is None:
        print("   unreachable (archived or not a contract): skipped")
        continue
    fns = functions(cid)
    cfg = store.get(("Config",), {})
    admin, guardian = cfg.get("admin"), cfg.get("guardian")
    next_offer = store.get(("NextOfferId",), 1)
    next_repo = store.get(("NextRepoId",), 1)
    assets = [k[1] for k in store if isinstance(k, tuple) and k[0] == "Asset"]
    print(f"   admin {short(admin or '?')}{' (key in .env)' if admin in KEYS else ''}, "
          f"guardian {short(guardian) if guardian else 'none'}{' (key in .env)' if guardian in KEYS else ''}, "
          f"{len(assets)} asset(s), offer ids < {next_offer}, repo ids < {next_repo}")

    # 1. stop new offers and takes
    for a in assets:
        pause = store.get(("Pause", a)) or {}
        cfg_a = store.get(("Asset", a)) or {}
        if pause.get("no_new_repos") or cfg_a.get("enabled") is False:
            print(f"   pause {short(a)}: already off for new repos")
            continue
        want = json.dumps({"no_new_repos": True, "no_seize": bool(pause.get("no_seize", False))})
        if "set_pause" in fns and admin in KEYS:
            r = send(cid, admin, "set_pause", "--asset", a, "--pause", want)
            how = "admin set_pause"
        elif "guardian_set_pause" in fns and guardian in KEYS:
            r = send(cid, guardian, "guardian_set_pause", "--asset", a, "--pause", want)
            how = "guardian_set_pause"
        elif admin in KEYS and "set_asset" in fns:
            cur = view(cid, "asset", "--asset", a)
            if not isinstance(cur, dict):
                print(f"   pause {short(a)}: cannot read asset config: skipped")
                continue
            cur["enabled"] = False
            r = send(cid, admin, "set_asset", "--asset", a, "--config", json.dumps(cur))
            how = "admin set_asset enabled=false"
        else:
            print(f"   pause {short(a)}: no admin/guardian key in .env: skipped")
            continue
        print(f"   pause {short(a)} no_new_repos via {how}: {r}")

    # 2./3. offers
    for i in range(1, int(next_offer)):
        o = view(cid, "offer", "--offer_id", str(i))
        if not isinstance(o, dict) or "principal" not in o:
            continue
        p, lender = int(o["principal"]), o["lender"]
        totals["offers"] += 1; totals["usdc"] += p
        if lender in KEYS:
            r = send(cid, lender, "cancel_offer", "--offer_id", str(i))
            totals["ours"] += 1; totals["ours_usdc"] += p
            print(f"   offer {i}: {usdc(p)} USDC, lender {short(lender)} ({ROLE[lender]} key): cancel_offer {r}")
        else:
            totals["theirs"] += 1; totals["theirs_usdc"] += p
            print(f"   offer {i}: {usdc(p)} USDC, lender {short(lender)}: not our key, the lender must cancel_offer {i} on {short(cid)}")

    # 3. live repos
    for i in range(1, int(next_repo)):
        r = view(cid, "repo", "--repo_id", str(i))
        if isinstance(r, dict) and r.get("status") in LIVE:
            totals["live"] += 1
            print(f"   repo {i}: {r['status']}, principal {usdc(r['principal'])} USDC, maturity {r['maturity_ts']}, "
                  f"borrower {short(r['borrower'])}, lender {short(r['lender'])}: settles on its own terms")

print(f"total: {totals['offers']} open offers / {usdc(totals['usdc'])} USDC; "
      f"ours (cancel_offer): {totals['ours']} / {usdc(totals['ours_usdc'])} USDC; "
      f"other lenders: {totals['theirs']} / {usdc(totals['theirs_usdc'])} USDC; live repos: {totals['live']}")
PY
