# Copilot Usage Monitor

A VS Code extension that samples GitHub Copilot usage and stores snapshots in VS Code global extension storage.

## Features
- GitHub.com and GitHub Enterprise account selection
- Status bar summary and detailed dashboard
- Local daily and weekly usage budgets
- Locally retained usage history
- Documented GitHub Enterprise AI-credit and premium-request usage reports

## Setup
1. Install the VSIX.
2. Run **Copilot Usage Monitor: Configure Account** from the Command Palette.
3. Choose GitHub.com or GitHub Enterprise. For Enterprise, enter the hostname (for example, `company.ghe.com`) and complete VS Code sign-in.
4. Run **Copilot Usage Monitor: Configure Budgets** to set optional local alert thresholds.
5. To view enterprise-billed usage, run **Copilot Usage Monitor: Configure Enterprise Billing** and enter the enterprise slug. Sign in to GitHub.com with an account that can view enterprise billing.

## Notes
Personal usage continues to use GitHub's internal `copilot_internal/user` endpoint, which is not a stable public API and may change. GitHub.com uses `api.github.com`; personal usage from GitHub Enterprise uses `api.<hostname>`.

Enterprise-billed AI-credit and premium-request usage is retrieved from GitHub's documented [enterprise billing usage API](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage?apiVersion=2026-03-10), using API version `2026-03-10`. These reports require enterprise billing access and return usage quantities and amounts; they do not expose the configured enterprise budget or pooled remaining-credit balance. The extension does not read credential files or collect prompts/source code.

Daily and weekly usage are estimates derived from counter changes between collected snapshots. Usage while VS Code is closed, and usage before the first sample of a day, may not be attributed accurately. Budgets only trigger local notifications; they do not limit usage on GitHub.

## Package
Run your existing packaging script (`npm run package`) from the extension project directory.
