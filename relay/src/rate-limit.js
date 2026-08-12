'use strict';

// Простой fixed-window rate-limit по ключу (обычно IP), в памяти. При этом
// масштабе (один общий бот, старт беты) выносить в Redis/что-то внешнее
// избыточно — процесс один, состояние может жить прямо в нём.

function createLimiter({ windowMs, max }) {
  // key -> { count, windowStart }
  const hits = new Map();

  function allow(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  }

  // Иначе Map растёт бесконечно на разовых/забаненных IP.
  function sweep() {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.windowStart >= windowMs) hits.delete(key);
    }
  }
  const timer = setInterval(sweep, windowMs);
  timer.unref();

  return { allow };
}

module.exports = { createLimiter };
