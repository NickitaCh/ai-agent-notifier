'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-token';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');
const i18n = require('../src/i18n');
const store = require('../src/store');
const telegram = require('../src/telegram');
const { route } = require('../src/server');

test('pick: побеждает первый распознанный кандидат', () => {
  assert.equal(i18n.pick('es', 'ru'), 'es');
  // Нераспознанный кандидат пропускается, а не роняет выбор в fallback.
  assert.equal(i18n.pick('pt-BR', 'ru'), 'ru');
  assert.equal(i18n.pick(null, undefined, 'en-GB'), 'en');
  assert.equal(i18n.pick(), 'en');
});

test('во всех каталогах релея одинаковый набор ключей', () => {
  const ru = Object.keys(require('../src/i18n/ru.json')).sort();
  for (const locale of ['en', 'es']) {
    assert.deepEqual(Object.keys(require(`../src/i18n/${locale}.json`)).sort(), ru, `расхождение в ${locale}.json`);
  }
});

test('buildMessage: текст события идёт на переданном языке', () => {
  const event = { type: 'permission_request', summary: 'rm -rf build/' };
  assert.match(telegram.buildMessage(event, 'ru').title, /просит разрешение/);
  assert.match(telegram.buildMessage(event, 'es').title, /pide permiso/);
  // Сводка события — это данные, а не строка интерфейса: не переводится.
  assert.equal(telegram.buildMessage(event, 'es').body, 'rm -rf build/');
});

test('createUser + setLocale: язык живёт в записи юзера', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aan-relay-i18n-'));
  store.createUser(dir, 'tok-1', 42, 'ru');
  assert.equal(store.getUser(dir, 'tok-1').locale, 'ru');

  store.setLocale(dir, 'tok-1', 'es');
  assert.equal(store.getUser(dir, 'tok-1').locale, 'es');

  // Пустое значение не должно затирать уже известный язык.
  store.setLocale(dir, 'tok-1', null);
  assert.equal(store.getUser(dir, 'tok-1').locale, 'es');
});

// --- сквозная проверка: язык из события доезжает до сообщения в Telegram ---

function withServer(fn) {
  const server = http.createServer(route);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        resolve(await fn(`http://127.0.0.1:${server.address().port}`));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function withEnv(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aan-relay-i18n-flow-'));
  const original = { dataDir: config.dataDir, send: telegram.sendEventMessage };
  config.dataDir = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    config.dataDir = original.dataDir;
    telegram.sendEventMessage = original.send;
  });
}

function postEvent(base, token, event) {
  return fetch(`${base}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(event),
  });
}

test('POST /events: сообщение уходит на языке, который прислал хост', async () => {
  await withEnv(async (dir) => {
    store.createUser(dir, 'tok-1', 42, 'ru');
    const sent = [];
    telegram.sendEventMessage = async (botToken, chatId, event, locale) => sent.push(locale);

    await withServer(async (base) => {
      await postEvent(base, 'tok-1', { id: 'ev-1', type: 'task_done', locale: 'es' });
    });

    assert.deepEqual(sent, ['es']);
    // И запомнился — чтобы ответы бота вне контекста события (например, на
    // /feedback) шли на том же языке.
    assert.equal(store.getUser(dir, 'tok-1').locale, 'es');
  });
});

test('POST /events: без locale в событии остаётся язык из записи юзера', async () => {
  await withEnv(async (dir) => {
    store.createUser(dir, 'tok-1', 42, 'ru');
    const sent = [];
    telegram.sendEventMessage = async (botToken, chatId, event, locale) => sent.push(locale);

    await withServer(async (base) => {
      await postEvent(base, 'tok-1', { id: 'ev-2', type: 'task_done' });
    });

    assert.deepEqual(sent, ['ru']);
  });
});

test('POST /events: язык сохраняется и когда статистика выключена', async () => {
  // relayMetrics:false убирает из тела client, но не locale — иначе бот
  // отвечал бы не на том языке именно тем, кто отказался от метрик.
  await withEnv(async (dir) => {
    store.createUser(dir, 'tok-1', 42, null);
    telegram.sendEventMessage = async () => {};

    await withServer(async (base) => {
      await postEvent(base, 'tok-1', { id: 'ev-3', type: 'task_done', locale: 'es' });
    });

    assert.equal(store.getUser(dir, 'tok-1').locale, 'es');
  });
});
