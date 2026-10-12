# Copilot Usage Monitor

A VS Code extension that tracks GitHub Copilot usage from multiple sources — your personal quota, documented GitHub billing reports, and your own local chat session logs — and surfaces them in the status bar and a dashboard.

## Features

- GitHub.com and GitHub Enterprise account selection, with quota tracking that adapts to your plan (Free/Pro chat & completions, Business/Enterprise premium requests, unlimited seats)
- Status bar summary with a modern hover tooltip (status dots, progress bars, budget status)
- Local daily/weekly/monthly usage budgets with one-time threshold notifications
- Documented GitHub billing reports (AI-credit and premium-request usage) for both enterprises and individually billed personal plans
- Local chat session token usage — parses VS Code's own chat session logs for this workspace to show per-prompt token counts, model, and credits, grouped by chat session
- CSV export (Excel-compatible) for both GitHub usage history and local chat session usage
- Locally retained usage history

## Setup

1. Install the VSIX.
2. Run **Copilot Usage Monitor: Configure Account** from the Command Palette. Choose GitHub.com or GitHub Enterprise (for Enterprise, enter the hostname, e.g. `company.ghe.com`, and complete VS Code sign-in).
3. Run **Copilot Usage Monitor: Configure Budgets** to set optional local alert thresholds (daily/weekly/monthly).
4. Optional — to see official GitHub billing reports:
   - Run **Copilot Usage Monitor: Configure Enterprise Billing** and enter the enterprise slug, for enterprise-billed usage.
   - Personal (individually billed) billing reports are fetched automatically using the account configured in step 2 — no separate setup needed.
5. Click the status bar item (or run **Copilot Usage Monitor: Open Dashboard**) to see everything in one place.

## Detailed workflow

### On activation (`src/extension.js` → `UsageMonitor.start()`)

The extension creates one `UsageMonitor` ([usageMonitor.js](src/usageMonitor.js)) that owns the status bar item, the dashboard panel, and a single polling timer. On activation and on every poll tick (`copilotUsageMonitor.pollMinutes`, default 15 min, clamped 5-120) it kicks off four independent, non-blocking refreshes:

| Refresh                      | Source                                 | What it does                                                                |
| ---------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `refresh()`                  | `copilot_internal/user` (undocumented) | Your live Copilot quota snapshot — chat/completions/premium-request buckets |
| `refreshEnterpriseBilling()` | documented enterprise billing API      | Only runs if an enterprise slug is configured                               |
| `refreshPersonalBilling()`   | documented personal billing API        | Runs automatically using the configured account                             |
| `refreshChatSessionUsage()`  | local `chatSessions/*.jsonl` logs      | Runs in the background so it's usually ready before you open the dashboard  |

### Personal quota tracking (`refresh()` → `src/github/api.js#parseUsage`)

Calls `copilot_internal/user` (`api.github.com`, or `api.<host>` for GitHub Enterprise) and reads `quota_snapshots`, which contains multiple buckets (`premium_interactions`, `chat`, `completions`, ...) — which ones are actually meaningful depends on your plan. `parseUsage` picks a "primary" bucket: `premium_interactions` when it's active for your plan (has quota, is unlimited, or has usage), otherwise the most-utilized bucket that is (e.g. `chat` for Free/Pro plans without premium request access). The result — including `unlimited`, `quotaId`/`quotaLabel`, and the full per-bucket breakdown — is stored as a `UsageSample` ([usage/model.js](src/usage/model.js)) and appended to history (`appendSample`, capped at ~2000 entries, collapsing near-duplicate samples).

### Status bar & tooltip (`updateStatus()` → `src/ui/tooltip.js`)

Renders a Markdown tooltip: the primary quota with a 🟢/🟡/🔴 status dot and a block-style progress bar (or "Unlimited" when uncapped), any other active quota buckets, and the three configured local budgets (today/week/month) against `usageSummary()` deltas computed from history. The status bar background turns yellow/red when a budget crosses 80%/100% (`checkBudgetCrossings`, which also fires a one-time `showWarningMessage`).

### Documented billing reports (`src/github/api.js#getEnterpriseBillingUsage` / `#getUserBillingUsage`)

These call GitHub's REST billing endpoints (`/enterprises/{enterprise}/settings/billing/{ai_credit|premium_request}/usage` and the per-user equivalent), which is a separate, official API from the quota endpoint above — it reports billed usage amounts, not a live quota or remaining balance. Enterprise-scoped requests first try filtering by the signed-in user (`?user=`), falling back to the unscoped enterprise-wide report on `HTTP 404`. A persistent `HTTP 404` after that fallback (e.g. the report type doesn't apply to your plan) is treated as "not available" — shown as a quiet note in the dashboard, not an error popup. Requires an authenticated session with the `read:enterprise` scope in addition to your normal sign-in.

### Local chat session usage (`src/chatlogs/sessionStore.js`)

VS Code's own chat feature persists every chat session as an append-only JSON-patch log at `workspaceStorage/<hash>/chatSessions/<session-id>.jsonl` (a sibling of this extension's own `context.storageUri`, which is how the folder is located without hardcoding any path). `collectChatSessionUsage()` replays each file's patches (`kind:0` = initial snapshot, `kind:1` = scalar set, `kind:2` = array append) to reconstruct, per request: `promptTokens`, `completionTokens`, `model`, `copilotCredits`, response `elapsedMs`, and the session's `customTitle` plus a cleaned prompt snippet (`<attachments>` blocks stripped, truncated). `refreshChatSessionUsage()` reports live progress (throttled to ~10 updates) so the dashboard shows a "Scanning… N / total" state with a progress bar instead of sitting silent, and always keeps the Rescan/Export buttons visible (disabled while scanning). This relies on an **undocumented, internal VS Code format** that may change between versions, and only covers chat used in VS Code for the current workspace folder (not other workspaces, github.com web chat, or CLI).

### Dashboard (`src/ui/dashboard.js`, opened via `openDashboard()`)

A webview panel rendering: quota summary cards, a full quota-bucket breakdown table, personal/enterprise billing report sections, the local chat session usage section (summary cards, per-model table, and one collapsed `<details>` block per chat session — expand to see that session's prompt-by-prompt table), and the daily usage history table. Buttons post messages back to `UsageMonitor` (`refresh`, `budgets`, `account`, `enterpriseBilling`, `exportCsv`, `refreshChatUsage`, `exportChatUsage`), which re-renders the same panel (`renderPanel()`) after each action rather than reopening it.

### Exporting data (`src/exports/csv.js`)

- **Export Usage History (CSV)** — one row per day: estimated used, cumulative counter, quota, plan, host.
- **Export Local Chat Session Token Usage (CSV)** — one row per prompt: chat session title, cleaned prompt text, model, prompt/completion/total tokens, credits, elapsed seconds (plus the raw session/request IDs at the end for traceability).

Both prompt a native save dialog and offer to open the resulting file (Excel-compatible).

## Notes

Personal quota tracking uses GitHub's internal `copilot_internal/user` endpoint, which is not a stable public API and may change.

Billing reports use GitHub's documented [billing usage API](https://docs.github.com/en/rest/billing/usage?apiVersion=2026-03-10) (API version `2026-03-10`). They require billing-read access and return billed usage quantities/amounts; they do not expose a configured budget or pooled remaining-credit balance, and some report types may simply not apply to your plan.

Local chat session token usage depends on VS Code's internal, undocumented chat storage format, scoped to the current workspace only.

The extension does not read credential files or collect prompts/source code for transmission anywhere; local chat log parsing stays on-disk and local to your machine.

Daily/weekly/monthly usage are estimates derived from counter changes between collected snapshots. Usage while VS Code is closed, and usage before the first sample of a day, may not be attributed accurately. Budgets only trigger local notifications; they do not limit usage on GitHub.

Settings Sync carries your configured account (provider/host) across machines/profiles that have it enabled; it never stores your auth token (VS Code's authentication providers manage that).

## Package

Run your existing packaging script (`npm run package`) from the extension project directory.
