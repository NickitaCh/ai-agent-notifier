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

// Единственный источник правды для хук-фрагментов каждого агента — и для
// печати сниппета, и для авто-мёрджа в install(). Раньше это были два
// независимых места (печать строила JSON руками), и они успели разойтись
// (печатный вариант потерял matcher/timeout, которые реально нужны).
function agentHookFragments(exePath) {
  const cmd = (args) => `"${exePath}" ${args}`;
  return [
    {
      agent: 'Claude Code',
      configPath: path.join(os.homedir(), '.claude', 'settings.json'),
      configLabel: '~/.claude/settings.json',
      hooksPatch: {
        PermissionRequest: [
          { matcher: '*', hooks: [{ type: 'command', command: cmd('notify permission'), timeout: 600 }] },
        ],
        Notification: [{ matcher: 'idle_prompt', hooks: [{ type: 'command', command: cmd('notify done') }] }],
      },
    },
    {
      agent: 'Cursor',
      configPath: path.join(os.homedir(), '.cursor', 'hooks.json'),
      configLabel: '~/.cursor/hooks.json',
      hooksPatch: {
        beforeShellExecution: [{ command: cmd('notify-cursor') }],
        beforeMCPExecution: [{ command: cmd('notify-cursor') }],
        stop: [{ command: cmd('notify-cursor') }],
      },
    },
  ];
}

// Событие считаем уже настроенным, если хоть один command в его текущем
// массиве групп указывает на этот же exe — иначе повторный запуск
// установщика (переустановка/апдейт) дублировал бы хук при каждом запуске.
function eventAlreadyPatched(existingGroups, exePath) {
  return (existingGroups || []).some((group) => {
    const commands = Array.isArray(group.hooks) ? group.hooks.map((h) => h.command) : [group.command];
    return commands.some((c) => typeof c === 'string' && c.includes(exePath));
  });
}

// Чистая функция: существующий конфиг агента (или undefined) + наш
// hooksPatch -> новый конфиг + список событий, куда реально что-то
// добавили. Трогает только "hooks.<событие>", остальные настройки агента
// (permissions, model и т.д.) переносятся как есть.
function mergeHooksConfig(existingConfig, hooksPatch, exePath) {
  const config = { ...(existingConfig && typeof existingConfig === 'object' ? existingConfig : {}) };
  const hooks = { ...(config.hooks || {}) };
  const added = [];
  for (const [eventName, groups] of Object.entries(hooksPatch)) {
    const current = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    if (eventAlreadyPatched(current, exePath)) continue;
    hooks[eventName] = [...current, ...groups];
    added.push(eventName);
  }
  config.hooks = hooks;
  return { config, added };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return { value: undefined, raw: undefined };
  const raw = fs.readFileSync(filePath, 'utf8');
  return { value: raw.trim() ? JSON.parse(raw) : {}, raw };
}

// Пытается вписать хуки в конфиг одного агента. Никогда не бросает — чужой
// файл с неожиданным содержимым не должен ронять весь install().
function tryAutoPatch(fragment, exePath) {
  const { configPath, configLabel } = fragment;
  let existing;
  try {
    existing = readJsonIfExists(configPath);
  } catch (err) {
    return `✗ ${configLabel}: не смог прочитать (${err.message}) — добавь вручную по сниппету ниже.`;
  }

  const { config, added } = mergeHooksConfig(existing.value, fragment.hooksPatch, exePath);
  if (!added.length) {
    return `= ${configLabel}: уже настроено, не трогал.`;
  }

  try {
    if (existing.raw !== undefined) {
      fs.writeFileSync(`${configPath}.bak`, existing.raw, 'utf8');
    } else {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch (err) {
    return `✗ ${configLabel}: не смог записать (${err.message}) — добавь вручную по сниппету ниже.`;
  }

  return existing.raw !== undefined
    ? `✓ ${configLabel}: хуки добавлены (бэкап исходника: ${path.basename(configPath)}.bak).`
    : `✓ ${configLabel}: файл создан с хуками.`;
}

function askYesNo(promptText, defaultYes) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed) return resolve(defaultYes);
      resolve(['y', 'yes', 'д', 'да'].includes(trimmed));
    });
  });
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

  const fragments = agentHookFragments(exePath);
  console.log('Осталось подключить хуки агента. Могу вписать их автоматически — правится только');
  console.log('секция "hooks" в конфиге, остальное не трогается, исходник сохраняется в .bak:\n');
  for (const fragment of fragments) {
    const yes = await askYesNo(`Добавить хуки ${fragment.agent} в ${fragment.configLabel}? [Y/n]: `, true);
    console.log(yes ? `  ${tryAutoPatch(fragment, exePath)}` : '  Пропущено — вставь вручную сниппет ниже.');
  }

  console.log('\nСниппеты для справки/ручной вставки (Copilot и Codex — только вручную, см. README):\n');
  for (const fragment of fragments) {
    console.log(`--- ${fragment.agent} — ${fragment.configLabel} (секция "hooks") ---`);
    console.log(JSON.stringify({ hooks: fragment.hooksPatch }, null, 2));
    console.log('');
  }

  await waitForEnter('Нажми Enter, чтобы закрыть это окно...');
}

module.exports = { install, computeExtensionId, installDir, mergeHooksConfig, agentHookFragments };
