'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBlanketlyAllowed, ruleMatches, parseRule, globToRegExp } = require('../src/claude-permissions');

test('parseRule: бланковое правило (без скобок)', () => {
  assert.deepEqual(parseRule('Bash'), { tool: 'Bash', arg: null });
});

test('parseRule: правило с аргументом', () => {
  assert.deepEqual(parseRule('Bash(rm*)'), { tool: 'Bash', arg: 'rm*' });
});

test('globToRegExp: * матчит что угодно, остальное — буквально', () => {
  const re = globToRegExp('mcp__claude-in-chrome__*');
  assert.equal(re.test('mcp__claude-in-chrome__navigate'), true);
  assert.equal(re.test('mcp__other__navigate'), false);
});

test('ruleMatches: бланковое правило матчит любой tool_input', () => {
  assert.equal(ruleMatches('Bash', 'Bash', { command: 'echo hi' }), true);
  assert.equal(ruleMatches('Bash', 'Bash', { command: 'rm -rf /' }), true);
});

test('ruleMatches: правило с аргументом матчит только по command', () => {
  assert.equal(ruleMatches('Bash(rm*)', 'Bash', { command: 'rm -rf /tmp/x' }), true);
  assert.equal(ruleMatches('Bash(rm*)', 'Bash', { command: 'echo hi' }), false);
});

test('ruleMatches: не матчит другой инструмент', () => {
  assert.equal(ruleMatches('Bash', 'PowerShell', { command: 'echo hi' }), false);
});

test('ruleMatches: составная команда — паттерн ловит подкоманду не в начале строки (регресс)', () => {
  // Реальный случай: "cd x && rm -f y && python ..." — rm не в начале
  // полной строки, но по факту это опасная команда, которую нужно поймать.
  assert.equal(
    ruleMatches('Bash(rm*)', 'Bash', { command: 'cd /tmp/x && rm -f file.xlsx && python -c "print(1)"' }),
    true
  );
});

test('ruleMatches: составная команда без опасной подкоманды не матчит', () => {
  assert.equal(
    ruleMatches('Bash(rm*)', 'Bash', { command: 'cd /tmp/x && echo hi && python -c "print(1)"' }),
    false
  );
});

test('ruleMatches: разделитель ";" тоже разбирается', () => {
  assert.equal(ruleMatches('Bash(rm*)', 'Bash', { command: 'echo start; rm -rf /tmp/y' }), true);
});

test('ruleMatches: разделитель "|" (pipe) тоже разбирается', () => {
  assert.equal(ruleMatches('Bash(rm*)', 'Bash', { command: 'echo y | rm -i file' }), true);
});

test('isBlanketlyAllowed: без tool name -> false (безопасный дефолт, уведомляем)', () => {
  assert.equal(isBlanketlyAllowed(null, {}, 'default', {}), false);
});

test('isBlanketlyAllowed: bypassPermissions -> всегда true, независимо от settings.json', () => {
  assert.equal(isBlanketlyAllowed('AnythingAtAll', {}, 'bypassPermissions', {}), true);
});

test('isBlanketlyAllowed: auto и dontAsk тоже считаются "без вопросов"', () => {
  assert.equal(isBlanketlyAllowed('X', {}, 'auto', {}), true);
  assert.equal(isBlanketlyAllowed('X', {}, 'dontAsk', {}), true);
});

test('isBlanketlyAllowed: acceptEdits разрешает только tools для правки файлов', () => {
  assert.equal(isBlanketlyAllowed('Edit', { file_path: 'a.js' }, 'acceptEdits', {}), true);
  assert.equal(isBlanketlyAllowed('Write', {}, 'acceptEdits', {}), true);
  assert.equal(isBlanketlyAllowed('Bash', { command: 'echo hi' }, 'acceptEdits', {}), false);
});

test('isBlanketlyAllowed: default-режим смотрит в permissions.allow', () => {
  const settings = { permissions: { allow: ['Bash'] } };
  assert.equal(isBlanketlyAllowed('Bash', { command: 'echo hi' }, 'default', settings), true);
  assert.equal(isBlanketlyAllowed('Edit', {}, 'default', settings), false);
});

test('isBlanketlyAllowed: ask-правило перекрывает бланковый allow (ключевая гарантия безопасности)', () => {
  const settings = {
    permissions: {
      allow: ['Bash'],
      ask: ['Bash(rm*)', 'Bash(sudo*)'],
    },
  };
  assert.equal(isBlanketlyAllowed('Bash', { command: 'echo hi' }, 'default', settings), true);
  assert.equal(isBlanketlyAllowed('Bash', { command: 'rm -rf /' }, 'default', settings), false);
  assert.equal(isBlanketlyAllowed('Bash', { command: 'sudo reboot' }, 'default', settings), false);
});

test('isBlanketlyAllowed: ask-правило ловит rm и внутри составной команды (реальный найденный баг)', () => {
  // Живой случай: "cd dir && rm -f file && python ..." тихо прошёл как
  // "безусловно разрешено", потому что rm не в начале всей строки — из-за
  // этого пропало уведомление, хотя сам Claude Code всё равно спросил.
  const settings = {
    permissions: {
      allow: ['Bash'],
      ask: ['Bash(rm*)'],
    },
  };
  const command = 'cd /tmp/project && rm -f _stage1.xlsx && python -c "print(1)"';
  assert.equal(isBlanketlyAllowed('Bash', { command }, 'default', settings), false);
});

test('isBlanketlyAllowed: инструмент вне allow -> уведомляем (безопасный дефолт)', () => {
  const settings = { permissions: { allow: ['Bash'] } };
  assert.equal(isBlanketlyAllowed('WebFetch', { url: 'https://x' }, 'default', settings), false);
});

test('isBlanketlyAllowed: пустые/отсутствующие permissions в settings.json -> ничего не разрешено бланково', () => {
  assert.equal(isBlanketlyAllowed('Bash', { command: 'echo hi' }, 'default', {}), false);
});
