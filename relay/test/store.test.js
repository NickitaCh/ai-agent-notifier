'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aan-relay-store-test-'));
}

test('createUser + getUser: сохранённого юзера можно прочитать обратно', () => {
  const dir = tempDir();
  store.createUser(dir, 'tok-1', 12345);
  const user = store.getUser(dir, 'tok-1');
  assert.equal(user.chatId, 12345);
  assert.equal(user.tier, 'free');
  assert.ok(user.createdAt > 0);
});

test('getUser: неизвестный токен -> undefined', () => {
  const dir = tempDir();
  assert.equal(store.getUser(dir, 'нет-такого'), undefined);
});

test('load: на свежей папке возвращает пустой объект, не бросает', () => {
  const dir = tempDir();
  assert.deepEqual(store.load(dir), {});
});

test('createUser: не затирает других уже сохранённых юзеров', () => {
  const dir = tempDir();
  store.createUser(dir, 'tok-a', 1);
  store.createUser(dir, 'tok-b', 2);
  const all = store.load(dir);
  assert.equal(all['tok-a'].chatId, 1);
  assert.equal(all['tok-b'].chatId, 2);
});
