"use strict";

/**
 * @file gitinfo.js
 * @description Fast, zero-subprocess Git branch resolver reading `.git/HEAD` directly (supports worktrees & submodules).
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * Walk up to 8 parent directories from `cwd` to locate `.git/HEAD` and extract the branch name.
 * @param {string} cwd
 * @returns {string}
 */
function branch(cwd) {
  if (!cwd) {
    return "";
  }
  let dir;
  try {
    dir = path.resolve(cwd);
  } catch {
    dir = cwd;
  }
  for (let i = 0; i < 8; i++) {
    const raw = readHEAD(dir);
    if (raw !== null) {
      return parseHEAD(raw.trim());
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return "";
}

/**
 * Read `.git/HEAD` from a directory or follow a `.git` file `gitdir:` pointer.
 * @param {string} dir
 * @returns {string|null}
 */
function readHEAD(dir) {
  const gitPath = path.join(dir, ".git");
  let stat;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    try {
      return fs.readFileSync(path.join(gitPath, "HEAD"), "utf8");
    } catch {
      return null;
    }
  }
  let raw;
  try {
    raw = fs.readFileSync(gitPath, "utf8");
  } catch {
    return null;
  }
  let gitDir = parseGitDirFile(raw.trim());
  if (gitDir === "") {
    return null;
  }
  if (!path.isAbsolute(gitDir)) {
    gitDir = path.join(dir, gitDir);
  }
  try {
    return fs.readFileSync(path.join(gitDir, "HEAD"), "utf8");
  } catch {
    return null;
  }
}

function parseGitDirFile(raw) {
  if (!raw.startsWith("gitdir:")) {
    return "";
  }
  return raw.slice("gitdir:".length).trim();
}

function parseHEAD(head) {
  if (head.startsWith("ref:")) {
    const ref = head.slice("ref:".length).trim();
    if (ref.startsWith("refs/heads/")) {
      return ref.slice("refs/heads/".length);
    }
    return path.basename(ref);
  }
  if (head.length > 7) {
    return head.slice(0, 7);
  }
  return head;
}

/**
 * Validate and sanitize a branch string so control characters are never rendered.
 * @param {string} raw
 * @returns {string}
 */
function sanitizedBranch(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 80) {
    return "";
  }
  for (const char of trimmed) {
    const ok =
      (char >= "a" && char <= "z") ||
      (char >= "A" && char <= "Z") ||
      (char >= "0" && char <= "9") ||
      char === "/" ||
      char === "-" ||
      char === "_" ||
      char === ".";
    if (!ok) {
      return "";
    }
  }
  return trimmed;
}

function validGitCandidatePath(candidate) {
  if (typeof candidate !== "string") return false;
  const trimmed = candidate.trim();
  if (trimmed === "") {
    return false;
  }
  try {
    return fs.statSync(trimmed).isDirectory();
  } catch {
    return false;
  }
}

function gitBranchFromPayload(payload) {
  if (!payload) return "";
  const paths = [
    payload.workspace?.current_dir ?? "",
    payload.cwd ?? "",
    payload.vcs?.root ?? "",
    payload.workspace?.project_dir ?? ""
  ];
  for (const candidate of paths) {
    if (!validGitCandidatePath(candidate)) {
      continue;
    }
    const found = branch(candidate);
    if (found !== "") {
      return found;
    }
  }
  return "";
}

module.exports = {
  branch,
  readHEAD,
  parseGitDirFile,
  parseHEAD,
  sanitizedBranch,
  validGitCandidatePath,
  gitBranchFromPayload
};
