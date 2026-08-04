#!/usr/bin/env node
'use strict';

// Использование: node install/unregister-unix.js [браузер]
// браузер — chrome (по умолчанию) | chromium | edge | brave.

const platform = require('../src/platform');
const { NATIVE_HOST_NAME } = require('../src/constants');

if (process.platform === 'win32') {
  console.error('Это скрипт для macOS/Linux. На Windows используйте install/unregister-windows.js');
  process.exit(1);
}

const browser = process.argv[2] || 'chrome';

try {
  platform.unregisterNativeHost(NATIVE_HOST_NAME, browser);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(`Манифест ${NATIVE_HOST_NAME}.json удалён из папки NativeMessagingHosts (${browser}).`);
