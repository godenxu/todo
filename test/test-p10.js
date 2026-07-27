/* P10：可配置权限矩阵（角色 × 权限一览表）测试。用法：node test/test-p10.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const bakMatrix = S.DB.permissionMatrix ? JSON.parse(JSON.stringify(S.DB.permissionMatrix)) : null;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.permissionMatrix = bakMatrix;
  };

  section('hasPermission：管理员恒真，不读矩阵');
  S.DB.settings.me = '测试管理员';
  S.DB.permissionMatrix = { staff: {}, comanager: {}, director: {} };   // 故意全清空
  ok('管理员的每一项权限依然都是 true（矩阵清空也不影响）', S.PERMISSIONS.every(p => S.hasPermission(p.key)));
  S.DB.permissionMatrix = null;

  section('getPermissionMatrix：缺省时逐行退回内置默认');
  ok('没配置过时，整体等于内置默认矩阵',
     JSON.stringify(S.getPermissionMatrix()) === JSON.stringify(S.DEFAULT_PERMISSION_MATRIX));
  S.DB.permissionMatrix = { staff: { edit_others_task: true } };   // 只配了 staff 一行，且只给了一个 key
  const partial = S.getPermissionMatrix();
  ok('配置了 staff 那一行就用配置的，没配的 comanager/director 两行退回默认',
     partial.staff.edit_others_task === true &&
     JSON.stringify(partial.comanager) === JSON.stringify(S.DEFAULT_PERMISSION_MATRIX.comanager) &&
     JSON.stringify(partial.director) === JSON.stringify(S.DEFAULT_PERMISSION_MATRIX.director));
  S.DB.permissionMatrix = null;

  section('hasPermission：非管理员按矩阵配置生效');
  S.DB.users.push({ name: '测试员工-矩阵', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试员工-矩阵';
  ok('默认矩阵下，员工没有 edit_others_task 权限', !S.hasPermission('edit_others_task'));
  S.DB.permissionMatrix = { staff: { ...S.DEFAULT_PERMISSION_MATRIX.staff, edit_others_task: true } };
  ok('管理员把这项权限配给员工之后，员工就有了', S.hasPermission('edit_others_task'));
  S.DB.permissionMatrix = null;

  section('requirePermission：没权限时提示且返回 false');
  ok('没有 system_admin 权限时返回 false 并提示', !S.requirePermission('system_admin'));
  ok('提示里带出了具体权限项名字', q('#snack-msg').textContent.includes('连接/断开共享文件'), q('#snack-msg').textContent);

  section('mergePermissionMatrix：整体按版本号/时间取较新的一份，不逐格合并');
  const older = { staff: { edit_others_task: false }, rev: 1, updated_at: '2026-01-01T00:00:00.000Z' };
  const newer = { staff: { edit_others_task: true }, rev: 2, updated_at: '2026-01-02T00:00:00.000Z' };
  ok('本地旧、对方新 → 采用对方的', S.mergePermissionMatrix(older, newer) === newer);
  ok('本地新、对方旧 → 保留本地的', S.mergePermissionMatrix(newer, older) === newer);
  ok('本地没有、对方有 → 采用对方的', S.mergePermissionMatrix(null, newer) === newer);
  ok('对方没有、本地有 → 保留本地的', S.mergePermissionMatrix(newer, null) === newer);
  ok('两边都没有 → 还是没有', S.mergePermissionMatrix(null, null) === null);

  section('permissionMatrixPanelHTML：渲染内容与矩阵状态一致');
  S.DB.settings.me = '测试管理员';
  S.DB.permissionMatrix = null;
  const html1 = S.permissionMatrixPanelHTML();
  ok('每一项权限都渲染了一行', S.PERMISSIONS.every(p => html1.includes(`data-key="${p.key}"`)));
  ok('管理员那一列全部是勾选且禁用（不接受配置）',
     (html1.match(/checked disabled/g) || []).length === S.PERMISSIONS.length);
  ok('默认矩阵下，员工那一列 edit_others_task 是未勾选的',
     /data-role="staff" data-key="edit_others_task"(?! checked)/.test(html1) &&
     !new RegExp('data-role="staff" data-key="edit_others_task" checked').test(html1));
  S.DB.permissionMatrix = { staff: { ...S.DEFAULT_PERMISSION_MATRIX.staff, edit_others_task: true }, comanager: S.DEFAULT_PERMISSION_MATRIX.comanager, director: S.DEFAULT_PERMISSION_MATRIX.director };
  const html2 = S.permissionMatrixPanelHTML();
  ok('配置改过之后，员工那一列 edit_others_task 变成勾选了',
     new RegExp('data-role="staff" data-key="edit_others_task" checked').test(html2));
  S.DB.permissionMatrix = null;

  section('perm-toggle：管理员切换矩阵，立即影响 hasPermission，且持久化');
  S.DB.settings.me = '测试管理员';
  await S.ACTIONS['perm-toggle']({ role: 'comanager', key: 'manage_staff_accounts' }, { checked: true });
  ok('矩阵已更新（组长现在拥有管理员工账号的权限）', S.getPermissionMatrix().comanager.manage_staff_accounts === true);
  S.DB.settings.me = '测试组长-矩阵测试';
  S.DB.users.push({ name: '测试组长-矩阵测试', role: 'comanager', salt: '', hash: '', iterations: 0 });
  const staffTarget = { name: '随便一个员工', role: 'staff' };
  ok('组长现在真的可以管理员工级账号了（canManageAccount）', S.canManageAccount(staffTarget));

  section('perm-toggle：非管理员无法触发（防御性检查）');
  S.DB.settings.me = '测试组长-矩阵测试';
  await S.ACTIONS['perm-toggle']({ role: 'staff', key: 'bulk_ops' }, { checked: true });
  ok('非管理员触发不了矩阵切换，被拦下', q('#snack-msg').textContent.includes('为了防止误操作'));

  section('集成：admin 把 comanager 的 manage_duty_work 关掉后，组长真的建不了工作了');
  S.DB.permissionMatrix = { staff: S.DEFAULT_PERMISSION_MATRIX.staff, comanager: { ...S.DEFAULT_PERMISSION_MATRIX.comanager, manage_duty_work: false }, director: S.DEFAULT_PERMISSION_MATRIX.director };
  S.DB.settings.me = '测试组长-矩阵测试';
  const dutyBefore = S.DB.duties.length;
  S.ACTIONS['duty-new']();
  ok('权限关掉之后，组长点新建职责被拦下（没有弹出表单）', !q('#modal-title').textContent.includes('新建职责') || q('#snack-msg').textContent.includes('为了防止误操作'));
  S.DB.permissionMatrix = { staff: S.DEFAULT_PERMISSION_MATRIX.staff, comanager: { ...S.DEFAULT_PERMISSION_MATRIX.comanager, manage_duty_work: true }, director: S.DEFAULT_PERMISSION_MATRIX.director };
  S.ACTIONS['duty-new']();
  ok('权限开回来之后，组长可以正常打开新建职责表单', q('#modal-title').textContent.includes('新建职责'));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
