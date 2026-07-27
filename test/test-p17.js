/* P17：本轮改动测试——
   1) 数据页默认只有管理员能看（员工/组长/处室领导默认 view_data = false）
   2) 共享文件夹改为"管理员定模板 + 工号拼接"，不再让用户自己随便选文件：
      DB.users 加 jobNo 字段、DB.shareConfig 模板配置、computeSharePath 拼路径、
      connectSharedFile 改用目录选择器 + 固定文件名
   3) 登录门禁：下拉选择改成输入姓名文本框匹配已建账号，不匹配就提示无法登录；
      只有系统里一个账号都没有时才允许自建（引导创建第一个管理员账号）
   4) 任务详情弹窗加宽（.wide 类）
   5) 数据体检新增"缺计划完成时间但有里程碑"一键补全
   用法：node test/test-p17.js */
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
  const bakShareConfig = S.DB.shareConfig;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.shareConfig = bakShareConfig;
  };

  section('数据页默认只对管理员开放');
  ok('员工默认看不了数据页', S.DEFAULT_PERMISSION_MATRIX.staff.view_data === false);
  ok('组长默认看不了数据页', S.DEFAULT_PERMISSION_MATRIX.comanager.view_data === false);
  ok('处室领导默认看不了数据页', S.DEFAULT_PERMISSION_MATRIX.director.view_data === false);
  ok('部门领导默认看不了数据页（本来就是）', S.DEFAULT_PERMISSION_MATRIX.gm.view_data === false);
  S.DB.users.push({ name: 'P17测试员工', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.permissionMatrix = null;
  S.DB.settings.me = 'P17测试员工';
  ok('实际生效：员工看不到数据页权限', !S.hasPermission('view_data'));
  S.setPage('dashboard');
  S.renderPage(); S.renderShell();
  ok('员工导航栏里没有"数据"入口', !q('#nav').innerHTML.includes('data-page="data"'));
  S.goto('data');
  ok('员工直接跳数据页会被弹回工作台', S.currentPage === 'dashboard', S.currentPage);
  S.DB.settings.me = '测试管理员';
  ok('管理员恒有 view_data 权限（不读矩阵）', S.hasPermission('view_data'));

  section('任务详情弹窗加宽');
  const anyTask = S.DB.tasks.find(t => !t.deleted_at);
  S.openTaskDetail(anyTask.id);
  ok('打开任务详情后 modal-box 带上了 wide 类', q('#modal-box').classList.contains('wide'));
  S.ACTIONS['modal-cancel']();
  ok('关闭弹窗后 wide 类被摘掉（不会污染其它弹窗）', !q('#modal-box').classList.contains('wide'));

  section('数据体检：缺计划完成时间但有里程碑 → 一键补全');
  const dutyCode = 'P17FIX';
  await S.Repo.upsert('duty', { code: dutyCode, name: 'P17测试职责' });
  const wid = 'w_p17fix';
  await S.Repo.upsert('work', { id: wid, duty: dutyCode, name: 'P17工作', owner: '测试管理员' });
  const taskId = 'p17_nodate_task';
  await S.Repo.upsert('task', { id: taskId, work: wid, title: 'P17缺日期任务', status: 'todo', plan_date: '', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p17_ms1', task: taskId, plan_date: '2026-10-05', deliverable: 'P17交付物1', report_level: 'section', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p17_ms2', task: taskId, plan_date: '2026-11-20', deliverable: 'P17交付物2（最晚）', report_level: 'section', done: '0' });
  let hc = S.healthCheck();
  const issue = hc.issues.find(i => i.k === 'noDateHasMs');
  ok('体检发现了这条"缺日期但有里程碑"的任务', !!issue && issue.n >= 1, issue);
  ok('这个任务不会被算进和它无关的普通 noDate 提示之外——两条都应该在（noDate 也会算上它）',
    hc.issues.some(i => i.k === 'noDate' && i.n >= 1));
  await S.fixHealth('noDateHasMs');
  const fixedTask = S.byId('task', taskId);
  ok('一键补全后，任务计划完成时间变成了最晚的里程碑日期（2026-11-20）', fixedTask.plan_date === '2026-11-20', fixedTask.plan_date);
  hc = S.healthCheck();
  ok('修复后这条问题消失了', !hc.issues.some(i => i.k === 'noDateHasMs' && i.n >= 1 && false) &&
    !(hc.issues.find(i => i.k === 'noDateHasMs')));

  section('工号：computeSharePath 纯函数');
  ok('模板里两处占位符都替换成工号', S.computeSharePath({ pathTemplate: 'A{工号}B{工号}C' }, '12345678') === 'A12345678B12345678C');
  ok('没填工号时用占位提示，不留空', S.computeSharePath({ pathTemplate: 'A{工号}B' }, '').includes('_'));
  ok('没有模板时返回空字符串', S.computeSharePath({}, '12345678') === '');
  ok('cfg 本身是 null 也不报错', S.computeSharePath(null, '12345678') === '');
  ok('DEFAULT_SHARE_FILE_NAME 是个非空文件名', typeof S.DEFAULT_SHARE_FILE_NAME === 'string' && S.DEFAULT_SHARE_FILE_NAME.endsWith('.json'));

  section('工号：新增账号时可以一起填，格式会被校验');
  S.DB.settings.me = '测试管理员';
  q('#adm-new-name').value = 'P17新同事甲';
  q('#adm-new-role').value = 'staff';
  q('#adm-new-jobno').value = '1234';   // 不足 8 位
  q('#adm-new-pin').value = '5678';
  await S.ACTIONS['admin-new-user']();
  ok('工号不是 8 位数字时创建被拒绝', !S.DB.users.some(u => u.name === 'P17新同事甲'));
  ok('提示说明了工号格式要求', q('#snack-msg').textContent.includes('工号'), q('#snack-msg').textContent);
  q('#adm-new-jobno').value = '20260001';
  await S.ACTIONS['admin-new-user']();
  const created = S.DB.users.find(u => u.name === 'P17新同事甲');
  ok('工号是 8 位数字时创建成功，且工号被存下来了', !!created && created.jobNo === '20260001', created);
  q('#adm-new-name').value = 'P17新同事乙';
  q('#adm-new-jobno').value = '';
  q('#adm-new-pin').value = '5678';
  await S.ACTIONS['admin-new-user']();
  ok('工号留空也能创建（选填）', S.DB.users.some(u => u.name === 'P17新同事乙' && (u.jobNo === '' || u.jobNo === undefined)));

  section('工号：账号列表里可以后补/修改工号（受权限约束）');
  const panelHtml = S.accountsPanelHTML();
  ok('账号列表里有"工号"这一列', panelHtml.includes('工号'));
  ok('可管理的账号，工号是个可编辑输入框', new RegExp(`data-act="account-jobno-change" data-name="P17新同事乙"`).test(panelHtml));
  await S.ACTIONS['account-jobno-change']({ name: 'P17新同事乙' }, { value: '9999' });
  ok('格式不对（不是 8 位数字）会被拒绝', !S.DB.users.find(u => u.name === 'P17新同事乙').jobNo);
  await S.ACTIONS['account-jobno-change']({ name: 'P17新同事乙' }, { value: '20260099' });
  ok('格式对了就存下来了', S.DB.users.find(u => u.name === 'P17新同事乙').jobNo === '20260099');
  S.DB.settings.me = 'P17新同事乙';   // 换成一个没有管理权限的普通员工
  await S.ACTIONS['account-jobno-change']({ name: '测试管理员' }, { value: '11111111' });
  ok('没有管理权限时不能改别人的工号', S.DB.users.find(u => u.name === '测试管理员').jobNo !== '11111111');
  S.DB.settings.me = '测试管理员';

  section('权限页"新增账号"表单里有工号输入框');
  S.renderPermissions();
  const permHtml = q('#page-permissions').innerHTML;
  ok('有 id="adm-new-jobno" 的输入框', permHtml.includes('id="adm-new-jobno"'));

  section('共享文件夹设置：数据页面板（管理员可见可编辑，非管理员只读提示）');
  S.DB.shareConfig = null;
  S.DB.settings.me = '测试管理员';
  S.setPage('data'); S.renderData();
  let dataHtml = q('#page-data').innerHTML;
  ok('管理员能看到"共享文件夹设置"面板', dataHtml.includes('共享文件夹设置'));
  ok('面板里有路径模板输入框', dataHtml.includes('id="share-path-template"'));
  q('#share-path-template').value = '\\\\NAS\\部门共享\\{工号}\\对接\\{工号}\\Todo';
  q('#share-file-name').value = '';
  await S.ACTIONS['share-config-save']();
  ok('保存后 DB.shareConfig 有了路径模板', S.DB.shareConfig && S.DB.shareConfig.pathTemplate.includes('{工号}'));
  ok('文件名留空时退回默认文件名', S.DB.shareConfig.fileName === S.DEFAULT_SHARE_FILE_NAME);
  S.renderData();
  dataHtml = q('#page-data').innerHTML;
  const admin = S.DB.users.find(u => u.name === '测试管理员');
  if (admin && admin.jobNo) {
    ok('管理员自己的工号已填时，面板显示了他自己算出来的路径', dataHtml.includes(S.computeSharePath(S.DB.shareConfig, admin.jobNo)));
  } else {
    ok('管理员自己还没填工号时，提示"还没填工号"', dataHtml.includes('还没填工号'));
  }

  section('共享文件夹设置：非管理员（即使能看数据页）看到的是只读提示，改不了');
  S.DB.permissionMatrix = { staff: { ...S.DEFAULT_PERMISSION_MATRIX.staff, view_data: true } };
  S.DB.settings.me = 'P17新同事乙';
  S.renderData();
  const staffDataHtml = q('#page-data').innerHTML;
  ok('普通员工看不到"共享文件夹设置（仅管理员）"这个可编辑面板', !staffDataHtml.includes('共享文件夹设置（仅管理员）'));
  ok('普通员工点连接共享文件夹会被权限拦下', (() => {
    S.ACTIONS['connect-shared']();
    return q('#snack-msg').textContent.includes('为了防止误操作');
  })());
  S.DB.permissionMatrix = null;
  S.DB.settings.me = '测试管理员';

  section('syncPayload / mergeSyncPayload 都带上了 shareConfig');
  const payload = S.syncPayload(S.DB);
  ok('syncPayload 里有 shareConfig 字段', 'shareConfig' in payload);
  const merged = S.mergeSyncPayload(
    { shareConfig: { pathTemplate: '旧模板', rev: 1, updated_at: '2026-01-01T00:00:00.000Z' } },
    { shareConfig: { pathTemplate: '新模板（对方更新）', rev: 2, updated_at: '2026-01-02T00:00:00.000Z' } }
  );
  ok('版本号更高的 shareConfig 会被采用', merged.shareConfig.pathTemplate === '新模板（对方更新）');

  section('浏览器不支持文件系统访问时优雅降级（换成目录选择器后依旧如此）');
  S.setFileHandle(null);
  await S.connectSharedFile();
  ok('没有 showDirectoryPicker 时给出提示而不是崩溃', q('#snack-msg').textContent.includes('文件系统访问'), q('#snack-msg').textContent);
  ok('没连上就是没连上', !S.fileHandle);

  section('登录门禁：输入姓名文本框，精确匹配已有账号');
  const loginUsers = S.DB.users.filter(u => !u.deleted_at);
  ok('已有账号时，登录选择页是姓名输入框而不是下拉选择', (() => {
    S.renderLoginPick();
    const h = q('#login-body').innerHTML;
    return h.includes('id="login-pick"') && !h.includes('新建账号');
  })());
  q('#login-pick').value = '';
  S.ACTIONS['login-next']();
  ok('姓名留空会提示先输入', q('#login-body').innerHTML.includes('请输入姓名'));
  q('#login-pick').value = '这个名字肯定不存在_P17';
  S.ACTIONS['login-next']();
  ok('姓名不在已建账号里会提示无法登录', q('#login-body').innerHTML.includes('没有这个账号'));
  q('#login-pick').value = '测试管理员';
  S.ACTIONS['login-next']();
  ok('姓名匹配到已有账号后进入 PIN 验证步骤', q('#login-body').innerHTML.includes('PIN'));

  section('登录门禁：系统里一个账号都没有时，才允许引导创建第一个（管理员）账号');
  const allUsersBak = JSON.parse(JSON.stringify(S.DB.users));
  S.DB.users = [];
  S.renderLoginPick();
  const bootstrapHtml = q('#login-body').innerHTML;
  ok('直接进入创建账号引导，而不是姓名输入框', bootstrapHtml.includes('id="login-new-name"') && !bootstrapHtml.includes('id="login-pick"'));
  ok('引导文案说明这是第一个（管理员）账号', bootstrapHtml.includes('管理员'));
  S.DB.users = allUsersBak;

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
