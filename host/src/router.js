'use strict';

// Правила "тип события -> список каналов" + сам вызов каналов.
// Каждый канал — модуль с интерфейсом send(event, settings): Promise<void>.

const settingsStore = require('./settings');
const extensionChannel = require('./channels/extension-channel');
const phoneChannel = require('./channels/phone-channel');

// [модуль, имя метода] вместо прямой ссылки на функцию — метод ищется на
// объекте в момент вызова, а не один раз при загрузке модуля. Это и проще
// для моков в тестах (подмена extensionChannel.sendBadge применяется сразу),
// и не даёт CHANNELS «застыть» со старой версией функции.
const CHANNEL_TARGETS = {
  badge: [extensionChannel, 'sendBadge'],
  notification: [extensionChannel, 'sendNotification'],
  phone: [phoneChannel, 'send'],
};

async function dispatch(event) {
  const settings = settingsStore.load();

  // «Не беспокоить» — per-проектное (по cwd события), а не глобальное:
  // шумная параллельная сессия не должна глушить важную.
  const snoozeUntil = (settings.snoozeByProject || {})[event.cwd];
  if (snoozeUntil && Date.now() < snoozeUntil) {
    console.error(
      `[router] событие ${event.type} id=${event.id} cwd=${event.cwd} подавлено — «не беспокоить» до ${new Date(snoozeUntil).toISOString()}`
    );
    return;
  }

  const channelNames = settings.rules[event.type] || [];
  console.error(`[router] dispatch ${event.type} id=${event.id} -> [${channelNames.join(', ')}]`);
  for (const name of channelNames) {
    const target = CHANNEL_TARGETS[name];
    if (!target) {
      console.error(`[router] неизвестный канал "${name}" в правиле для "${event.type}"`);
      continue;
    }
    const [channelModule, methodName] = target;
    try {
      await channelModule[methodName](event, settings);
    } catch (err) {
      console.error(`[router] канал "${name}" упал: ${err.message}`);
    }
  }
}

module.exports = { dispatch };
