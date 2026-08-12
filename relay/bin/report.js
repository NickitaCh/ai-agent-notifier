#!/usr/bin/env node
'use strict';

// Сводка по метрикам релея. Запускать на VPS: `npm run report` из /opt/aan-relay
// (или `DATA_DIR=... node bin/report.js` для выгрузки, скопированной локально).
//
// Намеренно НЕ подключает src/config.js: тот падает при отсутствии BOT_TOKEN и
// WEBHOOK_SECRET, а для чтения статистики секреты не нужны — отчёт должен
// сниматься и с копии папки данных на машине, где их нет вовсе. Дефолт DATA_DIR
// продублирован здесь по этой же причине; он должен совпадать с config.js.

const path = require('path');
const store = require('../src/store');
const metrics = require('../src/metrics');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DAY_MS = 86400000;

function pct(part, total) {
  if (!total) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentile(numbers, p) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key === null || key === undefined) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // По убыванию — в отчёте сверху всегда самое массовое.
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function printDistribution(title, pairs, total) {
  console.log(`\n${title}`);
  if (!pairs.length) {
    console.log('  нет данных');
    return;
  }
  for (const [key, count] of pairs) {
    console.log(`  ${String(key).padEnd(22)} ${String(count).padStart(6)}  ${pct(count, total)}`);
  }
}

function main() {
  const now = Date.now();
  const users = Object.values(store.load(DATA_DIR));
  const counters = metrics.loadCounters(DATA_DIR);
  const records = metrics.readRecords(DATA_DIR);

  console.log(`AI Agent Notifier — сводка релея`);
  console.log(`Папка данных: ${DATA_DIR}`);
  console.log(`Снято: ${new Date(now).toISOString()}`);
  console.log(`Файлы метрик: ${metrics.listLogFiles(DATA_DIR).join(', ') || 'нет'}`);

  // --- юзеры и активность ---
  const activated = users.filter((u) => u.firstEventAt);
  const active7 = users.filter((u) => u.lastSeenAt && now - u.lastSeenAt < 7 * DAY_MS);
  const active30 = users.filter((u) => u.lastSeenAt && now - u.lastSeenAt < 30 * DAY_MS);
  console.log(`\n=== Юзеры ===`);
  console.log(`  всего привязано        ${users.length}`);
  console.log(`  дошли до 1-го события  ${activated.length}  (${pct(activated.length, users.length)})`);
  console.log(`  активны за 7 дней      ${active7.length}  (${pct(active7.length, users.length)})`);
  console.log(`  активны за 30 дней     ${active30.length}  (${pct(active30.length, users.length)})`);
  // Привязался и ни одного события — это не "неактивный юзер", а сломанный
  // онбординг: расширение получило токен, но до реальной работы не дошло.
  console.log(`  привязались, но молчат ${users.length - activated.length}`);

  // Ретеншен считаем только по тем, у кого была возможность вернуться:
  // юзер, привязавшийся вчера, в знаменателе всё испортил бы.
  const mature = users.filter((u) => u.createdAt && now - u.createdAt >= 14 * DAY_MS);
  const retained = mature.filter((u) => u.lastSeenAt && now - u.lastSeenAt < 7 * DAY_MS);
  console.log(
    `\n  ретеншен: из ${mature.length} юзеров старше 14 дней активны на этой неделе ${retained.length} (${pct(
      retained.length,
      mature.length
    )})`
  );

  // --- воронка пейринга ---
  const pair = counters.pair || {};
  console.log(`\n=== Воронка привязки ===`);
  console.log(`  нажали "Привязать"     ${pair.started || 0}`);
  console.log(`  довели до конца        ${pair.completed || 0}  (${pct(pair.completed || 0, pair.started || 0)})`);
  console.log(`  отказ по rate-limit    ${pair.rejected_rate || 0}`);
  console.log(`  упёрлись в кап юзеров  ${pair.rejected_cap || 0}`);
  console.log(`  NB: "нажали" считает нажатия, а не людей — повторные клики из-за`);
  console.log(`      непонятного статуса тоже сюда, разрыв читать как трение.`);

  // --- события ---
  const eventRecords = records.filter((r) => r.kind === 'event');
  const perUser = activated.map((u) => (u.events && u.events.total) || 0);
  console.log(`\n=== События ===`);
  console.log(`  всего                  ${counters.events?.total || eventRecords.length}`);
  console.log(`  на активного юзера     медиана ${median(perUser)}, максимум ${Math.max(0, ...perUser)}`);
  console.log(`  за 7 дней              ${eventRecords.filter((r) => now - r.ts < 7 * DAY_MS).length}`);
  printDistribution('  по типу:', countBy(eventRecords, (r) => r.type), eventRecords.length);
  printDistribution('  по агенту:', countBy(eventRecords, (r) => r.agent), eventRecords.length);
  printDistribution('  топ инструментов:', countBy(eventRecords, (r) => r.tool).slice(0, 10), eventRecords.length);

  // --- клиенты ---
  // Берём из записей юзеров, а не из лога: интересно, на чём люди сидят
  // сейчас, а по логу активный юзер перевесил бы редко пишущего.
  const clients = users.map((u) => u.client).filter(Boolean);
  console.log(`\n=== Клиенты (${clients.length} из ${users.length} юзеров прислали) ===`);
  printDistribution('  ОС:', countBy(clients, (c) => c.os), clients.length);
  printDistribution('  версия ОС:', countBy(clients, (c) => `${c.os}/${c.osVersion}`), clients.length);
  printDistribution('  архитектура:', countBy(clients, (c) => c.arch), clients.length);
  printDistribution('  версия хоста:', countBy(clients, (c) => c.hostVersion), clients.length);
  printDistribution('  способ установки:', countBy(clients, (c) => (c.packaged ? 'exe' : 'node')), clients.length);
  console.log(`\n  ВАЖНО: сюда попадают только юзеры общего бота (provider=relay).`);
  console.log(`  Свой ntfy/Pushover/свой бот и локальные установки до сервера не`);
  console.log(`  доходят вообще — доли по ОС смещены, абсолютные числа занижены.`);

  // --- решения ---
  const decisions = records.filter((r) => r.kind === 'decision');
  const latencies = decisions.map((r) => r.latencyMs).filter((ms) => typeof ms === 'number');
  console.log(`\n=== Решения ===`);
  const dc = counters.decisions || {};
  const decidedTotal = (dc.allow || 0) + (dc.deny || 0) + (dc.timeout || 0);
  console.log(`  разрешено              ${dc.allow || 0}  (${pct(dc.allow || 0, decidedTotal)})`);
  console.log(`  отклонено              ${dc.deny || 0}  (${pct(dc.deny || 0, decidedTotal)})`);
  console.log(`  не ответили (таймаут)  ${dc.timeout || 0}  (${pct(dc.timeout || 0, decidedTotal)})`);
  if (latencies.length) {
    console.log(`\n  время ответа: медиана ${(median(latencies) / 1000).toFixed(1)}с, p90 ${(percentile(latencies, 90) / 1000).toFixed(1)}с`);
    // Знаменатель — только замеренные решения: у таймаутов и у решений,
    // переживших рестарт процесса, латентности нет, и включать их в базу
    // процентов значило бы занижать все бакеты сразу.
    printDistribution(`  распределение (${latencies.length} с замером):`, countBy(decisions, (r) => r.bucket), latencies.length);
  }

  // --- ошибки доставки ---
  const errors = counters.deliveryErrors || {};
  const errorTotal = Object.values(errors).reduce((sum, n) => sum + n, 0);
  console.log(`\n=== Ошибки доставки (${errorTotal}) ===`);
  if (!errorTotal) {
    console.log('  нет');
  } else {
    for (const [reason, count] of Object.entries(errors).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason.padEnd(22)} ${String(count).padStart(6)}`);
    }
    if (errors.blocked) {
      console.log(`  NB: blocked — человек заблокировал бота. В users.json он всё ещё`);
      console.log(`      числится и в "всего привязано" выглядит живым.`);
    }
  }
  console.log('');
}

if (require.main === module) {
  main();
}

module.exports = { median, percentile, countBy };
