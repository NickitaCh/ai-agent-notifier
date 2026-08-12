'use strict';

// Генератор синтетических данных для ручной проверки bin/report.js —
// на пустой папке отчёт печатает одни прочерки, и глазами не видно, что
// проценты, медианы и распределения считаются правильно.
//
//   node tools/seed-report-data.js <папка>
//   DATA_DIR=<папка> npm run report
//
// Лежит в tools/, а не в test/: `node --test` забирает ВСЁ содержимое папки
// test/ как тест-файлы, и этот скрипт падал бы там как упавший тест
// (запущенный без аргумента, он честно выходит с кодом 1).

const store = require('../src/store');
const metrics = require('../src/metrics');

const DAY_MS = 86400000;

function seed(dataDir, now = Date.now()) {
  const users = [
    // Давний активный юзер — попадает и в ретеншен, и в медиану событий.
    { token: 'tok-старожил', chatId: 1, createdAt: now - 40 * DAY_MS, events: 25, agent: 'claude',
      client: { os: 'windows', osVersion: '11.26200', arch: 'x64', hostVersion: '1.2.0', packaged: true } },
    // Свежий активный.
    { token: 'tok-новичок', chatId: 2, createdAt: now - 3 * DAY_MS, events: 4, agent: 'cursor',
      client: { os: 'macos', osVersion: '15', arch: 'arm64', hostVersion: '1.2.0', packaged: false } },
    // Давний, но отвалился — должен уронить ретеншен.
    { token: 'tok-отвалился', chatId: 3, createdAt: now - 60 * DAY_MS, events: 2, agent: 'claude',
      client: { os: 'linux', osVersion: 'ubuntu/22.04', arch: 'x64', hostVersion: '1.0.0', packaged: false } },
    // Привязался и не прислал ни одного события — сломанный онбординг.
    { token: 'tok-молчун', chatId: 4, createdAt: now - 10 * DAY_MS, events: 0, agent: null, client: null },
  ];

  for (const u of users) {
    store.createUser(dataDir, u.token, u.chatId);
    const all = store.load(dataDir);
    all[u.token].createdAt = u.createdAt;
    store.save(dataDir, all);

    const lastEventAt = u.token === 'tok-отвалился' ? now - 45 * DAY_MS : now - 1 * DAY_MS;
    for (let i = 0; i < u.events; i += 1) {
      const ts = lastEventAt - i * 3600000;
      metrics.recordEvent(
        dataDir,
        u.token,
        {
          id: `${u.token}-e${i}`,
          type: i % 3 === 0 ? 'task_done' : 'permission_request',
          agent: u.agent,
          tool: ['Edit', 'Bash', 'Write'][i % 3],
          client: u.client || undefined,
        },
        ts
      );
    }
  }

  // Воронка: 9 нажатий на 4 успешных привязки + отказы обоих видов.
  for (let i = 0; i < 9; i += 1) metrics.recordPairing(dataDir, 'started', now - 5 * DAY_MS);
  for (let i = 0; i < 4; i += 1) metrics.recordPairing(dataDir, 'completed', now - 5 * DAY_MS);
  metrics.recordPairing(dataDir, 'rejected_rate', now - 5 * DAY_MS);
  metrics.recordPairing(dataDir, 'rejected_cap', now - 2 * DAY_MS);

  // Решения с разной латентностью, включая таймаут.
  const outcomes = [
    ['allow', 1200], ['allow', 3400], ['allow', 18000], ['deny', 9000],
    ['allow', 240000], ['timeout', null], ['deny', 45000], ['allow', 2100],
  ];
  outcomes.forEach(([outcome, latency], i) => {
    const eventId = `решение-${i}`;
    const startedAt = now - 2 * DAY_MS;
    if (latency !== null) {
      metrics.trackActionable(eventId, metrics.hashUid(dataDir, 'tok-старожил'), 'claude', startedAt);
      metrics.recordDecision(dataDir, eventId, outcome, startedAt + latency);
    } else {
      metrics.recordDecision(dataDir, eventId, outcome, startedAt);
    }
  });

  metrics.recordDeliveryError(dataDir, 'tok-отвалился', 'Forbidden: bot was blocked by the user', now - 30 * DAY_MS);
  metrics.recordDeliveryError(dataDir, 'tok-новичок', 'fetch failed', now - DAY_MS);
}

if (require.main === module) {
  const dataDir = process.argv[2];
  if (!dataDir) {
    console.error('Использование: node tools/seed-report-data.js <папка>');
    process.exit(1);
  }
  seed(dataDir);
  console.log(`Данные засеяны в ${dataDir}. Теперь: DATA_DIR=${dataDir} npm run report`);
}

module.exports = { seed };
