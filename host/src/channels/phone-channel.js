'use strict';

// ЗАГЛУШКА канала 3 (push на телефон). Тот же интерфейс send(event, settings),
// что и у остальных каналов, — чтобы подключить реальную реализацию
// (например, POST на push-сервер) позже, не трогая router.js.
// TODO: реализовать, когда появится сервер пушей / выбранный провайдер (FCM, ntfy.sh и т.п.)

async function send(event) {
  console.error(`[phone-channel] заглушка: событие "${event.type}" не отправлено на телефон (не реализовано)`);
}

module.exports = { send };
