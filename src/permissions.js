'use strict';

// 系統中所有可被授權的功能。角色透過勾選這些代碼取得權限。
const PERMISSIONS = [
  { code: 'jobs.create', group: '工作回報', label: '新增工作回報' },
  { code: 'jobs.view_own', group: '工作回報', label: '查看自己參與的工作' },
  { code: 'jobs.edit_own', group: '工作回報', label: '編輯自己參與的工作、補傳照片（審核通過後鎖定）' },
  { code: 'jobs.view_all', group: '後台查詢', label: '查詢所有人的工作歷史資料' },
  { code: 'jobs.edit_all', group: '後台查詢', label: '編輯所有工作（含已審核）' },
  { code: 'jobs.review', group: '後台查詢', label: '審核工作回報（核可 / 退回）' },
  { code: 'jobs.delete', group: '後台查詢', label: '刪除工作與照片' },
  { code: 'jobs.export', group: '後台查詢', label: '匯出工作資料（CSV / Excel）' },
  { code: 'categories.manage', group: '系統管理', label: '工作類別管理' },
  { code: 'users.manage', group: '系統管理', label: '人員帳號管理（新增、停用、指派角色）' },
  { code: 'roles.manage', group: '系統管理', label: '角色與權限設定' },
];

const ALL_CODES = PERMISSIONS.map((p) => p.code);

function groupedPermissions() {
  const groups = [];
  for (const p of PERMISSIONS) {
    let g = groups.find((x) => x.name === p.group);
    if (!g) {
      g = { name: p.group, items: [] };
      groups.push(g);
    }
    g.items.push(p);
  }
  return groups;
}

module.exports = { PERMISSIONS, ALL_CODES, groupedPermissions };
