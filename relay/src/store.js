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

// locale — язык, на котором с этим юзером говорит бот. При создании берётся
// из language_code Telegram (единственное, что известно до первого события),
// дальше уточняется тем, что реально стоит в настройках расширения.
function createUser(dataDir, token, chatId, locale = null) {
  const users = load(dataDir);
  users[token] = { chatId, tier: 'free', createdAt: Date.now(), locale };
  save(dataDir, users);
  return users[token];
}

// Отдельно от metrics.recordEvent, хотя тот тоже правит запись юзера: язык
// обязан сохраняться и когда статистика выключена тумблером, иначе бот
// отвечал бы не на том языке именно тем, кто отказался от метрик.
function setLocale(dataDir, token, locale) {
  if (!locale) return;
  const users = load(dataDir);
  const user = users[token];
  if (!user || user.locale === locale) return;
  user.locale = locale;
  save(dataDir, users);
}

function getUser(dataDir, token) {
  return load(dataDir)[token];
}

module.exports = { load, save, createUser, setLocale, getUser };
