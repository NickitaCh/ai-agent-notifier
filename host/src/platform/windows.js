'use strict';

const path = require('path');
const os = require('os');

// Windows: настройки/лог/lock-файл демона храним в %APPDATA%\ai-agent-notifier
function configDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'ai-agent-notifier');
}

// Путь в реестре у каждого Chromium-браузера свой — расширение то же самое,
// но каждый браузер ищет native messaging hosts только в своей ветке HKCU.
const REGISTRY_HIVE_BY_BROWSER = {
  chrome: 'Software\\Google\\Chrome',
  chromium: 'Software\\Chromium',
  edge: 'Software\\Microsoft\\Edge',
  brave: 'Software\\BraveSoftware\\Brave-Browser',
};

function supportedBrowsers() {
  return Object.keys(REGISTRY_HIVE_BY_BROWSER);
}

function hiveFor(browser) {
  const hive = REGISTRY_HIVE_BY_BROWSER[browser];
  if (!hive) {
    throw new Error(`Неизвестный браузер "${browser}". Поддерживаются: ${supportedBrowsers().join(', ')}`);
  }
  return hive;
}

// Куда положить host-манифест на диске (сам путь произвольный, реальная
// привязка идёт через реестр) — свой подкаталог на каждый браузер, чтобы
// регистрация под разные браузеры не затирала друг друга.
function nativeHostManifestDir(browser = 'chrome') {
  hiveFor(browser); // валидация имени браузера
  return path.join(configDir(), 'native-host', browser);
}

// Запись пути к манифесту в HKCU, чтобы браузер нашёл native messaging host.
// HKCU не требует прав администратора.
function registerNativeHost(hostName, manifestPath, browser = 'chrome') {
  const { execFileSync } = require('child_process');
  const key = `HKCU\\${hiveFor(browser)}\\NativeMessagingHosts\\${hostName}`;
  execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    stdio: 'ignore',
  });
}

function unregisterNativeHost(hostName, browser = 'chrome') {
  const { execFileSync } = require('child_process');
  const key = `HKCU\\${hiveFor(browser)}\\NativeMessagingHosts\\${hostName}`;
  try {
    execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
  } catch {
    // ключа могло и не быть — не критично
  }
}

// os.release() на Windows возвращает "10.0.26200" — маркетингового номера
// версии там нет вообще, Windows 11 продолжает представляться как 10.0.
// Отличить 10 от 11 можно только по номеру сборки: 22000 — первая сборка
// Windows 11. Сборку оставляем в строке: она точнее, чем "11", когда речь
// про баг, воспроизводящийся только на конкретном обновлении.
// Оговорка: Windows Server тоже отдаёт 10.0.x (2022 — сборка 20348), и по
// этой логике определится как "10". Приемлемо — среди юзеров десктопного
// расширения серверных редакций почти не бывает.
function parseWindowsVersion(release) {
  const [major, , build] = String(release).split('.');
  if (major !== '10') return String(release);
  const buildNumber = Number(build);
  if (!Number.isFinite(buildNumber)) return String(release);
  return `${buildNumber >= 22000 ? '11' : '10'}.${buildNumber}`;
}

function osInfo() {
  return { os: 'windows', osVersion: parseWindowsVersion(os.release()) };
}

module.exports = {
  configDir,
  nativeHostManifestDir,
  registerNativeHost,
  unregisterNativeHost,
  supportedBrowsers,
  osInfo,
  parseWindowsVersion,
};
