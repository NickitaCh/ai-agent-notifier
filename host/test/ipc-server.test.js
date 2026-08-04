'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSnoozeByProject } = require('../src/ipc-server');

test('mergeSnoozeByProject: пустой current + патч -> просто патч', () => {
  const result = mergeSnoozeByProject(undefined, { '/repo/a': 123 });
  assert.deepEqual(result, { '/repo/a': 123 });
});

test('mergeSnoozeByProject: новый проект добавляется, старые остаются', () => {
  const current = { '/repo/a': 100 };
  const result = mergeSnoozeByProject(current, { '/repo/b': 200 });
  assert.deepEqual(result, { '/repo/a': 100, '/repo/b': 200 });
});

test('mergeSnoozeByProject: значение null в патче удаляет ключ (JSON Merge Patch), а не сохраняет null', () => {
  const current = { '/repo/a': 100, '/repo/b': 200 };
  const result = mergeSnoozeByProject(current, { '/repo/a': null });
  assert.deepEqual(result, { '/repo/b': 200 });
  assert.equal('a' in result, false); // ключа не должно остаться вообще, даже как null
});

test('mergeSnoozeByProject: обновление существующего значения', () => {
  const current = { '/repo/a': 100 };
  const result = mergeSnoozeByProject(current, { '/repo/a': 999 });
  assert.deepEqual(result, { '/repo/a': 999 });
});

test('mergeSnoozeByProject: пустой патч не меняет current', () => {
  const current = { '/repo/a': 100 };
  const result = mergeSnoozeByProject(current, {});
  assert.deepEqual(result, { '/repo/a': 100 });
});

test('mergeSnoozeByProject: не мутирует переданный current', () => {
  const current = { '/repo/a': 100 };
  mergeSnoozeByProject(current, { '/repo/a': null, '/repo/b': 200 });
  assert.deepEqual(current, { '/repo/a': 100 }); // исходный объект не тронут
});
