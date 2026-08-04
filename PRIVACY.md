# Privacy Policy — AI Agent Notifier

_Last updated: 2026-08-04_

**AI Agent Notifier does not collect, store, transmit, or sell any user
data.** It has no backend server, no analytics, and no network
communication of any kind beyond your own computer.

## What the extension does

AI Agent Notifier is a Chrome extension paired with a small companion
program ("host") that you install and run locally. The host listens for
hook events from AI coding agents (Claude Code, Cursor, GitHub Copilot CLI,
OpenAI Codex CLI) running on your machine, and the extension shows a
desktop notification or badge when an agent needs your attention.

## Data collection

None. Specifically:

- The extension requests only the `nativeMessaging`, `notifications`, and
  `alarms` Chrome permissions. It does not request `tabs`, `scripting`,
  `host_permissions`, or any permission that would let it read page
  content, browsing history, or any other site data.
- All communication happens over `chrome.runtime.connectNative` (Chrome's
  native messaging API) to a process running on `127.0.0.1` — your own
  computer. The extension's source contains no `fetch`, `XMLHttpRequest`,
  or any other outbound network call.
- The host process only talks to a local TCP socket
  (`127.0.0.1:8765`), protected by a random token generated on first run
  and stored in your local user profile. It never opens a connection to
  the internet.
- Event content it does process — tool names, working-directory paths,
  short summaries of what an agent is asking or has finished — stays on
  your machine. It is written only to local log files
  (`%APPDATA%\ai-agent-notifier\*.log` on Windows, equivalent app-data
  paths on macOS/Linux) for your own troubleshooting, and is never sent
  anywhere.
- The popup's "Скопировать диагностику" ("Copy diagnostics") button copies
  a local log excerpt to your clipboard, on your explicit click, for you
  to paste yourself (e.g. into a GitHub issue) if you choose to. Nothing
  is uploaded automatically.
- There are no accounts, no sign-in, and no persistent identifiers tied to
  you or your device beyond the random local auth token described above.

## Data storage

Settings (which notification channels are enabled, timeouts, per-project
"do not disturb" state) and logs are stored only in your local user
profile directory. Nothing is synced, backed up, or shared with any
third party, including the developer.

## Third parties

None. No analytics SDKs, crash reporters, ad networks, or other
third-party services are integrated into the extension or the host.

## Changes to this policy

If this policy ever changes (for example, if an optional future feature
introduces a network-connected notification channel), this document will
be updated first, the change will be described in the project's
[README](README.md), and the version history will remain visible in the
project's [GitHub repository](https://github.com/NickitaCh/ai-agent-notifier).

## Contact

This is an independent, open-source project. Questions or concerns can be
raised via [GitHub Issues](https://github.com/NickitaCh/ai-agent-notifier/issues)
on the project repository.
