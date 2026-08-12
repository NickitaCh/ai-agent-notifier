#!/usr/bin/env node
'use strict';

// Копирует docs/index.html и docs/privacy.html (репозиторий отдаёт их
// через GitHub Pages) в relay/public/ — оттуда их отдаёт сам relay по
// корневому "/" и "/privacy.html", чтобы https://ai-agent-notify.ru тоже
// показывал живую страницу, а не голый 404.
//
// docs/ — единственный источник текста: relay/public/ генерируется, не
// редактируется руками (тот же приём, что host/scripts/embed-extension.js
// для extension/ — держать контент в одном месте, а не поддерживать две
// копии, которые неизбежно разойдутся). Гитигнорится, пересоздаётся перед
// каждым деплоем.
//
// Важно: на VPS в relay/ уезжает только сама эта папка relay/ (см. деплой
// в CLAUDE.md/README) — docs/ там нет. Поэтому синк делается ЛОКАЛЬНО,
// до того как relay/ архивируется и копируется на сервер, а не во время
// работы самого сервиса.

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(__dirname, '..', '..', 'docs');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FILES = ['index.html', 'privacy.html'];

function main() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  for (const name of FILES) {
    const src = path.join(DOCS_DIR, name);
    const dest = path.join(PUBLIC_DIR, name);
    fs.copyFileSync(src, dest);
    console.log(`docs/${name} -> relay/public/${name}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, FILES, DOCS_DIR, PUBLIC_DIR };
