'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pairingCodes = require('../src/pairing-codes');

test('createCode: возвращает код, getCode находит его непретендованным', () => {
  const code = pairingCodes.createCode(60000);
  const entry = pairingCodes.getCode(code);
  assert.ok(entry);
  assert.equal(entry.token, null);
});

test('getCode: неизвестный код -> null', () => {
  assert.equal(pairingCodes.getCode('никогда-не-существовавший'), null);
});

test('getCode: просроченный код -> null, даже если формально ещё в памяти', async () => {
  const code = pairingCodes.createCode(5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pairingCodes.getCode(code), null);
});

test('claimCode: привязывает токен к коду, дальнейший getCode его видит', () => {
  const code = pairingCodes.createCode(60000);
  const ok = pairingCodes.claimCode(code, 'tok-123');
  assert.equal(ok, true);
  assert.equal(pairingCodes.getCode(code).token, 'tok-123');
});

test('claimCode: для неизвестного/просроченного кода возвращает false', () => {
  assert.equal(pairingCodes.claimCode('нет-такого', 'tok'), false);
});
