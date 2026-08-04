'use strict';

// Общий секрет для TCP-порта демона. Любой локальный процесс от имени
// того же пользователя мог раньше подключиться к 127.0.0.1:8765 и слать
// поддельные события/читать решения — токен закрывает этот путь минимальной
// ценой (файл, который читают только свои же адаптеры).
//
// Токен НЕ защищает от другого пользователя той же машины с правами на
// чтение файлов текущего пользователя (Windows ACL на %APPDATA% этим
// файлом не ужесточаются) — porog защиты: "чужой процесс не найдёт секрет
// случайно/по умолчанию", а не "администратор соседнего аккаунта не достанет".

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const platform = require('./platform');

function tokenPath() {
  return path.join(platform.configDir(), 'auth-token');
}

// Читает существующий токен либо создаёт новый. Может быть вызвано и
// демоном, и клиентом — кто первый добежал, тот и создал файл, остальные
// просто читают тот же самый.
function loadOrCreateToken() {
  const p = tokenPath();
  try {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // файла ещё нет — создадим ниже
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(platform.configDir(), { recursive: true });
  fs.writeFileSync(p, token, { mode: 0o600 });
  return token;
}

module.exports = { loadOrCreateToken };
