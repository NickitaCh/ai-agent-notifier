'use strict';

// Локализация расширения. Работает и в popup/welcome (через <script>), и в
// service worker'е (через importScripts) — поэтому вешается на self, а не
// на window, и грузит каталоги через fetch(chrome.runtime.getURL(...)),
// который доступен в обоих контекстах.
//
// Почему свой движок, а не chrome.i18n: chrome.i18n намертво привязан к
// языку интерфейса браузера и не даёт его переопределить. А язык здесь
// обязан быть один на всех четырёх поверхностях (попап, тост Chrome,
// сообщение на телефон, ответы Telegram-бота) — и три из них живут вне
// браузера. Общий источник истины — settings.locale в демоне; chrome.i18n
// остался только для name/description в manifest (см. _locales/), потому
// что карточку в Web Store иначе не локализовать.

const SUPPORTED = ['ru', 'en', 'es'];
const FALLBACK = 'en';

// Каталог языка, на который падаем, если ключ забыли перевести. Английский,
// а не русский: непереведённая строка на английском понятна почти всем в
// целевой аудитории, на русском — почти никому за её пределами.
let fallbackMessages = null;
let messages = null;
let current = FALLBACK;

// 'ru-RU' / 'es-419' -> 'ru' / 'es'. Регион нам не важен: различий между
// вариантами испанского в этих строках нет, а плодить es-ES/es-MX ради
// одинакового текста — лишняя работа на каждый новый ключ.
function normalize(tag) {
  if (!tag) return null;
  const base = String(tag).toLowerCase().split(/[-_]/)[0];
  return SUPPORTED.includes(base) ? base : null;
}

// Язык интерфейса браузера — используется ровно один раз, при первом
// запуске (см. background.js). Дальше язык берётся из настроек, чтобы
// переключатель в попапе имел смысл.
function detect() {
  const fromBrowser = chrome.i18n && chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : null;
  return normalize(fromBrowser) || FALLBACK;
}

async function loadCatalog(locale) {
  const res = await fetch(chrome.runtime.getURL(`i18n/${locale}.json`));
  if (!res.ok) throw new Error(`каталог ${locale} не загрузился: ${res.status}`);
  return res.json();
}

// Промис последней загрузки. Нужен потому, что t() синхронный, а каталог
// грузится по сети: service worker просыпается от события и может дойти до
// показа уведомления раньше, чем fetch завершится — тогда в тосте оказался
// бы сам ключ ("event.titlePermission") вместо текста. Вызывающий код,
// который может стартовать в такой момент, ждёт ready() (см. background.js).
let readyPromise = null;

function use(locale) {
  readyPromise = (async () => {
    const target = normalize(locale) || FALLBACK;
    if (!fallbackMessages) fallbackMessages = await loadCatalog(FALLBACK);
    messages = target === FALLBACK ? fallbackMessages : await loadCatalog(target);
    current = target;
    return target;
  })();
  return readyPromise;
}

function ready() {
  return readyPromise || Promise.resolve();
}

// Плейсхолдеры вида {name}. Намеренно примитивно: ни склонений, ни
// плюрализации — в этих строках нет ни одного места, где число или род
// подставлялись бы в середину фразы.
function format(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole));
}

function t(key, params) {
  const raw = (messages && messages[key]) || (fallbackMessages && fallbackMessages[key]);
  // Возвращаем сам ключ, а не пустую строку: пустая надпись в интерфейсе
  // выглядит как поломка вёрстки, а видимый "phone.testButton" сразу
  // говорит, что именно забыли перевести.
  if (raw === undefined) return key;
  return format(raw, params);
}

// Проставляет тексты во всём поддереве. data-i18n — в textContent,
// data-i18n-placeholder/-title — в соответствующие атрибуты.
function apply(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  if (root.documentElement) root.documentElement.lang = current;
}

self.I18n = { SUPPORTED, FALLBACK, detect, normalize, use, ready, t, apply, current: () => current };
