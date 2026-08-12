'use strict';

importScripts('i18n.js', 'channels/badge-channel.js', 'channels/notification-channel.js');

// Имя должно совпадать с host/src/constants.js (NATIVE_HOST_NAME) и с
// "name" в host-манифесте, который регистрируется в реестре/файловой системе.
const NATIVE_HOST_NAME = 'com.aiagentnotifier.host';

// Версия ПРОТОКОЛА (не версия расширения) — должна совпадать с
// PROTOCOL_VERSION в host/src/constants.js. Расширение обновляется само
// через Chrome Web Store, хост — вручную, поэтому со временем версии могут
// разойтись; тогда popup покажет предупреждение (см. host_hello ниже).
const EXTENSION_PROTOCOL_VERSION = 1;

let port = null;
let lastEvents = []; // короткий лог в памяти service worker'а — для popup
let waiters = {}; // requestId -> resolve-функция (см. requestFromDaemon)
let requestSeq = 0;
let hostInfo = null; // { protocolVersion, hostVersion, mismatch } — из последнего host_hello

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
    hostInfo = null;
  });
  port.postMessage({
    type: 'client_hello',
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
  });
}

function onNativeMessage(payload) {
  if (payload.type === 'host_hello') {
    hostInfo = {
      protocolVersion: payload.protocolVersion,
      hostVersion: payload.hostVersion,
      mismatch: payload.protocolVersion !== EXTENSION_PROTOCOL_VERSION,
    };
    return;
  }
  // Ответ на конкретный requestFromDaemon() — сопоставляем по requestId, а
  // не по типу сообщения. Раньше матчилось по типу ("settings_snapshot"),
  // и первый же пришедший ответ резолвил ВСЕ ожидающие промисы этого типа —
  // если два update_settings идут почти одновременно (например, юзер быстро
  // заполняет несколько полей телефон-провайдера подряд), второй настоящий
  // ответ с уже сохранёнными данными тихо терялся.
  if (payload.requestId && waiters[payload.requestId]) {
    const resolve = waiters[payload.requestId];
    delete waiters[payload.requestId];
    resolve(payload);
    return;
  }

  lastEvents.unshift({ ...payload, receivedAt: Date.now() });
  lastEvents = lastEvents.slice(0, 20);

  if (payload.kind === 'badge') {
    BadgeChannel.show(payload.event);
  } else if (payload.kind === 'notification') {
    // Ждём каталог: SW мог проснуться именно ради этого события, и
    // NotificationChannel.show() читает строки синхронно (см. i18n.ready).
    self.I18n.ready().then(() => NotificationChannel.show(payload.event, payload.options));
  }
}

const DAEMON_REQUEST_TIMEOUT_MS = 15000;

// Отправляет сообщение демону и ждёт именно ответ на него (сопоставление по
// requestId — см. onNativeMessage) через native-messaging порт. Без
// соединения — резолвится в null, вызывающий код (popup) покажет "нет связи".
//
// Таймаут — подстраховка: если Service Worker перезапустится, пока ответ ещё
// в пути (MV3 может усыпить его даже при вроде бы открытом порте), waiters
// обнулится вместе с остальным состоянием модуля, и ответ придёт уже
// нечему сопоставить — тогда popup иначе завис бы на "отправляю…" навсегда.
function requestFromDaemon(message) {
  return new Promise((resolve) => {
    if (!port) {
      resolve(null);
      return;
    }
    const requestId = `${Date.now()}-${++requestSeq}`;
    const timer = setTimeout(() => {
      delete waiters[requestId];
      resolve(null);
    }, DAEMON_REQUEST_TIMEOUT_MS);
    waiters[requestId] = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    port.postMessage({ ...message, requestId });
  });
}

// Пейринг с shared-ботом живёт здесь, а не в popup.js: popup.js раньше сам
// опрашивал relay/pair/status в цикле, но popup закрывается сразу же, как
// только теряет фокус — а именно это происходит в тот момент, когда
// "Привязать через бота" открывает вкладку Telegram кнопкой chrome.tabs.create
// (новая активная вкладка ворует фокус). Итог: юзер жмёт /start в Telegram,
// relay реально выдаёт токен, но цикл опроса в popup.js уже мёртв, и токен
// никогда не долетает до settings. Здесь то же самое переживает закрытие
// попапа, потому что background — service worker, а не документ попапа;
// код держится живым за счёт открытого native-messaging порта + будильника
// keepalive ниже, который на всякий случай тоже дёргает проверку.
async function getPendingPair() {
  const { pendingPair } = await chrome.storage.session.get('pendingPair');
  return pendingPair || null;
}

async function setPendingPair(value) {
  if (value) await chrome.storage.session.set({ pendingPair: value });
  else await chrome.storage.session.remove('pendingPair');
}

// Пока код ещё не подтверждён, дёргаем проверку почаще (раз в 3с), чтобы не
// заставлять юзера ждать до 24с (следующего тика будильника keepalive) —
// именно эта задержка провоцировала повторные клики по кнопке "Привязать".
// Будильник ниже остаётся подстраховкой на случай, если сам SW уснёт
// раньше, чем цепочка setTimeout успеет доработать.
let pairPollTimer = null;

function schedulePairPoll(delayMs) {
  clearTimeout(pairPollTimer);
  pairPollTimer = setTimeout(async () => {
    await checkPendingPair();
    if (await getPendingPair()) schedulePairPoll(3000);
  }, delayMs);
}

async function checkPendingPair() {
  const pending = await getPendingPair();
  if (!pending) return;
  if (Date.now() >= pending.deadline) {
    await setPendingPair(null);
    return;
  }
  const status = await requestFromDaemon({ type: 'relay_pair_status', code: pending.code });
  if (status?.paired && status.token) {
    await requestFromDaemon({
      type: 'update_settings',
      patch: { phone: { provider: 'relay', relayToken: status.token } },
    });
    await setPendingPair(null);
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'AI Agent Notifier',
      message: self.I18n.t('phone.pairedToast'),
    });
    return;
  }
  if (status?.expired) {
    await setPendingPair(null);
  }
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
  if (alarm.name !== 'keepalive') return;
  if (!port) connect();
  checkPendingPair();
  // Демон мог только что подняться — тогда это первая возможность
  // договориться с ним о языке.
  syncLocaleWithDaemon();
});

// --- язык -----------------------------------------------------------------
//
// Источник истины — settings.locale в демоне: оттуда его читают хост
// (сообщения на телефон) и relay (ответы бота), а значит все четыре
// поверхности говорят на одном языке. Но service worker должен уметь
// показать тост и без демона, поэтому язык дублируется в
// chrome.storage.local и читается оттуда мгновенно.
//
// Кто кого перетирает: если у демона язык уже задан — он выигрывает (его
// мог поставить попап из другого профиля Chrome). Если нет — туда уезжает
// наше значение. Так первый запуск один раз фиксирует язык браузера, а
// дальше им управляет переключатель в попапе.
async function initLocale() {
  const stored = await chrome.storage.local.get('locale');
  const locale = stored.locale || self.I18n.detect();
  if (!stored.locale) await chrome.storage.local.set({ locale });
  await self.I18n.use(locale);
  return locale;
}

async function syncLocaleWithDaemon() {
  const local = await initLocale();
  if (!port) return;
  const reply = await requestFromDaemon({ type: 'get_settings' });
  const daemonLocale = reply?.settings?.locale;
  if (daemonLocale && self.I18n.normalize(daemonLocale) && daemonLocale !== local) {
    await chrome.storage.local.set({ locale: daemonLocale });
    await self.I18n.use(daemonLocale);
    return;
  }
  if (!daemonLocale) {
    await requestFromDaemon({ type: 'update_settings', patch: { locale: local } });
  }
}

// Попап пишет в тот же ключ при переключении языка — подхватываем, чтобы
// тосты не остались на прежнем языке до перезапуска service worker'а.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.locale?.newValue) self.I18n.use(changes.locale.newValue);
});

initLocale();

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener((details) => {
  connect();
  // Только на свежую установку (не апдейт) — человек из Chrome Web Store
  // ещё не знает, что нужен отдельный компаньон на диске; открываем
  // это сразу, а не ждём, что он сам разберётся через иконку в панели.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});
connect();

// Сообщения от popup.js.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'get_status') {
    sendResponse({ connected: !!port, lastEvents, hostInfo, extensionVersion: chrome.runtime.getManifest().version });
    return false;
  }
  if (msg.type === 'get_settings') {
    requestFromDaemon({ type: 'get_settings' }).then((reply) => sendResponse({ settings: reply?.settings }));
    return true; // ответ асинхронный
  }
  if (msg.type === 'update_settings') {
    requestFromDaemon({ type: 'update_settings', patch: msg.patch }).then((reply) =>
      sendResponse({ settings: reply?.settings })
    );
    return true;
  }
  if (msg.type === 'get_diagnostics') {
    requestFromDaemon({ type: 'get_diagnostics' }).then((reply) => sendResponse({ logTail: reply?.logTail }));
    return true;
  }
  if (msg.type === 'test_phone') {
    requestFromDaemon({ type: 'test_phone' }).then((reply) => sendResponse({ ok: reply?.ok, error: reply?.error }));
    return true;
  }
  if (msg.type === 'relay_pair_start') {
    requestFromDaemon({ type: 'relay_pair_start' }).then(async (reply) => {
      if (reply?.ok && reply.code) {
        await setPendingPair({ code: reply.code, deadline: Date.now() + 10 * 60 * 1000 });
        schedulePairPoll(2000);
      }
      sendResponse(reply || { ok: false });
    });
    return true;
  }
  if (msg.type === 'relay_pair_status') {
    requestFromDaemon({ type: 'relay_pair_status', code: msg.code }).then((reply) => sendResponse(reply || { ok: false }));
    return true;
  }
  if (msg.type === 'get_pair_status') {
    getPendingPair().then((pending) => sendResponse({ pending }));
    return true;
  }
  return false;
});
