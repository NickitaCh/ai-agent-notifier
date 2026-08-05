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
  statusText.textContent = connected
    ? 'Компаньон подключён — можно закрывать эту вкладку.'
    : 'Компаньон пока не подключён — выполните шаги ниже, потом нажмите «Проверить снова».';
}

recheckBtn.addEventListener('click', refreshStatus);
refreshStatus();
