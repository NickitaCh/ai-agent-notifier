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
const metrics = require('./metrics');
const feedback = require('./feedback');
const { createLimiter } = require('./rate-limit');

const pairStartLimiter = createLimiter(config.pairStartRateLimit);
const feedbackLimiter = createLimiter(config.feedbackRateLimit);

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
    metrics.recordPairing(config.dataDir, 'rejected_rate');
    return sendJson(res, 429, { error: 'слишком много попыток, попробуйте позже' });
  }
  const code = pairingCodes.createCode(config.pairingCodeTtlMs);
  const username = await telegram.getBotUsername(config.botToken);
  metrics.recordPairing(config.dataDir, 'started');
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

async function handleFeedback(message) {
  const chatId = message.chat.id;
  const text = message.text.trim().slice('/feedback'.length).trim();

  if (!text) {
    await telegram.sendText(
      config.botToken,
      chatId,
      'Напишите пожелание или опишите проблему одной командой, например:\n/feedback не приходят уведомления после перезагрузки'
    );
    return;
  }

  if (!feedbackLimiter.allow(String(chatId))) {
    await telegram.sendText(config.botToken, chatId, 'Слишком много сообщений подряд — попробуйте позже.');
    return;
  }

  let record;
  try {
    record = feedback.save(config.dataDir, { chatId, text, username: message.from?.username || null });
  } catch (err) {
    console.error(`[feedback] ${err.message}`);
    await telegram.sendText(config.botToken, chatId, 'Не получилось сохранить обращение. Попробуйте ещё раз позже.');
    return;
  }

  // Пересылка админу — необязательная: обращение уже на диске, и если
  // ADMIN_CHAT_ID не задан или личка недоступна, юзеру всё равно надо
  // ответить "спасибо", а не "ошибка".
  if (config.adminChatId) {
    try {
      await telegram.sendText(config.botToken, config.adminChatId, feedback.formatForAdmin(record));
    } catch (err) {
      console.error(`[feedback] не удалось переслать админу: ${err.message}`);
    }
  }

  await telegram.sendText(config.botToken, chatId, '✅ Спасибо, передал. Если понадобится уточнить — напишу сюда же.');
}

async function handleIncomingMessage(message) {
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text.startsWith('/feedback')) {
    await handleFeedback(message);
    return;
  }

  if (!text.startsWith('/start')) {
    // Раньше любое постороннее сообщение молча игнорировалось — человек,
    // написавший боту "не работает", не получал вообще ничего в ответ.
    await telegram.sendText(
      config.botToken,
      chatId,
      'Я умею две вещи: привязывать расширение (кнопка «Привязать через бота» в настройках) и принимать обратную связь — напишите /feedback и текст.'
    );
    return;
  }

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
    // Без этого счётчика про упёршийся кап узнаёшь только случайно — юзер
    // просто видит "бот на паузе" и уходит молча.
    metrics.recordPairing(config.dataDir, 'rejected_cap');
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
  metrics.recordPairing(config.dataDir, 'completed');
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

  const uid = metrics.recordEvent(config.dataDir, user.token, event);

  const isActionable = event.type === 'permission_request' && event.needsDecision !== false;
  // Регистрируем ДО отправки в Telegram — чтобы не проиграть гонку с
  // мгновенным нажатием кнопки (см. pending-decisions.js).
  if (isActionable) {
    // Отсчёт латентности начинаем здесь же, а не в момент отправки в
    // Telegram: юзер ждёт с момента, как агент упёрся в вопрос, и время
    // самой отправки — тоже часть этого ожидания.
    metrics.trackActionable(event.id, uid, event.agent);
    pendingDecisions.register(event.id, config.decisionTimeoutMs, (decision) =>
      metrics.recordDecision(config.dataDir, event.id, decision === null ? 'timeout' : decision)
    );
  }

  try {
    await telegram.sendEventMessage(config.botToken, user.chatId, event);
  } catch (err) {
    metrics.recordDeliveryError(config.dataDir, user.token, err.message);
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
  // Чистим на старте, а не по таймеру: рестарт сервиса случается заведомо
  // чаще, чем раз в полгода (деплой, обновление хоста), а лишний
  // долгоживущий таймер в процессе — лишняя сущность.
  metrics.pruneOldMonths(config.dataDir);
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
