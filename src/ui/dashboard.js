"use strict";

const crypto = require("crypto");
const { formatNumber, escapeHtml } = require("../utils/format");
const { usageSummary } = require("../usage/model");
const { DASHBOARD_CSS } = require("./dashboardStyles");

/**
 * Computes a budget's completion percentage.
 *
 * @param {number} v - Credits used.
 * @param {number} b - Configured budget (0 means disabled).
 * @returns {number | null} Percentage 0-100, or `null` when no budget is set.
 */
function percentOf(v, b) {
  return b > 0 ? Math.min(100, Math.round((v / b) * 100)) : null;
}

/**
 * Renders the HTML progress bar + caption markup for a single budget card.
 *
 * @param {number} v - Credits used in the period.
 * @param {number} b - Configured budget for the period.
 * @returns {string} HTML markup for the card's progress section.
 */
function renderProgress(v, b) {
  const p = percentOf(v, b);
  if (p === null) return '<div class="muted">No budget configured</div>';
  const cls = p >= 100 ? "danger" : p >= 80 ? "warning" : "ok";
  return (
    `<div class="progress"><span class="${cls}" style="width:${p}%"></span></div>` +
    `<small><span class="dot ${cls}"></span>${p}% of budget · ${formatNumber(Math.max(0, b - v))} remaining</small>`
  );
}

/**
 * Renders the daily usage history table rows (most recent 31 days, newest first).
 *
 * @param {import("../usage/model").UsageSample[]} days - Samples scoped to the current cycle, sorted ascending by time.
 * @returns {string} HTML `<tr>` rows, or an empty string when there is no history.
 */
function renderHistoryRows(days) {
  const dailyMap = new Map();
  for (const s of days) {
    const d = dailyMap.get(s.localDate);
    if (!d) dailyMap.set(s.localDate, { first: s.used, last: s.used });
    else d.last = s.used;
  }
  return [...dailyMap.entries()]
    .slice(-31)
    .reverse()
    .map(
      ([date, d]) =>
        `<tr><td>${escapeHtml(date)}</td><td>${formatNumber(Math.max(0, d.last - d.first))}</td><td>${formatNumber(d.last)}</td></tr>`,
    )
    .join("");
}

/**
 * Renders one documented billing report (enterprise or personal) without
 * interpreting usage quantities as a budget or remaining balance.
 *
 * @param {string} title - Report name shown to the user.
 * @param {object | undefined} report - Latest normalized billing report.
 * @param {{message: string, notAvailable?: boolean} | undefined} error - Latest error for this report.
 * @returns {string} HTML for the billing report card.
 */
function renderBillingReport(title, report, error) {
  const rows =
    report && Array.isArray(report.usageItems)
      ? report.usageItems
          .map(
            (item) =>
              `<tr><td>${escapeHtml(item.product)}</td><td>${escapeHtml(item.model)}</td><td>${escapeHtml(item.sku)}</td><td>${escapeHtml(item.unitType)}</td><td>${formatNumber(item.netQuantity)}</td><td>${formatNumber(item.netAmount)}</td></tr>`,
          )
          .join("")
      : "";
  const period =
    report && report.timePeriod
      ? [
          report.timePeriod.year,
          report.timePeriod.month && String(report.timePeriod.month).padStart(2, "0"),
          report.timePeriod.day && String(report.timePeriod.day).padStart(2, "0"),
        ]
          .filter(Boolean)
          .join("-")
      : "";

  return `<div class="section"><h3>${escapeHtml(title)}${period ? ` · ${escapeHtml(period)}` : ""}</h3>${
    error
      ? `<div class="${error.notAvailable ? "muted" : "notice"}">${escapeHtml(error.message)}</div>`
      : report
        ? `<table><thead><tr><th>Product</th><th>Model</th><th>SKU</th><th>Unit</th><th>Net quantity</th><th>Net amount</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">No usage items reported for this period.</td></tr>'}</tbody></table>`
        : '<div class="muted">No report available yet.</div>'
  }</div>`;
}

/**
 * Renders a table breaking down every Copilot quota bucket reported for the
 * latest sample (e.g. premium requests, chat messages, code completions),
 * since which buckets actually apply varies by plan.
 *
 * @param {import("../usage/model").UsageSample | null} latest - The most recent usage sample.
 * @returns {string} HTML for the quota breakdown section.
 */
function renderQuotaBuckets(latest) {
  const buckets = latest && Array.isArray(latest.buckets) ? latest.buckets : [];
  if (!buckets.length)
    return `<div class="section"><h2>Copilot plan quotas</h2><div class="muted">No quota snapshot available yet.</div></div>`;

  const rows = buckets
    .map((b) => {
      const applicable = b.hasQuota || b.unlimited || b.used > 0;
      const status = !applicable
        ? '<span class="muted">Not on this plan</span>'
        : b.unlimited
          ? "Unlimited"
          : b.entitlement > 0
            ? `${Math.round((b.used / b.entitlement) * 100)}%`
            : "—";
      return `<tr><td>${escapeHtml(b.label)}</td><td>${formatNumber(b.used)}</td><td>${b.unlimited ? "Unlimited" : b.entitlement > 0 ? formatNumber(b.entitlement) : "—"}</td><td>${b.remaining != null ? formatNumber(b.remaining) : "—"}</td><td>${status}</td></tr>`;
    })
    .join("");

  return `<div class="section"><h2>Copilot plan quotas</h2><div class="muted">All quota buckets GitHub reports for your plan; which ones apply depends on your plan type.</div><table><thead><tr><th>Quota</th><th>Used</th><th>Entitlement</th><th>Remaining</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/**
 * Builds the full HTML document for the "Copilot Usage Monitor" dashboard
 * webview panel, including summary cards, a daily history table, and action
 * buttons wired to `postMessage` commands for refresh and configuration.
 *
 * @param {import("../usage/model").UsageSample[]} history - Stored usage history.
 * @param {import("../usage/model").UsageSample | null} latest - The most recent usage sample.
 * @param {import("vscode").WorkspaceConfiguration} cfg - The extension's configuration section.
 * @param {object | null} enterpriseBilling - Stored documented enterprise billing reports, if configured.
 * @param {object | null} personalBilling - Stored documented personal (individually billed) billing reports.
 * @returns {string} A complete HTML document string.
 */
function buildDashboardHtml(
  history,
  latest,
  cfg,
  enterpriseBilling = null,
  personalBilling = null,
) {
  const u = usageSummary(history, latest);
  const daily = Number(cfg.get("dailyBudget", 0)) || 0;
  const weekly = Number(cfg.get("weeklyBudget", 0)) || 0;
  const monthly = Number(cfg.get("monthlyBudget", 0)) || 0;

  const cyclePct =
    latest && !latest.unlimited && latest.entitlement > 0
      ? percentOf(latest.used, latest.entitlement)
      : null;
  const cycleCls =
    cyclePct >= 100 ? "danger" : cyclePct >= 80 ? "warning" : "ok";
  const cycleLabel = (latest && latest.quotaLabel) || "Current cycle used";

  const days = Array.isArray(history)
    ? history
        .filter((x) => !latest || x.cycleId === latest.cycleId)
        .slice()
        .sort((a, b) => a.ts.localeCompare(b.ts))
    : [];
  const rows = renderHistoryRows(days);
  const quotaBuckets = renderQuotaBuckets(latest);
  const billing =
    enterpriseBilling && enterpriseBilling.enterprise
      ? `<div class="section"><h2>Enterprise billing usage · ${escapeHtml(enterpriseBilling.enterprise)}</h2><div class="muted">Official GitHub billing reports${enterpriseBilling.user ? ` · scoped to ${escapeHtml(enterpriseBilling.user)}` : ""} · updated ${enterpriseBilling.fetchedAt ? escapeHtml(new Date(enterpriseBilling.fetchedAt).toLocaleString()) : "not yet"} · reports do not include budget limits or pooled remaining credits</div>${enterpriseBilling.errors && enterpriseBilling.errors.authorization ? `<div class="notice">${escapeHtml(enterpriseBilling.errors.authorization)}</div>` : ""}${renderBillingReport("AI credit usage", enterpriseBilling.reports && enterpriseBilling.reports.ai_credit, enterpriseBilling.errors && enterpriseBilling.errors.ai_credit)}${renderBillingReport("Premium request usage", enterpriseBilling.reports && enterpriseBilling.reports.premium_request, enterpriseBilling.errors && enterpriseBilling.errors.premium_request)}</div>`
      : `<div class="section"><h2>Enterprise billing usage</h2><div class="muted">Not configured. Configure an enterprise slug to retrieve official AI-credit and premium-request usage reports for your account.</div></div>`;
  const personal =
    personalBilling && personalBilling.username
      ? `<div class="section"><h2>Personal billing usage · ${escapeHtml(personalBilling.username)}</h2><div class="muted">Official GitHub billing reports for your individually billed Copilot plan (Free, Pro, Pro+, or an unmanaged seat) · updated ${personalBilling.fetchedAt ? escapeHtml(new Date(personalBilling.fetchedAt).toLocaleString()) : "not yet"}</div>${renderBillingReport("AI credit usage", personalBilling.reports && personalBilling.reports.ai_credit, personalBilling.errors && personalBilling.errors.ai_credit)}${renderBillingReport("Premium request usage", personalBilling.reports && personalBilling.reports.premium_request, personalBilling.errors && personalBilling.errors.premium_request)}</div>`
      : `<div class="section"><h2>Personal billing usage</h2><div class="muted">Not yet retrieved. Configure an account to fetch official AI-credit and premium-request billing reports for your individual Copilot plan.</div></div>`;

  const nonce = crypto.randomBytes(16).toString("hex");

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>${DASHBOARD_CSS}</style></head><body>
  <h1>Copilot Usage Monitor</h1><div class="sub">${latest ? `${escapeHtml(latest.host || "GitHub")} · ${escapeHtml(latest.plan || "Copilot")} · Updated ${escapeHtml(new Date(latest.ts).toLocaleString())}` : "No usage snapshot available yet."}</div>
  <div class="actions"><button id="refresh">Refresh now</button><button id="budgets">Configure budgets</button><button id="account">Configure account</button><button id="enterpriseBilling">Configure enterprise billing</button></div>
  <div class="grid">
  <div class="card"><div class="label">${escapeHtml(cycleLabel)}</div><div class="value">${latest ? formatNumber(latest.used) : "—"}</div>${
    latest && latest.unlimited
      ? `<div class="muted">Unlimited on this plan</div>`
      : latest && latest.entitlement > 0
        ? `<div class="muted">of ${formatNumber(latest.entitlement)}</div><div class="progress"><span class="${cycleCls}" style="width:${cyclePct}%"></span></div><small><span class="dot ${cycleCls}"></span>${cyclePct}% consumed</small>`
        : '<div class="muted">Quota total not reported by GitHub</div>'
  }</div>
  <div class="card"><div class="label">Remaining</div><div class="value">${latest && !latest.unlimited && latest.entitlement > 0 && latest.remaining != null ? formatNumber(latest.remaining) : "—"}</div><div class="muted">${latest && latest.unlimited ? "Unlimited plan" : latest && latest.entitlement > 0 ? "Current quota snapshot" : "Quota unavailable"}</div></div>
  <div class="card"><div class="label">Today</div><div class="value">${formatNumber(u.today)}</div>${renderProgress(u.today, daily)}</div>
  <div class="card"><div class="label">This week</div><div class="value">${formatNumber(u.week)}</div>${renderProgress(u.week, weekly)}</div>
  <div class="card"><div class="label">This month</div><div class="value">${formatNumber(u.month)}</div>${renderProgress(u.month, monthly)}</div></div>
  ${quotaBuckets}
  ${personal}
  ${billing}
  <div class="section"><h2>Daily usage history</h2><table><thead><tr><th>Date</th><th>Estimated credits used</th><th>Cycle counter at last sample</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="muted">No history collected yet. Leave VS Code running to collect snapshots.</td></tr>'}</tbody></table></div>
  <div class="notice"><strong>About these estimates</strong><br>Daily and weekly consumption are derived from changes in GitHub's cumulative counter. Usage before the first snapshot of a day or while VS Code is closed may be missed. Budgets are local alerts, not GitHub-enforced limits. Usage history is stored in VS Code global extension storage; prompts and source code are not collected.</div>
  <script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({command:'refresh'}));document.getElementById('budgets').addEventListener('click',()=>vscode.postMessage({command:'budgets'}));document.getElementById('account').addEventListener('click',()=>vscode.postMessage({command:'account'}));document.getElementById('enterpriseBilling').addEventListener('click',()=>vscode.postMessage({command:'enterpriseBilling'}));</script>
  </body></html>`;
}

module.exports = { buildDashboardHtml };
