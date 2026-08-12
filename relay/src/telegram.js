'use strict';

// Тонкая обёртка над Telegram Bot API. buildMessage() намеренно дублирует
// логику host/src/channels/phone-channel.js, а не импортирует её — relay и
// host это независимые деплойные единицы (разный процесс, разная машина),
// шарить между ними код не имеет смысла (тот же принцип, что уже описан в
// CLAUDE.md для popup.js/notification-channel.js).

const FETCH_TIMEOUT_MS = 10000;

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

async function callApi(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

async function sendEventMessage(botToken, chatId, event) {
  const { title, body, isActionable } = buildMessage(event);
  const payload = { chat_id: chatId, text: `${title}\n${body}` };
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
  return callApi(botToken, 'sendMessage', payload);
}

function sendText(botToken, chatId, text) {
  return callApi(botToken, 'sendMessage', { chat_id: chatId, text });
}

function answerCallbackQuery(botToken, callbackQueryId, text) {
  return callApi(botToken, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text }).catch((err) => {
    // Чисто косметический ответ (убирает "часики" на кнопке) — не должен
    // рушить обработку самого решения, если сам этот запрос не удался.
    console.error(`[telegram] answerCallbackQuery упал: ${err.message}`);
  });
}

async function getBotUsername(botToken) {
  const me = await callApi(botToken, 'getMe', {});
  return me.username;
}

function setWebhook(botToken, url, secretToken) {
  return callApi(botToken, 'setWebhook', { url, secret_token: secretToken });
}

module.exports = { buildMessage, sendEventMessage, sendText, answerCallbackQuery, getBotUsername, setWebhook };
