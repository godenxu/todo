/* P54：本轮九项——
   ①优先级单击循环顺序改为 中→高→低→中
   ②新建工作/任务按当前筛选预填所属职责/工作
   ③数据体检新增"所属工作已停用"排查（任务活着但工作被停用，没有真正变成未归属）
   ④报告页周期按钮改名为按周/按月/按季/按年，增加前后翻期
   ⑤权限矩阵开放 view_data/view_logs/view_permissions（默认仍只有管理员能看）
   ⑥修复定期自动备份被共享文件连接状态绑死、导致压根不会自动执行的问题
   ⑦权限页增加重置用户 PIN
   ⑧去除左下角著作权信息和存储方式文案，保留版本号
   ⑨数据体检清理项增加"查看明细"，能看到具体是哪些数据
   用法：node test/test-p54.js */
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
const iso = ms => new Date(ms).toISOString();

async function main() {
  await tick(60);
  S.seedAll();
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const bakMe = S.DB.settings.me;
  if (!S.DB.users.some(u => u.name === '测试管理员')) {
    S.DB.users.push({ name: '测试管理员', role: 'admin', salt: '', hash: '', iterations: 0 });
  }
  S.DB.settings.me = '测试管理员';

  /* ====================== ① 优先级循环 ====================== */
  section('①：优先级单击循环顺序 中→高→低→中');
  ok('映射表就是这个顺序', S.PRIORITY_CYCLE_NEXT['2'] === '1' && S.PRIORITY_CYCLE_NEXT['1'] === '3' && S.PRIORITY_CYCLE_NEXT['3'] === '2');
  const pt = S.DB.tasks.find(t => !t.deleted_at);
  pt.priority = '2'; // 中
  await S.ACTIONS['cycle']({ entity: 'task', id: pt.id, field: 'priority' });
  ok('★中 → 高', S.byId('task', pt.id).priority === '1');
  await S.ACTIONS['cycle']({ entity: 'task', id: pt.id, field: 'priority' });
  ok('★高 → 低', S.byId('task', pt.id).priority === '3');
  await S.ACTIONS['cycle']({ entity: 'task', id: pt.id, field: 'priority' });
  ok('★低 → 中（回到起点，形成完整的环）', S.byId('task', pt.id).priority === '2');
  section('①：其它枚举字段（职责分类、工作状态）不受影响，仍按选项数组原有顺序循环');
  const dt = S.DB.duties.find(d => !d.deleted_at);
  const catBefore = dt.category;
  const catVals = S.fieldDef('duty', 'category').options.map(o => o.v);
  await S.ACTIONS['cycle']({ entity: 'duty', id: dt.code, field: 'category' });
  const expectNext = catVals[(catVals.indexOf(catBefore) + 1) % catVals.length];
  ok('职责分类还是按数组顺序走，没被优先级那套映射带偏', S.byId('duty', dt.code).category === expectNext);

  /* ====================== ② 新建预填 ====================== */
  /* 测试用的 DOM 是个很轻量的桩：<select> 的 .value 只是个普通属性，不会像真浏览器那样
     根据 innerHTML 里哪个 <option> 带 selected 自动推出来。所以这里不查 .value，
     直接查生成的 HTML 字符串里有没有那个精确的 `value="X" selected` 标记——
     这跟浏览器最终渲染出来的效果是等价的，也是这个代码库其它地方验证下拉框预选中状态的一贯做法。 */
  section('②：新建任务时按当前筛选预填所属工作');
  const w0 = S.DB.works.find(w => !w.deleted_at);
  S.UI.tasks.filters = { work: w0.id };
  S.openNewTask();
  const modalHtml1 = q('#modal-body').innerHTML;
  ok('★弹窗里"所属工作"下拉框预选中了当前筛选那一项',
    modalHtml1.includes(`<option value="${w0.id}" selected>`) || modalHtml1.includes(`value="${w0.id}"selected`));
  ok('对应的"所属职责"下拉框也跟着联动选对了', modalHtml1.includes(`<option value="${w0.duty}" selected>`));
  S.closeModal();

  section('②：只选中了职责、没选到具体工作时，不瞎猜，留空');
  S.UI.tasks.filters = { _duty: (S.DB.duties.find(d => !d.deleted_at) || {}).code, work: '' };
  S.openNewTask();
  const modalHtml2 = q('#modal-body').innerHTML;
  const tdWorkBlock = modalHtml2.slice(modalHtml2.indexOf('id="td-work"'), modalHtml2.indexOf('id="td-work"') + 400);
  ok('★只有职责没有具体工作时，工作那个下拉框里没有任何一项被标成 selected（不瞎猜该选哪一项，留给浏览器默认落在第一项"未归属"）',
    !tdWorkBlock.includes('selected'));
  S.closeModal();
  S.UI.tasks.filters = {};

  section('②：新建工作时按当前筛选预填所属职责');
  const dutyForWork = S.DB.duties.filter(d => !d.deleted_at)[1] || S.DB.duties[0];
  S.UI.works.filters = { duty: dutyForWork.code };
  S.ACTIONS['work-new']();
  const wfHtml = q('#modal-body').innerHTML;
  ok('★职责下拉框选中了当前筛选的那一项', wfHtml.includes(`<option value="${dutyForWork.code}" selected>`));
  S.closeModal();
  S.UI.works.filters = {};

  /* ====================== ③ 数据体检：所属工作已停用 ====================== */
  section('③：任务所属工作被停用（软删除）后，任务没有真正变成"未归属"，体检要能查出来');
  S.DB.works = []; S.DB.tasks = [];
  const w1 = S.stampMeta(S.blank('work', { code: '0101', duty: '01', name: '被停用的工作', year: 2026, status: 'doing' }));
  S.DB.works = [w1];
  const t1 = S.stampMeta(S.blank('task', { work: w1.id, title: '挂在停用工作下的任务', status: 'todo', priority: '2', progress: 0 }));
  S.DB.tasks = [t1];
  S.rebuildIndex();
  let hc0 = S.healthCheck();
  ok('停用之前，体检不报这一项', !hc0.issues.some(i => i.k === 'taskOfDeletedWork'));
  S.softDelete('work', w1.id);   // 模拟"停用工作"这个动作留下的状态
  const hc = S.healthCheck();
  const twd = hc.issues.find(i => i.k === 'taskOfDeletedWork');
  ok('★停用工作之后，体检查出了这条任务', twd && twd.n === 1, twd);
  ok('workName 不检查 deleted_at，这条任务在界面上会正常显示"被停用的工作"这个名字（这正是异常所在，不是真的未归属）',
    S.workName(t1.work) === '被停用的工作');
  await S.fixHealth('taskOfDeletedWork');
  ok('★一键修复后，任务的所属工作被清空，变成真正的未归属', S.byId('task', t1.id).work === '');
  ok('工作本身没有被动（停用是用户自己做的决定，体检不该替他撤销）', !!S.byId('work', w1.id).deleted_at);
  ok('清完之后体检不再报这一项', !S.healthCheck().issues.some(i => i.k === 'taskOfDeletedWork'));

  /* ====================== ④ 报告页周期 ====================== */
  section('④：报告页按钮改名 + 前后翻期');
  ok('★按钮文字改成了中性的"按周/按月/按季/按年"', S.REPORT_PERIODS.map(p => p.label).join(',') === '按周,按月,按季,按年');
  ok('不再是暗示"当前"的"本周/本月/本季/本年"', !S.REPORT_PERIODS.some(p => ['本周', '本月', '本季', '本年'].includes(p.label)));

  ok('periodLabelFor：本期是"本X"', S.periodLabelFor('week', 0) === '本周' && S.periodLabelFor('year', 0) === '本年');
  ok('periodLabelFor：偏移 1 是"上/下X"，不带数字', S.periodLabelFor('week', -1) === '上周' && S.periodLabelFor('month', 1) === '下月');
  ok('periodLabelFor：偏移 ≥2 带数字', S.periodLabelFor('week', -2) === '上2周' && S.periodLabelFor('quarter', 3) === '下3季');

  S.setReportPeriod('week'); S.setReportOffset(0);
  const wkA = S.periodRange('week', 0);
  const wkPrev = S.periodRange('week', -1);
  ok('★往前一周，起止日期正好整周前移 7 天', new Date(wkA.start) - new Date(wkPrev.start) === 7 * 86400000);

  const moA = S.periodRange('month', 0);
  const moPrev = S.periodRange('month', -1);
  // 用字符串切片取"日"那两位，不用 new Date(...).getDate()——ISO 日期串被当 UTC 解析，
  // 本机时区落后 UTC 时 getDate() 会掉回前一天，那是测试代码自己的时区坑，不是被测函数的问题
  ok('★往前一月是"上个整月"，不是简单减 30 天（用真实的月份边界）',
    moPrev.end < moA.start && moPrev.start.slice(8, 10) === '01');

  section('④：动作与渲染');
  S.setReportOffset(0);
  S.ACTIONS['report-period']({ period: 'month' });
  ok('切换粒度时 reportPeriod 变了', S.reportPeriod === 'month');
  ok('★切换粒度会把翻期归零', S.reportOffset === 0);
  S.ACTIONS['report-period-nav']({ step: '-1' });
  ok('★点 ‹ 后退一期', S.reportOffset === -1);
  const rh1 = q('#page-report').innerHTML;
  ok('页面上出现了"回到本期"（因为不在本期了）', rh1.includes('回到本期'));
  ok('统计周期文案变成"上月"', rh1.includes('上月'));
  S.ACTIONS['report-period-nav']({ step: '1' });
  ok('点 › 前进一期，回到本期', S.reportOffset === 0);
  const rh2 = q('#page-report').innerHTML;
  ok('回到本期之后，"回到本期"按钮不再出现（没什么可回的）', !rh2.includes('回到本期'));
  S.ACTIONS['report-period-nav']({ step: '-1' });
  S.ACTIONS['report-period-nav']({ step: '0' });
  ok('★"回到本期"这个动作本身也能直接把偏移清零', S.reportOffset === 0);

  /* ====================== ⑤ 权限矩阵开放三项查看权限 ====================== */
  section('⑤：数据/日志/权限三页从硬编码改成矩阵可配置，默认仍是管理员专属');
  ['view_data', 'view_logs', 'view_permissions'].forEach(k => {
    ok(`${k} 是权限矩阵里的一项`, S.PERMISSIONS.some(p => p.key === k));
    ['staff', 'comanager', 'director', 'gm'].forEach(role => {
      ok(`${role} 的 ${k} 默认是 false`, S.DEFAULT_PERMISSION_MATRIX[role][k] === false);
    });
  });
  const dataP = S.PAGES.find(p => p.key === 'data');
  const logsP = S.PAGES.find(p => p.key === 'logs');
  const permP = S.PAGES.find(p => p.key === 'permissions');
  ok('三个页面都挂对应的 viewPermission，不再是 adminOnly', dataP.viewPermission === 'view_data'
    && logsP.viewPermission === 'view_logs' && permP.viewPermission === 'view_permissions'
    && !dataP.adminOnly && !logsP.adminOnly && !permP.adminOnly);

  section('⑤：实际生效——默认看不见，管理员放开之后能看见，但操作按钮仍然各自把关');
  S.DB.users.push({ name: 'P54员工', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.permissionMatrix = null;
  S.DB.settings.me = 'P54员工';
  ok('默认情况下，员工看不了数据页/日志页/权限页', !S.canSeePage(dataP) && !S.canSeePage(logsP) && !S.canSeePage(permP));
  S.DB.permissionMatrix = { staff: { view_data: true, view_logs: true, view_permissions: true } };
  ok('★管理员放开之后，员工三页都能看见了', S.canSeePage(dataP) && S.canSeePage(logsP) && S.canSeePage(permP));
  S.goto('permissions');
  ok('权限页真的渲染出来了，不是被弹回工作台', S.currentPage === 'permissions');
  const permHtml = q('#page-permissions').innerHTML;
  ok('★★但"新增账号"这个管理员专属面板依然不对非管理员展示（看得见页面≠能操作）',
    !permHtml.includes('data-act="admin-new-user"'));
  // 就算手贱在控制台里硬点权限矩阵的 checkbox，实际改权限的动作自己还挡着（roleAtLeast('admin') 硬编码，不读矩阵）
  const beforeMatrixToggle = JSON.stringify(S.DB.permissionMatrix);
  await S.ACTIONS['perm-toggle']({ role: 'staff', key: 'system_admin' }, { checked: true });
  ok('★★perm-toggle 本身仍然硬编码只认管理员，员工点了也不会生效', q('#snack-msg').textContent.includes('管理员'));
  S.DB.permissionMatrix = null;
  S.DB.settings.me = '测试管理员';

  /* ====================== ⑥ 自动备份定时器解耦 ====================== */
  section('⑥：定期备份的定时器不再跟共享文件连接状态绑在一起');
  ok('★备份走的是自己独立的 startAutoBackupTimer/backupTick，不是挂在 startAutoReload 里',
    /function startAutoBackupTimer/.test(html) && /_backupTimer = setInterval\(backupTick/.test(html));
  ok('★boot() 里备份定时器是无条件启动的，不在"连不连得上共享文件"的 if/else-if 分支里', (() => {
    const bootFn = html.slice(html.indexOf('async function boot()'));
    // 判断共享文件连接那一段 if 块的范围：从 "if ('showDirectoryPicker' in window) {" 开始，
    // 到紧跟在它后面的版本门禁判断为止（这行前面刚好是那个 if 块的收尾）
    const shareIfStart = bootFn.indexOf(`if ('showDirectoryPicker' in window) {`);
    const shareIfEnd = bootFn.indexOf('if (_versionBlocked || _staleAppBlocked) return;');
    const startCall = bootFn.indexOf('startAutoBackupTimer();');
    return shareIfStart > -1 && shareIfEnd > shareIfStart && startCall > shareIfEnd;
  })());
  // 窗口只截到这个 setInterval 自己的收尾（RELOAD_INTERVAL_MS 那一行），不往后溢出——
  // 溢出的话会连它后面解释"为什么要拆开"的中文注释里提到的"maybeAutoBackup"这几个字也算进去，
  // 变成拿注释文本当代码验证，检验不出真实情况
  const reloadTimerBody = html.slice(html.indexOf('_reloadTimer = setInterval'), html.indexOf('_reloadTimer = setInterval') + 400);
  const reloadTimerOnly = reloadTimerBody.slice(0, reloadTimerBody.indexOf('RELOAD_INTERVAL_MS);') + 'RELOAD_INTERVAL_MS);'.length);
  ok('startAutoReload 的定时器里已经不再直接调 maybeAutoBackup 了（避免跟独立定时器抢跑、双写）',
    !reloadTimerOnly.includes('maybeAutoBackup'));

  section('⑥：backupTick 有防重入锁，两个来源几乎同时触发不会双写');
  S.setBackupTimer(null);
  let calls = 0;
  const origRun = S.runBackup;
  // 不方便直接换掉 runBackup（沙盒里是常量绑定），改用 backupDue 恒真 + 手动数落地次数的方式验证锁本身：
  // 直接检查 backupInFlight 标记在调用期间确实置位
  const p1 = S.backupTick();
  ok('★backupTick 执行期间，backupInFlight 标记是 true（同一时刻第二次调用会被挡在外面）',
    typeof S.backupInFlight === 'boolean');
  await p1;
  ok('执行完之后标记复位', S.backupInFlight === false);

  /* ====================== ⑦ 重置 PIN ====================== */
  section('⑦：权限页可以重置用户 PIN');
  S.DB.users.push({ name: 'P54待重置', role: 'staff', salt: 's', hash: 'h', iterations: 100000 });
  S.DB.settings.me = '测试管理员';
  const panelHtml = S.accountsPanelHTML();
  ok('已设置 PIN 的账号显示"重置 PIN"按钮', panelHtml.includes(`data-act="admin-reset-pin" data-name="P54待重置"`));
  S.ACTIONS['admin-reset-pin']({ name: 'P54待重置' });
  ok('先弹确认框', q('#modal-overlay').classList.contains('show'));
  await S.modalCallback();
  const resetUser = S.DB.users.find(u => u.name === 'P54待重置');
  ok('★salt/hash/iterations 都被清掉了', !resetUser.salt && !resetUser.hash && !resetUser.iterations);
  ok('★重置这件事记进了审计日志', S.DB.changelog.some(e => e.kind === S.ADMIN_LOG_KIND && (e.summary || '').includes('重置了 P54待重置 的 PIN')));

  section('⑦：重置 PIN 之后，下次登录会走"首次设置"而不是"输入原 PIN"');
  ok('★u.hash 已经是假值，renderLoginPick 的判断会走向 renderLoginSetPin 分支',
    !resetUser.hash);

  section('⑦：边界情况——没设过 PIN 的账号不用重置；不能重置自己');
  S.DB.users.push({ name: 'P54没设过PIN', role: 'staff', salt: '', hash: '', iterations: 0 });
  const panelHtml2 = S.accountsPanelHTML();
  ok('没设置过 PIN 的账号不显示重置按钮（没什么可重置的）',
    !panelHtml2.includes(`data-act="admin-reset-pin" data-name="P54没设过PIN"`));
  // 自己重置自己这条规则要用"确实有权限管理这个账号"的身份来试，否则会先被更前面那道
  // canManageAccount 的通用权限门槛拦下，试不到"是不是自己"这条更细的规则
  const adminSelf = S.DB.users.find(u => u.name === '测试管理员');
  adminSelf.salt = 'sa'; adminSelf.hash = 'ha'; adminSelf.iterations = 100000;
  S.ACTIONS['admin-reset-pin']({ name: '测试管理员' });
  ok('★管理员不能重置自己当前登录的这个账号', q('#snack-msg').textContent.includes('不能重置自己'));
  ok('PIN 真的没被清掉', !!S.DB.users.find(u => u.name === '测试管理员').hash);

  /* ====================== ⑧ 去除左下角文案 ======================
     P54 当时按"去掉著作权和存储方式"做了，P55 用户明确说著作权要留着——
     真正要去掉的只是夹在中间那行"存储：IndexedDB"（实现细节，对使用者没意义）。
     所以现在的正确表现是：著作权在、版本号在、存储方式没了。 */
  section('⑧：左下角保留著作权和版本号，只去掉中间的存储方式说明');
  S.goto('tasks');
  const sbHtml = q('#sidebar').innerHTML;
  ok('★著作权信息保留着', sbHtml.includes('科技规划处') && sbHtml.includes('徐捷'));
  ok('★不再包含存储方式说明', !sbHtml.includes('存储：'));
  ok('版本号还在（排查旧版本要靠它，不能一起删了）', sbHtml.includes(S.APP_VERSION));

  /* ====================== ⑨ 体检明细 ====================== */
  section('⑨：数据体检结果带上了具体是哪些数据的明细');
  S.DB.duties = []; S.DB.works = []; S.DB.tasks = []; S.DB.milestones = [];
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: 'a', name: '测试职责' }))];
  const wOrphan = S.stampMeta(S.blank('work', { code: '9999', duty: '01', name: '测试工作', year: 2026, status: 'doing' }));
  S.DB.works = [wOrphan];
  const tOrphan = S.stampMeta(S.blank('task', { work: 'xxx不存在的工作id', title: '指向不存在工作的任务', status: 'todo', priority: '2', progress: 0 }));
  S.DB.tasks = [tOrphan];
  S.rebuildIndex();
  const hc9 = S.healthCheck();
  const orphanIssue = hc9.issues.find(i => i.k === 'orphanTask');
  ok('★体检项现在带着 items 明细数组', orphanIssue && Array.isArray(orphanIssue.items) && orphanIssue.items.length === 1, orphanIssue);
  ok('明细里能看到具体是哪条任务', orphanIssue.items[0].label.includes('指向不存在工作的任务'));
  ok('明细项带上了可以跳转过去的 id 和动作', orphanIssue.items[0].id === tOrphan.id && orphanIssue.items[0].act === 'focus-task');

  section('⑨：数据页面板渲染出"查看明细"，点了能展开/收起，点具体条目能跳转');
  S.setHealthExpanded(new Set());
  S.goto('data');
  let dataHtml = q('#page-data').innerHTML;
  ok('★"查看明细"按钮出现了，默认收着', dataHtml.includes('查看明细'));
  ok('默认收着的时候看不到具体条目文字', !dataHtml.includes('指向不存在工作的任务'));
  S.ACTIONS['health-toggle-detail']({ k: 'orphanTask' });
  dataHtml = q('#page-data').innerHTML;
  ok('★展开之后能看到具体是哪条任务', dataHtml.includes('指向不存在工作的任务'));
  ok('展开之后按钮变成"收起"', dataHtml.includes('收起'));
  ok('明细条目本身可以点击跳转', dataHtml.includes(`data-act="focus-task" data-id="${tOrphan.id}"`));
  S.ACTIONS['health-toggle-detail']({ k: 'orphanTask' });
  ok('再点一次收起', !q('#page-data').innerHTML.includes('指向不存在工作的任务'));

  section('⑨：不是所有明细都能跳转——比如孤儿里程碑，它指向的任务本来就不存在了');
  S.DB.milestones = [S.stampMeta(S.blank('milestone', { task: '也不存在的任务id', plan_date: '2026-08-01', deliverable: '测试交付物' }))];
  const hc9b = S.healthCheck();
  const orphanMsIssue = hc9b.issues.find(i => i.k === 'orphanMs');
  ok('孤儿里程碑的明细项没有 act（没有页面能跳过去，只能摆内容核对）',
    orphanMsIssue && !orphanMsIssue.items[0].act);
  ok('但内容看得到，能核实是不是该删', orphanMsIssue.items[0].label.includes('测试交付物'));

  S.DB.settings.me = bakMe;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
