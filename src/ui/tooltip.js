"use strict";

const vscode = require("vscode");
const {
  formatNumber,
  formatResetDate,
  escapeMarkdown,
  textProgress,
} = require("../utils/format");
const { budgetState, usageSummary } = require("../usage/model");

/** Status dot glyphs keyed by budget/quota status. */
const STATUS_DOT = {
  ok: "🟢",
  warning: "🟡",
  danger: "🔴",
  disabled: "⚪",
};

/** Human-readable labels keyed by overall status. */
const STATUS_LABEL = {
  ok: "On track",
  warning: "Near limit",
  danger: "Over budget",
  disabled: "No budget",
};

/**
 * Builds the list of configured local budgets (today/week/month) paired with
 * their current usage, read from extension configuration.
 *
 * @param {{today: number, week: number, month: number}} usage - Usage deltas from {@link usageSummary}.
 * @param {import("vscode").WorkspaceConfiguration} cfg - The extension's configuration section.
 * @returns {{label: string, used: number, budget: number}[]} Budget rows for display.
 */
function buildBudgetRows(usage, cfg) {
  return [
    {
      label: "Today",
      used: usage.today,
      budget: Number(cfg.get("dailyBudget", 0)) || 0,
    },
    {
      label: "This week",
      used: usage.week,
      budget: Number(cfg.get("weeklyBudget", 0)) || 0,
    },
    {
      label: "This month",
      used: usage.month,
      budget: Number(cfg.get("monthlyBudget", 0)) || 0,
    },
  ];
}

/**
 * Builds the modern, color-coded hover tooltip shown on the status bar item,
 * summarizing credit usage and local budget status.
 *
 * @param {import("../usage/model").UsageSample} sample - The latest usage sample.
 * @param {import("../usage/model").UsageSample[]} history - Stored usage history.
 * @param {import("vscode").WorkspaceConfiguration} cfg - The extension's configuration section.
 * @returns {{tooltip: import("vscode").MarkdownString, worstState: "ok" | "warning" | "danger"}}
 *   The rendered tooltip and the worst budget status, used to color the status bar item.
 */
function buildTooltip(sample, history, cfg) {
  const usage = usageSummary(history, sample);
  const budgets = buildBudgetRows(usage, cfg);
  const states = budgets.map((x) => budgetState(x.used, x.budget));
  const worst = states.includes("danger")
    ? "danger"
    : states.includes("warning")
      ? "warning"
      : "ok";

  const quotaKnown =
    !sample.unlimited &&
    Number.isFinite(sample.entitlement) &&
    sample.entitlement > 0;
  const pct = quotaKnown
    ? Math.min(100, Math.round((sample.used / sample.entitlement) * 100))
    : null;
  const quotaState = sample.unlimited
    ? "ok"
    : quotaKnown
      ? pct >= 100
        ? "danger"
        : pct >= 80
          ? "warning"
          : "ok"
      : "disabled";

  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;

  md.appendMarkdown(`## $(github) Copilot Usage Monitor\n\n`);
  md.appendMarkdown(
    `${escapeMarkdown(sample.host || "GitHub")} &nbsp;·&nbsp; \`${escapeMarkdown(sample.plan || "Copilot")}\`\n\n`,
  );
  md.appendMarkdown(`---\n\n`);

  md.appendMarkdown(
    `### ${STATUS_DOT[quotaState]} ${escapeMarkdown(sample.quotaLabel || "Credits")}\n\n`,
  );
  if (sample.unlimited) {
    md.appendMarkdown(
      `**${formatNumber(sample.used)}** used this cycle &nbsp;·&nbsp; _unlimited on this plan_\n\n`,
    );
  } else if (quotaKnown) {
    md.appendMarkdown(
      `**${formatNumber(sample.used)}** / ${formatNumber(sample.entitlement)} used &nbsp;·&nbsp; **${pct}%**${sample.remaining == null ? "" : ` &nbsp;·&nbsp; ${formatNumber(sample.remaining)} remaining`}\n\n`,
    );
    md.appendMarkdown(`${textProgress(pct, quotaState)}\n\n`);
  } else {
    md.appendMarkdown(
      `**${formatNumber(sample.used)}** used &nbsp;·&nbsp; _total not reported by GitHub_\n\n`,
    );
  }

  const otherBuckets = (sample.buckets || []).filter(
    (b) => b.quotaId !== sample.quotaId && b.entitlement > 0 && !b.unlimited,
  );
  if (otherBuckets.length) {
    md.appendMarkdown(`\n`);
    for (const b of otherBuckets) {
      const p = Math.round((b.used / b.entitlement) * 100);
      md.appendMarkdown(
        `_${escapeMarkdown(b.label)}:_ ${formatNumber(b.used)} / ${formatNumber(b.entitlement)} (${p}%)\n\n`,
      );
    }
  }

  if (sample.resetDate)
    md.appendMarkdown(
      `$(history) Resets ${escapeMarkdown(formatResetDate(sample.resetDate))}\n\n`,
    );

  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(`### Usage budgets\n\n`);
  for (const item of budgets) {
    const state = budgetState(item.used, item.budget);
    if (item.budget > 0) {
      const p = Math.round((item.used / item.budget) * 100);
      const left = Math.max(0, item.budget - item.used);
      md.appendMarkdown(
        `${STATUS_DOT[state]} **${item.label}** &nbsp;·&nbsp; ${formatNumber(item.used)} / ${formatNumber(item.budget)} used (**${p}%**) &nbsp;·&nbsp; ${formatNumber(left)} remaining\\\n${textProgress(p, state)}\n\n`,
      );
    } else {
      md.appendMarkdown(
        `${STATUS_DOT.disabled} **${item.label}** &nbsp;·&nbsp; ${formatNumber(item.used)} used &nbsp;·&nbsp; _no budget set_\n\n`,
      );
    }
  }

  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(
    `${STATUS_DOT[worst]} **${STATUS_LABEL[worst]}** &nbsp;·&nbsp; _Updated ${new Date(sample.ts).toLocaleString()}_\n\n`,
  );
  md.appendMarkdown(`$(link-external) Click to open dashboard`);
  md.isTrusted = false;

  return { tooltip: md, worstState: worst };
}

module.exports = { buildTooltip, STATUS_DOT, STATUS_LABEL };
