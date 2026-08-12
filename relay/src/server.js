#!/usr/bin/env node
'use strict';

// Точка входа relay-сервиса. Чистый http (без фреймворков) — трафик
// маленький (пейринг + события одного продукта), фреймворк был бы лишней
// зависимостью на сервере, который и так общий с другими проектами.

const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const pairingCodes = require('./pairing-codes');
const pendingDecisions = require('./pending-decisions');
const auth = require('./auth');
const telegram = require('./telegram');
const { createLimiter } = require('./rate-limit');

const pairStartLimiter = createLimiter(config.pairStartRateLimit);

function clientIp(req) {
  // За nginx (см. nginx/aan-relay.conf) стоит X-Forwarded-For — сырой
  // req.socket.remoteAddress иначе был бы всегда 127.0.0.1.
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // защита от неадекватно большого тела
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error(`битый JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function handlePairStart(req, res) {
  if (!pairStartLimiter.allow(clientIp(req))) {
    return sendJson(res, 429, { error: 'слишком много попыток, попробуйте позже' });
  }
  const code = pairingCodes.createCode(config.pairingCodeTtlMs);
  const username = await telegram.getBotUsername(config.botToken);
  sendJson(res, 200, { code, deepLink: `https://t.me/${username}?start=${code}` });
}

function handlePairStatus(req, res, url) {
  const code = url.searchParams.get('code') || '';
  const entry = pairingCodes.getCode(code);
  if (!entry) return sendJson(res, 200, { paired: false, expired: true });
  if (!entry.token) return sendJson(res, 200, { paired: false });
  sendJson(res, 200, { paired: true, token: entry.token });
}

// Всегда отвечаем Telegram 200 сразу — сама доставка ответа юзеру/резолв
// решения происходит асинхронно следом, вебхук не должен ждать сетевого
// round-trip обратно в Telegram API, чтобы не схватить таймаут/ретрай.
async function handleTelegramWebhook(req, res) {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== config.webhookSecret) {
    res.writeHead(403).end();
    return;
  }
  const update = await readJsonBody(req);
  res.writeHead(200).end();
  processTelegramUpdate(update).catch((err) => console.error(`[webhook] обработка апдейта упала: ${err.message}`));
}

async function processTelegramUpdate(update) {
  if (update.message?.text) {
    await handleIncomingMessage(update.message);
    return;
  }
  const cq = update.callback_query;
  if (cq?.data) {
    const sep = cq.data.indexOf(':');
    const action = sep === -1 ? null : cq.data.slice(0, sep);
    const eventId = sep === -1 ? null : cq.data.slice(sep + 1);
    if (eventId && (action === 'allow' || action === 'deny')) {
      pendingDecisions.resolveDecision(eventId, action);
      await telegram.answerCallbackQuery(config.botToken, cq.id, action === 'allow' ? 'Разрешено' : 'Отклонено');
    }
  }
}

async function handleIncomingMessage(message) {
  const chatId = message.chat.id;
  const text = message.text.trim();
  if (!text.startsWith('/start')) return;

  const code = text.slice('/start'.length).trim();
  if (!code) {
    await telegram.sendText(
      config.botToken,
      chatId,
      'Этот бот используется для привязки AI Agent Notifier. Откройте попап расширения → «Телефон» → «Привязать через бота».'
    );
    return;
  }

  const entry = pairingCodes.getCode(code);
  if (!entry) {
    await telegram.sendText(
      config.botToken,
      chatId,
      'Код не найден или истёк. Вернитесь в настройки расширения и начните привязку заново.'
    );
    return;
  }

  // Кап считаем по РАЗНЫМ chat.id, а не по токенам — повторная привязка
  // того же чата (второе устройство того же юзера) не должна упираться в
  // лимит наравне с действительно новым юзером.
  const existingUsers = Object.values(store.load(config.dataDir));
  const isNewChat = !existingUsers.some((u) => u.chatId === chatId);
  if (isNewChat && new Set(existingUsers.map((u) => u.chatId)).size >= config.maxUsers) {
    await telegram.sendText(
      config.botToken,
      chatId,
      'Общий бот сейчас на паузе — слишком много подключений для беты. Попробуйте позже или используйте режим "свой бот" в настройках расширения.'
    );
    return;
  }

  const token = crypto.randomBytes(24).toString('hex');
  store.createUser(config.dataDir, token, chatId);
  pairingCodes.claimCode(code, token);
  await telegram.sendText(config.botToken, chatId, '✅ Привязано! Можно вернуться в настройки расширения.');
}

// Только отправка + быстрый ack. НЕ ждёт решения здесь — POST, который
// висит до 9.5 минут, заблокировал бы остальные каналы в router.js на
// локальной стороне (тот же цикл вызывает notification/badge/phone
// последовательно). Ожидание — отдельным запросом, см. handleEventDecision.
async function handleEvents(req, res) {
  const user = auth.authenticate(req, config.dataDir);
  if (!user) return sendJson(res, 401, { error: 'unauthorized' });

  const event = await readJsonBody(req);
  if (!event.id || !event.type) return sendJson(res, 400, { error: 'нужны как минимум id и type' });

  const isActionable = event.type === 'permission_request' && event.needsDecision !== false;
  // Регистрируем ДО отправки в Telegram — чтобы не проиграть гонку с
  // мгновенным нажатием кнопки (см. pending-decisions.js).
  if (isActionable) pendingDecisions.register(event.id, config.decisionTimeoutMs);

  try {
    await telegram.sendEventMessage(config.botToken, user.chatId, event);
  } catch (err) {
    return sendJson(res, 502, { error: `не удалось отправить в Telegram: ${err.message}` });
  }

  sendJson(res, 200, { ok: true });
}

// Долгий long-poll — держит соединение, пока не придёт решение или не
// истечёт таймаут. Клиент-демон вызывает это отдельно и не блокирует им
// остальные каналы (сам решает, ждать ли, в своей логике).
async function handleEventDecision(req, res, eventId) {
  const user = auth.authenticate(req, config.dataDir);
  if (!user) return sendJson(res, 401, { error: 'unauthorized' });
  const decision = await pendingDecisions.awaitDecision(eventId);
  sendJson(res, 200, { decision });
}

function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  const decisionMatch = req.method === 'GET' && /^\/events\/([^/]+)\/decision$/.exec(url.pathname);

  let handler = null;
  if (req.method === 'POST' && url.pathname === '/pair/start') handler = handlePairStart;
  else if (req.method === 'GET' && url.pathname === '/pair/status') handler = (rq, rs) => handlePairStatus(rq, rs, url);
  else if (req.method === 'POST' && url.pathname === '/telegram/webhook') handler = handleTelegramWebhook;
  else if (req.method === 'POST' && url.pathname === '/events') handler = handleEvents;
  else if (decisionMatch) handler = (rq, rs) => handleEventDecision(rq, rs, decodeURIComponent(decisionMatch[1]));

  if (!handler) {
    res.writeHead(404).end();
    return;
  }

  Promise.resolve(handler(req, res)).catch((err) => {
    console.error(`[server] ${req.method} ${url.pathname} упал: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  });
}

function main() {
  const server = http.createServer(route);
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`[server] слушаю 127.0.0.1:${config.port}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  route,
  // Экспортировано ради юнит-теста на кап регистраций — не для
  // использования снаружи модуля в проде (тот же принцип, что в
  // host/src/ipc-server.js для mergeSnoozeByProject/buildHostHello).
  handleIncomingMessage,
};
