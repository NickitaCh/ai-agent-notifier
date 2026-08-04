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

function projectLabel(cwd) {
  if (!cwd) return '';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return cwd;
  const last = parts[parts.length - 1];
  if (parts.length > 1 && GENERIC_FOLDER_NAMES.has(last.toLowerCase())) {
    return `${parts[parts.length - 2]}/${last}`;
  }
  return last;
}

function show(event, options = {}) {
  const isPermission = event.type === 'permission_request';
  // AskUserQuestion и подобные — это не "разрешить/отклонить", агент сам
  // показывает варианты ответа в терминале. Кнопки здесь не имеют смысла —
  // просто информируем, что нужно вернуться и ответить там.
  const isActionable = isPermission && event.needsDecision !== false;
  const project = projectLabel(event.cwd);

  let title;
  if (isActionable) title = 'Агент просит разрешение';
  else if (isPermission) title = 'Агент задал вопрос';
  else title = 'Агент закончил';
  title += project ? ` — ${project}` : '';

  let message;
  if (isPermission) message = event.summary || event.tool || 'требуется ваше внимание';
  else message = 'Задача завершена, ждёт вас';
  if (isPermission && !isActionable) message += ' — ответьте в терминале';

  const notifOptions = {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    requireInteraction: options.requireInteraction ?? isActionable,
    silent: options.silent ?? false,
  };
  if (isActionable) {
    notifOptions.buttons = [{ title: 'Разрешить' }, { title: 'Отклонить' }];
  }

  // event.id используем как notificationId, чтобы потом связать клик по
  // кнопке с конкретным ожидающим CLI-хуком на стороне демона.
  chrome.notifications.create(event.id, notifOptions);
}

self.NotificationChannel = { show };
