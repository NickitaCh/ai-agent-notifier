'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleStop, cancelPending } = require('../src/stop-debounce');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('scheduleStop: без sessionId срабатывает сразу, без задержки', async () => {
  let fired = null;
  scheduleStop({ id: 'e1', sessionId: null }, 5000, (ev) => {
    fired = ev;
  });
  // синхронный вызов onFire — событие уже должно было прийти без ожидания таймера
  assert.equal(fired?.id, 'e1');
});

test('scheduleStop: с sessionId откладывает вызов ровно на delayMs', async () => {
  const start = Date.now();
  let firedAt = null;
  scheduleStop({ id: 'e2', sessionId: 'sessA' }, 60, (ev) => {
    firedAt = Date.now() - start;
  });
  assert.equal(firedAt, null, 'не должно сработать сразу');
  await wait(100);
  assert.ok(firedAt !== null, 'должно было сработать к этому моменту');
  assert.ok(firedAt >= 55, `сработало слишком рано: ${firedAt}мс`);
});

test('cancelPending: отменяет ещё не сработавший таймер', async () => {
  let fired = false;
  scheduleStop({ id: 'e3', sessionId: 'sessB' }, 50, () => {
    fired = true;
  });
  cancelPending('sessB');
  await wait(100);
  assert.equal(fired, false);
});

test('scheduleStop: повторный вызов для той же сессии отменяет предыдущий (не дублирует срабатывание)', async () => {
  const fires = [];
  scheduleStop({ id: 'first', sessionId: 'sessC' }, 40, (ev) => fires.push(ev.id));
  await wait(15);
  scheduleStop({ id: 'second', sessionId: 'sessC' }, 40, (ev) => fires.push(ev.id));
  await wait(80);
  assert.deepEqual(fires, ['second'], 'должно сработать только последнее событие сессии');
});

test('scheduleStop: разные сессии не влияют друг на друга', async () => {
  const fires = [];
  scheduleStop({ id: 'x', sessionId: 'sessX' }, 40, (ev) => fires.push(ev.id));
  scheduleStop({ id: 'y', sessionId: 'sessY' }, 40, (ev) => fires.push(ev.id));
  cancelPending('sessX');
  await wait(80);
  assert.deepEqual(fires, ['y']);
});

test('cancelPending: с неизвестным/пустым sessionId ничего не ломает', () => {
  assert.doesNotThrow(() => cancelPending(undefined));
  assert.doesNotThrow(() => cancelPending('никогда-не-существовавшая-сессия'));
});
