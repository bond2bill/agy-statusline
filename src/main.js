#!/usr/bin/env node
"use strict";

/**
 * @file main.js
 * @description CLI entrypoint and orchestration module for `agy-statusline` (`agy-hud`).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const { defaultConfig, loadFromPaths, configPaths } = require("./config");
const { load, matchModel } = require("./quota");
const { refreshQuota } = require("./quotaProbe");
const { branch, sanitizedBranch, gitBranchFromPayload } = require("./gitinfo");
const { getHostAndMode } = require("./host");
const {
  isClaudePayload,
  getClaudeSessionMeta,
  getSessionTitle,
  getConversationInfo,
  syncTmuxTitle
} = require("./session");
const { render } = require("./statusline");
const { collectAndSyncTmux } = require("./tmux");

const version = "1.2.0";
const consumedQuotaRefreshMs = 15 * 1000;
const untouchedQuotaRefreshMs = 30 * 1000;

/**
 * Parse JSON payload, stripping raw control characters inside JSON strings if needed.
 * @param {string} str
 * @returns {object}
 */
function safeParsePayload(str) {
  try {
    return JSON.parse(str);
  } catch {
    let inString = false;
    let escaped = false;
    let out = "";
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (inString) {
        if (escaped) {
          out += c;
          escaped = false;
        } else if (c === "\\") {
          out += c;
          escaped = true;
        } else if (c === '"') {
          out += c;
          inString = false;
        } else if (c === "\n") {
          out += "\\n";
        } else if (c === "\r") {
          out += "\\r";
        } else if (c === "\t") {
          out += "\\t";
        } else if (c.charCodeAt(0) < 32) {
          // drop non-printable control chars
        } else {
          out += c;
        }
      } else {
        if (c === '"') {
          inString = true;
        }
        out += c;
      }
    }
    return JSON.parse(out);
  }
}

function shouldUseProcessCWD(payloadCWD) {
  if (payloadCWD.trim() === "") {
    return true;
  }
  return path.basename(process.cwd()) === path.basename(payloadCWD);
}

/**
 * Resolve terminal column width when `payload.terminal_width` is absent (e.g. Claude Code CLI).
 * Queries `tmux display-message -p '#{pane_width}'` when inside tmux, reserving 4 cols for TUI padding.
 * @param {object} payload
 * @param {boolean} isClaude
 * @param {object} [opts]
 * @returns {number}
 */
function resolveTerminalWidth(payload, isClaude = false, opts = {}) {
  if ((payload.terminal_width ?? 0) > 0) {
    return payload.terminal_width;
  }
  if ((opts.terminalWidth ?? 0) > 0) {
    return opts.terminalWidth;
  }
  const env = opts.env || process.env;
  const envCols = Number(env?.AGY_HUD_WIDTH || env?.COLUMNS || 0);
  if (Number.isFinite(envCols) && envCols > 0) {
    return envCols;
  }
  if ((process.stdout?.columns ?? 0) > 0) {
    return process.stdout.columns;
  }
  if (env?.TMUX && opts.syncTmux !== false) {
    try {
      const execFn = opts.execFileSync || cp.execFileSync;
      const args =
        typeof env.TMUX_PANE === "string" && env.TMUX_PANE.trim().startsWith("%")
          ? ["display-message", "-p", "-t", env.TMUX_PANE.trim(), "#{pane_width}"]
          : ["display-message", "-p", "#{pane_width}"];
      const rawW = Number(
        String(
          execFn("tmux", args, {
            encoding: "utf8",
            timeout: 150,
            stdio: ["ignore", "pipe", "ignore"]
          }) || ""
        ).trim()
      );
      if (Number.isFinite(rawW) && rawW > 0) {
        return isClaude ? Math.max(40, rawW - 1) : rawW;
      }
    } catch {}
  }
  return isClaude ? 120 : 80;
}

/**
 * Render the status line string from raw JSON input, configuration, and optional quota cache.
 * @param {string} input
 * @param {object} [cfg]
 * @param {object|null} [cache]
 * @param {object} [opts]
 * @returns {string}
 */
function renderStatusline(input, cfg = defaultConfig(), cache = null, opts = {}) {
  if (!input || input.trim() === "") {
    return "agy-hud";
  }
  let payload;
  try {
    payload = safeParsePayload(input);
  } catch {
    return "agy-hud";
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "agy-hud";
  }
  const isClaude = isClaudePayload(payload);
  const claudeMeta = isClaude
    ? opts.claudeMeta ?? getClaudeSessionMeta(payload, opts.sessionOpts)
    : null;
  const terminalWidth = resolveTerminalWidth(payload, isClaude, opts);

  let branchName = "";
  if (cfg.showGitBranch) {
    branchName = gitBranchFromPayload(payload);
    if (branchName === "") {
      branchName = sanitizedBranch(payload.vcs?.branch ?? "");
    }
    if (branchName === "" && shouldUseProcessCWD(payload.cwd ?? "")) {
      branchName = branch(".");
    }
    if (branchName === "") {
      branchName = sanitizedBranch(process.env.AGY_HUD_GIT_BRANCH ?? "");
    }
  }
  let sessionTitle = "";
  if (cfg.showSession) {
    sessionTitle = opts.sessionTitle ?? getSessionTitle(payload, opts.sessionOpts);
    if (sessionTitle === "" && claudeMeta?.name) {
      sessionTitle = claudeMeta.name;
    }
  }
  if (opts.syncTmux !== false) {
    syncTmuxTitle(sessionTitle, payload, opts.tmuxOpts);
  }
  let hostInfo = null;
  if (cfg.showHost) {
    hostInfo = opts.hostInfo ?? getHostAndMode(opts.hostRuntime);
  }
  let convInfo = null;
  if (cfg.showConversationId !== false || cfg.showConversationSize !== false) {
    convInfo = opts.convInfo ?? getConversationInfo(payload, opts.sessionOpts);
  }
  try {
    return render(payload, {
      config: cfg,
      quota: isClaude ? null : cache,
      gitBranch: branchName,
      sessionTitle,
      hostInfo,
      convInfo,
      terminalWidth,
      agentState: opts.agentState ?? claudeMeta?.agentState,
      fallbackVersion: opts.fallbackVersion ?? claudeMeta?.version,
      now: opts.now
    });
  } catch {
    return "agy-hud";
  }
}

function quotaCacheWritePath() {
  const explicit = process.env.AGY_HUD_QUOTA_CACHE;
  if (explicit) {
    return explicit;
  }
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, "agy-hud", "quota_cache.json");
  }
  const home = os.homedir();
  if (!home) {
    return "";
  }
  return path.join(home, ".cache", "agy-hud", "quota_cache.json");
}

function legacyQuotaCachePath() {
  const home = os.homedir();
  if (!home) {
    return "";
  }
  return path.join(home, ".gemini", "antigravity-cli", "scratch", "agy-hud", "quota_cache.json");
}

function quotaCacheReadCandidates() {
  if (process.env.AGY_HUD_QUOTA_CACHE) {
    return [quotaCacheWritePath()];
  }
  const candidates = [quotaCacheWritePath(), legacyQuotaCachePath()];
  return candidates.filter(
    (candidate, index) => candidate !== "" && candidates.indexOf(candidate) === index
  );
}

function loadQuotaFromCandidates(candidates) {
  let primaryUnloadable = false;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const [cache, ok] = load(candidate);
    if (ok) {
      return [cache, true, primaryUnloadable];
    }
    if (index === 0 && fs.existsSync(candidate)) {
      primaryUnloadable = true;
    }
  }
  return [null, false, primaryUnloadable];
}

function usage(write) {
  write("usage: agy-hud [statusline|tmux-status|quota refresh|version]\n");
}

async function runCli(args, deps = {}) {
  const stdout =
    deps.stdout ??
    ((chunk) => {
      process.stdout.write(chunk);
    });
  const stderr =
    deps.stderr ??
    ((chunk) => {
      process.stderr.write(chunk);
    });
  const command = args[0] ?? "statusline";
  if (command === "version" || command === "--version" || command === "-v") {
    stdout(`${version}\n`);
    return 0;
  }
  if (command === "tmux-status") {
    const summary = (deps.collectAndSyncTmux ?? collectAndSyncTmux)(deps.tmuxStatusOpts);
    if (summary) {
      stdout(`${summary}\n`);
    }
    return 0;
  }
  if (command === "statusline") {
    const cfg = loadFromPaths(configPaths());
    const raw = await readStdin(deps.stdin ?? process.stdin);
    const payload = parsePayload(raw);
    let displayCache = null;
    if (!isClaudePayload(payload)) {
      const cachePath = quotaCacheWritePath();
      const [cache, ok, primaryUnloadable] = loadQuotaFromCandidates(quotaCacheReadCandidates());
      const [nextCache, refreshed] = await refreshQuotaBeforeRenderIfNeeded(
        cachePath,
        ok ? cache : null,
        payload,
        deps.refreshQuota ?? refreshQuota
      );
      displayCache = nextCache;
      triggerBackgroundRefreshIfNeeded(
        cachePath,
        displayCache,
        payload,
        primaryUnloadable && !refreshed
      );
    }
    stdout(`${renderStatusline(raw, cfg, displayCache)}\n`);
    return 0;
  }
  if (command === "quota") {
    if (args[1] === "refresh") {
      const lockPath = quotaCacheWritePath() + ".lock";
      try {
        const result = await (deps.refreshQuota ?? refreshQuota)(quotaCacheWritePath());
        stderr(`[quota_probe] ${result.message}\n`);
        if (result.ok && result.summary) {
          stdout(`${result.summary}\n`);
        }
        return result.ok ? 0 : 2;
      } catch (error) {
        stderr(`[quota_probe] ${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
      } finally {
        try {
          if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
          }
        } catch {}
      }
    }
    usage(stderr);
    return 2;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    usage(stderr);
    return 0;
  }
  usage(stderr);
  return 2;
}

function readStdin(stdin) {
  return new Promise((resolve) => {
    let raw = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      raw += chunk;
    });
    stdin.on("end", () => {
      resolve(raw);
    });
  });
}

async function refreshQuotaBeforeRenderIfNeeded(cachePath, cache, payload, refresh) {
  if (!shouldRefreshBeforeRender(cachePath, payload, new Date())) {
    return [cache, false];
  }
  try {
    const result = await refresh(cachePath);
    if (!result.ok) {
      return [cache, false];
    }
    const [freshCache, ok] = load(cachePath);
    if (!ok) {
      return [cache, false];
    }
    saveStatuslineRefreshState(
      refreshStatePath(cachePath),
      mergeStatuslineRefreshState(null, payload, true, new Date())
    );
    return [freshCache, true];
  } catch {
    return [cache, false];
  }
}

function shouldRefreshBeforeRender(cachePath, payload, now) {
  if (cachePath === "" || !payload) {
    return false;
  }
  const prevState = loadRefreshStateWithFallback(quotaCacheReadCandidates());
  const prevAgentState = prevState?.agentState ?? "";
  const agentState = normalizeAgentState(payload.agent_state);
  if (agentState !== "idle" || prevAgentState === "" || prevAgentState === "idle") {
    return false;
  }
  if (prevState?.lastActivityAt) {
    const last = new Date(prevState.lastActivityAt);
    if (!Number.isNaN(last.getTime()) && now.getTime() - last.getTime() < 5 * 1000) {
      return false;
    }
  }
  return true;
}

function triggerBackgroundRefreshIfNeeded(
  cachePath,
  cache,
  payload = null,
  repairRefresh = false
) {
  const now = new Date();
  const statePath = refreshStatePath(cachePath);
  const prevState = loadRefreshStateWithFallback(quotaCacheReadCandidates());
  const activityRefresh = shouldTriggerActivityRefresh(cache, payload, prevState, now);
  const nextState = mergeStatuslineRefreshState(prevState, payload, activityRefresh, now);
  saveStatuslineRefreshState(statePath, nextState);
  if (!quotaCacheNeedsRefresh(cache, now) && !activityRefresh && !repairRefresh) {
    return;
  }
  const lockPath = cachePath + ".lock";
  try {
    if (fs.existsSync(lockPath)) {
      const stat = fs.statSync(lockPath);
      const minLockMs = activityRefresh ? 5 * 1000 : 30 * 1000;
      if (now.getTime() - stat.mtimeMs < minLockMs) {
        return;
      }
    }
    fs.writeFileSync(lockPath, new Date().toISOString(), "utf8");
    const nodePath = process.argv[0];
    const child = cp.spawn(nodePath, [__filename, "quota", "refresh"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {}
}

function quotaCacheNeedsRefresh(cache, now = new Date()) {
  if (!cache || !cache.timestamp) {
    return true;
  }
  try {
    const cacheTime = new Date(cache.timestamp);
    if (Number.isNaN(cacheTime.getTime())) {
      return true;
    }
    const interval = cacheLooksUntouched(cache) ? untouchedQuotaRefreshMs : consumedQuotaRefreshMs;
    if (now.getTime() - cacheTime.getTime() > interval) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

function parsePayload(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function refreshStatePath(cachePath) {
  if (cachePath === "") {
    return "";
  }
  return `${cachePath}.statusline.json`;
}

function loadRefreshStateWithFallback(candidates) {
  for (const candidate of candidates) {
    const statePath = refreshStatePath(candidate);
    if (statePath === "") {
      continue;
    }
    if (fs.existsSync(statePath)) {
      return loadStatuslineRefreshState(statePath);
    }
  }
  return null;
}

function loadStatuslineRefreshState(statePath) {
  if (statePath === "") {
    return null;
  }
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : "",
      agentState: typeof parsed.agentState === "string" ? parsed.agentState : "",
      lastActivityAt:
        typeof parsed.lastActivityAt === "string" ? parsed.lastActivityAt : undefined
    };
  } catch {
    return null;
  }
}

function saveStatuslineRefreshState(statePath, stateObj) {
  if (statePath === "") {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(statePath, `${JSON.stringify(stateObj, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  } catch {}
}

function mergeStatuslineRefreshState(prevState, payload, activityRefresh, now) {
  const next = {
    conversationId: prevState?.conversationId ?? "",
    agentState: prevState?.agentState ?? "",
    lastActivityAt: prevState?.lastActivityAt
  };
  if (payload) {
    next.conversationId = (payload.conversation_id ?? "").trim();
    next.agentState = normalizeAgentState(payload.agent_state);
  }
  if (activityRefresh) {
    next.lastActivityAt = now.toISOString();
  }
  return next;
}

function shouldTriggerActivityRefresh(cache, payload, prevState, now) {
  if (!payload) {
    return false;
  }
  const conversationId = (payload.conversation_id ?? "").trim();
  const agentState = normalizeAgentState(payload.agent_state);
  const prevConversationId = prevState?.conversationId ?? "";
  const prevAgentState = prevState?.agentState ?? "";
  const conversationChanged = conversationId !== "" && conversationId !== prevConversationId;
  const becameActive = agentState !== "" && agentState !== "idle" && agentState !== prevAgentState;
  const settledAfterActive =
    agentState === "idle" && prevAgentState !== "" && prevAgentState !== "idle";
  if (settledAfterActive) {
    return true;
  }
  if (!cacheLooksUntouched(cache) && !activeModelQuotaLooksUntouched(cache, payload)) {
    return false;
  }
  if (!conversationChanged && !becameActive && !settledAfterActive) {
    return false;
  }
  if (prevState?.lastActivityAt) {
    const last = new Date(prevState.lastActivityAt);
    if (!Number.isNaN(last.getTime()) && now.getTime() - last.getTime() < 5 * 1000) {
      return false;
    }
  }
  return true;
}

function activeModelQuotaLooksUntouched(cache, payload) {
  if (!cache) {
    return false;
  }
  const model = payload.model?.display_name || payload.model?.id || "";
  if (model === "") {
    return false;
  }
  const [quota, ok] = matchModel(cache, model);
  if (!ok || quota === null) {
    return true;
  }
  return quota.remainingFraction >= 1;
}

function normalizeAgentState(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

function cacheLooksUntouched(cache) {
  if (!cache || !cache.models) {
    return false;
  }
  const quotas = Object.values(cache.models);
  if (quotas.length === 0) {
    return true;
  }
  for (const quota of quotas) {
    if (quota.remainingFraction < 1) {
      return false;
    }
  }
  return true;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  version,
  safeParsePayload,
  renderStatusline,
  configPaths,
  quotaCacheWritePath,
  quotaCacheReadCandidates,
  quotaCacheNeedsRefresh,
  runCli
};
