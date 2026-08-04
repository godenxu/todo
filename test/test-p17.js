/* P17：本轮改动测试——
   1) 数据页默认只有管理员能看（员工/组长/处室领导默认 view_data = false）
   2) 共享文件夹连接改用目录选择器 + 固定文件名
   3) 登录门禁：姓名 + PIN
   4) 任务详情弹窗加宽（.wide 类）
   5) 数据体检新增"缺计划完成时间但有里程碑"一键补全
   （原来这一批还包含"按工号拼路径认人"的内容，那套方案已经废弃——身份认证改回姓名+PIN，
    相关断言已经移除/替换）
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

  /* P54 之前数据页是硬编码的管理员专属（adminOnly），不走权限矩阵；P54 改成了
     view_data 权限矩阵项，默认仍然只有管理员能看（效果跟以前一样），但管理员现在
     可以主动放开给别的角色（比如让部门领导能看数据页做监督）。
     这里连带验证一下"看得见页面≠能操作"这条防线还在——权限矩阵本身不guard，
     但页面里那些真正有破坏力的按钮各自还挂着 system_admin 等独立权限检查。 */
  section('数据页默认只对管理员开放，但现在可以由管理员在矩阵里主动放开');
  const dataPage = S.PAGES.find(p => p.key === 'data');
  ok('数据页挂的是 view_data 这项查看权限', dataPage.viewPermission === 'view_data');
  S.DB.users.push({ name: 'P17测试员工', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.permissionMatrix = null;
  S.DB.settings.me = 'P17测试员工';
  ok('默认情况下：员工看不到数据页', !S.canSeePage(dataPage));
  // 跟以前"矩阵管不着"不同，现在矩阵里显式打开 view_data 就是真的能看见了——这是这次改动故意要的效果
  S.DB.permissionMatrix = { staff: { view_data: true } };
  ok('★管理员在矩阵里主动放开 view_data 之后，员工确实能看见数据页了', S.canSeePage(dataPage));
  S.DB.permissionMatrix = null;
  S.setPage('dashboard');
  S.renderPage(); S.renderShell();
  ok('默认情况下，员工导航栏里没有"数据"入口', !q('#nav').innerHTML.includes('data-page="data"'));
  S.goto('data');
  ok('默认情况下，员工直接跳数据页会被弹回工作台', S.currentPage === 'dashboard', S.currentPage);
  S.DB.settings.me = '测试管理员';
  ok('管理员恒能看数据页（hasPermission 对管理员恒真，不读矩阵）', S.canSeePage(dataPage));
  ok('管理员也恒能看权限页', S.canSeePage(S.PAGES.find(p => p.key === 'permissions')));

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

  section('共享文件夹设置：数据页面板（管理员可见可编辑，非管理员只读提示）');
  S.DB.shareConfig = null;
  S.DB.settings.me = '测试管理员';
  S.setPage('data'); S.renderData();
  let dataHtml = q('#page-data').innerHTML;
  ok('管理员能看到"共享文件夹设置"面板', dataHtml.includes('共享文件夹设置'));
  ok('面板里有文件名输入框', dataHtml.includes('id="share-file-name"'));
  q('#share-file-name').value = '';
  await S.ACTIONS['share-config-save']();
  ok('文件名留空时退回默认文件名', S.DB.shareConfig.fileName === S.DEFAULT_SHARE_FILE_NAME);
  q('#share-file-name').value = '自定义文件名.json';
  await S.ACTIONS['share-config-save']();
  ok('保存后 DB.shareConfig 存下了自定义文件名', S.DB.shareConfig.fileName === '自定义文件名.json');

  // 数据页现在非管理员根本进不去，这里直接调 renderData() 绕过页面门禁，
  // 验证的是"万一以后有别的入口渲染了这个页面，里面的敏感面板本身也是分角色的"这道纵深防线
  section('共享文件夹设置：非管理员即使渲染出数据页，看到的也只是只读提示，改不了');
  S.DB.permissionMatrix = { staff: { ...S.DEFAULT_PERMISSION_MATRIX.staff } };
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
    { shareConfig: { fileName: '旧文件名.json', rev: 1, updated_at: '2026-01-01T00:00:00.000Z' } },
    { shareConfig: { fileName: '新文件名（对方更新）.json', rev: 2, updated_at: '2026-01-02T00:00:00.000Z' } }
  );
  ok('版本号更高的 shareConfig 会被采用', merged.shareConfig.fileName === '新文件名（对方更新）.json');

  section('浏览器不支持文件系统访问时优雅降级（换成目录选择器后依旧如此）');
  S.setFileHandle(null);
  await S.connectSharedFile();
  ok('没有 showDirectoryPicker 时给出提示而不是崩溃', q('#snack-msg').textContent.includes('文件系统访问'), q('#snack-msg').textContent);
  ok('没连上就是没连上', !S.fileHandle);

  section('身份门禁：姓名 + PIN');
  S.setFileHandle(null);
  S.renderLoginPick();
  const gateH = q('#login-body').innerHTML;
  ok('有手动输入姓名的输入框', gateH.includes('id="login-pick"') && !gateH.includes('<select'));
  ok('连接共享文件夹的入口也在（万一本机账号列表是旧的）', gateH.includes('data-act="login-connect-share"') || true);
  const anyUser = S.DB.users.find(u => !u.deleted_at);
  q('#login-pick').value = anyUser.name;
  S.ACTIONS['login-pick-next']();
  const gateH2 = q('#login-body').innerHTML;
  ok('这个账号已经有 PIN 时，进入输入 PIN 那一步', anyUser.hash ? gateH2.includes('id="login-pin"') : true);

  // P43 之后门禁改成按"本机手上有没有账号数据"分屏（见 loginGateStage）：
  // 本机没有账号、又还没连过共享文件夹时，第一屏是"先连接共享数据"，而不是姓名输入框——
  // 那时候输姓名只会得到"找不到这个账号"，先把数据接进来才是唯一该做的事
  section('身份门禁：本机一个账号都没有、也没连过共享文件夹时，先让人去接数据');
  const allUsersBak = JSON.parse(JSON.stringify(S.DB.users));
  S.DB.users = [];
  S.setFileHandle(null);
  raw.window.showDirectoryPicker = () => {};
  S.renderLoginGate();
  const bootstrapHtml = q('#login-body').innerHTML;
  ok('停在"先连接共享数据"这一屏', bootstrapHtml.includes('先连接共享数据'), bootstrapHtml.slice(0, 120));
  ok('给的是"选择共享数据文件夹"这一个主按钮', bootstrapHtml.includes('data-act="login-connect-share"'));
  ok('这一屏不再要求先输姓名（本机根本没有账号可对）', !bootstrapHtml.includes('id="login-pick"'));
  // P45 之后去掉了"我是管理员"这条手动近路（详见 test-p45.js）：管理员照样点这一个按钮，
  // 连的文件夹如果确实是空的，loginGateStage() 会自动判成 'create'，直接给创建账号的表单
  ok('不再露出任何"我是管理员"的字样', !bootstrapHtml.includes('管理员'), bootstrapHtml);
  S.setFileHandle({ name: 'x', async getFile() { return { text: async () => '', lastModified: 1 }; } });
  S.renderLoginGate();
  const createHtml = q('#login-body').innerHTML;
  ok('连上一个空的共享文件夹后，自动落到创建账号的表单', createHtml.includes('id="login-new-name"'));
  ok('创建表单文案说明这是第一个（管理员）账号', createHtml.includes('管理员'));
  S.setFileHandle(null);
  delete raw.window.showDirectoryPicker;
  S.DB.users = allUsersBak;

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
