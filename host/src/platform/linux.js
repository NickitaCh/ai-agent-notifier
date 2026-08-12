'use strict';

// НЕ ПРОТЕСТИРОВАНО (разработка ведётся на Windows). У каждого Chromium-браузера
// на Linux своя папка конфига в ~/.config.

const path = require('path');
const os = require('os');
const fs = require('fs');

function configDir() {
  return path.join(os.homedir(), '.config', 'ai-agent-notifier');
}

const CONFIG_SEGMENTS_BY_BROWSER = {
  chrome: ['google-chrome'],
  chromium: ['chromium'],
  edge: ['microsoft-edge'],
  brave: ['BraveSoftware', 'Brave-Browser'],
};

function supportedBrowsers() {
  return Object.keys(CONFIG_SEGMENTS_BY_BROWSER);
}

function segmentsFor(browser) {
  const segments = CONFIG_SEGMENTS_BY_BROWSER[browser];
  if (!segments) {
    throw new Error(`Неизвестный браузер "${browser}". Поддерживаются: ${supportedBrowsers().join(', ')}`);
  }
  return segments;
}

function nativeHostManifestDir(browser = 'chrome') {
  return path.join(os.homedir(), '.config', ...segmentsFor(browser), 'NativeMessagingHosts');
}

function registerNativeHost(hostName, manifestPath, browser = 'chrome') {
  const targetDir = nativeHostManifestDir(browser);
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, `${hostName}.json`);
  fs.copyFileSync(manifestPath, target);
}

function unregisterNativeHost(hostName, browser = 'chrome') {
  const target = path.join(nativeHostManifestDir(browser), `${hostName}.json`);
  try {
    fs.unlinkSync(target);
  } catch {
    // файла могло и не быть
  }
}

// На Linux os.release() — это версия ядра ("5.15.0-79-generic"), которая
// про дистрибутив не говорит ничего. Дистрибутив берём из /etc/os-release
// (freedesktop-стандарт, есть во всех живых дистрибутивах): ID + VERSION_ID.
function parseOsRelease(text) {
  const fields = {};
  for (const line of String(text).split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    // Значения бывают и в кавычках, и без ('VERSION_ID="22.04"' vs 'ID=arch').
    fields[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  if (!fields.ID) return null;
  // У rolling-релизов (arch, gentoo) VERSION_ID нет вовсе — это не ошибка.
  return fields.VERSION_ID ? `${fields.ID}/${fields.VERSION_ID}` : fields.ID;
}

function osInfo() {
  let osVersion = 'unknown';
  try {
    osVersion = parseOsRelease(fs.readFileSync('/etc/os-release', 'utf8')) || 'unknown';
  } catch {
    // Файла может не быть в экзотическом окружении (некоторые контейнеры) —
    // это метрика, а не функциональность, молча деградируем до "unknown".
  }
  return { os: 'linux', osVersion };
}

module.exports = {
  configDir,
  nativeHostManifestDir,
  registerNativeHost,
  unregisterNativeHost,
  supportedBrowsers,
  osInfo,
  parseOsRelease,
};
