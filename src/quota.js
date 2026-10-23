"use strict";

/**
 * @file quota.js
 * @description
 * Quota cache loading, model matching, dual-window official quota parsing (`5h` & `Week`),
 * and fresh cache merging.
 */

const fs = require("node:fs");

/**
 * Load a JSON quota cache file from disk.
 * @param {string} cachePath
 * @returns {[object|null, boolean]}
 */
function load(cachePath) {
  let raw;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return [null, false];
  }
  try {
    const cache = JSON.parse(raw);
    if (!cache || typeof cache !== "object") {
      return [null, false];
    }
    if (cache.models === null || typeof cache.models !== "object") {
      cache.models = {};
    }
    return [cache, true];
  } catch {
    return [null, false];
  }
}

/**
 * Match a display model name against cached model quota entries.
 * @param {object|null} cache
 * @param {string} model
 * @returns {[object|null, boolean]}
 */
function matchModel(cache, model) {
  if (!cache || !cache.models) {
    return [null, false];
  }
  if (Object.prototype.hasOwnProperty.call(cache.models, model)) {
    return [cache.models[model], true];
  }
  const needle = normalize(model);
  if (!needle) {
    return [null, false];
  }
  for (const [label, quota] of Object.entries(cache.models)) {
    const haystack = normalize(label);
    if (haystack && (haystack.includes(needle) || needle.includes(haystack))) {
      return [quota, true];
    }
  }
  return [null, false];
}

/**
 * Convert a `remainingFraction` (0..1) into an integer consumed percentage (0..100).
 * @param {{remainingFraction: number}} quota
 * @returns {number}
 */
function usagePercent(quota) {
  let remaining = Number(quota?.remainingFraction ?? 1);
  if (!Number.isFinite(remaining)) remaining = 1;
  if (remaining < 0) remaining = 0;
  if (remaining > 1) remaining = 1;
  return Math.trunc((1 - remaining) * 100 + 0.5);
}

/**
 * Normalize a model name for fuzzy lookup.
 * @param {string} input
 * @returns {string}
 */
function normalize(input) {
  let out = String(input ?? "").toLowerCase();
  for (const old of ["gemini", "(", ")", "-", "_"]) {
    out = out.split(old).join(" ");
  }
  return out
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

module.exports = {
  load,
  matchModel,
  usagePercent,
  normalize
};
