'use strict';

// Проверки каталогов локализации расширения. Живут в host/test, потому что
// у extension/ нет своего npm-проекта и тест-раннера (см. CLAUDE.md), а
// файлы лежат рядом — тот же приём, что в installer.test.js, который читает
// extension/manifest.json.
//
// Смысл: каталоги набираются руками, и три самые вероятные ошибки —
// забыть ключ в одном из языков, оставить ключ, который больше нигде не
// используется, и сослаться в коде на ключ, которого в каталоге нет. Первые
// две дают кривой интерфейс, третья — надпись вида "phone.testButton"
// вместо текста. Глазами это ловится плохо, поэтому ловится тестом.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const EXT_DIR = path.join(__dirname, '..', '..', 'extension');
const I18N_DIR = path.join(EXT_DIR, 'i18n');
const LOCALES = ['ru', 'en', 'es'];
const REFERENCE = 'ru';

function catalog(locale) {
  return JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${locale}.json`), 'utf8'));
}

function readExt(...parts) {
  return fs.readFileSync(path.join(EXT_DIR, ...parts), 'utf8');
}

function allSources() {
  return [
    readExt('popup.html'),
    readExt('popup.js'),
    readExt('welcome.html'),
    readExt('welcome.js'),
    readExt('background.js'),
    readExt('channels', 'notification-channel.js'),
  ].join('\n');
}

// Точный набор: data-i18n* в разметке и все строковые литералы внутри
// вызова t(...) — включая тернарник t(x ? 'a.b' : 'c.d'), поэтому берём
// аргументы целиком, а не только первый.
function usedKeysStrict() {
  const sources = allSources();
  const keys = new Set();
  for (const m of sources.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) keys.add(m[1]);
  for (const call of sources.matchAll(/\bt\(([^)]*)/g)) {
    for (const lit of call[1].matchAll(/'([^']+)'/g)) keys.add(lit[1]);
  }
  return keys;
}

// Расширенный набор: вообще любой литерал, похожий на ключ. Нужен только
// для поиска мёртвых ключей — там ошибиться в сторону "используется"
// безопасно, а strict-версия дала бы ложные срабатывания на ключах,
// которые собираются в переменную до вызова t().
function usedKeysLoose() {
  const keys = usedKeysStrict();
  for (const m of allSources().matchAll(/'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'/g)) keys.add(m[1]);
  return keys;
}

test('во всех языках одинаковый набор ключей', () => {
  const reference = Object.keys(catalog(REFERENCE)).sort();
  for (const locale of LOCALES) {
    if (locale === REFERENCE) continue;
    const keys = Object.keys(catalog(locale)).sort();
    const missing = reference.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !reference.includes(k));
    assert.deepEqual(missing, [], `в ${locale}.json не хватает ключей`);
    assert.deepEqual(extra, [], `в ${locale}.json есть лишние ключи`);
  }
});

test('ни одна строка перевода не пустая', () => {
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(catalog(locale))) {
      assert.equal(typeof value, 'string', `${locale}.json: ${key} — не строка`);
      assert.ok(value.trim().length > 0, `${locale}.json: ${key} — пустая строка`);
    }
  }
});

test('плейсхолдеры {…} совпадают во всех языках', () => {
  // Перевод, потерявший {time} или переименовавший его в {hora}, оставляет
  // в интерфейсе либо дырку, либо literal "{hora}" — заметно только вживую.
  const placeholders = (text) => (text.match(/\{(\w+)\}/g) || []).sort();
  const reference = catalog(REFERENCE);
  for (const locale of LOCALES) {
    if (locale === REFERENCE) continue;
    const other = catalog(locale);
    for (const [key, value] of Object.entries(reference)) {
      assert.deepEqual(
        placeholders(other[key]),
        placeholders(value),
        `${locale}.json: у ключа ${key} разошлись плейсхолдеры`
      );
    }
  }
});

test('каждый ключ, используемый в коде, есть в каталогах', () => {
  const reference = catalog(REFERENCE);
  const missing = [...usedKeysStrict()].filter((key) => !(key in reference)).sort();
  assert.deepEqual(missing, [], 'код ссылается на ключи, которых нет в каталоге');
});

test('в каталоге нет ключей, которые нигде не используются', () => {
  const used = usedKeysLoose();
  const unused = Object.keys(catalog(REFERENCE))
    .filter((key) => !used.has(key))
    .sort();
  assert.deepEqual(unused, [], 'мёртвые ключи в каталоге — удалить или начать использовать');
});

test('в разметке не осталось захардкоженного текста вместо ключей', () => {
  // Кириллица в popup.html/welcome.html теперь допустима только в
  // комментариях и в <style> — весь видимый текст приходит из каталогов.
  for (const file of ['popup.html', 'welcome.html']) {
    const html = readExt(file);
    const body = html.slice(html.indexOf('<body>'));
    const withoutComments = body
      .replace(/<!--[\s\S]*?-->/g, '')
      // Переключатель языков — исключение: названия языков намеренно
      // написаны каждое на своём языке и не переводятся. Испанец должен
      // узнать "Русский" в списке, даже не читая кириллицу.
      .replace(/<div id="langRow"[\s\S]*?<\/div>/, '');
    const visible = [...withoutComments.matchAll(/>([^<>]+)</g)]
      .map((m) => m[1].trim())
      .filter((text) => /[А-Яа-яЁё]/.test(text));
    assert.deepEqual(visible, [], `${file}: остался текст в разметке`);
  }
});
