'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../src/router');
const settingsStore = require('../src/settings');
const extensionChannel = require('../src/channels/extension-channel');
const phoneChannel = require('../src/channels/phone-channel');

// Router обращается к settingsStore.load() и к методам каналов через
// свойство объекта в момент вызова (см. router.js), поэтому обычная
// подмена свойства на функцию-шпион работает без спец. библиотек мока.
function withMocks(mocks, fn) {
  const originals = mocks.map(([obj, key]) => obj[key]);
  for (const [obj, key, impl] of mocks) {
    obj[key] = impl;
  }
  return Promise.resolve(fn()).finally(() => {
    mocks.forEach(([obj, key], i) => {
      obj[key] = originals[i];
    });
  });
}

test('dispatch: вызывает только каналы из правила для данного типа события', async () => {
  const calls = [];
  await withMocks(
    [
      [settingsStore, 'load', () => ({ rules: { permission_request: ['notification', 'badge'] } })],
      [extensionChannel, 'sendNotification', async (event) => calls.push(['notification', event.id])],
      [extensionChannel, 'sendBadge', async (event) => calls.push(['badge', event.id])],
      [phoneChannel, 'send', async (event) => calls.push(['phone', event.id])],
    ],
    async () => {
      await router.dispatch({ id: 'ev1', type: 'permission_request' });
    }
  );
  assert.deepEqual(calls, [
    ['notification', 'ev1'],
    ['badge', 'ev1'],
  ]);
});

test('dispatch: для типа события без правила не вызывает ничего', async () => {
  const calls = [];
  await withMocks(
    [
      [settingsStore, 'load', () => ({ rules: {} })],
      [extensionChannel, 'sendBadge', async () => calls.push('badge')],
    ],
    async () => {
      await router.dispatch({ id: 'ev2', type: 'unknown_type' });
    }
  );
  assert.deepEqual(calls, []);
});

test('dispatch: неизвестное имя канала в правиле не роняет остальные', async () => {
  const calls = [];
  await withMocks(
    [
      [settingsStore, 'load', () => ({ rules: { task_done: ['bogus-channel', 'badge'] } })],
      [extensionChannel, 'sendBadge', async () => calls.push('badge')],
    ],
    async () => {
      await router.dispatch({ id: 'ev3', type: 'task_done' });
    }
  );
  assert.deepEqual(calls, ['badge']);
});

test('dispatch: если один канал бросает ошибку, остальные всё равно вызываются', async () => {
  const calls = [];
  await withMocks(
    [
      [settingsStore, 'load', () => ({ rules: { task_done: ['notification', 'badge'] } })],
      [
        extensionChannel,
        'sendNotification',
        async () => {
          throw new Error('канал упал');
        },
      ],
      [extensionChannel, 'sendBadge', async () => calls.push('badge')],
    ],
    async () => {
      await router.dispatch({ id: 'ev4', type: 'task_done' });
    }
  );
  assert.deepEqual(calls, ['badge']);
});

test('dispatch: «не беспокоить» для конкретного cwd подавляет только его события', async () => {
  const calls = [];
  await withMocks(
    [
      [
        settingsStore,
        'load',
        () => ({
          rules: { permission_request: ['notification', 'badge'] },
          snoozeByProject: { '/repo/noisy': Date.now() + 60000 },
        }),
      ],
      [extensionChannel, 'sendNotification', async (event) => calls.push(['notification', event.id])],
      [extensionChannel, 'sendBadge', async (event) => calls.push(['badge', event.id])],
    ],
    async () => {
      await router.dispatch({ id: 'ev5', type: 'permission_request', cwd: '/repo/noisy' });
      await router.dispatch({ id: 'ev5b', type: 'permission_request', cwd: '/repo/important' });
    }
  );
  // событие из заглушённого проекта подавлено, из другого — прошло
  assert.deepEqual(calls, [
    ['notification', 'ev5b'],
    ['badge', 'ev5b'],
  ]);
});

test('dispatch: snoozeByProject в прошлом не подавляет ничего', async () => {
  const calls = [];
  await withMocks(
    [
      [
        settingsStore,
        'load',
        () => ({
          rules: { task_done: ['badge'] },
          snoozeByProject: { '/repo/x': Date.now() - 1000 },
        }),
      ],
      [extensionChannel, 'sendBadge', async () => calls.push('badge')],
    ],
    async () => {
      await router.dispatch({ id: 'ev6', type: 'task_done', cwd: '/repo/x' });
    }
  );
  assert.deepEqual(calls, ['badge']);
});
