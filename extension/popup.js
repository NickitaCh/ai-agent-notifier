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
  const noFolder = t('project.noFolder');
  const place = project !== noFolder ? project : (shortId ? t('session.shortLabel', { id: shortId }) : '');
  const withId = place && shortId ? `${place} · ${shortId}` : place;
  return [agent, withId].filter(Boolean).join(' · ') || t('session.unknown');
}

// Короткий псевдоним — t() встречается в этом файле десятки раз.
const t = (key, params) => self.I18n.t(key, params);

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
  if (!cwd) return t('project.noFolder');
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
    opt.textContent = t('snooze.noProjects');
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
    label.textContent = t('snooze.activeUntil', { project: projectLabel(cwd), time: formatTime(until) });
    label.title = cwd;
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('snooze.cancel');
    cancelBtn.addEventListener('click', () => patchSettings({ snoozeByProject: { [cwd]: null } }));
    li.append(label, cancelBtn);
    snoozeActiveList.appendChild(li);
  }
}

const sessionsList = document.getElementById('sessionsList');

function renderSessionsList() {
  sessionsList.innerHTML = '';
  if (!knownSessions.size) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = t('sessions.empty');
    sessionsList.appendChild(empty);
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
    input.placeholder = t('sessions.namePlaceholder');
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
    relayPairStatus.textContent = t('phone.paired');
    relayPairBtn.textContent = t('phone.pairAgain');
  } else {
    relayPairStatus.textContent = '';
    relayPairBtn.textContent = t('phone.pairButton');
  }
}

function renderSettings(settings) {
  if (!settings) {
    showSaveHint(t('status.disconnected'));
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
    showSaveHint(t('settings.saved'));
  } else {
    showSaveHint(t('settings.saveFailed'));
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
  phoneTestHint.textContent = t('phone.testSending');
  phoneTestHint.classList.remove('show');
  const res = await sendMessage({ type: 'test_phone' });
  phoneTestBtn.disabled = false;
  phoneTestHint.textContent = res?.ok
    ? t('phone.testSent')
    : `${t('phone.testFailed')}${res?.error ? `: ${res.error}` : ''}`;
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
    relayPairBtn.textContent = t('phone.pairing');
    relayPairStatus.textContent = t('phone.pairWaiting');
    pairingPollTimer = setTimeout(pollPairingWhileOpen, 1500);
  } else {
    relayPairBtn.disabled = false;
    await loadSettings(); // подхватить итог: relayToken, если уже привязалось, либо исходный текст кнопки
  }
}

relayPairBtn.addEventListener('click', async () => {
  relayPairBtn.disabled = true;
  relayPairStatus.textContent = t('phone.pairOpening');
  const start = await sendMessage({ type: 'relay_pair_start' });
  if (!start?.ok) {
    relayPairBtn.disabled = false;
    relayPairStatus.textContent = `${t('phone.pairStartFailed')}${start?.error ? `: ${start.error}` : ''}`;
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
    statusText.textContent = t('status.noBackground');
    document.body.classList.add('disconnected');
    return null;
  }

  dot.classList.toggle('on', res.connected);
  statusText.textContent = res.connected ? t('status.connected') : t('status.disconnected');
  document.body.classList.toggle('disconnected', !res.connected);

  if (res.hostInfo?.mismatch) {
    versionWarning.textContent = t('version.mismatch', {
      extProtocol: EXTENSION_PROTOCOL_VERSION,
      hostProtocol: res.hostInfo.protocolVersion,
      hostVersion: res.hostInfo.hostVersion,
    });
    versionWarning.classList.add('show');
  } else {
    versionWarning.classList.remove('show');
  }

  log.innerHTML = '';
  if (!res.lastEvents.length) {
    const empty = document.createElement('li');
    empty.textContent = t('log.empty');
    log.appendChild(empty);
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
  checkAgainHint.textContent = t('onboarding.checking');
  const res = await refreshStatus();
  checkAgainBtn.disabled = false;
  checkAgainHint.textContent = res?.connected ? '' : t('onboarding.stillNoLink');
  if (res?.connected) loadSettings();
});

// Сам текст диагностики и тело issue НЕ локализуются — намеренно. Это
// технический артефакт, который читает мейнтейнер в трекере, а не интерфейс
// для юзера: единый английский формат означает, что issue от испанского и
// русского юзера выглядят одинаково и ищутся одним запросом. Локализованы
// только надписи на кнопках и подсказки вокруг них.
async function buildDiagnostics() {
  const [status, diag] = await Promise.all([
    sendMessage({ type: 'get_status' }),
    sendMessage({ type: 'get_diagnostics' }),
  ]);

  const report = [
    `AI Agent Notifier — diagnostics`,
    `Time: ${new Date().toISOString()}`,
    `Extension version: ${chrome.runtime.getManifest().version}`,
    `UI language: ${self.I18n.current()}`,
    `Platform: ${navigator.userAgent}`,
    `Connected to host: ${status?.connected ? 'yes' : 'no'}`,
    ``,
    `--- Recent events (popup) ---`,
    JSON.stringify(status?.lastEvents ?? [], null, 2),
    ``,
    `--- daemon.log tail ---`,
    diag?.logTail || '(unavailable)',
  ].join('\n');

  return { report, connected: !!status?.connected };
}

document.getElementById('reportIssue').addEventListener('click', async () => {
  const btn = document.getElementById('reportIssue');
  const originalText = btn.textContent;
  const { report } = await buildDiagnostics();

  try {
    await navigator.clipboard.writeText(report);
    btn.textContent = t('report.copied');
  } catch {
    btn.textContent = t('report.copyFailed');
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
    '<!-- Describe what happened and what you expected -->',
    '',
    '',
    '### Environment',
    `- Extension version: ${chrome.runtime.getManifest().version}`,
    `- UI language: ${self.I18n.current()}`,
    `- Platform: ${navigator.userAgent}`,
    `- Companion connected: ${connected ? 'yes' : 'no'}`,
    '',
    '### Diagnostics',
    '<!-- Full diagnostics are already in your clipboard — paste them here (Ctrl+V) -->',
    '',
  ].join('\n');
}

document.getElementById('sendFeedback').addEventListener('click', async () => {
  const hint = document.getElementById('feedbackHint');
  hint.textContent = t('feedback.preparing');
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
  hint.textContent = copied ? t('feedback.copiedHint') : t('feedback.copyFailedHint');
  chrome.tabs.create({ url });
});

// --- язык -----------------------------------------------------------------

const langButtons = Array.from(document.querySelectorAll('#langRow button[data-locale]'));

function renderLangChips() {
  const active = self.I18n.current();
  for (const btn of langButtons) btn.classList.toggle('active', btn.dataset.locale === active);
}

// Перерисовываем всё, что построено из строк: статические надписи через
// apply(), динамические — повторным рендером. Иначе половина попапа
// осталась бы на старом языке до переоткрытия.
async function applyLocale(locale) {
  await self.I18n.use(locale);
  self.I18n.apply(document);
  renderLangChips();
  await refreshStatus();
  await loadSettings();
}

for (const btn of langButtons) {
  btn.addEventListener('click', async () => {
    const locale = btn.dataset.locale;
    // Зеркало в storage — чтобы попап открывался сразу на нужном языке,
    // не дожидаясь ответа демона (и работал, когда демона нет вовсе).
    await chrome.storage.local.set({ locale });
    await applyLocale(locale);
    // И в настройки демона — оттуда язык берут хост (сообщения на телефон)
    // и relay (ответы бота). Без этого попап переключился бы, а уведомления
    // продолжали приходить на старом языке.
    patchSettings({ locale });
  });
}

async function init() {
  const stored = await chrome.storage.local.get('locale');
  // Первый запуск: языка ещё нет — берём язык интерфейса браузера.
  // Дальше он живёт в storage и меняется только переключателем выше.
  const locale = stored.locale || self.I18n.detect();
  if (!stored.locale) await chrome.storage.local.set({ locale });

  await self.I18n.use(locale);
  self.I18n.apply(document);
  renderLangChips();
  statusText.textContent = t('status.checking');

  await refreshStatus();
  await loadSettings();
  await pollPairingWhileOpen();
}

init();
