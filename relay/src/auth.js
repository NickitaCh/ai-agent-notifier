'use strict';

// Bearer-токен на /events — тот самый token, что local-демон получил при
// пейринге (см. pairing-codes.js + server.js /pair/status). Возвращает
// пользователя из store или null, если заголовка нет/токен неизвестен.

const store = require('./store');

function authenticate(req, dataDir) {
  const header = req.headers.authorization || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return null;
  const token = match[1];
  const user = store.getUser(dataDir, token);
  if (!user) return null;
  return { token, ...user };
}

module.exports = { authenticate };
