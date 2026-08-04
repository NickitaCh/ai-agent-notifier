#!/usr/bin/env node
'use strict';

// Регистрирует native messaging host в Windows:
//  1. генерирует .bat-лаунчер, который вызывает node + native-bridge.js
//     (Chrome не умеет запускать .js напрямую, ему нужен исполняемый файл);
//  2. пишет host-манифест (JSON) со ссылкой на лаунчер;
//  3. прописывает путь к манифесту в HKCU нужного браузера (права
//     администратора не нужны).
//
// Использование:
//   node install/register-windows.js <EXTENSION_ID> [браузер] [--exe=путь\к\ai-agent-notifier.exe]
// EXTENSION_ID смотри в chrome://extensions (или edge://extensions,
// brave://extensions...) после загрузки расширения в режиме "распакованное
// расширение". браузер — chrome (по умолчанию) | chromium | edge | brave.
// Для регистрации сразу в нескольких браузерах — запустите скрипт повторно
// с тем же ID для каждого браузера (лаунчер общий, манифест и запись в
// реестре — свои на каждый).
//
// --exe — путь к собранному `npm run build:win` standalone-бинарнику
// (dist/win/ai-agent-notifier.exe): лаунчер тогда вызывает его с
// аргументом "bridge" вместо node+native-bridge.js — на целевой машине не
// нужен установленный Node.js. Без флага — обычный dev-режим (нужен node
// в PATH).

const fs = require('fs');
const path = require('path');
const platform = require('../src/platform');
const { NATIVE_HOST_NAME } = require('../src/constants');

const HOST_DIR = path.join(__dirname, '..');
const BRIDGE_SCRIPT = path.join(HOST_DIR, 'src', 'native-bridge.js');
const LAUNCHER_PATH = path.join(HOST_DIR, 'install', 'native-host-launcher.bat');

function writeLauncher(exePath) {
  const content = exePath
    ? `@echo off\r\n"${exePath}" bridge %*\r\n`
    : `@echo off\r\n"${process.execPath}" "${BRIDGE_SCRIPT}" %*\r\n`;
  fs.writeFileSync(LAUNCHER_PATH, content, 'utf8');
  return LAUNCHER_PATH;
}

function writeManifest(extensionId, browser) {
  const manifestDir = platform.nativeHostManifestDir(browser);
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'AI Agent Notifier — native host для уведомлений от Claude Code',
    path: LAUNCHER_PATH,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const manifestPath = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

function main() {
  if (process.platform !== 'win32') {
    console.error('Это скрипт для Windows. На macOS/Linux используйте install/register-unix.js');
    process.exit(1);
  }

  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const exeFlag = process.argv.slice(2).find((a) => a.startsWith('--exe='));
  const exePath = exeFlag ? path.resolve(exeFlag.slice('--exe='.length)) : null;

  const extensionId = positional[0];
  const browser = positional[1] || 'chrome';
  if (!extensionId) {
    console.error(
      'Использование: node install/register-windows.js <EXTENSION_ID> [браузер] [--exe=путь\\к\\ai-agent-notifier.exe]'
    );
    console.error(
      'ID расширения смотри в chrome://extensions после загрузки распакованного расширения.'
    );
    console.error(`браузер: ${platform.supportedBrowsers().join(', ')} (по умолчанию chrome)`);
    process.exit(1);
  }
  if (exePath && !fs.existsSync(exePath)) {
    console.error(`Файл не найден: ${exePath}`);
    process.exit(1);
  }

  let manifestPath;
  try {
    writeLauncher(exePath);
    manifestPath = writeManifest(extensionId, browser);
    platform.registerNativeHost(NATIVE_HOST_NAME, manifestPath, browser);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`Готово (${browser}).`);
  console.log(`  Манифест: ${manifestPath}`);
  console.log(`  Лаунчер:  ${LAUNCHER_PATH}${exePath ? ' -> ' + exePath : ' -> node + native-bridge.js'}`);
  console.log(`  Проверить запись реестра: reg query HKCU\\Software /s /f "${NATIVE_HOST_NAME}"`);
}

main();
