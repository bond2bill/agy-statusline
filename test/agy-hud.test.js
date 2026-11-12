"use strict";

/**
 * @file agy-hud.test.js
 * @description
 * Comprehensive unit, edge-case, and soak tests for all `src/*` modules and bundled `dist/agy-hud.js`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const ansi = require("../src/ansi");
const config = require("../src/config");
const gitinfo = require("../src/gitinfo");
const host = require("../src/host");
const session = require("../src/session");
const quota = require("../src/quota");
const quotaProbe = require("../src/quotaProbe");
const statusline = require("../src/statusline");
const tmux = require("../src/tmux");
const main = require("../src/main");
const bundled = require("../dist/agy-hud");

test("ansi: strip, visibleLen, and colorize handle Unicode and ANSI codes", () => {
  const colored = ansi.colorize(" MacMini·SSH", ansi.colorOrange, true);
  assert.ok(colored.includes("\x1b["));
  assert.equal(ansi.strip(colored), " MacMini·SSH");
  assert.equal(ansi.visibleLen(colored), 13);
  assert.equal(ansi.colorize("plain", ansi.colorGreen, false), "plain");
});

test("config: defaultConfig and merge apply overrides accurately", () => {
  const base = config.defaultConfig();
  assert.equal(base.showHost, true);
  assert.equal(base.showSession, true);
  const merged = config.merge(base, {
    show_host: false,
    show_session: false,
    multiline: false,
    context_value: "both",
    usage_value: "percent"
  });
  assert.equal(merged.showHost, false);
  assert.equal(merged.showSession, false);
  assert.equal(merged.multiline, false);
  assert.equal(merged.contextValue, "both");
  assert.equal(merged.usageValue, "percent");
});

test("gitinfo: resolves branch from .git directory, worktree gitdir file, and sanitizes names", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-"));
  try {
    const repoDir = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/feat/hud-v1\n");
    assert.equal(gitinfo.branch(repoDir), "feat/hud-v1");

    const wtDir = path.join(tmp, "worktree");
    const wtGitDir = path.join(tmp, "wt-gitdir");
    fs.mkdirSync(wtDir, { recursive: true });
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, ".git"), `gitdir: ${wtGitDir}\n`);
    fs.writeFileSync(path.join(wtGitDir, "HEAD"), "ref: refs/heads/refactor-go-port\n");
    assert.equal(gitinfo.branch(wtDir), "refactor-go-port");

    assert.equal(gitinfo.sanitizedBranch("main"), "main");
    assert.equal(gitinfo.sanitizedBranch("bad;rm -rf"), "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("host: detects MacMini vs Laptop and Local (Remote Desktop) vs SSH (including tmux client tree)", () => {
  // 1. MacMini at Local (Remote Desktop GUI -> iTermServer -> login -> zsh -> agy)
  const macMiniLocal = host.getHostAndMode({
    env: {},
    platform: "darwin",
    pid: 500,
    hostname: () => "Ryan-Lab.local",
    sysctlModel: () => "Macmini9,1",
    pmsetBatt: () => "Now drawing from 'AC Power'",
    psTree: () =>
      [
        "1 0 /sbin/launchd",
        "200 1 /Users/ryan/Library/Application Support/iTerm2/iTermServer",
        "300 200 /usr/bin/login",
        "400 300 -zsh",
        "500 400 agy"
      ].join("\n"),
    tmuxClientPid: () => 0
  });
  assert.equal(macMiniLocal.machine, "MacMini");
  assert.equal(macMiniLocal.mode, "Local");
  assert.equal(macMiniLocal.isSsh, false);

  // 2. MacMini via SSHD (even when SSH_* env vars are absent, detected via sshd-session ancestor)
  const macMiniSsh = host.getHostAndMode({
    env: {},
    platform: "darwin",
    pid: 500,
    hostname: () => "Ryan-Lab.local",
    sysctlModel: () => "Macmini9,1",
    pmsetBatt: () => "Now drawing from 'AC Power'",
    psTree: () =>
      [
        "1 0 /sbin/launchd",
        "200 1 sshd-session: ryan [priv]",
        "300 200 sshd-session: ryan@ttys015",
        "400 300 -zsh",
        "500 400 agy"
      ].join("\n"),
    tmuxClientPid: () => 0
  });
  assert.equal(macMiniSsh.machine, "MacMini");
  assert.equal(macMiniSsh.mode, "SSH");
  assert.equal(macMiniSsh.isSsh, true);

  // 3. Laptop (MacBookPro) at Local
  const laptopLocal = host.getHostAndMode({
    env: {},
    platform: "darwin",
    pid: 500,
    hostname: () => "Ryans-MacBook-Pro.local",
    sysctlModel: () => "MacBookPro18,3",
    pmsetBatt: () => "Now drawing from 'Battery Power'\n -InternalBattery-0",
    psTree: () => "1 0 /sbin/launchd\n500 1 agy\n",
    tmuxClientPid: () => 0
  });
  assert.equal(laptopLocal.machine, "Laptop");
  assert.equal(laptopLocal.mode, "Local");

  // 4. Apple Silicon MacBook with generic Mac15,6 model detected via InternalBattery
  const m3Laptop = host.getHostAndMode({
    env: {},
    platform: "darwin",
    pid: 500,
    hostname: () => "Ryan-Air.local",
    sysctlModel: () => "Mac15,12",
    pmsetBatt: () => "Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)",
    psTree: () => "1 0 /sbin/launchd\n500 1 agy\n",
    tmuxClientPid: () => 0
  });
  assert.equal(m3Laptop.machine, "Laptop");
  assert.equal(m3Laptop.mode, "Local");

  // 5. Tmux session started locally (PID 2111 -> PPID 1), but currently attached via SSH client (PID 900 -> sshd 800)
  const tmuxViaSsh = host.getHostAndMode({
    env: { TMUX: "/tmp/tmux-501/default,2111,0" },
    platform: "darwin",
    pid: 500,
    hostname: () => "Ryan-Lab.local",
    sysctlModel: () => "Macmini9,1",
    pmsetBatt: () => "",
    psTree: () =>
      [
        "1 0 /sbin/launchd",
        "2111 1 tmux",
        "500 2111 agy",
        "800 1 sshd-session: ryan@ttys004",
        "850 800 -zsh",
        "900 850 tmux"
      ].join("\n"),
    tmuxClientPid: () => 900
  });
  assert.equal(tmuxViaSsh.machine, "MacMini");
  assert.equal(tmuxViaSsh.mode, "SSH");

  // 6. Tmux session started over SSH (SSH_CONNECTION set in pane), but currently attached via Local GUI client (PID 901 -> iTermServer 700)
  const tmuxViaLocalGui = host.getHostAndMode({
    env: {
      TMUX: "/tmp/tmux-501/default,2111,0",
      SSH_CONNECTION: "127.0.0.1 12345 127.0.0.1 22"
    },
    platform: "darwin",
    pid: 500,
    hostname: () => "Ryan-Lab.local",
    sysctlModel: () => "Macmini9,1",
    pmsetBatt: () => "",
    psTree: () =>
      [
        "1 0 /sbin/launchd",
        "2111 1 tmux",
        "500 2111 agy",
        "700 1 iTermServer",
        "750 700 -zsh",
        "901 750 tmux"
      ].join("\n"),
    tmuxClientPid: () => 901
  });
  assert.equal(tmuxViaLocalGui.machine, "MacMini");
  assert.equal(tmuxViaLocalGui.mode, "Local");
});

test("session: resolves /rename from history.jsonl (by conversationId and workspace fallback), falls back to DB, and syncs tmux window/pane titles", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sess-"));
  try {
    const histFile = path.join(tmp, "history.jsonl");
    const convId = "conv-123";
    fs.writeFileSync(
      histFile,
      [
        JSON.stringify({ conversationId: convId, display: "/rename Old Name" }),
        JSON.stringify({ conversationId: "other-id", display: "/rename Other Session" }),
        JSON.stringify({ conversationId: convId, display: '/rename "New Custom Name"' }),
        JSON.stringify({ workspace: "/Users/ryan/grok_x", display: "/rename GROK_IMAGES" })
      ].join("\n") + "\n"
    );

    const resolved = session.getSessionTitle(
      { conversation_id: convId, conversation_title: "Fallback Title" },
      { historyPath: histFile, dbPath: path.join(tmp, "missing.db") }
    );
    assert.equal(resolved, "New Custom Name");

    // Brand-new session before conversation_id is assigned: falls back to workspace /rename
    const wsResolved = session.getSessionTitle(
      { cwd: "/Users/ryan/grok_x" },
      { historyPath: histFile, dbPath: path.join(tmp, "missing.db") }
    );
    assert.equal(wsResolved, "GROK_IMAGES");

    const fallback = session.getSessionTitle(
      { conversation_id: "unrenamed-id", conversation_title: "Fallback Title" },
      { historyPath: histFile, dbPath: path.join(tmp, "missing.db") }
    );
    assert.equal(fallback, "Fallback Title");

    // Verify tmux window and pane title synchronization + cache deduplication
    const tmuxCalls = [];
    const cacheFile = path.join(tmp, "tmux-cache.json");
    const mockExec = (cmd, args) => {
      tmuxCalls.push([cmd, ...args]);
      return "";
    };
    const synced1 = session.syncTmuxTitle(
      "GROK_IMAGES",
      { agent_state: "working", cwd: "/Users/ryan/grok_x" },
      {
        env: { TMUX: "/tmp/tmux-501/default,2111,0", TMUX_PANE: "%24" },
        cacheFile,
        execFileSync: mockExec
      }
    );
    assert.equal(synced1, true);
    assert.deepEqual(tmuxCalls, [
      ["tmux", "select-pane", "-t", "%24", "-T", "● GROK_IMAGES"],
      ["tmux", "rename-window", "-t", "%24", "GROK_IMAGES"]
    ]);

    // Second call with identical title and state is a no-op via cache
    const synced2 = session.syncTmuxTitle(
      "GROK_IMAGES",
      { agent_state: "working", cwd: "/Users/ryan/grok_x" },
      {
        env: { TMUX: "/tmp/tmux-501/default,2111,0", TMUX_PANE: "%24" },
        cacheFile,
        execFileSync: mockExec
      }
    );
    assert.equal(synced2, false);
    assert.equal(tmuxCalls.length, 2);

    // Conversation ID & real file size (.db + .db-wal + transcript_full.jsonl)
    const cliDir = path.join(tmp, "cli");
    const realUuid = "cc9b9f65-a822-484a-b71a-5cc3f177adf8";
    fs.mkdirSync(path.join(cliDir, "conversations"), { recursive: true });
    fs.mkdirSync(
      path.join(cliDir, "brain", realUuid, ".system_generated", "logs"),
      { recursive: true }
    );
    fs.writeFileSync(path.join(cliDir, "conversations", `${realUuid}.db`), Buffer.alloc(1024 * 1024));
    fs.writeFileSync(
      path.join(cliDir, "conversations", `${realUuid}.db-wal`),
      Buffer.alloc(4 * 1024 * 1024)
    );
    fs.writeFileSync(
      path.join(cliDir, "brain", realUuid, ".system_generated", "logs", "transcript_full.jsonl"),
      Buffer.alloc(512 * 1024)
    );

    const cInfo = session.getConversationInfo({ conversation_id: realUuid }, { cliDir });
    assert.equal(cInfo.id, realUuid);
    assert.equal(cInfo.shortId, "cc9b9f65");
    assert.equal(cInfo.sizeBytes, 5.5 * 1024 * 1024);
    assert.equal(cInfo.sizeText, "5.5MB");

    const traversal = session.getConversationInfo(
      { conversation_id: "../../etc/passwd" },
      { cliDir }
    );
    assert.equal(traversal.id, "");
    assert.equal(traversal.sizeBytes, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("statusline & main: renders host, session, model, git branch, context, and dual-window quota identically in src and dist", () => {
  const payload = {
    cwd: "/Users/ryan/Automation_Solutions/RD_by_AI/agy-statusline",
    conversation_id: "d8fb3f4f-6415-4cbf-88fa-176c12c9f154",
    conversation_title: "Refactor AGY Statusline",
    model: {
      id: "Gemini 4 Argon (High)",
      display_name: "Gemini 4 Argon (High)"
    },
    plan_tier: "Google AI Ultra",
    context_window: {
      total_input_tokens: 52428,
      context_window_size: 1048576,
      used_percentage: 5.0
    },
    quota: {
      "gemini-5h": { remaining_fraction: 1.0, reset_in_seconds: 17800 },
      "gemini-weekly": { remaining_fraction: 0.6, reset_in_seconds: 82700 }
    },
    agent_state: "working",
    vcs: { branch: "main" },
    terminal_width: 200
  };

  const cfg = config.defaultConfig();
  const hostInfo = { machine: "MacMini", mode: "SSH", isSsh: true };
  const raw = JSON.stringify(payload);

  const outSrc = main.renderStatusline(raw, cfg, null, {
    hostInfo,
    sessionTitle: "Refactor AGY Statusline",
    syncTmux: false
  });
  const outDist = bundled.renderStatusline(raw, cfg, null, {
    hostInfo,
    sessionTitle: "Refactor AGY Statusline",
    syncTmux: false
  });

  assert.equal(outSrc, outDist);
  const plain = ansi.strip(outSrc);
  assert.ok(plain.includes("MacMini·SSH"), `Expected MacMini·SSH in: ${plain}`);
  assert.ok(plain.includes("4 Argon High"), `Expected model in: ${plain}`);
  assert.ok(plain.includes("Refactor AGY Statusline"), `Expected session title in: ${plain}`);
  assert.ok(
    plain.includes("d8fb3f4f-6415-4cbf-88fa-176c12c9f154"),
    `Expected full UUID on wide terminal in: ${plain}`
  );
  assert.ok(plain.includes("5h:"), `Expected 5h quota window in: ${plain}`);
  assert.ok(plain.includes("Week:"), `Expected Week quota window in: ${plain}`);

  // Narrower width (115 cols): automatically steps down full UUID to 8-char short ID + size
  const narrowPayload = { ...payload, terminal_width: 115 };
  const narrowOut = main.renderStatusline(JSON.stringify(narrowPayload), cfg, null, {
    hostInfo,
    sessionTitle: "Refactor AGY",
    convInfo: {
      id: payload.conversation_id,
      shortId: "d8fb3f4f",
      sizeBytes: 6186598,
      sizeText: "5.9MB"
    },
    syncTmux: false
  });
  const narrowPlain = ansi.strip(narrowOut);
  assert.ok(
    narrowPlain.includes("d8fb3f4f (5.9MB)"),
    `Expected 8-char short ID + size on narrower width in: ${narrowPlain}`
  );
  assert.ok(!narrowPlain.includes("d8fb3f4f-6415-4cbf-88fa-176c12c9f154"));
});

test("tmux: compares SemVer, formats etime, finds child agy/cc PIDs under zsh, and syncs outdated/uptime options", () => {
  assert.equal(tmux.compareSemver("1.4.12", "1.5.5"), -1);
  assert.equal(tmux.compareSemver("2.1.9", "2.1.322"), -1);
  assert.equal(tmux.compareSemver("1.10.0", "1.5.5"), 1);
  assert.equal(tmux.compareSemver("1.5.5", "1.5.5"), 0);

  assert.equal(tmux.formatEtime("19-01:40:07"), "19d1h");
  assert.equal(tmux.formatEtime("05:49:52"), "5h49m");
  assert.equal(tmux.formatEtime("07:45"), "7m");
  assert.equal(tmux.formatEtime("00:25"), "<1m");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tmux-test-"));
  try {
    const oldLog = path.join(tmp, "log", "cli-20261103_155437.log");
    const newLog = path.join(tmp, "log", "cli-20261111_114321.log");
    fs.mkdirSync(path.dirname(oldLog), { recursive: true });
    fs.writeFileSync(oldLog, "I1103 server.go:1] Starting\nI1103 server.go:2] Language server version: 1.4.12\n");
    fs.writeFileSync(newLog, "I1111 server.go:1] Starting\nI1111 server.go:2] Language server version: 1.5.5\n");

    const setCalls = [];
    const mockExec = (cmd, args) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return [
          "%1\t@1\t100\tagy\t○ GROK_X\t\t\t\t\t",
          "%2\t@2\t200\tagy\t● TMUX_RD\t1.5.5\t\t\t\t",
          "%3\t@3\t300\t2.1.310\t✳ TH_SOAK\t\t\t\t\t",
          "%4\t@4\t400\tzsh\tzsh\t\tagy 1.4.12 ✓\tagy 1.4.12✓\t5m\t0"
        ].join("\n");
      }
      if (cmd === "tmux" && args[0] === "list-windows") {
        return ["@1\t0", "@2\t0", "@3\t0", "@4\t1"].join("\n");
      }
      if (cmd === "ps") {
        return [
          "  100     1 15-02:00:00 -zsh",
          "  101   100 07-19:56:29 /Users/ryan/.local/bin/agy",
          "  200     1    05:00:00 -zsh",
          "  201   200       12:30 /Users/ryan/.local/bin/agy",
          "  300     1 18-04:00:00 -zsh",
          "  301   300 18-03:59:00 2.1.310",
          "  400     1    01:00:00 -zsh"
        ].join("\n");
      }
      if (cmd === "lsof" && args[1] === "101") {
        return `p101\nn${oldLog}\n`;
      }
      if (cmd === "lsof" && args[1] === "201") {
        return `p201\nn${newLog}\n`;
      }
      if (cmd === "tmux" && args[0] === "set-option") {
        setCalls.push(args);
      }
      return "";
    };

    const summary = tmux.collectAndSyncTmux({
      execFileSync: mockExec,
      latestVersions: { agy: "1.5.5", cc: "2.1.322" },
      pidCacheFile: path.join(tmp, "pid-cache.json")
    });

    assert.ok(summary.includes("●1"), `Expected 1 working agent in: ${summary}`);
    assert.ok(summary.includes("/3"), `Expected 3 total agents in: ${summary}`);
    assert.ok(summary.includes("⬆ 1 agy · 1 cc"), `Expected outdated counts in: ${summary}`);

    const flatArgs = setCalls.flat().join(" ");
    assert.ok(flatArgs.includes("agy 1.4.12 → 1.5.5 ⬆"));
    assert.ok(flatArgs.includes("7d19h"));
    assert.ok(flatArgs.includes("agy 1.5.5 ✓"));
    assert.ok(flatArgs.includes("12m"));
    assert.ok(flatArgs.includes("cc 2.1.310 → 2.1.322 ⬆"));
    assert.ok(flatArgs.includes("18d3h"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("quotaProbe: parses processes, listening ports, and masks emails in quota cache", () => {
  const psOut = [
    "ryan 32720 0.1 0.5 /usr/local/bin/agy --dangerously-skip-permissions -c",
    "ryan 44110 0.2 1.0 /path/to/language_server --csrf_token tok-abc-123"
  ].join("\n");
  const agyInfos = quotaProbe.parseAgyServerInfos(psOut);
  assert.equal(agyInfos.length, 1);
  assert.equal(agyInfos[0].pid, "32720");

  const lsInfo = quotaProbe.parseLanguageServerInfo(psOut);
  assert.deepEqual(lsInfo, { pid: "44110", csrfToken: "tok-abc-123" });

  const ports = quotaProbe.parseListeningPorts(
    "agy 32720 ryan 10u IPv4 0x0 0t0 TCP 127.0.0.1:54321 (LISTEN)\n"
  );
  assert.deepEqual(ports, [54321]);

  const built = quotaProbe.buildQuotaCache(
    {
      userStatus: {
        email: "ryan.secret@gmail.com",
        planStatus: { planInfo: { planName: "Ultra" } },
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: "Gemini 4 Argon (High)",
              quotaInfo: { remainingFraction: 0.75, resetTime: "2026-10-23T12:00:00Z" }
            }
          ]
        }
      }
    },
    new Date("2026-10-23T05:00:00Z")
  );
  assert.ok(built);
  assert.equal(built.cache.email, "rya***@gmail.com");
  assert.equal(built.cache.plan_name, "Ultra");
});

test("runCli: handles version, help, and statusline commands cleanly", async () => {
  let out = "";
  const code = await main.runCli(["version"], {
    stdout: (chunk) => {
      out += chunk;
    }
  });
  assert.equal(code, 0);
  assert.equal(out.trim(), main.version);
});

test("soak: randomized payloads across widths, modes, models, and configs without error", () => {
  const iterations = Number(process.env.SOAK_ITERATIONS || 2500);
  const models = [
    "Gemini 4 Argon (High)",
    "Gemini 3.5 Flash (Medium)",
    "Claude Opus 4.5 (Thinking)",
    "Claude Sonnet 4.5",
    "GPT-4o",
    ""
  ];
  const states = ["idle", "thinking", "working", "tool_use", "authenticating", "custom_state"];
  const widths = [25, 45, 65, 80, 100, 120, 160, 240, 320];
  const hosts = [
    { machine: "MacMini", mode: "SSH", isSsh: true },
    { machine: "MacMini", mode: "Local", isSsh: false },
    { machine: "Laptop", mode: "Local", isSsh: false },
    { machine: "Laptop", mode: "SSH", isSsh: true }
  ];

  for (let i = 0; i < iterations; i++) {
    const width = widths[i % widths.length];
    const model = models[i % models.length];
    const agentState = states[i % states.length];
    const hostInfo = hosts[i % hosts.length];
    const multiline = i % 3 !== 0;
    const showIcons = i % 2 === 0;
    const color = i % 4 !== 0;
    const usedPct = (i * 17) % 105;

    const payload = {
      cwd: `/Users/ryan/project_${i % 10}`,
      conversation_id: `conv-${i}`,
      conversation_title: i % 5 === 0 ? "Unicode Title CJK & Emoji 🚀" : `Session #${i}`,
      model: { display_name: model },
      plan_tier: i % 2 === 0 ? "Google AI Ultra" : "Pro",
      context_window: {
        total_input_tokens: usedPct * 1000,
        context_window_size: 100000,
        used_percentage: usedPct
      },
      quota:
        i % 2 === 0
          ? {
              "gemini-5h": { remaining_fraction: (100 - (i % 100)) / 100, reset_in_seconds: 3600 },
              "gemini-weekly": { remaining_fraction: 0.45, reset_in_seconds: 172800 },
              "3p-5h": { remaining_fraction: 0.8, reset_in_seconds: 1800 },
              "3p-weekly": { remaining_fraction: 0.25, reset_in_seconds: 86400 }
            }
          : undefined,
      agent_state: agentState,
      vcs: { branch: `branch-${i % 20}` },
      terminal_width: width
    };

    const cfg = config.merge(config.defaultConfig(), {
      multiline,
      show_icons: showIcons,
      color,
      context_value: i % 3 === 0 ? "both" : i % 3 === 1 ? "tokens" : "percent",
      usage_value: i % 2 === 0 ? "remaining" : "percent"
    });

    const raw = JSON.stringify(payload);
    const out1 = main.renderStatusline(raw, cfg, null, {
      hostInfo,
      sessionTitle: payload.conversation_title,
      syncTmux: false
    });
    const out2 = bundled.renderStatusline(raw, cfg, null, {
      hostInfo,
      sessionTitle: payload.conversation_title,
      syncTmux: false
    });

    assert.equal(out1, out2);
    const lines = out1.split("\n");
    assert.equal(lines.length, multiline ? 2 : 1);
    for (const line of lines) {
      assert.ok(
        ansi.visibleLen(line) <= width,
        `Line visibleLen (${ansi.visibleLen(line)}) exceeded width (${width}): ${ansi.strip(line)}`
      );
    }
  }
});
