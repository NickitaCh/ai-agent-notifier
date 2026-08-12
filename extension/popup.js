'use strict';

// Открытие popup — сигнал «пользователь увидел», бейдж больше не нужен.
chrome.action.setBadgeText({ text: '' });

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const versionWarning = document.getElementById('versionWarning');
const log = document.getElementById('log');
const saveHint = document.getElementById('saveHint');
const snoozeProjectSelect = document.getElementById('snoozeProject');
const snoozeActiveList = document.getElementById('snoozeActiveList');
const permissionTimeoutInput = document.getElementById('permissionTimeoutSec');
const stopDebounceInput = document.getElementById('stopDebounceSec');
const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"][data-event]'));
const phoneProviderButtons = Array.from(document.querySelectorAll('#phoneProviderRow button[data-provider]'));
const phoneTestBtn = document.getElementById('phoneTest');
const phoneTestHint = document.getElementById('phoneTestHint');
const relayPairBtn = document.getElementById('relayPairBtn');
const relayPairStatus = document.getElementById('relayPairStatus');

// provider -> [[input id, ключ в settings.phone], ...] — источник и для
// рендера полей, и для навешивания change-хендлеров ниже.
const PHONE_FIELDS_BY_PROVIDER = {
  ntfy: [['phoneNtfyTopicUrl', 'ntfyTopicUrl']],
  webhook: [['phoneWebhookUrl', 'webhookUrl']],
  pushover: [
    ['phonePushoverToken', 'pushoverToken'],
    ['phonePushoverUserKey', 'pushoverUserKey'],
  ],
  telegram: [
    ['phoneTelegramBotToken', 'telegramBotToken'],
    ['phoneTelegramChatId', 'telegramChatId'],
  ],
};
const PHONE_CONTAINER_BY_PROVIDER = {
  ntfy: 'phoneFieldsNtfy',
  webhook: 'phoneFieldsWebhook',
  pushover: 'phoneFieldsPushover',
  telegram: 'phoneFieldsTelegram',
  relay: 'phoneFieldsRelay',
};

// Дубль константы из background.js — контексты разные, общего модуля нет
// (см. projectLabel ниже, та же причина).
const EXTENSION_PROTOCOL_VERSION = 1;

// cwd последних событий — источник списка проектов для выбора "не беспокоить".
let knownProjects = [];
// sessionId последних событий -> { agent, cwd } — источник списка сессий
// для ручного нейминга. Map, а не массив, — обновляется на каждый refresh,
// новые события по тому же sessionId просто перезаписывают запись.
let knownSessions = new Map();
let currentSessionNames = {};

// Дубль AGENT_LABELS/логики короткого id из
// extension/channels/notification-channel.js — тот же повод, что и для
// projectLabel (popup и background/notification-channel — разные контексты).
const AGENT_LABELS = { claude: 'Claude Code', cursor: 'Cursor', copilot: 'Copilot', codex: 'Codex' };
function shortSessionId(sessionId) {
  return sessionId ? sessionId.replace(/-/g, '').slice(0, 4) : '';
}
function autoSessionLabel(sessionId, info) {
  const agent = AGENT_LABELS[info.agent] || '';
  const project = projectLabel(info.cwd);
  const shortId = shortSessionId(sessionId);
  const place = project !== '(без папки)' ? project : (shortId ? `сессия ${shortId}` : '');
  const withId = place && shortId ? `${place} · ${shortId}` : place;
  return [agent, withId].filter(Boolean).join(' · ') || 'неизвестная сессия';
}

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Та же логика, что в extension/channels/notification-channel.js — тут не
// шарится напрямую (popup и background — разные контексты выполнения),
// поэтому небольшой дубль вместо общего модуля.
const GENERIC_FOLDER_NAMES = new Set(['src', 'host', 'app', 'bin', 'lib', 'server', 'client', 'backend', 'frontend', 'web', 'core', 'test', 'tests', 'dist', 'build']);
function projectLabel(cwd) {
  if (!cwd) return '(без папки)';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return cwd;
  const last = parts[parts.length - 1];
  if (parts.length > 1 && GENERIC_FOLDER_NAMES.has(last.toLowerCase())) {
    return `${parts[parts.length - 2]}/${last}`;
  }
  return last;
}

function populateProjectSelect() {
  const previous = snoozeProjectSelect.value;
  snoozeProjectSelect.innerHTML = '';
  if (!knownProjects.length) {
    const opt = document.createElement('option');
    opt.textContent = 'нет недавних проектов';
    opt.disabled = true;
    snoozeProjectSelect.appendChild(opt);
    return;
  }
  for (const cwd of knownProjects) {
    const opt = document.createElement('option');
    opt.value = cwd;
    opt.textContent = projectLabel(cwd);
    snoozeProjectSelect.appendChild(opt);
  }
  if (knownProjects.includes(previous)) snoozeProjectSelect.value = previous;
}

function renderActiveSnoozes(snoozeByProject) {
  snoozeActiveList.innerHTML = '';
  const entries = Object.entries(snoozeByProject || {}).filter(([, until]) => until > Date.now());
  if (!entries.length) return;
  for (const [cwd, until] of entries) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'proj';
    label.textContent = `${projectLabel(cwd)} — до ${formatTime(until)}`;
    label.title = cwd;
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'отключить';
    cancelBtn.addEventListener('click', () => patchSettings({ snoozeByProject: { [cwd]: null } }));
    li.append(label, cancelBtn);
    snoozeActiveList.appendChild(li);
  }
}

const sessionsList = document.getElementById('sessionsList');

function renderSessionsList() {
  sessionsList.innerHTML = '';
  if (!knownSessions.size) {
    sessionsList.innerHTML = '<li class="empty">нет недавних сессий</li>';
    return;
  }
  for (const [sessionId, info] of knownSessions) {
    const li = document.createElement('li');

    const auto = document.createElement('span');
    auto.className = 'auto-label';
    auto.textContent = autoSessionLabel(sessionId, info);
    auto.title = info.cwd || '';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'своё имя для этой сессии…';
    input.value = currentSessionNames[sessionId] || '';
    input.addEventListener('change', () => {
      patchSettings({ sessionNames: { [sessionId]: input.value.trim() || null } });
    });

    li.append(auto, input);
    sessionsList.appendChild(li);
  }
}

function showSaveHint(text) {
  saveHint.textContent = text;
  saveHint.classList.add('show');
  setTimeout(() => saveHint.classList.remove('show'), 2000);
}

function renderPhoneSettings(phone = {}) {
  const provider = phone.provider || 'none';
  for (const btn of phoneProviderButtons) {
    btn.classList.toggle('active', btn.dataset.provider === provider);
  }

  for (const [providerName, containerId] of Object.entries(PHONE_CONTAINER_BY_PROVIDER)) {
    document.getElementById(containerId).classList.toggle('show', providerName === provider);
  }
  for (const fields of Object.values(PHONE_FIELDS_BY_PROVIDER)) {
    for (const [inputId, key] of fields) {
      document.getElementById(inputId).value = phone[key] || '';
    }
  }

  // Дефолт — включено, поэтому проверяем именно на !== false: у юзера,
  // настроившего relay до появления тумблера, поля в settings нет вовсе.
  document.getElementById('phoneRelayMetrics').checked = phone.relayMetrics !== false;

  if (phone.relayToken) {
    relayPairStatus.textContent = 'Привязано ✓';
    relayPairBtn.textContent = 'Привязать заново';
  } else {
    relayPairStatus.textContent = '';
    relayPairBtn.textContent = 'Привязать через бота';
  }
}

function renderSettings(settings) {
  if (!settings) {
    showSaveHint('нет связи с host');
    return;
  }

  const rules = settings.rules || {};
  for (const cb of checkboxes) {
    const channels = rules[cb.dataset.event] || [];
    cb.checked = channels.includes(cb.dataset.channel);
  }

  permissionTimeoutInput.value = Math.round((settings.permissionTimeoutMs ?? 60000) / 1000);
  stopDebounceInput.value = Math.round((settings.stopDebounceMs ?? 20000) / 1000);

  renderActiveSnoozes(settings.snoozeByProject);
  renderPhoneSettings(settings.phone);

  currentSessionNames = settings.sessionNames || {};
  renderSessionsList();
}

async function loadSettings() {
  const res = await sendMessage({ type: 'get_settings' });
  renderSettings(res?.settings);
}

async function patchSettings(patch) {
  const res = await sendMessage({ type: 'update_settings', patch });
  if (res?.settings) {
    renderSettings(res.settings);
    showSaveHint('Сохранено');
  } else {
    showSaveHint('Не удалось сохранить — нет связи с host');
  }
}

for (const cb of checkboxes) {
  cb.addEventListener('change', () => {
    const eventName = cb.dataset.event;
    const rowChannels = checkboxes
      .filter((c) => c.dataset.event === eventName && c.checked)
      .map((c) => c.dataset.channel);
    patchSettings({ rules: { [eventName]: rowChannels } });
  });
}

permissionTimeoutInput.addEventListener('change', () => {
  const sec = Math.max(5, Number(permissionTimeoutInput.value) || 60);
  patchSettings({ permissionTimeoutMs: sec * 1000 });
});

stopDebounceInput.addEventListener('change', () => {
  const sec = Math.max(0, Number(stopDebounceInput.value) || 0);
  patchSettings({ stopDebounceMs: sec * 1000 });
});

for (const btn of phoneProviderButtons) {
  btn.addEventListener('click', () => {
    patchSettings({ phone: { provider: btn.dataset.provider } });
  });
}

for (const fields of Object.values(PHONE_FIELDS_BY_PROVIDER)) {
  for (const [inputId, key] of fields) {
    document.getElementById(inputId).addEventListener('change', (e) => {
      patchSettings({ phone: { [key]: e.target.value.trim() } });
    });
  }
}

// Не в PHONE_FIELDS_BY_PROVIDER: там текстовые поля со .value, а тут флажок
// с .checked — общий цикл выше пришлось бы разветвлять по типу инпута ради
// одного элемента.
document.getElementById('phoneRelayMetrics').addEventListener('change', (e) => {
  patchSettings({ phone: { relayMetrics: e.target.checked } });
});

phoneTestBtn.addEventListener('click', async () => {
  phoneTestBtn.disabled = true;
  phoneTestHint.textContent = 'отправляю…';
  phoneTestHint.classList.remove('show');
  const res = await sendMessage({ type: 'test_phone' });
  phoneTestBtn.disabled = false;
  phoneTestHint.textContent = res?.ok ? 'Отправлено ✓' : `Не удалось${res?.error ? `: ${res.error}` : ''}`;
  if (res?.ok) phoneTestHint.classList.add('show');
  setTimeout(() => phoneTestHint.classList.remove('show'), 4000);
});

// Ожидание подтверждения от Telegram живёт в background.js, не здесь: попап
// закрывается сразу же, как только теряет фокус — что и происходит, когда
// chrome.tabs.create ниже открывает вкладку Telegram. background переживает
// закрытие попапа (service worker, не документ попапа) и сам допишет токен
// в настройки, когда relay его выдаст; заодно покажет системное уведомление.
//
// Пока идёт привязка, кнопка здесь только отражает состояние background
// (через get_pair_status) и заблокирована — раньше при повторном открытии
// попапа кнопка снова выглядела как "Привязать через бота" (сам попап не
// знал о фоновом ожидании), что провоцировало повторные клики и лишние
// коды пейринга, пока первый ещё обрабатывался.
let pairingPollTimer = null;

async function pollPairingWhileOpen() {
  clearTimeout(pairingPollTimer);
  const res = await sendMessage({ type: 'get_pair_status' });
  if (res?.pending) {
    relayPairBtn.disabled = true;
    relayPairBtn.textContent = 'Привязывается…';
    relayPairStatus.textContent = 'ждём подтверждения в Telegram… (попап можно закрыть, придёт уведомление)';
    pairingPollTimer = setTimeout(pollPairingWhileOpen, 1500);
  } else {
    relayPairBtn.disabled = false;
    await loadSettings(); // подхватить итог: relayToken, если уже привязалось, либо исходный текст кнопки
  }
}

relayPairBtn.addEventListener('click', async () => {
  relayPairBtn.disabled = true;
  relayPairStatus.textContent = 'открываю Telegram…';
  const start = await sendMessage({ type: 'relay_pair_start' });
  if (!start?.ok) {
    relayPairBtn.disabled = false;
    relayPairStatus.textContent = `Не удалось начать привязку${start?.error ? `: ${start.error}` : ''}`;
    return;
  }
  chrome.tabs.create({ url: start.deepLink });
  pollPairingWhileOpen();
});

for (const btn of document.querySelectorAll('button[data-snooze]')) {
  btn.addEventListener('click', () => {
    const cwd = snoozeProjectSelect.value;
    if (!cwd) return;
    const minutes = Number(btn.dataset.snooze);
    patchSettings({ snoozeByProject: { [cwd]: Date.now() + minutes * 60000 } });
  });
}

async function refreshStatus() {
  const res = await sendMessage({ type: 'get_status' });
  if (!res) {
    statusText.textContent = 'нет ответа от фонового процесса';
    document.body.classList.add('disconnected');
    return null;
  }

  dot.classList.toggle('on', res.connected);
  statusText.textContent = res.connected ? 'подключено к host' : 'нет связи с host';
  document.body.classList.toggle('disconnected', !res.connected);

  if (res.hostInfo?.mismatch) {
    versionWarning.textContent =
      `Версии расширения (протокол ${EXTENSION_PROTOCOL_VERSION}) и host-процесса ` +
      `(протокол ${res.hostInfo.protocolVersion}, версия ${res.hostInfo.hostVersion}) разошлись — ` +
      `обновите обе стороны до последней версии (см. README).`;
    versionWarning.classList.add('show');
  } else {
    versionWarning.classList.remove('show');
  }

  log.innerHTML = '';
  if (!res.lastEvents.length) {
    log.innerHTML = '<li>событий пока не было</li>';
  } else {
    for (const item of res.lastEvents) {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = formatTime(item.receivedAt);
      const desc = document.createElement('span');
      desc.textContent = `${item.kind}: ${item.event?.summary || item.event?.tool || item.event?.type || ''}`;
      li.append(time, desc);
      log.appendChild(li);
    }
  }

  // Проекты для выбора в "не беспокоить" — уникальные cwd из недавних событий.
  const seen = new Set();
  knownProjects = [];
  for (const item of res.lastEvents) {
    const cwd = item.event?.cwd;
    if (cwd && !seen.has(cwd)) {
      seen.add(cwd);
      knownProjects.push(cwd);
    }
  }
  populateProjectSelect();

  // Сессии для ручного нейминга — тоже из недавних событий, самое свежее
  // событие по sessionId выигрывает (res.lastEvents уже отсортирован
  // от нового к старому, см. background.js).
  knownSessions = new Map();
  for (const item of res.lastEvents) {
    const sessionId = item.event?.sessionId;
    if (sessionId && !knownSessions.has(sessionId)) {
      knownSessions.set(sessionId, { agent: item.event?.agent, cwd: item.event?.cwd });
    }
  }
  renderSessionsList();

  return res;
}

document.getElementById('openWelcome').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

const checkAgainBtn = document.getElementById('checkAgain');
const checkAgainHint = document.getElementById('checkAgainHint');
checkAgainBtn.addEventListener('click', async () => {
  checkAgainBtn.disabled = true;
  checkAgainHint.textContent = 'проверяю…';
  const res = await refreshStatus();
  checkAgainBtn.disabled = false;
  checkAgainHint.textContent = res?.connected ? '' : 'по-прежнему нет связи';
  if (res?.connected) loadSettings();
});

async function buildDiagnostics() {
  const [status, diag] = await Promise.all([
    sendMessage({ type: 'get_status' }),
    sendMessage({ type: 'get_diagnostics' }),
  ]);

  const report = [
    `AI Agent Notifier — диагностика`,
    `Время: ${new Date().toISOString()}`,
    `Версия расширения: ${chrome.runtime.getManifest().version}`,
    `Платформа: ${navigator.userAgent}`,
    `Подключено к host: ${status?.connected ? 'да' : 'нет'}`,
    ``,
    `--- Последние события (popup) ---`,
    JSON.stringify(status?.lastEvents ?? [], null, 2),
    ``,
    `--- Хвост daemon.log ---`,
    diag?.logTail || '(недоступно)',
  ].join('\n');

  return { report, connected: !!status?.connected };
}

document.getElementById('reportIssue').addEventListener('click', async () => {
  const btn = document.getElementById('reportIssue');
  const originalText = btn.textContent;
  const { report } = await buildDiagnostics();

  try {
    await navigator.clipboard.writeText(report);
    btn.textContent = 'Скопировано ✓';
  } catch {
    btn.textContent = 'Не удалось скопировать';
  }
  setTimeout(() => (btn.textContent = originalText), 2000);
});

const ISSUE_URL = 'https://github.com/NickitaCh/ai-agent-notifier/issues/new';

// Хвост daemon.log в URL не влезает (у гитхаба практический потолок в
// несколько килобайт на query string, а лог легко больше), поэтому короткую
// часть кладём в тело issue, а полную диагностику — в буфер обмена, и просим
// вставить. Один клик вместо "сначала нажмите одну кнопку, потом другую".
function buildIssueBody({ connected }) {
  return [
    '<!-- Опишите, что произошло и что вы ожидали увидеть -->',
    '',
    '',
    '### Окружение',
    `- Версия расширения: ${chrome.runtime.getManifest().version}`,
    `- Платформа: ${navigator.userAgent}`,
    `- Связь с компаньоном: ${connected ? 'есть' : 'нет'}`,
    '',
    '### Диагностика',
    '<!-- Полная диагностика уже скопирована в буфер обмена — вставьте её сюда (Ctrl+V) -->',
    '',
  ].join('\n');
}

document.getElementById('sendFeedback').addEventListener('click', async () => {
  const hint = document.getElementById('feedbackHint');
  hint.textContent = 'готовлю…';
  const { report, connected } = await buildDiagnostics();

  // Порядок важен: clipboard.writeText обязан завершиться ДО tabs.create.
  // Новая активная вкладка забирает фокус, попап тут же закрывается, и всё
  // незавершённое в этом контексте просто перестаёт существовать (та же
  // грабля, что была в пейринге — см. комментарий у relayPairBtn).
  let copied = true;
  try {
    await navigator.clipboard.writeText(report);
  } catch {
    copied = false;
  }

  const url = `${ISSUE_URL}?template=bug_report.md&body=${encodeURIComponent(buildIssueBody({ connected }))}`;
  hint.textContent = copied
    ? 'диагностика в буфере — вставьте её в issue'
    : 'не удалось скопировать диагностику, опишите проблему словами';
  chrome.tabs.create({ url });
});

refreshStatus().then(loadSettings).then(pollPairingWhileOpen);
