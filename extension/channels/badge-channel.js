'use strict';

// Канал 1 (замена toast). Раньше toast инжектился в активную вкладку через
// chrome.scripting.executeScript — это требовало host_permissions на все
// сайты. Chrome не даёт делать executeScript в фоне без пользовательского
// жеста или широкого host-permission, поэтому вместо инжекта — бейдж на
// иконке расширения: не требует permissions вообще, работает всегда,
// исчезает при открытии popup.

const COLORS = {
  permission_request: '#B8792A', // янтарный — нужно внимание
  task_done: '#2B5D63', // тил — просто к сведению
};

const TEXT = {
  permission_request: '!',
  task_done: '✓',
};

function show(event) {
  const color = COLORS[event.type] || '#63665F';
  const text = TEXT[event.type] || '•';
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

function clear() {
  chrome.action.setBadgeText({ text: '' });
}

self.BadgeChannel = { show, clear };
