'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeExtensionId } = require('../src/installer');

test('computeExtensionId: 32 символа, только a-p (формат Chrome extension ID)', () => {
  const manifestJson = JSON.stringify({ key: Buffer.from('fake-key-bytes-for-test').toString('base64') });
  const id = computeExtensionId(manifestJson);
  assert.match(id, /^[a-p]{32}$/);
});

test('computeExtensionId: детерминирован — один и тот же key всегда даёт один и тот же id', () => {
  const manifestJson = JSON.stringify({ key: Buffer.from('same-key').toString('base64') });
  assert.equal(computeExtensionId(manifestJson), computeExtensionId(manifestJson));
});

test('computeExtensionId: разные ключи -> разные id', () => {
  const a = JSON.stringify({ key: Buffer.from('key-a').toString('base64') });
  const b = JSON.stringify({ key: Buffer.from('key-b').toString('base64') });
  assert.notEqual(computeExtensionId(a), computeExtensionId(b));
});

test('computeExtensionId: совпадает с реальным manifest.json проекта', () => {
  const manifest = require('../../extension/manifest.json');
  const id = computeExtensionId(JSON.stringify(manifest));
  assert.match(id, /^[a-p]{32}$/);
});
