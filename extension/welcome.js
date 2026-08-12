'use strict';

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const recheckBtn = document.getElementById('recheck');

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refreshStatus() {
  recheckBtn.disabled = true;
  const res = await sendMessage({ type: 'get_status' });
  recheckBtn.disabled = false;

  const connected = !!res?.connected;
  dot.classList.toggle('on', connected);
  statusText.textContent = self.I18n.t(connected ? 'welcome.statusConnected' : 'welcome.statusWaiting');
}

recheckBtn.addEventListener('click', refreshStatus);

async function init() {
  // Тот же зеркальный ключ, что читает попап: страница онбординга может
  // открыться раньше, чем демон вообще запустится, поэтому язык берём из
  // storage, а не из настроек демона.
  const stored = await chrome.storage.local.get('locale');
  const locale = stored.locale || self.I18n.detect();
  if (!stored.locale) await chrome.storage.local.set({ locale });

  await self.I18n.use(locale);
  self.I18n.apply(document);
  statusText.textContent = self.I18n.t('welcome.statusChecking');

  await refreshStatus();
}

init();
