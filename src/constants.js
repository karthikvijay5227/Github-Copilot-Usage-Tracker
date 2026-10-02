"use strict";

/** Configuration and command namespace used throughout the extension. */
const NS = "copilotUsageMonitor";

/** `globalState` key storing the array of historical usage samples. */
const HISTORY_KEY = "history.v1";

/** `globalState` key storing the most recent usage sample. */
const LATEST_KEY = "latest.v1";

/** `globalState` key storing the last refresh error, if any. */
const LAST_ERROR_KEY = "lastError.v1";

/** `globalState` key storing the configured GitHub account (provider + host). */
const ACCOUNT_KEY = "account.v1";

/** `globalState` key storing the latest documented enterprise billing reports. */
const ENTERPRISE_BILLING_KEY = "enterpriseBilling.v1";

/** `globalState` key storing the latest documented personal (individually billed) Copilot billing reports. */
const PERSONAL_BILLING_KEY = "personalBilling.v1";

/** Identifier for the status bar item contributed by this extension. */
const STATUSBAR_ID = "copilotUsageMonitor.status";

module.exports = {
  NS,
  HISTORY_KEY,
  LATEST_KEY,
  LAST_ERROR_KEY,
  ACCOUNT_KEY,
  ENTERPRISE_BILLING_KEY,
  PERSONAL_BILLING_KEY,
  STATUSBAR_ID,
};
