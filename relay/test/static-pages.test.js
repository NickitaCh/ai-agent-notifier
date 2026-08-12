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
const { route } = require('../src/server');

// Фикстуры пишем сами, а не полагаемся на настоящий docs/ через
// scripts/sync-public.js — тест должен проверять поведение сервера
// (правильный роут -> правильный файл -> правильный Content-Type), а не
// содержимое лендинга, которое меняется независимо от этого кода.
function withPublicDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aan-relay-public-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  const original = config.publicDir;
  config.publicDir = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    config.publicDir = original;
  });
}

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

test('GET /: отдаёт index.html как text/html', async () => {
  await withPublicDir({ 'index.html': '<h1>привет</h1>', 'privacy.html': '<h1>приватность</h1>' }, async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.equal(await res.text(), '<h1>привет</h1>');
    });
  });
});

test('GET /privacy.html: отдаёт privacy.html отдельно от index.html', async () => {
  await withPublicDir({ 'index.html': '<h1>привет</h1>', 'privacy.html': '<h1>приватность</h1>' }, async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/privacy.html`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '<h1>приватность</h1>');
    });
  });
});

test('GET /: без синка (public/ пуст) — 404, а не 500', async () => {
  // Реалистичный случай: деплой без предварительного npm run sync-public.
  // Должно деградировать в обычный "страницы нет", а не падать с ошибкой.
  await withPublicDir({}, async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 404);
    });
  });
});

test('GET /nonexistent.html: обычный 404, публичные страницы не открывают произвольный доступ к файлам', async () => {
  await withPublicDir({ 'index.html': 'x' }, async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/nonexistent.html`);
      assert.equal(res.status, 404);
    });
  });
});

test('GET /: API-эндпоинты продолжают работать как прежде', async () => {
  // Регрессия на то, что новый роут "/" не перехватил ничего другого —
  // /pair/status с валидным query всё ещё должен отвечать JSON, а не
  // случайно попадать в статику.
  await withPublicDir({ 'index.html': 'x' }, async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/pair/status?code=нет-такого`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /application\/json/);
    });
  });
});
