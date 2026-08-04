'use strict';

const path = require('path');
const platform = require('./platform');

// Имя должно совпадать в: native-host-manifest.template.json, реестре и
// extension/background.js (аргумент connectNative).
const NATIVE_HOST_NAME = 'com.aiagentnotifier.host';

// Порт локального TCP-сервера демона. Фиксированный, чтобы CLI и bridge
// могли найти демон без файла-дискавери. При конфликте порта поменяйте
// здесь и пересоберите/перезапустите демон.
const DAEMON_PORT = 8765;
const DAEMON_HOST = '127.0.0.1';

function logFilePath() {
  return path.join(platform.configDir(), 'daemon.log');
}

// Отдельный лог для CLI-адаптеров (notify-agent*.js) — демон видит только
// то, что реально до него достучалось; если хук упал/не успел подключиться
// ДО этого момента, в daemon.log вообще ничего не появится. Этот лог пишут
// сами адаптеры на каждый чек-поинт, независимо от того, дошли ли до демона.
function hookLogFilePath() {
  return path.join(platform.configDir(), 'hook-cli.log');
}

function routingSettingsPath() {
  return path.join(platform.configDir(), 'routing.json');
}

module.exports = {
  NATIVE_HOST_NAME,
  DAEMON_PORT,
  DAEMON_HOST,
  logFilePath,
  hookLogFilePath,
  routingSettingsPath,
};
