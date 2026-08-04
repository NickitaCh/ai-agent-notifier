'use strict';

// Регистрация native messaging host из самого standalone-бинарника (aan.exe
// register ...) — без Node.js и без клонирования репозитория на целевой
// машине. В отличие от register-windows.js/register-unix.js, здесь нельзя
// опираться на __dirname: под pkg он указывает на виртуальный путь внутри
// снапшота, а не на реальный диск. Вместо этого лаунчер кладётся рядом с
// самим exe — path.dirname(process.execPath) реален что под pkg, что под
// голым node.

const fs = require('fs');
const path = require('path');
const platform = require('../src/platform');
const { NATIVE_HOST_NAME } = require('../src/constants');

function launcherPathFor(exeDir) {
  return path.join(exeDir, 'native-host-launcher.bat');
}

function writeLauncher(exeDir) {
  const launcherPath = launcherPathFor(exeDir);
  const content = `@echo off\r\n"${process.execPath}" bridge %*\r\n`;
  fs.writeFileSync(launcherPath, content, 'utf8');
  return launcherPath;
}

function writeManifest(launcherPath, extensionId, browser) {
  const manifestDir = platform.nativeHostManifestDir(browser);
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'AI Agent Notifier — native host для уведомлений от Claude Code',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const manifestPath = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

function register(extensionId, browser) {
  if (process.platform !== 'win32') {
    console.error('Команда register в этой сборке поддерживает только Windows — см. README для macOS/Linux.');
    process.exit(1);
  }
  if (!extensionId) {
    console.error('Использование: ai-agent-notifier.exe register <EXTENSION_ID> [chrome|chromium|edge|brave]');
    console.error('ID расширения — на странице chrome://extensions после загрузки распакованного расширения.');
    process.exit(1);
  }

  const exeDir = path.dirname(process.execPath);
  let manifestPath;
  try {
    const launcherPath = writeLauncher(exeDir);
    manifestPath = writeManifest(launcherPath, extensionId, browser);
    platform.registerNativeHost(NATIVE_HOST_NAME, manifestPath, browser);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`Готово (${browser}).`);
  console.log(`  Манифест: ${manifestPath}`);
  console.log(`  Лаунчер:  ${launcherPathFor(exeDir)}`);
}

function unregister(browser) {
  if (process.platform !== 'win32') {
    console.error('Команда unregister в этой сборке поддерживает только Windows.');
    process.exit(1);
  }
  platform.unregisterNativeHost(NATIVE_HOST_NAME, browser);
  console.log(`Регистрация снята (${browser}).`);
}

module.exports = { register, unregister };
