"use strict";

const vscode = require("vscode");
const { NS } = require("./constants");
const { UsageMonitor } = require("./usageMonitor");

/**
 * Extension entry point. Creates the {@link UsageMonitor} and registers all
 * contributed commands.
 *
 * @param {import("vscode").ExtensionContext} context - The extension's activation context.
 */
function activate(context) {
  const monitor = new UsageMonitor(context);
  context.subscriptions.push(monitor);
  monitor.start();

  context.subscriptions.push(
    vscode.commands.registerCommand(`${NS}.refresh`, () =>
      monitor.refreshAll(true),
    ),
    vscode.commands.registerCommand(`${NS}.openDashboard`, () =>
      monitor.openDashboard(),
    ),
    vscode.commands.registerCommand(`${NS}.resetHistory`, () =>
      monitor.resetHistory(),
    ),
    vscode.commands.registerCommand(`${NS}.configureAccount`, () =>
      monitor.configureAccount(),
    ),
    vscode.commands.registerCommand(`${NS}.configureBudgets`, () =>
      monitor.configureBudgets(),
    ),
    vscode.commands.registerCommand(`${NS}.configureEnterpriseBilling`, () =>
      monitor.configureEnterpriseBilling(),
    ),
  );
}

/** Extension deactivation hook. Cleanup is handled via `context.subscriptions`. */
function deactivate() {}

module.exports = { activate, deactivate };
