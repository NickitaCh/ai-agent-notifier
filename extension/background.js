'use strict';

importScripts('channels/badge-channel.js', 'channels/notification-channel.js');

// Имя должно совпадать с host/src/constants.js (NATIVE_HOST_NAME) и с
// "name" в host-манифесте, который регистрируется в реестре/файловой системе.
const NATIVE_HOST_NAME = 'com.aiagentnotifier.host';

let port = null;
let lastEvents = []; // короткий лог в памяти service worker'а — для popup
let waiters = {}; // тип ответа демона ("settings_snapshot"/"diagnostics_snapshot") -> resolve-функции

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (err) {
    console.error('[background] connectNative упал:', err.message);
    port = null;
    return;
  }
  port.onMessage.addListener(onNativeMessage);
  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      console.error('[background] native host отключился:', chrome.runtime.lastError.message);
    }
    port = null;
  });
}

function onNativeMessage(payload) {
  if (payload.type === 'settings_snapshot' || payload.type === 'diagnostics_snapshot') {
    const pending = waiters[payload.type] || [];
    waiters[payload.type] = [];
    pending.forEach((resolve) => resolve(payload));
    return;
  }

  lastEvents.unshift({ ...payload, receivedAt: Date.now() });
  lastEvents = lastEvents.slice(0, 20);

  if (payload.kind === 'badge') {
    BadgeChannel.show(payload.event);
  } else if (payload.kind === 'notification') {
    NotificationChannel.show(payload.event, payload.options);
  }
}

// Отправляет сообщение демону и ждёт ответ конкретного типа через
// native-messaging порт. Без соединения — резолвится в null, вызывающий код
// (popup) покажет "нет связи".
function requestFromDaemon(message, replyType) {
  return new Promise((resolve) => {
    if (!port) {
      resolve(null);
      return;
    }
    waiters[replyType] = waiters[replyType] || [];
    waiters[replyType].push(resolve);
    port.postMessage(message);
  });
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  const decision = buttonIndex === 0 ? 'allow' : 'deny';
  if (port) {
    port.postMessage({ type: 'permission_response', id: notificationId, decision });
  } else {
    console.error('[background] нет соединения с host — решение не доставлено');
  }
  chrome.notifications.clear(notificationId);
});

// MV3 может усыпить service worker; открытый native-messaging порт обычно
// держит его живым, но подстраховываемся периодической проверкой.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive' && !port) connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// Сообщения от popup.js.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'get_status') {
    sendResponse({ connected: !!port, lastEvents });
    return false;
  }
  if (msg.type === 'get_settings') {
    requestFromDaemon({ type: 'get_settings' }, 'settings_snapshot').then((reply) =>
      sendResponse({ settings: reply?.settings })
    );
    return true; // ответ асинхронный
  }
  if (msg.type === 'update_settings') {
    requestFromDaemon({ type: 'update_settings', patch: msg.patch }, 'settings_snapshot').then((reply) =>
      sendResponse({ settings: reply?.settings })
    );
    return true;
  }
  if (msg.type === 'get_diagnostics') {
    requestFromDaemon({ type: 'get_diagnostics' }, 'diagnostics_snapshot').then((reply) =>
      sendResponse({ logTail: reply?.logTail })
    );
    return true;
  }
  return false;
});
