/* P11：权限矩阵里的"查看"类权限（页面可见性 + 他人任务详情） + 下拉框点击分发修复 测试。
   用法：node test/test-p11.js */
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

  section('权限矩阵：新增的查看类权限，分组齐全');
  const groups = [...new Set(S.PERMISSIONS.map(p => p.group))];
  ok('分成 4 组：查看/操作/账号/系统', groups.sort().join(',') === ['查看', '操作', '账号', '系统'].sort().join(','), groups);
  const viewPerms = S.PERMISSIONS.filter(p => p.group === '查看').map(p => p.key).sort();
  ok('查看组包含 7 项', viewPerms.length === 7, viewPerms);
  ok('查看组具体项正确', viewPerms.join(',') ===
     ['view_tasks', 'view_works', 'view_duties', 'view_charts', 'view_report', 'view_data', 'view_others_detail'].sort().join(','));

  section('DEFAULT_PERMISSION_MATRIX：查看类默认对三个角色都开放（不因为升级突然挡住老用户）——数据页除外，那个默认只对管理员开放');
  const viewPermsExceptData = viewPerms.filter(k => k !== 'view_data');
  ['staff', 'comanager', 'director'].forEach(role => {
    ok(`${role} 默认除数据页外的查看权限都是 true`, viewPermsExceptData.every(k => S.DEFAULT_PERMISSION_MATRIX[role][k] === true), role);
    ok(`${role} 默认 view_data 是 false（数据页默认仅管理员可见）`, S.DEFAULT_PERMISSION_MATRIX[role].view_data === false, role);
  });

  section('canSeePage：工作台没有查看权限门槛，永远可见');
  const dashboardPage = { key: 'dashboard', label: '工作台' };
  S.DB.settings.me = '';
  ok('即使匿名/无身份，工作台也能看', S.canSeePage(dashboardPage));

  section('canSeePage / goto：关掉某角色的查看权限后，页面导航被拦下');
  S.DB.users.push({ name: '测试员工-查看权限', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试员工-查看权限';
  const tasksPage = { key: 'tasks', label: '任务', viewPermission: 'view_tasks' };
  ok('默认矩阵下，员工能看任务页', S.canSeePage(tasksPage));
  S.DB.permissionMatrix = { staff: { ...S.DEFAULT_PERMISSION_MATRIX.staff, view_tasks: false }, comanager: S.DEFAULT_PERMISSION_MATRIX.comanager, director: S.DEFAULT_PERMISSION_MATRIX.director };
  ok('关掉 view_tasks 后，canSeePage 返回 false', !S.canSeePage(tasksPage));
  S.goto('tasks');
  ok('直接 goto(\'tasks\') 会被弹回工作台', S.currentPage === 'dashboard', S.currentPage);
  S.renderShell();
  ok('导航栏里也看不到"任务"这一项了', !q('#nav').innerHTML.includes('data-page="tasks"'));
  S.DB.permissionMatrix = null;
  S.renderShell();
  ok('权限恢复默认后，导航栏里任务项回来了', q('#nav').innerHTML.includes('data-page="tasks"'));
  S.goto('tasks');
  ok('也能正常进入任务页了', S.currentPage === 'tasks');

  section('openTaskDetail：view_others_detail 权限门禁');
  const otherTask = S.DB.tasks.find(t => !t.deleted_at && t.owner && t.owner !== '测试员工-查看权限' &&
    !(t.assignees || []).includes('测试员工-查看权限'));
  S.DB.permissionMatrix = { staff: { ...S.DEFAULT_PERMISSION_MATRIX.staff, view_others_detail: false }, comanager: S.DEFAULT_PERMISSION_MATRIX.comanager, director: S.DEFAULT_PERMISSION_MATRIX.director };
  S.openTaskDetail(otherTask.id);
  ok('关掉 view_others_detail 后，打不开别人任务的详情', !q('#modal-title').textContent.includes('任务详情'));
  ok('提示是为了防止误操作', q('#snack-msg').textContent.includes('为了防止误操作'));

  const myOwnTask = { ...otherTask, id: 'test_p11_my_task', owner: '测试员工-查看权限', assignees: [] };
  await S.Repo.upsert('task', myOwnTask);
  S.openTaskDetail(myOwnTask.id);
  ok('哪怕关掉 view_others_detail，自己负责的任务详情还是能打开', q('#modal-title').textContent.includes('任务详情'));

  S.DB.permissionMatrix = { staff: { ...S.DEFAULT_PERMISSION_MATRIX.staff, view_others_detail: true }, comanager: S.DEFAULT_PERMISSION_MATRIX.comanager, director: S.DEFAULT_PERMISSION_MATRIX.director };
  S.openTaskDetail(otherTask.id);
  ok('开着 view_others_detail 时，能打开别人任务的详情（但只读）', q('#modal-title').textContent.includes('任务详情'));
  ok('详情是只读的（因为没有 edit_others_task 权限）', q('#modal-body').innerHTML.includes('detail-ro'));

  section('permissionMatrixPanelHTML：分组标题行 + 每项权限一行');
  S.DB.settings.me = '测试管理员';
  S.DB.permissionMatrix = null;
  const html = S.permissionMatrixPanelHTML();
  ok('渲染了 4 个分组标题行', (html.match(/perm-group-row/g) || []).length === 4);
  ok('每一项权限都有一行 checkbox', S.PERMISSIONS.every(p => html.includes(`data-key="${p.key}"`)));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
