/* P14：本轮改动测试——
   1) 新增"报告"页：一键生成本周简报
   2) 登录/切换身份时的轻提醒
   3) 任务详情弹窗直接展示里程碑明细 + 不再显示 rev/id 等内部字段
   （职责推进健康度标签这一项做完后被要求暂时取消了，没有留在这里）
   用法：node test/test-p14.js */
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

  section('报告页：定义齐全 + 权限门禁');
  const reportPage = S.PAGES.find(p => p.key === 'report');
  ok('PAGES 里有报告页，紧跟在图表之后、数据之前', !!reportPage && reportPage.viewPermission === 'view_report');
  const chartIdx = S.PAGES.findIndex(p => p.key === 'charts');
  const dataIdx = S.PAGES.findIndex(p => p.key === 'data');
  const reportIdx = S.PAGES.findIndex(p => p.key === 'report');
  ok('顺序确实在图表和数据之间', reportIdx === chartIdx + 1 && reportIdx === dataIdx - 1);
  ok('查看组里有查看报告页这一项', S.PERMISSIONS.some(p => p.key === 'view_report' && p.group === '查看'));
  ['staff', 'comanager', 'director', 'gm'].forEach(role => {
    ok(`${role} 默认能看报告页`, S.DEFAULT_PERMISSION_MATRIX[role].view_report === true, role);
  });

  section('报告页：canSeePage 门禁生效，关掉后进不去');
  S.DB.users.push({ name: '测试员工-报告', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试员工-报告';
  S.DB.permissionMatrix = null;
  ok('默认能看报告页', S.canSeePage(reportPage));
  S.DB.permissionMatrix = { staff: { ...S.DEFAULT_PERMISSION_MATRIX.staff, view_report: false }, comanager: S.DEFAULT_PERMISSION_MATRIX.comanager, director: S.DEFAULT_PERMISSION_MATRIX.director, gm: S.DEFAULT_PERMISSION_MATRIX.gm };
  ok('关掉后 canSeePage 返回 false', !S.canSeePage(reportPage));
  S.goto('report');
  ok('直接跳报告页会被弹回工作台', S.currentPage === 'dashboard', S.currentPage);
  S.DB.permissionMatrix = null;
  restore();

  const dutyCode = 'P14FIX';
  await S.Repo.upsert('duty', { code: dutyCode, name: 'P14测试职责' });
  const wid = 'w_p14fix';
  await S.Repo.upsert('work', { id: wid, duty: dutyCode, name: 'P14测试工作', owner: '测试管理员' });
  const yesterday = S.offsetDate(-1);

  section('报告页：渲染内容（先成果、后关注），导出改成打印/图片而不是纯文本弹窗');
  S.DB.settings.me = '测试管理员';
  S.setReportPeriod('week');
  await S.Repo.upsert('task', { id: 'p14_done_this_week', work: wid, title: 'P14本周完成的任务', status: 'done', plan_date: S.todayStr(), actual_date: S.todayStr(), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('task', { id: 'p14_ms_host_task', work: wid, title: 'P14里程碑宿主任务', status: 'doing', plan_date: S.offsetDate(3), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p14_delivered_this_week', task: 'p14_ms_host_task', plan_date: S.offsetDate(-1), deliverable: 'P14本周交付物', report_level: 'section', done: '1', actual_date: S.todayStr() });
  S.goto('report');
  ok('能正常进入报告页', S.currentPage === 'report');
  const reportHtml = q('#page-report').innerHTML;
  ok('页面标题是处室工作简报', reportHtml.includes('处室工作简报'));
  ok('不再是"生成本周简报"这个纯文本按钮了', !reportHtml.includes('data-act="report-copy"'));
  ok('改成了打印/导出PDF按钮', reportHtml.includes('data-act="report-print"'));
  ok('也有导出为图片按钮', reportHtml.includes('data-act="report-image"'));
  /* P55 之后报告页的分段不再是写死的，而是由「报告编排」（区域 + 模块）决定，默认编排就是
     处里汇报要念的四段：当期工作目标 / 当期工作状态 / 需要关注的工作 / 人员工作情况。
     「本期已完成任务」「本期已交付里程碑」这两块从写死的默认版式里挪走了，变成可选模块——
     数据本身（doneInRange / deliveredInRange）一点没动，管理员在编排里勾上就回来。
     所以这里改成验证"默认四段都在、顺序对"，外加"那两个模块勾上之后确实渲染得出来"。 */
  ok('默认编排四段都渲染出来了',
    ['当期处室工作目标', '当期处室工作进展', '当期需要关注的工作', '人员工作情况'].every(t => reportHtml.includes(t)));
  const idxGoal = reportHtml.indexOf('当期处室工作目标');
  const idxAttention = reportHtml.indexOf('当期需要关注的工作');
  const idxPeople = reportHtml.indexOf('人员工作情况');
  ok('顺序是"目标→关注→人员"，跟汇报顺序一致', idxGoal > -1 && idxGoal < idxAttention && idxAttention < idxPeople);
  const d = S.buildReportData('week');
  ok('buildReportData 字段齐全', ['tasks', 'works', 'today', 'period', 'periodLabel', 'rangeStart', 'rangeEnd', 'open', 'overdue', 'doneInRange', 'dutyStat', 'workStat', 'deliveredInRange', 'msAttention'].every(k => k in d));
  ok('本周完成的任务被算进 doneInRange', d.doneInRange.some(t => t.id === 'p14_done_this_week'));
  ok('本周交付的里程碑被算进 deliveredInRange', d.deliveredInRange.some(m => m.id === 'p14_delivered_this_week'));
  // 把这两个可选模块加进第一个区域，验证它们的渲染逻辑本身没坏（只是不在默认编排里而已）
  await S.saveReportConfig(cfg => { S.reportPresetIn(cfg).sections[0].modules.push('doneTasks', 'deliveredMs'); });
  const withDone = q('#page-report').innerHTML;
  ok('勾上"本期已完成任务"模块后，页面上看得到本周完成的任务标题', withDone.includes('P14本周完成的任务'));
  ok('勾上"本期已交付里程碑"模块后，页面上看得到交付物名字', withDone.includes('P14本周交付物'));
  S.DB.reportConfig = null;
  S.renderReport();

  section('报告页：打印/导出图片按钮不会崩溃（真实截图/PDF渲染只能在浏览器里手动验证）');
  S.ACTIONS['report-print']();
  ok('点打印没有抛异常（window.print 被调用）', true);
  await S.ACTIONS['report-image']();
  ok('点导出图片没有抛异常，优雅降级出了提示', !!q('#snack-msg').textContent);

  // P55：纯文本版本改成跟页面走同一份编排，不再另外维护一套写死的顺序
  section('报告页：文本版本（buildReportText）跟页面用同一份编排、同一批模块');
  const reportText = S.buildReportText();
  ok('文本里包含统计周期说明', reportText.includes('统计周期：本周'));
  ok('文本里也是默认那四段', ['当期处室工作目标', '当期处室工作进展', '当期需要关注的工作', '人员工作情况'].every(t => reportText.includes(t)));
  const textIdxGoal = reportText.indexOf('当期处室工作目标');
  const textIdxAttention = reportText.indexOf('当期需要关注的工作');
  ok('纯文本版本的段落顺序跟页面一致', textIdxGoal > -1 && textIdxAttention > -1 && textIdxGoal < textIdxAttention);

  section('报告页：统计周期可以切换（按周/按月/按季/按年）');
  ok('REPORT_PERIODS 有四个选项', S.REPORT_PERIODS.map(p => p.key).join(',') === 'week,month,quarter,year');
  S.ACTIONS['report-period']({ period: 'month' });
  ok('切到本月后 reportPeriod 变了', S.reportPeriod === 'month');
  // P54 之后按钮文字改成中性的"按月"（不再是"本月"）——粒度按钮不再暗示"当前"，
  // 是不是当前这一期改由 periodLabel 动态描述（本月/上月/下2月……）
  ok('页面上按钮也高亮切到按月了', q('#page-report').innerHTML.includes('data-period="month"') && /data-period="month">按月<\/span>/.test(q('#page-report').innerHTML));
  const dMonth = S.buildReportData('month');
  const dQuarter = S.buildReportData('quarter');
  const dYear = S.buildReportData('year');
  ok('本月的统计范围比本周宽（起始日更早或相等）', dMonth.rangeStart <= d.rangeStart);
  ok('本季的统计范围比本月宽', dQuarter.rangeStart <= dMonth.rangeStart);
  ok('本年的统计范围比本季宽', dYear.rangeStart <= dQuarter.rangeStart);
  ok('本月完成的任务（今天完成）也能被本月周期统计到', dMonth.doneInRange.some(t => t.id === 'p14_done_this_week'));
  S.ACTIONS['report-period']({ period: 'week' });   // 切回来，避免影响后面的测试

  section('报告页：职责下面能展开看各工作的推进情况（树状）');
  await S.Repo.upsert('work', { id: 'w_p14fix_2', duty: dutyCode, name: 'P14测试工作二', owner: '测试管理员' });
  await S.Repo.upsert('task', { id: 'p14_work2_task', work: 'w_p14fix_2', title: 'P14工作二的任务', status: 'todo', plan_date: S.offsetDate(20), owner: '测试管理员', assignees: [] });
  S.reportExpanded.clear();
  S.renderReport();
  const collapsedHtml = q('#page-report').innerHTML;
  ok('默认折叠，看不到工作明细行', !collapsedHtml.includes('report-work-row'));
  ok('有展开箭头（▸）', collapsedHtml.includes('data-act="report-duty-toggle"'));
  S.ACTIONS['report-duty-toggle']({ code: dutyCode });
  const expandedHtml = q('#page-report').innerHTML;
  ok('展开后能看到该职责下两项工作的推进条', (expandedHtml.match(/report-work-row/g) || []).length === 2);
  ok('展开后箭头变成 ▾', new RegExp(`data-code="${dutyCode}">▾`).test(expandedHtml));
  ok('工作名字也带出来了', expandedHtml.includes('P14测试工作') && expandedHtml.includes('P14测试工作二'));
  const dWithWork = S.buildReportData('week');
  ok('buildReportData 里带了 workStat', dWithWork.workStat.some(w => w.id === wid) && dWithWork.workStat.some(w => w.id === 'w_p14fix_2'));
  ok('文本版本里工作明细也缩进列在职责下面', S.buildReportText().includes(`　　· ${dWithWork.workStat.find(w => w.id === wid).name}`));
  S.ACTIONS['report-duty-toggle']({ code: dutyCode });   // 收起来，恢复默认状态

  section('任务详情弹窗：只读查看者看到的是摘要列表（日期/交付物/呈报层级/状态）');
  const cpTaskId = 'p14_cp_task';
  await S.Repo.upsert('task', { id: cpTaskId, work: wid, title: '带里程碑的测试任务', status: 'todo', plan_date: S.offsetDate(10), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p14_ms_1', task: cpTaskId, plan_date: S.offsetDate(-3), deliverable: 'P14交付物甲', report_level: 'section', done: '1', actual_date: S.offsetDate(-2) });
  await S.Repo.upsert('milestone', { id: 'p14_ms_2', task: cpTaskId, plan_date: S.offsetDate(5), deliverable: 'P14交付物乙', report_level: 'bank', done: '0' });
  const viewerName = 'P14只读查看者';
  S.DB.users.push({ name: viewerName, role: 'gm', salt: '', hash: '', iterations: 0 });   // 部门领导：能看详情但不能编辑
  S.DB.settings.me = viewerName;
  S.openTaskDetail(cpTaskId);
  const roHtml = q('#modal-body').innerHTML;
  ok('交付物甲的名字直接显示在详情里', roHtml.includes('P14交付物甲'));
  ok('交付物乙也直接显示了', roHtml.includes('P14交付物乙'));
  ok('呈报层级标签也带出来了（处室领导/行领导）', roHtml.includes('处室领导') && roHtml.includes('行领导'));
  ok('已交付的那条标出了完成状态', /P14交付物甲[\s\S]{0,120}已交付/.test(roHtml));
  ok('详情meta里不再出现"版本 rev"这种内部字段', !roHtml.includes('版本 rev'));
  ok('只读模式下没有可编辑的里程碑输入框', !roHtml.includes('data-cp-row'));

  section('任务详情弹窗：能编辑的人（负责人）看到的里程碑就是可以直接改的输入行，不再跳单独弹窗');
  S.DB.settings.me = '测试管理员';
  S.openTaskDetail(cpTaskId);
  ok('打开的还是"任务详情"这一个弹窗，不是别的', q('#modal-title').textContent.includes('任务详情'));
  const editHtml = q('#modal-body').innerHTML;
  ok('里程碑区域直接是可编辑的行（data-cp-row），不是摘要列表', (editHtml.match(/data-cp-row/g) || []).length === 2);
  ok('交付物甲的值直接在输入框里', editHtml.includes('value="P14交付物甲"'));
  ok('交付物乙的值也在', editHtml.includes('value="P14交付物乙"'));
  ok('每行都有"插入一条"按钮，可以再加里程碑', editHtml.includes('data-act="cp-insert-after"'));
  ok('已经不存在"管理"这个按钮/单独弹窗的概念了', !editHtml.includes('data-act="cp-editor"'));

  section('任务详情弹窗布局：所属职责挪到所属工作原来的位置，所属工作自己占一整行撑满宽度');
  ok('"所属职责"这个标签出现了', editHtml.includes('>所属职责<'));
  const dutyIdx = editHtml.indexOf('>所属职责<');
  const workLabelIdx = editHtml.indexOf('>所属工作<');
  ok('所属职责排在所属工作前面（跟编号同一行）', dutyIdx > -1 && workLabelIdx > -1 && dutyIdx < workLabelIdx);
  ok('所属工作的值撑满一整行（class="full"）', /所属工作<\/label>\s*<div class="full">/.test(editHtml));
  // 所属职责现在是可选的下拉框（跟所属工作两级联动），不再是只读文本
  ok('所属职责是个下拉框', editHtml.includes('id="td-duty"'));
  ok('下拉框里当前职责是选中状态', new RegExp(`value="${dutyCode}" selected`).test(editHtml), dutyCode);
  ok('只读模式下所属工作也是撑满一整行（不是编辑时才这样）', /所属工作<\/label><div class="full">/.test(roHtml));

  section('工作台时间线 / 报告页点里程碑：现在直接打开任务详情，不再弹一个单独的里程碑管理框');
  S.ACTIONS['cp-editor']({ id: cpTaskId });
  ok('点里程碑打开的是任务详情弹窗', q('#modal-title').textContent.includes('任务详情'));
  ok('不是里程碑管理弹窗（已经没有这个东西了）', !q('#modal-title').textContent.includes('里程碑 /'));

  section('登录/切换身份的轻提醒：纯逻辑判断');
  const meName = '测试员工-提醒';
  S.DB.users.push({ name: meName, role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = meName;
  const today = S.todayStr();
  await S.Repo.upsert('task', { id: 'p14_remind_late1', work: wid, title: '提醒-逾期1', status: 'todo', plan_date: yesterday, owner: meName, assignees: [] });
  await S.Repo.upsert('task', { id: 'p14_remind_late2', work: wid, title: '提醒-逾期2', status: 'todo', plan_date: yesterday, owner: meName, assignees: [] });
  await S.Repo.upsert('task', { id: 'p14_remind_week1', work: wid, title: '提醒-本周到期', status: 'todo', plan_date: today, owner: meName, assignees: [] });
  const msg = S.personalReminderMsg();
  ok('提到了 2 条逾期', msg.includes('2 条逾期'), msg);
  ok('提到了 1 条本周到期', msg.includes('1 条本周到期'), msg);

  section('登录/切换身份的轻提醒：名下什么都没有时不多嘴');
  const emptyName = '测试员工-无提醒';
  S.DB.users.push({ name: emptyName, role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = emptyName;
  ok('没有逾期/本周到期任务时返回空字符串', S.personalReminderMsg() === '');

  // 登录是姓名+PIN，这句提醒挂在"设置 PIN/验证 PIN 成功登录"这两个动作上
  section('登录流程：首次设置 PIN 登录成功后，提示里带上了这句提醒');
  S.DB.settings.me = '测试管理员';   // 先切走，才能看出下面是否真的切换成功
  q('#login-new-pin').value = '123456';
  q('#login-new-pin2').value = '123456';
  S.DB.settings.me = '';
  await S.ACTIONS['login-set-pin']({ name: meName });
  ok('身份确实切换成功了', S.DB.settings.me === meName, S.DB.settings.me);
  ok('切换提示里带上了逾期/本周到期提醒', q('#snack-msg').textContent.includes('逾期') && q('#snack-msg').textContent.includes('本周到期'), q('#snack-msg').textContent);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
