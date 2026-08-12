'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const metrics = require('../src/metrics');
const store = require('../src/store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aan-relay-metrics-test-'));
}

// Время передаём явно во все записывающие функции — иначе тест на ротацию
// зависел бы от того, в каком месяце его запустили.
const JAN = Date.UTC(2026, 0, 15, 10, 0, 0);
const FEB = Date.UTC(2026, 1, 3, 10, 0, 0);

function readLog(dir, month) {
  const text = fs.readFileSync(path.join(dir, `metrics-${month}.ndjson`), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('recordEvent: заполняет роллап в записи юзера', () => {
  const dir = tempDir();
  store.createUser(dir, 'tok-1', 42);

  metrics.recordEvent(
    dir,
    'tok-1',
    {
      id: 'e1',
      type: 'permission_request',
      agent: 'claude',
      tool: 'Edit',
      client: { os: 'windows', osVersion: '11.26200', arch: 'x64', hostVersion: '1.2.3', packaged: true },
    },
    JAN
  );

  const user = store.getUser(dir, 'tok-1');
  assert.equal(user.lastSeenAt, JAN);
  assert.equal(user.firstEventAt, JAN);
  assert.equal(user.events.total, 1);
  assert.equal(user.events.permission_request, 1);
  assert.equal(user.agents.claude, 1);
  assert.equal(user.client.os, 'windows');
  // Существующие поля не должны пострадать от роллапа.
  assert.equal(user.chatId, 42);
  assert.equal(user.tier, 'free');
});

test('recordEvent: firstEventAt ставится один раз, lastSeenAt двигается', () => {
  const dir = tempDir();
  store.createUser(dir, 'tok-1', 42);
  metrics.recordEvent(dir, 'tok-1', { id: 'e1', type: 'task_done' }, JAN);
  metrics.recordEvent(dir, 'tok-1', { id: 'e2', type: 'task_done' }, FEB);

  const user = store.getUser(dir, 'tok-1');
  assert.equal(user.firstEventAt, JAN);
  assert.equal(user.lastSeenAt, FEB);
  assert.equal(user.events.total, 2);
  assert.equal(user.events.task_done, 2);
});

test('recordEvent: в ndjson не попадают ни summary, ни cwd, ни сам токен', () => {
  const dir = tempDir();
  store.createUser(dir, 'tok-secret', 42);
  metrics.recordEvent(
    dir,
    'tok-secret',
    {
      id: 'e1',
      type: 'permission_request',
      agent: 'cursor',
      tool: 'Bash',
      summary: 'rm -rf /важный/путь',
      cwd: 'E:\\проекты\\секретный',
      client: { os: 'linux', osVersion: 'ubuntu/22.04', arch: 'arm64', hostVersion: '1.0.0', packaged: false },
    },
    JAN
  );

  const [record] = readLog(dir, '2026-01');
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes('tok-secret'), false);
  assert.equal(serialized.includes('rm -rf'), false);
  assert.equal(serialized.includes('секретный'), false);
  // А то, ради чего всё затевалось, на месте.
  assert.equal(record.kind, 'event');
  assert.equal(record.type, 'permission_request');
  assert.equal(record.agent, 'cursor');
  assert.equal(record.tool, 'Bash');
  assert.equal(record.os, 'linux');
  assert.equal(record.osVersion, 'ubuntu/22.04');
  assert.equal(record.arch, 'arm64');
  assert.equal(record.packaged, false);
  assert.ok(record.uid);
});

test('recordEvent: событие без client не роняет запись, поля клиента = null', () => {
  const dir = tempDir();
  store.createUser(dir, 'tok-1', 42);
  metrics.recordEvent(dir, 'tok-1', { id: 'e1', type: 'task_done' }, JAN);

  const [record] = readLog(dir, '2026-01');
  assert.equal(record.os, null);
  assert.equal(record.packaged, null);
  assert.equal(store.getUser(dir, 'tok-1').client, undefined);
});

test('recordEvent: для отвязанного юзера не воскрешает запись', () => {
  const dir = tempDir();
  metrics.recordEvent(dir, 'tok-нет', { id: 'e1', type: 'task_done' }, JAN);
  assert.deepEqual(store.load(dir), {});
});

test('hashUid: стабилен для одного токена и различает разные', () => {
  const dir = tempDir();
  const a1 = metrics.hashUid(dir, 'tok-a');
  const a2 = metrics.hashUid(dir, 'tok-a');
  const b = metrics.hashUid(dir, 'tok-b');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(a1.includes('tok-a'), false);
});

test('hashUid: разные инсталляции дают разные uid для одного токена', () => {
  // Соль своя на каждую папку данных — две выгрузки нельзя сопоставить
  // между собой по uid.
  assert.notEqual(metrics.hashUid(tempDir(), 'tok-a'), metrics.hashUid(tempDir(), 'tok-a'));
});

test('latencyBucket: границы бакетов', () => {
  assert.equal(metrics.latencyBucket(0), 'lt5s');
  assert.equal(metrics.latencyBucket(4999), 'lt5s');
  assert.equal(metrics.latencyBucket(5000), 'lt30s');
  assert.equal(metrics.latencyBucket(29999), 'lt30s');
  assert.equal(metrics.latencyBucket(30000), 'lt5m');
  assert.equal(metrics.latencyBucket(299999), 'lt5m');
  assert.equal(metrics.latencyBucket(300000), 'gte5m');
});

test('recordDecision: считает латентность от trackActionable', () => {
  const dir = tempDir();
  store.createUser(dir, 'tok-1', 42);
  const uid = metrics.recordEvent(dir, 'tok-1', { id: 'e1', type: 'permission_request', agent: 'claude' }, JAN);
  metrics.trackActionable('e1', uid, 'claude', JAN);
  metrics.recordDecision(dir, 'e1', 'allow', JAN + 3000);

  const decision = readLog(dir, '2026-01').find((r) => r.kind === 'decision');
  assert.equal(decision.outcome, 'allow');
  assert.equal(decision.latencyMs, 3000);
  assert.equal(decision.bucket, 'lt5s');
  assert.equal(decision.uid, uid);
  assert.equal(metrics.loadCounters(dir).decisions.allow, 1);
});

test('recordDecision: неотслеженное событие пишет исход без латентности', () => {
  const dir = tempDir();
  metrics.recordDecision(dir, 'событие-после-рестарта', 'timeout', JAN);

  const decision = readLog(dir, '2026-01').find((r) => r.kind === 'decision');
  assert.equal(decision.outcome, 'timeout');
  assert.equal(decision.latencyMs, null);
  assert.equal(decision.bucket, null);
  assert.equal(decision.uid, null);
  assert.equal(metrics.loadCounters(dir).decisions.timeout, 1);
});

test('recordDecision: второй вызов по тому же событию уже без латентности', () => {
  // Запись из inFlight снимается первым же вызовом — страховка от того,
  // чтобы зависшие события не копились в памяти.
  const dir = tempDir();
  store.createUser(dir, 'tok-1', 42);
  const uid = metrics.recordEvent(dir, 'tok-1', { id: 'e1', type: 'permission_request' }, JAN);
  metrics.trackActionable('e1', uid, null, JAN);
  metrics.recordDecision(dir, 'e1', 'allow', JAN + 1000);
  metrics.recordDecision(dir, 'e1', 'allow', JAN + 2000);

  const decisions = readLog(dir, '2026-01').filter((r) => r.kind === 'decision');
  assert.equal(decisions[0].latencyMs, 1000);
  assert.equal(decisions[1].latencyMs, null);
});

test('recordPairing: счётчики воронки складываются по стадиям', () => {
  const dir = tempDir();
  metrics.recordPairing(dir, 'started', JAN);
  metrics.recordPairing(dir, 'started', JAN);
  metrics.recordPairing(dir, 'completed', JAN);
  metrics.recordPairing(dir, 'rejected_cap', JAN);

  const counters = metrics.loadCounters(dir);
  assert.equal(counters.pair.started, 2);
  assert.equal(counters.pair.completed, 1);
  assert.equal(counters.pair.rejected_cap, 1);
  assert.equal(readLog(dir, '2026-01').filter((r) => r.kind === 'pair').length, 4);
});

test('classifyDeliveryError: блокировка бота отделена от прочих ошибок', () => {
  assert.equal(metrics.classifyDeliveryError('Telegram sendMessage: Forbidden: bot was blocked by the user'), 'blocked');
  assert.equal(metrics.classifyDeliveryError('Telegram sendMessage: Bad Request: chat not found'), 'chat_not_found');
  assert.equal(metrics.classifyDeliveryError('Telegram sendMessage: Forbidden: user is deactivated'), 'deactivated');
  assert.equal(metrics.classifyDeliveryError('fetch failed'), 'other');
});

test('recordDeliveryError: пишет причину в счётчики и в лог', () => {
  const dir = tempDir();
  store.createUser(dir, 'tok-1', 42);
  metrics.recordDeliveryError(dir, 'tok-1', 'Forbidden: bot was blocked by the user', JAN);

  assert.equal(metrics.loadCounters(dir).deliveryErrors.blocked, 1);
  const record = readLog(dir, '2026-01').find((r) => r.kind === 'delivery_error');
  assert.equal(record.reason, 'blocked');
  assert.ok(record.uid);
});

test('ротация: записи ложатся в файл своего месяца', () => {
  const dir = tempDir();
  store.createUser(dir, 'tok-1', 42);
  metrics.recordEvent(dir, 'tok-1', { id: 'e1', type: 'task_done' }, JAN);
  metrics.recordEvent(dir, 'tok-1', { id: 'e2', type: 'task_done' }, FEB);

  assert.deepEqual(metrics.listLogFiles(dir), ['metrics-2026-01.ndjson', 'metrics-2026-02.ndjson']);
  assert.equal(readLog(dir, '2026-01').length, 1);
  assert.equal(readLog(dir, '2026-02').length, 1);
});

test('pruneOldMonths: оставляет только последние N месяцев', () => {
  const dir = tempDir();
  for (const month of ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01']) {
    fs.writeFileSync(path.join(dir, `metrics-${month}.ndjson`), '{}\n', 'utf8');
  }
  // Посторонние файлы в той же папке (users.json, counters.json) трогать нельзя.
  fs.writeFileSync(path.join(dir, 'users.json'), '{}', 'utf8');

  const removed = metrics.pruneOldMonths(dir, 2);
  assert.deepEqual(removed, ['metrics-2025-09.ndjson', 'metrics-2025-10.ndjson', 'metrics-2025-11.ndjson']);
  assert.deepEqual(metrics.listLogFiles(dir), ['metrics-2025-12.ndjson', 'metrics-2026-01.ndjson']);
  assert.ok(fs.existsSync(path.join(dir, 'users.json')));
});

test('readRecords: читает все месяцы подряд и переживает битую строку', () => {
  const dir = tempDir();
  store.createUser(dir, 'tok-1', 42);
  metrics.recordEvent(dir, 'tok-1', { id: 'e1', type: 'task_done' }, JAN);
  // Оборванный на середине записи процесс оставляет ровно такой хвост.
  fs.appendFileSync(path.join(dir, 'metrics-2026-01.ndjson'), '{"kind":"event"', 'utf8');
  metrics.recordEvent(dir, 'tok-1', { id: 'e2', type: 'task_done' }, FEB);

  const records = metrics.readRecords(dir);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.ts),
    [JAN, FEB]
  );
});

test('readRecords: на папке без метрик возвращает пустой список, не бросает', () => {
  assert.deepEqual(metrics.readRecords(tempDir()), []);
  assert.deepEqual(metrics.loadCounters(tempDir()), {});
});
