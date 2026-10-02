"use strict";

const vscode = require("vscode");
const {
  NS,
  HISTORY_KEY,
  LATEST_KEY,
  LAST_ERROR_KEY,
  ACCOUNT_KEY,
  ENTERPRISE_BILLING_KEY,
  PERSONAL_BILLING_KEY,
  STATUSBAR_ID,
} = require("./constants");
const {
  validEnterpriseHost,
  normalizeHost,
  isGheDotComHost,
} = require("./utils/host");
const { formatNumber, localDateKey } = require("./utils/format");
const {
  getJson,
  getEnterpriseBillingUsage,
  getUserBillingUsage,
  parseUsage,
} = require("./github/api");
const {
  normalizeSnapshot,
  appendSample,
  budgetPeriodKey,
  usageSummary,
} = require("./usage/model");
const { buildTooltip } = require("./ui/tooltip");
const { buildDashboardHtml } = require("./ui/dashboard");

/**
 * Owns the status bar item, dashboard webview panel, polling timer, and
 * refresh/configuration flows for the Copilot Usage Monitor extension.
 */
class UsageMonitor {
  /**
   * @param {import("vscode").ExtensionContext} context - The extension's activation context.
   */
  constructor(context) {
    this.context = context;
    this.timer = undefined;
    this.panel = undefined;
    this.refreshing = false;
    this.billingRefreshing = false;
    this.personalBillingRefreshing = false;
    this.status = vscode.window.createStatusBarItem(
      STATUSBAR_ID,
      vscode.StatusBarAlignment.Right,
      90,
    );
    this.status.command = `${NS}.openDashboard`;
    this.status.tooltip = new vscode.MarkdownString(
      "GitHub Copilot Usage Monitor",
    );
    this.output = vscode.window.createOutputChannel("Copilot Usage Monitor");
    context.subscriptions.push(this.status, this.output);
  }

  /** Starts the status bar, polling timer, and configuration-change listeners. */
  start() {
    this.updateStatusFromStored();
    this.configureTimer();
    this.refresh(false);
    this.refreshEnterpriseBilling(false);
    this.refreshPersonalBilling(false);
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(`${NS}.pollMinutes`) ||
          e.affectsConfiguration(`${NS}.showInStatusBar`)
        ) {
          this.configureTimer();
          this.updateStatusFromStored();
        }
        if (
          e.affectsConfiguration(`${NS}.dailyBudget`) ||
          e.affectsConfiguration(`${NS}.weeklyBudget`) ||
          e.affectsConfiguration(`${NS}.monthlyBudget`)
        )
          this.updateStatusFromStored();
      }),
    );
  }

  /** Disposes the polling timer and dashboard panel. Called on deactivation. */
  dispose() {
    if (this.timer) clearInterval(this.timer);
    if (this.panel) this.panel.dispose();
  }

  /** @returns {import("vscode").WorkspaceConfiguration} This extension's configuration section. */
  cfg() {
    return vscode.workspace.getConfiguration(NS);
  }

  /** (Re)starts the polling timer using the configured interval (clamped to 5-120 minutes). */
  configureTimer() {
    if (this.timer) clearInterval(this.timer);
    const minutes = Math.max(
      5,
      Math.min(120, Number(this.cfg().get("pollMinutes", 15)) || 15),
    );
    this.timer = setInterval(() => {
      this.refresh(false);
      this.refreshEnterpriseBilling(false);
      this.refreshPersonalBilling(false);
    }, minutes * 60000);
  }

  /** Prompts the user to choose and configure a GitHub account, then refreshes. */
  async configureAccount() {
    const choices = [
      {
        label: "$(github) GitHub.com",
        description: "Use your regular GitHub account",
        id: "github",
      },
      {
        label: "$(server) GitHub Enterprise",
        description: "Use a GHE.com or GHES account",
        id: "github-enterprise",
      },
    ];
    const selected = await vscode.window.showQuickPick(choices, {
      placeHolder: "Choose the GitHub account type",
    });
    if (!selected) return;
    let host = "github.com";
    if (selected.id === "github-enterprise") {
      const current = this.context.globalState.get(ACCOUNT_KEY);
      const entered = await vscode.window.showInputBox({
        prompt:
          "Enter your GitHub Enterprise hostname (without https:// or a path)",
        placeHolder: "company.ghe.com",
        value:
          current && current.provider === "github-enterprise"
            ? current.host
            : "",
        ignoreFocusOut: true,
        validateInput: (v) =>
          validEnterpriseHost(v)
            ? null
            : "Enter a hostname such as company.ghe.com; do not include a scheme or path.",
      });
      if (!entered) return;
      host = normalizeHost(entered);
      // VS Code's GitHub Enterprise auth provider reads this setting.
      await vscode.workspace
        .getConfiguration("github-enterprise")
        .update("uri", `https://${host}`, vscode.ConfigurationTarget.Global);
    }
    await this.context.globalState.update(ACCOUNT_KEY, {
      provider: selected.id,
      host,
    });
    const session = await this.getSession(selected.id, true);
    if (!session) return;
    await this.refresh(true);
    await this.refreshPersonalBilling(true);
  }

  /**
   * Retrieves (or interactively creates) a GitHub authentication session.
   *
   * @param {string} provider - `"github"` or `"github-enterprise"`.
   * @param {boolean} interactive - Whether to prompt the user to sign in if needed.
   * @returns {Promise<import("vscode").AuthenticationSession | undefined>}
   */
  async getSession(provider, interactive, scopes = ["read:user"]) {
    const options = interactive
      ? {
          createIfNone: {
            detail:
              provider === "github"
                ? "Sign in to GitHub.com to read Copilot usage."
                : "Sign in to your GitHub Enterprise account to read Copilot usage.",
          },
        }
      : { silent: true };
    return vscode.authentication.getSession(provider, scopes, options);
  }

  /** Refreshes personal usage, personal billing, and configured enterprise usage independently. */
  async refreshAll(manual) {
    await this.refresh(manual);
    await this.refreshPersonalBilling(manual);
    await this.refreshEnterpriseBilling(manual);
  }

  /** Prompts for an enterprise slug and enables the documented billing reports. */
  async configureEnterpriseBilling() {
    const current = this.context.globalState.get(ENTERPRISE_BILLING_KEY);
    const enterprise = await vscode.window.showInputBox({
      prompt: "GitHub Enterprise slug for billing reports",
      placeHolder: "my-enterprise",
      value: current && current.enterprise ? current.enterprise : "",
      ignoreFocusOut: true,
      validateInput: (value) =>
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(String(value || "").trim())
          ? null
          : "Enter the enterprise slug shown in the enterprise URL.",
    });
    if (!enterprise) return;
    await this.context.globalState.update(ENTERPRISE_BILLING_KEY, {
      enterprise: enterprise.trim(),
      reports:
        current && current.enterprise === enterprise.trim()
          ? current.reports || {}
          : {},
      errors: {},
    });
    await this.refreshEnterpriseBilling(true);
  }

  /**
   * Fetches documented AI-credit and premium-request billing usage for the
   * signed-in user's own personal account, via
   * `/users/{username}/settings/billing/{usageType}/usage`.
   *
   * Unlike {@link refreshEnterpriseBilling}, this covers Copilot usage billed
   * directly to an individual (Free, Pro, Pro+, or an unmanaged personal
   * seat) and requires no separate configuration — it uses whichever account
   * is already configured for personal usage tracking.
   *
   * @param {boolean} manual - Whether to show interactive authentication/errors.
   */
  async refreshPersonalBilling(manual) {
    if (this.personalBillingRefreshing) return;
    const account = this.context.globalState.get(ACCOUNT_KEY);
    if (!account) return;

    this.personalBillingRefreshing = true;
    try {
      const session = await this.getSession(account.provider, manual);
      if (!session)
        throw new Error(
          `No ${account.provider === "github" ? "GitHub.com" : account.host} session found. Use Configure Account to sign in.`,
        );
      const username = session.account && session.account.label;
      if (!username)
        throw new Error("Could not determine the signed-in GitHub username.");

      const types = ["ai_credit", "premium_request"];
      const results = await Promise.all(
        types.map(async (type) => {
          try {
            return {
              type,
              report: await getUserBillingUsage(
                session.accessToken,
                username,
                type,
                account.host,
                this.output,
              ),
            };
          } catch (error) {
            return {
              type,
              error: error && error.message ? error.message : String(error),
              notAvailable: !!(error && error.notAvailable),
            };
          }
        }),
      );
      const previous = this.context.globalState.get(PERSONAL_BILLING_KEY);
      const reports = { ...(previous && previous.reports) };
      const errors = {};
      for (const result of results) {
        if (result.report) {
          reports[result.type] = {
            timePeriod: result.report.timePeriod,
            usageItems: result.report.usageItems,
            fetchedAt: new Date().toISOString(),
          };
          errors[result.type] = null;
        } else {
          errors[result.type] = {
            message: result.error,
            notAvailable: result.notAvailable,
          };
          this.output.appendLine(
            `[${new Date().toISOString()}] Personal ${result.type} billing report ${result.notAvailable ? "not available" : "failed"}: ${result.error}`,
          );
        }
      }
      const next = {
        username,
        fetchedAt: new Date().toISOString(),
        reports,
        errors,
      };
      await this.context.globalState.update(PERSONAL_BILLING_KEY, next);
      if (this.panel && !this.panel.disposed)
        this.panel.webview.html = buildDashboardHtml(
          this.context.globalState.get(HISTORY_KEY, []),
          this.context.globalState.get(LATEST_KEY, null),
          this.cfg(),
          this.context.globalState.get(ENTERPRISE_BILLING_KEY),
          next,
        );

      const hardFailures = results.filter(
        (result) => result.error && !result.notAvailable,
      );
      if (manual && hardFailures.length === results.length)
        await vscode.window.showErrorMessage(
          `Personal billing reports could not be retrieved: ${hardFailures.map((result) => result.error).join("; ")}`,
        );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.output.appendLine(
        `[${new Date().toISOString()}] Personal billing refresh failed: ${message}`,
      );
      if (manual)
        await vscode.window.showErrorMessage(
          `Copilot personal billing: ${message}`,
        );
    } finally {
      this.personalBillingRefreshing = false;
    }
  }

  /**
   * Fetches current enterprise AI-credit and premium-request usage via GitHub's
   * documented billing API, scoped to the signed-in individual user so it
   * reflects their personal credit usage rather than the whole enterprise.
   * The API reports usage, not configured budgets.
   *
   * Uses the same GitHub account (provider/host) configured for personal
   * usage tracking, since the enhanced billing platform is only available
   * on the enterprise's own GitHub host (github.com, or a GHE.com
   * data-residency host) — never a GitHub Enterprise Server appliance host.
   *
   * @param {boolean} manual - Whether to show interactive authentication/errors.
   */
  async refreshEnterpriseBilling(manual) {
    if (this.billingRefreshing) return;
    const config = this.context.globalState.get(ENTERPRISE_BILLING_KEY);
    if (!config || !config.enterprise) return;

    this.billingRefreshing = true;
    try {
      const account = this.context.globalState.get(ACCOUNT_KEY);
      if (!account)
        throw new Error(
          "Choose an account using Copilot Usage Monitor: Configure Account before configuring enterprise billing.",
        );
      if (
        account.provider === "github-enterprise" &&
        !isGheDotComHost(account.host)
      )
        throw new Error(
          `Enterprise billing reports are a GitHub Enterprise Cloud feature and are not available on GitHub Enterprise Server hosts such as ${account.host}.`,
        );

      const session = await this.getSession(account.provider, manual, [
        "read:enterprise",
      ]);
      if (!session)
        throw new Error(
          `No ${account.provider === "github" ? "GitHub.com" : account.host} session with enterprise access is available. Sign in with an account authorized to view enterprise billing.`,
        );
      const user = session.account && session.account.label;

      const types = ["ai_credit", "premium_request"];
      const results = await Promise.all(
        types.map(async (type) => {
          try {
            return {
              type,
              report: await getEnterpriseBillingUsage(
                session.accessToken,
                config.enterprise,
                type,
                { host: account.host, user, output: this.output },
              ),
            };
          } catch (error) {
            return {
              type,
              error: error && error.message ? error.message : String(error),
              notAvailable: !!(error && error.notAvailable),
            };
          }
        }),
      );
      const reports = { ...(config.reports || {}) };
      const errors = {};
      for (const result of results) {
        if (result.report && user && !result.report.scopedToUser) {
          this.output.appendLine(
            `[${new Date().toISOString()}] Enterprise ${result.type} billing report: per-user scoping for "${user}" was unavailable (HTTP 404), showing enterprise-wide usage instead.`,
          );
        }
        if (result.report) {
          reports[result.type] = {
            timePeriod: result.report.timePeriod,
            usageItems: result.report.usageItems,
            scopedToUser: result.report.scopedToUser,
            fetchedAt: new Date().toISOString(),
          };
          errors[result.type] = null;
        } else {
          errors[result.type] = {
            message: result.error,
            notAvailable: result.notAvailable,
          };
          this.output.appendLine(
            `[${new Date().toISOString()}] Enterprise ${result.type} billing report ${result.notAvailable ? "not available" : "failed"}: ${result.error}`,
          );
        }
      }
      const scopedToUser = Object.values(reports).some(
        (r) => r && r.scopedToUser,
      );
      const next = {
        enterprise: config.enterprise,
        user: scopedToUser ? user : undefined,
        fetchedAt: new Date().toISOString(),
        reports,
        errors,
      };
      await this.context.globalState.update(ENTERPRISE_BILLING_KEY, next);
      if (this.panel && !this.panel.disposed)
        this.panel.webview.html = buildDashboardHtml(
          this.context.globalState.get(HISTORY_KEY, []),
          this.context.globalState.get(LATEST_KEY, null),
          this.cfg(),
          next,
          this.context.globalState.get(PERSONAL_BILLING_KEY),
        );

      const hardFailures = results.filter(
        (result) => result.error && !result.notAvailable,
      );
      if (manual && hardFailures.length === results.length)
        await vscode.window.showErrorMessage(
          `Enterprise billing reports could not be retrieved: ${hardFailures.map((result) => result.error).join("; ")}`,
        );
      else if (manual && hardFailures.length)
        await vscode.window.showWarningMessage(
          `Some enterprise billing reports could not be retrieved: ${hardFailures.map((result) => result.error).join("; ")}`,
        );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.output.appendLine(
        `[${new Date().toISOString()}] Enterprise billing refresh failed: ${message}`,
      );
      const latest = this.context.globalState.get(ENTERPRISE_BILLING_KEY);
      await this.context.globalState.update(ENTERPRISE_BILLING_KEY, {
        ...latest,
        errors: {
          ...(latest && latest.errors),
          authorization: message,
        },
      });
      if (this.panel && !this.panel.disposed)
        this.panel.webview.html = buildDashboardHtml(
          this.context.globalState.get(HISTORY_KEY, []),
          this.context.globalState.get(LATEST_KEY, null),
          this.cfg(),
          this.context.globalState.get(ENTERPRISE_BILLING_KEY),
          this.context.globalState.get(PERSONAL_BILLING_KEY),
        );
      if (manual)
        await vscode.window.showErrorMessage(
          `Copilot enterprise billing: ${message}`,
        );
    } finally {
      this.billingRefreshing = false;
    }
  }

  /**
   * Fetches the latest Copilot usage, persists it, and refreshes the status
   * bar, output log, dashboard panel, and budget notifications.
   *
   * @param {boolean} manual - Whether this refresh was explicitly requested
   *   by the user (enables interactive account setup and error dialogs).
   */
  async refresh(manual) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      let account = this.context.globalState.get(ACCOUNT_KEY);
      if (!account) {
        if (!manual)
          throw new Error(
            "Choose an account using Copilot Usage Monitor: Configure Account.",
          );
        const selected = await vscode.window.showQuickPick(
          [
            {
              label: "$(github) GitHub.com",
              description: "Regular GitHub account",
              provider: "github",
              host: "github.com",
            },
            {
              label: "$(server) GitHub Enterprise",
              description: "GHE.com or GHES account",
              provider: "github-enterprise",
            },
          ],
          { placeHolder: "Select the account to monitor" },
        );
        if (!selected) return;
        let host = selected.host;
        if (selected.provider === "github-enterprise") {
          const entered = await vscode.window.showInputBox({
            prompt: "GitHub Enterprise hostname",
            placeHolder: "company.ghe.com",
            ignoreFocusOut: true,
            validateInput: (v) =>
              validEnterpriseHost(v)
                ? null
                : "Enter a hostname only, e.g. company.ghe.com",
          });
          if (!entered) return;
          host = normalizeHost(entered);
          await vscode.workspace
            .getConfiguration("github-enterprise")
            .update(
              "uri",
              `https://${host}`,
              vscode.ConfigurationTarget.Global,
            );
        }
        account = { provider: selected.provider, host };
        await this.context.globalState.update(ACCOUNT_KEY, account);
      }
      let session = await this.getSession(account.provider, manual);
      if (!session)
        throw new Error(
          `No ${account.provider === "github" ? "GitHub.com" : "GitHub Enterprise"} session found. Use Configure Account to sign in.`,
        );
      const url =
        account.provider === "github"
          ? "https://api.github.com/copilot_internal/user"
          : `https://api.${account.host}/copilot_internal/user`;
      const data = await getJson(
        url,
        session.accessToken,
        "2022-11-28",
        this.output,
      );
      const parsed = parseUsage(data);
      if (!parsed)
        throw new Error(
          "The Copilot response did not contain a recognizable credit counter. The internal endpoint may have changed.",
        );
      const now = new Date(),
        normalized = normalizeSnapshot(parsed, now);
      const history = this.context.globalState.get(HISTORY_KEY, []);
      const latest = this.context.globalState.get(LATEST_KEY, null);
      const cycleId =
        normalized.resetDate || (latest && latest.cycleId) || "unknown";
      const sample = {
        ts: now.toISOString(),
        localDate: localDateKey(now),
        cycleId,
        used: normalized.used,
        entitlement: normalized.entitlement,
        remaining: normalized.remaining,
        unlimited: normalized.unlimited,
        quotaId: normalized.quotaId,
        quotaLabel: normalized.quotaLabel,
        buckets: normalized.buckets,
        resetDate: normalized.resetDate,
        plan: normalized.plan,
        provider: account.provider,
        host: account.host,
      };
      const next = appendSample(history, sample);
      await this.context.globalState.update(HISTORY_KEY, next);
      await this.context.globalState.update(LATEST_KEY, sample);
      await this.context.globalState.update(LAST_ERROR_KEY, null);
      this.updateStatus(sample);
      this.output.appendLine(
        `[${now.toISOString()}] ${account.host}: ${sample.used} credits used${sample.entitlement == null ? "" : ` / ${sample.entitlement}`}`,
      );
      this.checkBudgetCrossings(next, sample);
      if (this.panel && !this.panel.disposed)
        this.panel.webview.html = buildDashboardHtml(
          next,
          sample,
          this.cfg(),
          this.context.globalState.get(ENTERPRISE_BILLING_KEY),
          this.context.globalState.get(PERSONAL_BILLING_KEY),
        );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      await this.context.globalState.update(LAST_ERROR_KEY, {
        message,
        ts: new Date().toISOString(),
      });
      this.output.appendLine(
        `[${new Date().toISOString()}] Refresh failed: ${message}`,
      );
      this.setStatus(
        "$(github) Copilot: ⚠",
        `**Refresh failed**\n\n${message}`,
      );
      if (manual)
        await vscode.window.showErrorMessage(
          `Copilot Usage Monitor: ${message}`,
        );
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Shows a one-time warning notification the first time usage crosses the
   * 80% and 100% thresholds of each configured local budget period.
   *
   * @param {import("./usage/model").UsageSample[]} history - Updated usage history.
   * @param {import("./usage/model").UsageSample} sample - The sample just recorded.
   */
  checkBudgetCrossings(history, sample) {
    const daily = Number(this.cfg().get("dailyBudget", 0)) || 0,
      weekly = Number(this.cfg().get("weeklyBudget", 0)) || 0,
      monthly = Number(this.cfg().get("monthlyBudget", 0)) || 0;
    const usage = usageSummary(history, sample);
    for (const [label, budget, used] of [
      ["Daily", daily, usage.today],
      ["Weekly", weekly, usage.week],
      ["Monthly", monthly, usage.month],
    ]) {
      if (budget <= 0) continue;
      const key = `budgetNotice.${label.toLowerCase()}.${budgetPeriodKey(label, sample)}`;
      const pct = used / budget;
      const old = this.context.globalState.get(key, 0);
      const threshold = pct >= 1 ? 2 : pct >= 0.8 ? 1 : 0;
      if (threshold > old) {
        this.context.globalState.update(key, threshold);
        vscode.window.showWarningMessage(
          `Copilot ${label.toLowerCase()} usage is ${Math.round(pct * 100)}% of your local budget (${formatNumber(used)} / ${formatNumber(budget)}).`,
        );
      }
    }
  }

  /** Renders the status bar from the last stored sample, or a placeholder when none exists. */
  updateStatusFromStored() {
    const latest = this.context.globalState.get(LATEST_KEY, null);
    if (latest) this.updateStatus(latest);
    else
      this.setStatus("$(github) Copilot: —", "No Copilot usage recorded yet.");
  }

  /**
   * Updates the status bar text, background color, and hover tooltip from a
   * usage sample.
   *
   * @param {import("./usage/model").UsageSample} sample - The sample to render.
   */
  updateStatus(sample) {
    const history = this.context.globalState.get(HISTORY_KEY, []);
    const { tooltip, worstState } = buildTooltip(sample, history, this.cfg());

    this.status.backgroundColor =
      worstState === "danger"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : worstState === "warning"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;

    const quotaKnown =
      Number.isFinite(sample.entitlement) && sample.entitlement > 0;
    this.setStatus(
      `$(github) Copilot: ${formatNumber(sample.used)}${sample.remaining != null && quotaKnown ? ` · ${formatNumber(sample.remaining)} left` : ""}`,
      tooltip,
    );
  }

  /**
   * Sets the status bar item's text and tooltip, and shows/hides it per
   * configuration.
   *
   * @param {string} text - The status bar item's text (may include codicons).
   * @param {string | import("vscode").MarkdownString} tooltip - The hover tooltip.
   */
  setStatus(text, tooltip) {
    this.status.text = text;
    this.status.tooltip = tooltip;
    if (this.cfg().get("showInStatusBar", true)) this.status.show();
    else this.status.hide();
  }

  /** Opens (or reveals and refreshes) the usage dashboard webview panel. */
  openDashboard() {
    const history = this.context.globalState.get(HISTORY_KEY, []);
    const latest = this.context.globalState.get(LATEST_KEY, null);
    if (!this.panel || this.panel.disposed) {
      this.panel = vscode.window.createWebviewPanel(
        `${NS}.dashboard`,
        "Copilot Usage Monitor",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.webview.onDidReceiveMessage(
        (message) => {
          if (message.command === "refresh") this.refreshAll(true);
          if (message.command === "budgets") this.configureBudgets();
          if (message.command === "account") this.configureAccount();
          if (message.command === "enterpriseBilling")
            this.configureEnterpriseBilling();
        },
        undefined,
        this.context.subscriptions,
      );
      this.panel.onDidDispose(
        () => {
          this.panel = undefined;
        },
        null,
        this.context.subscriptions,
      );
    }
    this.panel.webview.html = buildDashboardHtml(
      history,
      latest,
      this.cfg(),
      this.context.globalState.get(ENTERPRISE_BILLING_KEY),
      this.context.globalState.get(PERSONAL_BILLING_KEY),
    );
    this.panel.reveal(vscode.ViewColumn.One);
  }

  /** Prompts for and saves daily/weekly/monthly local budget thresholds. */
  async configureBudgets() {
    const validate = (v) =>
      Number.isFinite(Number(v)) && Number(v) >= 0
        ? null
        : "Enter a non-negative number.";
    const daily = await vscode.window.showInputBox({
      prompt: "Daily local usage budget (credits; 0 disables)",
      value: String(this.cfg().get("dailyBudget", 0)),
      validateInput: validate,
    });
    if (daily === undefined) return;
    const weekly = await vscode.window.showInputBox({
      prompt: "Weekly local usage budget (credits; 0 disables)",
      value: String(this.cfg().get("weeklyBudget", 0)),
      validateInput: validate,
    });
    if (weekly === undefined) return;
    const monthly = await vscode.window.showInputBox({
      prompt: "Monthly local usage budget (credits; 0 disables)",
      value: String(this.cfg().get("monthlyBudget", 0)),
      validateInput: validate,
    });
    if (monthly === undefined) return;
    await this.cfg().update(
      "dailyBudget",
      Number(daily),
      vscode.ConfigurationTarget.Global,
    );
    await this.cfg().update(
      "weeklyBudget",
      Number(weekly),
      vscode.ConfigurationTarget.Global,
    );
    await this.cfg().update(
      "monthlyBudget",
      Number(monthly),
      vscode.ConfigurationTarget.Global,
    );
    this.updateStatusFromStored();
    vscode.window.showInformationMessage(
      "Local Copilot usage budgets updated.",
    );
  }

  /** Clears locally stored usage history after user confirmation. */
  async resetHistory() {
    const answer = await vscode.window.showWarningMessage(
      "Delete locally stored Copilot usage history? This does not change GitHub usage.",
      { modal: true },
      "Delete History",
    );
    if (answer !== "Delete History") return;
    await this.context.globalState.update(HISTORY_KEY, []);
    await this.context.globalState.update(LATEST_KEY, null);
    this.updateStatusFromStored();
    if (this.panel && !this.panel.disposed)
      this.panel.webview.html = buildDashboardHtml(
        [],
        null,
        this.cfg(),
        this.context.globalState.get(ENTERPRISE_BILLING_KEY),
        this.context.globalState.get(PERSONAL_BILLING_KEY),
      );
    vscode.window.showInformationMessage(
      "Copilot Usage Monitor history cleared.",
    );
  }
}

module.exports = { UsageMonitor };
