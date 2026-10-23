'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let server;
let base;
let db;

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-test-'));
  const app = createApp({ dataDir });
  db = app.locals.db;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

// 帶 cookie 的簡易瀏覽器
function browser() {
  let cookie = '';
  async function req(url, opts = {}) {
    const res = await fetch(base + url, {
      redirect: 'manual',
      ...opts,
      headers: { ...(opts.headers || {}), cookie },
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, location: res.headers.get('location'), text: bytes.toString('utf8'), bytes, headers: res.headers };
  }
  async function csrf(url = '/login') {
    const page = await req(url);
    const m = page.text.match(/name="_csrf" value="([^"]+)"/);
    return m && m[1];
  }
  async function post(url, fields, from) {
    const token = await csrf(from || url);
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...fields, _csrf: token })) {
      for (const item of [].concat(v)) body.append(k, item);
    }
    return req(url, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }
  async function login(username, password) {
    return post('/login', { username, password }, '/login');
  }
  return { req, csrf, post, login };
}

const admin = browser();
const worker = browser();
const boss = browser();
let workerRoleId;
let managerRoleId;
let jobId;

test('預設管理員登入後必須先改密碼', async () => {
  const bad = await admin.login('admin', 'wrong');
  assert.strictEqual(bad.status, 401);
  const ok = await admin.login('admin', 'admin1234');
  assert.strictEqual(ok.status, 302);
  const home = await admin.req('/');
  assert.strictEqual(home.location, '/account/password');
  const changed = await admin.post('/account/password', { current: 'admin1234', password: 'Admin#2026', password2: 'Admin#2026' });
  assert.strictEqual(changed.location, '/');
  assert.strictEqual((await admin.req('/')).status, 200);
});

test('沒有 CSRF token 的 POST 會被拒絕', async () => {
  const res = await admin.req('/admin/categories', {
    method: 'POST', body: new URLSearchParams({ name: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.strictEqual(res.status, 403);
});

test('管理者可自訂角色並把人放入角色', async () => {
  workerRoleId = db.prepare("SELECT id FROM roles WHERE name = '員工'").get().id;
  managerRoleId = db.prepare("SELECT id FROM roles WHERE name = '主管'").get().id;

  let r = await admin.post('/admin/users', {
    username: 'worker1', display_name: '王小明', password: 'worker1234', roles: [String(workerRoleId)],
  }, '/admin/users/new');
  assert.strictEqual(r.location, '/admin/users');
  r = await admin.post('/admin/users', {
    username: 'boss1', display_name: '陳主管', password: 'boss12345', roles: [String(managerRoleId)],
  }, '/admin/users/new');
  assert.strictEqual(r.location, '/admin/users');

  // 自訂角色：只能看全部工作，不能新增
  r = await admin.post('/admin/roles', {
    name: '稽核', description: '唯讀', permissions: ['jobs.view_all'],
  }, '/admin/roles/new');
  assert.strictEqual(r.location, '/admin/roles');
  const audit = db.prepare("SELECT id FROM roles WHERE name = '稽核'").get();
  assert.deepStrictEqual(
    db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(audit.id).map((x) => x.permission),
    ['jobs.view_all']
  );
});

test('不能移除最後一位系統管理員', async () => {
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const sysRole = db.prepare('SELECT id FROM roles WHERE is_system = 1').get().id;
  const r = await admin.post(`/admin/roles/${sysRole}`, { description: 'x', members: [] }, `/admin/roles/${sysRole}/edit`);
  assert.strictEqual(r.status, 400);
  assert.ok(db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?').get(adminId, sysRole));
});

test('員工登入、改密碼並新增含照片的工作回報', async () => {
  await worker.login('worker1', 'worker1234');
  await worker.post('/account/password', { current: 'worker1234', password: 'Worker#2026', password2: 'Worker#2026' });

  const token = await worker.csrf('/jobs/new');
  const cat = db.prepare('SELECT id FROM categories LIMIT 1').get().id;
  const form = new FormData();
  const fields = {
    _csrf: token, category_id: cat, title: '機房網路佈線', description: '更換 Cat6', address: '新北市板橋區文化路一段 1 號',
    work_date: '2026-10-23', start_time: '09:00', end_time: '12:00', status: '施工中', customer_name: '測試公司',
  };
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('photos_before', new Blob([PNG], { type: 'image/png' }), 'before.png');
  form.append('photos_after', new Blob([PNG], { type: 'image/png' }), 'after.png');
  form.append('photos_after', new Blob(['not an image'], { type: 'text/plain' }), 'evil.txt');
  const r = await worker.req(`/jobs?_csrf=${token}`, { method: 'POST', body: form, headers: { 'x-requested-with': 'XMLHttpRequest' } });
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  const { redirect } = JSON.parse(r.text);
  jobId = Number(redirect.split('/').pop());

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  assert.match(job.job_no, /^SY\d{8}-001$/);
  const photos = db.prepare('SELECT stage FROM job_photos WHERE job_id = ? ORDER BY id').all(jobId).map((p) => p.stage);
  assert.deepStrictEqual(photos, ['before', 'after']); // 非圖片檔被過濾

  const page = await worker.req(redirect);
  assert.match(page.text, /工作回報已建立/);
  assert.match(page.text, /機房網路佈線/);
  const photoId = db.prepare('SELECT id FROM job_photos WHERE job_id = ?').get(jobId).id;
  const img = await worker.req(`/photos/${photoId}`);
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
});

test('缺少必填欄位時不會建立工作', async () => {
  const r = await worker.post('/jobs', { title: '', description: '', address: '', work_date: '' }, '/jobs/new');
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /請填寫工作名稱/);
});

test('員工無法進入後台與查看他人工作', async () => {
  assert.strictEqual((await worker.req('/admin/users')).status, 403);
  assert.strictEqual((await worker.req('/admin/roles')).status, 403);
  assert.strictEqual((await worker.req('/jobs/export.csv')).status, 403);
  // scope=all 會被降級為只看自己的
  const list = await worker.req('/jobs?scope=all');
  assert.match(list.text, /我的工作/);
  assert.doesNotMatch(list.text, /工作歷史查詢<\/a>/);

  const bossId = db.prepare("SELECT id FROM users WHERE username = 'boss1'").get().id;
  const cat = db.prepare('SELECT id FROM categories LIMIT 1').get().id;
  const other = db.prepare(
    "INSERT INTO jobs (job_no, category_id, title, address, work_date, created_by) VALUES ('X-1', ?, '別人的工作', 'a', '2026-10-01', ?)"
  ).run(cat, bossId).lastInsertRowid;
  assert.strictEqual((await worker.req(`/jobs/${other}`)).status, 404);
});

test('主管可查詢歷史、審核、匯出；審核通過後員工不可再修改', async () => {
  await boss.login('boss1', 'boss12345');
  await boss.post('/account/password', { current: 'boss12345', password: 'Boss#20261', password2: 'Boss#20261' });

  const list = await boss.req('/jobs?scope=all&q=' + encodeURIComponent('板橋'));
  assert.match(list.text, /機房網路佈線/);
  assert.doesNotMatch(list.text, /別人的工作/);
  const none = await boss.req('/jobs?scope=all&from=2027-01-01');
  assert.match(none.text, /查無符合條件/);

  let r = await boss.post(`/jobs/${jobId}/review`, { review_status: '退回' }, `/jobs/${jobId}`);
  assert.strictEqual(db.prepare('SELECT review_status FROM jobs WHERE id = ?').get(jobId).review_status, '待審核');
  r = await boss.post(`/jobs/${jobId}/review`, { review_status: '已核可', review_comment: '施工確實' }, `/jobs/${jobId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(db.prepare('SELECT review_status FROM jobs WHERE id = ?').get(jobId).review_status, '已核可');

  assert.strictEqual((await worker.req(`/jobs/${jobId}/edit`)).status, 403);

  const csv = await boss.req('/jobs/export.csv?scope=all');
  assert.strictEqual(csv.status, 200);
  assert.ok(csv.text.startsWith('﻿"工作單號"'));
  assert.match(csv.text, /機房網路佈線/);
});

test('角色權限變更立即生效', async () => {
  // 拿掉員工角色的新增權限
  await admin.post(`/admin/roles/${workerRoleId}`, {
    name: '員工', description: '', permissions: ['jobs.view_own'],
    members: [String(db.prepare("SELECT id FROM users WHERE username = 'worker1'").get().id)],
  }, `/admin/roles/${workerRoleId}/edit`);
  assert.strictEqual((await worker.req('/jobs/new')).status, 403);
  assert.strictEqual((await worker.req(`/jobs/${jobId}`)).status, 200);
});

test('停用帳號後立即無法使用', async () => {
  const id = db.prepare("SELECT id FROM users WHERE username = 'worker1'").get().id;
  await admin.post(`/admin/users/${id}`, { display_name: '王小明', roles: [String(workerRoleId)] }, `/admin/users/${id}/edit`);
  const r = await worker.req('/');
  assert.strictEqual(r.location, '/login');
});
