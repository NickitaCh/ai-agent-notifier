'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeExtensionId, mergeHooksConfig, agentHookFragments } = require('../src/installer');

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

const exePath = 'C:\\Users\\test\\AppData\\Local\\AI Agent Notifier\\ai-agent-notifier.exe';
const claudePatch = agentHookFragments(exePath)[0].hooksPatch;

test('mergeHooksConfig: в пустой конфиг добавляет все события из патча', () => {
  const { config, added } = mergeHooksConfig(undefined, claudePatch, exePath);
  assert.deepEqual(added, ['PermissionRequest', 'Notification']);
  assert.equal(config.hooks.PermissionRequest.length, 1);
  assert.ok(config.hooks.PermissionRequest[0].hooks[0].command.includes(exePath));
});

test('mergeHooksConfig: не дублирует хук, если наш exe уже стоит в этом событии', () => {
  const first = mergeHooksConfig(undefined, claudePatch, exePath).config;
  const { config, added } = mergeHooksConfig(first, claudePatch, exePath);
  assert.deepEqual(added, []);
  assert.equal(config.hooks.PermissionRequest.length, 1);
});

test('mergeHooksConfig: сохраняет чужие хуки в том же событии, добавляя наш рядом', () => {
  const existing = { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo other-tool' }] }] } };
  const { config, added } = mergeHooksConfig(existing, claudePatch, exePath);
  assert.deepEqual(added, ['PermissionRequest', 'Notification']);
  assert.equal(config.hooks.PermissionRequest.length, 2);
  assert.equal(config.hooks.PermissionRequest[0].hooks[0].command, 'echo other-tool');
});

test('mergeHooksConfig: не трогает остальные ключи конфига агента', () => {
  const existing = { permissions: { allow: ['Bash'] }, model: 'sonnet' };
  const { config } = mergeHooksConfig(existing, claudePatch, exePath);
  assert.deepEqual(config.permissions, { allow: ['Bash'] });
  assert.equal(config.model, 'sonnet');
});
