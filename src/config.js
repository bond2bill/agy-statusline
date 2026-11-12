"use strict";

/**
 * @file config.js
 * @description Configuration loading, path resolution, and schema normalization for agy-statusline.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Return the default HUD configuration object.
 * @returns {object}
 */
function defaultConfig() {
  return {
    showModel: true,
    showProgressBar: true,
    multiline: true,
    color: true,
    showGitBranch: true,
    showCWD: true,
    showAgentState: true,
    showIcons: true,
    showSession: true,
    showConversationId: true,
    showConversationSize: true,
    showHost: true,
    contextValue: "percent",
    usageValue: "remaining",
    debug: false
  };
}

/**
 * Merge a partial user JSON config into a base configuration object.
 * @param {object} base
 * @param {object} patch
 * @returns {object}
 */
function merge(base, patch) {
  if (!patch || typeof patch !== "object") {
    return base;
  }
  if (typeof patch.show_model === "boolean") base.showModel = patch.show_model;
  if (typeof patch.show_progress_bar === "boolean") base.showProgressBar = patch.show_progress_bar;
  if (typeof patch.multiline === "boolean") base.multiline = patch.multiline;
  if (typeof patch.color === "boolean") base.color = patch.color;
  if (typeof patch.show_git_branch === "boolean") base.showGitBranch = patch.show_git_branch;
  if (typeof patch.show_cwd === "boolean") base.showCWD = patch.show_cwd;
  if (typeof patch.show_agent_state === "boolean") base.showAgentState = patch.show_agent_state;
  if (typeof patch.show_icons === "boolean") base.showIcons = patch.show_icons;
  if (typeof patch.show_session === "boolean") base.showSession = patch.show_session;
  if (typeof patch.show_conversation_id === "boolean") {
    base.showConversationId = patch.show_conversation_id;
  }
  if (typeof patch.show_conversation_size === "boolean") {
    base.showConversationSize = patch.show_conversation_size;
  }
  if (typeof patch.show_host === "boolean") base.showHost = patch.show_host;
  if (typeof patch.context_value === "string" && patch.context_value !== "") {
    base.contextValue = patch.context_value;
  }
  if (typeof patch.usage_value === "string" && patch.usage_value !== "") {
    base.usageValue = patch.usage_value;
  }
  if (typeof patch.debug === "boolean") base.debug = patch.debug;
  return base;
}

/**
 * Load configuration from the first readable file in `paths`.
 * @param {string[]} paths
 * @returns {object}
 */
function loadFromPaths(paths) {
  for (const configPath of paths) {
    let raw;
    try {
      raw = fs.readFileSync(configPath, "utf8");
    } catch {
      continue;
    }
    try {
      return merge(defaultConfig(), JSON.parse(raw));
    } catch {
      return defaultConfig();
    }
  }
  return defaultConfig();
}

/**
 * Return ordered candidate paths for `config.json`.
 * @param {string} [baseDir]
 * @returns {string[]}
 */
function configPaths(baseDir = __dirname) {
  const paths = [];
  const explicit = process.env.AGY_HUD_CONFIG;
  if (explicit) {
    paths.push(explicit);
  }
  paths.push(path.join(baseDir, "config.json"));
  paths.push(path.join(baseDir, "..", "config.json"));
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    paths.push(path.join(xdg, "agy-hud", "config.json"));
  }
  const home = os.homedir();
  if (home) {
    paths.push(path.join(home, ".config", "agy-hud", "config.json"));
  }
  return paths;
}

module.exports = {
  defaultConfig,
  merge,
  loadFromPaths,
  configPaths
};
