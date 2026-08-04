/* P13：本轮四项改动测试——
   1) 去除 Ctrl+S 备份快捷键与右下角文案
   2) 撤销栈扩展到账号/权限矩阵 + 撤销按钮只在真有可撤销内容时才出现
   3) 权限不足提示改为"为了防止误操作"的温和表述
   4) 新增"部门领导"角色：能看除数据页/权限页外的一切，但不能编辑
   用法：node test/test-p13.js */
const fs = require('fs');
const path = require('path');
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

  section('去除 Ctrl+S 备份快捷键 + 右下角文案');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('右下角状态栏不再提 Ctrl+S 备份', !html.includes('Ctrl+S'));
  ok('Ctrl+Z 撤销的提示还在', html.includes('Ctrl+Z 撤销'));
  ok('keydown 里不再有 Ctrl+S 触发导出的分支', !html.includes(`e.key === 's' || e.key === 'S'`));
  ok('导出功能本身（手动点按钮那条路）还在，没被一并删掉', html.includes("'export-all': () => exportJSON()"));

  section('权限不足提示改为"为了防止误操作"的温和表述，且没有生硬的"权限不足"字样了');
  ok('全文找不到"权限不足"这个词了', !html.includes('权限不足'));
  S.DB.users.push({ name: '测试员工-p13', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试员工-p13';
  S.ACTIONS['work-new']();
  ok('员工被拦下时看到的是"为了防止误操作"而不是生硬的"权限不足"', q('#snack-msg').textContent.includes('为了防止误操作'), q('#snack-msg').textContent);

  section('撤销：账号 / 权限矩阵变更现在也进撤销栈了，撤销按钮只在真有内容时才出现');
  S.DB.settings.me = '测试管理员';
  // 先把撤销栈排空，确认"没有可撤销的操作"时按钮是隐藏的
  for (let i = 0; i < 25; i++) { await S.undoLast(); if (q('#snack-msg').textContent.includes('没有可撤销的操作了')) break; }
  ok('撤销栈排空后再撤销，提示没有可撤销的操作', q('#snack-msg').textContent.includes('没有可撤销的操作了'));
  ok('这时撤销按钮是隐藏的，不会给个假按钮', q('#undo-btn').classList.contains('hidden'));

  const beforeToggle = S.getPermissionMatrix().staff.bulk_ops;
  await S.ACTIONS['perm-toggle']({ role: 'staff', key: 'bulk_ops' }, { checked: !beforeToggle });
  ok('权限矩阵切换后，撤销按钮露出来了（真的有内容可以撤销）', !q('#undo-btn').classList.contains('hidden'));
  await S.undoLast();
  ok('撤销后，权限矩阵真的改回去了', S.getPermissionMatrix().staff.bulk_ops === beforeToggle);

  const nameBefore = '测试撤销账号';
  S.DB.settings.me = '测试管理员';
  q('#adm-new-name').value = nameBefore;
  q('#adm-new-role').value = 'staff';
  await S.ACTIONS['admin-new-user']();
  ok('新建了账号', !!S.DB.users.find(u => u.name === nameBefore));
  await S.undoLast();
  /* P50 之后撤销的实现方式变了：不再是"把内存里的数据整个拨回旧版本"，而是落成一次新的向前编辑
     （详见 undoRestoreList）。原因是直接塞回旧记录的话，它的版本号比共享文件里那条低，
     一同步就被原样盖回来，撤销等于没生效。
     对"撤销刚创建的账号"来说，表现从"这条记录从数组里消失"变成了"这条记录被软删除"——
     效果一样（登录、账号列表都按 !deleted_at 过滤），但删除这件事现在能正确同步给别人了。 */
  const undoneUser = S.DB.users.find(u => u.name === nameBefore);
  ok('撤销后，刚创建的账号不再是有效账号（账号变更也在撤销范围内）',
    !undoneUser || !!undoneUser.deleted_at, undoneUser);
  ok('★而且是软删除而不是直接抹掉——这样这次撤销才能同步给其他人',
    !!(undoneUser && undoneUser.deleted_at));
  restore();

  section('新增"部门领导"角色：定义齐全');
  ok('ROLES 里有部门领导', (S.ROLES.find(r => r.v === 'gm') || {}).label === '部门领导');
  ok('部门领导排在处室领导之上、管理员之下', S.ROLE_RANK.director < S.ROLE_RANK.gm && S.ROLE_RANK.gm < S.ROLE_RANK.admin);
  const gmDefault = S.DEFAULT_PERMISSION_MATRIX.gm;
  ok('部门领导默认能看任务/工作/职责/图表页 + 他人任务详情', gmDefault.view_tasks && gmDefault.view_works && gmDefault.view_duties && gmDefault.view_charts && gmDefault.view_others_detail);
  // P54 之后数据页改回矩阵控制（view_data 权限），但部门领导的默认值仍然是 false，
  // 效果跟以前的硬编码一样看不到，区别只是现在管理员可以主动放开
  ok('部门领导默认看不了数据/日志/权限三页（矩阵里这三项默认 false）',
    gmDefault.view_data === false && gmDefault.view_logs === false && gmDefault.view_permissions === false);
  ok('部门领导默认没有任何编辑/管理类权限', !gmDefault.edit_others_task && !gmDefault.manage_duty_work && !gmDefault.bulk_ops && !gmDefault.manage_staff_accounts && !gmDefault.manage_director_accounts && !gmDefault.system_admin);

  section('新增"部门领导"角色：实际生效——能看不能改，数据页/权限页都进不去');
  S.DB.users.push({ name: '测试部门领导', role: 'gm', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试部门领导';
  S.DB.permissionMatrix = null;
  S.renderShell();
  ok('导航栏里有任务/工作/职责/图表', ['tasks', 'works', 'duties', 'charts'].every(k => q('#nav').innerHTML.includes(`data-page="${k}"`)));
  ok('导航栏里没有数据、也没有权限', !q('#nav').innerHTML.includes('data-page="data"') && !q('#nav').innerHTML.includes('data-page="permissions"'));
  S.goto('data');
  ok('直接跳数据页会被弹回工作台', S.currentPage === 'dashboard', S.currentPage);
  S.goto('permissions');
  ok('直接跳权限页也会被弹回工作台', S.currentPage === 'dashboard', S.currentPage);
  S.goto('tasks');
  ok('能正常进任务页', S.currentPage === 'tasks');
  const otherTask = S.DB.tasks.find(t => !t.deleted_at && t.owner && t.owner !== '测试部门领导');
  ok('canEditRecord：部门领导编辑不了别人的任务', !S.canEditRecord('task', otherTask));

  section('权限矩阵一览表：部门领导也有自己的一列');
  S.DB.settings.me = '测试管理员';
  S.DB.permissionMatrix = null;
  const matrixHtml = S.permissionMatrixPanelHTML();
  ok('表头里有部门领导这一列', matrixHtml.includes('>部门领导<'));
  ok('每一项权限都有部门领导对应的勾选框', S.PERMISSIONS.every(p => matrixHtml.includes(`data-role="gm" data-key="${p.key}"`)));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
