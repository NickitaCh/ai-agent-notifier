'use strict';

// Грубая имитация логики permissions Claude Code (~/.claude/settings.json +
// текущий permission_mode из хука), чтобы notify-agent не спамил
// уведомлением на действия, которые агент и так выполнит без вопроса. При
// любом сомнении решаем в пользу уведомления — лучше лишний раз спросить,
// чем промолчать про реальный запрос разрешения. В частности: "ask"-правила
// (точечные исключения поверх allow, например "Bash(rm*)") всегда
// перекрывают allow.
//
// Учитываются только глобальные ~/.claude/settings.json — локальные
// project-level настройки (.claude/settings.json в cwd проекта) пока не
// читаются (см. README, раздел "Известные ограничения").

const fs = require('fs');
const os = require('os');
const path = require('path');

// В этих режимах Claude Code вообще не спрашивает разрешения ни на что —
// см. документацию хуков (permission_mode в PreToolUse input).
const NO_PROMPT_MODES = new Set(['bypassPermissions', 'auto', 'dontAsk']);

// В режиме acceptEdits (Shift+Tab в терминале) автоматически принимаются
// только правки файлов — остальные инструменты (Bash и т.п.) по-прежнему
// могут спросить.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function loadClaudeSettings() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

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
function splitCommandSegments(command) {
  return command
    .split(/&&|\|\||[|;]/)
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

// claudeSettings — необязательный параметр только для тестов, чтобы не
// зависеть от реального ~/.claude/settings.json на диске. В проде всегда
// читается настоящий файл.
function isBlanketlyAllowed(toolName, toolInput, permissionMode, claudeSettings) {
  if (!toolName) return false;

  if (NO_PROMPT_MODES.has(permissionMode)) return true;
  if (permissionMode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return true;

  const settings = claudeSettings || loadClaudeSettings();
  const perms = settings.permissions || {};
  const askRules = perms.ask || [];
  const allowRules = perms.allow || [];

  if (askRules.some((r) => ruleMatches(r, toolName, toolInput))) return false;
  return allowRules.some((r) => ruleMatches(r, toolName, toolInput));
}

module.exports = {
  isBlanketlyAllowed,
  // Экспортировано дополнительно ради юнит-тестов на чистую логику
  // сопоставления правил, без похода на диск.
  ruleMatches,
  parseRule,
  globToRegExp,
};
