'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pendingDecisions = require('../src/pending-decisions');

test('register + resolveDecision до awaitDecision: решение не теряется', async () => {
  pendingDecisions.register('ev1', 5000);
  pendingDecisions.resolveDecision('ev1', 'allow');
  assert.equal(await pendingDecisions.awaitDecision('ev1'), 'allow');
});

test('register + awaitDecision до resolveDecision: тоже резолвится корректно', async () => {
  pendingDecisions.register('ev2', 5000);
  const promise = pendingDecisions.awaitDecision('ev2');
  pendingDecisions.resolveDecision('ev2', 'deny');
  assert.equal(await promise, 'deny');
});

test('register без resolveDecision таймаутится в null', async () => {
  pendingDecisions.register('ev3', 10);
  assert.equal(await pendingDecisions.awaitDecision('ev3'), null);
});

test('awaitDecision без предшествующего register -> null (fail-open)', async () => {
  assert.equal(await pendingDecisions.awaitDecision('никогда-не-регистрировали'), null);
});

test('resolveDecision для незарегистрированного id ничего не ломает', () => {
  assert.doesNotThrow(() => pendingDecisions.resolveDecision('другой-неизвестный', 'allow'));
});

test('повторный resolveDecision после первого — no-op, значение не перезаписывается', async () => {
  pendingDecisions.register('ev4', 5000);
  pendingDecisions.resolveDecision('ev4', 'deny');
  pendingDecisions.resolveDecision('ev4', 'allow');
  assert.equal(await pendingDecisions.awaitDecision('ev4'), 'deny');
});

test('onResolve вызывается с решением от кнопки', () => {
  const seen = [];
  pendingDecisions.register('ev6', 5000, (decision) => seen.push(decision));
  pendingDecisions.resolveDecision('ev6', 'allow');
  pendingDecisions.resolveDecision('ev6', 'deny'); // повтор — не должен звать хук второй раз
  assert.deepEqual(seen, ['allow']);
});

test('onResolve вызывается и на таймауте — иначе о нём никто снаружи не узнает', async () => {
  const seen = [];
  pendingDecisions.register('ev7', 10, (decision) => seen.push(decision));
  await pendingDecisions.awaitDecision('ev7');
  assert.deepEqual(seen, [null]);
});

test('упавший onResolve не мешает выдать решение ожидающему', async () => {
  pendingDecisions.register('ev8', 5000, () => {
    throw new Error('наблюдатель сломался');
  });
  const promise = pendingDecisions.awaitDecision('ev8');
  pendingDecisions.resolveDecision('ev8', 'allow');
  assert.equal(await promise, 'allow');
});

test('несколько awaitDecision на один eventId получают одно и то же решение', async () => {
  pendingDecisions.register('ev5', 5000);
  const p1 = pendingDecisions.awaitDecision('ev5');
  const p2 = pendingDecisions.awaitDecision('ev5');
  pendingDecisions.resolveDecision('ev5', 'allow');
  assert.deepEqual(await Promise.all([p1, p2]), ['allow', 'allow']);
});
