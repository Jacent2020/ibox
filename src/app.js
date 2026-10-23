'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { openDatabase } = require('./db');
const SqliteStore = require('./session-store');
const { loadUser, requireLogin, csrf, flash } = require('./middleware');

const SITE_NAME = '莘藝科技工程施工回報站';

function sessionSecret(dataDir) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, 'session-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

function createApp({ dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data') } = {}) {
  const db = openDatabase(dataDir);
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy && trustProxy !== 'false') app.set('trust proxy', trustProxy === 'true' ? true : trustProxy);

  app.locals.siteName = SITE_NAME;
  app.locals.badgeClass = {
    待施工: 'gray', 施工中: 'blue', 已完工: 'green', 暫停: 'orange', 取消: 'muted',
    待審核: 'yellow', 已核可: 'green', 退回: 'red',
  };

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(session({
    store: new SqliteStore(db),
    secret: sessionSecret(dataDir),
    name: 'sy.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 12 * 60 * 60 * 1000, // 閒置 12 小時後需重新登入
    },
  }));
  app.use(flash);
  app.use(loadUser(db));
  app.use((req, res, next) => {
    res.locals.path = req.path;
    res.locals.title = '';
    next();
  });
  app.use(csrf);

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(require('./routes/auth')(db));
  app.use(requireLogin);
  app.use(require('./routes/jobs')(db, uploadDir));
  app.use('/admin', require('./routes/admin')(db));

  app.use((req, res) => {
    res.status(404).render('error', { title: '找不到頁面', message: '您要找的頁面不存在。' });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: '系統錯誤', message: '系統發生錯誤，請稍後再試或聯絡管理員。' });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
