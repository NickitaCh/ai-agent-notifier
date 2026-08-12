'use strict';

// Сбор продуктовых метрик релея. Два уровня хранения, оба на диске рядом с
// users.json — по тем же причинам, по которым store.js не тащит БД (см. его
// шапку): десятки-сотни юзеров, файлы читаются глазами при отладке.
//
// 1) Роллап в самой записи юзера (users.json): lastSeenAt, счётчики событий и
//    решений, последний клиент. Нужен онлайн — на нём потом будут строиться
//    лимиты тарифа, а гонять ради этого весь лог нельзя.
// 2) Append-only metrics-YYYY-MM.ndjson: по строке на факт. Предагрегация
//    отвечает только на вопросы, придуманные заранее, а вопросы к моменту
//    монетизации ещё не все известны — сырой лог позволяет посчитать
//    задним числом что угодно (см. bin/report.js).
//
// Чего здесь НЕТ и быть не должно: summary события, cwd (это пути в файловой
// системе юзера), текста команд, chatId. Из идентификаторов — только uid,
// необратимый хеш токена (см. hashUid): его хватает, чтобы отличать юзеров
// друг от друга и считать ретеншен, но по самому логу нельзя ни написать
// человеку, ни выдать себя за него.
//
// Любая ошибка здесь ГЛУШИТСЯ (см. safely): метрика не должна ломать
// доставку уведомлений. Забитый диск — это потерянная строчка статистики, а
// не пропущенный запрос разрешения у агента.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const COUNTERS_FILE = 'counters.json';
const SALT_FILE = 'metrics-salt';
// Сколько месячных файлов держим. Полгода хватает, чтобы увидеть сезонность
// и посчитать ретеншен, и при этом не хранить бессрочно то, что обещали в
// политике приватности удалять (см. PRIVACY.md).
const KEEP_MONTHS = 6;

function safely(label, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    console.error(`[metrics] ${label} упало (метрика потеряна, работа продолжается): ${err.message}`);
    return fallback;
  }
}

// Соль постоянная и лежит на сервере отдельно от лога — без неё uid нельзя
// сопоставить с токеном даже перебором (токен 24 байта, но соль защищает от
// сопоставления двух выгрузок между собой, если лог куда-то утечёт).
function loadSalt(dataDir) {
  const target = path.join(dataDir, SALT_FILE);
  try {
    return fs.readFileSync(target, 'utf8').trim();
  } catch {
    const salt = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(target, salt, { encoding: 'utf8', mode: 0o600 });
    return salt;
  }
}

function hashUid(dataDir, token) {
  return crypto
    .createHash('sha256')
    .update(`${loadSalt(dataDir)}:${token}`)
    .digest('hex')
    .slice(0, 12);
}

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function logPath(dataDir, ts) {
  return path.join(dataDir, `metrics-${monthKey(ts)}.ndjson`);
}

function append(dataDir, record, now) {
  safely('запись в ndjson', () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(logPath(dataDir, now), `${JSON.stringify({ ts: now, ...record })}\n`, 'utf8');
  });
}

// --- глобальные счётчики (воронка, отказы) --------------------------------

function loadCounters(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, COUNTERS_FILE), 'utf8'));
  } catch (err) {
    // Отсутствие файла — норма до первого счётчика (и на каждом свежем
    // деплое), через safely() это писало бы пугающую ошибку в лог на самом
    // первом событии. Всё остальное (битый JSON, права) — уже настоящий сбой.
    if (err.code !== 'ENOENT') {
      console.error(`[metrics] чтение counters.json упало, считаю пустым: ${err.message}`);
    }
    return {};
  }
}

// Путь вида 'pair.completed' — чтобы не заводить отдельную функцию на каждый
// счётчик и не плодить копипасту load/мутация/save.
function bump(dataDir, dottedPath, by = 1) {
  safely('инкремент счётчика', () => {
    const counters = loadCounters(dataDir);
    const keys = dottedPath.split('.');
    let node = counters;
    for (const key of keys.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
      node = node[key];
    }
    const last = keys[keys.length - 1];
    node[last] = (node[last] || 0) + by;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, COUNTERS_FILE), JSON.stringify(counters, null, 2), 'utf8');
  });
}

// --- роллап в записи юзера -------------------------------------------------

function patchUser(dataDir, token, patch) {
  safely('обновление записи юзера', () => {
    const users = store.load(dataDir);
    const user = users[token];
    // Юзера могли отвязать между запросом и записью — тогда просто нечего
    // обновлять, воскрешать удалённую запись метрикой точно не надо.
    if (!user) return;
    patch(user);
    store.save(dataDir, users);
  });
}

// --- латентность -----------------------------------------------------------

// Бакеты, а не сырые миллисекунды в роллапе: точное распределение всё равно
// считается по ndjson, а здесь важно только "успел человек среагировать или
// нет". Границы выбраны по смыслу, а не круглые: 5с — успел, пока смотрит на
// экран; 30с — телефон в кармане, достал; 5мин — отошёл и вернулся; дальше
// уже почти наверняка таймаут хука.
function latencyBucket(ms) {
  if (ms < 5000) return 'lt5s';
  if (ms < 30000) return 'lt30s';
  if (ms < 300000) return 'lt5m';
  return 'gte5m';
}

// eventId -> { uid, token, agent, startedAt } для событий, по которым ждём
// решения. Живёт в памяти: запись гарантированно снимается в recordDecision,
// который вызывается и по кнопке, и по таймауту (см. pending-decisions —
// resolveDecision срабатывает ровно один раз на событие). Переживать
// рестарт процесса тут нечему: незавершённые ожидания рестарт всё равно
// обрывает, и на стороне хоста они отваливаются в fail-open.
const inFlight = new Map();

// --- публичный интерфейс ---------------------------------------------------

function recordEvent(dataDir, token, event, now = Date.now()) {
  const uid = safely('хеширование uid', () => hashUid(dataDir, token), null);
  if (!uid) return null;
  const client = event.client || {};

  patchUser(dataDir, token, (user) => {
    user.lastSeenAt = now;
    // Момент, когда юзер перешёл из "привязался" в "реально пользуется" —
    // без него привязка и активация в воронке неотличимы.
    if (!user.firstEventAt) user.firstEventAt = now;
    user.events = user.events || {};
    user.events.total = (user.events.total || 0) + 1;
    user.events[event.type] = (user.events[event.type] || 0) + 1;
    if (event.agent) {
      user.agents = user.agents || {};
      user.agents[event.agent] = (user.agents[event.agent] || 0) + 1;
    }
    // Клиент перезаписываем целиком: интересно текущее состояние (на чём
    // человек сидит сейчас), а не история его переустановок.
    if (event.client) user.client = event.client;
  });

  bump(dataDir, 'events.total');
  append(
    dataDir,
    {
      kind: 'event',
      uid,
      type: event.type,
      agent: event.agent || null,
      tool: event.tool || null,
      os: client.os || null,
      osVersion: client.osVersion || null,
      arch: client.arch || null,
      hostVersion: client.hostVersion || null,
      packaged: client.packaged === undefined ? null : client.packaged,
    },
    now
  );
  return uid;
}

// Запоминаем начало ожидания решения. uid берём готовым из recordEvent, чтобы
// не хешировать токен второй раз на то же событие.
function trackActionable(eventId, uid, agent, now = Date.now()) {
  if (!uid) return;
  inFlight.set(eventId, { uid, agent: agent || null, startedAt: now });
}

// outcome: 'allow' | 'deny' | 'timeout'
function recordDecision(dataDir, eventId, outcome, now = Date.now()) {
  const pending = inFlight.get(eventId);
  inFlight.delete(eventId);
  bump(dataDir, `decisions.${outcome}`);
  // Решение по событию, которого мы не отслеживали (рестарт процесса между
  // отправкой и нажатием) — сам исход всё равно ценен, теряем только
  // латентность и привязку к юзеру.
  const latencyMs = pending ? now - pending.startedAt : null;
  append(
    dataDir,
    {
      kind: 'decision',
      uid: pending ? pending.uid : null,
      agent: pending ? pending.agent : null,
      outcome,
      latencyMs,
      bucket: latencyMs === null ? null : latencyBucket(latencyMs),
    },
    now
  );
}

// stage: 'started' | 'completed' | 'rejected_cap' | 'rejected_rate'
//
// Про 'started' vs 'completed': один и тот же человек может нажать "Привязать"
// несколько раз подряд (ровно это и было живым багом — попап закрывался, и
// казалось, что ничего не происходит). Так что started > completed — это не
// обязательно разные люди, это в том числе и трение онбординга. Читать разрыв
// нужно именно так, а не как "столько юзеров мы потеряли".
function recordPairing(dataDir, stage, now = Date.now()) {
  bump(dataDir, `pair.${stage}`);
  append(dataDir, { kind: 'pair', stage }, now);
}

// Отдельно от прочих ошибок: 403 "bot was blocked" — это не сбой доставки, а
// сигнал оттока (человек заблокировал бота, но остался в users.json и в
// статистике выглядит как живой юзер).
function classifyDeliveryError(message) {
  const text = String(message).toLowerCase();
  if (text.includes('blocked by the user')) return 'blocked';
  if (text.includes('chat not found')) return 'chat_not_found';
  if (text.includes('deactivated')) return 'deactivated';
  return 'other';
}

function recordDeliveryError(dataDir, token, message, now = Date.now()) {
  const reason = classifyDeliveryError(message);
  bump(dataDir, `deliveryErrors.${reason}`);
  const uid = safely('хеширование uid', () => hashUid(dataDir, token), null);
  append(dataDir, { kind: 'delivery_error', uid, reason }, now);
}

// --- чтение и уборка (для bin/report.js и старта сервера) ------------------

function listLogFiles(dataDir) {
  try {
    return fs
      .readdirSync(dataDir)
      .filter((name) => /^metrics-\d{4}-\d{2}\.ndjson$/.test(name))
      .sort();
  } catch (err) {
    // Папки данных ещё нет — норма на свежем деплое, см. loadCounters.
    if (err.code !== 'ENOENT') console.error(`[metrics] листинг метрик упал: ${err.message}`);
    return [];
  }
}

function readRecords(dataDir) {
  const records = [];
  for (const name of listLogFiles(dataDir)) {
    safely(`чтение ${name}`, () => {
      const text = fs.readFileSync(path.join(dataDir, name), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        // Битую строку пропускаем молча: append не атомарен, и обрыв
        // процесса ровно в момент записи может оставить хвост без \n.
        try {
          records.push(JSON.parse(line));
        } catch {
          /* пропускаем */
        }
      }
    });
  }
  return records;
}

function pruneOldMonths(dataDir, keepMonths = KEEP_MONTHS) {
  const files = listLogFiles(dataDir);
  // Имена отсортированы лексикографически, что для YYYY-MM совпадает с
  // хронологией — специально поэтому в имени и нули впереди месяца.
  const stale = files.slice(0, Math.max(0, files.length - keepMonths));
  for (const name of stale) {
    safely(`удаление ${name}`, () => {
      fs.unlinkSync(path.join(dataDir, name));
      console.log(`[metrics] удалён устаревший файл метрик ${name} (храним ${keepMonths} мес.)`);
    });
  }
  return stale;
}

module.exports = {
  recordEvent,
  trackActionable,
  recordDecision,
  recordPairing,
  recordDeliveryError,
  classifyDeliveryError,
  latencyBucket,
  hashUid,
  loadCounters,
  readRecords,
  listLogFiles,
  pruneOldMonths,
  monthKey,
  KEEP_MONTHS,
};
