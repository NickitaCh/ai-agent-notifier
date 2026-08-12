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
const feedback = require('../src/feedback');
const telegram = require('../src/telegram');
const i18n = require('../src/i18n');
const { handleIncomingMessage } = require('../src/server');

function withTempDataDir(fn, { adminChatId = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aan-relay-feedback-test-'));
  const originalDataDir = config.dataDir;
  const originalAdmin = config.adminChatId;
  config.dataDir = dir;
  config.adminChatId = adminChatId;
  return Promise.resolve(fn(dir)).finally(() => {
    config.dataDir = originalDataDir;
    config.adminChatId = originalAdmin;
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

// Лимитер в server.js живёт на уровне модуля и общий для всех тестов —
// поэтому у каждого теста свой chatId, чтобы они не съедали чужую квоту.
let nextChatId = 5000;
function chatId() {
  nextChatId += 1;
  return nextChatId;
}

test('save + list: обращение сохраняется и читается обратно', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aan-fb-'));
  feedback.save(dir, { chatId: 1, text: 'не приходят уведомления', username: 'qa11' }, 1000);
  feedback.save(dir, { chatId: 2, text: 'добавьте тёмную тему' }, 2000);

  const all = feedback.list(dir);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], { ts: 1000, chatId: 1, username: 'qa11', text: 'не приходят уведомления' });
  assert.equal(all[1].username, null);
});

test('save: слишком длинный текст обрезается с пометкой', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aan-fb-'));
  const record = feedback.save(dir, { chatId: 1, text: 'я'.repeat(feedback.MAX_TEXT_LENGTH + 500) }, 1000);
  assert.ok(record.text.endsWith('… [обрезано]'));
  assert.ok(record.text.length < feedback.MAX_TEXT_LENGTH + 20);
});

test('list: на папке без обращений возвращает пустой список', () => {
  assert.deepEqual(feedback.list(fs.mkdtempSync(path.join(os.tmpdir(), 'aan-fb-'))), []);
});

test('formatForAdmin: с username и без', () => {
  assert.match(feedback.formatForAdmin({ chatId: 7, username: 'qa11', text: 'привет' }), /@qa11 \(chat 7\)/);
  assert.match(feedback.formatForAdmin({ chatId: 7, username: null, text: 'привет' }), /chat 7/);
});

test('/feedback с текстом: сохраняет и благодарит', async () => {
  await withTempDataDir(async (dir) => {
    await withMockedSendText(async (sent) => {
      const id = chatId();
      await handleIncomingMessage({
        chat: { id },
        from: { username: 'qa11', language_code: 'ru' },
        text: '/feedback кнопка не нажимается',
      });

      const saved = feedback.list(dir);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].text, 'кнопка не нажимается');
      assert.equal(saved[0].chatId, id);
      assert.equal(saved[0].username, 'qa11');
      assert.equal(sent[sent.length - 1].text, i18n.t('ru', 'bot.feedbackThanks'));
    });
  });
});

test('/feedback без текста: подсказывает формат и ничего не сохраняет', async () => {
  await withTempDataDir(async (dir) => {
    await withMockedSendText(async (sent) => {
      await handleIncomingMessage({ chat: { id: chatId() }, text: '/feedback' });
      assert.deepEqual(feedback.list(dir), []);
      assert.equal(sent[sent.length - 1].text, i18n.t('en', 'bot.feedbackUsage'));
    });
  });
});

test('/feedback пересылается админу, когда ADMIN_CHAT_ID задан', async () => {
  await withTempDataDir(
    async () => {
      await withMockedSendText(async (sent) => {
        await handleIncomingMessage({ chat: { id: chatId() }, text: '/feedback всё сломалось' });
        const toAdmin = sent.find((m) => String(m.chatId) === '999000');
        assert.ok(toAdmin, 'обращение должно уйти в админский чат');
        assert.match(toAdmin.text, /всё сломалось/);
      });
    },
    { adminChatId: '999000' }
  );
});

test('/feedback: упавшая пересылка админу не мешает поблагодарить юзера', async () => {
  await withTempDataDir(
    async (dir) => {
      const original = telegram.sendText;
      const sent = [];
      telegram.sendText = async (botToken, to, text) => {
        if (String(to) === '999000') throw new Error('админ заблокировал бота');
        sent.push({ chatId: to, text });
      };
      try {
        await handleIncomingMessage({ chat: { id: chatId() }, text: '/feedback тест' });
        assert.equal(feedback.list(dir).length, 1);
        assert.equal(sent[sent.length - 1].text, i18n.t('en', 'bot.feedbackThanks'));
      } finally {
        telegram.sendText = original;
      }
    },
    { adminChatId: '999000' }
  );
});

test('/feedback: сверх лимита отвечает отказом и не сохраняет', async () => {
  await withTempDataDir(async (dir) => {
    await withMockedSendText(async (sent) => {
      const id = chatId();
      const max = config.feedbackRateLimit.max;
      for (let i = 0; i < max; i += 1) {
        await handleIncomingMessage({ chat: { id }, text: `/feedback сообщение ${i}` });
      }
      assert.equal(feedback.list(dir).length, max);

      await handleIncomingMessage({ chat: { id }, text: '/feedback ещё одно' });
      assert.equal(feedback.list(dir).length, max, 'сверхлимитное обращение не должно сохраняться');
      assert.equal(sent[sent.length - 1].text, i18n.t('en', 'bot.feedbackTooMany'));
    });
  });
});

test('/feedback: лимит считается по чату, сосед не страдает', async () => {
  await withTempDataDir(async (dir) => {
    await withMockedSendText(async () => {
      const noisy = chatId();
      for (let i = 0; i <= config.feedbackRateLimit.max; i += 1) {
        await handleIncomingMessage({ chat: { id: noisy }, text: `/feedback спам ${i}` });
      }
      const quiet = chatId();
      await handleIncomingMessage({ chat: { id: quiet }, text: '/feedback обычное сообщение' });
      assert.ok(feedback.list(dir).some((r) => r.chatId === quiet));
    });
  });
});

test('постороннее сообщение боту получает подсказку, а не тишину', async () => {
  await withTempDataDir(async () => {
    await withMockedSendText(async (sent) => {
      await handleIncomingMessage({ chat: { id: chatId() }, text: 'привет, а как это работает?' });
      assert.equal(sent[sent.length - 1].text, i18n.t('en', 'bot.help'));
    });
  });
});
