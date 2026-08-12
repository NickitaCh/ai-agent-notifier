'use strict';

// Обратная связь через общего бота: команда /feedback <текст>.
//
// Зачем отдельный канал, когда есть GitHub issues: для аудитории из Chrome
// Web Store гитхаб — заметный барьер (нужен аккаунт, нужно понимать, что
// такое issue), а Telegram у этих юзеров уже открыт — они именно в нём и
// получают уведомления. Пишем в файл (а не только пересылаем админу), чтобы
// сообщение не потерялось, если пересылка не удалась или админ не задан.
//
// Здесь, в отличие от metrics.js, chatId сохраняется намеренно: без него
// невозможно ответить человеку, а он сам осознанно написал в поддержку.
// Это отражено в политике приватности отдельным пунктом.

const fs = require('fs');
const path = require('path');

const FEEDBACK_FILE = 'feedback.ndjson';
// Телеграм и сам режет сообщения на 4096 символов, но полагаться на это не
// стоит: файл читают глазами, и одна гигантская строка делает его
// нечитаемым. Обрезаем с явной пометкой, чтобы не выглядело как баг.
const MAX_TEXT_LENGTH = 2000;

function save(dataDir, { chatId, text, username = null }, now = Date.now()) {
  const trimmed =
    text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}… [обрезано]` : text;
  const record = { ts: now, chatId, username, text: trimmed };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, FEEDBACK_FILE), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    // Не проглатываем полностью: пусть вызывающий решит, говорить ли юзеру
    // "не сохранилось". Молча потерянное сообщение в поддержку хуже, чем
    // потерянная строчка статистики.
    throw new Error(`не удалось сохранить обращение: ${err.message}`);
  }
  return record;
}

function list(dataDir) {
  try {
    return fs
      .readFileSync(path.join(dataDir, FEEDBACK_FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[feedback] чтение упало: ${err.message}`);
    return [];
  }
}

// Что показать админу в пересылке. Отдельная функция, чтобы формат
// сообщения можно было проверить тестом, не трогая сеть.
function formatForAdmin({ chatId, username, text }) {
  const who = username ? `@${username} (chat ${chatId})` : `chat ${chatId}`;
  return `💬 Обратная связь от ${who}:\n\n${text}`;
}

module.exports = { save, list, formatForAdmin, MAX_TEXT_LENGTH };
