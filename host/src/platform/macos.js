'use strict';

// НЕ ПРОТЕСТИРОВАНО (разработка ведётся на Windows), но по документации Chrome
// на macOS регистрация native messaging host — это просто JSON-файл-манифест
// в определённой папке, без реестра. У каждого Chromium-браузера своя папка
// приложения в Application Support.

const path = require('path');
const os = require('os');
const fs = require('fs');

function configDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'ai-agent-notifier');
}

const APP_SUPPORT_SEGMENTS_BY_BROWSER = {
  chrome: ['Google', 'Chrome'],
  chromium: ['Chromium'],
  edge: ['Microsoft Edge'],
  brave: ['BraveSoftware', 'Brave-Browser'],
};

function supportedBrowsers() {
  return Object.keys(APP_SUPPORT_SEGMENTS_BY_BROWSER);
}

function segmentsFor(browser) {
  const segments = APP_SUPPORT_SEGMENTS_BY_BROWSER[browser];
  if (!segments) {
    throw new Error(`Неизвестный браузер "${browser}". Поддерживаются: ${supportedBrowsers().join(', ')}`);
  }
  return segments;
}

function nativeHostManifestDir(browser = 'chrome') {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    ...segmentsFor(browser),
    'NativeMessagingHosts'
  );
}

// На macOS регистрация = просто положить манифест в нужную папку под именем host'а.
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

module.exports = {
  configDir,
  nativeHostManifestDir,
  registerNativeHost,
  unregisterNativeHost,
  supportedBrowsers,
};
