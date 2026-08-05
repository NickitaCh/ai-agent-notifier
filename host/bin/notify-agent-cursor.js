#!/usr/bin/env node
'use strict';

// Адаптер для хуков Cursor (~/.cursor/hooks.json или <project>/.cursor/hooks.json).
// В отличие от notify-agent.js (Claude Code, отдельная подкоманда на хук),
// здесь ОДИН скрипт вешается сразу на несколько типов хуков Cursor — тип
// события Cursor сам присылает в поле hook_event_name на stdin.
//
// Использует ТОТ ЖЕ демон и тот же универсальный формат событий
// (permission_request / task_done), что и Claude Code — вся логика роутинга,
// каналов и debounce на Stop общая, специфичен для Cursor только этот файл.
//
// Настройка (~/.cursor/hooks.json):
// {
//   "version": 1,
//   "hooks": {
//     "beforeShellExecution": [{ "command": "node <абсолютный путь>/notify-agent-cursor.js" }],
//     "beforeMCPExecution":   [{ "command": "node <абсолютный путь>/notify-agent-cursor.js" }],
//     "stop":                 [{ "command": "node <абсолютный путь>/notify-agent-cursor.js" }]
//   }
// }
//
// Формат хуков Cursor подобран по документации на момент написания — если
// что-то не подхватится, сверьтесь с актуальной схемой и поправьте только
// printDecision()/summarize() ниже.

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

function summarize(hookEventName, input) {
  if (hookEventName === 'beforeShellExecution') return truncate(input.command || '');
  if (hookEventName === 'beforeMCPExecution') {
    return input.tool_name || truncate(JSON.stringify(input.tool_input || {}));
  }
  return hookEventName;
}

function resolveCwd(input) {
  return input.cwd || (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) || process.cwd();
}

// Идентично по духу submitEvent из notify-agent.js — тот же протокол,
// тот же демон, дублируем ради независимости адаптеров друг от друга.
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
  // Cursor понимает permission: "allow" | "deny" | "ask".
  if (decision === 'allow') {
    process.stdout.write(JSON.stringify({ permission: 'allow' }));
  } else if (decision === 'deny') {
    process.stdout.write(
      JSON.stringify({ permission: 'deny', agent_message: 'Отклонено через уведомление' })
    );
  } else {
    // Таймаут/нет связи -> fail-open: возвращаем решение Cursor'у,
    // пусть спросит сам как обычно (как будто нотификатора нет).
    process.stdout.write(JSON.stringify({ permission: 'ask' }));
  }
}

async function handlePermission(hookEventName, input) {
  const event = {
    id: randomUUID(),
    type: 'permission_request',
    agent: 'cursor',
    tool: hookEventName === 'beforeMCPExecution' ? input.tool_name || 'MCP' : 'Shell',
    summary: summarize(hookEventName, input),
    cwd: resolveCwd(input),
    sessionId: input.conversation_id || null,
    ts: Date.now(),
  };
  const decision = await submitEvent(event);
  printDecision(decision);
}

async function handleStop(input) {
  const event = {
    id: randomUUID(),
    type: 'task_done',
    agent: 'cursor',
    cwd: resolveCwd(input),
    sessionId: input.conversation_id || null,
    ts: Date.now(),
  };
  await Promise.race([submitEvent(event), new Promise((r) => setTimeout(r, 5000))]);
  process.stdout.write('{}');
}

async function main() {
  const raw = await readStdin();
  const input = parseInput(raw);
  const hookEventName = input.hook_event_name;

  if (hookEventName === 'beforeShellExecution' || hookEventName === 'beforeMCPExecution') {
    await handlePermission(hookEventName, input);
  } else if (hookEventName === 'stop') {
    await handleStop(input);
  } else {
    process.stdout.write('{}');
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { main };
