'use strict';

// Канал 3 (телефон). Интерфейс send(event, settings) не изменился —
// router.js не знает, что канал больше не заглушка. Ошибки НЕ глушатся
// здесь намеренно: router.js уже оборачивает вызов канала в try/catch
// (см. router.js dispatch), а ipc-server.js's handleTestPhone читает
// брошенную ошибку напрямую для кнопки "Отправить тестовое" в popup.
//
// provider === 'telegram' здесь — это режим "свой бот" (bot token + chat id
// заданы юзером вручную). Приём кнопок Разрешить/Отклонить (two-way) для
// этого режима — отдельно, в telegram-poller.js (long polling), потому что
// получение решения не является ответом на HTTP-запрос отправки сообщения.
//
// provider === 'relay' — общий Telegram-бот через наш relay-сервер (Фаза 2,
// см. relay/): юзеру не нужно заводить своего бота, только один раз
// привязать чат через deep-link (popup.js, "Привязать через бота"). Решение
// приходит отдельным long-poll запросом (см. pollRelayDecision) — специально
// НЕ awaited внутри send(), иначе router.js держал бы весь цикл диспатча
// (notification/badge/phone идут последовательно) до 9.5 минут.

const extensionChannel = require('./extension-channel');
const { clientInfo } = require('../client-info');

const RELAY_BASE_URL = 'https://ai-agent-notify.ru';

function buildMessage(event) {
  const isPermission = event.type === 'permission_request';
  const isActionable = isPermission && event.needsDecision !== false;
  const label = event.sessionLabel || event.cwd || '';

  let title;
  if (isActionable) title = 'Агент просит разрешение';
  else if (isPermission) title = 'Агент задал вопрос';
  else title = 'Агент закончил';
  if (label) title += ` — ${label}`;

  let body;
  if (isPermission) body = event.summary || event.tool || 'требуется ваше внимание';
  else body = 'Задача завершена, ждёт вас';
  if (isPermission && !isActionable) body += ' — ответьте в терминале';

  return { title, body, isActionable };
}

// Без явного таймаута зависший/недоступный провайдер вешает fetch на
// неопределённое время — а вместе с ним и весь запрос test_phone/событие
// (сам процесс демона это не блокирует, но конкретный вызов send() зависает,
// и если к моменту ответа Service Worker расширения успеет перезапуститься
// (MV3 может это сделать даже при вроде бы открытом порте), ответ придёт
// уже нечему сопоставить — см. background.js).
const FETCH_TIMEOUT_MS = 10000;

async function assertOk(res, label) {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  throw new Error(`${label}: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
}

// ntfy: топик передаётся как часть URL (https://ntfy.sh/мой-топик или
// self-hosted аналог) — публикуем через JSON API на корень сервера, а не
// заголовками (Title-заголовок с кириллицей требует RFC 2047-кодирования,
// JSON-тело этой проблемы не имеет).
async function sendNtfy(event, phone) {
  if (!phone.ntfyTopicUrl) return;
  const { title, body } = buildMessage(event);
  const url = new URL(phone.ntfyTopicUrl);
  // URL.pathname процент-кодирует не-ASCII (кириллические топики) — топик
  // нужен в исходном виде для ntfy JSON API, не в percent-encoded форме.
  const topic = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const res = await fetch(`${url.origin}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, title, message: body, priority: 4 }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await assertOk(res, 'ntfy');
}

// Общий webhook — покрывает Discord (поле "content") и Slack (поле "text")
// одним запросом: оба сервиса тихо игнорируют незнакомые поля, так что
// отправка обоих ключей не ломает ни один из них.
async function sendWebhook(event, phone) {
  if (!phone.webhookUrl) return;
  const { title, body } = buildMessage(event);
  const text = `${title}\n${body}`;
  const res = await fetch(phone.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, text }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await assertOk(res, 'webhook');
}

async function sendPushover(event, phone) {
  if (!phone.pushoverToken || !phone.pushoverUserKey) return;
  const { title, body, isActionable } = buildMessage(event);
  const params = new URLSearchParams({
    token: phone.pushoverToken,
    user: phone.pushoverUserKey,
    title,
    message: body,
    // priority 1 = high (пробивает quiet hours), без emergency-повторов —
    // те требуют retry/expire и подтверждения через receipts, лишняя
    // сложность для MVP.
    priority: isActionable ? '1' : '0',
  });
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body: params,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await assertOk(res, 'Pushover');
}

// Свой Telegram-бот: отправка с inline-кнопками для permission_request.
// Нажатие кнопки обрабатывается отдельно в telegram-poller.js.
async function sendTelegram(event, phone) {
  if (!phone.telegramBotToken || !phone.telegramChatId) return;
  const { title, body, isActionable } = buildMessage(event);
  const payload = { chat_id: phone.telegramChatId, text: `${title}\n${body}` };
  if (isActionable) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          { text: '✅ Разрешить', callback_data: `allow:${event.id}` },
          { text: '❌ Отклонить', callback_data: `deny:${event.id}` },
        ],
      ],
    };
  }
  const res = await fetch(`https://api.telegram.org/bot${phone.telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await assertOk(res, 'Telegram');
}

// Ждать решения долго (relay сам держит /events/:id/decision до 9.5 минут,
// см. relay/src/config.js decisionTimeoutMs) — таймаут клиента должен быть
// заведомо больше, иначе fetch оборвётся раньше, чем relay успеет ответить.
const DECISION_POLL_TIMEOUT_MS = 600000;

async function pollRelayDecision(token, eventId) {
  const res = await fetch(`${RELAY_BASE_URL}/events/${encodeURIComponent(eventId)}/decision`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(DECISION_POLL_TIMEOUT_MS),
  });
  await assertOk(res, 'relay decision');
  const data = await res.json();
  if (data.decision) extensionChannel.resolveDecision(eventId, data.decision);
}

// Слепок клиента (ОС/версия хоста/архитектура) прикладываем к КАЖДОМУ
// событию, а не отдельным хендшейком при пейринге: отдельный эндпоинт
// пришлось бы ещё и вызывать по расписанию, чтобы данные не устаревали
// после обновления хоста или переустановки ОС, а так они всегда свежие
// ценой ~60 байт на событие. Отключается тумблером phone.relayMetrics —
// сами события при этом продолжают ходить, отключается только статистика.
function buildRelayBody(event, phone) {
  if (phone.relayMetrics === false) return event;
  return { ...event, client: clientInfo() };
}

async function sendRelay(event, phone) {
  if (!phone.relayToken) return;
  const res = await fetch(`${RELAY_BASE_URL}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${phone.relayToken}` },
    body: JSON.stringify(buildRelayBody(event, phone)),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await assertOk(res, 'relay');

  const isActionable = event.type === 'permission_request' && event.needsDecision !== false;
  if (!isActionable) return;

  // Намеренно не await — см. комментарий в шапке файла про блокировку router.js.
  pollRelayDecision(phone.relayToken, event.id).catch((err) =>
    console.error(`[phone-channel] relay: ожидание решения для ${event.id} упало: ${err.message}`)
  );
}

const SENDERS = {
  ntfy: sendNtfy,
  webhook: sendWebhook,
  pushover: sendPushover,
  telegram: sendTelegram,
  relay: sendRelay,
};

async function send(event, settings) {
  const phone = (settings && settings.phone) || {};
  const provider = phone.provider || 'none';
  if (provider === 'none') return;

  const sender = SENDERS[provider];
  if (!sender) {
    console.error(`[phone-channel] неизвестный provider "${provider}"`);
    return;
  }
  await sender(event, phone);
}

// Пейринг с shared-ботом (см. popup.js "Привязать через бота") — тоже идёт
// через демон, а не напрямую из popup, тем же принципом, что и остальная
// сетевая работа демона: расширение только показывает UI, HTTP делает демон.
async function pairStart() {
  const res = await fetch(`${RELAY_BASE_URL}/pair/start`, {
    method: 'POST',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await assertOk(res, 'relay pair/start');
  return res.json(); // { code, deepLink }
}

async function pairStatus(code) {
  const res = await fetch(`${RELAY_BASE_URL}/pair/status?code=${encodeURIComponent(code)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await assertOk(res, 'relay pair/status');
  return res.json(); // { paired, token? } либо { paired: false, expired: true }
}

module.exports = { send, buildMessage, pairStart, pairStatus, buildRelayBody };
