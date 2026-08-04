'use strict';

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { DAEMON_PORT, DAEMON_HOST } = require('./constants');
const { writeLine } = require('./ndjson');
const auth = require('./auth');

const DAEMON_ENTRY = path.join(__dirname, 'daemon.js');

function tryConnect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port: DAEMON_PORT, host: DAEMON_HOST });
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      // Хендшейк — первое, что уходит в сокет, до любых submit_event/
      // bridge_register. Демон отвергнет всё остальное, пока не увидит
      // валидный токен (см. ipc-server.js).
      writeLine(socket, { type: 'auth', token: auth.loadOrCreateToken() });
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function spawnDaemon() {
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Подключается к демону; если он ещё не поднят — запускает detached-процесс
// и ждёт, пока порт откликнется. Используется и CLI-хуком, и native-bridge.
async function connect({ autoStart = true, retries = 15, retryDelayMs = 200 } = {}) {
  try {
    return await tryConnect();
  } catch {
    if (!autoStart) throw new Error('Демон недоступен, автозапуск отключён');
  }

  spawnDaemon();

  for (let i = 0; i < retries; i++) {
    await wait(retryDelayMs);
    try {
      return await tryConnect();
    } catch {
      // пробуем ещё раз
    }
  }
  throw new Error('Не удалось подключиться к демону даже после автозапуска');
}

module.exports = { connect };
