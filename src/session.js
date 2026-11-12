"use strict";

/**
 * @file session.js
 * @description
 * Real-time Session Title resolver and tmux Window/Pane title synchronizer for Antigravity CLI (`agy`).
 * Resolution priority:
 * 1. Explicit `payload.session_name` or `payload.title`.
 * 2. Latest `/rename <title>` entry in `~/.gemini/antigravity-cli/history.jsonl` matching `conversation_id`
 *    (or matching `workspace` on a newly started session before `conversation_id` is assigned).
 * 3. Live `payload.conversation_title` passed by Antigravity CLI.
 * 4. Summary title in `~/.gemini/antigravity-cli/conversation_summaries.db` (via `node:sqlite` or `sqlite3`).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const SAFE_CONV_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_VER_RE = /^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z._+-]*$/;

/**
 * Return the byte size of a regular file, or 0 when missing/inaccessible.
 * @param {string} filePath
 * @returns {number}
 */
function safeFileSize(filePath) {
  if (!filePath) return 0;
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && Number.isFinite(st.size) && st.size > 0 ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Format a byte count into a concise human-readable string (e.g. `129KB`, `5.9MB`, `1.20GB`).
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.trunc(bytes)}B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/**
 * Resolve conversation ID (full + 8-char short prefix) and total storage size
 * (`conversations/<id>.db` + `<id>.db-wal` + `brain/<id>/.system_generated/logs/transcript_full.jsonl`).
 * @param {object} payload
 * @param {object} [opts]
 * @returns {{ id: string, shortId: string, sizeBytes: number, sizeText: string }}
 */
function getConversationInfo(payload, opts = {}) {
  const empty = { id: "", shortId: "", sizeBytes: 0, sizeText: "" };
  if (!payload || typeof payload !== "object") return empty;
  const rawId = String(payload.conversation_id || payload.session_id || "").trim();
  if (!rawId || !SAFE_CONV_ID_RE.test(rawId)) return empty;

  const shortId = rawId.length > 8 ? rawId.slice(0, 8) : rawId;
  const homeDir = opts.homeDir || os.homedir();
  const cliDir =
    opts.cliDir ||
    process.env.AGY_CLI_DIR ||
    (homeDir ? path.join(homeDir, ".gemini", "antigravity-cli") : "");

  let sizeBytes = 0;
  if (cliDir) {
    const dbSize = safeFileSize(path.join(cliDir, "conversations", `${rawId}.db`));
    const walSize = safeFileSize(path.join(cliDir, "conversations", `${rawId}.db-wal`));
    let transcriptSize = safeFileSize(
      path.join(cliDir, "brain", rawId, ".system_generated", "logs", "transcript_full.jsonl")
    );
    if (transcriptSize === 0) {
      transcriptSize = safeFileSize(
        path.join(cliDir, "brain", rawId, ".system_generated", "logs", "transcript.jsonl")
      );
    }
    if (transcriptSize === 0 && typeof payload.transcript_path === "string") {
      transcriptSize = safeFileSize(payload.transcript_path.trim());
    }
    sizeBytes = dbSize + walSize + transcriptSize;
  }

  return {
    id: rawId,
    shortId,
    sizeBytes,
    sizeText: formatBytes(sizeBytes)
  };
}

/**
 * Strip surrounding quotes, backticks, markdown hashes, and whitespace from a title string.
 * @param {string} str
 * @returns {string}
 */
function cleanTitle(str) {
  return String(str ?? "")
    .replace(/^[#*`"'\s]+/, "")
    .replace(/[#*`"'\s]+$/, "")
    .trim();
}

/**
 * Truncate a string by Unicode code points (runes), appending `…` when exceeding `maxLen`.
 * @param {string} str
 * @param {number} [maxLen=25]
 * @returns {string}
 */
function truncate(str, maxLen = 25) {
  const runes = Array.from(String(str ?? ""));
  if (runes.length > maxLen) {
    return `${runes.slice(0, maxLen - 1).join("")}…`;
  }
  return String(str ?? "");
}

/**
 * Resolve the human-readable title for the active conversation/session.
 * @param {object} payload
 * @param {object} [opts]
 * @returns {string}
 */
function getSessionTitle(payload, opts = {}) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.session_name === "string" && cleanTitle(payload.session_name) !== "") {
    return cleanTitle(payload.session_name);
  }
  if (typeof payload.title === "string" && cleanTitle(payload.title) !== "") {
    return cleanTitle(payload.title);
  }

  const convId = String(payload.conversation_id || payload.session_id || "").trim();
  const cwd = String(payload.workspace?.current_dir || payload.cwd || "").trim();

  const homeDir = opts.homeDir || os.homedir();
  const historyPath =
    opts.historyPath || path.join(homeDir, ".gemini", "antigravity-cli", "history.jsonl");

  // 1. Check history.jsonl first for the latest /rename command in real-time
  try {
    if (fs.existsSync(historyPath)) {
      const content = fs.readFileSync(historyPath, "utf8");
      const lines = content.trim().split(/\r?\n/);
      let workspaceFallback = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes("/rename")) continue;
        if (convId && line.includes(convId)) {
          try {
            const entry = JSON.parse(line);
            if (
              entry.conversationId === convId &&
              typeof entry.display === "string" &&
              entry.display.startsWith("/rename ")
            ) {
              const renameTitle = cleanTitle(entry.display.slice(8));
              if (renameTitle) {
                return renameTitle;
              }
            }
          } catch {}
        } else if (!convId && cwd && !workspaceFallback && i >= Math.max(0, lines.length - 25)) {
          try {
            const entry = JSON.parse(line);
            if (
              !entry.conversationId &&
              entry.workspace === cwd &&
              typeof entry.display === "string" &&
              entry.display.startsWith("/rename ")
            ) {
              const renameTitle = cleanTitle(entry.display.slice(8));
              if (renameTitle) {
                workspaceFallback = renameTitle;
              }
            }
          } catch {}
        }
      }
      if (workspaceFallback) {
        return workspaceFallback;
      }
    }
  } catch {}

  // 2. Check live conversation_title passed by Antigravity CLI
  if (
    typeof payload.conversation_title === "string" &&
    cleanTitle(payload.conversation_title) !== ""
  ) {
    return cleanTitle(payload.conversation_title);
  }

  if (!convId) {
    return "";
  }

  // 3. Fallback to conversation_summaries.db
  const dbPath =
    opts.dbPath ||
    path.join(homeDir, ".gemini", "antigravity-cli", "conversation_summaries.db");
  try {
    if (fs.existsSync(dbPath)) {
      try {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db
          .prepare("SELECT title FROM conversation_summaries WHERE conversation_id = ?")
          .get(convId);
        db.close();
        if (row && typeof row.title === "string" && cleanTitle(row.title) !== "") {
          return cleanTitle(row.title);
        }
      } catch {
        const safeId = convId.replace(/'/g, "");
        const out = cp.execFileSync(
          "sqlite3",
          [dbPath, `SELECT title FROM conversation_summaries WHERE conversation_id='${safeId}';`],
          {
            encoding: "utf8",
            timeout: 200,
            stdio: ["ignore", "pipe", "ignore"]
          }
        );
        if (out && cleanTitle(out)) {
          return cleanTitle(out);
        }
      }
    }
  } catch {}

  return "";
}

/**
 * Resolve the active tmux pane ID (`%0`, `%24`, etc.) from `TMUX_PANE` or process ancestry.
 * @param {object} [env]
 * @param {number} [pid]
 * @param {Function} [execFn]
 * @returns {string}
 */
function resolveTmuxPane(env = process.env, pid = process.pid, execFn = cp.execFileSync) {
  if (!env || !env.TMUX) return "";
  if (typeof env.TMUX_PANE === "string" && env.TMUX_PANE.trim().startsWith("%")) {
    return env.TMUX_PANE.trim();
  }
  try {
    const panesRaw = execFn("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"], {
      encoding: "utf8",
      timeout: 200,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const paneByPid = new Map();
    for (const line of String(panesRaw).split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(%\d+)$/);
      if (m) paneByPid.set(Number(m[1]), m[2]);
    }
    if (paneByPid.size === 0) return "";

    const psRaw = execFn("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 200,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const ppidMap = new Map();
    for (const line of String(psRaw).split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) ppidMap.set(Number(m[1]), Number(m[2]));
    }

    let cur = pid;
    const seen = new Set();
    while (cur && cur > 1 && !seen.has(cur)) {
      if (paneByPid.has(cur)) return paneByPid.get(cur);
      seen.add(cur);
      cur = ppidMap.get(cur);
    }
  } catch {}
  return "";
}

/**
 * Synchronize the resolved session title to the enclosing tmux pane (`select-pane -T`)
 * and tmux window (`rename-window`), using a lightweight cache to avoid redundant CLI calls.
 * @param {string} sessionTitle
 * @param {object} payload
 * @param {object} [opts]
 * @returns {boolean}
 */
function syncTmuxTitle(sessionTitle, payload, opts = {}) {
  const env = opts.env || process.env;
  if (!env || !env.TMUX || env.AGY_TMUX_NO_SYNC === "1") {
    return false;
  }
  const execFn = opts.execFileSync || cp.execFileSync;
  const paneId = resolveTmuxPane(env, opts.pid || process.pid, execFn);
  if (!paneId) return false;

  const state = String(payload?.agent_state || "idle").toLowerCase();
  const style = env.AGY_TITLE_STYLE || "dot";
  const ind =
    state === "idle"
      ? style === "emoji"
        ? "😴"
        : "○"
      : style === "emoji"
        ? "🏃"
        : "●";

  const cwd = String(payload?.workspace?.current_dir || payload?.cwd || "").trim();
  const workspace = cwd ? path.basename(cwd) : "agy";
  const shortTitle = sessionTitle ? truncate(cleanTitle(sessionTitle), 24) : "";
  const paneTitle = shortTitle ? `${ind} ${shortTitle}` : `${ind} ${workspace}`;
  const windowName = shortTitle;
  const rawVer = String(payload?.version || "").trim();
  const version = SAFE_VER_RE.test(rawVer) ? rawVer : "";

  const cacheFile = opts.cacheFile || path.join(os.tmpdir(), "agy-hud-tmux-cache.json");
  let cache = {};
  try {
    if (fs.existsSync(cacheFile)) {
      cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) || {};
    }
  } catch {
    cache = {};
  }

  const prev = cache[paneId];
  if (
    prev &&
    prev.paneTitle === paneTitle &&
    prev.windowName === windowName &&
    (version === "" || prev.version === version)
  ) {
    return false;
  }

  try {
    execFn("tmux", ["select-pane", "-t", paneId, "-T", paneTitle], {
      timeout: 200,
      stdio: "ignore"
    });
    if (windowName) {
      execFn("tmux", ["rename-window", "-t", paneId, windowName], {
        timeout: 200,
        stdio: "ignore"
      });
    }
    if (version) {
      execFn("tmux", ["set-option", "-p", "-t", paneId, "@agent_ver", version], {
        timeout: 200,
        stdio: "ignore"
      });
    }
    cache[paneId] = {
      paneTitle,
      windowName,
      version: version || prev?.version || "",
      updatedAt: Date.now()
    };
    fs.writeFileSync(cacheFile, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  cleanTitle,
  truncate,
  formatBytes,
  getConversationInfo,
  getSessionTitle,
  resolveTmuxPane,
  syncTmuxTitle
};
