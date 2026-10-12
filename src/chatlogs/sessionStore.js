"use strict";

const fs = require("fs/promises");
const path = require("path");

/**
 * @typedef {object} ChatRequestUsage
 * @property {string} sessionId - The chat session's id (its `.jsonl` filename, without extension).
 * @property {string} sessionTitle - The session's display name (VS Code's auto-generated or user-renamed chat title), falling back to `sessionId` when untitled.
 * @property {string} requestId - The individual request/response turn's id.
 * @property {string} promptSummary - A short, human-readable snippet of the user's prompt text (attachments/XML stripped, truncated).
 * @property {string | null} timestamp - ISO timestamp the request was sent, if known.
 * @property {string} model - Model id with the `copilot/` vendor prefix stripped (e.g. `claude-sonnet-5`).
 * @property {number} promptTokens - Prompt (input) tokens billed for this request.
 * @property {number} completionTokens - Completion (output) tokens billed for this request.
 * @property {number} totalTokens - `promptTokens + completionTokens`.
 * @property {number | null} credits - Copilot premium credits billed for this request, if reported.
 * @property {number | null} elapsedMs - Total response time in milliseconds, if reported.
 */

/**
 * Sets a deeply nested value on an object/array graph, creating
 * intermediate arrays/objects as needed. Used for `kind:1` patches, which
 * assign a scalar/object value at an exact path (e.g. a token count).
 *
 * @param {any} root - The object graph to mutate.
 * @param {(string | number)[]} keyPath - Path segments to the target value.
 * @param {any} value - The value to set.
 */
function setPath(root, keyPath, value) {
  let node = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    const nextKey = keyPath[i + 1];
    if (node[key] == null) node[key] = typeof nextKey === "number" ? [] : {};
    node = node[key];
  }
  node[keyPath[keyPath.length - 1]] = value;
}

/**
 * Appends items to a deeply nested array, creating intermediate
 * arrays/objects as needed. Used for `kind:2` patches, which splice new
 * item(s) onto an array (e.g. a new chat request, or new response parts)
 * rather than replacing the whole array.
 *
 * @param {any} root - The object graph to mutate.
 * @param {(string | number)[]} keyPath - Path segments to the target array.
 * @param {any} items - The array of items to append.
 */
function appendPath(root, keyPath, items) {
  if (!Array.isArray(items)) return;
  let node = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    const nextKey = keyPath[i + 1];
    if (node[key] == null) node[key] = typeof nextKey === "number" ? [] : {};
    node = node[key];
  }
  const lastKey = keyPath[keyPath.length - 1];
  if (!Array.isArray(node[lastKey])) node[lastKey] = [];
  node[lastKey].push(...items);
}

/**
 * Reduces a raw chat request's message text to a short, human-readable
 * prompt summary: strips `<attachments>...</attachments>` blocks (large
 * auto-injected context VS Code prepends to the message), collapses
 * whitespace, and truncates for display.
 *
 * @param {string | undefined} text - The raw `message.text` field from a request.
 * @returns {string} A short prompt summary, or a placeholder when there's no text.
 */
function summarizePromptText(text) {
  if (!text) return "(no prompt text)";
  const cleaned = String(text)
    .replace(/<attachments>[\s\S]*?<\/attachments>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "(attachments only)";
  const limit = 100;
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}\u2026` : cleaned;
}

/**
 * Parses one VS Code chat session `.jsonl` log (an append-only patch log)
 * and extracts per-request token/credit/timing usage.
 *
 * This relies on VS Code's internal, undocumented chat session storage
 * format and may change between versions; parsing failures are handled
 * per-line so a single malformed entry doesn't discard the rest of the file.
 *
 * @param {string} filePath - Absolute path to the `.jsonl` session log.
 * @returns {Promise<ChatRequestUsage[]>} Usage records for every request found in the session.
 */
async function parseChatSessionFile(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (_) {
    return [];
  }
  const state = { requests: [] };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    try {
      if (entry.kind === 0 && entry.v && typeof entry.v === "object") {
        Object.assign(state, entry.v);
      } else if (entry.kind === 2 && Array.isArray(entry.k)) {
        appendPath(state, entry.k, entry.v);
      } else if (Array.isArray(entry.k)) {
        setPath(state, entry.k, entry.v);
      }
    } catch (_) {
      // Best-effort extraction; ignore patches that don't apply cleanly.
    }
  }

  const sessionId = state.sessionId || path.basename(filePath, ".jsonl");
  const sessionTitle = state.customTitle || sessionId;
  const requests = Array.isArray(state.requests) ? state.requests : [];
  return requests
    .filter((r) => r && (r.promptTokens != null || r.completionTokens != null))
    .map((r) => {
      const promptTokens = Number(r.promptTokens) || 0;
      const completionTokens = Number(r.completionTokens) || 0;
      return {
        sessionId,
        sessionTitle,
        requestId: r.requestId || "",
        promptSummary: summarizePromptText(r.message && r.message.text),
        timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : null,
        model: String(r.modelId || "").replace(/^copilot\//, "") || "unknown",
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        credits: Number.isFinite(r.copilotCredits) ? r.copilotCredits : null,
        elapsedMs:
          r.result &&
          r.result.timings &&
          Number.isFinite(r.result.timings.totalElapsed)
            ? r.result.timings.totalElapsed
            : null,
      };
    });
}

/**
 * Locates the `chatSessions` folder for the current workspace. It lives as
 * a sibling of this extension's own workspace storage folder, under the
 * same `workspaceStorage/<hash>/` directory, so it can be derived without
 * hardcoding any VS Code installation path.
 *
 * @param {import("vscode").ExtensionContext} context - The extension's activation context.
 * @returns {string | null} Absolute path to the `chatSessions` folder, or `null` if no workspace is open.
 */
function findChatSessionsDir(context) {
  if (!context.storageUri) return null;
  return path.join(path.dirname(context.storageUri.fsPath), "chatSessions");
}

/**
 * Collects per-request token/credit/timing usage from every local chat
 * session log for the current workspace.
 *
 * @param {import("vscode").ExtensionContext} context - The extension's activation context.
 * @returns {Promise<{available: boolean, reason?: string, requests: ChatRequestUsage[]}>}
 *   `available` is `false` when there's no workspace open or no logs exist yet.
 */
async function collectChatSessionUsage(context) {
  const dir = findChatSessionsDir(context);
  if (!dir)
    return {
      available: false,
      reason: "Open a folder/workspace to read local chat session logs.",
      requests: [],
    };
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch (_) {
    return {
      available: false,
      reason: "No local chat session logs found for this workspace yet.",
      requests: [],
    };
  }
  const all = [];
  for (const file of files) {
    const records = await parseChatSessionFile(path.join(dir, file));
    all.push(...records);
  }
  all.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  return { available: true, requests: all };
}

/**
 * Aggregates per-request usage records into overall totals, a per-model
 * breakdown, and a per-session breakdown (keyed by the session's display
 * title rather than its opaque id).
 *
 * @param {ChatRequestUsage[]} requests - Usage records from {@link collectChatSessionUsage}.
 * @returns {{
 *   totalRequests: number, totalPromptTokens: number, totalCompletionTokens: number,
 *   totalTokens: number, totalCredits: number,
 *   byModel: {model: string, requests: number, promptTokens: number, completionTokens: number, totalTokens: number, credits: number}[],
 *   bySession: {sessionId: string, sessionTitle: string, requests: number, promptTokens: number, completionTokens: number, totalTokens: number, credits: number, lastTimestamp: string | null}[],
 * }}
 */
function summarizeChatSessionUsage(requests) {
  const byModel = new Map();
  const bySession = new Map();
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCredits = 0;
  for (const r of requests) {
    totalPromptTokens += r.promptTokens;
    totalCompletionTokens += r.completionTokens;
    totalCredits += r.credits || 0;

    const m = byModel.get(r.model) || {
      model: r.model,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      credits: 0,
    };
    m.requests += 1;
    m.promptTokens += r.promptTokens;
    m.completionTokens += r.completionTokens;
    m.totalTokens += r.totalTokens;
    m.credits += r.credits || 0;
    byModel.set(r.model, m);

    const s = bySession.get(r.sessionId) || {
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      credits: 0,
      lastTimestamp: null,
    };
    s.requests += 1;
    s.promptTokens += r.promptTokens;
    s.completionTokens += r.completionTokens;
    s.totalTokens += r.totalTokens;
    s.credits += r.credits || 0;
    if (!s.lastTimestamp || (r.timestamp || "") > s.lastTimestamp)
      s.lastTimestamp = r.timestamp;
    bySession.set(r.sessionId, s);
  }
  return {
    totalRequests: requests.length,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    totalCredits,
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    bySession: [...bySession.values()].sort((a, b) =>
      (b.lastTimestamp || "").localeCompare(a.lastTimestamp || ""),
    ),
  };
}

/**
 * Groups per-request usage records by chat session, each with its own
 * requests sorted newest-first, and the sessions themselves ordered by
 * most recently used first. Intended for rendering one collapsible section
 * per chat session instead of one long flat table.
 *
 * @param {ChatRequestUsage[]} requests - Usage records from {@link collectChatSessionUsage}.
 * @returns {{sessionId: string, sessionTitle: string, requests: ChatRequestUsage[]}[]}
 */
function groupRequestsBySession(requests) {
  const bySession = new Map();
  for (const r of requests) {
    const g = bySession.get(r.sessionId) || {
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      requests: [],
    };
    g.requests.push(r);
    bySession.set(r.sessionId, g);
  }
  const groups = [...bySession.values()];
  for (const g of groups)
    g.requests.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  groups.sort((a, b) => {
    const aTs = (a.requests[0] && a.requests[0].timestamp) || "";
    const bTs = (b.requests[0] && b.requests[0].timestamp) || "";
    return bTs.localeCompare(aTs);
  });
  return groups;
}

module.exports = {
  collectChatSessionUsage,
  summarizeChatSessionUsage,
  groupRequestsBySession,
  findChatSessionsDir,
  parseChatSessionFile,
};
