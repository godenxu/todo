/* P9：呈报层级默认值 / 新任务默认牵头人 / 牵头人变更提醒 / 组长改名 / 权限页 测试。
   用法：node test/test-p9.js */
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
  const restore = () => { S.DB.users = JSON.parse(JSON.stringify(bakUsers)); S.DB.settings.me = bakMe; };

  section('里程碑编辑器：呈报层级下拉框仍在，新行默认选中处室领导');
  const cpTask = S.DB.tasks.find(t => !S.hasCheckpoints(t) && !t.deleted_at);
  const blankRowHtml = S.cpRowHTML(null);
  ok('空白新行有可见的下拉框', blankRowHtml.includes('class="cp-report-level"') && blankRowHtml.includes('<select'));
  ok('空白新行默认选中处室领导', /<option value="section" selected>/.test(blankRowHtml), blankRowHtml);
  const existingMs = { plan_date: '2026-01-01', deliverable: '既有交付物', report_level: 'bank', done: '0' };
  const existingRowHtml = S.cpRowHTML(existingMs);
  ok('已有记录（比如宽表导入设过的 bank）下拉框会选中原来的值', /<option value="bank" selected>/.test(existingRowHtml), existingRowHtml);

  section('新建任务：只有"员工"角色默认牵头人是自己');
  const w0101 = S.DB.works.find(w => w.code === '0101');
  S.DB.users.push({ name: '测试新建人-员工', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试新建人-员工';
  const qi = S.parseQuickInput('一个新任务 $0101');
  ok('员工建任务，没指定负责人时默认是自己', qi.owner === '测试新建人-员工', qi.owner);
  const qiExplicit = S.parseQuickInput('一个新任务 $0101 @张三');
  ok('@ 指定的是参与人，不影响默认牵头人逻辑', qiExplicit.owner === '测试新建人-员工' && qiExplicit.assignees.includes('张三'));

  S.DB.users.push({ name: '测试新建人-组长', role: 'comanager', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试新建人-组长';
  const qiComanager = S.parseQuickInput('一个新任务 $0101');
  ok('组长建任务，不会默认牵头给自己，退回工作牵头人兜底', qiComanager.owner === w0101.owner, [qiComanager.owner, w0101.owner]);

  S.DB.settings.me = '';
  const qiNoMe = S.parseQuickInput('一个新任务 $0101');
  ok('没有登录身份时（myRole 兜底也是 staff，但没有真实账号），一样退回工作牵头人兜底', qiNoMe.owner === w0101.owner, [qiNoMe.owner, w0101.owner]);

  section('ownerChangeNeedsWarning：纯逻辑判断');
  const t0 = S.DB.tasks.find(t => !t.deleted_at && t.owner);
  S.DB.settings.me = t0.owner;
  ok('员工把自己牵头的任务转给别人 → 需要提醒', S.ownerChangeNeedsWarning(t0, '别人'));
  ok('改成还是自己 → 不需要提醒', !S.ownerChangeNeedsWarning(t0, t0.owner));
  S.DB.users.push({ name: t0.owner, role: 'comanager', salt: '', hash: '', iterations: 0 });
  ok('组长及以上转给别人 → 不需要提醒（不受这条限制）', !S.ownerChangeNeedsWarning(t0, '别人'));
  S.DB.users = S.DB.users.filter(u => u.name !== t0.owner);
  S.DB.settings.me = '不是负责人的路人';
  ok('当前登录人本来就不是这条任务的负责人 → 不需要提醒（谈不上"转移"）', !S.ownerChangeNeedsWarning(t0, '别人'));

  section('spCommitSingle：员工转移自己牵头的任务，先确认再生效');
  S.DB.settings.me = t0.owner;
  S.openEditor('task', t0.id, 'owner', raw.document.createElement('td'));
  ok('弹层已打开', !!S.sp);
  await S.spCommitSingle('新的负责人');
  ok('没有立即改变（等确认）', S.byId('task', t0.id).owner === t0.owner);
  ok('弹出了确认框', typeof S.modalCallback === 'function');
  await S.modalCallback();
  ok('确认后牵头人真的改了', S.byId('task', t0.id).owner === '新的负责人');
  // 还原，避免影响后面用例
  S.byId('task', t0.id).owner = t0.owner;

  section('spCommitSingle：改成自己或者组长以上操作，不弹确认框、直接生效');
  S.DB.settings.me = t0.owner;
  S.openEditor('task', t0.id, 'owner', raw.document.createElement('td'));
  await S.spCommitSingle(t0.owner);
  ok('改成还是自己，没有弹确认框、直接生效（其实值没变）', S.byId('task', t0.id).owner === t0.owner);

  section('openTaskDetail：转移自己牵头的任务需要确认，且确认后其它字段的修改也一起生效');
  const t1 = S.DB.tasks.find(t => !t.deleted_at && t.owner && t.id !== t0.id);
  S.DB.settings.me = t1.owner;
  const originalTitle = t1.title;
  S.openTaskDetail(t1.id);
  q('#td-title').value = '改过标题的任务';
  q('#td-owner').value = '另一个人';
  await S.modalCallback();
  ok('弹出了转移确认框，标题还没真的改', S.byId('task', t1.id).title === originalTitle);
  ok('modalCallback 换成了确认框自己的', typeof S.modalCallback === 'function');
  await S.modalCallback();
  const t1After = S.byId('task', t1.id);
  ok('确认后牵头人改了', t1After.owner === '另一个人');
  ok('确认后标题也一起改了（不是只改了牵头人）', t1After.title === '改过标题的任务');
  // 还原
  t1After.owner = t1.owner; t1After.title = originalTitle;

  section('openBatchEdit(owner)：批量转移自己牵头的任务需要确认');
  const t2 = S.DB.tasks.find(t => !t.deleted_at && t.owner && t.id !== t0.id && t.id !== t1.id);
  S.DB.settings.me = t2.owner;
  S.UI.tasks.sel = new Set([t2.id]);
  S.ACTIONS['batch']({ field: 'owner' });
  q('#be-owner').value = '批量转移给的人';
  await S.modalCallback();
  ok('批量转移自己牵头的任务，先弹确认框，没有立即生效', S.byId('task', t2.id).owner === t2.owner);
  await S.modalCallback();
  ok('确认后批量转移生效', S.byId('task', t2.id).owner === '批量转移给的人');
  S.byId('task', t2.id).owner = t2.owner;
  S.UI.tasks.sel.clear();

  section('删除提示文案：员工删自己牵头的任务会特别提醒');
  const t3 = S.DB.tasks.find(t => !t.deleted_at && t.owner && t.id !== t0.id && t.id !== t1.id && t.id !== t2.id);
  S.DB.settings.me = t3.owner;
  S.ACTIONS['task-del']({ id: t3.id });
  ok('弹窗文案提到需要有权限的同事帮忙恢复', q('#modal-body').innerHTML.includes('有权限的同事'), q('#modal-body').innerHTML);

  section('角色改名：组长（原"协管"）');
  ok('ROLES 里的 comanager 现在叫组长', (S.ROLES.find(r => r.v === 'comanager') || {}).label === '组长');

  restore();

  section('权限页：仅管理员可见/可访问');
  S.DB.users.push({ name: '测试非管理员', role: 'director', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试非管理员';
  S.setPage('dashboard'); S.renderShell();
  ok('非管理员的导航栏里没有"权限"这一项', !q('#nav').innerHTML.includes('data-page="permissions"'));
  S.goto('permissions');
  ok('非管理员直接改 hash 跳权限页会被弹回工作台', S.currentPage === 'dashboard', S.currentPage);

  S.DB.settings.me = '测试管理员';
  S.renderShell();
  ok('管理员的导航栏里有"权限"这一项', q('#nav').innerHTML.includes('data-page="permissions"'));
  S.goto('permissions');
  ok('管理员可以正常进入权限页', S.currentPage === 'permissions');
  const permHtml = q('#page-permissions').innerHTML;
  ok('权限页里有新增账号表单', permHtml.includes('adm-new-name') && permHtml.includes('data-act="admin-new-user"'));
  ok('权限页里的账号列表包含重置 PIN 按钮', permHtml.includes('data-act="admin-reset-pin"'));

  section('权限页：管理员新增账号 + 重置 PIN');
  q('#adm-new-name').value = '权限页新建的人';
  q('#adm-new-role').value = 'staff';
  q('#adm-new-pin').value = '2468';
  await S.ACTIONS['admin-new-user']();
  const newAccount = S.DB.users.find(u => u.name === '权限页新建的人');
  ok('账号创建成功', !!newAccount && newAccount.role === 'staff');
  ok('创建者（管理员）自己的登录身份没有被切换走', S.DB.settings.me === '测试管理员');
  ok('可以用刚设的 PIN 验证通过', await S.verifyPin('2468', newAccount));

  S.ACTIONS['admin-reset-pin']({ name: '权限页新建的人' });
  q('#reset-pin1').value = '1357';
  q('#reset-pin2').value = '1357';
  await S.modalCallback();
  const afterReset = S.DB.users.find(u => u.name === '权限页新建的人');
  ok('重置后旧 PIN 不再有效', !(await S.verifyPin('2468', afterReset)));
  ok('重置后新 PIN 生效', await S.verifyPin('1357', afterReset));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
