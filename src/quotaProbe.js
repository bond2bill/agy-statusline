"use strict";

/**
 * @file quotaProbe.js
 * @description
 * Local loopback quota probe for Antigravity (`agy` and `language_server`) via `GetUserStatus`.
 * Contacts only `127.0.0.1` and stores a sanitized quota cache with `0600` permissions.
 */

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const cp = require("node:child_process");

function parseLanguageServerInfo(psOutput) {
  for (const line of String(psOutput ?? "").split(/\r?\n/)) {
    if (!line.includes("language_server") || !line.includes("--csrf_token")) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    const pid = parts.length > 1 ? parts[1] : "";
    const tokenMatch = line.match(/--csrf_token\s+([a-zA-Z0-9-]+)/);
    if (pid !== "" && /^\d+$/.test(pid) && tokenMatch) {
      return { pid, csrfToken: tokenMatch[1] };
    }
  }
  return null;
}

function parseAgyServerInfos(psOutput) {
  const infos = [];
  for (const line of String(psOutput ?? "").split(/\r?\n/)) {
    if (!/(^|\s)(?:\/\S+\/)?agy(\s|$)/.test(line)) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    const pid = parts.length > 1 ? parts[1] : "";
    if (pid !== "" && /^\d+$/.test(pid)) {
      infos.push({ pid, csrfToken: "", kind: "agy" });
    }
  }
  return infos;
}

function parseListeningPorts(lsofOutput) {
  const ports = new Set();
  for (const line of String(lsofOutput ?? "").split(/\r?\n/)) {
    if (!line.includes("LISTEN")) {
      continue;
    }
    const match = line.match(/(?:127\.0\.0\.1|localhost|\*|\[::1\]):(\d+)\b/);
    if (match) {
      ports.add(Number(match[1]));
    }
  }
  return [...ports];
}

function buildQuotaCache(rawResponse, now) {
  if (!isRecord(rawResponse)) {
    return null;
  }
  const userStatus = asRecord(rawResponse.userStatus);
  const email =
    typeof userStatus.email === "string" ? maskEmail(userStatus.email) : "masked@email.com";
  const planStatus = asRecord(userStatus.planStatus);
  const planInfo = asRecord(planStatus.planInfo);
  const planName = typeof planInfo.planName === "string" ? planInfo.planName : "Free";
  const cascade = asRecord(userStatus.cascadeModelConfigData);
  const configs = Array.isArray(cascade.clientModelConfigs) ? cascade.clientModelConfigs : [];
  const models = {};
  for (const item of configs) {
    const model = asRecord(item);
    const label = typeof model.label === "string" ? model.label : "";
    const quotaInfo = asRecord(model.quotaInfo);
    if (label === "" || Object.keys(quotaInfo).length === 0) {
      continue;
    }
    const resetTime = typeof quotaInfo.resetTime === "string" ? quotaInfo.resetTime : "";
    const remainingFraction =
      typeof quotaInfo.remainingFraction === "number"
        ? quotaInfo.remainingFraction
        : resetTime === ""
          ? 1
          : 0;
    models[label] = { remainingFraction, resetTime };
  }
  if (Object.keys(models).length === 0) {
    return null;
  }
  const cache = {
    timestamp: now.toISOString().replace(".000Z", "Z"),
    email,
    plan_name: planName,
    models
  };
  const lines = [
    "=== QUOTA SUMMARY ===",
    `Plan: ${planName}`,
    `Cache Timestamp: ${cache.timestamp}`
  ];
  for (const [model, quota] of Object.entries(models)) {
    const usedPct = Math.trunc((1 - quota.remainingFraction) * 100 + 0.5);
    let line = `- ${model.padEnd(30, " ")} : Usage ${String(usedPct).padStart(3, " ")}%`;
    if (usedPct > 0 && quota.resetTime !== "") {
      line += ` | Reset ${quota.resetTime}`;
    }
    lines.push(line);
  }
  lines.push("=====================");
  return { cache, summary: lines.join("\n") };
}

async function refreshQuota(cachePath, runtime = defaultRuntime()) {
  const psOutput = runtime.ps();
  const languageServer = parseLanguageServerInfo(psOutput);
  const candidates = [
    ...parseAgyServerInfos(psOutput),
    ...(languageServer ? [languageServer] : [])
  ];
  if (candidates.length === 0) {
    return { ok: false, message: "No running language_server or agy quota server found." };
  }
  let rawResponse = null;
  let sawPort = false;
  for (const info of candidates) {
    let ports;
    try {
      ports = parseListeningPorts(runtime.lsof(info.pid));
    } catch {
      continue;
    }
    if (ports.length > 0) {
      sawPort = true;
    }
    for (const port of ports) {
      rawResponse = await runtime.request(port, info.csrfToken);
      if (rawResponse) {
        break;
      }
    }
    if (rawResponse) {
      break;
    }
  }
  if (!sawPort) {
    return { ok: false, message: "No listening ports found on quota server." };
  }
  if (!rawResponse) {
    return { ok: false, message: "Failed to query GetUserStatus from all identified ports." };
  }
  const built = buildQuotaCache(rawResponse, runtime.now());
  if (!built) {
    return { ok: false, message: "GetUserStatus returned malformed quota data." };
  }
  runtime.mkdir(path.dirname(cachePath));
  runtime.writeFile(cachePath, `${JSON.stringify(built.cache, null, 2)}\n`);
  return {
    ok: true,
    message: `Successfully cached processed quota data to ${cachePath}`,
    cachePath,
    summary: built.summary
  };
}

function defaultRuntime() {
  return {
    ps: () => cp.execFileSync("ps", ["aux"], { encoding: "utf8" }),
    lsof: (pid) =>
      cp.execFileSync("lsof", ["-nP", "-iTCP", "-a", "-p", pid], { encoding: "utf8" }),
    request: queryLanguageServer,
    now: () => new Date(),
    writeFile: (filePath, data) =>
      fs.writeFileSync(filePath, data, { encoding: "utf8", mode: 0o600 }),
    mkdir: (dirPath) => fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  };
}

async function queryLanguageServer(port, csrfToken) {
  const endpoint = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
  const headers = {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1"
  };
  if (csrfToken !== "") {
    headers["X-Codeium-Csrf-Token"] = csrfToken;
  }
  const httpsResult = await requestJson(https, {
    protocol: "https:",
    hostname: "127.0.0.1",
    port,
    path: endpoint,
    method: "POST",
    headers,
    rejectUnauthorized: false
  });
  if (httpsResult !== null) {
    return httpsResult;
  }
  return requestJson(http, {
    protocol: "http:",
    hostname: "127.0.0.1",
    port,
    path: endpoint,
    method: "POST",
    headers
  });
}

function requestJson(mod, options) {
  return new Promise((resolve) => {
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      );
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.write("{}");
    req.end();
  });
}

function maskEmail(email) {
  const at = email.indexOf("@");
  if (at < 0) {
    return "masked@email.com";
  }
  return `${email.slice(0, 3)}***${email.slice(at)}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

module.exports = {
  parseLanguageServerInfo,
  parseAgyServerInfos,
  parseListeningPorts,
  buildQuotaCache,
  refreshQuota,
  defaultRuntime,
  queryLanguageServer,
  maskEmail
};
