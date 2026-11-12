#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
# Single-Pass tmux Fleet Status & Pane/Window Option Synchronizer
# Tracks running vs. latest versions and true process uptimes for both `agy`
# and Claude Code (`claude` / `X.Y.Z`) across all tmux sessions.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME:-}/.local/bin:/usr/sbin:/sbin:${PATH:-/usr/bin:/bin}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

exec node "$ROOT_DIR/dist/agy-hud.js" tmux-status "$@"
