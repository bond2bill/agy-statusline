"use strict";

/**
 * @file tmux.js
 * @description
 * Single-pass `tmux` fleet monitor and pane/window option synchronizer for both
 * Antigravity CLI (`agy`) and Claude Code (`claude` / `X.Y.Z`).
 *
 * Resolves each pane's true child agent process (`agy` or `claude` beneath `-zsh`),
 * determines its exact in-memory running version vs. latest installed binary on disk,
 * formats true process uptime (`etime`), updates native `tmux` `@` options only when
 * values change, and prints a concise global fleet summary for `status-right`.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;
const EXACT_VER_CMD_RE = /^\d+\.\d+\.\d+$/;
const SAFE_VER_RE = /^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z._+-]*$/;

/**
 * Compare two SemVer strings (`X.Y.Z`).
 * Returns `-1` if `a < b`, `0` if `a == b`, `1` if `a > b`, or `null` if invalid.
 * @param {string} a
 * @param {string} b
 * @returns {number|null}
 */
function compareSemver(a, b) {
  const ma = String(a ?? "").trim().match(SEMVER_RE);
  const mb = String(b ?? "").trim().match(SEMVER_RE);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const na = Number(ma[i]);
    const nb = Number(mb[i]);
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Format `ps -o etime=` output (`[[DD-]HH:]MM:SS`) into a compact badge (`7d19h`, `5h49m`, `12m`, `<1m`).
 * @param {string} raw
 * @returns {string}
 */
function formatEtime(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  let days = 0;
  let rest = s;
  const dashIdx = s.indexOf("-");
  if (dashIdx !== -1) {
    days = parseInt(s.slice(0, dashIdx), 10) || 0;
    rest = s.slice(dashIdx + 1);
  }
  const parts = rest.split(":").map((p) => parseInt(p, 10) || 0);
  let hours = 0;
  let mins = 0;
  if (parts.length === 3) {
    [hours, mins] = parts;
  } else if (parts.length === 2) {
    [, mins] = [0, parts[0]];
  } else {
    return "";
  }
  if (days > 0) {
    return `${days}d${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h${mins}m`;
  }
  if (mins > 0) {
    return `${mins}m`;
  }
  return "<1m";
}

/**
 * Parse `ps -axo pid=,ppid=,etime=,comm=` into lookup maps.
 * @param {string} psOutput
 * @returns {{ procByPid: Map<number, object>, childrenByPpid: Map<number, number[]> }}
 */
function parsePsTable(psOutput) {
  const procByPid = new Map();
  const childrenByPpid = new Map();
  for (const line of String(psOutput ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const etime = m[3];
    const fullComm = m[4].trim();
    const comm = path.basename(fullComm);
    procByPid.set(pid, { pid, ppid, etime, comm, fullComm });
    let list = childrenByPpid.get(ppid);
    if (!list) {
      list = [];
      childrenByPpid.set(ppid, list);
    }
    list.push(pid);
  }
  return { procByPid, childrenByPpid };
}

/**
 * Classify whether a process entry is an `agy` or `claude` (`cc`) CLI agent.
 * @param {{ pid: number, etime: string, comm: string }} proc
 * @returns {{ engine: "agy"|"cc", pid: number, etime: string, commVer: string }|null}
 */
function classifyAgentProc(proc) {
  if (!proc) return null;
  if (proc.comm === "agy") {
    return { engine: "agy", pid: proc.pid, etime: proc.etime, commVer: "" };
  }
  if (EXACT_VER_CMD_RE.test(proc.comm)) {
    return { engine: "cc", pid: proc.pid, etime: proc.etime, commVer: proc.comm };
  }
  if (proc.comm === "claude") {
    return { engine: "cc", pid: proc.pid, etime: proc.etime, commVer: "" };
  }
  return null;
}

/**
 * Find the active `agy` or `claude` process inside a tmux pane (checking `panePid` and up to 4 child levels).
 * @param {number} panePid
 * @param {string} paneCmd
 * @param {Map<number, object>} procByPid
 * @param {Map<number, number[]>} childrenByPpid
 * @returns {{ engine: "agy"|"cc", pid: number, etime: string, commVer: string }|null}
 */
function findPaneAgent(panePid, paneCmd, procByPid, childrenByPpid) {
  if (!panePid || panePid <= 0) return null;
  const root = procByPid.get(panePid);
  const direct = classifyAgentProc(root);
  if (direct) return direct;

  let frontier = childrenByPpid.get(panePid) || [];
  const visited = new Set([panePid]);
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    const next = [];
    for (const childPid of frontier) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      const proc = procByPid.get(childPid);
      const hit = classifyAgentProc(proc);
      if (hit) return hit;
      const grand = childrenByPpid.get(childPid);
      if (grand) next.push(...grand);
    }
    frontier = next;
  }

  // Fallback if tmux reports paneCmd directly while ps comm was truncated
  if (paneCmd === "agy" && root) {
    return { engine: "agy", pid: root.pid, etime: root.etime, commVer: "" };
  }
  if (EXACT_VER_CMD_RE.test(paneCmd) && root) {
    return { engine: "cc", pid: root.pid, etime: root.etime, commVer: paneCmd };
  }
  return null;
}

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) || {};
    }
  } catch {}
  return {};
}

function writeJsonSafe0600(filePath, data) {
  try {
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch {}
}

function findBinary(name, homeDir, envPath) {
  const candidates = [];
  if (homeDir) {
    candidates.push(path.join(homeDir, ".local", "bin", name));
  }
  for (const dir of String(envPath || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, name));
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return "";
}

/**
 * Resolve the latest installed `agy` and `claude` versions on disk using mtime+size caching
 * and symlink target inspection (`<1ms` on cache hit).
 * @param {object} [opts]
 * @returns {{ agy: string, cc: string }}
 */
function resolveLatestDiskVersions(opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const envPath = opts.envPath ?? process.env.PATH ?? "";
  const execFn = opts.execFileSync || cp.execFileSync;
  const cacheFile =
    opts.diskCacheFile || path.join(os.tmpdir(), `agy-hud-disk-vers-${process.getuid?.() ?? 0}.json`);

  const cache = readJsonSafe(cacheFile);
  let dirty = false;

  // 1. Latest AGY version on disk
  let latestAgy = "";
  const agyBin = opts.agyBin ?? findBinary("agy", homeDir, envPath);
  if (agyBin) {
    try {
      const st = fs.statSync(agyBin);
      const sig = `${Math.trunc(st.mtimeMs)}:${st.size}`;
      if (cache.agySig === sig && SAFE_VER_RE.test(cache.agyVer || "")) {
        latestAgy = cache.agyVer;
      } else {
        const out = String(
          execFn(agyBin, ["--version"], {
            encoding: "utf8",
            timeout: 1500,
            stdio: ["ignore", "pipe", "ignore"]
          }) || ""
        ).trim();
        const m = out.match(/(\d+\.\d+\.\d+[0-9A-Za-z._+-]*)/);
        if (m) {
          latestAgy = m[1];
          cache.agySig = sig;
          cache.agyVer = latestAgy;
          dirty = true;
        }
      }
    } catch {}
  }

  // 2. Latest Claude Code version on disk (prefer instant symlink target `~/.local/share/claude/versions/X.Y.Z`)
  let latestCc = "";
  const claudeBin = opts.claudeBin ?? findBinary("claude", homeDir, envPath);
  if (claudeBin) {
    try {
      const real = fs.realpathSync(claudeBin);
      const base = path.basename(real);
      if (EXACT_VER_CMD_RE.test(base)) {
        latestCc = base;
      } else {
        const st = fs.statSync(real);
        const sig = `${Math.trunc(st.mtimeMs)}:${st.size}`;
        if (cache.ccSig === sig && SAFE_VER_RE.test(cache.ccVer || "")) {
          latestCc = cache.ccVer;
        } else {
          const out = String(
            execFn(claudeBin, ["--version"], {
              encoding: "utf8",
              timeout: 1500,
              stdio: ["ignore", "pipe", "ignore"]
            }) || ""
          ).trim();
          const m = out.match(/(\d+\.\d+\.\d+)/);
          if (m) {
            latestCc = m[1];
            cache.ccSig = sig;
            cache.ccVer = latestCc;
            dirty = true;
          }
        }
      }
    } catch {}
  }

  if (dirty) {
    writeJsonSafe0600(cacheFile, cache);
  }
  return { agy: latestAgy, cc: latestCc };
}

/**
 * Read the first 1KB of an open `agy` CLI log file to extract `Language server version: X.Y.Z`.
 * @param {string} logPath
 * @returns {string}
 */
function parseVersionFromAgyLog(logPath) {
  if (!logPath) return "";
  let fd;
  try {
    fd = fs.openSync(logPath, "r");
    const buf = Buffer.alloc(1024);
    const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    const m = head.match(/Language server version:\s*([0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z._+-]*)/);
    return m ? m[1] : "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Resolve the running version of an `agy` or `claude` PID using PID caching and `lsof` log inspection.
 * @param {{ engine: "agy"|"cc", pid: number, commVer: string }} agent
 * @param {string} paneAgentVer
 * @param {object} pidCache
 * @param {object} [opts]
 * @returns {string}
 */
function resolveRunningAgentVersion(agent, paneAgentVer, pidCache, opts = {}) {
  if (!agent) return "";
  if (agent.commVer && SAFE_VER_RE.test(agent.commVer)) {
    return agent.commVer;
  }
  const key = `${agent.engine}:${agent.pid}`;
  if (pidCache[key] && SAFE_VER_RE.test(pidCache[key])) {
    return pidCache[key];
  }

  const execFn = opts.execFileSync || cp.execFileSync;
  if (agent.engine === "agy") {
    try {
      const lsofOut = String(
        execFn("lsof", ["-p", String(agent.pid), "-Fn"], {
          encoding: "utf8",
          timeout: 400,
          stdio: ["ignore", "pipe", "ignore"]
        }) || ""
      );
      for (const line of lsofOut.split(/\r?\n/)) {
        if (!line.startsWith("n")) continue;
        const filePath = line.slice(1).trim();
        if (/\/log\/cli-[^/]+\.log$/.test(filePath)) {
          const ver = parseVersionFromAgyLog(filePath);
          if (ver) {
            pidCache[key] = ver;
            return ver;
          }
        }
      }
    } catch {}
    if (paneAgentVer && SAFE_VER_RE.test(paneAgentVer)) {
      pidCache[key] = paneAgentVer;
      return paneAgentVer;
    }
    return "";
  }

  if (agent.engine === "cc") {
    try {
      const lsofOut = String(
        execFn("lsof", ["-p", String(agent.pid), "-Fn"], {
          encoding: "utf8",
          timeout: 400,
          stdio: ["ignore", "pipe", "ignore"]
        }) || ""
      );
      for (const line of lsofOut.split(/\r?\n/)) {
        if (!line.startsWith("n")) continue;
        const m = line.slice(1).trim().match(/\/versions\/(\d+\.\d+\.\d+)$/);
        if (m) {
          pidCache[key] = m[1];
          return m[1];
        }
      }
    } catch {}
  }
  return "";
}

/**
 * Determine whether a pane's title indicates the agent is actively working (`●` or `🏃`).
 * @param {string} paneTitle
 * @returns {boolean}
 */
function isPaneWorking(paneTitle) {
  const t = String(paneTitle ?? "").trim();
  return t.startsWith("●") || t.startsWith("🏃");
}

/**
 * Execute a single-pass scan of all `tmux` panes and windows, synchronize changed `@` options,
 * and return the formatted global fleet status string for `status-right`.
 * @param {object} [opts]
 * @returns {string}
 */
function collectAndSyncTmux(opts = {}) {
  const execFn = opts.execFileSync || cp.execFileSync;
  const pidCacheFile =
    opts.pidCacheFile || path.join(os.tmpdir(), `agy-hud-pid-vers-${process.getuid?.() ?? 0}.json`);

  let panesRaw = "";
  let windowsRaw = "";
  let psRaw = "";
  try {
    panesRaw = String(
      execFn(
        "tmux",
        [
          "list-panes",
          "-a",
          "-F",
          "#{pane_id}\t#{window_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}\t#{@agent_ver}\t#{@agent_ver_badge}\t#{@agent_bar_ver}\t#{@agent_uptime}\t#{@agent_outdated}"
        ],
        { encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] }
      ) || ""
    );
    windowsRaw = String(
      execFn(
        "tmux",
        ["list-windows", "-a", "-F", "#{window_id}\t#{@win_outdated}\t#{@fleet_summary}"],
        {
          encoding: "utf8",
          timeout: 500,
          stdio: ["ignore", "pipe", "ignore"]
        }
      ) || ""
    );
    psRaw = String(
      execFn("ps", ["-axo", "pid=,ppid=,etime=,comm="], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"]
      }) || ""
    );
  } catch {
    return "";
  }

  const { procByPid, childrenByPpid } = parsePsTable(psRaw);
  const latest = opts.latestVersions || resolveLatestDiskVersions(opts);
  const oldPidCache = readJsonSafe(pidCacheFile);
  const nextPidCache = {};
  for (const [k, v] of Object.entries(oldPidCache)) {
    const m = k.match(/^(agy|cc):(\d+)$/);
    if (m && procByPid.has(Number(m[2]))) {
      nextPidCache[k] = v;
    }
  }

  const tmuxArgs = [];
  const winOutdatedTarget = new Map();
  let totalAgents = 0;
  let workingAgents = 0;
  let outdatedAgy = 0;
  let outdatedCc = 0;

  for (const line of panesRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const [
      paneId,
      windowId,
      panePidStr,
      paneCmd = "",
      paneTitle = "",
      curAgentVer = "",
      curVerBadge = "",
      curBarVer = "",
      curUptime = "",
      curOutdated = ""
    ] = fields;
    if (!paneId || !windowId) continue;
    if (!winOutdatedTarget.has(windowId)) {
      winOutdatedTarget.set(windowId, false);
    }

    const agent = findPaneAgent(Number(panePidStr), paneCmd.trim(), procByPid, childrenByPpid);
    if (!agent) {
      if (curVerBadge !== "" || curBarVer !== "" || curUptime !== "" || curOutdated === "1") {
        appendTmuxCmd(tmuxArgs, ["set-option", "-p", "-t", paneId, "@agent_ver_badge", ""]);
        appendTmuxCmd(tmuxArgs, ["set-option", "-p", "-t", paneId, "@agent_bar_ver", ""]);
        appendTmuxCmd(tmuxArgs, ["set-option", "-p", "-t", paneId, "@agent_uptime", ""]);
        appendTmuxCmd(tmuxArgs, ["set-option", "-p", "-t", paneId, "@agent_outdated", "0"]);
      }
      continue;
    }

    totalAgents += 1;
    if (isPaneWorking(paneTitle)) {
      workingAgents += 1;
    }

    const runningVer = resolveRunningAgentVersion(agent, curAgentVer.trim(), nextPidCache, opts);
    const latestVer = agent.engine === "agy" ? latest.agy : latest.cc;
    const isOutdated =
      Boolean(runningVer && latestVer) && compareSemver(runningVer, latestVer) === -1;

    if (isOutdated) {
      winOutdatedTarget.set(windowId, true);
      if (agent.engine === "agy") outdatedAgy += 1;
      else outdatedCc += 1;
    }

    const uptime = formatEtime(agent.etime);
    let verBadge = agent.engine;
    let barVer = agent.engine;
    if (runningVer) {
      if (isOutdated) {
        verBadge = `${agent.engine} ${runningVer} → ${latestVer} ⬆`;
        barVer = `${agent.engine} ${runningVer}→${latestVer}⬆`;
      } else {
        verBadge = `${agent.engine} ${runningVer} ✓`;
        barVer = `${agent.engine} ${runningVer}✓`;
      }
    }
    const outdatedStr = isOutdated ? "1" : "0";

    if (curVerBadge !== verBadge) {
      appendTmuxCmd(tmuxArgs, ["set-option", "-p", "-t", paneId, "@agent_ver_badge", verBadge]);
    }
    if (curBarVer !== barVer) {
      appendTmuxCmd(tmuxArgs, ["set-option", "-p", "-t", paneId, "@agent_bar_ver", barVer]);
    }
    if (curUptime !== uptime) {
      appendTmuxCmd(tmuxArgs, ["set-option", "-p", "-t", paneId, "@agent_uptime", uptime]);
    }
    if (curOutdated !== outdatedStr) {
      appendTmuxCmd(tmuxArgs, ["set-option", "-p", "-t", paneId, "@agent_outdated", outdatedStr]);
    }
  }

  let curFleetSummary = null;
  for (const line of windowsRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [windowId, curWinOutdated = "", fleetSum = ""] = line.split("\t");
    if (curFleetSummary === null) {
      curFleetSummary = fleetSum;
    }
    if (!windowId || !winOutdatedTarget.has(windowId)) continue;
    const desired = winOutdatedTarget.get(windowId) ? "1" : "0";
    if (curWinOutdated.trim() !== desired) {
      appendTmuxCmd(tmuxArgs, ["set-option", "-w", "-t", windowId, "@win_outdated", desired]);
    }
  }

  let summary = "";
  if (totalAgents > 0) {
    const activePart = `#[fg=#a6e3a1]●${workingAgents}#[fg=#6c7086]/${totalAgents}#[default]`;
    const outdatedParts = [];
    if (outdatedAgy > 0) outdatedParts.push(`${outdatedAgy} agy`);
    if (outdatedCc > 0) outdatedParts.push(`${outdatedCc} cc`);
    if (outdatedParts.length > 0) {
      summary = `${activePart} #[fg=#f9e2af]#[bold]⬆ ${outdatedParts.join(" · ")}#[default]`;
    } else {
      summary = `${activePart} #[fg=#a6e3a1]✓#[default]`;
    }
  }

  if (curFleetSummary !== summary) {
    appendTmuxCmd(tmuxArgs, ["set-option", "-g", "@fleet_summary", summary]);
  }

  if (tmuxArgs.length > 0) {
    try {
      execFn("tmux", tmuxArgs, { timeout: 500, stdio: "ignore" });
    } catch {}
  }

  if (JSON.stringify(nextPidCache) !== JSON.stringify(oldPidCache)) {
    writeJsonSafe0600(pidCacheFile, nextPidCache);
  }

  return summary;
}

function appendTmuxCmd(tmuxArgs, cmdTokens) {
  if (tmuxArgs.length > 0) {
    tmuxArgs.push(";");
  }
  tmuxArgs.push(...cmdTokens);
}

module.exports = {
  compareSemver,
  formatEtime,
  parsePsTable,
  findPaneAgent,
  resolveLatestDiskVersions,
  parseVersionFromAgyLog,
  resolveRunningAgentVersion,
  collectAndSyncTmux
};
