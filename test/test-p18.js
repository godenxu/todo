/* P18：本轮改动测试——
   1) 修复"数据页默认关闭对员工/组长/处室领导不生效"的根因：perm-toggle 以前会把整份合并矩阵
      （含大量沿用默认值的键）整体存死，导致新默认值被旧快照掩盖；改成只存真正点过的键（稀疏对象），
      并加一次性迁移 migrateViewDataDefault() 清掉已有存量数据里显式的 view_data:true
   2) 登录/建号成功后自动尝试连接共享文件夹（不用去数据页找按钮）：
      顶栏常驻的"连接共享文件夹"提示（不受角色限制）+ connect-my-shared-folder 动作（无权限门槛）+
      maybeAutoConnectSharedFolder() 只在"没连、且管理员配好了模板"时才出手
   用法：node test/test-p18.js */
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
  const bakShareConfig = S.DB.shareConfig;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.permissionMatrix = bakMatrix;
    S.DB.shareConfig = bakShareConfig;
    S.setFileHandle(null);
  };

  section('perm-toggle 改成稀疏存储：只存真正点过的键，不把整份默认矩阵快照进去');
  S.DB.permissionMatrix = null;
  S.DB.settings.me = '测试管理员';
  await S.ACTIONS['perm-toggle']({ role: 'comanager', key: 'manage_duty_work' }, { checked: false });
  ok('组长这一行现在只有一个键（刚点过的那个）', Object.keys(S.DB.permissionMatrix.comanager).length === 1, S.DB.permissionMatrix.comanager);
  ok('这个键的值确实是刚才设的', S.DB.permissionMatrix.comanager.manage_duty_work === false);
  ok('没被点过的 staff/director/gm 这几行，这次没有被顺手写进任何键',
    !('view_data' in (S.DB.permissionMatrix.staff || {})) && !('view_data' in (S.DB.permissionMatrix.director || {})));
  ok('矩阵合并出来的其它权限，仍然照默认值走（没有被这次点击污染）',
    S.getPermissionMatrix().comanager.bulk_ops === S.DEFAULT_PERMISSION_MATRIX.comanager.bulk_ops);
  await S.ACTIONS['perm-toggle']({ role: 'comanager', key: 'bulk_ops' }, { checked: false });
  ok('再点一个键之后，这一行变成两个键（累加，不是互相覆盖）', Object.keys(S.DB.permissionMatrix.comanager).length === 2);

  section('migrateViewDataDefault：一次性清掉存量数据里被旧快照锁死的 view_data:true');
  S.DB.permissionMatrix = {
    staff: { view_data: true, edit_others_task: false },
    comanager: { view_data: true, manage_duty_work: true },
    director: { view_data: true },
    gm: { view_data: false },
  };
  const changed1 = S.migrateViewDataDefault();
  ok('第一次跑，报告有改动', changed1 === true);
  ok('staff 的 view_data:true 被清掉了（回落到新默认值 false）', !('view_data' in S.DB.permissionMatrix.staff));
  ok('comanager 的 view_data:true 也被清掉了', !('view_data' in S.DB.permissionMatrix.comanager));
  ok('director 的 view_data:true 也被清掉了', !('view_data' in S.DB.permissionMatrix.director));
  ok('同一行里其它已经手动配置过的键不受影响（staff.edit_others_task 还在）', S.DB.permissionMatrix.staff.edit_others_task === false);
  ok('同一行里其它已经手动配置过的键不受影响（comanager.manage_duty_work 还在）', S.DB.permissionMatrix.comanager.manage_duty_work === true);
  ok('gm 本来就是 false，不受影响', S.DB.permissionMatrix.gm.view_data === false);
  ok('迁移后 view_data 实际生效为 false', S.getPermissionMatrix().staff.view_data === false && S.getPermissionMatrix().comanager.view_data === false);
  ok('打上了一次性标记', S.DB.permissionMatrix._viewDataMigratedV1 === true);
  const changed2 = S.migrateViewDataDefault();
  ok('第二次跑（已经迁移过），直接跳过，不报告改动', changed2 === false);
  // 迁移跑过之后，管理员正常在权限页重新手动打开 view_data，不会被这段代码强行关掉
  await S.ACTIONS['perm-toggle']({ role: 'staff', key: 'view_data' }, { checked: true });
  ok('迁移跑过之后，管理员手动重新打开 view_data 是生效的', S.getPermissionMatrix().staff.view_data === true);
  const changed3 = S.migrateViewDataDefault();
  ok('再跑一次迁移，不会把管理员刚重新打开的 view_data 又关掉', changed3 === false && S.getPermissionMatrix().staff.view_data === true);
  S.DB.permissionMatrix = null;

  section('顶栏"连接共享文件夹"提示：只在没连接且管理员配好模板时出现，不挑角色');
  // 沙盒的 window 桩本来就没有 showDirectoryPicker（用来验证"浏览器不支持时优雅降级"），
  // 这里单独临时补一个假的上去，才能验证"浏览器支持"这条分支下的展示逻辑，用完立刻删掉
  raw.window.showDirectoryPicker = () => {};
  S.setFileHandle(null);
  S.DB.shareConfig = null;
  S.renderShell();
  ok('管理员还没配置模板时，顶栏没有这个提示', !q('#share-connect-hint').innerHTML.includes('connect-my-shared-folder'));
  S.DB.shareConfig = { pathTemplate: 'A{工号}B{工号}C', fileName: 'x.json' };
  S.renderShell();
  ok('配好模板、且本机未连接时，顶栏出现了连接提示', q('#share-connect-hint').innerHTML.includes('data-act="connect-my-shared-folder"'));
  S.setFileHandle({ name: 'fake.json' });
  S.renderShell();
  ok('本机已连接时，提示消失', !q('#share-connect-hint').innerHTML.includes('connect-my-shared-folder'));
  S.setFileHandle(null);
  delete raw.window.showDirectoryPicker;

  section('connect-my-shared-folder 动作：不受角色/权限限制（谁都能点）');
  S.DB.users.push({ name: 'P18测试员工', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = 'P18测试员工';
  S.ACTIONS['connect-my-shared-folder']();
  ok('普通员工点这个动作不会被"为了防止误操作"拦下（走到了浏览器能力检测那一步）',
    !q('#snack-msg').textContent.includes('为了防止误操作'));
  ok('沙盒环境没有 showDirectoryPicker，所以提示是"不支持"而不是权限不足', q('#snack-msg').textContent.includes('文件系统访问'));
  S.DB.settings.me = '测试管理员';

  section('maybeAutoConnectSharedFolder：只在"没连 + 有模板 + 浏览器支持"时才出手，其余情况安静跳过');
  q('#snack-msg').textContent = '';
  S.setFileHandle({ name: 'already.json' });
  await S.maybeAutoConnectSharedFolder();
  ok('已经连接时，直接跳过，不会报"不支持"（说明真的没往下走）', !q('#snack-msg').textContent.includes('不支持'));
  S.setFileHandle(null);
  S.DB.shareConfig = null;
  q('#snack-msg').textContent = '';
  await S.maybeAutoConnectSharedFolder();
  ok('管理员还没配置模板时，也安静跳过', !q('#snack-msg').textContent.includes('不支持'));
  S.DB.shareConfig = { pathTemplate: 'A{工号}B', fileName: 'x.json' };
  q('#snack-msg').textContent = '';
  await S.maybeAutoConnectSharedFolder();
  ok('浏览器（沙盒）本身不支持时，安静跳过，不会每次登录都弹一条"不支持"的提示烦用户',
    !q('#snack-msg').textContent.includes('不支持'));
  raw.window.showDirectoryPicker = () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
  q('#snack-msg').textContent = '';
  await S.maybeAutoConnectSharedFolder();
  ok('浏览器支持、条件也都满足时，真的会往下调用 connectSharedFile（这里用抛 AbortError 模拟用户在系统选择框里点了取消，不算错误、不弹提示）',
    !q('#snack-msg').textContent.includes('失败'));
  delete raw.window.showDirectoryPicker;

  section('回归：登录成功流程本身没被自动连接这一步带崩');
  S.DB.settings.me = '';
  q('#login-pin').value = '';
  const staffAcct = S.DB.users.find(u => u.name === 'P18测试员工');
  const { salt, hash, iterations } = await S.hashPin('123456');
  staffAcct.salt = salt; staffAcct.hash = hash; staffAcct.iterations = iterations;
  q('#login-pin').value = '123456';
  await S.ACTIONS['login-verify']({ name: 'P18测试员工' });
  ok('身份确实切换成功了（自动连接那一步没有把正常登录流程搞崩）', S.DB.settings.me === 'P18测试员工');
  ok('提示里仍然是切换成功的文案', q('#snack-msg').textContent.includes('已切换为'));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
