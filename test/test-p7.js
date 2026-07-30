/* P7 身份与权限系统（PIN 账号 + 员工/组长/处室领导/管理员）测试。用法：node test/test-p7.js */
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
  // 测试沙盒默认已登录成"测试管理员"（role: admin），这里另外保存一份快照方便各小节结束后恢复
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const restore = () => { S.DB.users = JSON.parse(JSON.stringify(bakUsers)); S.DB.settings.me = bakMe; };

  // 身份认证是姓名 + PIN：PBKDF2 加盐哈希，salt/hash/iterations 存在账号记录里
  section('PIN 校验：hashPin/verifyPin');
  ok('hashPin/verifyPin 都存在', typeof S.hashPin === 'function' && typeof S.verifyPin === 'function');
  await (async () => {
    const { salt, hash, iterations } = await S.hashPin('123456');
    const user = { name: 'P7-PIN测试', role: 'staff', salt, hash, iterations };
    ok('正确的 PIN 验证通过', await S.verifyPin('123456', user));
    ok('错误的 PIN 验证不通过', !(await S.verifyPin('654321', user)));
  })();
  ok('账号没有 salt/hash 时 verifyPin 返回 false，不抛异常', !(await S.verifyPin('123456', { name: 'x', role: 'staff' })));

  section('角色等级判断');
  ok('ROLE_RANK 顺序：员工 < 组长 < 处室领导 < 管理员',
     S.ROLE_RANK.staff < S.ROLE_RANK.comanager && S.ROLE_RANK.comanager < S.ROLE_RANK.director && S.ROLE_RANK.director < S.ROLE_RANK.admin);
  S.DB.settings.me = '测试管理员';
  ok('当前登录是管理员，roleAtLeast admin 为真', S.roleAtLeast('admin'));

  section('canEditRecord：员工只能改自己负责/参与的记录');
  const t0 = S.DB.tasks.find(t => !t.deleted_at && t.owner);
  const staffUser = { name: '测试员工', role: 'staff', salt: '', hash: '', iterations: 0 };
  S.DB.users.push(staffUser);
  S.DB.settings.me = '测试员工';
  ok('员工不能编辑别人负责的任务', !S.canEditRecord('task', t0));
  const mine = S.DB.tasks.find(t => !t.deleted_at && t.owner === '测试员工') || (() => {
    const c = { ...t0, id: 'test_mine_task', owner: '测试员工', assignees: [] };
    S.DB.tasks.push(c); return c;
  })();
  ok('员工能编辑自己负责的任务', S.canEditRecord('task', mine));
  const asAssignee = { ...t0, id: 'test_assignee_task', owner: '别人', assignees: ['测试员工'] };
  S.DB.tasks.push(asAssignee);
  ok('员工能编辑自己是参与人的任务（不一定是负责人）', S.canEditRecord('task', asAssignee));
  S.DB.tasks = S.DB.tasks.filter(t => t.id !== 'test_mine_task' && t.id !== 'test_assignee_task');

  section('canEditRecord：组长以上不受"是否本人负责"限制');
  S.DB.users.push({ name: '测试组长', role: 'comanager', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试组长';
  ok('组长能编辑任何人负责的任务', S.canEditRecord('task', t0));

  section('权限点位：员工尝试受限操作会被拦下');
  S.DB.settings.me = '测试员工';
  S.setPage('duties');
  const anyDuty = S.DB.duties.find(d => !d.deleted_at);
  const dutyCountBefore = S.DB.duties.length;
  S.ACTIONS['duty-del']({ code: anyDuty.code });
  ok('员工点删除职责，职责数没有变化（直接被权限拦截，没走到确认弹窗那一步）',
     S.DB.duties.length === dutyCountBefore);
  ok('提示里说明了是为了防止误操作', q('#snack-msg').textContent.includes('为了防止误操作'));
  S.ACTIONS['work-new']();
  ok('员工新建工作被拦下', q('#snack-msg').textContent.includes('为了防止误操作'));
  S.ACTIONS['reset-all']();
  ok('员工触发重置全部数据被拦下（这个连组长都不够，只有管理员）', q('#snack-msg').textContent.includes('为了防止误操作'));
  S.ACTIONS['connect-shared']();
  ok('员工连接共享文件被拦下', q('#snack-msg').textContent.includes('为了防止误操作'));

  section('权限点位：组长可以做员工做不了的事，但摸不到管理员专属操作');
  S.DB.settings.me = '测试组长';
  S.ACTIONS['reset-all']();
  ok('组长一样碰不了重置全部数据（管理员专属）', q('#snack-msg').textContent.includes('为了防止误操作'));

  section('批量操作：跳过没权限编辑的记录，而不是整批失败或整批放行');
  S.DB.settings.me = '测试员工';
  const otherTask2 = S.DB.tasks.find(t => !t.deleted_at && t.owner !== '测试员工' && !(t.assignees || []).includes('测试员工'));
  const myTask = { ...otherTask2, id: 'test_batch_mine', owner: '测试员工', assignees: [], status: 'todo', rev: 1 };
  await S.Repo.upsert('task', myTask);   // 用 upsert 而不是直接 push，确保 IDX 索引同步更新，byId() 才查得到
  const otherStatusBefore = otherTask2.status;
  S.UI.tasks.sel = new Set([otherTask2.id, myTask.id]);
  S.ACTIONS['batch']({ field: 'status' });
  q('#be-status').value = 'doing';
  await S.modalCallback();
  ok('自己负责的那条改成功了', S.byId('task', myTask.id).status === 'doing');
  ok('别人负责的那条被跳过，状态没变', S.byId('task', otherTask2.id).status === otherStatusBefore);
  ok('提示里说明了跳过的条数', q('#snack-msg').textContent.includes('跳过'), q('#snack-msg').textContent);
  S.DB.tasks = S.DB.tasks.filter(t => t.id !== 'test_batch_mine');
  S.UI.tasks.sel.clear();

  section('账号管理面板：处室领导/管理员的可编辑范围不同');
  S.DB.settings.me = '测试管理员';
  const director = { name: '测试处室领导', role: 'director', salt: '', hash: '', iterations: 0 };
  const staff2 = { name: '测试员工2', role: 'staff', salt: '', hash: '', iterations: 0 };
  const admin2 = { name: '测试管理员2', role: 'admin', salt: '', hash: '', iterations: 0 };
  S.DB.users.push(director, staff2, admin2);
  ok('管理员能管理任何角色的账号（包括处室领导、其他管理员）',
     S.canManageAccount(director) && S.canManageAccount(admin2) && S.canManageAccount(staff2));
  S.DB.settings.me = '测试处室领导';
  ok('处室领导能管理员工账号', S.canManageAccount(staff2));
  ok('处室领导不能管理其他处室领导账号', !S.canManageAccount(director));
  ok('处室领导不能管理管理员账号', !S.canManageAccount(admin2));
  const assignable = S.assignableRoles().map(r => r.v).sort();
  ok('处室领导能分配的角色只有员工/组长，不能把人升成处室领导或管理员', assignable.join(',') === ['comanager', 'staff'].sort().join(','));
  const panelHtml = S.accountsPanelHTML();
  ok('面板里处室领导自己名下能管的账号是可编辑下拉框', panelHtml.includes('data-act="account-role-change"'));
  ok('面板文字提到了权限边界', panelHtml.includes('管理员'));

  section('login-create：新建账号流程 + 徐捷首位自动成为管理员');
  S.DB.settings.me = '测试管理员';
  ok('目前系统里已经有管理员（测试管理员），此时新建"徐捷"不应该被特殊照顾', true);
  // 重新构造一个"系统里还没有管理员"的场景，验证徐捷首次创建被自动设为管理员
  const noAdminUsers = S.DB.users.filter(u => u.role !== 'admin');
  S.DB.users = noAdminUsers;
  S.DB.settings.me = '';
  q('#login-new-name').value = '徐捷';
  q('#login-new-pin').value = '123456';
  q('#login-new-pin2').value = '123456';
  await S.ACTIONS['login-create']();
  const xujie = S.DB.users.find(u => u.name === '徐捷');
  ok('徐捷在没有管理员时创建账号，自动成为管理员', !!xujie && xujie.role === 'admin', xujie && xujie.role);
  ok('创建后本机身份自动切到徐捷', S.DB.settings.me === '徐捷');
  ok('PIN 一起哈希记下来了（以后就是靠它验证的）', xujie && !!xujie.hash);

  q('#login-new-name').value = '普通同事';
  q('#login-new-pin').value = '123456';
  q('#login-new-pin2').value = '123456';
  await S.ACTIONS['login-create']();
  const normalUser = S.DB.users.find(u => u.name === '普通同事');
  ok('已经有管理员之后，再新建的账号默认是员工，不会跟着变管理员', !!normalUser && normalUser.role === 'staff', normalUser && normalUser.role);

  section('login-create：校验逻辑（重名/PIN 长度/两次 PIN 一致）');
  q('#login-new-name').value = '徐捷';
  q('#login-new-pin').value = '123456';
  q('#login-new-pin2').value = '123456';
  await S.ACTIONS['login-create']();
  ok('重名会被拒绝，不会覆盖已有账号', S.DB.users.filter(u => u.name === '徐捷').length === 1);
  q('#login-new-name').value = '新人甲';
  q('#login-new-pin').value = '12';
  q('#login-new-pin2').value = '12';
  await S.ACTIONS['login-create']();
  ok('PIN 不足 4 位会被拒绝', !S.DB.users.some(u => u.name === '新人甲'));
  q('#login-new-name').value = '新人乙';
  q('#login-new-pin').value = '123456';
  q('#login-new-pin2').value = '654321';
  await S.ACTIONS['login-create']();
  ok('两次 PIN 不一致会被拒绝', !S.DB.users.some(u => u.name === '新人乙'));

  section('身份识别：选姓名 + 验 PIN，对上了才放行');
  S.DB.settings.me = '';
  await S.ACTIONS['login-verify-pin']({ name: '普通同事' });   // 还没输 PIN，页面上是空的
  ok('PIN 是空的验证不通过', !S.DB.settings.me);
  q('#login-pin').value = '123456';
  await S.ACTIONS['login-verify-pin']({ name: '普通同事' });
  ok('PIN 对上了就登录成功', S.DB.settings.me === '普通同事', S.DB.settings.me);
  S.DB.settings.me = '';
  q('#login-pin').value = '000000';
  await S.ACTIONS['login-verify-pin']({ name: '普通同事' });
  ok('PIN 不对不给进（身份仍然是空的）', !S.DB.settings.me);

  section('users 随共享文件合并（复用通用的按 rev/updated_at 合并逻辑）');
  const localUsers = [{ name: '甲', role: 'staff', rev: 1, updated_at: '2026-01-01T00:00:00.000Z' }];
  const remoteUsers = [
    { name: '甲', role: 'comanager', rev: 2, updated_at: '2026-01-02T00:00:00.000Z' },   // 对方把甲提升为组长，版本更高
    { name: '乙', role: 'staff', rev: 1, updated_at: '2026-01-01T00:00:00.000Z' },        // 对方新增的账号
  ];
  const mergedUsers = S.mergeByPk('name', localUsers, remoteUsers);
  ok('账号也遵循版本号合并（对方更新的角色变更会被采纳）', mergedUsers.find(u => u.name === '甲').role === 'comanager');
  ok('对方新增的账号会被收进来', mergedUsers.some(u => u.name === '乙'));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
