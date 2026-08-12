'use strict';

// Канал 2: chrome.notifications — основной канал, пробивает alt-tab.
// Для permission_request добавляем кнопки Разрешить/Отклонить; клики
// обрабатываются в background.js (там же, где notificationId связывается
// с event.id для ответа демону).

// Хуки в ~/.claude/settings.json глобальные — цепляют вообще все сессии
// Claude Code на машине, не только одну. Показываем папку проекта в
// заголовке, чтобы можно было понять, из какой сессии пришло уведомление.
// Последний сегмент пути часто бесполезен как ярлык ("src", "host", "app") —
// в таком случае добавляем ещё и родительскую папку для контекста.
const GENERIC_FOLDER_NAMES = new Set(['src', 'host', 'app', 'bin', 'lib', 'server', 'client', 'backend', 'frontend', 'web', 'core', 'test', 'tests', 'dist', 'build']);
// Папки, из которых имя проекта извлечь нельзя (домашний каталог и т.п.) —
// в этом случае считаем cwd неинформативным и не показываем его вовсе,
// вместо бесполезного "Nick"/"Users".
const UNINFORMATIVE_LEAF_NAMES = new Set(['nick', 'users', 'home', 'desktop', 'documents', 'downloads']);

const AGENT_LABELS = { claude: 'Claude Code', cursor: 'Cursor', copilot: 'Copilot', codex: 'Codex' };

function projectLabel(cwd) {
  if (!cwd) return '';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return cwd;
  const last = parts[parts.length - 1];
  if (UNINFORMATIVE_LEAF_NAMES.has(last.toLowerCase())) return '';
  if (parts.length > 1 && GENERIC_FOLDER_NAMES.has(last.toLowerCase())) {
    return `${parts[parts.length - 2]}/${last}`;
  }
  return last;
}

// Несколько сессий одного агента могут крутиться в одном и том же проекте
// одновременно — метка по cwd их не различает, поэтому к автоматической
// метке всегда добавляется короткий суффикс sessionId. Ручное имя из
// popup (event.sessionLabel, см. router.js) полностью его заменяет —
// раз пользователь сам назвал сессию, ему не нужен технический суффикс.
function sessionDisplayLabel(event) {
  if (event.sessionLabel) return event.sessionLabel;

  const agent = AGENT_LABELS[event.agent] || '';
  const project = projectLabel(event.cwd);
  const shortId = event.sessionId ? event.sessionId.replace(/-/g, '').slice(0, 4) : '';

  const place = project || (shortId ? self.I18n.t('session.shortLabel', { id: shortId }) : '');
  const withId = project && shortId ? `${place} · ${shortId}` : place;

  return [agent, withId].filter(Boolean).join(' · ');
}

function show(event, options = {}) {
  const isPermission = event.type === 'permission_request';
  // AskUserQuestion и подобные — это не "разрешить/отклонить", агент сам
  // показывает варианты ответа в терминале. Кнопки здесь не имеют смысла —
  // просто информируем, что нужно вернуться и ответить там.
  const isActionable = isPermission && event.needsDecision !== false;
  const label = sessionDisplayLabel(event);

  const t = (key, params) => self.I18n.t(key, params);

  let title;
  if (isActionable) title = t('event.titlePermission');
  else if (isPermission) title = t('event.titleQuestion');
  else title = t('event.titleDone');
  title += label ? ` — ${label}` : '';

  let message;
  if (isPermission) message = event.summary || event.tool || t('event.needsAttention');
  else message = t('event.bodyDone');
  if (isPermission && !isActionable) message += t('event.answerInTerminal');

  const notifOptions = {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    requireInteraction: options.requireInteraction ?? isActionable,
    silent: options.silent ?? false,
  };
  if (isActionable) {
    notifOptions.buttons = [{ title: t('event.allow') }, { title: t('event.deny') }];
  }

  // event.id используем как notificationId, чтобы потом связать клик по
  // кнопке с конкретным ожидающим CLI-хуком на стороне демона.
  chrome.notifications.create(event.id, notifOptions);
}

self.NotificationChannel = { show };
