#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
# Antigravity CLI Status-Line Hook Entrypoint (Node.js HUD)
# Reads status-line JSON payload from stdin and renders the HUD via dist/agy-hud.js.
# Set AGY_HUD_DEBUG=1 to save the last payload to debug/last_payload.json.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME:-}/.local/bin:/usr/sbin:/sbin:${PATH:-/usr/bin:/bin}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

INPUT=$(cat)
if [ "${AGY_HUD_DEBUG:-0}" = "1" ]; then
  mkdir -p "$ROOT_DIR/debug"
  printf "%s\n" "$INPUT" > "$ROOT_DIR/debug/last_payload.json"
fi

printf "%s\n" "$INPUT" | exec node "$ROOT_DIR/dist/agy-hud.js" statusline
