"use strict";

/**
 * @file host.js
 * @description
 * Portable Host Machine (`MacMini` vs `Laptop` vs custom host) and Connection Mode (`Local` vs `SSH`) detector.
 * Works identically across shared dotfiles/configs on multiple machines:
 * 1. Hardware detection via `sysctl -n hw.model`, `os.hostname()`, and `pmset -g batt`.
 * 2. Connection mode detection across 3 layers:
 *    - Layer 1: `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`, `P9K_SSH` environment variables.
 *    - Layer 2: Parent process tree (`PPID` walk up to PID 1) checking for `sshd` / `sshd-session`.
 *    - Layer 3: Active `tmux` client (`#{client_pid}`) ancestor tree check when running inside `tmux`.
 */

const os = require("node:os");
const cp = require("node:child_process");

/**
 * Default system runtime used by `getHostAndMode`. Can be overridden in tests.
 * @returns {object}
 */
function defaultHostRuntime() {
  return {
    env: process.env,
    platform: process.platform,
    pid: process.pid,
    hostname: () => os.hostname(),
    sysctlModel: () =>
      cp.execFileSync("sysctl", ["-n", "hw.model"], {
        encoding: "utf8",
        timeout: 200,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim(),
    pmsetBatt: () =>
      cp.execFileSync("pmset", ["-g", "batt"], {
        encoding: "utf8",
        timeout: 200,
        stdio: ["ignore", "pipe", "ignore"]
      }),
    psTree: () =>
      cp.execFileSync("ps", ["-axo", "pid=,ppid=,comm="], {
        encoding: "utf8",
        timeout: 200,
        stdio: ["ignore", "pipe", "ignore"]
      }),
    tmuxClientPid: () =>
      Number(
        cp.execFileSync("tmux", ["display-message", "-p", "#{client_pid}"], {
          encoding: "utf8",
          timeout: 200,
          stdio: ["ignore", "pipe", "ignore"]
        }).trim()
      )
  };
}

/**
 * Parse `ps -axo pid=,ppid=,comm=` output into a PID -> { ppid, comm } Map.
 * @param {string} psOut
 * @returns {Map<number, {ppid: number, comm: string}>}
 */
function parsePsTree(psOut) {
  const map = new Map();
  if (typeof psOut !== "string") return map;
  for (const line of psOut.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) {
      map.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
    }
  }
  return map;
}

/**
 * Walk up the process tree from `startPid` to PID 1 and return true if any ancestor is `sshd`.
 * @param {Map<number, {ppid: number, comm: string}>} psMap
 * @param {number} startPid
 * @returns {boolean}
 */
function hasSshdAncestor(psMap, startPid) {
  let cur = startPid;
  const seen = new Set();
  while (cur && cur > 1 && !seen.has(cur)) {
    seen.add(cur);
    const info = psMap.get(cur);
    if (!info) break;
    if (/sshd/i.test(info.comm)) return true;
    cur = info.ppid;
  }
  return false;
}

/**
 * Detect machine label (`MacMini`, `Laptop`, or hostname) and connection mode (`Local` vs `SSH`).
 * @param {object} [rt]
 * @returns {{machine: string, mode: "SSH"|"Local", isSsh: boolean, hwModel: string, rawHost: string}}
 */
function getHostAndMode(rt = defaultHostRuntime()) {
  const env = rt.env ?? process.env;
  let hwModel = "";
  try {
    hwModel = rt.sysctlModel() || "";
  } catch {}

  let rawHost = "Host";
  try {
    rawHost = (rt.hostname() || "Host").replace(/\.local$/i, "");
  } catch {}

  let machine = (env.AGY_HOST_LABEL || "").trim();
  if (!machine) {
    if (
      /^Macmini/i.test(hwModel) ||
      /^(Mac14,3|Mac14,12|Mac16,10|Mac16,11)$/.test(hwModel) ||
      /macmini|ryan-lab/i.test(rawHost)
    ) {
      machine = "MacMini";
    } else if (/^MacBook/i.test(hwModel)) {
      machine = "Laptop";
    } else if (rt.platform === "darwin") {
      try {
        const batt = rt.pmsetBatt() || "";
        machine = batt.includes("InternalBattery") ? "Laptop" : rawHost;
      } catch {
        machine = rawHost;
      }
    } else {
      machine = rawHost || "Host";
    }
  }

  let isSsh = Boolean(
    env.SSH_CONNECTION ||
      env.SSH_CLIENT ||
      env.SSH_TTY ||
      env.P9K_SSH === "1"
  );

  try {
    const psMap = parsePsTree(rt.psTree());
    if (psMap.size > 0) {
      if (env.TMUX) {
        try {
          const clientPid = rt.tmuxClientPid();
          if (Number.isFinite(clientPid) && clientPid > 0 && psMap.has(clientPid)) {
            isSsh = hasSshdAncestor(psMap, clientPid);
          }
        } catch {}
      } else if (!isSsh) {
        isSsh = hasSshdAncestor(psMap, rt.pid);
      }
    }
  } catch {}

  return {
    machine,
    mode: isSsh ? "SSH" : "Local",
    isSsh,
    hwModel,
    rawHost
  };
}

module.exports = {
  defaultHostRuntime,
  parsePsTree,
  hasSshdAncestor,
  getHostAndMode
};
