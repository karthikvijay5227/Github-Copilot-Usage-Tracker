"use strict";

/**
 * Formats a number using the user's locale, or returns an em dash when the
 * value is missing or non-finite.
 *
 * @param {number | null | undefined} n - The value to format.
 * @returns {string} The formatted number, or `"—"` when unavailable.
 */
function formatNumber(n) {
  return Number.isFinite(Number(n)) ? new Intl.NumberFormat().format(n) : "—";
}

/**
 * Formats a quota reset date/time for display, falling back to the raw
 * value when it cannot be parsed as a date.
 *
 * @param {string | number} value - An ISO date string or timestamp.
 * @returns {string} A locale-formatted date/time string.
 */
function formatResetDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/**
 * Escapes text for safe inclusion in HTML (webview) content.
 *
 * @param {unknown} s - The value to escape.
 * @returns {string} HTML-escaped text.
 */
function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        c
      ],
  );
}

/**
 * Escapes text for safe inclusion in a {@link import("vscode").MarkdownString}.
 *
 * @param {unknown} s - The value to escape.
 * @returns {string} Markdown-escaped text.
 */
function escapeMarkdown(s) {
  return String(s ?? "").replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&");
}

/**
 * Builds a `YYYY-MM-DD` key for a date using local time, used to bucket
 * usage samples by calendar day.
 *
 * @param {Date} d - The date to key.
 * @returns {string} The local date key.
 */
function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Renders a textual progress bar made of rounded block glyphs (▰/▱), with an
 * optional leading status dot, for display inside a Markdown tooltip.
 *
 * @param {number | null} percent - Percentage complete, 0-100.
 * @param {"ok" | "warning" | "danger" | "disabled" | undefined} [state] - Status used to color the leading dot.
 * @returns {string} A Markdown-safe progress bar string.
 */
function textProgress(percent, state) {
  if (!Number.isFinite(percent)) return "_not available_";
  const p = Math.max(0, Math.min(100, percent));
  const segments = 16;
  const filled = Math.round((p / 100) * segments);
  const dot = { ok: "🟢", warning: "🟡", danger: "🔴" }[state];
  const lead = dot ? `${dot} ` : "";
  const bar = "▰".repeat(filled) + "▱".repeat(segments - filled);
  return `${lead}${bar}`;
}

module.exports = {
  formatNumber,
  formatResetDate,
  escapeHtml,
  escapeMarkdown,
  localDateKey,
  textProgress,
};
