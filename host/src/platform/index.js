'use strict';

// Единая точка входа для ОС-зависимого слоя. Логика демона/роутера/каналов
// работает только через этот интерфейс и не знает, какая под ним ОС.
// Контракт реализации (windows.js / macos.js / linux.js):
//   configDir(): string                          — папка для настроек/лога/lock-файла демона
//   nativeHostManifestDir(): string               — куда кладём/откуда читаем host-манифест
//   registerNativeHost(hostName, manifestPath)    — зарегистрировать native messaging host
//   unregisterNativeHost(hostName)                — снять регистрацию
//   osInfo(): { os, osVersion }                   — ОС и её версия в читаемом виде
//                                                   (см. client-info.js — кто и зачем это шлёт)

const impls = {
  win32: () => require('./windows'),
  darwin: () => require('./macos'),
  linux: () => require('./linux'),
};

const load = impls[process.platform];
if (!load) {
  throw new Error(`Платформа ${process.platform} пока не поддерживается`);
}

module.exports = load();
