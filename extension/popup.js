'use strict';

// Открытие popup — сигнал «пользователь увидел», бейдж больше не нужен.
chrome.action.setBadgeText({ text: '' });

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const log = document.getElementById('log');
const saveHint = document.getElementById('saveHint');
const snoozeProjectSelect = document.getElementById('snoozeProject');
const snoozeActiveList = document.getElementById('snoozeActiveList');
const permissionTimeoutInput = document.getElementById('permissionTimeoutSec');
const stopDebounceInput = document.getElementById('stopDebounceSec');
const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"][data-event]'));

// cwd последних событий — источник списка проектов для выбора "не беспокоить".
let knownProjects = [];

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

function showSaveHint(text) {
  saveHint.textContent = text;
  saveHint.classList.add('show');
  setTimeout(() => saveHint.classList.remove('show'), 2000);
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

  return res;
}

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

document.getElementById('reportIssue').addEventListener('click', async () => {
  const btn = document.getElementById('reportIssue');
  const originalText = btn.textContent;
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

  try {
    await navigator.clipboard.writeText(report);
    btn.textContent = 'Скопировано ✓';
  } catch {
    btn.textContent = 'Не удалось скопировать';
  }
  setTimeout(() => (btn.textContent = originalText), 2000);
});

refreshStatus().then(loadSettings);
