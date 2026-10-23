'use strict';

const TZ = 'Asia/Taipei';

// SQLite datetime('now') 為 UTC 字串，顯示時轉成台灣時間
function formatDateTime(value) {
  if (!value) return '';
  const d = new Date(value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

function todayLocal() {
  // en-CA 會輸出 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function str(v, max = 2000) {
  if (v === undefined || v === null) return '';
  return String(Array.isArray(v) ? v[0] : v).trim().slice(0, max);
}

function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function isDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isTime(v) {
  return /^\d{2}:\d{2}$/.test(v);
}

module.exports = { formatDateTime, todayLocal, str, toArray, isDate, isTime };
