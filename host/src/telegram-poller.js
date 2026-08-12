'use strict';

// Two-way для канала "телефон" в режиме "свой Telegram-бот": единственная
// задача — поймать нажатие inline-кнопки Разрешить/Отклонить
// (callback_query от long-polling getUpdates) и зарезолвить решение тем же
// путём, что клик в расширении — extensionChannel.resolveDecision(). Демон
// не различает, откуда пришло решение (см. extension-channel.js).
//
// Обычные текстовые сообщения боту игнорируются: у режима "свой бот" нет
// pairing-флоу (в отличие от будущего shared-бота на relay) — юзер сам
// вписывает bot token/chat id в настройки, боту достаточно уметь только
// присылать кнопки и принимать их нажатия.

const fs = require('fs');
const settingsStore = require('./settings');
const extensionChannel = require('./channels/extension-channel');
const { telegramOffsetPath } = require('./constants');

const IDLE_RETRY_MS = 5000; // provider !== 'telegram' или не настроено — просто ждём и перепроверяем
const POLL_TIMEOUT_S = 25; // long-polling таймаут на стороне Telegram

let running = false;

function loadOffset() {
  try {
    return parseInt(fs.readFileSync(telegramOffsetPath(), 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset) {
  try {
    fs.writeFileSync(telegramOffsetPath(), String(offset), 'utf8');
  } catch (err) {
    console.error(`[telegram-poller] не удалось сохранить offset: ${err.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Любое обычное сообщение боту (не нажатие кнопки) логируем с chat.id —
// это единственный надёжный способ узнать telegramChatId для настроек:
// демон уже поллит getUpdates сам, так что открывать getUpdates в браузере
// вручную бессмысленно (демон, скорее всего, успеет забрать апдейт первым).
function logIncomingMessage(update) {
  const chatId = update.message?.chat?.id;
  if (chatId === undefined) return;
  const text = update.message.text || '';
  console.error(
    `[telegram-poller] сообщение от chat.id=${chatId} ("${text}") — впишите этот id в поле "Chat ID" настроек`
  );
}

// Нажатие кнопки -> резолвим решение + гасим "часики" на кнопке в клиенте
// (answerCallbackQuery — чисто косметический ответ, ошибку игнорируем).
function handleUpdate(update, botToken) {
  logIncomingMessage(update);
  const cq = update.callback_query;
  if (!cq || typeof cq.data !== 'string') return;
  const sep = cq.data.indexOf(':');
  if (sep === -1) return;
  const action = cq.data.slice(0, sep);
  const eventId = cq.data.slice(sep + 1);
  if (!eventId || (action !== 'allow' && action !== 'deny')) return;

  extensionChannel.resolveDecision(eventId, action);

  fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cq.id }),
  }).catch(() => {});
}

async function pollOnce(botToken, offset) {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset + 1}`,
    { signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000) }
  );
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'неизвестная ошибка Telegram API');
  return data.result;
}

async function loopOnce() {
  const settings = settingsStore.load();
  const phone = settings.phone || {};
  if (phone.provider !== 'telegram' || !phone.telegramBotToken) {
    await sleep(IDLE_RETRY_MS);
    return;
  }

  let offset = loadOffset();
  try {
    const updates = await pollOnce(phone.telegramBotToken, offset);
    for (const update of updates) {
      offset = Math.max(offset, update.update_id);
      handleUpdate(update, phone.telegramBotToken);
    }
    if (updates.length) saveOffset(offset);
  } catch (err) {
    console.error(`[telegram-poller] getUpdates упал: ${err.message}`);
    await sleep(IDLE_RETRY_MS);
  }
}

async function start() {
  if (running) return;
  running = true;
  console.error('[telegram-poller] запущен (активируется, когда phone.provider === "telegram")');
  while (running) {
    await loopOnce();
  }
}

function stop() {
  running = false;
}

module.exports = { start, stop };
