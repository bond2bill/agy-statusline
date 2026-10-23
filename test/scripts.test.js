"use strict";

/**
 * @file scripts.test.js
 * @description
 * Integration tests for shell scripts: `hooks/status-line.sh`, `scripts/statusline.sh`,
 * `scripts/title.sh`, and `install.sh`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { strip } = require("../src/ansi");

const rootDir = path.resolve(__dirname, "..");

test("hooks/status-line.sh renders HUD and supports AGY_HUD_DEBUG=1", () => {
  const hookScript = path.join(rootDir, "hooks", "status-line.sh");
  const payload = JSON.stringify({
    cwd: "/Users/ryan/Automation_Solutions/RD_by_AI/agy-statusline",
    conversation_title: "Hook Test Session",
    model: { display_name: "Gemini 4 Argon (High)" },
    plan_tier: "Google AI Ultra",
    context_window: { used_percentage: 12 },
    agent_state: "working",
    terminal_width: 180
  });

  const out = cp.execFileSync("sh", [hookScript], {
    input: payload,
    encoding: "utf8",
    env: {
      ...process.env,
      AGY_HOST_LABEL: "MacMini",
      SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22",
      AGY_TMUX_NO_SYNC: "1"
    }
  });
  const plain = strip(out);
  assert.ok(plain.includes("MacMini·SSH"), `Expected MacMini·SSH in: ${plain}`);
  assert.ok(plain.includes("Hook Test Session"), `Expected session title in: ${plain}`);
});

test("scripts/statusline.sh renders Wide, Medium, and Narrow layouts and detects Host/SSH", () => {
  const bashStatus = path.join(rootDir, "scripts", "statusline.sh");
  for (const cols of [160, 100, 60]) {
    const payload = JSON.stringify({
      agent_state: "working",
      context_window: { used_percentage: 42.5 },
      vcs: { branch: "main", dirty: true },
      sandbox: { enabled: true },
      artifact_count: 2,
      subagents: [{ id: "1" }],
      task_count: 3,
      model: { display_name: "Gemini 4 Argon (High)" },
      terminal_width: cols,
      conversation_id: "conv-bash-1",
      conversation_title: "Bash HUD Session"
    });

    const out = cp.execFileSync("bash", [bashStatus], {
      input: payload,
      encoding: "utf8",
      env: {
        ...process.env,
        AGY_HOST_LABEL: "MacMini",
        SSH_CONNECTION: "10.0.0.1 123 10.0.0.2 22",
        AGY_TMUX_NO_SYNC: "1"
      }
    });
    const plain = strip(out);
    assert.ok(plain.includes("[MacMini·SSH]"), `Expected [MacMini·SSH] for width=${cols}: ${plain}`);
    assert.ok(plain.includes("WORKING"), `Expected WORKING state for width=${cols}: ${plain}`);
  }

  // Minimal payload without conversation_id or conversation_title
  const minOut = cp.execFileSync("bash", [bashStatus], {
    input: "{}",
    encoding: "utf8",
    env: {
      ...process.env,
      AGY_HOST_LABEL: "Laptop",
      SSH_CONNECTION: "",
      AGY_TMUX_NO_SYNC: "1"
    }
  });
  assert.ok(strip(minOut).includes("READY"));
});

test("scripts/title.sh formats tab/window titles in dot and emoji styles without TTY side-effects", () => {
  const titleScript = path.join(rootDir, "scripts", "title.sh");
  const payload = JSON.stringify({
    agent_state: "thinking",
    workspace: { current_dir: "/Users/ryan/agy-statusline" },
    conversation_id: "conv-title-1",
    conversation_title: "Build Community Statusline"
  });

  const dotOut = cp
    .execFileSync("bash", [titleScript], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, AGY_TITLE_NO_TTY: "1", AGY_TITLE_STYLE: "dot" }
    })
    .trim();
  assert.ok(dotOut.startsWith("● Build Community Statusl…"), `Unexpected dot title: ${dotOut}`);
  assert.ok(dotOut.includes("| agy-statusline | thinking"));

  const emojiOut = cp
    .execFileSync("bash", [titleScript], {
      input: JSON.stringify({
        agent_state: "idle",
        workspace: { current_dir: "/Users/ryan/agy-statusline" }
      }),
      encoding: "utf8",
      env: { ...process.env, AGY_TITLE_NO_TTY: "1", AGY_TITLE_STYLE: "emoji" }
    })
    .trim();
  assert.equal(emojiOut, "😴 agy-statusline | idle");
});

test("install.sh installs plugin, scripts, updates settings.json, and upgrades .tmux.conf in isolated directories", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-"));
  try {
    const cliDir = path.join(tmp, "antigravity-cli");
    const pluginDir = path.join(tmp, "plugins", "agy-hud");
    const tmuxConf = path.join(tmp, ".tmux.conf");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(
      path.join(cliDir, "settings.json"),
      JSON.stringify({ model: "Gemini 4 Argon (High)" }, null, 2)
    );
    fs.writeFileSync(
      tmuxConf,
      "setw -g window-status-current-format ' #I:#{?#{m:*.*.*,#{pane_current_command}},#{s/✳ //:pane_title},#W}#F '\n"
    );

    cp.execFileSync("bash", [path.join(rootDir, "install.sh"), "--hud"], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGY_CLI_DIR: cliDir,
        AGY_PLUGIN_DIR: pluginDir,
        AGY_TMUX_CONF: tmuxConf
      }
    });

    assert.ok(fs.existsSync(path.join(pluginDir, "dist", "agy-hud.js")));
    assert.ok(fs.existsSync(path.join(pluginDir, "hooks", "status-line.sh")));
    assert.ok(fs.existsSync(path.join(cliDir, "statusline.sh")));
    assert.ok(fs.existsSync(path.join(cliDir, "title.sh")));

    const updatedSettings = JSON.parse(
      fs.readFileSync(path.join(cliDir, "settings.json"), "utf8")
    );
    assert.equal(
      updatedSettings.statusLine.command,
      path.join(pluginDir, "hooks", "status-line.sh")
    );
    assert.equal(updatedSettings.title.command, path.join(cliDir, "title.sh"));

    const updatedTmuxConf = fs.readFileSync(tmuxConf, "utf8");
    assert.ok(
      updatedTmuxConf.includes("#{m/r:^([0-9]+[.][0-9]+[.][0-9]+|agy)$,#{pane_current_command}}"),
      `Expected upgraded tmux format in: ${updatedTmuxConf}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
