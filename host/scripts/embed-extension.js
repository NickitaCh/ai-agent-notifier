#!/usr/bin/env node
'use strict';

// Генерирует host/src/embedded-extension.js — снимок содержимого extension/
// в виде JS-литералов. Нужно затем, чтобы `aan.exe` (installer.js) мог сам
// распаковать расширение на диск при установке без Node.js на целевой
// машине: pkg встраивает в снапшот только то, что находится внутри host/ и
// подключено через require() с литеральным путём, а extension/ — соседняя
// папка вне этого дерева. Проще всего один раз (на этапе сборки) прочитать
// файлы и сгенерировать обычный .js-модуль — дальше это уже штатный
// bundling, никаких особых путей pkg разрешать не нужно.
//
// Запускается перед каждой pkg-сборкой (см. package.json, build:*).
// Сгенерированный файл не коммитится (.gitignore) — он всегда свежий на
// момент сборки.

const fs = require('fs');
const path = require('path');

const EXTENSION_DIR = path.join(__dirname, '..', '..', 'extension');
const OUTPUT_PATH = path.join(__dirname, '..', 'src', 'embedded-extension.js');

const TEXT_EXTENSIONS = new Set(['.js', '.json', '.html', '.css']);

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, base));
    } else {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function main() {
  const relFiles = listFiles(EXTENSION_DIR).sort();
  const entries = relFiles.map((rel) => {
    const abs = path.join(EXTENSION_DIR, rel);
    const isText = TEXT_EXTENSIONS.has(path.extname(rel));
    if (isText) {
      const content = fs.readFileSync(abs, 'utf8');
      return `  ${JSON.stringify(rel)}: { encoding: 'utf8', content: ${JSON.stringify(content)} },`;
    }
    const content = fs.readFileSync(abs).toString('base64');
    return `  ${JSON.stringify(rel)}: { encoding: 'base64', content: ${JSON.stringify(content)} },`;
  });

  const output = `'use strict';

// АВТОСГЕНЕРИРОВАНО: scripts/embed-extension.js. Не редактировать руками —
// перегенерируется при каждой сборке (npm run build:*) из содержимого
// extension/.

module.exports = {
  files: {
${entries.join('\n')}
  },
};
`;

  fs.writeFileSync(OUTPUT_PATH, output, 'utf8');
  console.log(`Встроено файлов: ${relFiles.length} -> ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main();
