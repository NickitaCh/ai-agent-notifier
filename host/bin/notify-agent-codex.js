#!/usr/bin/env node
'use strict';

// Адаптер для хуков OpenAI Codex CLI (~/.codex/hooks.json).
//
// ⚠️ Codex-хуки на момент написания — заметно менее стабильная и хуже
// документированная часть, чем у Claude Code/Cursor: официальной страницы
// с полной JSON-схемой найти не удалось, а в самом репозитории openai/codex
// на GitHub несколько открытых issues именно про непоследовательное
// покрытие хуков (часть tool-хендлеров вообще не эмитит события). Схема
// полей ниже собрана по достаточно свежему issue-предложению и может не
// совпадать с реально выпущенной версией — сделано защитно (проверяются
// варианты имён полей и в camelCase, и в snake_case).
//
// Реальные ограничения платформы (не наш выбор, так устроен Codex):
//  - Нужен feature-флаг: [features].codex_hooks = true в ~/.codex/config.toml,
//    без него хуки Codex вообще не вызываются.
//  - PreToolUse сейчас покрывает только часть инструментов (shell/exec,
//    apply_patch, mcp) — не все вызовы агента дойдут до нас в принципе.
//  - Нет хука для "агент закончил" — подкоманды done тут нет и быть не может.
//  - Из решения хука реальный эффект имеет только "deny". Всё остальное
//    (в т.ч. явный "allow" или таймаут) Codex трактует одинаково — как
//    разрешение продолжить. Поэтому кнопка «Разрешить» в уведомлении для
//    Codex ничего не меняет: действие и так пройдёт, если её не нажать.
//    Единственная кнопка с реальным эффектом — «Отклонить».

const { randomUUID } = require('crypto');
const { connect } = require('../src/ipc-client');
const { writeLine, createLineReader } = require('../src/ndjson');

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

// toolInput может прийти под разными именами в зависимости от версии —
// поддерживаем оба варианта на каждом поле.
function field(input, camel, snake) {
  return input[camel] ?? input[snake];
}

function summarize(toolName, toolInput) {
  if (!toolInput) return toolName || '';
  if (typeof toolInput.command === 'string') return truncate(toolInput.command);
  if (Array.isArray(toolInput.command)) return truncate(toolInput.command.join(' '));
  if (typeof toolInput.path === 'string') return `${toolName}: ${toolInput.path}`;
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

function printDecision(decision) {
  // Codex учитывает только deny — всё остальное (в т.ч. пустой вывод)
  // означает "продолжить как есть". См. предупреждение в шапке файла.
  if (decision === 'deny') {
    process.stdout.write(
      JSON.stringify({
        permissionDecision: 'deny',
        permissionDecisionReason: 'Отклонено через системное уведомление',
      })
    );
  }
}

async function main() {
  const raw = await readStdin();
  const input = parseInput(raw);

  const toolName = field(input, 'toolName', 'tool_name') || 'Shell';
  const toolInput = field(input, 'toolInput', 'tool_input') || {};
  const cwd = input.cwd || process.cwd();
  const sessionId = field(input, 'sessionId', 'session_id') || null;

  const event = {
    id: randomUUID(),
    type: 'permission_request',
    agent: 'codex',
    tool: toolName,
    summary: summarize(toolName, toolInput),
    cwd,
    sessionId,
    ts: Date.now(),
  };

  const decision = await submitEvent(event);
  printDecision(decision);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { main };
