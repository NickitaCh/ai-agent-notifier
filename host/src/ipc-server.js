'use strict';

const fs = require('fs');
const net = require('net');
const { DAEMON_PORT, DAEMON_HOST, logFilePath, PROTOCOL_VERSION, hostVersion } = require('./constants');
const { createLineReader, writeLine } = require('./ndjson');
const router = require('./router');
const settingsStore = require('./settings');
const extensionChannel = require('./channels/extension-channel');
const stopDebounce = require('./stop-debounce');
const auth = require('./auth');

const DIAGNOSTICS_TAIL_LINES = 60;

function start() {
  const expectedToken = auth.loadOrCreateToken();

  const server = net.createServer((socket) => {
    let authenticated = false;

    createLineReader(socket, (msg) => {
      if (!authenticated) {
        // Первое сообщение на любом новом соединении обязано быть хендшейком
        // с верным токеном (см. ipc-client.js) — иначе это не наш процесс.
        if (msg.type === 'auth' && msg.token === expectedToken) {
          authenticated = true;
        } else {
          console.error('[ipc-server] неверный токен авторизации, разрываю соединение');
          socket.destroy();
        }
        return;
      }
      handleMessage(socket, msg).catch((err) => {
        console.error(`[ipc-server] ошибка обработки сообщения: ${err.message}`);
      });
    });
    socket.on('close', () => extensionChannel.unregisterBridge(socket));
    socket.on('error', (err) => console.error(`[ipc-server] socket error: ${err.message}`));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Другой демон уже слушает порт — это и есть наша защита от дублей.
      console.error('[ipc-server] порт занят, демон уже запущен — выхожу');
      process.exit(0);
    }
    console.error(`[ipc-server] ошибка сервера: ${err.message}`);
    process.exit(1);
  });

  server.listen(DAEMON_PORT, DAEMON_HOST, () => {
    console.error(`[ipc-server] слушаю ${DAEMON_HOST}:${DAEMON_PORT}`);
  });

  return server;
}

async function handleMessage(socket, msg) {
  switch (msg.type) {
    case 'submit_event':
      await handleSubmitEvent(socket, msg.event);
      break;
    case 'bridge_register':
      extensionChannel.registerBridge(socket);
      break;
    case 'client_hello':
      // Расширение обновляется автоматически через Chrome Web Store, хост —
      // вручную. Отвечаем своей версией протокола сразу же, чтобы popup мог
      // предупредить пользователя о рассинхроне, не блокируя саму работу
      // (fail-open: несовпадение — это только предупреждение, не отказ).
      if (msg.protocolVersion !== undefined && msg.protocolVersion !== PROTOCOL_VERSION) {
        console.error(
          `[ipc-server] несовпадение версий протокола: расширение=${msg.protocolVersion}, хост=${PROTOCOL_VERSION}`
        );
      }
      writeLine(socket, buildHostHello());
      break;
    case 'permission_response':
      extensionChannel.resolveDecision(msg.id, msg.decision);
      break;
    case 'get_settings':
      writeLine(socket, { type: 'settings_snapshot', settings: settingsStore.load() });
      break;
    case 'update_settings':
      writeLine(socket, { type: 'settings_snapshot', settings: applySettingsPatch(msg.patch) });
      break;
    case 'get_diagnostics':
      writeLine(socket, { type: 'diagnostics_snapshot', logTail: readLogTail() });
      break;
    default:
      console.error(`[ipc-server] неизвестный тип сообщения: ${msg.type}`);
  }
}

function buildHostHello() {
  return { type: 'host_hello', protocolVersion: PROTOCOL_VERSION, hostVersion: hostVersion() };
}

// Хвост daemon.log для кнопки "Скопировать диагностику" в popup — без
// содержимого событий (summary там уже есть в логе как есть, это тот же
// уровень детализации, что и обычная отладка руками).
function readLogTail() {
  try {
    const content = fs.readFileSync(logFilePath(), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-DIAGNOSTICS_TAIL_LINES).join('\n');
  } catch (err) {
    return `(не удалось прочитать лог: ${err.message})`;
  }
}

// Мёрж snoozeByProject по правилам JSON Merge Patch (RFC 7396): значение
// null для проекта означает "убрать снуз для него", а не "сохранить null" —
// иначе карта копила бы мёртвые записи при каждой отмене.
function mergeSnoozeByProject(current, patch) {
  const merged = { ...(current || {}) };
  for (const [project, until] of Object.entries(patch || {})) {
    if (until === null) delete merged[project];
    else merged[project] = until;
  }
  return merged;
}

// Неглубокий мёрж на верхнем уровне + отдельно на один уровень внутрь
// "rules"/"snoozeByProject" (та же логика, что уже используется при чтении
// дефолтов в settings.js) — этого достаточно для тех полей, что реально
// правит popup: булевы тумблеры, числа таймаутов, списки каналов по типу
// события, снуз по конкретному проекту.
function applySettingsPatch(patch) {
  if (!patch || typeof patch !== 'object') return settingsStore.load();
  const current = settingsStore.load();
  const merged = {
    ...current,
    ...patch,
    rules: { ...current.rules, ...(patch.rules || {}) },
    snoozeByProject: mergeSnoozeByProject(current.snoozeByProject, patch.snoozeByProject),
  };
  settingsStore.save(merged);
  return merged;
}

async function handleSubmitEvent(socket, event) {
  const settings = settingsStore.load();
  console.error(
    `[ipc-server] событие ${event.type} id=${event.id} tool=${event.tool || '-'} cwd=${event.cwd || '-'} session=${event.sessionId || '-'} summary="${event.summary || ''}"`
  );

  // Любое новое событие в сессии означает, что пользователь уже ответил —
  // отложенное "агент закончил и ждёт" по прошлому Stop больше не актуально.
  stopDebounce.cancelPending(event.sessionId);

  if (event.type === 'permission_request' && event.needsDecision === false) {
    // Информационное уведомление (например, AskUserQuestion) — не тот
    // случай, где наши Разрешить/Отклонить что-то значат. Не ждём решения,
    // просто доставляем и отвечаем сразу.
    await router.dispatch(event);
    writeLine(socket, { type: 'ack' });
  } else if (event.type === 'permission_request') {
    // Подписываемся на решение ДО диспатча, чтобы не потерять мгновенный клик.
    const decisionPromise = extensionChannel.waitForDecision(event.id, settings.permissionTimeoutMs);
    await router.dispatch(event);
    const decision = await decisionPromise;
    console.error(`[ipc-server] решение по id=${event.id}: ${decision === null ? 'таймаут/нет связи' : decision}`);
    writeLine(socket, { type: 'decision', id: event.id, decision });
  } else if (event.type === 'task_done') {
    const delayMs = settings.stopDebounceMs ?? 20000;
    stopDebounce.scheduleStop(event, delayMs, (ev) => {
      router.dispatch(ev).catch((err) => console.error(`[ipc-server] отложенный dispatch упал: ${err.message}`));
    });
    writeLine(socket, { type: 'ack' });
  } else {
    await router.dispatch(event);
    writeLine(socket, { type: 'ack' });
  }
  socket.end();
}

module.exports = {
  start,
  // Экспортировано ради юнит-теста на чистую логику мёржа/хендшейка — не
  // для использования снаружи модуля в проде.
  mergeSnoozeByProject,
  buildHostHello,
};
