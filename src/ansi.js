"use strict";

/**
 * @file ansi.js
 * @description ANSI escape sequence utilities and standard terminal color definitions.
 */

const colorReset = "\x1b[0m";
const colorBlue = "\x1b[34m";
const colorGreen = "\x1b[32m";
const colorYellow = "\x1b[33m";
const colorCyan = "\x1b[36m";
const colorMagenta = "\x1b[35m";
const colorRed = "\x1b[31m";
const colorOrange = "\x1b[38;5;208m";
const colorMuted = "\x1b[90m";

/**
 * Strip all CSI ANSI escape sequences from a string.
 * @param {string} input
 * @returns {string}
 */
function strip(input) {
  return String(input ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Count visible Unicode code points (runes) after stripping ANSI sequences.
 * @param {string} input
 * @returns {number}
 */
function visibleLen(input) {
  return Array.from(strip(input)).length;
}

/**
 * Wrap text in an ANSI color sequence when color output is enabled.
 * @param {string} input
 * @param {string} colorCode
 * @param {boolean} enabled
 * @returns {string}
 */
function colorize(input, colorCode, enabled) {
  if (!enabled || !input) {
    return input;
  }
  return `${colorCode}${input}${colorReset}`;
}

module.exports = {
  colorReset,
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
};
