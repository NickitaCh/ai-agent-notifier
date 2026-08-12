'use strict';

// Одноразовые коды пейринга — только в памяти (переживать рестарт не нужно,
// юзер просто откроет попап заново и получит новый код/ссылку). code ->
// { expiresAt, token }. token появляется, как только юзер написал боту
// /start <code> (см. telegram.js) — до этого момента token === null.

const crypto = require('crypto');

const codes = new Map();

function createCode(ttlMs) {
  const code = crypto.randomBytes(16).toString('hex');
  codes.set(code, { expiresAt: Date.now() + ttlMs, token: null });
  return code;
}

// Возвращает запись, только если код существует и ещё не истёк — иначе null,
// как для "не найдено", так и для "просрочен" (вызывающему коду разница не
// важна, оба случая означают "начните пейринг заново").
function getCode(code) {
  const entry = codes.get(code);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    codes.delete(code);
    return null;
  }
  return entry;
}

function claimCode(code, token) {
  const entry = getCode(code);
  if (!entry) return false;
  entry.token = token;
  return true;
}

// Периодическая уборка просроченных кодов, на которые никто не вернулся
// узнать статус (иначе Map росла бы бесконечно на заброшенных попытках
// пейринга). Не экспортируется отдельно — побочный эффект require().
function sweepExpired() {
  const now = Date.now();
  for (const [code, entry] of codes) {
    if (now > entry.expiresAt) codes.delete(code);
  }
}
const sweepTimer = setInterval(sweepExpired, 60000);
sweepTimer.unref(); // не должен держать процесс живым сам по себе

module.exports = { createCode, getCode, claimCode };
