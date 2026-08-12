'use strict';

// Регресс на реальный инцидент 12.08.2026: extension/i18n.js объявлял свои
// внутренние функции (t, apply, format, detect...) на верхнем уровне файла.
// В классических <script> (не модулях) верхнеуровневые имена делят ОДИН
// глобальный scope между всеми тегами страницы — popup.html подключает
// i18n.js первым тегом, а popup.js вторым, и там тоже верхнеуровневый
// `const t = ...`. Из-за этого при открытии попапа падало
// "Uncaught SyntaxError: Identifier 't' has already been declared" —
// ошибка на этапе создания привязок для всего скрипта, ДО первой строки,
// так что popup.js не выполнялся целиком: ни одно поле не заполнялось, а
// причина в разметке никак не была видна (симптом выглядел как проблема с
// демоном/связью, хотя дело было чисто в JS).
//
// `node --check` (и host/test/*.test.js в целом) эту ошибку не ловит
// принципиально — каждый файл синтаксически валиден сам по себе, конфликт
// возникает только когда несколько файлов делят один scope. Эмулируем это
// через vm: грузим файлы в один и тот же vm-контекст в том порядке, в
// котором их подключает реальная страница/service worker, и проверяем, что
// вторая (и последующие) загрузка не бросает SyntaxError о редекларации.
//
// Дальше выполнение неизбежно упрётся в отсутствие document/chrome — это
// ожидаемо и не тестируется здесь; конфликт деклараций проверяется на
// этапе GlobalDeclarationInstantiation, который выполняется целиком ДО
// первой строки скрипта, так что более поздний ранний крах (например,
// ReferenceError на `chrome` в первой же строке popup.js) не мешает
// обнаружить конфликт, возникающий из-за строки в середине файла.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT_DIR = path.join(__dirname, '..', '..', 'extension');

function readExt(rel) {
  return fs.readFileSync(path.join(EXT_DIR, rel), 'utf8');
}

// Запускает файлы по очереди в одном контексте — так же, как браузер грузит
// несколько <script> тегов на одну страницу (и как importScripts грузит
// файлы в текущий global scope воркера). Возвращает ошибку, если её
// выбросил КОНКРЕТНО последний файл — та, что нас интересует; более ранний
// (ожидаемый) крах предыдущих файлов не должен маскировать проверку.
function runSequenceCatchLast(files) {
  const context = vm.createContext({ self: undefined, console });
  context.self = context; // self.I18n = ... должно писать в тот же контекст
  let lastError = null;
  for (const file of files) {
    try {
      vm.runInContext(readExt(file), context, { filename: file });
    } catch (err) {
      lastError = { file, err };
      // Не прерываем цикл: интересует именно тот файл, где редекларация
      // РЕАЛЬНО происходит (последний в списке для наших сценариев), а
      // не первый попавшийся ReferenceError на отсутствующем chrome/document.
    }
  }
  return lastError;
}

function assertNoRedeclaration(files, targetFile) {
  const result = runSequenceCatchLast(files);
  // `err.name`, а не `instanceof SyntaxError`: vm.createContext создаёт
  // отдельный realm со своим глобальным SyntaxError-конструктором, и
  // instanceof молча возвращает false для ошибки из чужого realm'а — тест
  // с instanceof проходил бы вхолостую, даже когда конфликт реально есть
  // (обнаружено при обкатке этого же теста на нефиксенном i18n.js).
  if (result && result.file === targetFile && result.err.name === 'SyntaxError') {
    assert.fail(
      `${targetFile} конфликтует именем с одним из [${files.slice(0, -1).join(', ')}] ` +
        `в общем global scope: ${result.err.message}`
    );
  }
}

test('popup.html: i18n.js + popup.js не конфликтуют именами в общем scope', () => {
  assertNoRedeclaration(['i18n.js', 'popup.js'], 'popup.js');
});

test('welcome.html: i18n.js + welcome.js не конфликтуют именами в общем scope', () => {
  assertNoRedeclaration(['i18n.js', 'welcome.js'], 'welcome.js');
});

test('background.js (service worker): i18n.js + оба канала + сам background.js', () => {
  // background.js делает importScripts('i18n.js', 'channels/badge-channel.js',
  // 'channels/notification-channel.js') первой строкой, а дальше идёт его
  // собственный код в том же scope воркера — воспроизводим ровно этот
  // порядок вручную, раз в vm нет живого importScripts.
  assertNoRedeclaration(
    ['i18n.js', 'channels/badge-channel.js', 'channels/notification-channel.js', 'background.js'],
    'background.js'
  );
});

test('i18n.js сам по себе оставляет в scope только self.I18n', () => {
  const context = vm.createContext({ self: undefined, console });
  context.self = context;
  vm.runInContext(readExt('i18n.js'), context, { filename: 'i18n.js' });
  assert.equal(typeof context.I18n, 'object');
  // Внутренние имена не должны утекать наружу — иначе это тот же класс
  // бага, просто с другим именем вместо t.
  for (const leaked of ['t', 'apply', 'format', 'detect', 'normalize', 'use', 'ready', 'loadCatalog']) {
    assert.equal(typeof context[leaked], 'undefined', `${leaked} утёк в глобальный scope`);
  }
});
