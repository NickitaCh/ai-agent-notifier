# AI Agent Notifier

[![test](https://github.com/NickitaCh/ai-agent-notifier/actions/workflows/test.yml/badge.svg)](https://github.com/NickitaCh/ai-agent-notifier/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> ⚠️ Личный проект в разработке, пока не опубликован в Chrome Web Store —
> установка сейчас ручная (см. «Установка» ниже). Проверено вживую на
> Windows + Claude Code/Cursor; GitHub Copilot CLI и macOS/Linux — по
> документации, без реальной проверки (см. «Известные ограничения»).

Chrome-расширение (MV3) + локальный Node.js native host, которые ловят события
от хуков AI-агентов (сейчас: Claude Code, Cursor, GitHub Copilot CLI) и
показывают уведомления, когда агент вас ждёт — в первую очередь **системное
уведомление Windows**, которое пробивает alt-tab, плюс бейдж на иконке
расширения. Для запроса разрешения уведомление содержит кнопки «Разрешить» /
«Отклонить» — решение уходит обратно в хук, и агент продолжает работу без
похода в терминал. Настройки (какие каналы включены, таймауты, «не
беспокоить N часов») — прямо в popup расширения, без правки JSON руками.

## Архитектура

```
Claude Code hook  --> CLI notify-agent
Cursor hook       --> CLI notify-agent-cursor    }--> TCP 127.0.0.1:8765 --> демон (host/src/daemon.js)
Copilot CLI hook  --> CLI notify-agent-copilot                                мозг: настройки + роутинг
                                                                                    |
                                                                                    +--> extension-channel --(TCP, с auth-токеном)--> native-bridge (stdio, спавнится Chrome)
                                                                                    |                                     |
                                                                                    |                              расширение: бейдж (канал 1) + chrome.notifications (канал 2)
                                                                                    |                                     |
                                                                                    |        <-- Разрешить/Отклонить -----+
                                                                                    |
                                                                                    +--> phone-channel (ЗАГЛУШКА, канал 3)
```

Демон, роутер и каналы **полностью не знают, от какого агента пришло
событие** — они работают с универсальным форматом
(`permission_request`/`task_done` + `tool`/`summary`/`cwd`/`sessionId`).
Всё специфичное для конкретного агента (формат его hook-протокола) живёт
в одном файле-адаптере (`bin/notify-agent*.js`). Добавление нового агента —
это новый адаптер, а не правки в демоне/расширении.

Демон — персистентный процесс, не зависящий от браузера: адаптеры и
native-bridge подключаются к нему по TCP, а если он не запущен —
автоматически стартуют его (`detached`, переживает породивший процесс). Это
сделано специально, чтобы в будущем демон мог слать события на телефон, даже
когда Chrome закрыт.

## Структура проекта

```
extension/            Chrome MV3 расширение (приёмник каналов 1 и 2)
  manifest.json         permissions: nativeMessaging, notifications, alarms — без доступа к сайтам
  background.js        connectNative + роутинг в UI-каналы + мост настроек popup<->демон + keepalive
  popup.html/.js        статус, тумблеры каналов, таймауты, «не беспокоить», лог событий
  channels/
    badge-channel.js      канал 1 — бейдж на иконке расширения
    notification-channel.js  канал 2 — chrome.notifications с кнопками
  icons/

host/                  Node.js демон + CLI-адаптеры + native messaging host
  bin/
    notify-agent.js          адаптер Claude Code: notify-agent permission | done
    notify-agent-cursor.js   адаптер Cursor: один скрипт на несколько хуков
    notify-agent-copilot.js  адаптер GitHub Copilot CLI: permission | done
  src/
    daemon.js               точка входа демона (TCP-сервер, ротация daemon.log)
    ipc-server.js / ipc-client.js   локальный протокол (ndjson по TCP) + auth-хендшейк
    auth.js                  токен для TCP-порта (auth-token в конфиг-папке)
    router.js                правила "тип события -> каналы" + проверка snooze
    stop-debounce.js          откладывает "готово" пока сессия активна
    settings.js               чтение/запись routing.json
    native-bridge.js         реально регистрируется как native messaging host
    channels/
      extension-channel.js    доставка в расширение + ожидание решения
      phone-channel.js        ЗАГЛУШКА
    platform/                 ОС-зависимый слой (пути, регистрация)
      windows.js / macos.js / linux.js
  test/                    юнит-тесты (node:test) на router/stop-debounce/claude-permissions
  install/
    register-windows.js / unregister-windows.js
  config/routing.default.json

claude-hooks/settings.snippet.json   фрагмент для ~/.claude/settings.json
cursor-hooks/hooks.snippet.json      фрагмент для ~/.cursor/hooks.json
copilot-hooks/hooks.snippet.json     фрагмент для ~/.copilot/hooks/
```

## Установка (Windows)

### 1. Зависимости хоста

```
cd host
npm install
npm link          # кладёт `notify-agent` на PATH (глобальный симлинк на bin/notify-agent.js)
```

Если не хочется линковать глобально — можно в hooks (см. ниже) указывать
полный путь: `node E:\chrome\ai-agent-notifier\host\bin\notify-agent.js permission`.

### 2. Загрузить расширение в Chrome

`chrome://extensions` → включить «Режим разработчика» → «Загрузить
распакованное расширение» → выбрать папку `extension/`. Скопируйте
**ID расширения**, он понадобится на следующем шаге.

### 3. Зарегистрировать native messaging host

```
cd host
node install/register-windows.js <EXTENSION_ID>
```

Скрипт:
- создаёт `install/native-host-launcher.bat` (Chrome не умеет запускать `.js`
  напрямую — нужен исполняемый файл);
- пишет host-манифест в `%APPDATA%\ai-agent-notifier\native-host\chrome\`;
- прописывает путь к манифесту в `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.aiagentnotifier.host`
  (без прав администратора).

Перезагрузите расширение (кнопка ⟳ на `chrome://extensions`), чтобы
`background.js` переподключился по native messaging.

**Другой Chromium-браузер вместо/вместе с Chrome** (Edge, Brave, Chromium) —
тот же скрипт со вторым аргументом, тот же `EXTENSION_ID` (расширение нужно
так же отдельно загрузить как распакованное в этом браузере):
```
node install/register-windows.js <EXTENSION_ID> edge
node install/register-windows.js <EXTENSION_ID> brave
node install/register-windows.js <EXTENSION_ID> chromium
```
Каждый браузер получает свой манифест и свою запись в реестре — регистрации
не конфликтуют между собой. Снять регистрацию: `node install/unregister-windows.js [браузер]`.

### 4. Подключить хуки агента

**Claude Code**: слейте содержимое `claude-hooks/settings.snippet.json` в
свой `~/.claude/settings.json` (не перезаписывайте файл целиком, если там
уже есть другие настройки/хуки — добавьте вручную секции
`PermissionRequest`/`Notification` в существующий `hooks`). Используются
именно эти два хука, а не более известные `PreToolUse`/`Stop` — см. раздел
«Почему PermissionRequest/Notification, а не PreToolUse/Stop» ниже.

**Cursor**: слейте содержимое `cursor-hooks/hooks.snippet.json` в свой
`~/.cursor/hooks.json` (пользовательский уровень, все проекты) либо в
`<проект>/.cursor/hooks.json` (только этот проект). Пути в `"command"`
абсолютные — если переносите проект в другое место, поправьте их. Хуки
`beforeShellExecution`/`beforeMCPExecution` покрывают запросы разрешения,
`stop` — «агент закончил» с тем же debounce-механизмом, что и у Claude Code.
Cursor сам перечитывает файл хуков при сохранении — перезапуск не нужен.

**GitHub Copilot CLI**: положите содержимое `copilot-hooks/hooks.snippet.json`
в `~/.copilot/hooks/notify-agent.json` (пользовательский уровень, все
репозитории — на Windows это `%USERPROFILE%\.copilot\hooks\`) либо в
`.github/hooks/notify-agent.json` внутри конкретного репозитория. ⚠️ Формат
поля с командой скрипта (`"powershell"` вместо `"command"`) собран по
документации на момент написания и не проверен на реальном Copilot CLI —
если хук не подхватится, сверьтесь с `docs.github.com/copilot/reference/hooks-reference`
и поправьте это поле в снипете.

Можно подключить сразу несколько агентов одновременно — демон один на всех,
различает события только по содержимому, а не по источнику.

## Как проверить, что всё работает

1. **Демон отдельно.** `cd host && node src/daemon.js` — в консоли (или в
   `%APPDATA%\ai-agent-notifier\daemon.log`, если демон запущен detached)
   должна появиться строка `слушаю 127.0.0.1:8765`.
2. **CLI → демон.**
   ```
   echo {} | node bin/notify-agent.js done
   ```
   в логе демона должна появиться обработка события `task_done`.
3. **Расширение ↔ демон.** Откройте popup расширения — если написано
   «подключено к host», native messaging соединение установлено.
4. **End-to-end.** Выполните (инструмент нарочно не из вашего allow-листа,
   чтобы safety-net не съел тестовое событие молча — см. раздел ниже):
   ```
   echo {"tool_name":"Edit","tool_input":{"file_path":"test.js"}} | node bin/notify-agent.js permission
   ```
   Должно прилететь системное уведомление Windows с кнопками «Разрешить» /
   «Отклонить» и бейдж на иконке расширения. Нажатие кнопки — команда
   `notify-agent` должна сразу завершиться (проверьте `%errorlevel%` /
   вывод в консоли).
5. **В связке с Claude Code.** Запустите Claude Code в проекте и попросите
   что-то, что требует разрешения и не покрыто вашим allow-листом (например,
   отредактировать файл). Уведомление должно прилететь до того, как в
   терминале появится обычный промпт на подтверждение.
6. **Юнит-тесты.** `cd host && npm test` — покрывают роутинг по правилам,
   debounce на «готово» и сопоставление правил `permissions.allow`/`ask`.

## Настройка

Основной способ — **popup расширения**: тумблеры «уведомление / бейдж» для
каждого типа события, таймауты в секундах, «не беспокоить» **по проекту**
(выбор из недавних cwd + 30 мин / 1 час / 3 часа, список активных заглушений
с отменой каждой отдельно) — шумная параллельная сессия не глушит важную.
Правки применяются сразу, без перезапуска демона — popup сам шлёт их через
native messaging.

Под капотом это всё тот же `%APPDATA%\ai-agent-notifier\routing.json`
(создаётся из `host/config/routing.default.json` при первом запуске
демона) — его можно и дальше редактировать руками, если нужно то, чего нет
в popup:

```json
{
  "rules": {
    "permission_request": ["notification", "badge"],
    "task_done": ["notification", "badge"]
  },
  "notification": { "requireInteraction": true, "silent": false },
  "permissionTimeoutMs": 60000,
  "stopDebounceMs": 20000,
  "permissionExcludeTools": ["Read", "Glob", "Grep", "NotebookRead", "WebFetch"],
  "permissionInfoOnlyTools": ["AskUserQuestion"],
  "snoozeByProject": {}
}
```

- `rules` — какие каналы дёргать на какой тип события (`notification`,
  `badge`, `phone`).
- `permissionTimeoutMs` — сколько ждать решения пользователя. Если
  никто не нажал кнопку (или расширение не подключено, или демон не
  поднялся) — хук **ничего не выводит и завершается кодом 0** (fail-open):
  Claude Code просто спросит разрешение обычным способом в терминале,
  как будто уведомителя нет. Отсутствие уведомления никогда не блокирует
  обычную работу.
- `stopDebounceMs` — доп. подстраховка поверх `Notification`/`idle_prompt`
  (который уже сам по себе точнее старого `Stop`, см. раздел выше): событие
  «готово» откладывается на `stopDebounceMs`; если за это время в той же
  сессии придёт новое событие (значит вы уже ответили) — отложенное
  уведомление тихо отменяется. `permission_request` эта задержка не
  касается — уведомление о
  запросе разрешения всегда уходит немедленно.
- `permissionExcludeTools` — инструменты, которые не считаются требующими
  внимания, даже если формально не в allow-листе (см. раздел ниже).
- `permissionInfoOnlyTools` — инструменты вроде `AskUserQuestion`: не
  «разрешить/отклонить», агент сам показывает варианты ответа в терминале.
  Уведомление для них информационное, без кнопок, хук не ждёт решения.
- `snoozeByProject` — карта `cwd -> timestamp в мс`. Пока
  `Date.now() < timestamp` для данного `cwd`, роутер подавляет все каналы
  **только для событий с этим `cwd`** — другие проекты не глушатся
  (permission-хук при этом всё равно fail-open'ится по таймауту — Claude
  Code продолжит работать как обычно, просто без уведомления). Обновляется
  через popup; патч с `null` в значении конкретного проекта удаляет запись
  (а не оставляет мёртвый `null` в файле).

Правки в этот файл подхватываются на лету (демон читает его при каждом
событии, перезапуск не нужен).

## Установка (macOS/Linux)

ОС-зависимый код целиком лежит в `host/src/platform/` за общим интерфейсом
(`configDir`, `nativeHostManifestDir`, `registerNativeHost`,
`unregisterNativeHost`) — `host/src/platform/index.js` просто выбирает
реализацию по `process.platform`. Остальной код (демон, router, каналы, CLI,
extension) от ОС не зависит вообще: транспорт — TCP localhost, а не
именованные пайпы/сокеты, специально ради этого.

**⚠️ Не протестировано вживую** (разработка и все проверки шли на Windows) —
реализовано строго по документированному поведению Chrome. Если что-то не
заработает, первым делом проверьте: манифест — валидный JSON, `path` в нём —
абсолютный путь, у `native-bridge.js` выставлен исполняемый бит.

1. **Зависимости хоста и регистрация**
   ```
   cd host
   npm install
   npm link                 # кладёт notify-agent на PATH (или указывайте полный путь в hooks)
   ```
2. **Загрузить расширение** в `chrome://extensions` (режим разработчика →
   «Загрузить распакованное расширение» → папка `extension/`), скопировать
   ID расширения.
3. **Зарегистрировать native host**
   ```
   node install/register-unix.js <EXTENSION_ID>
   ```
   Скрипт кладёт JSON-манифест напрямую в папку браузера (по умолчанию —
   Google Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
   на macOS, `~/.config/google-chrome/NativeMessagingHosts/` на Linux) и
   делает `native-bridge.js` исполняемым (`chmod +x`). Никакого
   `.bat`-лаунчера здесь не нужно — браузер запускает скрипт напрямую по
   шебангу `#!/usr/bin/env node`.

   **Другой Chromium-браузер вместо/вместе с Chrome** (Edge, Brave, Chromium)
   — тот же скрипт со вторым аргументом, тот же `EXTENSION_ID` (расширение
   нужно так же отдельно загрузить как распакованное в этом браузере):
   ```
   node install/register-unix.js <EXTENSION_ID> edge
   node install/register-unix.js <EXTENSION_ID> brave
   node install/register-unix.js <EXTENSION_ID> chromium
   ```
   Пути для каждого браузера — в `host/src/platform/macos.js`/`linux.js`
   (`APP_SUPPORT_SEGMENTS_BY_BROWSER` / `CONFIG_SEGMENTS_BY_BROWSER`); для
   Chrome Beta/Canary поправьте их там же вручную.
4. Перезагрузите расширение и подключите хуки — см. общий раздел «Подключить
   хуки агента» выше (снипеты для Claude Code/Cursor универсальны для всех ОС,
   поправить нужно только пути в `"command"`).
5. Отключить регистрацию: `node install/unregister-unix.js [браузер]`.

## Standalone-бинарник (без Node.js на целевой машине)

Весь `host/` (демон, native-bridge, все CLI-адаптеры) собирается в один
исполняемый файл через единый диспетчер `bin/aan.js` — вместо пяти
node-скриптов получается один бинарник, поведение выбирается первым
аргументом: `aan daemon`, `aan bridge`, `aan notify permission|done`,
`aan notify-cursor`, `aan notify-copilot permission|done`. Собирается
через [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) (поддерживаемый форк
`vercel/pkg`).

```
cd host
npm install
npm run build:win     # -> dist/win/ai-agent-notifier.exe (~55 МБ, проверено вживую)
npm run build:mac     # -> dist/mac/ai-agent-notifier      (не протестировано — нет macOS)
npm run build:linux   # -> dist/linux/ai-agent-notifier    (не протестировано — нет Linux)
```

⚠️ `pkg-fetch` не всегда держит прекомпилированный Node под каждую
патч-версию — если сборка уходит в "Compiling Node.js from sources", нужен
полный MSVC/build toolchain, которого обычно нет. Если так — смените таргет
на другую версию Node (например `node22-win-x64` вместо `node18-win-x64`,
это и подтверждено рабочим здесь) в соответствующем `build:*` скрипте.

**Регистрация под собранный бинарник** — тот же `register-windows.js`/
`register-unix.js`, что и раньше, с флагом `--exe`:
```
node install/register-windows.js <EXTENSION_ID> chrome --exe=dist/win/ai-agent-notifier.exe
node install/register-unix.js <EXTENSION_ID> chrome --exe=/path/to/dist/linux/ai-agent-notifier
```
Манифест native messaging не умеет передавать аргументы командной строки в
`"path"`, поэтому скрипт всё равно генерирует тонкую обёртку (`.bat` на
Windows, `.sh` на macOS/Linux) — она вызывает бинарник с аргументом
`bridge`, сам бинарник Node.js не требует.

Автозапуск демона (`ipc-client.js`) внутри собранного бинарника работает
без отдельной логики: `pkg` распознаёт путь внутри своего снапшота,
переданный как аргумент дочернему процессу, как альтернативную точку
входа — `daemon.js` сам решает, что он "главный модуль"
(`require.main === module`), и запускается как обычно. Проверено вживую:
`daemon`, `bridge`, `notify-cursor` — все три подкоманды.

Хуки агентов (`claude-hooks/`, `cursor-hooks/`, `copilot-hooks/`) при этом
можно направить на тот же бинарник вместо `node ... notify-agent.js` —
команда в конфиге меняется на `"<путь>\ai-agent-notifier.exe" notify permission`
(и аналогично для `done`/`notify-cursor`/`notify-copilot`).

## Почему PermissionRequest/Notification, а не PreToolUse/Stop

Первая версия висела на `PreToolUse` (срабатывает на **каждый** вызов
инструмента, даже уже разрешённый) и `Stop` (срабатывает на **каждый** ход
диалога). Из-за этого пришлось городить самодельную имитацию разрешений
Claude Code (`host/src/claude-permissions.js`), ручной exclude-лист
read-only инструментов и debounce поверх `Stop` — и всё равно регулярно
всплывали ложные уведомления (`WebSearch`, `WebFetch`, `Artifact`,
`AskUserQuestion` — каждый раз новый инструмент, который "как бы не должен
был спрашивать, но спросил").

У Claude Code есть более точные хуки:
- **`PermissionRequest`** — вызывается Claude Code, только когда решение
  реально нужно пользователю. Если действие уже разрешено (allow-лист,
  `permission_mode`) — хук просто не вызывается, и городить эту логику
  самим больше не нужно.
- **`Notification`** с `matcher: "idle_prompt"` — вызывается, когда Claude
  Code сам показывает пользователю индикатор простоя. Содержательно то же,
  что раньше выцарапывалось через debounce поверх `Stop`, только точнее и
  без риска среагировать на каждую реплику активной переписки.

`host/src/claude-permissions.js` и `permissionExcludeTools` в `routing.json`
остались в коде как подстраховка (на случай нестандартного поведения
хука или ручного оверрайда — «Claude бы спросил, но мне всё равно не нужно
уведомление»), но перестали быть основным механизмом фильтрации.

Особый случай — `AskUserQuestion`: это не «разрешить/отклонить», а сам
агент показывает варианты ответа в терминале. Такие инструменты помечены в
`permissionInfoOnlyTools` — уведомление для них информационное, без кнопок,
и хук не ждёт решения (агент показывает свой диалог сразу, без задержки).

Ограничение: учитываются только глобальные `~/.claude/settings.json`,
project-level `.claude/settings.json` в конкретном репозитории пока не
читается.

## Безопасность

Расширение просит только `nativeMessaging`, `notifications`, `alarms` — без
доступа к содержимому сайтов (нет `scripting`/`tabs`/`host_permissions`):
канал 1 — бейдж на иконке, а не инжект в страницу, поэтому широкие
разрешения ему не нужны.

TCP-порт демона (`127.0.0.1:8765`) защищён общим токеном
(`host/src/auth.js`): при первом запуске генерируется случайный секрет в
`%APPDATA%\ai-agent-notifier\auth-token` (права `0600`), и первое сообщение
на любом новом соединении обязано быть хендшейком с этим токеном — иначе
демон рвёт соединение. Это закрывает путь для случайного/по умолчанию
доступа с той же машины, но не защищает от другого пользователя с правами на
чтение файлов вашего профиля (Windows ACL на этот файл не ужесточаются) —
порог защиты умышленно средний, для однопользовательской локальной машины.

## Известные ограничения / TODO

- **Канал «телефон»** (`host/src/channels/phone-channel.js`) — заглушка,
  логирует и ничего не отправляет. Интерфейс `send(event, settings)`
  совпадает с остальными каналами, так что подключение реального push-сервера
  не потребует правок в `router.js`.
- **Формат JSON-ответа хука** (`hookSpecificOutput.permissionDecision` в
  `bin/notify-agent.js`) подобран по документированной схеме хуков Claude
  Code, но она менялась между версиями. Если авто-разрешение через
  уведомление не подхватывается — сверьтесь с актуальной документацией хуков
  и поправьте только функцию `printPermissionDecision()`.
- Юнит-тесты (`host/test/`) покрывают только чистую логику (router,
  stop-debounce, claude-permissions) — end-to-end путь
  CLI→демон→bridge→расширение проверяется только вручную, автотестов на
  него нет.
- **GitHub Copilot CLI-адаптер** (`notify-agent-copilot.js`) протестирован
  через демон/расширение только с синтетическими JSON-событиями (структура
  события подтверждена — доходит, парсится, показывает уведомление
  правильно). Сам факт, что Copilot CLI реально вызовет скрипт по этому
  конфигу с такими полями — не проверен на живом Copilot CLI, только по
  документации. Формат `"powershell"`-поля в `copilot-hooks/hooks.snippet.json`
  — самый неопределённый момент, см. выше.
- **Другие агенты, помимо Claude Code/Cursor/Copilot CLI**: у OpenAI Codex
  CLI хуки сильно ограничены — `PreToolUse` ловит только shell-команды (не
  файлы и не MCP), `Stop`-эквивалента нет вообще, нужно включать
  feature-флаг в `~/.codex/config.toml`. У Aider нет hook/plugin API в
  принципе — адаптер потребовал бы оборачивать процесс аидера и парсить его
  вывод, это другой по духу (и более хрупкий) подход, отдельная задача.

## Лицензия

[MIT](LICENSE)
