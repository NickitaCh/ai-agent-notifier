#!/usr/bin/env node
'use strict';

// Это исполняемый файл, который реально регистрируется как Chrome native
// messaging host (см. install/native-host-manifest.template.json). Chrome
// сам спавнит его через stdio, когда расширение вызывает connectNative().
//
// Задача моста — тонкая: перекладывать сообщения между native-messaging-
// протоколом Chrome (stdin/stdout, 4-байтный префикс длины + JSON) и
// TCP-демоном (ndjson). Сам мост не хранит состояние и не решает роутинг —
// это делает демон. Живёт мост ровно столько, сколько открыт порт в
// расширении; при закрытии — просто выходит, демон продолжает работать.
//
// ВАЖНО: сюда нельзя писать в stdout ничего, кроме кадров протокола —
// Chrome разбирает stdout строго по этому формату. Диагностика — только
// через console.error (уходит в stderr).

const ipcClient = require('./ipc-client');
const { writeLine, createLineReader } = require('./ndjson');

function readNativeMessages(onMessage) {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break; // сообщение ещё не докачалось целиком
      const body = buffer.slice(4, 4 + length);
      buffer = buffer.slice(4 + length);
      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch (err) {
        console.error(`[native-bridge] битое сообщение от расширения: ${err.message}`);
      }
    }
  });
  process.stdin.on('end', () => {
    console.error('[native-bridge] stdin закрыт (Chrome отключился), выхожу');
    process.exit(0);
  });
}

function writeNativeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

async function main() {
  let daemonSocket;
  try {
    daemonSocket = await ipcClient.connect();
  } catch (err) {
    console.error(`[native-bridge] не удалось подключиться к демону: ${err.message}`);
    process.exit(1);
  }

  writeLine(daemonSocket, { type: 'bridge_register' });

  // Демон -> расширение. "push" разворачиваем (расширение исторически
  // ждёт payload напрямую, без обёртки) — остальное (settings_snapshot и
  // т.п.) пробрасываем как есть.
  createLineReader(daemonSocket, (msg) => {
    if (msg.type === 'push') {
      writeNativeMessage(msg.payload);
    } else {
      writeNativeMessage(msg);
    }
  });
  daemonSocket.on('close', () => {
    console.error('[native-bridge] соединение с демоном закрыто, выхожу');
    process.exit(0);
  });
  daemonSocket.on('error', (err) => {
    console.error(`[native-bridge] ошибка соединения с демоном: ${err.message}`);
    process.exit(1);
  });

  // Расширение -> демон (ответы Разрешить/Отклонить и т.п.)
  readNativeMessages((msg) => {
    writeLine(daemonSocket, msg);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
