# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chrome MV3 extension + local Node.js native-messaging host/daemon. Per-agent
hooks (Claude Code, Cursor, GitHub Copilot CLI, OpenAI Codex CLI) call a CLI
adapter, which normalizes the event and sends it to a persistent local daemon,
which routes it to the extension (Windows toast notification + toolbar badge).
Permission-request notifications carry Allow/Deny buttons whose click routes a
decision back through the same path into the still-running hook process, which
prints it on stdout so the agent can act on it — no trip to the terminal
needed. Not published to the Chrome Web Store yet (unpacked install only, see
README "Установка").

All comments and console/log output in this codebase are Russian — match that
style when editing existing files. English is fine for new standalone
material only if there's a strong reason to diverge.

## Commands (all run from `host/`)

```
npm install                # host deps
npm test                   # node:test — runs test/*.test.js
node --test test/router.test.js   # single test file
npm run daemon              # node src/daemon.js (foreground, for manual debugging)
npm run embed:extension     # regenerate src/embedded-extension.js from ../extension/
npm run register:windows -- <EXTENSION_ID> [chrome|edge|brave|chromium]
npm run register:unix -- <EXTENSION_ID> [chrome|edge|brave|chromium]
npm run build:win           # embed:extension + pkg -> dist/win/ai-agent-notifier.exe
npm run build:mac           # (untested — no macOS available to the author)
npm run build:linux         # (untested — no Linux available to the author)
```

The relay is a separate project with its own commands (run from `relay/`):

```
npm test                    # node:test — runs test/*.test.js
npm start                   # node src/server.js (needs BOT_TOKEN + WEBHOOK_SECRET)
npm run report              # bin/report.js — usage summary from the metrics files
node tools/seed-report-data.js <dir>   # synthetic data to eyeball the report
```

`node --test` treats **every** file under `test/` as a test file, not just
`*.test.js`. That is why the seed generator lives in `tools/` — inside
`test/` it ran on every `npm test` and failed as a broken test.

There is no linter configured anywhere in the repo (no eslint config, no
`.cursor/rules`, no `.github/copilot-instructions.md`) — don't invent lint
commands.

**`npm test` on a fresh clone requires `npm run embed:extension` first.**
`host/src/embedded-extension.js` is generated and gitignored; `test/installer.test.js`
imports `src/installer.js`, which does `require('./embedded-extension')` at
module load time, so the whole test run fails with a missing-module error
until that file exists. CI (`.github/workflows/test.yml`) does `npm ci` →
`npm run embed:extension` → `npm test`, in that order, on `windows-latest`
across Node 18.x/22.x — mirror that order locally.

The **extension has no build step**: it's loaded unpacked as-is from
`extension/` (`chrome://extensions` → Developer mode → Load unpacked). There's
no bundler, no transpilation, no npm project in `extension/` at all — the
files there run directly in the MV3 service worker / popup.

## Architecture

### Components and where agent-specific logic lives

- `host/bin/notify-agent*.js` — one adapter file per agent. This is the *only*
  place that knows a given agent's hook JSON schema. Each adapter parses
  stdin, builds a generic event (`{ id, type: 'permission_request'|'task_done',
  agent, tool, summary, cwd, sessionId, needsDecision?, ts }`), sends it to the
  daemon, and translates the daemon's decision back into whatever stdout shape
  that agent's hook protocol expects (Claude Code: `hookSpecificOutput.decision.behavior`;
  Cursor: `{permission: 'allow'|'deny'|'ask'}`). Adapters do not share code
  with each other beyond the generic `submitEvent()`/`ipc-client` transport —
  each duplicates its own small stdin/JSON-parsing helpers on purpose, so
  adapters stay independent and one agent's format quirks can't leak into
  another's file.
- `host/src/daemon.js` + `ipc-server.js` — the persistent "brain": a bare TCP
  server on `127.0.0.1:8765`. Fully agent-agnostic; only understands the
  generic event shape and the wire protocol below. Auto-started detached by
  any client that can't connect (see below), so it outlives the process that
  spawned it and survives Chrome being closed.
- `host/src/router.js` — event type → channel list (from `routing.json`),
  plus per-project snooze filtering and session-label resolution. Channels are
  looked up by `[module, methodName]` pairs, not bound function references
  (deliberately, so tests can monkey-patch a channel method after the module
  is loaded).
- `host/src/channels/extension-channel.js` — the *only* channel that actually
  talks to the browser. Badge and notification are not separate transports:
  both go out as the same `{type:'push', payload:{kind, event, ...}}` message
  over every registered bridge socket; `kind` (`'badge'`/`'notification'`)
  tells the extension how to render it. This module also owns the
  permission-decision wait/resolve map (`waitForDecision`/`resolveDecision`),
  keyed by event id.
- `host/src/channels/phone-channel.js` — sends to a per-user-configured
  provider (`settings.phone.provider`): `ntfy`, `webhook` (Discord/Slack,
  same body carries both `content` and `text` since each service ignores the
  field it doesn't recognize), `pushover`, `telegram` (own bot token +
  chat id, sends inline Allow/Deny buttons for actionable events), or
  `relay` (the shared bot — see `relay/` below). Same
  `send(event, settings)` interface as the other channels, so `router.js`
  doesn't know or care which provider is active. Errors are NOT swallowed
  here — they propagate up through `router.js`'s existing per-channel
  try/catch, and separately through `ipc-server.js`'s `test_phone` handler
  (used by the popup's "send test notification" button) so a bad token
  surfaces as a real error instead of a silent no-op.
- `host/src/telegram-poller.js` — the two-way half of the Telegram provider:
  a `getUpdates` long-polling loop (only active while
  `settings.phone.provider === 'telegram'`) that resolves permission
  decisions from inline-button taps via the *same*
  `extensionChannel.resolveDecision()` used for clicks in the extension —
  the daemon doesn't distinguish where a decision came from. Started
  fire-and-forget from `daemon.js` (an infinite loop, never awaited). Offset
  is persisted to `<configDir>/telegram-offset.txt` so a daemon restart
  doesn't replay old callback queries. Any non-callback update (e.g. the
  user just texting their own bot) has its `chat.id` logged to
  `daemon.log` — this is the documented way to discover `telegramChatId`
  for settings, since the daemon is already polling `getUpdates` itself and
  would otherwise silently consume the update before a manual browser check
  of the API could see it. This provider has no pairing flow — the user
  pastes their own bot token and chat id into settings. One-click pairing
  exists only for the shared bot, which needs a server because Telegram
  allows a single `getUpdates` listener per bot token; see `relay/`.
- `relay/` — a standalone service (its own `package.json`, deployed
  separately to a VPS, *not* part of the host build) backing
  `provider: 'relay'`, the shared Telegram bot. Plain `node:http`, no
  framework, no dependencies. Endpoints: `/pair/start`, `/pair/status`,
  `/telegram/webhook`, `POST /events` (fast ack) and
  `GET /events/:id/decision` (long-poll). The split between the last two is
  load-bearing, not stylistic: `router.js` dispatches channels sequentially
  with `await`, so a `send()` that blocked until the user tapped a button
  would stall the badge and notification channels behind it for minutes.
  State lives in flat JSON/ndjson files next to the process (`store.js`,
  `metrics.js`) — at this scale a database buys nothing and costs a moving
  part on a box shared with unrelated services.
- `host/src/client-info.js` — the OS/arch/host-version snapshot attached to
  each event sent through the relay, assembled from `platform.osInfo()`.
  The extension never reports this and must not start: it has no network
  code at all, and the host is the only component that reliably knows the
  OS. Gated by `settings.phone.relayMetrics` (default on).
- `host/src/native-bridge.js` — the actual registered Chrome native-messaging
  host executable. Chrome spawns it via stdio when the extension calls
  `connectNative()`. It is a dumb, stateless translator between Chrome's
  native-messaging wire format (4-byte little-endian length prefix + JSON on
  stdin/stdout) and the daemon's ndjson-over-TCP protocol — it holds no
  routing logic itself. It dies when Chrome closes the port; the daemon keeps
  running.
- `extension/background.js` — MV3 service worker. Holds the `connectNative`
  port, dispatches incoming pushes to `channels/badge-channel.js` /
  `channels/notification-channel.js`, forwards popup requests
  (`get_settings`/`update_settings`/`get_diagnostics`) to the daemon over the
  same native-messaging port, and relays notification button clicks back as
  `permission_response` messages. Uses `chrome.alarms` every 0.4 min as a
  keepalive/reconnect nudge since MV3 can suspend the service worker.

### End-to-end event flow (verified against code, not just the README diagram)

1. Agent hook fires → CLI adapter (`bin/notify-agent*.js`) reads stdin, builds
   the generic event.
2. Adapter calls `ipc-client.connect()`, which tries a raw TCP connect to
   `127.0.0.1:8765`; on failure it spawns `node src/daemon.js` detached
   (`stdio:'ignore'`, `child.unref()`) and retries the connection (15× / 200ms)
   until the daemon's listener is up.
3. On connect, the client's **first** line on the socket is always
   `{type:'auth', token}` (see auth mechanism below) — this happens before
   `submit_event`/`bridge_register`, for both CLI adapters and the
   native-bridge, since both go through the same `ipc-client.connect()`.
4. Adapter sends `{type:'submit_event', event}`. `ipc-server.js`
   (`handleSubmitEvent`) branches on `event.type`:
   - `permission_request` with `needsDecision:false` (e.g. Claude's
     `AskUserQuestion`) — dispatches and acks immediately, no waiting.
   - `permission_request` (normal) — subscribes to
     `extensionChannel.waitForDecision(event.id, permissionTimeoutMs)`
     *before* dispatching (to avoid losing a race with an instant click), then
     dispatches, then waits. Reply is `{type:'decision', id, decision}` where
     `decision` is `'allow'|'deny'|null` (`null` = timeout or extension not
     connected → fail-open, adapter prints nothing and the agent's own normal
     prompt takes over).
   - `task_done` — goes through `stop-debounce.js` first: delayed by
     `stopDebounceMs` (default 20s), and cancelled if any new event arrives
     for the same `sessionId` in the meantime (means the user already
     responded, so the stale "agent is done" notice would be noise).
   - anything else — dispatched and acked directly.
5. `router.js` checks `snoozeByProject[event.cwd]`, resolves
   `event.sessionLabel` from `sessionNames[event.sessionId]` if the user
   named that session in the popup, then calls `send(event, settings)` on
   every channel listed in `routing.json.rules[event.type]`.
6. `extension-channel.js` broadcasts `{type:'push', payload}` to every
   connected native-bridge socket (there is normally exactly one — one Chrome
   instance/profile — but the code supports more).
7. `native-bridge.js` receives the daemon's ndjson line, unwraps `push`
   payloads, and re-frames them as a native-messaging message on stdout for
   Chrome to deliver to `background.js`.
8. `background.js` renders via `BadgeChannel.show`/`NotificationChannel.show`.
   For an actionable permission request, the notification gets Allow/Deny
   buttons; `chrome.notifications.onButtonClicked` posts
   `{type:'permission_response', id: notificationId, decision}` back down the
   *same* native-messaging port.
9. That flows back: native-bridge → daemon (`ipc-server` case
   `'permission_response'`) → `extensionChannel.resolveDecision(id, decision)`
   → resolves the promise the adapter (step 4) is still awaiting → daemon
   replies `{type:'decision', ...}` to the adapter's socket → adapter prints
   the agent-specific decision JSON on stdout and exits.

The whole loop only works within `permissionTimeoutMs` (default 570000ms =
9.5 min, deliberately under Claude Code's 10-minute hook timeout ceiling): the
adapter process is still alive and blocked on step 4/9 the entire time. A
button click after that window is a no-op — the hook process is already gone
and the agent has fallen through to its own terminal prompt.

### The native-messaging + TCP-auth-token bridge (the non-obvious part)

There is **no special-cased transport for the extension** — `native-bridge.js`
is just another TCP client of the daemon, using the identical
`ipc-client.js`/auth handshake as every CLI adapter. The only thing that makes
it a "bridge" rather than a one-shot CLI call is a single extra message it
sends right after auth: `{type:'bridge_register'}`, which makes
`ipc-server.js` call `extensionChannel.registerBridge(socket)` and add that
socket to the module-level `bridges` Set — that's what makes it a broadcast
target for pushes. A CLI adapter's socket never sends `bridge_register`, so it
never joins that set; it just sends one `submit_event` and gets one reply.

Auth (`host/src/auth.js`): a random 24-byte hex token is generated on first
use by whichever process gets there first (daemon or a client — both call
`loadOrCreateToken()`), written to `<configDir>/auth-token` with `0600`
permissions. `ipc-server.js` treats the first line on any new socket as
mandatory: if it isn't `{type:'auth', token: <matching value>}`, the socket is
destroyed immediately, before any other message type is even considered. This
is a same-machine/same-user guard (stops other local processes from injecting
fake events or reading decisions), not a real ACL boundary — it explicitly
does not defend against another OS user account with read access to this
user's profile directory (documented as an accepted, intentional limitation).

Separately, there's a **protocol-version handshake** layered on top,
independent of auth: the extension sends `client_hello` with
`{protocolVersion, extensionVersion}` right after connecting;
`ipc-server.js` replies `host_hello` with `{protocolVersion, hostVersion}`
(`PROTOCOL_VERSION` in `host/src/constants.js`, currently `1`). A mismatch is
**only a warning** surfaced as a banner in the popup — it never blocks
communication. This exists because the extension auto-updates via the Chrome
Web Store while the host is updated manually (or via the standalone exe), so
the two can legitimately drift apart in version over time.

### Adding a new agent adapter

1. Create `host/bin/notify-agent-<agent>.js`. Copy the shape of
   `notify-agent-cursor.js` (single file handling multiple hook event types
   via a `hook_event_name`-style field) or `notify-agent.js` (Claude Code:
   separate `permission`/`done` subcommands) — whichever matches that agent's
   hook model. Implement your own stdin parsing / summarization / decision
   printing; don't try to share these with other adapters beyond
   `ipc-client.connect()` + `ndjson.js`'s `writeLine`/`createLineReader`.
2. Emit only the generic event shape
   (`id`/`type`/`agent`/`tool`/`summary`/`cwd`/`sessionId`/`needsDecision`/`ts`).
   Do not touch `daemon.js`, `router.js`, `extension-channel.js`, or anything
   under `extension/` — none of them should need to change.
3. Add a bin entry in `host/package.json` (`"bin"` map) and a case in
   `host/bin/aan.js`'s subcommand switch (for the standalone-exe path).
4. Add `<agent>-hooks/hooks.snippet.json` at the repo root with that agent's
   hook config fragment, following the existing `claude-hooks/`/`cursor-hooks/`/
   `copilot-hooks/`/`codex-hooks/` folders as templates.
5. If the agent has a notion of "agent is idle/done" distinct from permission
   requests, reuse `task_done` + the existing `stop-debounce.js` mechanism
   rather than inventing new debounce logic.

### Packaging and distribution — two paths, pick based on the target machine

**Dev / has Node.js already** (contributing, or installing for yourself on a
machine you control): `npm install` in `host/`, load `extension/` unpacked in
Chrome, then `node install/register-windows.js <EXTENSION_ID>` (or
`register-unix.js` on macOS/Linux). That script writes a small wrapper
(`native-host-launcher.bat` on Windows — Chrome can't spawn `.js` directly,
so it needs an executable to point at — or a `chmod +x` shebang script on
Unix) that runs `node src/native-bridge.js`, writes the Chrome native-host
manifest JSON, and registers it in `HKCU\...\NativeMessagingHosts\...`
(Windows, no admin needed) or the platform's manifest directory
(macOS/Linux). OS-specific paths live behind a single interface in
`host/src/platform/{windows,macos,linux}.js` (`configDir`,
`nativeHostManifestDir`, `registerNativeHost`, `unregisterNativeHost`),
selected by `platform/index.js` on `process.platform`. Everything above that
layer (daemon, router, channels, CLI, extension) is OS-agnostic by
construction — the transport is TCP on localhost specifically so it doesn't
need named pipes/unix sockets per OS.

**No Node.js on the target machine** (giving the tool to someone else, or
avoiding a Node install): `npm run build:win|mac|linux` in `host/`. This
first runs `embed:extension` (`host/scripts/embed-extension.js`), which
snapshots every file under `../extension/` into `host/src/embedded-extension.js`
as JS literals (text files inline as UTF-8 strings, binary/icons as base64) —
necessary because `pkg` only bundles files it can statically discover via
literal `require()` calls inside `host/`, and `extension/` is a sibling
directory outside that tree. Then `@yao-pkg/pkg` bundles `bin/aan.js` — the
single dispatcher entry point that replaces all five separate scripts behind
one binary, subcommand-selected (`aan daemon|bridge|notify|notify-cursor|
notify-copilot|notify-codex|register|unregister|install`) — into one exe
(~55MB, `node22-win-x64` confirmed working; if `pkg-fetch` can't find a
prebuilt Node for the target version it tries compiling from source, which
needs a full MSVC toolchain most machines don't have — switch the target
Node version in the `build:*` script instead of fixing that toolchain).
Running the resulting exe with **no arguments** (or `aan install`) runs
`host/src/installer.js`: it extracts the embedded extension files to
`%LOCALAPPDATA%\AI Agent Notifier\extension`, computes the extension's ID
*without* needing Chrome to show it — by replicating Chrome's own algorithm
(SHA-256 of the manifest's `key` field, first 16 bytes, each nibble mapped to
a letter `a`-`p`) against the fixed `"key"` baked into `extension/manifest.json`
— registers the native host automatically, and opens both
`chrome://extensions` and the extraction folder in Explorer. The only two
steps that remain genuinely manual are the two things Chrome deliberately
won't let any script do (its own defense against silent extension
installation): flipping on Developer Mode, and clicking "Load unpacked".
`install/register-standalone.js` (used by both `aan register` directly and by
`installer.js`) is the standalone-aware counterpart of
`register-windows.js`/`register-unix.js` — it can't use `__dirname` for the
launcher location (under `pkg` that points into the virtual snapshot, not a
real path), so it derives the wrapper's location from
`path.dirname(process.execPath)` instead. Both the dev path and the exe path
end up writing the *same* manifest shape and the *same kind* of thin wrapper
(`.bat`/`.sh`) — the only difference is whether that wrapper invokes
`node native-bridge.js` or `<exe> bridge`.

### Settings / routing (`routing.json`, `host/config/routing.default.json`)

Lives at `<configDir>/routing.json`, seeded from
`host/config/routing.default.json` on first daemon run, hand-editable, and
re-read on every event (no daemon restart needed). Also mutated live by the
extension popup via `get_settings`/`update_settings` messages relayed through
`background.js` → native-bridge → daemon (`applySettingsPatch` in
`ipc-server.js`, which does a shallow merge except for `rules` and the two
map-shaped fields `snoozeByProject`/`sessionNames`, both merged with JSON
Merge Patch semantics where a `null` value deletes that key rather than being
stored literally). Key fields: `rules` (event type → channel list),
`permissionTimeoutMs`, `stopDebounceMs`, `permissionExcludeTools` (manual,
explicit user override — "yes, Claude would ask, but I don't want a
notification for this tool anyway"; the *only* suppression mechanism left,
see below), `permissionInfoOnlyTools` (e.g. `AskUserQuestion` — shown as
an informational notification with no buttons, hook doesn't wait),
`snoozeByProject` (per-cwd, not global, so one noisy parallel session doesn't
mute another project), `sessionNames` (user-assigned labels resolved into
`event.sessionLabel` by the router so the extension never needs the whole
name map).

### There is no `permission_mode`-based blanket-allow check — on purpose, after three tries

`bin/notify-agent.js`'s `runPermission()` used to pre-filter events with an
`isBlanketlyAllowed()` helper (`host/src/claude-permissions.js`, now deleted)
before even the `PermissionRequest` hook was trusted. That helper went
through two prior designs, both eventually removed for the same root cause —
trying to independently re-derive "is a decision really needed" instead of
trusting that `PermissionRequest` itself only fires when Claude Code has
already decided one is needed:

1. Original: reimplemented `permissions.ask`/`allow` rule matching from
   `~/.claude/settings.json`, back when the adapter listened on `PreToolUse`
   (fires on *every* tool call, even pre-allowed ones). Silently swallowed
   two real prompts in practice (a compound Bash command inside a broad
   allow-rule; an `mkdir` under a path Claude Code separately flags as
   sensitive).
2. Narrowed to just checking `permission_mode`
   (`bypassPermissions`/`auto`/`dontAsk` → treated as "Claude never asks
   anything"; `acceptEdits` → only for `Edit`/`Write`/`NotebookEdit`/`MultiEdit`),
   with no `settings.json` reads at all. Also eventually caught swallowing a
   real prompt: a user-configured `ask` rule (e.g. `Bash(rm*)` in
   `~/.claude/settings.json`) overrides `auto` mode for that specific
   command — Claude Code correctly fires `PermissionRequest` and prompts in
   the terminal, but `permission_mode` in the hook payload still reports
   `"auto"`, so this check still called it blanket-allowed and exited
   silently before submitting the event.

Same failure shape both times: a coarser signal (a copied rule-matching
table, then just `permission_mode`) second-guessing the hook's own
already-accurate "a decision is needed" signal, and losing that bet in
practice, not in theory. The fix both times fixed the immediate case but
kept the same category of bug alive; the third occurrence retired the
category instead of patching it again. If you're tempted to add a
permission-mode or rule-matching pre-filter back, don't — trust
`PermissionRequest` completely. `permissionExcludeTools` remains the one
sanctioned suppression path, and it's opt-in and explicit rather than
inferred.

### Localization: three catalogs, one language

The UI ships in Russian, English and Spanish. Strings live in **three
separate catalog sets**, one per deploy unit, and they are deliberately not
shared:

- `extension/i18n/{ru,en,es}.json` + `extension/i18n.js` — popup, welcome
  page, Chrome toasts.
- `host/src/i18n/{ru,en,es}.json` + `host/src/i18n.js` — the phone-channel
  messages the host sends.
- `relay/src/i18n/{ru,en,es}.json` + `relay/src/i18n.js` — everything the
  shared bot says.

Same reasoning as `relay/src/telegram.js` duplicating `buildMessage`: browser
extension, local exe and VPS service update on entirely different schedules,
and their string sets barely overlap. A shared package for a few dozen
phrases would cost more than the duplication.

**What is shared is the chosen language, not the files.** `settings.locale`
in the daemon is the single source of truth: the host reads it for phone
messages and sends it with each event as `event.locale`, which the relay
stores on the user record and uses for bot replies. The extension mirrors it
into `chrome.storage.local` so the popup can render instantly and while the
daemon is down. On first run the extension resolves
`chrome.i18n.getUILanguage()` once and writes it there; after that only the
popup's language switcher changes it. The result is that all four surfaces
always speak the same language — which is the whole point, since a toast and
the phone notification for the same event sit side by side.

`chrome.i18n` is used for exactly one thing: `_locales/*/messages.json` for
the manifest's name and description, because a Web Store listing can't be
localized any other way. It is not used for the UI — it is bound to the
browser's language and cannot be overridden, which would defeat the switcher.

Adding a string: add the key to **every** catalog of that unit, then use it
(`data-i18n="key"` in markup, `t('key')` in JS). `host/test/i18n-catalogs.test.js`
fails on a key missing from one language, an unused key, a placeholder that
drifted between languages, and any visible Cyrillic left hardcoded in the
extension's markup. Adding a language means a new catalog in each unit plus
its code in `SUPPORTED` (three places) and a chip in the popup.

Two things stay unlocalized on purpose: the diagnostics text and the
pre-filled GitHub issue body (a technical artifact read by the maintainer —
one uniform English format keeps issues searchable), and the language names
in the switcher (each written in its own language, so you can find yours
without being able to read the current one).

### What the relay's metrics may and may not record

`relay/src/metrics.js` writes two things: a rollup inside each user's record
in `users.json` (for online use — tier limits will read it) and an
append-only `metrics-YYYY-MM.ndjson` (for analysis after the fact, since the
questions worth asking aren't all known yet). `bin/report.js` reads both.

The boundary is not a style preference and is repeated verbatim in
`PRIVACY.md`, in the Chrome Web Store privacy answers, and in the popup
copy, so changing it means changing all four:

- **Never recorded:** the event `summary`, `cwd` (a path into the user's
  filesystem), command text, file contents, `chatId` in the metrics log, or
  IP addresses. Notification text passes through the relay in memory and is
  never written to its disk.
- **Recorded:** event type, agent, tool name, OS/arch/host version,
  timestamps, counters, decision outcomes and latency, and `uid` — a
  truncated salted SHA-256 of the user's token, so installations can be told
  apart without being identifiable. The salt is per-server, so uids from two
  deployments can't be joined.
- Metrics must never break delivery. Every write goes through `safely()`,
  which logs and swallows: a full disk costs a statistics line, not a
  missed permission request. A missing file is not an error — `loadCounters`
  and `listLogFiles` treat `ENOENT` as empty rather than logging, because
  otherwise every fresh deploy screams on its first event.
- `feedback.js` is the deliberate exception: it *does* store `chatId` and
  username, because a support message you can't reply to is useless. It
  throws instead of swallowing, so the user can be told the message didn't
  save.

### Test coverage boundaries

`host/test/*.test.js` (plain `node:test`) covers pure logic only: router
dispatch/snooze rules, stop-debounce timing, `installer.js`'s extension-ID
computation, and a couple of
`ipc-server.js` pure-function cases (`mergeSnoozeByProject`, host-hello
building). The full CLI → daemon → native-bridge → extension path has no
automated coverage — it's exercised manually (see README "Как проверить, что
всё работает" for the manual verification steps: standalone daemon, raw CLI
event, popup connection status, then a real end-to-end permission prompt).

### Platform status

Development and all real verification happened on Windows; macOS/Linux code
paths (`host/src/platform/{macos,linux}.js`, `register-unix.js`) are
implemented against documented Chrome/OS behavior but not run on real
macOS/Linux machines. If touching those files, don't assume they've been
exercised — check the caveats in the README's "Установка (macOS/Linux)"
section. The Cursor adapter has been used live; the Copilot CLI adapter is
verified only with synthetic JSON events through the daemon (real Copilot CLI
invocation unverified); the Codex adapter is the least verified of all —
Codex's hook JSON schema isn't officially documented anywhere the author could
find, only inferred from a GitHub issue proposal, and the adapter is written
defensively (checks both camelCase and snake_case field name variants) as a
result. Codex also only honors "deny" (no "allow" effect, and no `done`/idle
signal exists for it).
