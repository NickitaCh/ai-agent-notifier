'use strict';

// isBlanketlyAllowed сейчас проверяет только режимы, в которых Claude Code
// АРХИТЕКТУРНО не спрашивает разрешения ни на что (bypassPermissions/auto/
// dontAsk) или только на конкретный класс инструментов (acceptEdits — но
// лишь Edit/Write/…). Раньше здесь ещё была своя имитация правил
// permissions.ask/allow из ~/.claude/settings.json — убрана намеренно
// (см. ниже), это НЕ откат, а осознанное сужение.
//
// Почему: PermissionRequest-хук (в отличие от старого PreToolUse) сам по
// себе стреляет только тогда, когда Claude Code уже решил, что решение
// пользователя реально нужно — переигрывать это решение своей копией
// ask/allow-правил избыточно, когда совпадает, и опасно, когда не
// совпадает. На практике не совпало дважды: составная Bash-команда внутри
// широкого allow-правила и mkdir по пути внутри allow-правила, который
// Claude Code отдельно пометил как "чувствительный путь" (эту проверку
// правил ask/allow не покрывает вообще, она из другого источника). Оба
// раза это тихо гасило настоящий запрос на решение. Правило проекта:
// при сомнении — уведомить, а не промолчать; эта имитация чаще молчала
// неправильно, чем ловила гипотетический ложный хук.
//
// ruleMatches/parseRule/globToRegExp ниже — обычные глоб-утилиты,
// оставлены и протестированы, но isBlanketlyAllowed их больше не вызывает.

// В этих режимах Claude Code вообще не спрашивает разрешения ни на что —
// см. документацию хуков (permission_mode в PreToolUse input).
const NO_PROMPT_MODES = new Set(['bypassPermissions', 'auto', 'dontAsk']);

// В режиме acceptEdits (Shift+Tab в терминале) автоматически принимаются
// только правки файлов — остальные инструменты (Bash и т.п.) по-прежнему
// могут спросить.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// "Bash(rm*)" -> { tool: "Bash", arg: "rm*" }; "Bash" -> { tool: "Bash", arg: null }
function parseRule(rule) {
  const m = /^([^(]+)(?:\((.*)\))?$/.exec(rule);
  if (!m) return null;
  return { tool: m[1], arg: m[2] ?? null };
}

// Составная shell-команда вроде "cd x && rm -f y && python ..." раньше
// проверялась ТОЛЬКО целиком, одним anchored-регэкспом (^rm.*$) — и такой
// паттерн у "Bash(rm*)" не матчил ничего, если rm не в самом начале строки.
// Реальный Claude Code это ловит (мы это увидели по факту — он спросил
// подтверждение, а наша имитация — нет), значит и нам нужно проверять не
// только всю строку, но и отдельные под-команды. Это эвристика (не полный
// shell-парсер, не различает && внутри кавычек/скобок), но закрывает
// основной практический случай.
//
// Перевод строки — тоже разделитель команд: многострочный tool_input.command
// (несколько шагов одним вызовом Bash, без && между ними) — обычное дело,
// и настоящий Claude Code разбирает такие строки построчно (снова поймано
// по факту: реальный запрос на подтверждение rm на второй строке многошагового
// вызова, а наша имитация без \n в регэкспе его не увидела).
function splitCommandSegments(command) {
  return command
    .split(/&&|\|\||[|;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function subjectsFor(toolInput) {
  if (!toolInput) return [''];
  if (typeof toolInput.command === 'string') {
    return [toolInput.command, ...splitCommandSegments(toolInput.command)];
  }
  if (typeof toolInput.file_path === 'string') return [toolInput.file_path];
  return [JSON.stringify(toolInput)];
}

function ruleMatches(rule, toolName, toolInput) {
  const parsed = parseRule(rule);
  if (!parsed) return false;
  if (!globToRegExp(parsed.tool).test(toolName)) return false;
  if (parsed.arg === null) return true; // безусловное правило на весь инструмент
  const pattern = globToRegExp(parsed.arg);
  return subjectsFor(toolInput).some((subject) => pattern.test(subject));
}

function isBlanketlyAllowed(toolName, toolInput, permissionMode) {
  if (!toolName) return false;

  if (NO_PROMPT_MODES.has(permissionMode)) return true;
  if (permissionMode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return true;

  return false;
}

module.exports = {
  isBlanketlyAllowed,
  // Экспортировано дополнительно ради юнит-тестов на чистую логику
  // сопоставления правил, без похода на диск.
  ruleMatches,
  parseRule,
  globToRegExp,
};
