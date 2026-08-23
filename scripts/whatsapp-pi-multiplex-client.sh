#!/usr/bin/env bash
set -Eeuo pipefail

: "${WHATSAPP_PI_CLIENT_ID:?missing WHATSAPP_PI_CLIENT_ID}"
: "${WHATSAPP_PI_CREDENTIAL_FILE:?missing WHATSAPP_PI_CREDENTIAL_FILE}"
: "${PI_ENTRYPOINT:?missing PI_ENTRYPOINT}"
PI_COMMAND="${PI_COMMAND:-pi}"
SESSION_NAME="whatsapp-pi-${WHATSAPP_PI_CLIENT_ID}"
WORKING_DIRECTORY="${WHATSAPP_PI_WORKING_DIRECTORY:-$HOME}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    while tmux has-session -t "$SESSION_NAME" 2>/dev/null; do sleep 2; done
    exit 1
fi
cleanup() { tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true; }
trap cleanup TERM INT

tmux new-session -d -s "$SESSION_NAME" -c "$WORKING_DIRECTORY" -- \
    bash -lc 'exec "$1" -e "$2" --whatsapp-multiplex-client="$3"' bash \
    "$PI_COMMAND" "$PI_ENTRYPOINT" "$WHATSAPP_PI_CLIENT_ID"
while tmux has-session -t "$SESSION_NAME" 2>/dev/null; do sleep 2; done
exit 1
