#!/usr/bin/env node
'use strict';

// CLI-обёртка, которую дёргают хуки Claude Code:
//   notify-agent permission   — на PermissionRequest, ждёт решение пользователя
//   notify-agent done         — на Notification (matcher idle_prompt), не ждёт
//
// Сознательно используются PermissionRequest/Notification, а НЕ
// PreToolUse/Stop:
//  - PreToolUse дёргается на КАЖДЫЙ вызов инструмента, даже уже разрешённый
//    (Claude сам его выполнит без вопроса) — это и вызывало всю прошлую
//    возню с exclude-листами (WebFetch, Read, Artifact...). PermissionRequest
//    дёргается ТОЛЬКО когда решение реально нужно — Claude Code сам это
//    определяет, повторять его логику вручную больше не требуется.
//  - Stop дёргается на каждый ход диалога (потребовал самодельный debounce).
//    Notification/idle_prompt — нативный сигнал "Claude показывает
//    индикатор простоя", т.е. содержательно то же самое, что мы раньше
//    выцарапывали через stop-debounce.js.
//
// Формат ввода/вывода подстроен под хуки Claude Code:
//  - hook передаёт JSON-контекст события через stdin;
//  - для PermissionRequest решение возвращается через JSON на stdout в поле
//    hookSpecificOutput.decision.behavior ("allow" | "deny"). Схема хуков
//    у Claude Code может отличаться между версиями — если разрешение через
//    уведомление не подхватывается, свериться с текущей документацией хуков
//    и поправить только функцию printPermissionDecision() ниже.
//
// Философия отказоустойчивости: если демон недоступен, расширение не
// подключено или пользователь не успел нажать кнопку — CLI НИЧЕГО не
// печатает и выходит с кодом 0. Это откатывает поведение к обычному
// поведению Claude Code (спросит в терминале), т.е. отсутствие уведомления
// никогда не блокирует обычную работу (fail-open).

const { randomUUID } = require('crypto');
const { connect } = require('../src/ipc-client');
const { writeLine, createLineReader } = require('../src/ndjson');
const settingsStore = require('../src/settings');
const { createFileLogger } = require('../src/file-logger');
const { hookLogFilePath } = require('../src/constants');

// Демон видит только то, что реально до него достучалось. Если этот
// процесс упадёт/зависнет/будет убит хостом ДО того, как дозвонится —
// в daemon.log не останется вообще никакого следа. Этот лог пишем сами,
// на каждый чек-поинт, независимо от того, дошли ли до демона.
const writeHookLog = createFileLogger(hookLogFilePath());
const hookLog = (...args) => writeHookLog('claude', ...args);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    // Хук может не передать stdin вовсе — не виснем.
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

function parseHookInput(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function truncate(text, max = 160) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Человекочитаемое краткое описание вызова для текста уведомления. Порядок
// проверок — от самых частых/понятных полей к более общим. Финальный
// фолбэк — НЕ сырой JSON (его никто не хочет видеть в уведомлении), а
// просто имя инструмента.
function summarizeToolInput(toolName, toolInput) {
  if (!toolInput) return toolName || '';
  if (typeof toolInput.command === 'string') return truncate(toolInput.command);
  if (typeof toolInput.file_path === 'string') return `${toolName}: ${toolInput.file_path}`;
  if (typeof toolInput.url === 'string') return `${toolName}: ${toolInput.url}`;
  if (typeof toolInput.query === 'string') return `${toolName}: ${truncate(toolInput.query)}`;
  if (typeof toolInput.pattern === 'string') return `${toolName}: ${toolInput.pattern}`;
  if (typeof toolInput.prompt === 'string') return truncate(toolInput.prompt);
  if (Array.isArray(toolInput.questions) && toolInput.questions[0]?.question) {
    return truncate(toolInput.questions[0].question);
  }
  return toolName || 'требует подтверждения';
}

// Отправляет событие демону и ждёт ответ (decision для permission_request,
// ack для остальных). Возвращает null при любой проблеме связи — вызывающий
// код трактует это как fail-open.
function submitEvent(event) {
  return new Promise((resolve) => {
    connect()
      .then((socket) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(value);
        };

        createLineReader(socket, (msg) => {
          if (msg.type === 'decision') finish(msg.decision);
          else if (msg.type === 'ack') finish(null);
        });
        socket.on('error', () => finish(null));
        socket.on('close', () => finish(null));

        writeLine(socket, { type: 'submit_event', event });
      })
      .catch(() => resolve(null));
  });
}

function printPermissionDecision(decision) {
  if (decision === 'allow' || decision === 'deny') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: decision },
        },
      })
    );
  }
  // decision === null (таймаут/нет связи) -> ничего не печатаем, fail-open —
  // Claude Code проведёт свой обычный поток разрешения, как будто нас нет.
}

async function runPermission() {
  const startedAt = Date.now();
  hookLog(`старт pid=${process.pid}`);

  const raw = await readStdin();
  const hookInput = parseHookInput(raw);
  hookLog(`stdin прочитан (${Date.now() - startedAt}мс), tool=${hookInput.tool_name || '-'} raw_len=${raw.length}`);

  // PermissionRequest сам по себе уже дёргается Claude Code только когда
  // решение реально нужно (см. комментарий в шапке файла) — раньше здесь
  // ещё стояла своя проверка isBlanketlyAllowed(permission_mode), считавшая
  // "auto"/"bypassPermissions"/"dontAsk" всегда безопасными для тихого
  // пропуска. Убрана: живой случай — ask-правило "Bash(rm*)" в
  // ~/.claude/settings.json переопределяет auto-режим для конкретной
  // команды, Claude Code корректно спрашивает подтверждение в терминале, а
  // наша проверка (смотрела только на permission_mode, не на ask-правила)
  // всё равно тихо гасила уведомление. Единственный оставшийся оверрайд —
  // ручной, через routing.json (permissionExcludeTools) ниже: "да, Claude
  // бы спросил, но мне всё равно не нужно уведомление".
  const settings = settingsStore.load();
  const excludeTools = settings.permissionExcludeTools || [];
  if (excludeTools.includes(hookInput.tool_name)) {
    hookLog(`выход: инструмент в permissionExcludeTools`);
    process.exit(0);
  }

  // Инструменты вроде AskUserQuestion — это не "разрешить/отклонить",
  // а сам агент показывает пользователю варианты ответа в терминале. Наши
  // кнопки Разрешить/Отклонить для них не имеют смысла (это не то решение,
  // которое реально принимается), поэтому уведомление для них —
  // информационное ("агент задал вопрос"), без кнопок, и хук не ждёт
  // решения — агент сразу показывает свой диалог, не задерживаясь.
  const infoOnlyTools = settings.permissionInfoOnlyTools || [];
  const needsDecision = !infoOnlyTools.includes(hookInput.tool_name);

  const event = {
    id: randomUUID(),
    type: 'permission_request',
    agent: 'claude',
    tool: hookInput.tool_name || null,
    summary: summarizeToolInput(hookInput.tool_name, hookInput.tool_input),
    cwd: hookInput.cwd || process.cwd(),
    sessionId: hookInput.session_id || null,
    needsDecision,
    ts: Date.now(),
  };

  hookLog(`отправляю событие id=${event.id} needsDecision=${needsDecision}`);

  if (!needsDecision) {
    await submitEvent(event); // просто уведомляем, решения не печатаем — обычный поток агента не трогаем
    hookLog(`выход: needsDecision=false, событие отправлено (${Date.now() - startedAt}мс)`);
    process.exit(0);
  }

  const decision = await submitEvent(event);
  hookLog(`решение получено: ${decision === null ? 'null (таймаут/нет связи)' : decision} (${Date.now() - startedAt}мс с запуска)`);
  printPermissionDecision(decision);
  process.exit(0);
}

// Вызывается из Notification-хука с matcher "idle_prompt" (см. шапку файла) —
// hookInput здесь в формате Notification (session_id/cwd/notification_type/
// message), но нам нужны только session_id и cwd, они есть в обоих форматах.
async function runDone() {
  hookLog(`старт (done) pid=${process.pid}`);
  const raw = await readStdin();
  const hookInput = parseHookInput(raw);

  const event = {
    id: randomUUID(),
    type: 'task_done',
    agent: 'claude',
    cwd: hookInput.cwd || process.cwd(),
    sessionId: hookInput.session_id || null,
    ts: Date.now(),
  };

  // Дожидаемся отправки (не дольше 5с), чтобы событие точно ушло, но
  // хук не завис надолго, если демон недоступен.
  await Promise.race([submitEvent(event), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}

// Если процесс упадёт от неожиданного исключения где-то в середине —
// это раньше пропадало вообще без следа (демон никогда не узнает, что
// хук вообще запускался). Теперь хотя бы попадёт в hook-cli.log.
process.on('uncaughtException', (err) => {
  hookLog(`необработанное исключение: ${err.stack || err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  hookLog(`необработанный reject: ${err?.stack || err}`);
  process.exit(1);
});

async function main() {
  const command = process.argv[2];
  if (command === 'permission') {
    await runPermission();
  } else if (command === 'done') {
    await runDone();
  } else {
    console.error('Использование: notify-agent permission | notify-agent done');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
