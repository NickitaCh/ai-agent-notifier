'use strict';

// Канал доставки в расширение: и бейдж на иконке (канал 1), и системное
// уведомление (канал 2) физически уходят одним и тем же путём — push через
// все подключённые native-bridge сокеты. Различие — в поле kind пейлоада,
// расширение само решает, как отрисовать.

const { writeLine } = require('../ndjson');

const bridges = new Set();
// eventId -> { resolve, timer }
const pending = new Map();

function registerBridge(socket) {
  bridges.add(socket);
  console.error(`[extension-channel] bridge подключился, всего: ${bridges.size}`);
}

function unregisterBridge(socket) {
  if (!bridges.delete(socket)) return; // это был не bridge (например, CLI-соединение)
  console.error(`[extension-channel] bridge отключился, всего: ${bridges.size}`);
}

function broadcast(payload) {
  for (const socket of bridges) {
    try {
      writeLine(socket, { type: 'push', payload });
    } catch (err) {
      console.error(`[extension-channel] не удалось отправить в bridge: ${err.message}`);
    }
  }
}

async function sendBadge(event) {
  broadcast({ kind: 'badge', event });
}

async function sendNotification(event, settings) {
  broadcast({
    kind: 'notification',
    event,
    options: settings.notification,
  });
}

// Вызывается до отправки уведомления, чтобы не потерять быстрый клик
// пользователя (race между dispatch и подпиской на ответ).
function waitForDecision(eventId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(eventId);
      resolve(null); // таймаут -> fail-open, вызывающий код решит, что делать
    }, timeoutMs);
    pending.set(eventId, { resolve, timer });
  });
}

function resolveDecision(eventId, decision) {
  const entry = pending.get(eventId);
  if (!entry) return; // либо уже истёк таймаут, либо неизвестный id
  clearTimeout(entry.timer);
  pending.delete(eventId);
  entry.resolve(decision);
}

module.exports = {
  registerBridge,
  unregisterBridge,
  sendBadge,
  sendNotification,
  waitForDecision,
  resolveDecision,
};
