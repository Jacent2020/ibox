'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { requirePerm } = require('../middleware');
const { JOB_STATUSES, REVIEW_STATUSES, PHOTO_STAGES } = require('../db');
const { str, toArray, isDate, isTime, todayLocal, formatDateTime } = require('../util');

const PAGE_SIZE = 20;
const STAGE_CODES = PHOTO_STAGES.map((s) => s.code);
const STAGE_LABEL = Object.fromEntries(PHOTO_STAGES.map((s) => [s.code, s.label]));
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

// 表單欄位定義：用於驗證、更新與異動紀錄
const FIELDS = [
  { key: 'category_id', label: '工作類別' },
  { key: 'title', label: '工作名稱', max: 100 },
  { key: 'description', label: '工作簡述', max: 2000 },
  { key: 'address', label: '施工地址', max: 200 },
  { key: 'customer_name', label: '客戶 / 業主', max: 100 },
  { key: 'contact_name', label: '現場聯絡人', max: 50 },
  { key: 'contact_phone', label: '聯絡電話', max: 50 },
  { key: 'work_date', label: '施工日期' },
  { key: 'start_time', label: '開始時間' },
  { key: 'end_time', label: '結束時間' },
  { key: 'status', label: '進度狀態' },
  { key: 'materials', label: '使用材料 / 設備', max: 2000 },
  { key: 'issues', label: '異常狀況 / 待辦', max: 2000 },
  { key: 'notes', label: '備註', max: 2000 },
  { key: 'latitude', label: '緯度' },
  { key: 'longitude', label: '經度' },
];

module.exports = function jobRoutes(db, uploadDir) {
  const router = express.Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        const now = new Date();
        const sub = path.join(String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
        const dir = path.join(uploadDir, sub);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename(req, file, cb) {
        cb(null, crypto.randomBytes(16).toString('hex') + IMAGE_TYPES[file.mimetype]);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024, files: 60 },
    fileFilter(req, file, cb) {
      cb(null, Boolean(IMAGE_TYPES[file.mimetype]));
    },
  });

  const photoFields = upload.fields(STAGE_CODES.map((s) => ({ name: `photos_${s}`, maxCount: 20 })));
  const singleStageField = upload.array('photos', 20);

  // 將 multer 的錯誤轉成友善訊息
  function handleUpload(mw) {
    return (req, res, next) => {
      mw(req, res, (err) => {
        if (!err) return next();
        const text = err.code === 'LIMIT_FILE_SIZE' ? '單張照片不可超過 20MB。'
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? '照片數量過多，每個階段最多 20 張。'
          : '照片上傳失敗：' + err.message;
        res.status(400).render('error', { title: '上傳失敗', message: text });
      });
    };
  }

  // 上傳表單由前端以 XHR 送出時回傳 JSON，讓頁面自行轉址（保留提示訊息）
  function redirect(req, res, url) {
    if (req.get('x-requested-with') === 'XMLHttpRequest') return res.json({ redirect: url });
    res.redirect(url);
  }

  function uploadedFiles(req) {
    if (!req.files) return [];
    if (Array.isArray(req.files)) return req.files;
    return Object.values(req.files).flat();
  }

  function removeFiles(files) {
    for (const f of files) fs.rm(f.path, { force: true }, () => {});
  }

  const insertPhoto = db.prepare(
    'INSERT INTO job_photos (job_id, stage, filename, original_name, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertLog = db.prepare('INSERT INTO job_logs (job_id, user_id, action, detail) VALUES (?, ?, ?, ?)');

  function savePhotos(jobId, stage, files, userId) {
    for (const f of files) {
      const rel = path.relative(uploadDir, f.path).split(path.sep).join('/');
      insertPhoto.run(jobId, stage, rel, f.originalname.slice(0, 200), f.mimetype, f.size, userId);
    }
  }

  function activeCategories() {
    return db.prepare('SELECT id, name FROM categories WHERE is_active = 1 ORDER BY sort_order, id').all();
  }

  function activeUsers() {
    return db.prepare('SELECT id, display_name, username FROM users WHERE is_active = 1 ORDER BY display_name').all();
  }

  function getJob(id) {
    return db.prepare(
      `SELECT j.*, c.name AS category_name, u.display_name AS creator_name, r.display_name AS reviewer_name
       FROM jobs j
       JOIN categories c ON c.id = j.category_id
       JOIN users u ON u.id = j.created_by
       LEFT JOIN users r ON r.id = j.reviewed_by
       WHERE j.id = ?`
    ).get(id);
  }

  function memberIds(jobId) {
    return db.prepare('SELECT user_id FROM job_members WHERE job_id = ?').all(jobId).map((r) => r.user_id);
  }

  function isMember(req, job) {
    return job.created_by === req.user.id || memberIds(job.id).includes(req.user.id);
  }

  function canView(req, job) {
    return req.can('jobs.view_all') || (req.can('jobs.view_own') && isMember(req, job));
  }

  function canEdit(req, job) {
    if (req.can('jobs.edit_all')) return true;
    return req.can('jobs.edit_own') && isMember(req, job) && job.review_status !== '已核可';
  }

  function loadJob(req, res, next) {
    const id = Number(req.params.id);
    const job = Number.isInteger(id) ? getJob(id) : null;
    if (!job || !canView(req, job)) {
      return res.status(404).render('error', { title: '找不到工作', message: '此工作不存在，或您沒有查看權限。' });
    }
    req.job = job;
    next();
  }

  // 解析並驗證表單，回傳 { values, members, errors }
  function parseJobForm(req) {
    const b = req.body || {};
    const v = {};
    for (const f of FIELDS) v[f.key] = str(b[f.key], f.max || 200);
    const errors = [];

    v.category_id = Number(v.category_id);
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(v.category_id)) errors.push('請選擇工作類別。');
    if (!v.title) errors.push('請填寫工作名稱。');
    if (!v.description) errors.push('請填寫工作簡述。');
    if (!v.address) errors.push('請填寫施工地址。');
    if (!isDate(v.work_date)) errors.push('請選擇施工日期。');
    if (v.start_time && !isTime(v.start_time)) errors.push('開始時間格式不正確。');
    if (v.end_time && !isTime(v.end_time)) errors.push('結束時間格式不正確。');
    if (v.start_time && v.end_time && v.end_time < v.start_time) errors.push('結束時間不可早於開始時間。');
    if (!JOB_STATUSES.includes(v.status)) v.status = JOB_STATUSES[0];
    for (const k of ['latitude', 'longitude']) {
      const n = v[k] === '' ? null : Number(v[k]);
      v[k] = Number.isFinite(n) ? n : null;
    }

    const validUsers = new Set(activeUsers().map((u) => u.id));
    const members = [...new Set(toArray(b.members).map(Number))].filter((id) => validUsers.has(id));
    return { values: v, members, errors };
  }

  function nextJobNo() {
    const prefix = 'SY' + todayLocal().replace(/-/g, '') + '-';
    const row = db.prepare('SELECT job_no FROM jobs WHERE job_no LIKE ? ORDER BY job_no DESC LIMIT 1').get(prefix + '%');
    const seq = row ? Number(row.job_no.slice(prefix.length)) + 1 : 1;
    return prefix + String(seq).padStart(3, '0');
  }

  function renderForm(res, opts) {
    res.render('jobs/form', {
      categories: activeCategories(),
      users: activeUsers(),
      statuses: JOB_STATUSES,
      stages: PHOTO_STAGES,
      ...opts,
    });
  }

  // ---------- 首頁儀表板 ----------
  router.get('/', (req, res) => {
    const uid = req.user.id;
    const mineWhere = '(j.created_by = @uid OR EXISTS (SELECT 1 FROM job_members m WHERE m.job_id = j.id AND m.user_id = @uid))';
    const recent = req.can('jobs.view_own', 'jobs.view_all') ? db.prepare(
      `SELECT j.id, j.job_no, j.title, j.status, j.review_status, j.work_date, j.address, c.name AS category_name
       FROM jobs j JOIN categories c ON c.id = j.category_id
       WHERE ${mineWhere} ORDER BY j.id DESC LIMIT 8`
    ).all({ uid }) : [];

    let stats = null;
    if (req.can('jobs.view_all')) {
      const today = todayLocal();
      stats = db.prepare(
        `SELECT
           SUM(work_date = @today) AS today,
           SUM(status = '施工中') AS in_progress,
           SUM(status = '已完工' AND review_status = '待審核') AS pending_review,
           SUM(review_status = '退回') AS rejected,
           COUNT(*) AS total
         FROM jobs`
      ).get({ today });
    }
    res.render('dashboard', { title: '首頁', recent, stats, formatDateTime });
  });

  // ---------- 列表與查詢 ----------
  function buildFilter(req) {
    const q = req.query;
    const scope = q.scope === 'all' && req.can('jobs.view_all') ? 'all' : 'mine';
    const where = [];
    const params = { uid: req.user.id };
    if (scope === 'mine') {
      where.push('(j.created_by = @uid OR EXISTS (SELECT 1 FROM job_members m WHERE m.job_id = j.id AND m.user_id = @uid))');
    }
    const f = {
      scope,
      q: str(q.q, 100),
      category: str(q.category, 10),
      status: str(q.status, 10),
      review: str(q.review, 10),
      member: str(q.member, 10),
      from: str(q.from, 10),
      to: str(q.to, 10),
    };
    if (f.q) {
      const cols = ['j.job_no', 'j.title', 'j.description', 'j.address', 'j.customer_name', 'j.issues', 'j.notes'];
      where.push('(' + cols.map((c) => `${c} LIKE @kw ESCAPE '\\'`).join(' OR ') + ')');
      params.kw = '%' + f.q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    }
    if (f.category) { where.push('j.category_id = @category'); params.category = Number(f.category); }
    if (JOB_STATUSES.includes(f.status)) { where.push('j.status = @status'); params.status = f.status; }
    if (REVIEW_STATUSES.includes(f.review)) { where.push('j.review_status = @review'); params.review = f.review; }
    if (f.member && scope === 'all') {
      where.push('(j.created_by = @member OR EXISTS (SELECT 1 FROM job_members m2 WHERE m2.job_id = j.id AND m2.user_id = @member))');
      params.member = Number(f.member);
    }
    if (isDate(f.from)) { where.push('j.work_date >= @from'); params.from = f.from; }
    if (isDate(f.to)) { where.push('j.work_date <= @to'); params.to = f.to; }
    return { f, sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  }

  const LIST_SELECT = `
    SELECT j.*, c.name AS category_name, u.display_name AS creator_name,
      (SELECT GROUP_CONCAT(mu.display_name, '、') FROM job_members m JOIN users mu ON mu.id = m.user_id WHERE m.job_id = j.id) AS member_names,
      (SELECT COUNT(*) FROM job_photos p WHERE p.job_id = j.id) AS photo_count
    FROM jobs j
    JOIN categories c ON c.id = j.category_id
    JOIN users u ON u.id = j.created_by`;

  router.get('/jobs', requirePerm('jobs.view_own', 'jobs.view_all'), (req, res) => {
    const { f, sql, params } = buildFilter(req);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs j ${sql}`).get(params).n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
    const jobs = db.prepare(`${LIST_SELECT} ${sql} ORDER BY j.work_date DESC, j.id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    res.render('jobs/list', {
      title: f.scope === 'all' ? '工作歷史查詢' : '我的工作',
      jobs, f, total, page, pages, qs,
      categories: db.prepare('SELECT id, name FROM categories ORDER BY sort_order, id').all(),
      users: db.prepare('SELECT id, display_name FROM users ORDER BY display_name').all(),
      statuses: JOB_STATUSES,
      reviews: REVIEW_STATUSES,
    });
  });

  router.get('/jobs/export.csv', requirePerm('jobs.export'), (req, res) => {
    const { sql, params } = buildFilter(req);
    const rows = db.prepare(`${LIST_SELECT} ${sql} ORDER BY j.work_date DESC, j.id DESC`).all(params);
    const header = ['工作單號', '施工日期', '開始', '結束', '類別', '工作名稱', '工作簡述', '施工地址', '客戶/業主',
      '聯絡人', '聯絡電話', '進度狀態', '審核狀態', '審核意見', '回報人', '施工人員', '使用材料', '異常狀況', '備註', '照片數', '建立時間'];
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防止 CSV 公式注入
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const lines = [header.map(cell).join(',')];
    for (const j of rows) {
      lines.push([j.job_no, j.work_date, j.start_time, j.end_time, j.category_name, j.title, j.description, j.address,
        j.customer_name, j.contact_name, j.contact_phone, j.status, j.review_status, j.review_comment, j.creator_name,
        j.member_names, j.materials, j.issues, j.notes, j.photo_count, formatDateTime(j.created_at)].map(cell).join(','));
    }
    const filename = encodeURIComponent(`施工回報_${todayLocal()}.csv`);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="jobs.csv"; filename*=UTF-8''${filename}`);
    res.send('﻿' + lines.join('\r\n')); // BOM 讓 Excel 正確顯示中文
  });

  // ---------- 新增 ----------
  router.get('/jobs/new', requirePerm('jobs.create'), (req, res) => {
    renderForm(res, {
      title: '新增工作回報',
      job: { work_date: todayLocal(), status: '施工中' },
      members: [req.user.id],
      isNew: true,
    });
  });

  router.post('/jobs', requirePerm('jobs.create'), handleUpload(photoFields), (req, res) => {
    const { values, members, errors } = parseJobForm(req);
    const files = uploadedFiles(req);
    if (errors.length) {
      removeFiles(files);
      res.locals.flash = errors.map((text) => ({ type: 'error', text }));
      res.status(400);
      return renderForm(res, { title: '新增工作回報', job: values, members, isNew: true });
    }
    if (!members.includes(req.user.id)) members.unshift(req.user.id);

    const jobId = db.transaction(() => {
      const cols = FIELDS.map((f) => f.key);
      const info = db.prepare(
        `INSERT INTO jobs (job_no, created_by, ${cols.join(', ')}) VALUES (@job_no, @created_by, ${cols.map((c) => '@' + c).join(', ')})`
      ).run({ ...values, job_no: nextJobNo(), created_by: req.user.id });
      const id = info.lastInsertRowid;
      const addMember = db.prepare('INSERT OR IGNORE INTO job_members (job_id, user_id) VALUES (?, ?)');
      for (const m of members) addMember.run(id, m);
      let count = 0;
      for (const stage of STAGE_CODES) {
        const list = (req.files && req.files[`photos_${stage}`]) || [];
        savePhotos(id, stage, list, req.user.id);
        count += list.length;
      }
      insertLog.run(id, req.user.id, '建立工作', count ? `上傳照片 ${count} 張` : '');
      return id;
    })();

    req.flash('success', '工作回報已建立。');
    redirect(req, res, `/jobs/${jobId}`);
  });

  // ---------- 檢視 ----------
  router.get('/jobs/:id', loadJob, (req, res) => {
    const job = req.job;
    const photos = db.prepare(
      `SELECT p.*, u.display_name AS uploader FROM job_photos p LEFT JOIN users u ON u.id = p.uploaded_by
       WHERE p.job_id = ? ORDER BY p.id`
    ).all(job.id);
    const members = db.prepare(
      'SELECT u.id, u.display_name FROM job_members m JOIN users u ON u.id = m.user_id WHERE m.job_id = ? ORDER BY u.display_name'
    ).all(job.id);
    const logs = db.prepare(
      `SELECT l.*, u.display_name FROM job_logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.job_id = ? ORDER BY l.id DESC`
    ).all(job.id);
    res.render('jobs/show', {
      title: job.title,
      job, members, logs, formatDateTime,
      photosByStage: PHOTO_STAGES.map((s) => ({ ...s, photos: photos.filter((p) => p.stage === s.code) })),
      editable: canEdit(req, job),
      statuses: JOB_STATUSES,
      reviews: REVIEW_STATUSES,
    });
  });

  // ---------- 編輯 ----------
  function requireEditable(req, res, next) {
    if (!canEdit(req, req.job)) {
      const message = req.job.review_status === '已核可'
        ? '此工作已審核通過並鎖定，如需修改請洽主管。'
        : '您沒有編輯此工作的權限。';
      return res.status(403).render('error', { title: '無法編輯', message });
    }
    next();
  }

  router.get('/jobs/:id/edit', loadJob, requireEditable, (req, res) => {
    renderForm(res, { title: '編輯工作', job: req.job, members: memberIds(req.job.id), isNew: false });
  });

  router.post('/jobs/:id', loadJob, requireEditable, (req, res) => {
    const { values, members, errors } = parseJobForm(req);
    const old = req.job;
    if (errors.length) {
      res.locals.flash = errors.map((text) => ({ type: 'error', text }));
      res.status(400);
      return renderForm(res, { title: '編輯工作', job: { ...old, ...values }, members, isNew: false });
    }
    if (!members.length) members.push(old.created_by);

    const changed = FIELDS.filter((f) => String(old[f.key] ?? '') !== String(values[f.key] ?? '')).map((f) => f.label);
    const oldMembers = memberIds(old.id).sort().join(',');
    if ([...members].sort().join(',') !== oldMembers) changed.push('施工人員');

    db.transaction(() => {
      const sets = FIELDS.map((f) => `${f.key} = @${f.key}`).join(', ');
      // 員工修改被退回的工作後，自動回到待審核
      const resetReview = old.review_status === '退回' ? ", review_status = '待審核'" : '';
      db.prepare(`UPDATE jobs SET ${sets}, updated_at = datetime('now')${resetReview} WHERE id = @id`).run({ ...values, id: old.id });
      db.prepare('DELETE FROM job_members WHERE job_id = ?').run(old.id);
      const add = db.prepare('INSERT INTO job_members (job_id, user_id) VALUES (?, ?)');
      for (const m of members) add.run(old.id, m);
      if (changed.length) {
        const detail = '修改：' + changed.join('、') + (old.status !== values.status ? `（狀態 ${old.status} → ${values.status}）` : '');
        insertLog.run(old.id, req.user.id, '更新工作', detail);
      }
    })();
    req.flash('success', changed.length ? '工作已更新。' : '資料沒有變更。');
    res.redirect(`/jobs/${old.id}`);
  });

  router.post('/jobs/:id/status', loadJob, requireEditable, (req, res) => {
    const status = str(req.body.status, 10);
    if (JOB_STATUSES.includes(status) && status !== req.job.status) {
      db.prepare("UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.job.id);
      insertLog.run(req.job.id, req.user.id, '變更狀態', `${req.job.status} → ${status}`);
      req.flash('success', `狀態已變更為「${status}」。`);
    }
    res.redirect(`/jobs/${req.job.id}`);
  });

  // ---------- 照片 ----------
  router.post('/jobs/:id/photos', loadJob, requireEditable, handleUpload(singleStageField), (req, res) => {
    const files = uploadedFiles(req);
    const stage = str(req.body.stage, 10);
    if (!STAGE_CODES.includes(stage) || !files.length) {
      removeFiles(files);
      req.flash('error', '請選擇照片階段與至少一張照片（支援 JPG、PNG、WebP、HEIC）。');
      return redirect(req, res, `/jobs/${req.job.id}#photos`);
    }
    db.transaction(() => {
      savePhotos(req.job.id, stage, files, req.user.id);
      db.prepare("UPDATE jobs SET updated_at = datetime('now') WHERE id = ?").run(req.job.id);
      insertLog.run(req.job.id, req.user.id, '上傳照片', `${STAGE_LABEL[stage]} ${files.length} 張`);
    })();
    req.flash('success', `已上傳 ${files.length} 張${STAGE_LABEL[stage]}照片。`);
    redirect(req, res, `/jobs/${req.job.id}#photos`);
  });

  router.post('/jobs/:id/photos/:pid/delete', loadJob, (req, res) => {
    const photo = db.prepare('SELECT * FROM job_photos WHERE id = ? AND job_id = ?').get(Number(req.params.pid), req.job.id);
    if (!photo) return res.redirect(`/jobs/${req.job.id}#photos`);
    // 有刪除權限者，或可編輯此工作且為自己上傳的照片
    const allowed = req.can('jobs.delete') || (canEdit(req, req.job) && photo.uploaded_by === req.user.id);
    if (!allowed) {
      return res.status(403).render('error', { title: '權限不足', message: '您無法刪除這張照片。' });
    }
    db.prepare('DELETE FROM job_photos WHERE id = ?').run(photo.id);
    fs.rm(path.join(uploadDir, photo.filename), { force: true }, () => {});
    insertLog.run(req.job.id, req.user.id, '刪除照片', `${STAGE_LABEL[photo.stage]} ${photo.original_name}`);
    req.flash('success', '照片已刪除。');
    res.redirect(`/jobs/${req.job.id}#photos`);
  });

  router.get('/photos/:id', (req, res) => {
    const photo = db.prepare('SELECT * FROM job_photos WHERE id = ?').get(Number(req.params.id));
    const job = photo && getJob(photo.job_id);
    if (!photo || !job || !canView(req, job)) return res.status(404).end();
    const file = path.resolve(uploadDir, photo.filename);
    if (!file.startsWith(path.resolve(uploadDir) + path.sep)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.type(photo.mime);
    if (req.query.download) res.attachment(`${job.job_no}_${STAGE_LABEL[photo.stage]}_${photo.id}${path.extname(file)}`);
    res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  // ---------- 審核 ----------
  router.post('/jobs/:id/review', loadJob, requirePerm('jobs.review'), (req, res) => {
    const review = str(req.body.review_status, 10);
    const comment = str(req.body.review_comment, 1000);
    if (!REVIEW_STATUSES.includes(review)) return res.redirect(`/jobs/${req.job.id}`);
    if (review === '退回' && !comment) {
      req.flash('error', '退回時請填寫審核意見，讓施工人員知道要修正什麼。');
      return res.redirect(`/jobs/${req.job.id}#review`);
    }
    db.prepare(
      "UPDATE jobs SET review_status = ?, review_comment = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(review, comment, req.user.id, req.job.id);
    insertLog.run(req.job.id, req.user.id, '審核', review + (comment ? `：${comment}` : ''));
    req.flash('success', `審核結果：${review}`);
    res.redirect(`/jobs/${req.job.id}`);
  });

  // ---------- 刪除 ----------
  router.post('/jobs/:id/delete', loadJob, requirePerm('jobs.delete'), (req, res) => {
    const photos = db.prepare('SELECT filename FROM job_photos WHERE job_id = ?').all(req.job.id);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(req.job.id);
    for (const p of photos) fs.rm(path.join(uploadDir, p.filename), { force: true }, () => {});
    req.flash('success', `工作 ${req.job.job_no} 已刪除。`);
    res.redirect('/jobs?scope=all');
  });

  return router;
};
