# Privacy Policy — AI Agent Notifier

_Last updated: 2026-08-12_

**Out of the box, AI Agent Notifier sends nothing anywhere.** The extension
and its local companion program talk only to each other, on your own
machine.

One feature is different, and this policy exists mostly to describe it: the
optional **phone channel**, which forwards notifications to your phone. It
is off by default. Turning it on means notification content leaves your
computer — necessarily, since that is what the feature does. Everything
below spells out exactly what leaves, to whom, and what is kept.

## What the software does

AI Agent Notifier pairs a Chrome extension with a small companion program
(the "host") that you install and run locally. The host listens for hook
events from AI coding agents (Claude Code, Cursor, GitHub Copilot CLI,
OpenAI Codex CLI) running on your machine, and the extension shows a
desktop notification or badge when an agent needs your attention.

## Default configuration: local only

With the phone channel off (the default), all of the following hold:

- The extension requests only the `nativeMessaging`, `notifications`,
  `alarms`, and `storage` Chrome permissions. It does not request `tabs`,
  `scripting`, `host_permissions`, or any permission that would let it read
  page content, browsing history, or any other site data.
- The extension's own source contains no `fetch`, `XMLHttpRequest`, or any
  other outbound network call. Any network access the product makes is made
  by the host process, never by the extension.
- Extension and host communicate over `chrome.runtime.connectNative` and a
  TCP socket on `127.0.0.1:8765`, protected by a random token generated on
  first run and stored in your local user profile. The socket never accepts
  a connection from outside the machine.
- Event content — tool names, working-directory paths, short summaries of
  what an agent is asking or has finished — is written only to local log
  files (`%APPDATA%\ai-agent-notifier\*.log` on Windows, equivalent
  app-data paths on macOS and Linux), for your own troubleshooting.
- There are no accounts and no sign-in.

## The optional phone channel

You choose a provider in the extension popup. Nothing is sent until you do.
Whichever you choose, the message that leaves your machine contains: a
title saying an agent wants permission / asked a question / finished, the
project folder name or the session label you assigned, and the event's
short summary (typically the tool name and a one-line description of the
action, e.g. `Bash — rm -rf build/`). It does not contain file contents,
full command output, or credentials.

- **ntfy, Webhook (Discord/Slack), Pushover** — the message goes directly
  from your machine to the service you configured, using the URL or token
  you entered. Nothing passes through any server operated by this project.
  Those services' own privacy policies apply.
- **Telegram (your own bot)** — the message goes directly from your machine
  to Telegram's API using your own bot token. Telegram's privacy policy
  applies.
- **Telegram (shared bot)** — the message passes through a relay server
  operated by the developer of this project. See the next section.

## The shared-bot relay (`ai-agent-notify.ru`)

Choosing the shared bot means you do not have to create a Telegram bot of
your own; the cost is that a server run by this project sits in the middle.
It is a small Node.js service; its full source is in the `relay/` directory
of the project repository.

**Pairing** links your Telegram chat to your installation. The server
stores: your Telegram chat id, a random token it generates for your
installation, and the timestamp of pairing. It never receives or stores
your Telegram phone number, name, or contacts.

**Message delivery.** Each notification is received, forwarded to Telegram
for your chat, and discarded. Notification text is held in memory for the
duration of the request and is **not** written to the server's disk. Your
decision (Allow/Deny) travels back the same way. The message itself, of
course, remains in your Telegram chat, where Telegram stores it under
Telegram's own policy.

**Usage statistics** are recorded on the relay, and can be turned off with
the "Помогать статистикой" checkbox next to the shared-bot setting. When
on, each event records:

- what kind of event it was (`permission_request` / `task_done`), which
  agent it came from (Claude Code / Cursor / …), and the tool name (`Edit`,
  `Bash`, …);
- your operating system and its version, CPU architecture, host program
  version, and whether you installed the standalone executable or run it
  via Node.js;
- timestamps, counts, and — for permission requests — the outcome
  (allow / deny / no answer) and how long the answer took;
- a `uid`: a truncated salted SHA-256 hash of your installation token. It
  distinguishes one installation from another so that counts like
  "returning users" can be computed. It cannot be reversed into your token,
  and the salt is unique to the server, so the same token would hash
  differently elsewhere.

**Not recorded, with the checkbox on or off:** the event summary, the
working-directory path, command text, file contents, your Telegram chat id
in the statistics log, or your IP address.

Statistics files are kept for six months and then deleted automatically.
Turning the checkbox off stops new statistics; notifications keep working.

**Coverage note, for honesty about what these numbers mean:** statistics
exist only for shared-bot users. Local providers and local-only
installations never contact the server at all.

## Feedback sent through the bot

If you send `/feedback <text>` to the shared bot, the server stores your
message text, your Telegram chat id, and your Telegram username if you have
one, so that a reply can reach you. This happens only for messages you
explicitly send as feedback. Kept until the issue is resolved, then deleted.

## Diagnostics and issue reports

The popup's "Скопировать диагностику" button copies a local log excerpt to
your clipboard, on your click, for you to paste wherever you choose. The
"Сообщить о проблеме" button additionally opens a pre-filled GitHub issue
form in a new tab; nothing is submitted until you press GitHub's own submit
button, and you decide what to paste in. Nothing uploads automatically.

## Data storage

Settings (channel selection, provider credentials you entered, timeouts,
per-project "do not disturb" state) and logs are stored only in your local
user profile directory. They are not synced or backed up anywhere by this
software.

On the relay, the only stored data is what the sections above list:
pairing records, statistics (if enabled), and feedback messages you sent
deliberately.

## Third parties

- The extension and host integrate no analytics SDKs, crash reporters, or
  ad networks.
- If you enable a phone provider, that provider (ntfy, Discord, Slack,
  Pushover, or Telegram) receives your notifications and applies its own
  privacy policy.
- Nothing is sold, and nothing is shared with anyone else.

## Changes to this policy

Material changes will be made in this document first, described in the
project's [README](README.md), with the revision history remaining visible
in the [GitHub repository](https://github.com/NickitaCh/ai-agent-notifier).

## Contact

This is an independent, open-source project. Questions or concerns can be
raised via [GitHub Issues](https://github.com/NickitaCh/ai-agent-notifier/issues),
or by sending `/feedback` to the shared bot.
