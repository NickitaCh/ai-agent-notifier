#!/usr/bin/env node
'use strict';

// Регистрирует native messaging host на macOS/Linux. Один скрипт на обе ОС,
// потому что механизм идентичен (просто JSON-манифест в папке браузера, без
// реестра) — различаются только пути, а они уже вынесены в
// host/src/platform/{macos,linux}.js.
//
// НЕ ПРОТЕСТИРОВАНО вживую (разработка велась на Windows), реализовано по
// документированному поведению Chrome. Если не заработает, проверьте
// в первую очередь: 1) исполняемый бит на native-bridge.js (chmod +x),
// 2) что "path" в манифесте — абсолютный путь.
//
// Использование:
//   node install/register-unix.js <EXTENSION_ID> [браузер] [--exe=/путь/к/ai-agent-notifier]
// EXTENSION_ID смотри в chrome://extensions (или edge://extensions,
// brave://extensions...) после загрузки расширения в режиме "распакованное
// расширение". браузер — chrome (по умолчанию) | chromium | edge | brave.
// Для регистрации сразу в нескольких браузерах — запустите скрипт повторно
// с тем же ID для каждого браузера.
//
// --exe — путь к собранному standalone-бинарнику (npm run build:mac /
// build:linux): генерируется тонкий shell-скрипт-обёртка, которая вызывает
// его с аргументом "bridge" — на целевой машине не нужен Node.js.

const fs = require('fs');
const path = require('path');
const platform = require('../src/platform');
const { NATIVE_HOST_NAME } = require('../src/constants');

const HOST_DIR = path.join(__dirname, '..');
const BRIDGE_SCRIPT = path.join(HOST_DIR, 'src', 'native-bridge.js');
const GENERATED_MANIFEST = path.join(HOST_DIR, 'install', `${NATIVE_HOST_NAME}.generated.json`);
const LAUNCHER_PATH = path.join(HOST_DIR, 'install', 'native-host-launcher.sh');

function ensureExecutable() {
  fs.chmodSync(BRIDGE_SCRIPT, 0o755);
}

// Возвращает путь, который нужно прописать в манифест как "path": либо
// сам native-bridge.js (шебанг + chmod), либо сгенерированная обёртка
// вокруг standalone-бинарника (в манифесте нельзя передать аргументы —
// "bridge" зашивается в обёртку).
function resolveHostPath(exePath) {
  if (!exePath) {
    ensureExecutable();
    return BRIDGE_SCRIPT;
  }
  const content = `#!/bin/sh\nexec "${exePath}" bridge "$@"\n`;
  fs.writeFileSync(LAUNCHER_PATH, content, 'utf8');
  fs.chmodSync(LAUNCHER_PATH, 0o755);
  return LAUNCHER_PATH;
}

function writeGeneratedManifest(extensionId, hostPath) {
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'AI Agent Notifier — native host для уведомлений от Claude Code',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  fs.writeFileSync(GENERATED_MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
  return GENERATED_MANIFEST;
}

function main() {
  if (process.platform === 'win32') {
    console.error('Это скрипт для macOS/Linux. На Windows используйте install/register-windows.js');
    process.exit(1);
  }

  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const exeFlag = process.argv.slice(2).find((a) => a.startsWith('--exe='));
  const exePath = exeFlag ? path.resolve(exeFlag.slice('--exe='.length)) : null;

  const extensionId = positional[0];
  const browser = positional[1] || 'chrome';
  if (!extensionId) {
    console.error(
      'Использование: node install/register-unix.js <EXTENSION_ID> [браузер] [--exe=/путь/к/бинарнику]'
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

  let finalPath;
  try {
    const hostPath = resolveHostPath(exePath);
    const generatedManifest = writeGeneratedManifest(extensionId, hostPath);
    platform.registerNativeHost(NATIVE_HOST_NAME, generatedManifest, browser);
    finalPath = path.join(platform.nativeHostManifestDir(browser), `${NATIVE_HOST_NAME}.json`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`Готово (${browser}).`);
  console.log(`  Манифест: ${finalPath}`);
  console.log(exePath ? `  Обёртка:  ${LAUNCHER_PATH} -> ${exePath}` : `  Хост:     ${BRIDGE_SCRIPT} (chmod +x применён)`);
}

main();
