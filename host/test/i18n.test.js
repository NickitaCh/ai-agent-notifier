'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const i18n = require('../src/i18n');
const phoneChannel = require('../src/channels/phone-channel');

test('t: отдаёт строку на запрошенном языке', () => {
  assert.equal(i18n.t('ru', 'event.titleDone'), 'Агент закончил');
  assert.equal(i18n.t('en', 'event.titleDone'), 'Agent finished');
  assert.equal(i18n.t('es', 'event.titleDone'), 'El agente ha terminado');
});

test('t: региональный тег сводится к базовому языку', () => {
  assert.equal(i18n.t('es-419', 'event.allow'), i18n.t('es', 'event.allow'));
  assert.equal(i18n.t('ru_RU', 'event.allow'), i18n.t('ru', 'event.allow'));
});

test('t: неизвестный ключ возвращает сам ключ, а не пустую строку', () => {
  // Пустая строка в уведомлении выглядит как сломанная доставка, видимый
  // ключ сразу показывает, что именно забыли перевести.
  assert.equal(i18n.t('ru', 'нет.такого.ключа'), 'нет.такого.ключа');
});

test('resolve: неподдерживаемый язык не проходит', () => {
  assert.equal(i18n.normalize('pt-BR'), null);
  assert.ok(i18n.SUPPORTED.includes(i18n.resolve('pt-BR')));
  assert.equal(i18n.resolve('en'), 'en');
});

test('во всех каталогах хоста одинаковый набор ключей', () => {
  const ru = Object.keys(require('../src/i18n/ru.json')).sort();
  for (const locale of ['en', 'es']) {
    assert.deepEqual(Object.keys(require(`../src/i18n/${locale}.json`)).sort(), ru, `расхождение в ${locale}.json`);
  }
});

test('buildMessage: заголовок и тело идут на языке из настроек', () => {
  const event = { type: 'permission_request', tool: 'Edit', summary: 'редактирует файл' };
  assert.match(phoneChannel.buildMessage(event, 'ru').title, /просит разрешение/);
  assert.match(phoneChannel.buildMessage(event, 'en').title, /needs permission/);
  assert.match(phoneChannel.buildMessage(event, 'es').title, /pide permiso/);
});

test('buildMessage: информационное событие дописывает «ответьте в терминале» на нужном языке', () => {
  const event = { type: 'permission_request', needsDecision: false, summary: 'выберите вариант' };
  assert.match(phoneChannel.buildMessage(event, 'en').body, /answer in the terminal/);
  assert.match(phoneChannel.buildMessage(event, 'es').body, /responde en la terminal/);
});

test('buildMessage: метка сессии не переводится, а подставляется как есть', () => {
  const event = { type: 'task_done', sessionLabel: 'Claude Code · мой-проект' };
  assert.match(phoneChannel.buildMessage(event, 'en').title, /Claude Code · мой-проект/);
});
