# shellcheck shell=bash
# Privileged keys out of git (Raven R10: AS-01, UA-04, UA-06 multisig half).
# Sourced, not run, by deploy.sh, onboard.sh, winddown.sh and buy-usdc.sh,
# right after they source their ENV_FILE. scripts/test/keys.test.sh tests it.
#
# The admin, guardian, issuer and oracle feeder keys (ADMIN_*, GUARDIAN_*,
# ISSUER_*, FEEDER_*: *_ADDRESS and *_SECRET) are read from an untracked file,
# CARAVEL_KEYS_FILE (default ~/.local/lib/caravel/.env, the keepers' copy),
# when it exists. A role found there takes both its lines from there; a role
# it lacks falls back to the tracked .env, which holds testnet burner keys
# only. Mainnet never reads keys from a tracked file (scripts/lib/mainnet-plan.sh).
#
# Testnet behaviour is unchanged for teammates: without the untracked file
# every key comes from the tracked .env as before. An explicit ENV_FILE (a
# throwaway deployment) is used as-is unless CARAVEL_KEYS_FILE is set too, so
# a dry run on throwaway keys never picks up the live keys.

CARAVEL_KEY_ROLES=(ADMIN GUARDIAN ISSUER FEEDER)

# git_tracked FILE: 0 when FILE is tracked by the git repository it sits in.
git_tracked() {
  local f="$1" dir
  dir="$(cd "$(dirname "$f")" 2>/dev/null && pwd)" || return 1
  git -C "$dir" ls-files --error-unmatch -- "$(basename "$f")" >/dev/null 2>&1
}

# caravel_keys_file NETWORK: the untracked keys file for NETWORK.
caravel_keys_file() {
  if [[ -n "${CARAVEL_KEYS_FILE:-}" ]]; then
    printf '%s\n' "$CARAVEL_KEYS_FILE"
  elif [[ "$1" == mainnet ]]; then
    printf '%s\n' "$HOME/.local/lib/caravel/mainnet.env"
  else
    printf '%s\n' "$HOME/.local/lib/caravel/.env"
  fi
}

# read_env_lines FILE REGEX: export every KEY=VALUE line of FILE whose key
# matches REGEX, without sourcing the file (values never reach stdout).
read_env_lines() {
  local f="$1" re="$2" line k v
  while IFS= read -r line; do
    k="${line%%=*}" v="${line#*=}"
    [[ "$k" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    if [[ "$v" == \"*\" || "$v" == \'*\' ]]; then v="${v:1:${#v}-2}"; fi
    printf -v "$k" '%s' "$v"
    export "${k?}"
  done < <(grep -E "^(${re})=" "$f" || true)
}

# load_private_keys ENV_FILE ENV_FILE_IS_DEFAULT(0|1)
# Sets KEYS_SOURCE (one line for the log; names only, never values) and
# KEYS_FILE_ROLES (roles read from the untracked file). Returns 1 (caller
# dies) when the keys file is tracked in git.
load_private_keys() {
  local env_file="$1" default_env="$2" f role
  KEYS_FILE_ROLES=()
  KEYS_SOURCE="keys: tracked $env_file (testnet burner keys)"
  f="$(caravel_keys_file testnet)"
  [[ "$default_env" == 1 || -n "${CARAVEL_KEYS_FILE:-}" ]] || return 0
  [[ -f "$f" ]] || return 0
  # The keeper units point ENV_FILE at the keys file itself.
  [[ "$(realpath "$f")" == "$(realpath "$env_file")" ]] && return 0
  if git_tracked "$f"; then
    KEYS_SOURCE="keys file $f is tracked in git; refusing to read keys from it"
    return 1
  fi
  for role in "${CARAVEL_KEY_ROLES[@]}"; do
    grep -qE "^${role}_(ADDRESS|SECRET)=" "$f" || continue
    unset "${role}_ADDRESS" "${role}_SECRET"
    read_env_lines "$f" "${role}_(ADDRESS|SECRET)"
    KEYS_FILE_ROLES+=("$role")
  done
  if (( ${#KEYS_FILE_ROLES[@]} )); then
    KEYS_SOURCE="keys: ${KEYS_FILE_ROLES[*]} from $f (untracked); the rest from $env_file"
  fi
  return 0
}

# key_in_keys_file VAR: 0 when VAR's role was read from the untracked file.
key_in_keys_file() {
  local role="${1%_*}" r
  for r in "${KEYS_FILE_ROLES[@]}"; do [[ "$r" == "$role" ]] && return 0; done
  return 1
}
