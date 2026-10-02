"use strict";

const https = require("https");
const vscode = require("vscode");

/**
 * Performs an authenticated HTTPS GET request and parses the response body
 * as JSON.
 *
 * @param {string | URL} url - The absolute URL to request.
 * @param {string} token - A bearer token used for the `Authorization` header.
 * @param {string} apiVersion - The GitHub REST API version header value.
 * @param {import("vscode").OutputChannel} [output] - Optional extension output channel for response-body diagnostics.
 * @returns {Promise<any>} The parsed JSON response body.
 * @throws {Error} When the request fails, times out, or the response is not
 *   a successful JSON body.
 */
function getJson(url, token, apiVersion = "2026-03-10", output) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": apiVersion,
          "Editor-Version": `vscode/${vscode.version}`,
          "User-Agent": "Copilot-Usage-Monitor",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (output) {
            output.appendLine(
              `[${new Date().toISOString()}] GitHub API ${res.statusCode} ${url}\n${body || "(empty response body)"}`,
            );
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let detail = "";
            try {
              detail = JSON.parse(body).message || "";
            } catch (_) {}
            reject(
              new Error(
                `GitHub returned HTTP ${res.statusCode}${detail ? `: ${detail}` : ""}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            reject(new Error("GitHub returned invalid JSON."));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () =>
      req.destroy(new Error("GitHub request timed out.")),
    );
  });
}

/**
 * Gets a documented billing usage report for an enterprise, optionally
 * scoped to a single user, via GitHub's REST billing API.
 *
 * The "enhanced billing platform" endpoints this uses
 * (`/enterprises/{enterprise}/settings/billing/{usageType}/usage`) are a
 * GitHub Enterprise Cloud feature, so they are always served from the
 * enterprise's own API host: `api.github.com` for enterprises on
 * github.com, or `api.<host>` for enterprises on a GHE.com data-residency
 * host. They are not available on GitHub Enterprise Server (GHES).
 *
 * If scoping to `user` returns HTTP 404 (e.g. the signed-in account's login
 * isn't recognized as a billable user within this enterprise), this falls
 * back to the unscoped, enterprise-wide report rather than failing outright.
 *
 * @param {string} token - A GitHub token authorized to read enterprise billing (`read:enterprise` scope).
 * @param {string} enterprise - The enterprise slug.
 * @param {"ai_credit" | "premium_request"} usageType - The billing report type.
 * @param {{host?: string, user?: string, output?: import("vscode").OutputChannel}} [options] - `host` is the enterprise's
 *   GitHub host (defaults to `github.com`); `user` scopes the report to a single
 *   user's login so it reflects that individual's credit usage.
 * @returns {Promise<{timePeriod: object, usageItems: object[], scopedToUser: boolean}>}
 */
async function getEnterpriseBillingUsage(
  token,
  enterprise,
  usageType,
  options = {},
) {
  if (!["ai_credit", "premium_request"].includes(usageType))
    throw new Error(`Unsupported enterprise billing usage type: ${usageType}`);

  const { host = "github.com", user, output } = options;
  const apiBase =
    host === "github.com" ? "https://api.github.com" : `https://api.${host}`;
  const basePath = `${apiBase}/enterprises/${encodeURIComponent(enterprise)}/settings/billing/${usageType}/usage`;

  const fetchReport = async (scopedUser) => {
    const url = new URL(basePath);
    if (scopedUser) url.searchParams.set("user", scopedUser);
    const data = await getJson(url, token, "2026-03-10", output);
    if (
      !data ||
      typeof data !== "object" ||
      !data.timePeriod ||
      !Array.isArray(data.usageItems)
    )
      throw new Error(
        `GitHub returned an invalid ${usageType} billing usage report.`,
      );
    return data;
  };

  /**
   * Wraps a terminal HTTP 404 (i.e. still 404 after any user-scope fallback)
   * in a distinguishable error flagged `notAvailable`, so callers can treat
   * "this report doesn't exist for this enterprise/plan" as informational
   * rather than a hard failure.
   */
  const asNotAvailable = (error) => {
    const message = error && error.message ? error.message : String(error);
    if (!/HTTP 404/.test(message)) return error;
    const label = usageType === "ai_credit" ? "AI credit" : "Premium request";
    const notAvailableError = new Error(
      `${label} billing usage is not available for this enterprise (HTTP 404). This report may not apply to your plan.`,
    );
    notAvailableError.notAvailable = true;
    return notAvailableError;
  };

  if (!user) {
    try {
      return { ...(await fetchReport(undefined)), scopedToUser: false };
    } catch (error) {
      throw asNotAvailable(error);
    }
  }
  try {
    return { ...(await fetchReport(user)), scopedToUser: true };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!/HTTP 404/.test(message)) throw error;
    try {
      return { ...(await fetchReport(undefined)), scopedToUser: false };
    } catch (fallbackError) {
      throw asNotAvailable(fallbackError);
    }
  }
}

/**
 * Gets a documented billing usage report for an individually billed Copilot
 * plan (Free, Pro, Pro+, or a personal Business/Enterprise seat not managed
 * by an organization), via `/users/{username}/settings/billing/{usageType}/usage`.
 *
 * Unlike the enterprise billing endpoints, these report usage billed
 * directly to the user's personal account, so they work for individual
 * plans that have no enterprise or organization billing to query.
 *
 * @param {string} token - A GitHub token belonging to the user whose usage is being queried.
 * @param {string} username - The GitHub login to query usage for (normally the signed-in user).
 * @param {"ai_credit" | "premium_request"} usageType - The billing report type.
 * @param {string} [host] - The user's GitHub host (defaults to `github.com`).
 * @param {import("vscode").OutputChannel} [output] - Optional extension output channel for response-body diagnostics.
 * @returns {Promise<{timePeriod: object, usageItems: object[]}>}
 */
async function getUserBillingUsage(
  token,
  username,
  usageType,
  host = "github.com",
  output,
) {
  if (!["ai_credit", "premium_request"].includes(usageType))
    throw new Error(`Unsupported user billing usage type: ${usageType}`);

  const apiBase =
    host === "github.com" ? "https://api.github.com" : `https://api.${host}`;
  const url = new URL(
    `${apiBase}/users/${encodeURIComponent(username)}/settings/billing/${usageType}/usage`,
  );
  try {
    const data = await getJson(url, token, "2026-03-10", output);
    if (
      !data ||
      typeof data !== "object" ||
      !data.timePeriod ||
      !Array.isArray(data.usageItems)
    )
      throw new Error(
        `GitHub returned an invalid ${usageType} user billing usage report.`,
      );
    return data;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!/HTTP 404/.test(message)) throw error;
    const label = usageType === "ai_credit" ? "AI credit" : "Premium request";
    const notAvailableError = new Error(
      `${label} billing usage is not available for your personal account (HTTP 404). This report may not apply to your plan.`,
    );
    notAvailableError.notAvailable = true;
    throw notAvailableError;
  }
}

/**
 * Display labels for known `quota_snapshots` buckets, used when picking and
 * labeling the "primary" metric shown in the status bar/tooltip.
 */
const QUOTA_LABELS = {
  premium_interactions: "Premium requests",
  chat: "Chat messages",
  completions: "Code completions",
};

/**
 * Normalizes one raw `quota_snapshots` bucket (e.g. `chat`, `completions`,
 * `premium_interactions`) into a consistent shape, tolerating both
 * camelCase and snake_case field names across API versions.
 *
 * @param {string} quotaId - The bucket's key in `quota_snapshots`.
 * @param {any} bucket - The raw bucket object.
 * @returns {{quotaId: string, label: string, used: number, entitlement: number | null, remaining: number | null, unlimited: boolean, hasQuota: boolean, active: boolean, resetDate: string | null}}
 */
function normalizeQuotaBucket(quotaId, bucket) {
  const n = (...xs) => {
    for (const x of xs)
      if (typeof x === "number" && Number.isFinite(x)) return x;
    return null;
  };
  const used = n(bucket.creditsUsed, bucket.credits_used, bucket.used) ?? 0;
  const entitlement = n(
    bucket.entitlement,
    bucket.limit,
    bucket.creditsEntitlement,
    bucket.credits_entitlement,
  );
  const remaining = n(
    bucket.remaining,
    bucket.quota_remaining,
    bucket.creditsRemaining,
    bucket.credits_remaining,
  );
  const unlimited = !!bucket.unlimited;
  const hasQuota = !!bucket.has_quota;
  return {
    quotaId,
    label: QUOTA_LABELS[quotaId] || quotaId,
    used,
    entitlement,
    remaining,
    unlimited,
    hasQuota,
    // A bucket is relevant to show/select when the plan actually meters it
    // (has_quota), it's unlimited, or it already has recorded usage. Buckets
    // like premium_interactions on a Free plan report has_quota:false,
    // unlimited:false, used:0 and should be treated as not applicable.
    active: hasQuota || unlimited || used > 0,
    resetDate: bucket.resetDate || bucket.reset_date || null,
  };
}

/**
 * Extracts the Copilot credit usage counters from a raw
 * `copilot_internal/user` API response.
 *
 * GitHub reports usage across multiple quota buckets (`premium_interactions`,
 * `chat`, `completions`, ...), and which ones actually apply depends on the
 * plan: Free/Pro plans without premium request access report an inactive
 * `premium_interactions` bucket (`has_quota: false`, `entitlement: 0`) and
 * instead meter `chat`/`completions`; Business/Enterprise and premium-request
 * enabled plans meter `premium_interactions` (often `unlimited: true` with
 * `entitlement: 0`, meaning uncapped rather than unknown).
 *
 * This picks a "primary" bucket to headline — `premium_interactions` when
 * it's actually active for this plan, otherwise the most-utilized active
 * bucket — and returns the full set of buckets for a detailed breakdown.
 *
 * @param {any} data - The raw, parsed JSON response body.
 * @returns {{used: number, entitlement: number | null, remaining: number | null, unlimited: boolean, quotaId: string, quotaLabel: string, resetDate: string | null, plan: string, buckets: ReturnType<typeof normalizeQuotaBucket>[]} | null}
 *   The normalized usage fields, or `null` if no recognizable counter was found.
 */
function parseUsage(data) {
  const qs = data && data.quota_snapshots;
  if (!qs || typeof qs !== "object") return null;
  const buckets = Object.entries(qs)
    .filter(([, v]) => v && typeof v === "object")
    .map(([quotaId, v]) => normalizeQuotaBucket(quotaId, v));
  if (!buckets.length) return null;

  const pool = buckets.filter((b) => b.active);
  const candidates = pool.length ? pool : buckets;

  const premium = candidates.find((b) => b.quotaId === "premium_interactions");
  const mostUtilized = candidates
    .filter((b) => b.entitlement > 0)
    .sort((a, b) => b.used / b.entitlement - a.used / a.entitlement)[0];
  const primary = premium || mostUtilized || candidates[0];

  return {
    used: primary.used,
    entitlement: primary.entitlement,
    remaining: primary.remaining,
    unlimited: primary.unlimited,
    quotaId: primary.quotaId,
    quotaLabel: primary.label,
    resetDate:
      data.quota_reset_date_utc ||
      data.quota_reset_date ||
      primary.resetDate ||
      null,
    plan: data.copilot_plan || data.plan || "Copilot",
    buckets,
  };
}

module.exports = {
  getJson,
  getEnterpriseBillingUsage,
  getUserBillingUsage,
  parseUsage,
};
