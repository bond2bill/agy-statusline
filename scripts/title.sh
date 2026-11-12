#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Zero-Jitter Terminal Tab & Window Title Script for Antigravity CLI (`agy`)
# - Sets Tab Title (OSC 1), Window Title (OSC 2), and iTerm2 User Variables (OSC 1337)
# - Synchronizes tmux Pane Title (`select-pane -T`) and Window Name (`rename-window`)
# - Supports iTerm2, macOS Terminal.app, and tmux (even with `allow-rename off`)
# - Uses binary active/idle dot (● / ○) or emoji (🏃 / 😴 via AGY_TITLE_STYLE=emoji)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DATA=$(cat)

{
  read -r STATE || true
  read -r CWD || true
  read -r CONV_ID || true
  read -r CONV_TITLE || true
  read -r AGY_VER || true
} <<< "$(
  printf "%s\n" "$DATA" | jq -r '
    (.agent_state // "idle"),
    (.workspace.current_dir // .cwd // ""),
    (.conversation_id // .session_id // ""),
    (.session_name // .title // .conversation_title // ""),
    (.version // "")
  ' 2>/dev/null || printf "idle\n\n\n\n"
)"

if [[ ! "${CONV_ID:-}" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
  CONV_ID=""
fi
if [[ ! "${AGY_VER:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z._+-]*$ ]]; then
  AGY_VER=""
fi

if [ -n "$CWD" ]; then
  if [[ "$CWD" =~ /google/src/cloud/[^/]+/([^/]+) ]]; then
    WORKSPACE="${BASH_REMATCH[1]}"
  else
    WORKSPACE=$(basename "$CWD")
  fi
else
  WORKSPACE="unknown"
fi

STYLE="${AGY_TITLE_STYLE:-dot}"
case "$STATE" in
  idle)
    if [ "$STYLE" = "emoji" ]; then IND="😴"; else IND="○"; fi
    ;;
  *)
    if [ "$STYLE" = "emoji" ]; then IND="🏃"; else IND="●"; fi
    ;;
esac

SESSION_TITLE=""
HIST_FILE="${AGY_HISTORY_FILE:-$HOME/.gemini/antigravity-cli/history.jsonl}"
if [ -n "${CONV_ID:-}" ]; then
  if [ -f "$HIST_FILE" ]; then
    LATEST_RENAME=$(grep -F "\"conversationId\":\"$CONV_ID\"" "$HIST_FILE" 2>/dev/null | grep -F '"/rename ' | tail -n 1 | jq -r '.display[8:] // empty' 2>/dev/null || true)
    if [ -n "$LATEST_RENAME" ]; then
      SESSION_TITLE="$LATEST_RENAME"
    fi
  fi
elif [ -n "${CWD:-}" ] && [ -f "$HIST_FILE" ]; then
  LATEST_RENAME=$(tail -n 25 "$HIST_FILE" 2>/dev/null | grep -F "\"workspace\":\"$CWD\"" | grep -v '"conversationId"' | grep -F '"/rename ' | tail -n 1 | jq -r '.display[8:] // empty' 2>/dev/null || true)
  if [ -n "$LATEST_RENAME" ]; then
    SESSION_TITLE="$LATEST_RENAME"
  fi
fi

if [ -z "$SESSION_TITLE" ] && [ -n "${CONV_TITLE:-}" ]; then
  SESSION_TITLE="$CONV_TITLE"
fi

if [ -z "$SESSION_TITLE" ] && [ -n "${CONV_ID:-}" ]; then
  DB_PATH="${AGY_SUMMARIES_DB:-$HOME/.gemini/antigravity-cli/conversation_summaries.db}"
  if [ -f "$DB_PATH" ]; then
    SAFE_ID="${CONV_ID//\'/}"
    SESSION_TITLE=$(sqlite3 "$DB_PATH" "SELECT title FROM conversation_summaries WHERE conversation_id='${SAFE_ID}';" 2>/dev/null || true)
  fi
fi

if [ -n "$SESSION_TITLE" ]; then
  SESSION_TITLE=$(echo "$SESSION_TITLE" | sed -E "s/^[#*\`\"'[:space:]]+//; s/[#*\`\"'[:space:]]+$//")
  if [ "${#SESSION_TITLE}" -gt 24 ]; then
    SESSION_TITLE="${SESSION_TITLE:0:23}…"
  fi
fi

if [ -n "$SESSION_TITLE" ]; then
  TAB_TITLE="$IND $SESSION_TITLE"
  WIN_TITLE="$IND $SESSION_TITLE | $WORKSPACE | $STATE"
  VAR_TITLE="$SESSION_TITLE"
else
  TAB_TITLE="$IND $WORKSPACE"
  WIN_TITLE="$IND $WORKSPACE | $STATE"
  VAR_TITLE="$WORKSPACE"
fi

# Synchronize tmux pane title and window name directly via tmux CLI
if [ "${AGY_TITLE_NO_TTY:-0}" != "1" ] && [ -n "${TMUX:-}" ]; then
  TARGET_PANE="${TMUX_PANE:-}"
  if [ -z "$TARGET_PANE" ]; then
    CUR_PID="$$"
    PANE_MAP=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null || true)
    while [ -n "$CUR_PID" ] && [ "$CUR_PID" -gt 1 ] 2>/dev/null; do
      MATCH_PANE=$(echo "$PANE_MAP" | awk -v p="$CUR_PID" '$1 == p {print $2; exit}')
      if [ -n "$MATCH_PANE" ]; then
        TARGET_PANE="$MATCH_PANE"
        break
      fi
      CUR_PID=$(ps -o ppid= -p "$CUR_PID" 2>/dev/null | tr -d ' ' || true)
    done
  fi
  if [ -n "$TARGET_PANE" ]; then
    tmux select-pane -t "$TARGET_PANE" -T "$TAB_TITLE" 2>/dev/null || true
    if [ -n "$SESSION_TITLE" ]; then
      tmux rename-window -t "$TARGET_PANE" "$VAR_TITLE" 2>/dev/null || true
    fi
    if [ -n "${AGY_VER:-}" ]; then
      tmux set-option -p -t "$TARGET_PANE" @agent_ver "$AGY_VER" 2>/dev/null || true
    fi
  else
    tmux select-pane -T "$TAB_TITLE" 2>/dev/null || true
    if [ -n "$SESSION_TITLE" ]; then
      tmux rename-window "$VAR_TITLE" 2>/dev/null || true
    fi
    if [ -n "${AGY_VER:-}" ]; then
      tmux set-option -p @agent_ver "$AGY_VER" 2>/dev/null || true
    fi
  fi
fi

if [ "${AGY_TITLE_NO_TTY:-0}" != "1" ] && [ -c /dev/tty ] 2>/dev/null; then
  printf "\033]1;%s\007\033]2;%s\007" "$TAB_TITLE" "$WIN_TITLE" > /dev/tty 2>/dev/null || true

  B64_VAR=$(printf "%s" "$VAR_TITLE" | base64 | tr -d '\n')
  printf "\033]1337;SetUserVar=session_name=%s\007" "$B64_VAR" > /dev/tty 2>/dev/null || true
  printf "\033]1337;SetUserVar=session_title=%s\007" "$B64_VAR" > /dev/tty 2>/dev/null || true

  if [ -n "${TMUX:-}" ]; then
    printf "\033k%s\033\\" "$TAB_TITLE" > /dev/tty 2>/dev/null || true
    printf "\033Ptmux;\033\033]1;%s\007\033\\" "$TAB_TITLE" > /dev/tty 2>/dev/null || true
    printf "\033Ptmux;\033\033]2;%s\007\033\\" "$WIN_TITLE" > /dev/tty 2>/dev/null || true
  fi
fi

# When running inside tmux, output concise TAB_TITLE so agy's SetWindowTitle (OSC 2)
# sets a clean #{pane_title} on the tmux pane instead of appending "| workspace | state".
if [ "${AGY_TITLE_NO_TTY:-0}" != "1" ] && [ -n "${TMUX:-}" ]; then
  echo "$TAB_TITLE"
else
  echo "$WIN_TITLE"
fi
