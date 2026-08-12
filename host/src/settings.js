'use strict';

const fs = require('fs');
const path = require('path');
const platform = require('./platform');
const { routingSettingsPath } = require('./constants');

const DEFAULTS_PATH = path.join(__dirname, '..', 'config', 'routing.default.json');

// Настройки живут в JSON-файле в конфиг-папке пользователя (platform.configDir()).
// При первом запуске копируются дефолты. Правки руками — ок, формат простой.

function ensureFile() {
  const dir = platform.configDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = routingSettingsPath();
  if (!fs.existsSync(target)) {
    fs.copyFileSync(DEFAULTS_PATH, target);
  }
  return target;
}

function load() {
  const target = ensureFile();
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
  try {
    const custom = JSON.parse(fs.readFileSync(target, 'utf8'));
    // Как и rules — phone мёржим на один уровень вглубь, а не заменяем
    // целиком: иначе частично сохранённый custom.phone (например, только
    // provider, без остальных полей) навсегда теряет дефолтные пустые поля
    // остальных провайдеров вместо того, чтобы их просто игнорировать.
    return {
      ...defaults,
      ...custom,
      rules: { ...defaults.rules, ...custom.rules },
      phone: { ...defaults.phone, ...custom.phone },
    };
  } catch (err) {
    console.error(`[settings] не удалось прочитать ${target}, использую дефолты: ${err.message}`);
    return defaults;
  }
}

function save(settings) {
  const target = ensureFile();
  fs.writeFileSync(target, JSON.stringify(settings, null, 2), 'utf8');
}

module.exports = { load, save, ensureFile };
