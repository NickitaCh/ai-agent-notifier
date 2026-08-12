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

// os.release() на macOS отдаёт версию ядра Darwin ("24.5.0"), а не версию
// macOS — как "ОС юзера" это нечитаемо. Соответствие задано таблицей, а не
// формулой (Darwin major - 9), потому что формула ломается дважды: на 10.15
// снизу и на прыжке нумерации macOS 15 -> 26 сверху.
// Альтернатива — спавнить `sw_vers`, но это лишний процесс на каждое
// событие ради строчки, которая и так известна из таблицы.
const MACOS_BY_DARWIN_MAJOR = {
  19: '10.15',
  20: '11',
  21: '12',
  22: '13',
  23: '14',
  24: '15',
  25: '26',
};

function parseMacosVersion(darwinRelease) {
  const major = Number(String(darwinRelease).split('.')[0]);
  // Неизвестный major — это версия новее таблицы. Возвращаем сырой Darwin,
  // а не гадаем: "darwin-27" в отчёте честно читается как "пора обновить
  // таблицу", а неверно угаданное "17" молча испортило бы статистику.
  return MACOS_BY_DARWIN_MAJOR[major] || `darwin-${Number.isFinite(major) ? major : 'unknown'}`;
}

function osInfo() {
  return { os: 'macos', osVersion: parseMacosVersion(os.release()) };
}

module.exports = {
  configDir,
  nativeHostManifestDir,
  registerNativeHost,
  unregisterNativeHost,
  supportedBrowsers,
  osInfo,
  parseMacosVersion,
};
