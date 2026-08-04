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

module.exports = {
  configDir,
  nativeHostManifestDir,
  registerNativeHost,
  unregisterNativeHost,
  supportedBrowsers,
};
