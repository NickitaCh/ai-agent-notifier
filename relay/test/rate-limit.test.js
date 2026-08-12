'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../src/rate-limit');

test('allow: пропускает до max запросов в окне, дальше блокирует', () => {
  const limiter = createLimiter({ windowMs: 60000, max: 3 });
  assert.equal(limiter.allow('ip1'), true);
  assert.equal(limiter.allow('ip1'), true);
  assert.equal(limiter.allow('ip1'), true);
  assert.equal(limiter.allow('ip1'), false);
});

test('allow: разные ключи считаются независимо', () => {
  const limiter = createLimiter({ windowMs: 60000, max: 1 });
  assert.equal(limiter.allow('ip1'), true);
  assert.equal(limiter.allow('ip2'), true);
  assert.equal(limiter.allow('ip1'), false);
  assert.equal(limiter.allow('ip2'), false);
});

test('allow: новое окно после истечения windowMs сбрасывает счётчик', async () => {
  const limiter = createLimiter({ windowMs: 20, max: 1 });
  assert.equal(limiter.allow('ip1'), true);
  assert.equal(limiter.allow('ip1'), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(limiter.allow('ip1'), true);
});
