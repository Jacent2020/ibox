'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { ALL_CODES } = require('./permissions');

const JOB_STATUSES = ['待施工', '施工中', '已完工', '暫停', '取消'];
const REVIEW_STATUSES = ['待審核', '已核可', '退回'];
const PHOTO_STAGES = [
  { code: 'before', label: '施工前' },
  { code: 'during', label: '施工中' },
  { code: 'after', label: '施工後' },
];
const DEFAULT_CATEGORIES = ['弱電工程', '網路佈線', '監視系統', '門禁系統', '消防設備', '設備維修', '例行保養', '其他'];

const SYSTEM_ADMIN_ROLE = '系統管理員';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  job_no TEXT NOT NULL UNIQUE,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  customer_name TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  work_date TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '待施工',
  materials TEXT NOT NULL DEFAULT '',
  issues TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT '待審核',
  review_comment TEXT NOT NULL DEFAULT '',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_work_date ON jobs(work_date);
CREATE INDEX IF NOT EXISTS idx_jobs_created_by ON jobs(created_by);

CREATE TABLE IF NOT EXISTS job_members (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, user_id)
);

CREATE TABLE IF NOT EXISTS job_photos (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('before', 'during', 'after')),
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_photos_job ON job_photos(job_id);

CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`;

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

// 首次啟動時建立預設角色、類別與管理員帳號。
function seed(db) {
  const roleCount = db.prepare('SELECT COUNT(*) AS n FROM roles').get().n;
  if (roleCount === 0) {
    const insertRole = db.prepare('INSERT INTO roles (name, description, is_system) VALUES (?, ?, ?)');
    const grant = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
    const defaults = [
      [SYSTEM_ADMIN_ROLE, '擁有全部權限，不可刪除', 1, ALL_CODES],
      ['主管', '可查詢、審核與匯出所有工作', 0,
        ['jobs.create', 'jobs.view_own', 'jobs.edit_own', 'jobs.view_all', 'jobs.edit_all', 'jobs.review', 'jobs.export', 'categories.manage']],
      ['員工', '現場施工人員，回報自己的工作', 0, ['jobs.create', 'jobs.view_own', 'jobs.edit_own']],
    ];
    db.transaction(() => {
      for (const [name, desc, isSystem, perms] of defaults) {
        const { lastInsertRowid } = insertRole.run(name, desc, isSystem);
        for (const p of perms) grant.run(lastInsertRowid, p);
      }
    })();
  }

  const catCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (catCount === 0) {
    const ins = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
    DEFAULT_CATEGORIES.forEach((name, i) => ins.run(name, (i + 1) * 10));
  }

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    const password = process.env.ADMIN_PASSWORD || 'admin1234';
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, display_name, password_hash, must_change_password) VALUES (?, ?, ?, 1)')
      .run('admin', '系統管理員', bcrypt.hashSync(password, 10));
    const adminRole = db.prepare('SELECT id FROM roles WHERE name = ?').get(SYSTEM_ADMIN_ROLE);
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(lastInsertRowid, adminRole.id);
    if (!process.env.ADMIN_PASSWORD) {
      console.log('已建立預設管理員帳號 admin / admin1234，首次登入後請立即變更密碼。');
    }
  }

  // 系統管理員角色永遠擁有全部權限（含日後新增的權限代碼）。
  const sysRole = db.prepare('SELECT id FROM roles WHERE is_system = 1').get();
  if (sysRole) {
    const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)');
    for (const p of ALL_CODES) grant.run(sysRole.id, p);
  }
}

module.exports = {
  openDatabase,
  JOB_STATUSES,
  REVIEW_STATUSES,
  PHOTO_STAGES,
  SYSTEM_ADMIN_ROLE,
};
