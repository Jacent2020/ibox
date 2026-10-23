'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { requireLogin } = require('../middleware');
const { str } = require('../util');

const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

module.exports = function authRoutes(db) {
  const router = express.Router();
  const fails = new Map(); // 簡易登入失敗計數，防止暴力破解

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.render('login', { title: '登入', username: '' });
  });

  router.post('/login', (req, res, next) => {
    const username = str(req.body.username, 50);
    const password = String(req.body.password || '');
    const key = `${req.ip}|${username.toLowerCase()}`;
    const record = fails.get(key);
    if (record && record.count >= MAX_FAILS && Date.now() - record.at < LOCK_MS) {
      res.locals.flash = [{ type: 'error', text: '登入失敗次數過多，請 15 分鐘後再試。' }];
      return res.status(429).render('login', { title: '登入', username });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !user.is_active || !bcrypt.compareSync(password, user.password_hash)) {
      const count = record && Date.now() - record.at < LOCK_MS ? record.count + 1 : 1;
      fails.set(key, { count, at: Date.now() });
      res.locals.flash = [{ type: 'error', text: '帳號或密碼錯誤，或帳號已停用。' }];
      return res.status(401).render('login', { title: '登入', username });
    }

    fails.delete(key);
    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
      const safe = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//');
      res.redirect(safe ? returnTo : '/');
    });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  router.get('/account/password', requireLogin, (req, res) => {
    res.render('account/password', { title: '變更密碼' });
  });

  router.post('/account/password', requireLogin, (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const current = String(req.body.current || '');
    const next1 = String(req.body.password || '');
    const next2 = String(req.body.password2 || '');
    let error = null;
    if (!bcrypt.compareSync(current, row.password_hash)) error = '目前密碼不正確。';
    else if (next1.length < 8) error = '新密碼至少需 8 個字元。';
    else if (next1 !== next2) error = '兩次輸入的新密碼不一致。';
    else if (next1 === current) error = '新密碼不可與目前密碼相同。';
    if (error) {
      res.locals.flash = [{ type: 'error', text: error }];
      return res.status(400).render('account/password', { title: '變更密碼' });
    }
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(bcrypt.hashSync(next1, 10), req.user.id);
    req.flash('success', '密碼已更新。');
    res.redirect('/');
  });

  return router;
};
