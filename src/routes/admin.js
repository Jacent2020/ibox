'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { requirePerm } = require('../middleware');
const { groupedPermissions, ALL_CODES } = require('../permissions');
const { str, toArray, formatDateTime } = require('../util');

const USERNAME_RE = /^[A-Za-z0-9._-]{3,30}$/;

module.exports = function adminRoutes(db) {
  const router = express.Router();

  function allRoles() {
    return db.prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
       FROM roles r ORDER BY r.is_system DESC, r.id`
    ).all();
  }

  function validRoleIds(input) {
    const ids = new Set(allRoles().map((r) => r.id));
    return [...new Set(toArray(input).map(Number))].filter((id) => ids.has(id));
  }

  // 防呆：系統中至少要保留一位啟用中的系統管理員，避免所有人被鎖在門外
  function activeAdminCount() {
    return db.prepare(
      `SELECT COUNT(DISTINCT u.id) AS n FROM users u
       JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       WHERE r.is_system = 1 AND u.is_active = 1`
    ).get().n;
  }

  // 在交易中執行變更，若會導致沒有任何系統管理員則整筆復原並回傳 false
  function guarded(change) {
    const ROLLBACK = new Error('rollback');
    try {
      db.transaction(() => {
        change();
        if (activeAdminCount() === 0) throw ROLLBACK;
      })();
      return true;
    } catch (err) {
      if (err === ROLLBACK) return false;
      throw err;
    }
  }

  // ================= 人員管理 =================
  const users = express.Router();
  users.use(requirePerm('users.manage'));

  users.get('/', (req, res) => {
    const list = db.prepare(
      `SELECT u.*, (SELECT GROUP_CONCAT(r.name, '、') FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS role_names
       FROM users u ORDER BY u.is_active DESC, u.display_name`
    ).all();
    res.render('admin/users', { title: '人員管理', list, formatDateTime });
  });

  users.get('/new', (req, res) => {
    res.render('admin/user-form', { title: '新增人員', u: { is_active: 1 }, userRoles: [], roles: allRoles(), isNew: true });
  });

  users.post('/', (req, res) => {
    const u = {
      username: str(req.body.username, 30),
      display_name: str(req.body.display_name, 50),
      phone: str(req.body.phone, 50),
      email: str(req.body.email, 100),
      is_active: 1,
    };
    const password = String(req.body.password || '').trim();
    const roleIds = validRoleIds(req.body.roles);
    const errors = [];
    if (!USERNAME_RE.test(u.username)) errors.push('帳號需為 3–30 個英數字（可含 . _ -）。');
    else if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) errors.push('此帳號已被使用。');
    if (!u.display_name) errors.push('請填寫姓名。');
    if (password.length < 8) errors.push('初始密碼至少需 8 個字元。');
    if (!roleIds.length) errors.push('請至少指派一個角色。');
    if (errors.length) {
      res.locals.flash = errors.map((text) => ({ type: 'error', text }));
      return res.status(400).render('admin/user-form', { title: '新增人員', u, userRoles: roleIds, roles: allRoles(), isNew: true });
    }
    db.transaction(() => {
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO users (username, display_name, phone, email, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, 1)'
      ).run(u.username, u.display_name, u.phone, u.email, bcrypt.hashSync(password, 10));
      const add = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');
      for (const r of roleIds) add.run(lastInsertRowid, r);
    })();
    req.flash('success', `已新增人員「${u.display_name}」，首次登入時會要求變更密碼。`);
    res.redirect('/admin/users');
  });

  function loadUser(req, res, next) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) return res.status(404).render('error', { title: '找不到人員', message: '此人員不存在。' });
    req.target = u;
    next();
  }

  users.get('/:id/edit', loadUser, (req, res) => {
    const userRoles = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(req.target.id).map((r) => r.role_id);
    res.render('admin/user-form', { title: '編輯人員', u: req.target, userRoles, roles: allRoles(), isNew: false });
  });

  users.post('/:id', loadUser, (req, res) => {
    const t = req.target;
    const u = {
      ...t,
      display_name: str(req.body.display_name, 50),
      phone: str(req.body.phone, 50),
      email: str(req.body.email, 100),
      is_active: req.body.is_active ? 1 : 0,
    };
    const password = String(req.body.password || '').trim();
    const roleIds = validRoleIds(req.body.roles);
    const errors = [];
    if (!u.display_name) errors.push('請填寫姓名。');
    if (password && password.length < 8) errors.push('新密碼至少需 8 個字元。');
    if (!roleIds.length) errors.push('請至少指派一個角色。');
    if (t.id === req.user.id && !u.is_active) errors.push('不能停用自己的帳號。');

    const render = () => res.status(400).render('admin/user-form', { title: '編輯人員', u, userRoles: roleIds, roles: allRoles(), isNew: false });
    if (errors.length) {
      res.locals.flash = errors.map((text) => ({ type: 'error', text }));
      return render();
    }

    const ok = guarded(() => {
      db.prepare('UPDATE users SET display_name = ?, phone = ?, email = ?, is_active = ? WHERE id = ?')
        .run(u.display_name, u.phone, u.email, u.is_active, t.id);
      if (password) {
        db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(bcrypt.hashSync(password, 10), t.id);
      }
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(t.id);
      const add = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');
      for (const r of roleIds) add.run(t.id, r);
    });
    if (!ok) {
      res.locals.flash = [{ type: 'error', text: '系統至少需保留一位啟用中的「系統管理員」，此變更已取消。' }];
      return render();
    }
    req.flash('success', `已更新人員「${u.display_name}」${password ? '，並重設密碼' : ''}。`);
    res.redirect('/admin/users');
  });

  router.use('/users', users);

  // ================= 角色與權限 =================
  const roles = express.Router();
  roles.use(requirePerm('roles.manage'));

  function activeUsers() {
    return db.prepare('SELECT id, display_name, username FROM users WHERE is_active = 1 ORDER BY display_name').all();
  }

  roles.get('/', (req, res) => {
    const list = allRoles();
    const perms = db.prepare('SELECT role_id, permission FROM role_permissions').all();
    for (const r of list) r.permissions = perms.filter((p) => p.role_id === r.id).map((p) => p.permission);
    res.render('admin/roles', { title: '角色與權限', list, groups: groupedPermissions() });
  });

  roles.get('/new', (req, res) => {
    res.render('admin/role-form', {
      title: '新增角色', role: {}, rolePerms: [], roleMembers: [], users: activeUsers(), groups: groupedPermissions(), isNew: true,
    });
  });

  function parseRole(req) {
    return {
      name: str(req.body.name, 30),
      description: str(req.body.description, 200),
      perms: [...new Set(toArray(req.body.permissions))].filter((p) => ALL_CODES.includes(p)),
      members: [...new Set(toArray(req.body.members).map(Number))]
        .filter((id) => db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)),
    };
  }

  function saveRole(roleId, r, isSystem) {
    db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ?').run(r.name, r.description, roleId);
    if (!isSystem) {
      db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
      const grant = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
      for (const p of r.perms) grant.run(roleId, p);
    }
    db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(roleId);
    const add = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');
    for (const m of r.members) add.run(m, roleId);
  }

  roles.post('/', (req, res) => {
    const r = parseRole(req);
    const errors = [];
    if (!r.name) errors.push('請填寫角色名稱。');
    else if (db.prepare('SELECT 1 FROM roles WHERE name = ?').get(r.name)) errors.push('角色名稱已存在。');
    if (errors.length) {
      res.locals.flash = errors.map((text) => ({ type: 'error', text }));
      return res.status(400).render('admin/role-form', {
        title: '新增角色', role: r, rolePerms: r.perms, roleMembers: r.members, users: activeUsers(), groups: groupedPermissions(), isNew: true,
      });
    }
    db.transaction(() => {
      const { lastInsertRowid } = db.prepare('INSERT INTO roles (name, description) VALUES (?, ?)').run(r.name, r.description);
      saveRole(lastInsertRowid, r, false);
    })();
    req.flash('success', `已新增角色「${r.name}」。`);
    res.redirect('/admin/roles');
  });

  function loadRole(req, res, next) {
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(Number(req.params.id));
    if (!role) return res.status(404).render('error', { title: '找不到角色', message: '此角色不存在。' });
    req.role = role;
    next();
  }

  roles.get('/:id/edit', loadRole, (req, res) => {
    const rolePerms = db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(req.role.id).map((p) => p.permission);
    const roleMembers = db.prepare('SELECT user_id FROM user_roles WHERE role_id = ?').all(req.role.id).map((m) => m.user_id);
    res.render('admin/role-form', {
      title: '編輯角色', role: req.role, rolePerms, roleMembers, users: activeUsers(), groups: groupedPermissions(), isNew: false,
    });
  });

  roles.post('/:id', loadRole, (req, res) => {
    const role = req.role;
    const isSystem = Boolean(role.is_system);
    const r = parseRole(req);
    if (isSystem) r.name = role.name; // 系統角色名稱與權限固定
    // 停用中的成員不會出現在表單上，保留其原本的角色
    const inactive = db.prepare(
      'SELECT ur.user_id FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = ? AND u.is_active = 0'
    ).all(role.id).map((x) => x.user_id);
    r.members = [...new Set([...r.members, ...inactive])];

    const errors = [];
    if (!r.name) errors.push('請填寫角色名稱。');
    else if (db.prepare('SELECT 1 FROM roles WHERE name = ? AND id <> ?').get(r.name, role.id)) errors.push('角色名稱已存在。');
    const rerender = () => res.status(400).render('admin/role-form', {
      title: '編輯角色', role: { ...role, ...r }, rolePerms: isSystem ? ALL_CODES : r.perms, roleMembers: r.members,
      users: activeUsers(), groups: groupedPermissions(), isNew: false,
    });
    if (errors.length) {
      res.locals.flash = errors.map((text) => ({ type: 'error', text }));
      return rerender();
    }
    const ok = guarded(() => saveRole(role.id, r, isSystem));
    if (!ok) {
      res.locals.flash = [{ type: 'error', text: '「系統管理員」角色至少需保留一位啟用中的成員。' }];
      return rerender();
    }
    req.flash('success', `已更新角色「${r.name}」。`);
    res.redirect('/admin/roles');
  });

  roles.post('/:id/delete', loadRole, (req, res) => {
    if (req.role.is_system) {
      req.flash('error', '系統管理員角色不可刪除。');
    } else {
      db.prepare('DELETE FROM roles WHERE id = ?').run(req.role.id);
      req.flash('success', `已刪除角色「${req.role.name}」。`);
    }
    res.redirect('/admin/roles');
  });

  router.use('/roles', roles);

  // ================= 工作類別 =================
  const cats = express.Router();
  cats.use(requirePerm('categories.manage'));

  cats.get('/', (req, res) => {
    const list = db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM jobs j WHERE j.category_id = c.id) AS job_count
       FROM categories c ORDER BY c.sort_order, c.id`
    ).all();
    res.render('admin/categories', { title: '工作類別', list });
  });

  cats.post('/', (req, res) => {
    const name = str(req.body.name, 30);
    if (!name) req.flash('error', '請輸入類別名稱。');
    else if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name)) req.flash('error', '類別名稱已存在。');
    else {
      const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories').get().m;
      db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(name, max + 10);
      req.flash('success', `已新增類別「${name}」。`);
    }
    res.redirect('/admin/categories');
  });

  cats.post('/:id', (req, res) => {
    const id = Number(req.params.id);
    const name = str(req.body.name, 30);
    const sort = Number(req.body.sort_order) || 0;
    const active = req.body.is_active ? 1 : 0;
    if (!name) req.flash('error', '類別名稱不可空白。');
    else if (db.prepare('SELECT 1 FROM categories WHERE name = ? AND id <> ?').get(name, id)) req.flash('error', '類別名稱已存在。');
    else {
      db.prepare('UPDATE categories SET name = ?, sort_order = ?, is_active = ? WHERE id = ?').run(name, sort, active, id);
      req.flash('success', '類別已更新。');
    }
    res.redirect('/admin/categories');
  });

  cats.post('/:id/delete', (req, res) => {
    const id = Number(req.params.id);
    const used = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE category_id = ?').get(id).n;
    if (used) req.flash('error', `此類別已有 ${used} 筆工作使用，無法刪除，可改為「停用」。`);
    else {
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      req.flash('success', '類別已刪除。');
    }
    res.redirect('/admin/categories');
  });

  router.use('/categories', cats);

  return router;
};
