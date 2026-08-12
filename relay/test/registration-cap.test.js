'use strict';

// config.js бросает при require(), если BOT_TOKEN/WEBHOOK_SECRET не заданы —
// в проде это секреты из systemd unit, в тесте достаточно любых значений
// (сеть замокана ниже, реальный токен не понадобится).
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-token';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');
const store = require('../src/store');
const pairingCodes = require('../src/pairing-codes');
const telegram = require('../src/telegram');
const i18n = require('../src/i18n');
const { handleIncomingMessage } = require('../src/server');

function withTempDataDirAndCap(maxUsers, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aan-relay-cap-test-'));
  const originalDataDir = config.dataDir;
  const originalMax = config.maxUsers;
  config.dataDir = dir;
  config.maxUsers = maxUsers;
  return Promise.resolve(fn(dir)).finally(() => {
    config.dataDir = originalDataDir;
    config.maxUsers = originalMax;
  });
}

function withMockedSendText(fn) {
  const original = telegram.sendText;
  const sent = [];
  telegram.sendText = async (botToken, chatId, text) => {
    sent.push({ chatId, text });
  };
  return Promise.resolve(fn(sent)).finally(() => {
    telegram.sendText = original;
  });
}

test('handleIncomingMessage: новый чат создаётся, пока не достигнут maxUsers', async () => {
  await withTempDataDirAndCap(2, async (dir) => {
    await withMockedSendText(async (sent) => {
      const code = pairingCodes.createCode(60000);
      await handleIncomingMessage({ chat: { id: 111 }, from: { language_code: 'ru' }, text: `/start ${code}` });
      const user = Object.values(store.load(dir))[0];
      assert.equal(user.chatId, 111);
      assert.equal(sent[sent.length - 1].text, i18n.t('ru', 'bot.paired'));
    });
  });
});

test('handleIncomingMessage: сверх maxUsers новым чатам отказывает', async () => {
  await withTempDataDirAndCap(1, async (dir) => {
    await withMockedSendText(async (sent) => {
      store.createUser(dir, 'existing-token', 999); // уже заняли единственное место
      const code = pairingCodes.createCode(60000);
      await handleIncomingMessage({ chat: { id: 222 }, text: `/start ${code}` });
      const users = store.load(dir);
      assert.equal(Object.keys(users).length, 1); // новый юзер не добавился
      assert.equal(sent[sent.length - 1].text, i18n.t('en', 'bot.capReached'));
    });
  });
});

test('handleIncomingMessage: повторная привязка того же chat.id разрешена даже при заполненном капе', async () => {
  await withTempDataDirAndCap(1, async (dir) => {
    await withMockedSendText(async (sent) => {
      store.createUser(dir, 'existing-token', 333);
      const code = pairingCodes.createCode(60000);
      await handleIncomingMessage({ chat: { id: 333 }, text: `/start ${code}` });
      const users = store.load(dir);
      assert.equal(Object.keys(users).length, 2); // новый токен для того же chatId — ок
      assert.equal(sent[sent.length - 1].text, i18n.t('en', 'bot.paired'));
    });
  });
});

test('handleIncomingMessage: неизвестный/просроченный код — вежливый отказ, юзер не создаётся', async () => {
  await withTempDataDirAndCap(500, async (dir) => {
    await withMockedSendText(async (sent) => {
      await handleIncomingMessage({ chat: { id: 444 }, text: '/start никогда-не-существовавший-код' });
      assert.deepEqual(store.load(dir), {});
      assert.equal(sent[sent.length - 1].text, i18n.t('en', 'bot.codeNotFound'));
    });
  });
});
