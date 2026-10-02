"use strict";

const { localDateKey } = require("../utils/format");

/**
 * @typedef {object} UsageSample
 * @property {string} ts - ISO timestamp when the sample was collected.
 * @property {string} localDate - Local `YYYY-MM-DD` key for the sample.
 * @property {string} cycleId - Identifier grouping samples within the same billing cycle.
 * @property {number} used - Cumulative usage for the primary quota bucket, as reported by GitHub.
 * @property {number | null} entitlement - Total entitlement for the primary bucket, if reported.
 * @property {number | null} remaining - Remaining amount for the primary bucket, if reported.
 * @property {boolean} unlimited - Whether the primary bucket is uncapped (no entitlement ceiling).
 * @property {string} quotaId - The primary bucket's `quota_snapshots` key (e.g. `premium_interactions`, `chat`, `completions`).
 * @property {string} quotaLabel - Human-readable label for the primary bucket.
 * @property {object[]} buckets - All known quota buckets for this plan, for a detailed breakdown.
 * @property {string | null} resetDate - ISO date/time the cycle resets, if reported.
 * @property {string} plan - The Copilot plan name.
 * @property {string} provider - `"github"` or `"github-enterprise"`.
 * @property {string} host - The GitHub host the sample was collected from.
 */

/**
 * Normalizes a raw parsed usage payload into the subset of fields persisted
 * in a {@link UsageSample}.
 *
 * @param {{used: number, entitlement: number | null, remaining: number | null, unlimited: boolean, quotaId: string, quotaLabel: string, resetDate: string | null, plan: string, buckets: object[]}} s - Parsed usage fields.
 * @param {Date} now - The current time, used to stamp `fetchedAt`.
 * @returns {{used: number, entitlement: number | null, remaining: number | null, unlimited: boolean, quotaId: string, quotaLabel: string, buckets: object[], resetDate: string | null, plan: string, fetchedAt: string}}
 */
function normalizeSnapshot(s, now) {
  return {
    used: Math.max(0, s.used),
    entitlement: s.entitlement,
    remaining: s.remaining,
    unlimited: !!s.unlimited,
    quotaId: s.quotaId,
    quotaLabel: s.quotaLabel,
    buckets: Array.isArray(s.buckets) ? s.buckets : [],
    resetDate: s.resetDate,
    plan: s.plan,
    fetchedAt: now.toISOString(),
  };
}

/**
 * Appends a new sample to history, collapsing it into the previous entry
 * when it represents the same moment (same day/cycle/usage within a minute)
 * to avoid redundant storage growth.
 *
 * @param {UsageSample[]} history - Existing stored history.
 * @param {UsageSample} sample - The new sample to append.
 * @returns {UsageSample[]} The updated history, capped to the most recent 2000 entries.
 */
function appendSample(history, sample) {
  const a = Array.isArray(history) ? history.slice(-1999) : [],
    p = a[a.length - 1];
  if (
    p &&
    p.localDate === sample.localDate &&
    p.cycleId === sample.cycleId &&
    p.used === sample.used &&
    Math.abs(Date.parse(p.ts) - Date.parse(sample.ts)) < 60000
  )
    a[a.length - 1] = sample;
  else a.push(sample);
  return a;
}

/**
 * Builds the storage key used to de-duplicate budget-crossing notifications
 * for a given period and sample.
 *
 * @param {"Daily" | "Weekly" | "Monthly"} label - The budget period.
 * @param {UsageSample} sample - The sample the period is computed for.
 * @returns {string} A key unique to the given period instance.
 */
function budgetPeriodKey(label, sample) {
  if (label === "Daily") return sample.localDate;
  const d = new Date(sample.ts);
  if (label === "Monthly")
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDateKey(d);
}

/**
 * Classifies usage against a budget into a status bucket.
 *
 * @param {number} used - Credits used in the period.
 * @param {number} budget - The configured budget for the period (0 disables it).
 * @returns {"ok" | "warning" | "danger" | "disabled"} The budget status.
 */
function budgetState(used, budget) {
  if (!(budget > 0)) return "disabled";
  const pct = used / budget;
  return pct >= 1 ? "danger" : pct >= 0.8 ? "warning" : "ok";
}

/**
 * Computes today/this-week/this-month usage deltas from stored history,
 * scoped to the same billing cycle as the latest sample.
 *
 * @param {UsageSample[]} history - Stored usage history.
 * @param {UsageSample | null} latest - The most recent usage sample.
 * @returns {{today: number, week: number, month: number}} Estimated credits used in each period.
 */
function usageSummary(history, latest) {
  if (!latest) return { today: 0, week: 0, month: 0 };
  const samples = (Array.isArray(history) ? history : [])
    .filter((s) => s.cycleId === latest.cycleId)
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const deltaFor = (filter) => {
    const subset = samples.filter(filter);
    return subset.length
      ? Math.max(0, subset[subset.length - 1].used - subset[0].used)
      : 0;
  };
  const day = latest.localDate;
  const now = new Date(latest.ts);
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  monthStart.setHours(0, 0, 0, 0);
  return {
    today: deltaFor((s) => s.localDate === day),
    week: deltaFor((s) => new Date(s.ts) >= monday),
    month: deltaFor((s) => new Date(s.ts) >= monthStart),
  };
}

module.exports = {
  normalizeSnapshot,
  appendSample,
  budgetPeriodKey,
  budgetState,
  usageSummary,
  localDateKey,
};
