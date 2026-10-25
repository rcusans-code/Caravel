#!/usr/bin/env bash
# Caravel alert hook: one message to the journal and, when configured, to
# Telegram. Called by the keeper and nav-keeper as ALERT_CMD (stuck payouts,
# NAV pushes failing) and by caravel-alert@.service when a keeper unit fails
# (OnFailure=).
#
#   caravel-alert.sh "<message>"
#
# Telegram: put TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in ALERT_ENV
# (default ~/.config/caravel/alert.env, chmod 600, never in the repo). Without
# them the message only goes to the journal (tag caravel-alert).
set -uo pipefail

msg="${*:-caravel alert (no message)}"
ALERT_ENV="${ALERT_ENV:-$HOME/.config/caravel/alert.env}"
# shellcheck disable=SC1090
[[ -f "$ALERT_ENV" ]] && { set -a; source "$ALERT_ENV"; set +a; }

logger -t caravel-alert -- "$msg" 2>/dev/null || true
printf 'caravel-alert: %s\n' "$msg" >&2

[[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]] || exit 0
# Token in the URL, so pass it through a curl config on stdin (never argv / ps).
if ! printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TELEGRAM_BOT_TOKEN" |
     curl -fsS --max-time 15 -K - -o /dev/null \
       --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
       --data-urlencode "text=$(hostname -s): $msg"; then
  printf 'caravel-alert: Telegram send failed\n' >&2
  exit 1
fi
