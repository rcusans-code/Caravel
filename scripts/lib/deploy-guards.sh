# shellcheck shell=bash
# Guards and provenance helpers for scripts/deploy.sh (Raven audit R4).
# Sourced, not run. The caller defines log, die, view and as_issuer;
# scripts/test/deploy-guards.test.sh stubs them to test each guard offline.

GUARDS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARAVEL_SOURCE_REPO="${CARAVEL_SOURCE_REPO:-github:rcusans-code/Caravel}"

# AS-05: the classic asset string and the SAC id must name the same token.
# A mismatched pair lets the app check trustlines on one asset while the
# contract moves another; the SAC id is derived from code:issuer and the
# network passphrase, so no RPC is needed.
check_sac() { # check_sac LABEL ASSET SAC
  local label="$1" asset="$2" sac="$3" derived
  [[ -n "$asset" ]] || die "$label: ${label}_ASSET is empty (want CODE:ISSUER)"
  [[ "$asset" =~ ^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$ ]] || die "$label: ${label}_ASSET '$asset' is not CODE:ISSUER"
  # Derivation is local; --rpc-url only satisfies the CLI when a passphrase is set.
  derived=$(stellar contract id asset --asset "$asset" \
              --rpc-url "${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}" 2>/dev/null) \
    || die "$label: cannot derive the SAC id of $asset (stellar CLI / network passphrase?)"
  [[ "$derived" == "$sac" ]] \
    || die "$label: ${label}_SAC $sac does not match ${label}_ASSET $asset (its SAC is $derived)"
  log "$label SAC matches $asset"
}

# AS-06: issuer authorization on an AUTH_REQUIRED token. For a holder the
# protocol cannot work without (the repo contract) a failed set_authorized,
# or an `authorized` that still reads false, stops the deploy: otherwise it
# reports done and every take fails with the SAC's #11. G-accounts keep the
# WARN path (a wallet without a trustline yet).
authorize_holder() { # authorize_holder LABEL TOKEN WHO REQUIRED(0|1)
  local label="$1" token="$2" who="$3" required="$4"
  if [[ "$(view --id "$token" -- authorized --id "$who" 2>/dev/null || echo false)" == true ]]; then
    log "$label authorized: $who"
    return 0
  fi
  log "issuer set_authorized($who) on $label"
  if ! as_issuer --id "$token" -- set_authorized --id "$who" --authorize true >/dev/null; then
    (( required )) && die "set_authorized($who) on $label failed; the repo contract cannot hold $label"
    log "WARN: set_authorized failed for $who (G-account without a $label trustline?)"
    return 0
  fi
  if (( required )) && [[ "$(view --id "$token" -- authorized --id "$who" 2>/dev/null || echo false)" != true ]]; then
    die "$label authorized($who) still false after set_authorized; takes would fail with #11"
  fi
  return 0
}

# STD-05: SEP-46 meta so explorers and `stellar contract info build` can link
# the on-chain wasm to this repo. A contract tree with uncommitted changes is
# marked "-dirty": the sha alone would claim code it does not contain.
build_meta_args() { # sets BUILD_META=(--meta … --meta …)
  local root="$1" sha
  BUILD_META=(--meta "source_repo=$CARAVEL_SOURCE_REPO")
  if sha=$(git -C "$root" rev-parse HEAD 2>/dev/null); then
    if [[ -n "$(git -C "$root" status --porcelain -- contracts Cargo.toml Cargo.lock 2>/dev/null)" ]]; then
      sha="$sha-dirty"
    fi
    BUILD_META+=(--meta "commit_sha=$sha")
  else
    log "WARN: not a git checkout; contract meta gets source_repo only"
  fi
}

# Hash of the wasm without its contractmetav0 section: the commit_sha meta
# changes on every commit, the code does not (scripts/wasm-code-hash.py).
code_hash() { # code_hash FILE
  python3 "$GUARDS_DIR/../wasm-code-hash.py" "$1" | cut -d' ' -f1
}
