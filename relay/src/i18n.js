'use strict';

// Локализация того, что relay пишет юзеру в Telegram. Свой каталог, как и
// у хоста, — relay это отдельная деплойная единица (см. шапку telegram.js
// про тот же принцип для buildMessage).
//
// Откуда берётся язык, по убыванию точности:
//   1. event.locale в теле POST /events — это ровно тот язык, который стоит
//      в настройках расширения, то есть тот же, что в попапе и в тостах;
//   2. user.locale в записи юзера — то же самое, но с прошлого события
//      (нужно для ответов бота, которые не привязаны к событию);
//   3. language_code из Telegram при пейринге — единственное, что известно
//      до первого события;
//   4. английский.

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

// Первый распознанный вариант из переданных. Порядок задаёт вызывающий —
// см. комментарий выше.
function pick(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    if (normalized) return normalized;
  }
  return FALLBACK;
}

function format(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole));
}

function t(locale, key, params) {
  const catalog = CATALOGS[normalize(locale) || FALLBACK];
  const raw = catalog[key] !== undefined ? catalog[key] : CATALOGS[FALLBACK][key];
  if (raw === undefined) return key;
  return format(raw, params);
}

module.exports = { t, pick, normalize, SUPPORTED: Object.keys(CATALOGS), FALLBACK };
