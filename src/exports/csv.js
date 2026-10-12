"use strict";

/**
 * Escapes a value for safe inclusion in a CSV cell (quotes the value if it
 * contains a comma, quote, or newline, doubling any embedded quotes).
 *
 * @param {unknown} value - The raw cell value.
 * @returns {string} The CSV-escaped cell text.
 */
function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Groups stored usage history into per-day rows scoped to the latest
 * billing cycle, mirroring the dashboard's "Daily usage history" table.
 *
 * @param {import("../usage/model").UsageSample[]} history - Stored usage history.
 * @param {import("../usage/model").UsageSample | null} latest - The most recent usage sample.
 * @returns {{date: string, used: number, cumulative: number, quotaLabel: string, plan: string, host: string}[]}
 *   One row per day, in ascending date order.
 */
function dailyUsageRows(history, latest) {
  const days = Array.isArray(history)
    ? history
        .filter((x) => !latest || x.cycleId === latest.cycleId)
        .slice()
        .sort((a, b) => a.ts.localeCompare(b.ts))
    : [];
  const dailyMap = new Map();
  for (const s of days) {
    const existing = dailyMap.get(s.localDate);
    if (!existing) dailyMap.set(s.localDate, { first: s.used, last: s.used, sample: s });
    else {
      existing.last = s.used;
      existing.sample = s;
    }
  }
  return [...dailyMap.entries()].map(([date, d]) => ({
    date,
    used: Math.max(0, d.last - d.first),
    cumulative: d.last,
    quotaLabel: d.sample.quotaLabel || "",
    plan: d.sample.plan || "",
    host: d.sample.host || "",
  }));
}

/**
 * Builds a CSV document of daily Copilot usage, suitable for opening in
 * Excel or any spreadsheet application.
 *
 * @param {import("../usage/model").UsageSample[]} history - Stored usage history.
 * @param {import("../usage/model").UsageSample | null} latest - The most recent usage sample.
 * @returns {string} CSV text with a header row, using CRLF line endings.
 */
function buildUsageCsv(history, latest) {
  const header = [
    "Date",
    "Estimated Used",
    "Cumulative Counter",
    "Quota",
    "Plan",
    "Host",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const row of dailyUsageRows(history, latest)) {
    lines.push(
      [row.date, row.used, row.cumulative, row.quotaLabel, row.plan, row.host]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Builds a CSV document of local chat session token usage (one row per
 * request), suitable for opening in Excel or any spreadsheet application.
 *
 * @param {import("../chatlogs/sessionStore").ChatRequestUsage[]} requests - Per-request usage records.
 * @returns {string} CSV text with a header row, using CRLF line endings.
 */
function buildChatSessionUsageCsv(requests) {
  const header = [
    "Timestamp",
    "Chat Session",
    "Prompt",
    "Model",
    "Prompt Tokens",
    "Completion Tokens",
    "Total Tokens",
    "Credits",
    "Elapsed (s)",
    "Session ID",
    "Request ID",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const r of requests || []) {
    lines.push(
      [
        r.timestamp || "",
        r.sessionTitle || r.sessionId,
        r.promptSummary || "",
        r.model,
        r.promptTokens,
        r.completionTokens,
        r.totalTokens,
        r.credits == null ? "" : r.credits,
        r.elapsedMs == null ? "" : (r.elapsedMs / 1000).toFixed(1),
        r.sessionId,
        r.requestId,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

module.exports = {
  buildUsageCsv,
  buildChatSessionUsageCsv,
  dailyUsageRows,
  csvEscape,
};
