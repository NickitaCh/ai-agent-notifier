'use strict';

// Конфиг только из переменных окружения — сервис деплоится как systemd unit,
// секреты (BOT_TOKEN, WEBHOOK_SECRET) не должны лежать в репозитории.

const path = require('path');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана обязательная переменная окружения ${name}`);
  return value;
}

module.exports = {
  port: Number(process.env.PORT || 8443),
  botToken: required('BOT_TOKEN'),
  // Telegram присылает этот же секрет заголовком X-Telegram-Bot-Api-Secret-Token
  // на каждый webhook-запрос — так отличаем реальный Telegram от кого угодно
  // ещё, кто узнает URL вебхука (см. setWebhook secret_token в install.js).
  webhookSecret: required('WEBHOOK_SECRET'),
  // Куда писать pairing-таблицу (token -> chatId), переживает рестарт процесса.
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  // Статические страницы (index.html/privacy.html), которые relay отдаёт по
  // "/" и "/privacy.html" — сгенерированы из docs/ скриптом
  // scripts/sync-public.js, см. его шапку про то, почему копия, а не общий
  // источник в рантайме.
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'),
  // Максимум, сколько relay держит открытый POST /events, ожидая решения —
  // выровнено с потолком хука Claude Code (10 мин), см. host/README.md.
  decisionTimeoutMs: Number(process.env.DECISION_TIMEOUT_MS || 570000),
  // TTL кода пейринга — время на то, чтобы юзер успел тапнуть deep-link и
  // нажать Start в Telegram после того, как расширение его сгенерировало.
  pairingCodeTtlMs: Number(process.env.PAIRING_CODE_TTL_MS || 600000),
  // Safety valve на время беты — кап на число РАЗНЫХ chat.id (не токенов:
  // несколько устройств одного юзера не должны съедать чужие места). Не
  // бизнес-лимит free/pro (см. TODO про tier), а просто потолок нагрузки на
  // маленький VPS, пока не проверено поведение под реальным трафиком.
  maxUsers: Number(process.env.MAX_USERS || 500),
  // Rate-limit на /pair/start по IP — защита от спама по эндпоинту
  // (создание кодов ничего не стоит по деньгам, но не бесплатно по памяти).
  pairStartRateLimit: {
    windowMs: Number(process.env.PAIR_START_WINDOW_MS || 600000),
    max: Number(process.env.PAIR_START_MAX || 10),
  },
  // Куда пересылать /feedback. Необязательный: если не задан, обращения
  // всё равно пишутся в feedback.ndjson, просто не прилетают в личку.
  adminChatId: process.env.ADMIN_CHAT_ID || '',
  // Лимит на /feedback — по chat.id, а не по IP: у вебхука IP всегда
  // телеграмовский, различать юзеров по нему невозможно.
  feedbackRateLimit: {
    windowMs: Number(process.env.FEEDBACK_WINDOW_MS || 3600000),
    max: Number(process.env.FEEDBACK_MAX || 5),
  },
};
