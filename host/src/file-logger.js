'use strict';

// Синхронный логгер в файл с простой ротацией на один бэкап (.1).
// Синхронно — не через createWriteStream: объём логов тут крошечный
// (десятки строк на событие), а синхронная запись убирает целый класс
// гонок между открытием/буферизацией стрима и проверкой размера файла для
// ротации — без неё statSync сразу после write мог увидеть файл, который
// физически ещё не создан на диске.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 МБ — с запасом для однопользовательского локального лога

function createFileLogger(logPath, maxBytes = DEFAULT_MAX_BYTES) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  function currentSize() {
    try {
      return fs.statSync(logPath).size;
    } catch {
      return 0;
    }
  }

  function rotateIfNeeded() {
    if (currentSize() < maxBytes) return;
    try {
      fs.renameSync(logPath, `${logPath}.1`);
    } catch {
      // не удалось переименовать — не критично, продолжаем дописывать как есть
    }
  }

  return function write(level, ...args) {
    const line = `[${new Date().toISOString()}] [${level}] ${args.join(' ')}\n`;
    rotateIfNeeded();
    try {
      fs.appendFileSync(logPath, line);
    } catch {
      // сбой записи лога не должен ронять вызывающий процесс
    }
  };
}

module.exports = { createFileLogger };
