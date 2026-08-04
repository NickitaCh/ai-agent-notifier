#!/usr/bin/env node
'use strict';

// Единая точка входа для standalone-сборки (pkg): вместо пяти отдельных
// .exe — один бинарник, поведение выбирается первым аргументом. Каждый
// отдельный скрипт (daemon.js, native-bridge.js, notify-agent*.js)
// по-прежнему работает и сам по себе через node — это не замена, а
// дополнительный способ запуска для дистрибутива без Node.js.
//
// Использование:
//   aan daemon
//   aan bridge
//   aan notify permission | notify done                  (Claude Code)
//   aan notify-cursor                                     (Cursor, тип хука в stdin)
//   aan notify-copilot permission | notify-copilot done   (GitHub Copilot CLI)
//   aan notify-codex                                       (OpenAI Codex CLI, только deny имеет эффект)

const command = process.argv[2];
const rest = process.argv.slice(3);

// Подставляем argv так, будто дочерний модуль запущен напрямую —
// notify-agent*.js сами разбирают process.argv[2] как подкоманду.
// require() пишем литеральной строкой в каждой ветке (не через переменную) —
// pkg статически анализирует require() при сборке и не бандлит то, что
// не может распознать как литерал.
function setArgs(args) {
  process.argv = [process.argv[0], process.argv[1], ...args];
}

switch (command) {
  case 'daemon':
    require('../src/daemon').main();
    break;
  case 'bridge':
    require('../src/native-bridge').main();
    break;
  case 'notify':
    setArgs(rest);
    require('./notify-agent').main();
    break;
  case 'notify-cursor':
    setArgs(rest);
    require('./notify-agent-cursor').main();
    break;
  case 'notify-copilot':
    setArgs(rest);
    require('./notify-agent-copilot').main();
    break;
  case 'notify-codex':
    setArgs(rest);
    require('./notify-agent-codex').main();
    break;
  default:
    console.error('Использование: aan <daemon|bridge|notify|notify-cursor|notify-copilot|notify-codex> [...]');
    process.exit(1);
}
