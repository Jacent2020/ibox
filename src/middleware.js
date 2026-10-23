'use strict';

const crypto = require('crypto');

function loadUser(db) {
  const userStmt = db.prepare(
    'SELECT id, username, display_name, is_active, must_change_password FROM users WHERE id = ?'
  );
  const permStmt = db.prepare(
    `SELECT DISTINCT rp.permission FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = ?`
  );
  const roleStmt = db.prepare(
    'SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.id'
  );

  return (req, res, next) => {
    req.user = null;
    if (req.session.userId) {
      const user = userStmt.get(req.session.userId);
      if (user && user.is_active) {
        user.permissions = new Set(permStmt.all(user.id).map((r) => r.permission));
        user.roles = roleStmt.all(user.id).map((r) => r.name);
        req.user = user;
      } else {
        delete req.session.userId;
      }
    }
    res.locals.user = req.user;
    res.locals.can = (...codes) => !!req.user && codes.some((c) => req.user.permissions.has(c));
    req.can = res.locals.can;
    next();
  };
}

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  // 預設密碼或被重設密碼的帳號必須先改密碼
  if (req.user.must_change_password && !req.path.startsWith('/account/password') && req.path !== '/logout') {
    return res.redirect('/account/password');
  }
  next();
}

// 擁有其中任一權限即可通過
function requirePerm(...codes) {
  return (req, res, next) => {
    if (!req.can(...codes)) {
      return res.status(403).render('error', { title: '權限不足', message: '您的角色沒有使用此功能的權限，請洽系統管理員。' });
    }
    next();
  };
}

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // multipart 表單在 multer 解析前讀不到 body，因此也接受 query 或 header 帶入
  const token = (req.body && req.body._csrf) || req.query._csrf || req.get('x-csrf-token');
  const expected = Buffer.from(req.session.csrf);
  const given = Buffer.from(String(token || ''));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(403).render('error', { title: '表單已過期', message: '請重新整理頁面後再送出一次。' });
  }
  next();
}

function flash(req, res, next) {
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  req.flash = (type, text) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, text });
  };
  next();
}

module.exports = { loadUser, requireLogin, requirePerm, csrf, flash };
