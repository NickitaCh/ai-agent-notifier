#!/usr/bin/env node
'use strict';

// Адаптер для хуков GitHub Copilot CLI (~/.copilot/hooks/*.json или
// .github/hooks/*.json в репозитории). По духу ближе к notify-agent.js
// (Claude Code) — отдельная подкоманда на каждый хук, а не один
// универсальный скрипт, как у Cursor:
//   notify-agent-copilot.js permission   — на preToolUse
//   notify-agent-copilot.js done         — на agentStop
//
// Использует ТОТ ЖЕ демон и универсальный формат событий
// (permission_request / task_done), что и остальные адаптеры.
//
// Схема I/O у Copilot CLI почти совпадает с Claude Code (те же имена полей
// permissionDecision/permissionDecisionReason, но БЕЗ обёртки
// hookSpecificOutput) — см. документацию хуков Copilot CLI. Если схема
// изменится, поправьте только printPermissionDecision() ниже.

const { randomUUID } = require('crypto');
const { connect } = require('../src/ipc-client');
const { writeLine, createLineReader } = require('../src/ndjson');
const settingsStore = require('../src/settings');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

function parseInput(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function truncate(text, max = 160) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// toolArgs у Copilot CLI — произвольный объект (unknown), структура похожа
// на tool_input у Claude Code, поэтому логика похожа на summarizeToolInput
// из notify-agent.js.
function summarizeToolArgs(toolName, toolArgs) {
  if (!toolArgs) return toolName || '';
  if (typeof toolArgs.command === 'string') return truncate(toolArgs.command);
  if (typeof toolArgs.file_path === 'string' || typeof toolArgs.path === 'string') {
    return `${toolName}: ${toolArgs.file_path || toolArgs.path}`;
  }
  if (typeof toolArgs.url === 'string') return `${toolName}: ${toolArgs.url}`;
  if (typeof toolArgs.query === 'string') return `${toolName}: ${truncate(toolArgs.query)}`;
  return toolName || 'требует подтверждения';
}

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
  if (decision === 'allow') {
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
  } else if (decision === 'deny') {
    process.stdout.write(
      JSON.stringify({
        permissionDecision: 'deny',
        permissionDecisionReason: 'Отклонено через системное уведомление',
      })
    );
  }
  // decision === null (таймаут/нет связи) -> пустой вывод = поведение по
  // умолчанию (fail-open), как и у остальных адаптеров.
}

async function runPermission() {
  const raw = await readStdin();
  const input = parseInput(raw);

  // Тот же общий exclude-лист read-only инструментов, что и у Claude Code
  // (routing.json: permissionExcludeTools) — единое поведение для всех
  // агентов, раз пользователь так решил.
  const settings = settingsStore.load();
  const excludeTools = settings.permissionExcludeTools || [];
  if (excludeTools.includes(input.toolName)) {
    process.exit(0);
  }

  const event = {
    id: randomUUID(),
    type: 'permission_request',
    tool: input.toolName || null,
    summary: summarizeToolArgs(input.toolName, input.toolArgs),
    cwd: input.cwd || process.cwd(),
    sessionId: input.sessionId || null,
    ts: Date.now(),
  };

  const decision = await submitEvent(event);
  printPermissionDecision(decision);
  process.exit(0);
}

async function runDone() {
  const raw = await readStdin();
  const input = parseInput(raw);

  const event = {
    id: randomUUID(),
    type: 'task_done',
    cwd: input.cwd || process.cwd(),
    sessionId: input.sessionId || null,
    ts: Date.now(),
  };

  await Promise.race([submitEvent(event), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}

async function main() {
  const command = process.argv[2];
  if (command === 'permission') {
    await runPermission();
  } else if (command === 'done') {
    await runDone();
  } else {
    console.error('Использование: notify-agent-copilot.js permission | notify-agent-copilot.js done');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
