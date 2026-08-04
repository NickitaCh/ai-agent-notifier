#!/usr/bin/env node
'use strict';

// Использование: node install/unregister-windows.js [браузер]
// браузер — chrome (по умолчанию) | chromium | edge | brave.

const platform = require('../src/platform');
const { NATIVE_HOST_NAME } = require('../src/constants');

const browser = process.argv[2] || 'chrome';

try {
  platform.unregisterNativeHost(NATIVE_HOST_NAME, browser);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(`Регистрация native messaging host (${browser}) снята из реестра HKCU.`);
console.log('Файл манифеста/лаунчера при этом не удалялся — можно почистить install/ и папку конфига вручную.');
