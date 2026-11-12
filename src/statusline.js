"use strict";

/**
 * @file statusline.js
 * @description
 * Terminal HUD renderer for Antigravity CLI (`agy`).
 * Renders host & connection badge (`MacMini·SSH`, `MacMini·Local`, `Laptop·Local`),
 * model & plan tier, session title, working directory, git branch, agent state,
 * context window bar, and dual-window (`5h` & `Week`) quota usage.
 */

const path = require("node:path");
const {
  colorBlue,
  colorGreen,
  colorYellow,
  colorCyan,
  colorMagenta,
  colorRed,
  colorOrange,
  colorMuted,
  strip,
  visibleLen,
  colorize
} = require("./ansi");
const { matchModel, usagePercent } = require("./quota");
const { truncate } = require("./session");

function shortModelName(display) {
  let short = String(display ?? "");
  short = short.split("Gemini").join("");
  short = short.split("Claude").join("");
  short = short.split("Thinking").join("");
  short = short.split("(").join("");
  short = short.split(")").join("");
  short = short.split("Medium").join("Med");
  short = short.trim().split(/\s+/).filter(Boolean).join(" ");
  const runes = Array.from(short);
  if (runes.length > 18) {
    short = `${runes.slice(0, 15).join("")}...`;
  }
  return short;
}

function withIcon(config, icon, fallback) {
  return config.showIcons ? icon : fallback;
}

function renderSessionSegment(title, config) {
  return `${withIcon(config, "\uF4A4 ", "")}${title}`;
}

function renderConvSegment(convInfo, config, useShortId = false) {
  if (!convInfo || typeof convInfo !== "object") return "";
  const showId = config.showConversationId !== false && Boolean(convInfo.id);
  const showSize = config.showConversationSize !== false && Boolean(convInfo.sizeText);
  if (!showId && !showSize) return "";
  const idText = showId ? (useShortId ? convInfo.shortId || convInfo.id : convInfo.id) : "";
  if (idText && showSize) {
    return `${withIcon(config, "\uF292 ", "#")}${idText} (${convInfo.sizeText})`;
  }
  if (idText) {
    return `${withIcon(config, "\uF292 ", "#")}${idText}`;
  }
  return `${withIcon(config, "\uF0A0 ", "")}${convInfo.sizeText}`;
}

function renderHostSegment(hostInfo, config) {
  if (!hostInfo || !hostInfo.machine) return "";
  const icon =
    hostInfo.machine === "Laptop"
      ? "\uF109 "
      : hostInfo.isSsh
        ? "\uF233 "
        : "\uF108 ";
  return `${withIcon(config, icon, "")}${hostInfo.machine}\xB7${hostInfo.mode}`;
}

function renderVersionSegment(rawVersion, config) {
  if (config.showVersion === false) return "";
  const clean = String(rawVersion ?? "").trim().replace(/^v/i, "");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z._+-]*$/.test(clean)) return "";
  return `v${clean}`;
}

function renderModelSegment(shortModel, rawPlan, config) {
  let plan = "Plan ?";
  if (rawPlan) {
    if (/ultra/i.test(rawPlan)) {
      plan = "Ultra";
    } else if (/pro/i.test(rawPlan)) {
      plan = "Pro";
    } else if (/free/i.test(rawPlan)) {
      plan = "Free";
    } else if (/enterprise/i.test(rawPlan)) {
      plan = "Enterprise";
    } else {
      plan = rawPlan.replace(/^Google\s+AI\s+/i, "").trim() || rawPlan;
    }
  }
  if (config.showModel && shortModel !== "") {
    return `${withIcon(config, "\uEE9C ", "")}${shortModel} | ${renderPlan(plan, config)}`;
  }
  if (plan === "Ultra" || plan === "Pro") {
    return `${withIcon(config, "\uEE9C ", "")}${renderPlan(plan, config)} Tier`;
  }
  return `${withIcon(config, "\uEE9C ", "")}${plan}`;
}

function renderPlan(plan, config) {
  if (plan === "Ultra") {
    return `${withIcon(config, "\uF0A3 ", "")}Ultra`;
  }
  if (plan === "Pro") {
    return `${withIcon(config, "\uF0A3 ", "")}Pro`;
  }
  return plan;
}

function renderGitSegment(branchName, config) {
  if (branchName === "git") {
    return `${withIcon(config, "\uE725 ", "")}git`;
  }
  return `${withIcon(config, "\uE725 ", "")}${branchName}`;
}

function resetSuffix(config, reset) {
  return ` ${withIcon(config, "\u21BB ", "")}Reset ${reset}`;
}

function inlineResetSuffix(config, reset) {
  if (reset === "") {
    return "";
  }
  return ` (${withIcon(config, "\u21BB ", "")}${reset})`;
}

function render(payload, opts) {
  const config = opts.config;
  const width = (payload.terminal_width ?? 0) <= 0 ? 80 : payload.terminal_width;
  const modelDisplay = payload.model?.display_name || payload.model?.id || "Gemini";
  const modelSegment = renderModelSegment(
    shortModelName(modelDisplay),
    payload.plan_tier ?? "",
    config
  );
  const ctxPct = contextPercent(payload.context_window);
  const stateLabel = state(payload.agent_state ?? "");
  const quota = quotaInfo(
    opts.quota,
    modelDisplay,
    payload.quota,
    opts.now ?? new Date()
  );
  const sessionTitle = opts.sessionTitle ?? "";
  const hostInfo = opts.hostInfo ?? null;
  const convInfo = opts.convInfo ?? null;
  if (config.multiline) {
    return renderMultiline(
      payload,
      config,
      width,
      modelSegment,
      ctxPct,
      quota,
      opts.gitBranch ?? "",
      stateLabel,
      sessionTitle,
      hostInfo,
      convInfo
    );
  }
  return renderSingleLine(
    payload,
    config,
    width,
    modelSegment,
    ctxPct,
    quota,
    stateLabel,
    sessionTitle,
    hostInfo,
    convInfo
  );
}

function renderMultiline(
  payload,
  config,
  width,
  modelSegment,
  ctxPct,
  quota,
  branchName,
  stateLabel,
  sessionTitle = "",
  hostInfo = null,
  convInfo = null
) {
  const hostText =
    config.showHost && hostInfo
      ? colorize(
          renderHostSegment(hostInfo, config),
          hostInfo.isSsh ? colorOrange : colorGreen,
          config.color
        )
      : "";
  const verRaw = renderVersionSegment(payload.version, config);
  const verText = verRaw ? colorize(verRaw, colorMagenta, config.color) : "";
  const convFullRaw = renderConvSegment(convInfo, config, false);
  const convShortRaw = renderConvSegment(convInfo, config, true);
  const convFullText = convFullRaw ? colorize(convFullRaw, colorMuted, config.color) : "";
  const convShortText = convShortRaw ? colorize(convShortRaw, colorMuted, config.color) : "";
  const modelText = colorize(modelSegment, colorBlue, config.color);
  const cwdText =
    config.showCWD && payload.cwd
      ? colorize(
          withIcon(config, "\uF07C ", "") + path.basename(payload.cwd),
          colorYellow,
          config.color
        )
      : "";
  const gitText =
    config.showGitBranch && branchName !== ""
      ? colorize(renderGitSegment(branchName, config), colorMagenta, config.color)
      : "";
  const stateText = config.showAgentState
    ? colorize(stateLabel, stateColor(stateLabel), config.color)
    : "";

  const sessionFullText =
    config.showSession && sessionTitle !== ""
      ? colorize(renderSessionSegment(sessionTitle, config), colorCyan, config.color)
      : "";

  // Tier 0: Full layout with AGY version + full 36-char Conversation UUID + Size
  let line1 = joinHeader(
    hostText,
    verText,
    modelText,
    sessionFullText,
    convFullText,
    cwdText,
    gitText,
    stateText
  );

  // Tier 1: Step down Conversation UUID to 8-char short ID if full UUID exceeds width
  if (visibleLen(line1) > width && convShortText !== convFullText) {
    line1 = joinHeader(
      hostText,
      verText,
      modelText,
      sessionFullText,
      convShortText,
      cwdText,
      gitText,
      stateText
    );
  }

  // Tier 2: Truncate Session Title (20 chars) + keep AGY version + 8-char Conversation ID
  if (visibleLen(line1) > width && sessionFullText !== "") {
    const sess20 = colorize(
      renderSessionSegment(truncate(sessionTitle, 20), config),
      colorCyan,
      config.color
    );
    line1 = joinHeader(
      hostText,
      verText,
      modelText,
      sess20,
      convShortText,
      cwdText,
      gitText,
      stateText
    );
  }

  // Tier 3: Drop CWD, keep AGY version + 8-char Conversation ID + Git + Session (16 chars)
  if (visibleLen(line1) > width) {
    const sess16 =
      sessionFullText !== ""
        ? colorize(
            renderSessionSegment(truncate(sessionTitle, 16), config),
            colorCyan,
            config.color
          )
        : "";
    line1 = joinHeader(hostText, verText, modelText, sess16, convShortText, gitText, stateText);
  }

  // Tier 4: Drop Git, keep AGY version + 8-char Conversation ID + Session (14 chars)
  if (visibleLen(line1) > width && convShortText !== "") {
    const sess14 =
      sessionFullText !== ""
        ? colorize(
            renderSessionSegment(truncate(sessionTitle, 14), config),
            colorCyan,
            config.color
          )
        : "";
    line1 = joinHeader(hostText, verText, modelText, sess14, convShortText, stateText);
  }

  // Tier 5: Ultra-narrow fallbacks (drop Conversation ID, keep AGY version if possible)
  if (visibleLen(line1) > width) {
    const p = [];
    if (hostText) p.push(hostText);
    if (verText) p.push(verText);
    p.push(modelText);
    if (sessionFullText !== "") {
      p.push(
        colorize(
          renderSessionSegment(truncate(sessionTitle, 14), config),
          colorCyan,
          config.color
        )
      );
    }
    p.push(stateText);
    line1 = joinHeader(...p);
  }
  if (visibleLen(line1) > width) {
    if (config.showSession && sessionTitle !== "") {
      line1 = joinHeader(
        hostText,
        colorize(
          renderSessionSegment(truncate(sessionTitle, 12), config),
          colorCyan,
          config.color
        ),
        stateText
      );
    } else {
      line1 = joinHeader(hostText, colorize(modelSegment, colorBlue, config.color), stateText);
    }
  }
  if (visibleLen(line1) > width) {
    line1 = joinHeader(hostText, colorize(modelSegment, colorBlue, config.color));
  }
  line1 = fit(line1, width);

  let ctx = "Context ";
  if (config.showProgressBar) {
    ctx += `${progressBar(ctxPct, 10, config.color)} `;
  }
  ctx += contextValue(config, payload.context_window, ctxPct);

  let usage2 = "";
  if (quota.hasQuota) {
    usage2 = usageLabel(config, quota, true);
    if (quota.windows.length <= 1 && quota.reset !== "") {
      usage2 += resetSuffix(config, quota.reset);
    }
  }
  let line2 = joinHeader(ctx, usage2);
  if (visibleLen(line2) > width) {
    let usageNoBar = "";
    if (quota.hasQuota) {
      usageNoBar = usageLabel(config, quota, false);
      if (quota.windows.length <= 1 && quota.reset !== "") {
        usageNoBar += resetSuffix(config, quota.reset);
      }
    }
    line2 = joinHeader(
      `Context ${contextValue(config, payload.context_window, ctxPct)}`,
      usageNoBar
    );
  }
  if (visibleLen(line2) > width) {
    let usageCompact = "";
    if (quota.hasQuota) {
      usageCompact = usageLabel(config, quota, false);
      if (quota.windows.length <= 1 && quota.reset !== "") {
        usageCompact += resetSuffix(config, quota.reset);
      }
    }
    line2 = joinHeader(`Context ${formatInt(ctxPct)}%`, usageCompact);
  }
  if (visibleLen(line2) > width) {
    let coreUsage = "";
    if (quota.hasQuota) {
      coreUsage = `Use ${usageValue(config, quota.usagePct)}`;
    }
    line2 = join(`Ctx ${formatInt(ctxPct)}%`, coreUsage);
  }
  if (visibleLen(line2) > width) {
    line2 = `${formatInt(ctxPct)}%`;
  }
  line2 = fit(line2, width);
  return `${line1}\n${line2}`;
}

function renderSingleLine(
  payload,
  config,
  width,
  modelSegment,
  ctxPct,
  quota,
  stateLabel,
  sessionTitle = "",
  hostInfo = null,
  convInfo = null
) {
  const coloredHost =
    config.showHost && hostInfo
      ? colorize(
          renderHostSegment(hostInfo, config),
          hostInfo.isSsh ? colorOrange : colorGreen,
          config.color
        )
      : "";
  const coloredBadge = colorize(modelSegment, colorBlue, config.color);
  const verRaw = renderVersionSegment(payload.version, config);
  const coloredVer = verRaw ? colorize(verRaw, colorMagenta, config.color) : "";
  const coloredSession =
    config.showSession && sessionTitle
      ? colorize(renderSessionSegment(truncate(sessionTitle, 18), config), colorCyan, config.color)
      : "";
  const convFullRaw = renderConvSegment(convInfo, config, false);
  const convShortRaw = renderConvSegment(convInfo, config, true);
  const coloredConvFull = convFullRaw ? colorize(convFullRaw, colorMuted, config.color) : "";
  const coloredConvShort = convShortRaw ? colorize(convShortRaw, colorMuted, config.color) : "";
  const ctx = `Ctx ${contextValue(config, payload.context_window, ctxPct)}`;
  let tokens = tokenDetail(payload.context_window);
  if (tokens !== "" && config.contextValue === "percent") {
    tokens = colorize(tokens, colorMuted, config.color);
  } else {
    tokens = "";
  }
  let usage2 = "";
  if (quota.hasQuota) {
    let text = usageLabel(config, quota, false);
    if (quota.windows.length <= 1 && quota.reset !== "") {
      text += resetSuffix(config, quota.reset);
    }
    usage2 = colorize(text, colorMuted, config.color);
  }
  const stateText = config.showAgentState
    ? colorize(stateLabel, stateColor(stateLabel), config.color)
    : "";
  let bar = "";
  if (config.showProgressBar) {
    bar = progressBar(ctxPct, 10, config.color);
  }
  const levels = [];
  if (coloredSession) {
    if (coloredConvFull) {
      levels.push([coloredHost, coloredVer, coloredBadge, coloredSession, coloredConvFull, ctx, tokens, bar, usage2, stateText]);
    }
    if (coloredConvShort) {
      levels.push([coloredHost, coloredVer, coloredBadge, coloredSession, coloredConvShort, ctx, tokens, bar, usage2, stateText]);
      levels.push([coloredHost, coloredVer, coloredBadge, coloredSession, coloredConvShort, ctx, bar, usage2, stateText]);
      levels.push([coloredHost, coloredVer, coloredBadge, coloredSession, coloredConvShort, ctx, stateText]);
    }
    levels.push([coloredHost, coloredVer, coloredBadge, coloredSession, ctx, tokens, bar, usage2, stateText]);
    levels.push([coloredHost, coloredVer, coloredBadge, coloredSession, ctx, bar, usage2, stateText]);
    levels.push([coloredHost, coloredVer, coloredBadge, coloredSession, ctx, stateText]);
    levels.push([coloredHost, coloredSession, ctx, stateText]);
  }
  if (coloredConvFull) {
    levels.push([coloredHost, coloredVer, coloredBadge, coloredConvFull, ctx, tokens, bar, usage2, stateText]);
  }
  if (coloredConvShort) {
    levels.push([coloredHost, coloredVer, coloredBadge, coloredConvShort, ctx, bar, usage2, stateText]);
    levels.push([coloredHost, coloredVer, coloredBadge, coloredConvShort, ctx, stateText]);
  }
  levels.push(
    [coloredHost, coloredVer, coloredBadge, ctx, tokens, bar, usage2, stateText],
    [coloredHost, coloredVer, coloredBadge, ctx, bar, usage2, stateText],
    [coloredHost, coloredVer, coloredBadge, ctx, usage2, stateText],
    [coloredHost, coloredVer, coloredBadge, ctx, stateText],
    [coloredHost, ctx, stateText],
    [`${formatInt(ctxPct)}%`, stateLabel]
  );
  for (const parts of levels) {
    const validParts = parts.filter(Boolean);
    const line = join(...validParts);
    if (visibleLen(line) <= width) {
      return line;
    }
  }
  return fit(`${formatInt(ctxPct)}% ${stateLabel}`, width);
}

function quotaInfo(cache, modelDisplay, officialQuota, now) {
  const cacheInfo = cacheQuotaInfo(cache, modelDisplay);
  const official = officialQuotaInfo(officialQuota, modelDisplay);
  if (official !== null) {
    if (
      official.hasQuota &&
      cacheInfo !== null &&
      cacheInfo.hasQuota &&
      cacheIsFresh(cache, now)
    ) {
      return mergeFreshCacheQuota(official, cacheInfo);
    }
    return official;
  }
  if (cacheInfo !== null) {
    return cacheInfo;
  }
  return noQuota();
}

function cacheQuotaInfo(cache, modelDisplay) {
  const [quota, ok] = matchModel(cache, modelDisplay);
  if (!ok || quota === null) {
    return null;
  }
  const usagePct = usagePercent(quota);
  const reset = usagePct > 0 ? formatResetClock(quota.resetTime) : "";
  return quotaDisplay([{ label: "", usagePct, reset }]);
}

function cacheIsFresh(cache, now) {
  if (!cache?.timestamp) {
    return false;
  }
  const cacheTime = new Date(cache.timestamp);
  if (Number.isNaN(cacheTime.getTime())) {
    return false;
  }
  return now.getTime() - cacheTime.getTime() <= 5 * 60 * 1000;
}

function officialQuotaInfo(officialQuota, modelDisplay) {
  if (!officialQuota || typeof officialQuota !== "object") {
    return null;
  }
  const keys = officialQuotaKeys(modelDisplay);
  const buckets = [];
  let sawKnownBucket = false;
  for (const { key, label } of keys) {
    if (!Object.prototype.hasOwnProperty.call(officialQuota, key)) {
      continue;
    }
    sawKnownBucket = true;
    const bucket = officialQuota[key];
    if (bucket && Number.isFinite(bucket.remaining_fraction)) {
      const usagePct = usagePercent({
        remainingFraction: bucket.remaining_fraction ?? 1,
        resetTime: bucket.reset_time ?? ""
      });
      const reset = usagePct > 0 ? formatOfficialReset(bucket) : "";
      buckets.push({ label, usagePct, reset });
    }
  }
  if (buckets.length === 0) {
    return sawKnownBucket ? noQuota() : null;
  }
  return quotaDisplay(buckets);
}

function mergeFreshCacheQuota(official, cache) {
  if (!cache.hasQuota || cache.windows.length === 0) {
    return official;
  }
  const cacheWindow = cache.windows[0];
  const windows = official.windows.map((window) => {
    if (window.label !== "5h") {
      return window;
    }
    if (cacheWindow.usagePct <= window.usagePct) {
      return window;
    }
    return { ...window, usagePct: cacheWindow.usagePct, reset: cacheWindow.reset };
  });
  const hasFiveHourWindow = windows.some((window) => window.label === "5h");
  if (!hasFiveHourWindow && cacheWindow.usagePct > official.usagePct) {
    return cache;
  }
  return quotaDisplay(windows);
}

function quotaDisplay(windows) {
  let selected = windows[0] ?? { label: "", usagePct: 0, reset: "" };
  for (const window of windows.slice(1)) {
    if (window.usagePct > selected.usagePct) {
      selected = window;
    }
  }
  return {
    usagePct: selected.usagePct,
    reset: selected.reset,
    hasQuota: windows.length > 0,
    windows
  };
}

function noQuota() {
  return { usagePct: 0, reset: "", hasQuota: false, windows: [] };
}

function officialQuotaKeys(modelDisplay) {
  const normalized = String(modelDisplay ?? "").toLowerCase();
  const is3p =
    normalized.includes("claude") ||
    normalized.includes("gpt") ||
    normalized.includes("oss") ||
    normalized.includes("anthropic") ||
    normalized.includes("openai") ||
    normalized.includes("deepseek") ||
    normalized.includes("3p") ||
    normalized.includes("sonnet") ||
    normalized.includes("haiku") ||
    normalized.includes("opus") ||
    normalized.includes("codex") ||
    normalized.includes("o1") ||
    normalized.includes("o3") ||
    normalized.includes("qwen") ||
    normalized.includes("llama");
  if (is3p) {
    return [
      { key: "3p-5h", label: "5h" },
      { key: "3p-weekly", label: "Week" }
    ];
  }
  return [
    { key: "gemini-5h", label: "5h" },
    { key: "gemini-weekly", label: "Week" }
  ];
}

function formatResetClock(reset) {
  if (!reset) {
    return "";
  }
  const target = new Date(reset.replace("Z", "+00:00"));
  if (Number.isNaN(target.getTime())) {
    return "";
  }
  return `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
}

function formatOfficialReset(bucket) {
  if (Number.isFinite(bucket.reset_in_seconds) && (bucket.reset_in_seconds ?? 0) > 0) {
    return formatResetDuration(bucket.reset_in_seconds ?? 0);
  }
  return formatResetClock(bucket.reset_time ?? "");
}

function formatResetDuration(seconds) {
  if (seconds > 0 && seconds < 60) {
    return "<1m";
  }
  let totalMinutes = Math.max(0, Math.trunc(seconds / 60));
  const days = Math.trunc(totalMinutes / (24 * 60));
  totalMinutes -= days * 24 * 60;
  const hours = Math.trunc(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${formatInt(days)}d ${formatInt(hours)}h`;
  }
  if (hours > 0) {
    return `${formatInt(hours)}h ${formatInt(minutes)}m`;
  }
  return `${formatInt(minutes)}m`;
}

function contextValue(config, ctx, pct) {
  const tokens = tokenDetail(ctx);
  switch (config.contextValue) {
    case "tokens":
      if (tokens !== "") {
        return tokens.replace(/^\(/, "").replace(/\)$/, "");
      }
      break;
    case "both":
      if (tokens !== "") {
        return `${formatInt(pct)}% ${tokens}`;
      }
      break;
  }
  return `${formatInt(pct)}%`;
}

function contextPercent(ctx) {
  const inputTokens = ctx?.total_input_tokens ?? 0;
  const windowSize = ctx?.context_window_size ?? 0;
  if (
    Number.isFinite(inputTokens) &&
    Number.isFinite(windowSize) &&
    inputTokens > 0 &&
    windowSize > 0
  ) {
    return clampInt(Math.trunc((inputTokens / windowSize) * 100 + 0.5));
  }
  const upstream = ctx?.used_percentage ?? 0;
  if (!Number.isFinite(upstream)) {
    return 0;
  }
  return clampInt(Math.trunc(upstream + 0.5));
}

function usageLabel(config, quota, withBar) {
  if (quota.windows.length > 1) {
    return `Usage ${quota.windows
      .map((window) => usageWindowLabel(config, window, withBar))
      .join(" │ ")}`;
  }
  let label = "Usage ";
  if (withBar && config.showProgressBar) {
    label += `${usageBar(config, quota.usagePct)} `;
  }
  return label + usageValue(config, quota.usagePct);
}

function usageWindowLabel(config, window, withBar) {
  let label = window.label ? `${window.label}: ` : "";
  if (withBar && config.showProgressBar) {
    label += `${usageBar(config, window.usagePct, 10)} `;
  }
  return label + usageWindowValue(config, window.usagePct) + inlineResetSuffix(config, window.reset);
}

function usageWindowValue(config, usagePct) {
  if (config.usageValue === "remaining") {
    return `${formatInt(100 - usagePct)}%`;
  }
  return `${formatInt(usagePct)}%`;
}

function usageValue(config, usagePct) {
  if (config.usageValue === "remaining") {
    return `${formatInt(100 - usagePct)}% left`;
  }
  return `${formatInt(usagePct)}%`;
}

function usageBar(config, usagePct, width = 8) {
  const fillPct = config.usageValue === "remaining" ? 100 - usagePct : usagePct;
  return progressBarWithColor(fillPct, usagePct, width, config.color);
}

function tokenDetail(ctx) {
  const total = ctx?.total_input_tokens;
  const windowSize = ctx?.context_window_size ?? 0;
  if (typeof total !== "number" || total <= 0 || windowSize <= 0) {
    return "";
  }
  return `(${formatTokens(total)}/${formatTokens(windowSize)})`;
}

function formatTokens(n) {
  if (n >= 1e6) {
    if (n % 1e6 === 0) {
      return `${formatInt(n / 1e6)}M`;
    }
    return `${Number((n / 1e6).toFixed(1))}M`;
  }
  if (n >= 1e3) {
    return `${formatInt((n + 500) / 1e3)}k`;
  }
  return formatInt(n);
}

function progressBar(pct, width, color) {
  return progressBarWithColor(pct, pct, width, color);
}

function progressBarWithColor(fillPct, colorPct, width, color) {
  fillPct = clampInt(fillPct);
  colorPct = clampInt(colorPct);
  let filled = Math.trunc((fillPct / 100) * width + 0.5);
  if (filled < 0) filled = 0;
  if (filled > width) filled = width;
  const bar = `${"\u2588".repeat(filled)}${"\u2591".repeat(width - filled)}`;
  if (!color) {
    return bar;
  }
  return colorize(bar, percentageColor(colorPct), true);
}

function percentageColor(pct) {
  if (pct >= 90) return colorRed;
  if (pct >= 75) return colorOrange;
  if (pct >= 50) return colorYellow;
  return colorGreen;
}

function state(raw) {
  switch (String(raw ?? "").toLowerCase()) {
    case "":
    case "idle":
      return "Idle";
    case "thinking":
      return "Thinking";
    case "authenticating":
      return "Auth";
    default:
      return title(raw);
  }
}

function stateColor(label) {
  switch (label) {
    case "Idle":
      return colorGreen;
    case "Thinking":
      return colorYellow;
    case "Auth":
      return colorCyan;
    default:
      return colorCyan;
  }
}

function join(...parts) {
  return parts.filter((part) => part !== "").join("  ");
}

function joinHeader(...parts) {
  return parts.filter((part) => part !== "").join(" \u2502 ");
}

function fit(input, width) {
  if (width <= 0 || visibleLen(input) <= width) {
    return input;
  }
  return Array.from(strip(input)).slice(0, width).join("");
}

function clampInt(n) {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function formatInt(n) {
  return Math.trunc(n).toString(10);
}

function pad2(n) {
  if (n < 10) {
    return `0${formatInt(n)}`;
  }
  return formatInt(n);
}

function title(raw) {
  const fields = String(raw ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (let i = 0; i < fields.length; i++) {
    const runes = Array.from(fields[i].toLowerCase());
    if (runes.length > 0 && runes[0] >= "a" && runes[0] <= "z") {
      runes[0] = runes[0].toUpperCase();
    }
    fields[i] = runes.join("");
  }
  if (fields.length === 0) {
    return "Active";
  }
  return fields.join(" ");
}

module.exports = {
  shortModelName,
  renderSessionSegment,
  renderConvSegment,
  renderVersionSegment,
  renderHostSegment,
  renderModelSegment,
  renderGitSegment,
  render,
  renderMultiline,
  renderSingleLine,
  quotaInfo,
  officialQuotaKeys,
  formatResetDuration,
  contextPercent,
  formatTokens
};
