'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Реализации подключаем НАПРЯМУЮ, минуя platform/index.js: тот выбирает
// модуль по process.platform, а проверить надо парсеры всех трёх ОС с
// машины разработки (Windows). Сами парсеры чистые — на вход строка, ничего
// не читают с диска, поэтому так это безопасно.
const windows = require('../src/platform/windows');
const macos = require('../src/platform/macos');
const linux = require('../src/platform/linux');

test('parseWindowsVersion: сборка >= 22000 — это Windows 11', () => {
  assert.equal(windows.parseWindowsVersion('10.0.26200'), '11.26200');
  // Ровно граница: 22000 — первая сборка Windows 11.
  assert.equal(windows.parseWindowsVersion('10.0.22000'), '11.22000');
});

test('parseWindowsVersion: сборка < 22000 — это Windows 10', () => {
  assert.equal(windows.parseWindowsVersion('10.0.19045'), '10.19045');
  assert.equal(windows.parseWindowsVersion('10.0.21999'), '10.21999');
});

test('parseWindowsVersion: не 10.x и мусор отдаются как есть', () => {
  assert.equal(windows.parseWindowsVersion('6.1.7601'), '6.1.7601');
  assert.equal(windows.parseWindowsVersion('10.0.abc'), '10.0.abc');
  assert.equal(windows.parseWindowsVersion(''), '');
});

test('parseMacosVersion: Darwin major переводится в версию macOS', () => {
  assert.equal(macos.parseMacosVersion('24.5.0'), '15');
  assert.equal(macos.parseMacosVersion('23.0.0'), '14');
  assert.equal(macos.parseMacosVersion('19.6.0'), '10.15');
  // Прыжок нумерации macOS 15 -> 26: формулой major-9 не считается.
  assert.equal(macos.parseMacosVersion('25.0.0'), '26');
});

test('parseMacosVersion: версия новее таблицы не угадывается, а отдаётся сырой', () => {
  assert.equal(macos.parseMacosVersion('27.1.0'), 'darwin-27');
  assert.equal(macos.parseMacosVersion('нечисло'), 'darwin-unknown');
});

test('parseOsRelease: ID + VERSION_ID, кавычки снимаются', () => {
  const text = [
    'PRETTY_NAME="Ubuntu 22.04.3 LTS"',
    'NAME="Ubuntu"',
    'VERSION_ID="22.04"',
    'ID=ubuntu',
    'ID_LIKE=debian',
  ].join('\n');
  assert.equal(linux.parseOsRelease(text), 'ubuntu/22.04');
});

test('parseOsRelease: rolling-релиз без VERSION_ID — только ID', () => {
  assert.equal(linux.parseOsRelease('NAME="Arch Linux"\nID=arch'), 'arch');
});

test('parseOsRelease: без ID парсить нечего', () => {
  assert.equal(linux.parseOsRelease('PRETTY_NAME="Что-то"'), null);
  assert.equal(linux.parseOsRelease(''), null);
});

test('osInfo текущей платформы отдаёт непустые os и osVersion', () => {
  const platform = require('../src/platform');
  const info = platform.osInfo();
  assert.ok(['windows', 'macos', 'linux'].includes(info.os));
  assert.ok(info.osVersion.length > 0);
});

test('clientInfo: собирает полный слепок клиента', () => {
  const { clientInfo } = require('../src/client-info');
  const info = clientInfo();
  assert.ok(['windows', 'macos', 'linux'].includes(info.os));
  assert.ok(info.osVersion.length > 0);
  assert.ok(info.arch.length > 0);
  assert.match(info.hostVersion, /^\d+\.\d+\.\d+/);
  // В тестах бежим под обычным node, не под pkg-бинарником.
  assert.equal(info.packaged, false);
});
