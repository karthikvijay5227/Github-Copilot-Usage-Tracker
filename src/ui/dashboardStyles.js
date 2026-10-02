"use strict";

/**
 * CSS for the dashboard webview panel. Kept as a standalone module so the
 * webview markup in {@link module:ui/dashboard} stays focused on structure.
 * Uses VS Code theme CSS variables so the dashboard matches the active theme.
 *
 * @type {string}
 */
const DASHBOARD_CSS = `
:root{color-scheme:light dark}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1100px;margin:auto}
h1{font-size:24px;margin:0 0 6px}
.muted,small{color:var(--vscode-descriptionForeground)}
.sub{margin-bottom:22px;color:var(--vscode-descriptionForeground)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:18px 0}
.card{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:16px;background:var(--vscode-sideBar-background)}
.label{font-size:12px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.06em}
.value{font-size:25px;font-weight:650;margin:8px 0}
.progress{height:10px;border-radius:10px;background:var(--vscode-progressBar-background);overflow:hidden;margin:12px 0 5px}
.progress span{display:block;height:100%;border-radius:10px}
.ok{background:#3ca66b}
.warning{background:#d6a343}
.danger{background:#d9534f}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:var(--vscode-descriptionForeground)}
.dot.ok{background:#3ca66b}
.dot.warning{background:#d6a343}
.dot.danger{background:#d9534f}
.section{margin-top:26px}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{text-align:left;padding:10px;border-bottom:1px solid var(--vscode-panel-border)}
th{color:var(--vscode-descriptionForeground);font-weight:600}
.notice{border-left:3px solid var(--vscode-textLink-foreground);padding:10px 14px;background:var(--vscode-textBlockQuote-background);margin-top:18px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}
button{border:1px solid var(--vscode-button-border,transparent);border-radius:5px;padding:7px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}
@media(max-width:600px){body{padding:14px}.value{font-size:21px}}
`;

module.exports = { DASHBOARD_CSS };
