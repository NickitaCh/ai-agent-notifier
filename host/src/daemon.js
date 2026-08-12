#!/usr/bin/env node
'use strict';

// Точка входа демона — персистентного процесса-"мозга". Запускается либо
// вручную, либо автоматически из ipc-client.js (CLI-хуком или native-bridge),
// когда порт демона не отвечает. Живёт независимо от браузера и хуков.

const { logFilePath } = require('./constants');
const { createFileLogger } = require('./file-logger');
const ipcServer = require('./ipc-server');
const telegramPoller = require('./telegram-poller');

function redirectLogsToFile() {
  // Спавнится с stdio:'ignore', поэтому свой лог пишем в файл вручную —
  // иначе console.log/error улетают в никуда и отладка невозможна.
  const write = createFileLogger(logFilePath());
  console.log = (...args) => write('info', ...args);
  console.error = (...args) => write('error', ...args);
}

function main() {
  redirectLogsToFile();
  console.log(`демон стартовал, pid=${process.pid}`);
  ipcServer.start();
  // Не await — это бесконечный цикл на время жизни демона (см.
  // telegram-poller.js), должен работать параллельно с TCP-сервером, а не
  // блокировать запуск.
  telegramPoller.start().catch((err) => console.error(`[daemon] telegram-poller упал: ${err.message}`));

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('uncaughtException', (err) => {
    console.error(`необработанное исключение: ${err.stack || err.message}`);
  });
}

// Запускаемся сами, только если вызваны напрямую (node daemon.js / скомпилированный
// exe с этим модулем как entry point) — не при require() из bin/aan.js.
if (require.main === module) {
  main();
}

module.exports = { main };
