#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Pure-Bash Status-Line Script for Antigravity CLI (`agy`)
# Features:
# - Automatic Host (`MacMini` vs `Laptop`) & Connection (`Local` vs `SSH`) badge
# - Real-time Session Title resolution (`history.jsonl` /rename + SQLite DB)
# - Automatic tmux Window & Pane title synchronization on `/rename`
# - 15-segment fine-grain Unicode Context Bar (█▓▒░·)
# - VCS Branch + dirty indicator, Model badge, Artifacts, Subagents, Tasks, Sandbox
# - Responsive 3-tier layout (Wide >=120 cols, Medium 80..119 cols, Narrow <80 cols)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ─── ANSI Helpers (Standard 16-color palette) ────────────────────────────────
R="\033[0m"
B="\033[1m"
I="\033[3m"

FG_WHITE="\033[37m"
FG_GRAY="\033[90m"
FG_BRIGHT_RED="\033[91m"
FG_BRIGHT_GREEN="\033[92m"
FG_BRIGHT_YELLOW="\033[93m"
FG_BRIGHT_BLUE="\033[94m"
FG_BRIGHT_MAGENTA="\033[95m"
FG_BRIGHT_CYAN="\033[96m"
FG_BRIGHT_WHITE="\033[97m"

NUM_COLOR="${FG_BRIGHT_WHITE}${B}"

# ─── Parse JSON from stdin (Single jq pass) ──────────────────────────────────
{
  read -r STATE || true
  read -r USED_PCT || true
  read -r VCS_BRANCH || true
  read -r VCS_DIRTY || true
  read -r SANDBOX || true
  read -r ARTIFACTS || true
  read -r SUBAGENTS || true
  read -r BG_TASKS || true
  read -r MODEL || true
  read -r COLS || true
  read -r CONV_ID || true
  read -r CONV_TITLE || true
  read -r CWD || true
  read -r AGY_VER || true
  read -r TRANSCRIPT_PATH || true
  read -r IS_CLAUDE || true
} <<< "$(
  jq -r '
    (.agent_state // "idle"),
    (.context_window.used_percentage // 0),
    (.vcs.branch // ""),
    (.vcs.dirty // false),
    (.sandbox.enabled // false),
    (.artifact_count // 0),
    (if .subagents | type == "array" then (.subagents | length) else 0 end),
    (.task_count // 0),
    (.model.display_name // ""),
    (.terminal_width // 0),
    (.conversation_id // .session_id // ""),
    (.session_name // .title // .conversation_title // ""),
    (.workspace.current_dir // .cwd // ""),
    (.version // ""),
    (.transcript_path // ""),
    (if (.product // "") != "antigravity" and ((.conversation_id // "") == "") and (has("rate_limits") or has("cost") or ((.transcript_path // "") | contains("/.claude/"))) then "1" else "0" end)
  ' 2>/dev/null || printf "idle\n0\n\nfalse\nfalse\n0\n0\n0\n\n0\n\n\n\n\n\n0\n"
)"

if [ "${COLS:-0}" -le 0 ] 2>/dev/null; then
  if [ -n "${TMUX:-}" ] && [ "${AGY_TMUX_NO_SYNC:-0}" != "1" ]; then
    COLS=$(tmux display-message -p ${TMUX_PANE:+-t "$TMUX_PANE"} '#{pane_width}' 2>/dev/null || echo 80)
  else
    COLS="${COLUMNS:-80}"
  fi
fi
case "$COLS" in ''|*[!0-9]*) COLS=80 ;; esac

VER_BADGE=""
if [[ "${AGY_VER:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z._+-]*$ ]]; then
  VER_BADGE="${FG_BRIGHT_MAGENTA}v${AGY_VER}${R} "
fi

PCT_FMT=$(LC_NUMERIC=C printf "%.1f" "${USED_PCT:-0}" 2>/dev/null || echo "0.0")
PCT_INT=${USED_PCT%.*}; PCT_INT=${PCT_INT:-0}

# ─── State Indicator ─────────────────────────────────────────────────────────
case "$STATE" in
  idle)     S="${FG_BRIGHT_GREEN}${B}● READY${R}" ;;
  thinking) S="${FG_BRIGHT_YELLOW}${B}◆ THINKING${R}" ;;
  working)  S="${FG_BRIGHT_CYAN}${B}⚙ WORKING${R}" ;;
  tool_use) S="${FG_BRIGHT_MAGENTA}${B}🔧 TOOL${R}" ;;
  *)        S="${FG_WHITE}${B}⏳ $(echo "$STATE" | tr '[:lower:]' '[:upper:]')${R}" ;;
esac

# ─── VCS Branch ──────────────────────────────────────────────────────────────
V=""
if [ -n "$VCS_BRANCH" ]; then
  if [ "$VCS_DIRTY" = "true" ]; then
    V="${FG_GRAY} ╱ ${FG_BRIGHT_RED}${VCS_BRANCH}${FG_BRIGHT_YELLOW}*${R}"
  else
    V="${FG_GRAY} ╱ ${FG_BRIGHT_BLUE}${VCS_BRANCH}${R}"
  fi
fi

# ─── Model ───────────────────────────────────────────────────────────────────
M=""
if [ -n "$MODEL" ]; then
  M="${FG_GRAY} ╱ ${FG_BRIGHT_MAGENTA}${I}${MODEL}${R}"
fi

# ─── Sandbox Badge ───────────────────────────────────────────────────────────
if [ "$SANDBOX" = "true" ]; then
  SB="${FG_GRAY}sandbox ${FG_BRIGHT_GREEN}${B}ON${R}"
else
  SB="${FG_GRAY}sandbox off${R}"
fi

# ─── Context Bar (15 segments) ───────────────────────────────────────────────
BAR_LEN=15
FILLED=$((PCT_INT * BAR_LEN / 100))
REMAINDER=$(( (PCT_INT * BAR_LEN) % 100 ))

if [ "$PCT_INT" -ge 90 ]; then
  BAR_COLOR="$FG_BRIGHT_RED"
elif [ "$PCT_INT" -ge 60 ]; then
  BAR_COLOR="$FG_BRIGHT_YELLOW"
else
  BAR_COLOR="$FG_BRIGHT_WHITE"
fi

BAR=""
for ((i = 0; i < BAR_LEN; i++)); do
  if [ "$i" -lt "$FILLED" ]; then
    BAR="${BAR}█"
  elif [ "$i" -eq "$FILLED" ]; then
    if [ "$REMAINDER" -ge 75 ]; then
      BAR="${BAR}▓"
    elif [ "$REMAINDER" -ge 50 ]; then
      BAR="${BAR}▒"
    elif [ "$REMAINDER" -ge 25 ]; then
      BAR="${BAR}░"
    else
      BAR="${BAR}·"
    fi
  else
    BAR="${BAR}·"
  fi
done

CTX="${FG_GRAY}ctx ${BAR_COLOR}${BAR} ${NUM_COLOR}${PCT_FMT}%${R}"
ART_FMT="${FG_GRAY}artifacts ${NUM_COLOR}${ARTIFACTS}${R}"
SUB_FMT="${FG_GRAY}subagents ${NUM_COLOR}${SUBAGENTS}${R}"
BG_FMT="${FG_GRAY}tasks ${NUM_COLOR}${BG_TASKS}${R}"
DOT="${FG_GRAY} · ${R}"

# ─── Session Title & Conversation ID/Size ────────────────────────────────────
if [[ ! "${CONV_ID:-}" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
  CONV_ID=""
fi

file_bytes() {
  local f="$1"
  [ -f "$f" ] || { echo 0; return; }
  stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0
}

CONV_BADGE=""
if [ -n "${CONV_ID:-}" ]; then
  CLI_HOME="${AGY_CLI_DIR:-$HOME/.gemini/antigravity-cli}"
  DB_B=$(file_bytes "$CLI_HOME/conversations/${CONV_ID}.db")
  WAL_B=$(file_bytes "$CLI_HOME/conversations/${CONV_ID}.db-wal")
  TR_B=$(file_bytes "$CLI_HOME/brain/${CONV_ID}/.system_generated/logs/transcript_full.jsonl")
  if [ "$TR_B" -eq 0 ]; then
    TR_B=$(file_bytes "$CLI_HOME/brain/${CONV_ID}/.system_generated/logs/transcript.jsonl")
  fi
  TOT_B=$((DB_B + WAL_B + TR_B))
  if [ "$TOT_B" -eq 0 ] && [ -n "${TRANSCRIPT_PATH:-}" ]; then
    TOT_B=$(file_bytes "$TRANSCRIPT_PATH")
  fi
  SIZE_TXT=""
  if [ "$TOT_B" -ge 1073741824 ]; then
    SIZE_TXT=$(LC_NUMERIC=C awk -v b="$TOT_B" 'BEGIN { printf "%.2fGB", b/1073741824 }')
  elif [ "$TOT_B" -ge 1048576 ]; then
    SIZE_TXT=$(LC_NUMERIC=C awk -v b="$TOT_B" 'BEGIN { printf "%.1fMB", b/1048576 }')
  elif [ "$TOT_B" -ge 1024 ]; then
    SIZE_TXT="$(( (TOT_B + 512) / 1024 ))KB"
  elif [ "$TOT_B" -gt 0 ]; then
    SIZE_TXT="${TOT_B}B"
  fi
  if [ "$COLS" -ge 140 ]; then
    DISP_ID="$CONV_ID"
  else
    DISP_ID="${CONV_ID:0:8}"
  fi
  if [ -n "$SIZE_TXT" ]; then
    CONV_BADGE="${FG_GRAY} ╱ #${DISP_ID} (${SIZE_TXT})${R}"
  else
    CONV_BADGE="${FG_GRAY} ╱ #${DISP_ID}${R}"
  fi
fi

SES=""
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
  SES="${FG_GRAY} ╱ ${FG_BRIGHT_CYAN}${SESSION_TITLE}${R}"
  if [ -n "${TMUX:-}" ] && [ "${AGY_TMUX_NO_SYNC:-0}" != "1" ] && [ "${IS_CLAUDE:-0}" != "1" ]; then
    SHORT_TMUX_TITLE="$SESSION_TITLE"
    if [ "${#SHORT_TMUX_TITLE}" -gt 24 ]; then
      SHORT_TMUX_TITLE="${SHORT_TMUX_TITLE:0:23}…"
    fi
    if [ "$STATE" = "idle" ]; then TMUX_IND="○"; else TMUX_IND="●"; fi
    if [ -n "${TMUX_PANE:-}" ]; then
      tmux select-pane -t "$TMUX_PANE" -T "$TMUX_IND $SHORT_TMUX_TITLE" 2>/dev/null || true
      tmux rename-window -t "$TMUX_PANE" "$SHORT_TMUX_TITLE" 2>/dev/null || true
    fi
  fi
fi

# ─── Host & Connection Mode (Local vs SSH) ───────────────────────────────────
HW_MODEL=$(sysctl -n hw.model 2>/dev/null || true)
RAW_HOST=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "Host")
MACHINE="${AGY_HOST_LABEL:-}"
if [ -z "$MACHINE" ]; then
  case "$HW_MODEL:$RAW_HOST" in
    Macmini*:*|Mac14,3:*|Mac14,12:*|Mac16,10:*|Mac16,11:*|*[Mm]acmini*|*[Rr]yan-[Ll]ab*)
      MACHINE="MacMini"
      ;;
    MacBook*:*)
      MACHINE="Laptop"
      ;;
    *)
      if pmset -g batt 2>/dev/null | grep -q "InternalBattery"; then
        MACHINE="Laptop"
      else
        MACHINE="$RAW_HOST"
      fi
      ;;
  esac
fi

IS_SSH=0
if [ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ] || [ "${P9K_SSH:-}" = "1" ]; then
  IS_SSH=1
fi
CHECK_PID="$$"
if [ -n "${TMUX:-}" ]; then
  TMUX_CLIENT_PID=$(tmux display-message -p '#{client_pid}' 2>/dev/null || true)
  if [ -n "$TMUX_CLIENT_PID" ]; then
    CHECK_PID="$TMUX_CLIENT_PID"
    IS_SSH=0
  fi
fi
CUR_PID="$CHECK_PID"
while [ -n "$CUR_PID" ] && [ "$CUR_PID" -gt 1 ] 2>/dev/null; do
  PINFO=$(ps -o ppid=,comm= -p "$CUR_PID" 2>/dev/null || true)
  [ -z "$PINFO" ] && break
  case "$PINFO" in
    *sshd*)
      IS_SSH=1
      break
      ;;
  esac
  CUR_PID=$(echo "$PINFO" | awk '{print $1}')
done

if [ "$IS_SSH" -eq 1 ]; then
  HOST_BADGE="${FG_BRIGHT_YELLOW}${B}[${MACHINE}·SSH]${R} "
else
  HOST_BADGE="${FG_BRIGHT_GREEN}${B}[${MACHINE}·Local]${R} "
fi

# ─── Responsive Output ───────────────────────────────────────────────────────
LINE1="${HOST_BADGE}${VER_BADGE}${S}${SES}${CONV_BADGE}${M}${V}"
LINE2=" ${CTX}${DOT}${ART_FMT}${DOT}${SUB_FMT}${DOT}${BG_FMT}${DOT}${SB}"

if [ "$COLS" -ge 120 ]; then
  echo -e "${LINE1}${FG_GRAY}  │  ${R}${LINE2}"
elif [ "$COLS" -ge 80 ]; then
  echo -e "${FG_GRAY}╭─${R} ${LINE1}"
  echo -e "${FG_GRAY}╰─${R}${LINE2}"
else
  echo -e "${HOST_BADGE}${S}${M}"
  echo -e "${CTX}${DOT}${BG_FMT}"
fi
