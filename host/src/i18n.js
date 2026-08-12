'use strict';

// Локализация текстов, которые хост отправляет пользователю (сообщения на
// телефон). Отдельный маленький модуль со своими каталогами, а не общий с
// extension/i18n — по той же причине, по которой relay/src/telegram.js
// дублирует buildMessage вместо импорта из хоста: расширение, хост и relay
// это три независимые единицы доставки (браузер, exe на машине юзера,
// сервис на VPS), у каждой свой цикл обновления. Наборы строк почти не
// пересекаются — общий пакет ради восьми фраз стоил бы дороже дубля.
//
// Язык берётся из settings.locale, куда его кладёт расширение (см.
// extension/background.js): в браузере он определяется при первом запуске
// и дальше меняется переключателем в попапе. Так уведомление на телефоне
// приходит на том же языке, что и тост в браузере.

const CATALOGS = {
  ru: require('./i18n/ru.json'),
  en: require('./i18n/en.json'),
  es: require('./i18n/es.json'),
};

const FALLBACK = 'en';

function normalize(tag) {
  if (!tag) return null;
  const base = String(tag).toLowerCase().split(/[-_]/)[0];
  return CATALOGS[base] ? base : null;
}

// Запасной вариант, когда расширение ещё ни разу не подключалось и языка в
// настройках нет: локаль ОС. Не идеально (в русской Windows может стоять
// англоязычный Chrome), но лучше, чем молча выдать английский — а как
// только попап один раз откроется, значение перезапишется точным.
function osLocale() {
  const fromEnv = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
  if (fromEnv) return normalize(fromEnv);
  try {
    return normalize(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

function resolve(locale) {
  return normalize(locale) || osLocale() || FALLBACK;
}

function format(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole));
}

function t(locale, key, params) {
  const catalog = CATALOGS[resolve(locale)];
  const raw = catalog[key] !== undefined ? catalog[key] : CATALOGS[FALLBACK][key];
  if (raw === undefined) return key;
  return format(raw, params);
}

module.exports = { t, resolve, normalize, SUPPORTED: Object.keys(CATALOGS), FALLBACK };
