'use strict';

// Постоянное хранилище token -> { chatId, tier, createdAt }. Плоский JSON-
// файл, как и routing.json в host/ — при этом масштабе (десятки-сотни
// юзеров) полноценная БД избыточна, а формат тривиально читать руками при
// отладке. Пишем синхронно: нагрузка на пейринг/события низкая, а
// синхронная запись избавляет от гонок между конкурентными запросами без
// отдельного лока.

const fs = require('fs');
const path = require('path');

function ensureFile(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, 'users.json');
  if (!fs.existsSync(target)) fs.writeFileSync(target, '{}', 'utf8');
  return target;
}

function load(dataDir) {
  const target = ensureFile(dataDir);
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    console.error(`[store] не удалось прочитать ${target}, считаю пустым: ${err.message}`);
    return {};
  }
}

function save(dataDir, users) {
  const target = ensureFile(dataDir);
  fs.writeFileSync(target, JSON.stringify(users, null, 2), 'utf8');
}

function createUser(dataDir, token, chatId) {
  const users = load(dataDir);
  users[token] = { chatId, tier: 'free', createdAt: Date.now() };
  save(dataDir, users);
  return users[token];
}

function getUser(dataDir, token) {
  return load(dataDir)[token];
}

module.exports = { load, save, createUser, getUser };
