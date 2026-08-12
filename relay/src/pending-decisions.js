'use strict';

// Решение может прийти (callback_query от кнопки в Telegram) РАНЬШЕ, чем
// клиент-демон успеет начать его ждать (GET /events/:id/decision — это
// отдельный HTTP-запрос, не тот же самый, что POST /events, см. server.js:
// POST не может держать соединение открытым до 9.5 минут, иначе он
// блокирует остальные каналы в router.js на локальной стороне). Поэтому
// register() создаёт запись ДО отправки в Telegram (чтобы не проиграть гонку
// с мгновенным кликом), а resolveDecision() и awaitDecision() работают
// независимо друг от друга — решение, пришедшее до вызова awaitDecision(),
// просто лежит в entry.decision и отдаётся сразу, а не теряется.

// eventId -> { decision: undefined | 'allow' | 'deny' | null, timer, waiters: Function[] }
const state = new Map();

// Держим запись ещё немного после того, как решение стало известно — на
// случай если клиент опрашивает с небольшой задержкой (сетевой round-trip),
// иначе повторный awaitDecision() после уборки увидел бы "не регистрировали"
// и понял бы это как таймаут, хотя решение на самом деле было.
const CLEANUP_DELAY_MS = 30000;

function register(eventId, timeoutMs) {
  const entry = { decision: undefined, waiters: [], timer: null };
  entry.timer = setTimeout(() => resolveDecision(eventId, null), timeoutMs);
  state.set(eventId, entry);
}

function resolveDecision(eventId, decision) {
  const entry = state.get(eventId);
  if (!entry || entry.decision !== undefined) return; // не регистрировали или уже решено
  clearTimeout(entry.timer);
  entry.decision = decision;
  entry.waiters.forEach((resolve) => resolve(decision));
  entry.waiters = [];
  setTimeout(() => state.delete(eventId), CLEANUP_DELAY_MS).unref();
}

// Отдаёт решение, когда оно появится. Если register() для этого eventId не
// вызывался (или запись уже вычищена) — сразу null, тем же fail-open
// принципом, что и таймаут (согласуется с host/src/channels/extension-channel.js).
function awaitDecision(eventId) {
  const entry = state.get(eventId);
  if (!entry) return Promise.resolve(null);
  if (entry.decision !== undefined) return Promise.resolve(entry.decision);
  return new Promise((resolve) => entry.waiters.push(resolve));
}

module.exports = { register, resolveDecision, awaitDecision };
