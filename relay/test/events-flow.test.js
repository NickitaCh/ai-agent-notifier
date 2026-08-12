'use strict';

// Сквозная проверка обработчика POST /events через настоящий http-сервер:
// юнит-тесты покрывают metrics.js и store.js по отдельности, но не то, что
// они вообще вызываются из боевого пути запроса — а именно это и ломается
// при рефакторинге server.js.

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-token';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');
const store = require('../src/store');
const metrics = require('../src/metrics');
const telegram = require('../src/telegram');
const pendingDecisions = require('../src/pending-decisions');
const { route } = require('../src/server');

function withServer(fn) {
  const server = http.createServer(route);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        resolve(await fn(base));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function withEnv(fn, { sendEventMessage } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aan-relay-flow-test-'));
  const original = {
    dataDir: config.dataDir,
    timeout: config.decisionTimeoutMs,
    send: telegram.sendEventMessage,
  };
  config.dataDir = dir;
  // Боевые 9.5 минут держали бы таймер и не давали процессу тестов выйти.
  config.decisionTimeoutMs = 200;
  telegram.sendEventMessage = sendEventMessage || (async () => ({ message_id: 1 }));
  return Promise.resolve(fn(dir)).finally(() => {
    config.dataDir = original.dataDir;
    config.decisionTimeoutMs = original.timeout;
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

test('POST /events: событие доставляется и попадает в метрики', async () => {
  await withEnv(async (dir) => {
    store.createUser(dir, 'tok-1', 42);
    const delivered = [];
    telegram.sendEventMessage = async (botToken, chatId, event) => delivered.push({ chatId, event });

    await withServer(async (base) => {
      const res = await postEvent(base, 'tok-1', {
        id: 'ev-1',
        type: 'task_done',
        agent: 'claude',
        tool: 'Bash',
        summary: 'секретная сводка',
        cwd: 'E:\\секретный\\путь',
        client: { os: 'windows', osVersion: '11.26200', arch: 'x64', hostVersion: '1.2.3', packaged: true },
      });
      assert.equal(res.status, 200);
    });

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].chatId, 42);

    const user = store.getUser(dir, 'tok-1');
    assert.equal(user.events.total, 1);
    assert.equal(user.agents.claude, 1);
    assert.equal(user.client.os, 'windows');
    assert.ok(user.lastSeenAt > 0);

    // Главное: содержимое события не осело в логе метрик.
    const dump = JSON.stringify(metrics.readRecords(dir));
    assert.equal(dump.includes('секретная сводка'), false);
    assert.equal(dump.includes('секретный'), false);
    assert.equal(dump.includes('tok-1'), false);
  });
});

test('POST /events: чужой токен — 401 и никаких записей', async () => {
  await withEnv(async (dir) => {
    await withServer(async (base) => {
      // Токен только ASCII: в HTTP-заголовок кириллица не пролезает (ByteString).
      const res = await postEvent(base, 'not-our-token', { id: 'ev-x', type: 'task_done' });
      assert.equal(res.status, 401);
    });
    assert.deepEqual(metrics.readRecords(dir), []);
  });
});

test('POST /events: actionable-событие меряет исход и латентность решения', async () => {
  await withEnv(async (dir) => {
    store.createUser(dir, 'tok-1', 42);

    await withServer(async (base) => {
      const res = await postEvent(base, 'tok-1', {
        id: 'ev-actionable',
        type: 'permission_request',
        agent: 'cursor',
        tool: 'Edit',
      });
      assert.equal(res.status, 200);
      // Имитируем нажатие кнопки в Telegram (то же, что делает вебхук).
      pendingDecisions.resolveDecision('ev-actionable', 'allow');
    });

    const decision = metrics.readRecords(dir).find((r) => r.kind === 'decision');
    assert.equal(decision.outcome, 'allow');
    assert.equal(typeof decision.latencyMs, 'number');
    assert.equal(metrics.loadCounters(dir).decisions.allow, 1);
  });
});

test('POST /events: отсутствие ответа записывается как timeout', async () => {
  await withEnv(async (dir) => {
    store.createUser(dir, 'tok-1', 42);

    await withServer(async (base) => {
      await postEvent(base, 'tok-1', { id: 'ev-timeout', type: 'permission_request' });
    });
    // config.decisionTimeoutMs выставлен в 200мс выше.
    await new Promise((resolve) => setTimeout(resolve, 350));

    const decision = metrics.readRecords(dir).find((r) => r.kind === 'decision');
    assert.equal(decision.outcome, 'timeout');
    assert.equal(metrics.loadCounters(dir).decisions.timeout, 1);
  });
});

test('POST /events: упавшая доставка в Telegram даёт 502 и классифицируется', async () => {
  await withEnv(
    async (dir) => {
      store.createUser(dir, 'tok-1', 42);

      await withServer(async (base) => {
        const res = await postEvent(base, 'tok-1', { id: 'ev-blocked', type: 'task_done' });
        assert.equal(res.status, 502);
      });

      assert.equal(metrics.loadCounters(dir).deliveryErrors.blocked, 1);
      // Событие всё равно должно быть засчитано: до Telegram оно дошло.
      assert.equal(store.getUser(dir, 'tok-1').events.total, 1);
    },
    {
      sendEventMessage: async () => {
        throw new Error('Telegram sendMessage: Forbidden: bot was blocked by the user');
      },
    }
  );
});

test('POST /events: без id или type — 400', async () => {
  await withEnv(async (dir) => {
    store.createUser(dir, 'tok-1', 42);
    await withServer(async (base) => {
      const res = await postEvent(base, 'tok-1', { type: 'task_done' });
      assert.equal(res.status, 400);
    });
    assert.deepEqual(metrics.readRecords(dir), []);
  });
});
