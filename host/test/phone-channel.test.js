'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const phoneChannel = require('../src/channels/phone-channel');
const extensionChannel = require('../src/channels/extension-channel');

// Подменяем глобальный fetch на шпион, который просто пишет что ему передали.
// Как и withMocks в router.test.js — сохраняем оригинал, восстанавливаем в finally.
function withFetch(impl, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return impl(url, options);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    global.fetch = original;
  });
}

function okResponse(body = {}) {
  return { ok: true, status: 200, text: async () => '', json: async () => body };
}

// Язык в buildMessage/send передаём явно во всех тестах, где проверяется
// текст. Без него i18n падает на локаль машины: локально это ru и тесты
// проходили, а на англоязычном раннере CI — en, и ассерты на русские
// подстроки валились. Тест не должен зависеть от языка машины.
test('buildMessage: actionable permission_request даёт заголовок "просит разрешение"', () => {
  const { title, body, isActionable } = phoneChannel.buildMessage(
    {
      type: 'permission_request',
      tool: 'Edit',
      summary: 'редактирует файл',
    },
    'ru'
  );
  assert.equal(isActionable, true);
  assert.match(title, /просит разрешение/);
  assert.equal(body, 'редактирует файл');
});

test('buildMessage: permission_request с needsDecision:false — информационный, без действия', () => {
  const { title, body, isActionable } = phoneChannel.buildMessage(
    { type: 'permission_request', needsDecision: false, summary: 'выберите вариант' },
    'ru'
  );
  assert.equal(isActionable, false);
  assert.match(title, /задал вопрос/);
  assert.match(body, /ответьте в терминале/);
});

test('buildMessage: task_done даёт заголовок "закончил"', () => {
  const { title, isActionable } = phoneChannel.buildMessage({ type: 'task_done' }, 'ru');
  assert.equal(isActionable, false);
  assert.match(title, /закончил/);
});

test('send: provider "none" не вызывает fetch', async () => {
  await withFetch(
    () => okResponse(),
    async (calls) => {
      await phoneChannel.send({ type: 'task_done' }, { phone: { provider: 'none' } });
      assert.equal(calls.length, 0);
    }
  );
});

test('send: без настроенного phone вообще — не падает и ничего не шлёт', async () => {
  await withFetch(
    () => okResponse(),
    async (calls) => {
      await phoneChannel.send({ type: 'task_done' }, {});
      assert.equal(calls.length, 0);
    }
  );
});

test('send: неизвестный provider логирует ошибку, но не бросает исключение', async () => {
  await withFetch(
    () => okResponse(),
    async (calls) => {
      await assert.doesNotReject(() =>
        phoneChannel.send({ type: 'task_done' }, { phone: { provider: 'bogus' } })
      );
      assert.equal(calls.length, 0);
    }
  );
});

test('send: ntfy без ntfyTopicUrl не шлёт запрос', async () => {
  await withFetch(
    () => okResponse(),
    async (calls) => {
      await phoneChannel.send({ type: 'task_done' }, { phone: { provider: 'ntfy' } });
      assert.equal(calls.length, 0);
    }
  );
});

test('send: ntfy публикует JSON с topic из URL', async () => {
  await withFetch(
    () => okResponse(),
    async (calls) => {
      await phoneChannel.send(
        { type: 'task_done' },
        { locale: 'ru', phone: { provider: 'ntfy', ntfyTopicUrl: 'https://ntfy.sh/мой-топик' } }
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://ntfy.sh/');
      const payload = JSON.parse(calls[0].options.body);
      assert.equal(payload.topic, 'мой-топик');
      assert.match(payload.title, /закончил/);
    }
  );
});

test('send: webhook шлёт и content (Discord), и text (Slack) в одном теле', async () => {
  await withFetch(
    () => okResponse(),
    async (calls) => {
      await phoneChannel.send(
        { type: 'task_done' },
        { phone: { provider: 'webhook', webhookUrl: 'https://example.com/hook' } }
      );
      const payload = JSON.parse(calls[0].options.body);
      assert.ok(payload.content);
      assert.equal(payload.content, payload.text);
    }
  );
});

test('send: pushover с actionable-событием шлёт priority=1, иначе priority=0', async () => {
  await withFetch(
    () => okResponse(),
    async (calls) => {
      await phoneChannel.send(
        { type: 'permission_request', tool: 'Edit' },
        { phone: { provider: 'pushover', pushoverToken: 'tok', pushoverUserKey: 'user' } }
      );
      await phoneChannel.send(
        { type: 'task_done' },
        { phone: { provider: 'pushover', pushoverToken: 'tok', pushoverUserKey: 'user' } }
      );
      const params1 = new URLSearchParams(calls[0].options.body);
      const params2 = new URLSearchParams(calls[1].options.body);
      assert.equal(params1.get('priority'), '1');
      assert.equal(params2.get('priority'), '0');
    }
  );
});

test('send: pushover без token/userKey не шлёт запрос', async () => {
  await withFetch(
    () => okResponse(),
    async (calls) => {
      await phoneChannel.send({ type: 'task_done' }, { phone: { provider: 'pushover', pushoverToken: 'tok' } });
      assert.equal(calls.length, 0);
    }
  );
});

test('send: telegram добавляет inline_keyboard только для actionable-события', async () => {
  await withFetch(
    () => okResponse(),
    async (calls) => {
      await phoneChannel.send(
        { id: 'ev1', type: 'permission_request', tool: 'Edit' },
        { phone: { provider: 'telegram', telegramBotToken: 'tok', telegramChatId: 'chat1' } }
      );
      await phoneChannel.send(
        { id: 'ev2', type: 'task_done' },
        { phone: { provider: 'telegram', telegramBotToken: 'tok', telegramChatId: 'chat1' } }
      );
      const payload1 = JSON.parse(calls[0].options.body);
      const payload2 = JSON.parse(calls[1].options.body);
      assert.match(calls[0].url, /\/bottok\/sendMessage$/);
      assert.equal(payload1.reply_markup.inline_keyboard[0][0].callback_data, 'allow:ev1');
      assert.equal(payload1.reply_markup.inline_keyboard[0][1].callback_data, 'deny:ev1');
      assert.equal(payload2.reply_markup, undefined);
    }
  );
});

test('send: relay без relayToken не шлёт запрос', async () => {
  await withFetch(
    () => okResponse(),
    async (calls) => {
      await phoneChannel.send({ type: 'task_done' }, { phone: { provider: 'relay' } });
      assert.equal(calls.length, 0);
    }
  );
});

test('send: relay шлёт событие с Bearer-токеном на /events', async () => {
  await withFetch(
    () => okResponse({ ok: true }),
    async (calls) => {
      await phoneChannel.send(
        { id: 'ev-relay-1', type: 'task_done' },
        { phone: { provider: 'relay', relayToken: 'tok-xyz' } }
      );
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/events$/);
      assert.equal(calls[0].options.headers.Authorization, 'Bearer tok-xyz');
    }
  );
});

test('buildRelayBody: по умолчанию прикладывает слепок клиента к событию', () => {
  const body = phoneChannel.buildRelayBody({ id: 'ev-1', type: 'task_done' }, { relayToken: 't' });
  assert.equal(body.id, 'ev-1');
  assert.ok(['windows', 'macos', 'linux'].includes(body.client.os));
  assert.ok(body.client.hostVersion.length > 0);
});

test('buildRelayBody: relayMetrics:false убирает client, но НЕ язык', () => {
  // Язык — не статистика: без него бот отвечал бы не на том языке, что
  // остальной интерфейс, даже у юзера, отключившего сбор метрик.
  const event = { id: 'ev-2', type: 'task_done' };
  const body = phoneChannel.buildRelayBody(event, { relayToken: 't', relayMetrics: false }, 'es');
  assert.equal(body.client, undefined);
  assert.equal(body.locale, 'es');
  assert.deepEqual({ id: body.id, type: body.type }, event);
});

test('buildRelayBody: неизвестный язык нормализуется до поддерживаемого', () => {
  const body = phoneChannel.buildRelayBody({ id: 'ev-3', type: 'task_done' }, { relayToken: 't' }, 'pt-BR');
  assert.ok(['ru', 'en', 'es'].includes(body.locale));
});

test('send: relay кладёт client в тело запроса', async () => {
  await withFetch(
    () => okResponse({ ok: true }),
    async (calls) => {
      await phoneChannel.send(
        { id: 'ev-relay-4', type: 'task_done' },
        { phone: { provider: 'relay', relayToken: 'tok-xyz' } }
      );
      const sent = JSON.parse(calls[0].options.body);
      assert.equal(sent.id, 'ev-relay-4');
      assert.ok(sent.client.os.length > 0);
    }
  );
});

test('send: relay для non-actionable события не запускает опрос решения', async () => {
  await withFetch(
    () => okResponse({ ok: true }),
    async (calls) => {
      await phoneChannel.send(
        { id: 'ev-relay-2', type: 'task_done' },
        { phone: { provider: 'relay', relayToken: 'tok-xyz' } }
      );
      // Даём микротаскам прогнаться — если бы опрос решения всё же
      // стартовал, к этому моменту он бы уже сделал второй вызов fetch.
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls.length, 1);
    }
  );
});

test('send: relay для actionable события резолвится сразу после POST /events, не дожидаясь решения', async () => {
  const originalResolve = extensionChannel.resolveDecision;
  const resolved = [];
  extensionChannel.resolveDecision = (id, decision) => resolved.push([id, decision]);
  try {
    await withFetch(
      (url) => {
        if (String(url).endsWith('/events')) return okResponse({ ok: true });
        // Запрос решения — намеренно не резолвим быстро, send() не должен его ждать.
        return new Promise((resolve) => setTimeout(() => resolve(okResponse({ decision: 'allow' })), 50));
      },
      async (calls) => {
        const start = Date.now();
        await phoneChannel.send(
          { id: 'ev-relay-3', type: 'permission_request', tool: 'Edit' },
          { phone: { provider: 'relay', relayToken: 'tok-xyz' } }
        );
        // send() вернулся почти сразу — не ждал 50мс запроса решения (сам
        // запрос решения к этому моменту уже СТАРТОВАЛ — fire-and-forget,
        // без await — но не резолвился, calls.length тут уже 2).
        assert.ok(Date.now() - start < 40);
        assert.equal(calls.length, 2);

        // А сам фоновый опрос решения всё же донашивается до конца и в
        // итоге резолвит локальное решение через extensionChannel.
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(calls.length, 2);
        assert.deepEqual(resolved, [['ev-relay-3', 'allow']]);
      }
    );
  } finally {
    extensionChannel.resolveDecision = originalResolve;
  }
});

test('send: неуспешный HTTP-ответ бросает исключение (для test_phone в popup)', async () => {
  await withFetch(
    () => ({ ok: false, status: 500, text: async () => 'внутренняя ошибка' }),
    async () => {
      await assert.rejects(
        () =>
          phoneChannel.send(
            { type: 'task_done' },
            { phone: { provider: 'webhook', webhookUrl: 'https://example.com/hook' } }
          ),
        /HTTP 500/
      );
    }
  );
});
