#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-Command Installer for agy-statusline (Antigravity CLI HUD & Title Suite)
# Installs the Node.js HUD plugin (`agy-hud`), pure-Bash `statusline.sh`,
# and `title.sh`, configures `~/.gemini/antigravity-cli/settings.json`,
# and optionally upgrades `~/.tmux.conf` to display `agy` pane/window titles.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGY_CLI_DIR="${AGY_CLI_DIR:-$HOME/.gemini/antigravity-cli}"
PLUGIN_DIR="${AGY_PLUGIN_DIR:-$HOME/.gemini/config/plugins/agy-hud}"
TMUX_CONF="${AGY_TMUX_CONF:-$HOME/.tmux.conf}"
MODE="hud" # "hud" (Node.js HUD default) or "bash" (pure-Bash statusline.sh)

for arg in "$@"; do
  case "$arg" in
    --bash) MODE="bash" ;;
    --hud)  MODE="hud" ;;
    --help|-h)
      echo "Usage: ./install.sh [--hud | --bash]"
      echo "  --hud   (Default) Install Node.js HUD plugin + title.sh"
      echo "  --bash  Install pure-Bash statusline.sh + title.sh"
      exit 0
      ;;
  esac
done

echo "[agy-statusline] Building dist/agy-hud.js bundle..."
node "$REPO_DIR/scripts/build.js"

# Preserve user config.json if present, then clean legacy files from $PLUGIN_DIR
TMP_CONFIG=""
if [ -f "$PLUGIN_DIR/config.json" ]; then
  TMP_CONFIG=$(mktemp)
  cp "$PLUGIN_DIR/config.json" "$TMP_CONFIG"
fi
rm -rf "$PLUGIN_DIR"
mkdir -p "$AGY_CLI_DIR" "$PLUGIN_DIR/hooks" "$PLUGIN_DIR/dist" "$PLUGIN_DIR/docs"

# Copy plugin files
cp "$REPO_DIR/plugin.json" "$REPO_DIR/config.example.json" "$REPO_DIR/LICENSE" "$REPO_DIR/CHANGELOG.md" "$REPO_DIR/README.md" "$REPO_DIR/README.vi.md" "$PLUGIN_DIR/"
if [ -n "$TMP_CONFIG" ] && [ -f "$TMP_CONFIG" ]; then
  cp "$TMP_CONFIG" "$PLUGIN_DIR/config.json"
  rm -f "$TMP_CONFIG"
else
  cp "$REPO_DIR/config.example.json" "$PLUGIN_DIR/config.json"
fi
cp "$REPO_DIR/docs/hud-preview.png" "$PLUGIN_DIR/docs/hud-preview.png"
cp "$REPO_DIR/hooks/status-line.sh" "$PLUGIN_DIR/hooks/status-line.sh"
cp "$REPO_DIR/dist/agy-hud.js" "$PLUGIN_DIR/dist/agy-hud.js"
chmod +x "$PLUGIN_DIR/hooks/status-line.sh" "$PLUGIN_DIR/dist/agy-hud.js"

# Copy standalone bash scripts and clean legacy backups
rm -f "$AGY_CLI_DIR"/statusline.sh.bak* "$AGY_CLI_DIR"/statusline.sh.backup* "$AGY_CLI_DIR"/title.sh.bak* "$AGY_CLI_DIR"/title.sh.backup*
cp "$REPO_DIR/scripts/statusline.sh" "$AGY_CLI_DIR/statusline.sh"
cp "$REPO_DIR/scripts/title.sh" "$AGY_CLI_DIR/title.sh"
chmod +x "$AGY_CLI_DIR/statusline.sh" "$AGY_CLI_DIR/title.sh"

SETTINGS_FILE="$AGY_CLI_DIR/settings.json"
if [ "$MODE" = "bash" ]; then
  STATUS_CMD="$AGY_CLI_DIR/statusline.sh"
else
  STATUS_CMD="$PLUGIN_DIR/hooks/status-line.sh"
fi
TITLE_CMD="$AGY_CLI_DIR/title.sh"

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

# Upgrade ~/.tmux.conf if it uses #{m:*.*.*,#{pane_current_command}} so `agy` panes
# render their dynamic session title on tmux window tabs, pane borders, and outer terminal titles.
if [ -f "$TMUX_CONF" ]; then
  node -e '
  const fs = require("node:fs");
  const confPath = process.argv[1];
  let content = fs.readFileSync(confPath, "utf8");
  const orig = content;
  content = content
    .split("#{m:*.*.*,#{pane_current_command}}")
    .join("#{m/r:^([0-9]+[.][0-9]+[.][0-9]+|agy)$,#{pane_current_command}}");
  content = content
    .split("#{s/✳ //:pane_title}")
    .join("#{s/ [|] .*//:#{s/^[✳●○🏃😴] *//:pane_title}}");
  if (content !== orig) {
    fs.copyFileSync(confPath, confPath + ".bak");
    fs.writeFileSync(confPath, content, "utf8");
    console.log("[agy-statusline] Updated " + confPath + " to support agy window/pane titles.");
  }
  ' "$TMUX_CONF"
  if [ "$TMUX_CONF" = "$HOME/.tmux.conf" ] && command -v tmux >/dev/null 2>&1 && tmux list-sessions >/dev/null 2>&1; then
    tmux source-file "$TMUX_CONF" 2>/dev/null || true
  fi
fi

echo "[agy-statusline] Installed successfully! StatusLine -> $STATUS_CMD"
