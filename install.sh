#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-Command Installer for agy-statusline (Antigravity CLI HUD & tmux Suite)
# Consolidates `statusLine`, `title`, and `tmux` fleet monitor under a single
# plugin root (`~/.gemini/config/plugins/agy-hud`), symlinked to the git repo
# by default so upgrades and branch switches stay 100% synchronized.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGY_CLI_DIR="${AGY_CLI_DIR:-$HOME/.gemini/antigravity-cli}"
DEFAULT_PLUGIN_DIR="$HOME/.gemini/config/plugins/agy-hud"
PLUGIN_DIR="${AGY_PLUGIN_DIR:-$DEFAULT_PLUGIN_DIR}"
TMUX_CONF="${AGY_TMUX_CONF:-$HOME/.tmux.conf}"
MODE="hud" # "hud" (Node.js HUD default) or "bash" (pure-Bash statusline.sh)
INSTALL_STYLE="auto" # "auto" -> symlink if .git exists, else copy; overridable via --link / --copy

for arg in "$@"; do
  case "$arg" in
    --bash) MODE="bash" ;;
    --hud)  MODE="hud" ;;
    --link) INSTALL_STYLE="link" ;;
    --copy) INSTALL_STYLE="copy" ;;
    --help|-h)
      echo "Usage: ./install.sh [--hud | --bash] [--link | --copy]"
      echo "  --hud   (Default) Use Node.js HUD plugin + unified plugin title.sh"
      echo "  --bash  Use pure-Bash statusline.sh + unified plugin title.sh"
      echo "  --link  Symlink plugin directory directly to this repository (default for git clones)"
      echo "  --copy  Copy standalone files into plugin directory"
      exit 0
      ;;
  esac
done

if [ "$INSTALL_STYLE" = "auto" ]; then
  if [ -d "$REPO_DIR/.git" ] && [ "$PLUGIN_DIR" = "$DEFAULT_PLUGIN_DIR" ]; then
    INSTALL_STYLE="link"
  else
    INSTALL_STYLE="copy"
  fi
fi

chmod +x "$REPO_DIR/hooks/status-line.sh" \
         "$REPO_DIR/scripts/statusline.sh" \
         "$REPO_DIR/scripts/title.sh" \
         "$REPO_DIR/scripts/tmux-agent-status.sh"

echo "[agy-statusline] Building dist/agy-hud.js bundle..."
node "$REPO_DIR/scripts/build.js"

mkdir -p "$AGY_CLI_DIR" "$(dirname -- "$PLUGIN_DIR")"

# Preserve existing user config.json if present before linking/copying
TMP_CONFIG=""
if [ -f "$PLUGIN_DIR/config.json" ] && [ ! -L "$PLUGIN_DIR" ]; then
  TMP_CONFIG=$(mktemp)
  cp "$PLUGIN_DIR/config.json" "$TMP_CONFIG"
fi

if [ "$INSTALL_STYLE" = "link" ]; then
  if [ "$PLUGIN_DIR" != "$REPO_DIR" ]; then
    rm -rf "$PLUGIN_DIR"
    ln -s "$REPO_DIR" "$PLUGIN_DIR"
  fi
  if [ ! -f "$REPO_DIR/config.json" ]; then
    if [ -n "$TMP_CONFIG" ] && [ -f "$TMP_CONFIG" ]; then
      cp "$TMP_CONFIG" "$REPO_DIR/config.json"
    else
      cp "$REPO_DIR/config.example.json" "$REPO_DIR/config.json"
    fi
  fi
else
  rm -rf "$PLUGIN_DIR"
  mkdir -p "$PLUGIN_DIR/hooks" "$PLUGIN_DIR/scripts" "$PLUGIN_DIR/dist" "$PLUGIN_DIR/docs"
  cp "$REPO_DIR/plugin.json" "$REPO_DIR/config.example.json" "$REPO_DIR/LICENSE" "$REPO_DIR/CHANGELOG.md" "$REPO_DIR/README.md" "$REPO_DIR/README.vi.md" "$PLUGIN_DIR/"
  if [ -n "$TMP_CONFIG" ] && [ -f "$TMP_CONFIG" ]; then
    cp "$TMP_CONFIG" "$PLUGIN_DIR/config.json"
  else
    cp "$REPO_DIR/config.example.json" "$PLUGIN_DIR/config.json"
  fi
  cp "$REPO_DIR/docs/hud-preview.png" "$PLUGIN_DIR/docs/hud-preview.png"
  cp "$REPO_DIR/hooks/status-line.sh" "$PLUGIN_DIR/hooks/status-line.sh"
  cp "$REPO_DIR/scripts/statusline.sh" "$PLUGIN_DIR/scripts/statusline.sh"
  cp "$REPO_DIR/scripts/title.sh" "$PLUGIN_DIR/scripts/title.sh"
  cp "$REPO_DIR/scripts/tmux-agent-status.sh" "$PLUGIN_DIR/scripts/tmux-agent-status.sh"
  cp "$REPO_DIR/dist/agy-hud.js" "$PLUGIN_DIR/dist/agy-hud.js"
  chmod +x "$PLUGIN_DIR/hooks/status-line.sh" \
           "$PLUGIN_DIR/scripts/statusline.sh" \
           "$PLUGIN_DIR/scripts/title.sh" \
           "$PLUGIN_DIR/scripts/tmux-agent-status.sh" \
           "$PLUGIN_DIR/dist/agy-hud.js"
fi

if [ -n "$TMP_CONFIG" ] && [ -f "$TMP_CONFIG" ]; then
  rm -f "$TMP_CONFIG"
fi

# Remove legacy standalone copies outside the unified plugin directory
rm -f "$AGY_CLI_DIR"/statusline.sh "$AGY_CLI_DIR"/statusline.sh.bak* "$AGY_CLI_DIR"/statusline.sh.backup* \
      "$AGY_CLI_DIR"/title.sh "$AGY_CLI_DIR"/title.sh.bak* "$AGY_CLI_DIR"/title.sh.backup*

SETTINGS_FILE="$AGY_CLI_DIR/settings.json"
if [ "$MODE" = "bash" ]; then
  STATUS_CMD="$PLUGIN_DIR/scripts/statusline.sh"
else
  STATUS_CMD="$PLUGIN_DIR/hooks/status-line.sh"
fi
TITLE_CMD="$PLUGIN_DIR/scripts/title.sh"
TMUX_HELPER="$PLUGIN_DIR/scripts/tmux-agent-status.sh"

node -e '
const fs = require("node:fs");
const file = process.argv[1];
const statusCmd = process.argv[2];
const titleCmd = process.argv[3];
let data = {};
if (fs.existsSync(file)) {
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.copyFileSync(file, file + ".bak");
  } catch {}
}
data.statusLine = { type: "command", command: statusCmd, enabled: true };
data.title = { type: "command", command: titleCmd, enabled: true };
fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
' "$SETTINGS_FILE" "$STATUS_CMD" "$TITLE_CMD"

# Upgrade ~/.tmux.conf to display live state, running vs. latest versions,
# outdated alerts (⬆), and process uptimes for both `agy` and Claude Code (`X.Y.Z`).
if [ -f "$TMUX_CONF" ]; then
  node -e '
  const fs = require("node:fs");
  const confPath = process.argv[1];
  const helperPath = process.argv[2];
  let content = fs.readFileSync(confPath, "utf8");
  const orig = content;

  const agentMatch = "#{m/r:^([0-9]+[.][0-9]+[.][0-9]+|agy|claude)$,#{pane_current_command}}";
  const desiredStatusRight =
    "set -g status-right '\''#{?#{&&:" + agentMatch + ",#{!=:#{@agent_bar_ver},}},#{?#{==:#{@agent_outdated},1},#[fg=#f9e2af]#[bold]#{@agent_bar_ver}#[default],#[fg=#a6e3a1]#{@agent_bar_ver}#[default]} #[fg=#94e2d5]⏱ #{@agent_uptime}#[fg=#45475a] │ #[default],}#(" + helperPath + ")#[fg=#45475a] │#[fg=#a6adc8] %Y-%m-%d #[bold]%H:%M #[default]'\''";
  const desiredWinCur =
    "setw -g window-status-current-format '\'' #I:#{?" + agentMatch + ",#{s/ [|] .*//:pane_title},#W}#{?#{==:#{@win_outdated},1}, #[fg=#f9e2af]#[bg=#45475a]#[bold]⬆#[fg=#f5e0dc]#[bg=#45475a]#[bold],}#F '\''";
  const desiredWin =
    "setw -g window-status-format '\'' #I:#{?" + agentMatch + ",#{s/ [|] .*//:pane_title},#W}#{?#{==:#{@win_outdated},1}, #[fg=#f9e2af]#[bold]⬆#[fg=#6c7086]#[nobold],} '\''";
  const desiredBorder =
    "set -g pane-border-format \" Pane: #{pane_index} | #{?" + agentMatch + ",#{s/ [|] .*//:pane_title} #{?#{!=:#{@agent_ver_badge},},#{?#{==:#{@agent_outdated},1},#[fg=#f9e2af]#[bold](#{@agent_ver_badge})#[default],#[fg=#a6e3a1](#{@agent_ver_badge})#[default]},(#{pane_current_command})}#{?#{!=:#{@agent_uptime},}, #[fg=#94e2d5]⏱ #{@agent_uptime}#[default],},#{pane_current_command}} \"";
  const desiredTitles =
    "set -g set-titles-string \"#S#{?" + agentMatch + ", (#{s/ [|] .*//:#{s/^[✳●○🏃😴] *//:pane_title}}),}\"";

  const lines = content.split(/\r?\n/);
  const hasInterval = lines.some((l) => /^\s*set(?:-option)?\s+-g\s+status-interval\b/.test(l));
  const out = [];
  for (const line of lines) {
    if (/^\s*set(?:-option)?\s+-g\s+status-interval\b/.test(line)) {
      out.push("set -g status-interval 5");
    } else if (/^\s*set(?:-option)?\s+-g\s+status-right\s+/.test(line)) {
      if (!hasInterval) out.push("set -g status-interval 5");
      out.push(desiredStatusRight);
    } else if (/^\s*set(?:-option)?\s+-g\s+status-right-length\b/.test(line)) {
      out.push("set -g status-right-length 120");
    } else if (/^\s*setw\s+-g\s+window-status-current-format\b/.test(line)) {
      out.push(desiredWinCur);
    } else if (/^\s*setw\s+-g\s+window-status-format\b/.test(line)) {
      out.push(desiredWin);
    } else if (/^\s*set(?:-option)?\s+-g\s+pane-border-format\b/.test(line)) {
      out.push(desiredBorder);
    } else if (/^\s*set(?:-option)?\s+-g\s+set-titles-string\b/.test(line)) {
      out.push(desiredTitles);
    } else {
      out.push(line);
    }
  }
  const next = out.join("\n");
  if (next !== orig) {
    fs.copyFileSync(confPath, confPath + ".bak");
    fs.writeFileSync(confPath, next, "utf8");
    console.log("[agy-statusline] Updated " + confPath + " with unified agy/claude version & uptime telemetry.");
  }
  ' "$TMUX_CONF" "$TMUX_HELPER"

  if [ "$TMUX_CONF" = "$HOME/.tmux.conf" ] && command -v tmux >/dev/null 2>&1 && tmux list-sessions >/dev/null 2>&1; then
    tmux source-file "$TMUX_CONF" 2>/dev/null || true
    "$TMUX_HELPER" >/dev/null 2>&1 || true
    tmux refresh-client -S 2>/dev/null || true
  fi
fi

echo "[agy-statusline] Installed ($INSTALL_STYLE mode)! Plugin -> $PLUGIN_DIR"
echo "  statusLine -> $STATUS_CMD"
echo "  title      -> $TITLE_CMD"
