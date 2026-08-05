'use strict';

// Устанавливает расширение + native host из ОДНОГО exe, без Node.js на
// целевой машине и без ручного копирования EXTENSION_ID. Запускается по
// умолчанию при простом двойном клике по ai-agent-notifier.exe (см.
// bin/aan.js: команда не указана -> install()).
//
// Три шага, которые Chrome НЕЛЬЗЯ автоматизировать программно (осознанное
// ограничение самого Chrome против тихой установки расширений) остаются
// ручными: включить Developer mode, нажать "Load unpacked", выбрать папку.
// Всё остальное — распаковка файлов расширения, вычисление его ID,
// регистрация native messaging host — делается само.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const readline = require('readline');

const { files } = require('./embedded-extension');
const registerStandalone = require('../install/register-standalone');

function installDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'AI Agent Notifier', 'extension');
}

function extractFiles(targetDir) {
  for (const [rel, file] of Object.entries(files)) {
    const dest = path.join(targetDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (file.encoding === 'base64') {
      fs.writeFileSync(dest, Buffer.from(file.content, 'base64'));
    } else {
      fs.writeFileSync(dest, file.content, 'utf8');
    }
  }
}

// Chrome вычисляет ID unpacked-расширения с манифестом, где задан "key",
// одинаково для любого пути на диске: SHA-256 публичного ключа, первые 16
// байт, каждый ниббл (0-15) -> буква a-p. Тот же алгоритм, что и для ID
// упакованных .crx с тем же ключом — поэтому ID не изменится и после
// публикации с этим же ключом. Даёт нам ID заранее, без похода в
// chrome://extensions за копированием строки.
function computeExtensionId(manifestJson) {
  const manifest = JSON.parse(manifestJson);
  const keyBuf = Buffer.from(manifest.key, 'base64');
  const hash = crypto.createHash('sha256').update(keyBuf).digest();
  return hash
    .subarray(0, 16)
    .toString('hex')
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

function openInBackground(command, args) {
  try {
    execFile(command, args, { windowsHide: false });
  } catch {
    // необязательный шаг для удобства — если не открылось само,
    // человек откроет вручную по инструкции ниже
  }
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

function hookSnippets(exePath) {
  const p = exePath.replace(/\\/g, '\\\\');
  return [
    [
      'Claude Code — ~/.claude/settings.json (секция "hooks")',
      `{
  "hooks": {
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "\\"${p}\\" notify permission" }] }],
    "Notification": [{ "matcher": "idle_prompt", "hooks": [{ "type": "command", "command": "\\"${p}\\" notify done" }] }]
  }
}`,
    ],
    [
      'Cursor — .cursor/hooks.json',
      `{
  "hooks": {
    "beforeShellExecution": [{ "command": "\\"${p}\\" notify-cursor" }],
    "beforeMCPExecution": [{ "command": "\\"${p}\\" notify-cursor" }],
    "stop": [{ "command": "\\"${p}\\" notify-cursor" }]
  }
}`,
    ],
  ];
}

async function install() {
  const exePath = process.execPath;
  const targetDir = installDir();

  console.log('AI Agent Notifier — установка\n');

  extractFiles(targetDir);
  console.log(`[1/3] Файлы расширения распакованы:\n      ${targetDir}`);

  const extensionId = computeExtensionId(files['manifest.json'].content);
  console.log(`[2/3] ID расширения вычислен заранее: ${extensionId}`);

  try {
    registerStandalone.registerQuiet(extensionId, 'chrome');
    console.log('[3/3] Native messaging host зарегистрирован (Chrome).');
  } catch (err) {
    console.log(`[3/3] Не удалось зарегистрировать host автоматически: ${err.message}`);
    console.log(`      Повторить вручную: "${exePath}" register ${extensionId}`);
  }

  console.log('\nОсталось два клика — их Chrome не даёт сделать программно:\n');
  console.log('  1. Открой chrome://extensions, включи Developer mode (правый верхний угол).');
  console.log(`  2. «Load unpacked» -> выбери папку (уже открыта в проводнике):\n     ${targetDir}\n`);

  openInBackground('cmd', ['/c', 'start', '', 'chrome://extensions']);
  openInBackground('explorer.exe', [targetDir]);

  console.log('После этого расширение готово к работе — демон запустится сам при первом событии.\n');
  console.log('Подключи хуки своего агента (вставь в его конфиг, путь уже подставлен):\n');
  for (const [title, snippet] of hookSnippets(exePath)) {
    console.log(`--- ${title} ---`);
    console.log(snippet);
    console.log('');
  }

  await waitForEnter('Нажми Enter, чтобы закрыть это окно...');
}

module.exports = { install, computeExtensionId, installDir };
