'use strict';

// Простой протокол поверх TCP: одна JSON-строка на сообщение (newline-delimited JSON).

function createLineReader(socket, onMessage) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (err) {
        console.error(`[ndjson] битая строка, пропускаю: ${err.message}`);
      }
    }
  });
}

function writeLine(socket, obj) {
  socket.write(JSON.stringify(obj) + '\n');
}

module.exports = { createLineReader, writeLine };
