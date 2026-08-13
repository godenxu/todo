/* P66：报告页十项反馈
   ① 本期已交付里程碑/即将到期里程碑清单，跟本期已完成任务一样带上牵头人
   ② 里程碑完成情况分布里的"未完成（未逾期）"改叫"推进中"
   ③ 当期涉及范围/当期工作计划量：当期仍在推进中（status === 'doing'）的任务/里程碑，
      哪怕没有任何完成节点落在本期，也要算进"当期涉及"，不然会显得当期没有推进
   ④ 报告页各模块加点击下钻：statCard/pieChart/pieLegend/hBarList 支持可选 attrs，
      配合新增的 report-filter-tasks/report-filter-works/report-filter-duties 三个 ACTIONS
   ⑤ 到期分布/优先级分布/任务来源分布改成跟"待办总量趋势"一样看全量，不再局限当期
   ⑥ 任务状态占比饼图并入"当期完成进度（含 SPI）"，taskStatusPie 这个模块被合并掉了
   ⑦ 新增"当期交付物层级统计"模块（deliveredMsLevelPie），只看本期实际交付的那一批
   ⑧ "本期已交付里程碑"与"里程碑完成情况分布"口径不同，两处 chart-note 都要点明差异
   ⑨ 里程碑甘特图时间轴左边界最多只画到 2 个月前，更早的历史数据不再把轴拉得很稀
   ⑩ 各人任务量与完成率：靠 periodTasks 扩大口径自动吃到"推进中"的任务，不再只看完成节点
   用法：node test/test-p66.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();

  /* ================= ①：里程碑清单带牵头人 ================= */
  section('①：本期已交付/即将到期里程碑清单，"p" 那一行带上所属任务的牵头人');
  const tOwner = S.DB.tasks.find(t => !t.deleted_at && t.owner);
  ok('前置：找到了一条有牵头人的任务', !!tOwner);
  if (tOwner) {
    const ms = { id: 'p66_ms_owner', task: tOwner.id, deliverable: 'P66交付物', plan_date: S.todayStr(), done: '0' };
    const rows = S.reportMsRows([ms], '（无）', S.todayStr());
    ok('★清单里出现了牵头人姓名', rows.includes(tOwner.owner));
  }
  const msNoOwner = { id: 'p66_ms_noowner', task: '__not_exist__', deliverable: 'P66交付物2', plan_date: S.todayStr(), done: '0' };
  ok('任务查不到时兜底显示"未指派"，不抛异常', S.reportMsRows([msNoOwner], '（无）', S.todayStr()).includes('未指派'));

  /* ================= ②："未完成（未逾期）"改"推进中" ================= */
  section('②：里程碑完成情况分布的第三档改名');
  ok('★源码里不再有"未完成（未逾期）"这个老措辞', !html.includes('未完成（未逾期）'));
  ok('★msCompletionPie 输出的标签是"推进中"', S.msCompletionPie(S.DB.tasks.filter(t => !t.deleted_at)).some(s => s.label === '推进中'));

  /* ================= ③：当期口径吃进"推进中"的任务/里程碑 ================= */
  section('③：★核心——status===doing 的任务，哪怕没有完成节点落在本期，也算"当期涉及"');
  await S.Repo.upsert('duty', { code: 'P66', name: 'P66职责' });
  await S.Repo.upsert('work', { id: 'p66_w', duty: 'P66', code: 'W1', name: 'P66工作', owner: '张三', year: new Date().getFullYear() });
  // 计划完成日排到很远的将来、也没有实际完成日——按老口径这条不该出现在"当期"，但它正在推进
  await S.Repo.upsert('task', { id: 'p66_doing', work: 'p66_w', title: 'P66正在推进的任务',
    status: 'doing', priority: '2', plan_date: S.offsetDate(400), owner: 'P66推进中同志', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p66_ms_doing', task: 'p66_doing', deliverable: 'P66里程碑',
    plan_date: S.offsetDate(400), done: '0' });
  S.rebuildIndex();
  const dd = S.buildReportData('week', 0);
  ok('★★这条"推进中"任务出现在当期涉及范围里（老口径会把它漏掉）', dd.periodTasks.some(t => t.id === 'p66_doing'));
  ok('★它名下的里程碑也跟着算进当期', dd.periodMs.some(m => m.id === 'p66_ms_doing'));
  ok('它也算进"需推进任务"（periodOpen，当期工作计划量模块用这个）', dd.periodOpen.some(t => t.id === 'p66_doing'));
  ok('涉及职责/工作因此追溯到了 P66', dd.dutyCodes.has('P66') && dd.workIds.has('p66_w'));

  section('③：不是"推进中"的、又不满足其它任何一条口径的任务，仍然不算当期（避免过度放宽）');
  await S.Repo.upsert('task', { id: 'p66_todo_far', work: 'p66_w', title: 'P66还没开始且排得很远',
    status: 'todo', priority: '3', plan_date: S.offsetDate(400), owner: '丁', assignees: [] });
  S.rebuildIndex();
  const dd2 = S.buildReportData('week', 0);
  ok('★todo 状态、计划日又在未来很远的，依旧不算当期', !dd2.periodTasks.some(t => t.id === 'p66_todo_far'));

  section('⑩：各人任务量与完成率（personBars）用的是 periodTasks，自动吃到"推进中"扩围的效果');
  const personHtml = S.REPORT_MODULE_MAP.personBars.html(dd, { width: 900 });
  ok('★"P66推进中同志"出现在了当期人员统计里', personHtml.includes('P66推进中同志'));

  /* ================= ⑥：任务状态占比并入当期完成进度 ================= */
  section('⑥：taskStatusPie 模块被合并掉了，periodStatus 接管饼图 + 加了 table:true');
  ok('★REPORT_MODULE_MAP 里已经没有 taskStatusPie 了', !S.REPORT_MODULE_MAP.taskStatusPie);
  ok('★periodStatus 现在标了 table:true（新增了看数据表能力）', S.REPORT_MODULE_MAP.periodStatus.table === true);
  const periodStatusHtml = S.REPORT_MODULE_MAP.periodStatus.html(dd, { width: 900 });
  ok('periodStatus 正文里出现了饼图 svg', periodStatusHtml.includes('<svg'));
  ok('periodStatus 正文里依旧有 SPI 卡片', periodStatusHtml.includes('SPI'));
  S.chartTableView.rep_periodStatus = true;
  const periodStatusTable = S.REPORT_MODULE_MAP.periodStatus.html(dd, { width: 900 });
  ok('切到"看数据表"后输出 dataTable', periodStatusTable.includes('<table class="dtable">'));
  delete S.chartTableView.rep_periodStatus;

  /* ================= ⑤：到期/优先级/来源分布改全量 ================= */
  section('⑤：到期分布/优先级分布/任务来源分布不再局限当期，标成 all，喂的是全量任务');
  ['taskDueDist', 'taskPriorityPie', 'taskSourceBars'].forEach(k =>
    ok(`★${k}.scope === 'all'`, S.REPORT_MODULE_MAP[k].scope === 'all'));
  // p66_todo_far 不在当期口径里，但它是未删除、未完成的任务——全量到期分布该看得到它
  const dueBucketsAll = S.dueBuckets(dd2.tasks);
  const dueBucketsPeriod = S.dueBuckets(dd2.periodTasks);
  const totalAll = dueBucketsAll.reduce((a, b) => a + b.n, 0);
  const totalPeriod = dueBucketsPeriod.reduce((a, b) => a + b.n, 0);
  ok('★全量到期分布覆盖的未完成任务数 ≥ 当期口径（p66_todo_far 这类被排除在外的任务在全量里还在）',
    totalAll >= totalPeriod, { totalAll, totalPeriod });
  const priorityHtmlAll = S.REPORT_MODULE_MAP.taskPriorityPie.html(dd2);
  ok('priorityPie 渲染不报错', priorityHtmlAll.includes('<svg') || priorityHtmlAll.includes('empty'));

  /* ================= ④：点击下钻 ================= */
  section('④：statCard/pieChart/pieLegend/hBarList 支持可选 attrs，传了才带 clickable');
  ok('不传 attrs 时 statCard 输出原样（向后兼容）', S.statCard('X', 1) === '<div class="card"><div class="k">X</div><div class="v ">1</div></div>');
  const clickableCard = S.statCard('X', 1, '', ' data-act="goto-view" data-page="tasks" data-view="done"');
  ok('★传了 attrs 之后卡片带 clickable class 和对应属性', clickableCard.includes('card clickable') && clickableCard.includes('data-view="done"'));
  const pieOut = S.pieChart([{ label: 'A', n: 3, color: '#000', attrs: ' data-act="x" data-y="1"' }, { label: 'B', n: 2, color: '#111' }], 100, 'test');
  ok('★带 attrs 的那一扇区有 pie-slice-clickable class', pieOut.includes('pie-slice-clickable'));
  const legendOut = S.pieLegend([{ label: 'A', n: 3, color: '#000', attrs: ' data-act="x"' }, { label: 'B', n: 2, color: '#111' }]);
  ok('★带 attrs 的图例项有 clickable class，没带的没有', /class="clickable" data-act="x"/.test(legendOut) && !/<span class="clickable"><i style="background:#111"/.test(legendOut));
  const barListOut = S.hBarList([{ label: 'A', n: 3, attrs: ' data-act="x"' }, { label: 'B', n: 1 }]);
  ok('★带 attrs 的横条有 clickable class', /class="bar-row clickable" data-act="x"/.test(barListOut));
  ok('没带 attrs 的横条不带 clickable', /class="bar-row" title="B/.test(barListOut));

  section('④：新增的三个通用下钻 ACTIONS 真的会跳转并带对的筛选');
  S.UI.tasks.filters = {}; S.UI.tasks.view = 'all';
  await S.ACTIONS['report-filter-tasks']({ field: 'priority', val: '1' });
  ok('★report-filter-tasks：任务页筛选被设成对应字段/值', S.UI.tasks.filters.priority === '1');
  ok('落到了任务页', S.currentPage === 'tasks');
  S.UI.works.filters = {};
  await S.ACTIONS['report-filter-works']({ field: 'status', val: 'doing' });
  ok('★report-filter-works：工作页筛选被设成对应字段/值', S.UI.works.filters.status === 'doing');
  ok('落到了工作页', S.currentPage === 'works');
  S.UI.duties.filters = {};
  await S.ACTIONS['report-filter-duties']({ field: 'category', val: '一、前瞻研判' });
  ok('★report-filter-duties：职责页筛选被设成对应字段/值', S.UI.duties.filters.category === '一、前瞻研判');
  ok('落到了职责页', S.currentPage === 'duties');

  section('④：periodStatus/taskPriorityPie/dutyItemBars/workOverview 等模块正文里真带上了 data-act');
  ok('periodStatus 卡片带 goto-view', S.REPORT_MODULE_MAP.periodStatus.html(dd, { width: 900 }).includes('data-act="goto-view"'));
  ok('taskPriorityPie 带 report-filter-tasks（优先级）', S.REPORT_MODULE_MAP.taskPriorityPie.html(dd).includes('data-field="priority"'));
  ok('taskSourceBars 带 report-filter-tasks（来源）', S.REPORT_MODULE_MAP.taskSourceBars.html(dd).includes('data-act="report-filter-tasks"') || S.taskFieldBars('source', dd.tasks).length === 0);
  ok('dutyItemBars 带 _duty 筛选', S.REPORT_MODULE_MAP.dutyItemBars.html(dd).includes('data-field="_duty"'));
  ok('workOverview 带 report-filter-works（状态）', S.REPORT_MODULE_MAP.workOverview.html(dd).includes('data-act="report-filter-works"'));
  ok('worksByDutyBars 复用 duty-drill', S.REPORT_MODULE_MAP.worksByDutyBars.html().includes('data-act="duty-drill"'));
  ok('dashCards 任务维度卡片带 goto-view', S.REPORT_MODULE_MAP.dashCards.html(dd).includes('data-view="overdue"'));

  /* ================= ⑦：新增交付物层级统计（P68 已并入 deliveredMs，这里只留统计口径本身的验证） =================
     deliveredMsLevelPie 作为独立模块在 P68 里被并进了「本期已交付里程碑」（见 test-p68.js），
     这里不再断言这个 key 存在；msReportLevelStatsOf 这个统计口径本身还在被复用，继续验证它没坏。 */
  section('⑦：msReportLevelStatsOf —— 只看本期实际交付的那一批，按呈报层级统计');
  const t2 = S.DB.tasks.find(t => !t.deleted_at);
  await S.Repo.upsert('milestone', { id: 'p66_delivered', task: t2.id, deliverable: 'P66已交付',
    plan_date: S.todayStr(), actual_date: S.todayStr(), done: '1', report_level: 'department' });
  S.rebuildIndex();
  const dd3 = S.buildReportData('week', 0);
  ok('前置：这条确实进了本期已交付清单', dd3.deliveredInRange.some(m => m.id === 'p66_delivered'));
  const levelOut = S.msReportLevelStatsOf(dd3.deliveredInRange);
  ok('★统计到了这一条（部门领导那一档 ≥ 1）', levelOut.find(s => s.label === '部门领导').n >= 1);

  /* ================= ⑧：口径差异要点明 ================= */
  section('⑧：本期已交付里程碑 与 里程碑完成情况分布，chart-note 里都点明了口径不同');
  const deliveredHtml = S.REPORT_MODULE_MAP.deliveredMs.html(dd3);
  ok('★"本期已交付里程碑"的说明文字点出了跟"完成情况分布"口径不同', deliveredHtml.includes('口径不同'));
  const completionHtml = S.REPORT_MODULE_MAP.msCompletionPie.html(dd3);
  ok('★"里程碑完成情况分布"也回指了这一点', completionHtml.includes('本期已交付里程碑') && completionHtml.includes('不看完成日期'));

  /* ================= ⑨：甘特图时间轴裁剪 2 个月前 ================= */
  section('⑨：twoMonthsAgoOffset 按日历月算，且是负数（过去）');
  const twoMoAgo = S.twoMonthsAgoOffset();
  ok('是负数', twoMoAgo < 0);
  ok('大致在 -58 ~ -62 天之间（2 个月，各月天数不同会有 1-2 天摆动）', twoMoAgo <= -58 && twoMoAgo >= -62, twoMoAgo);

  section('⑨：★甘特图不再把 5 个月前的老里程碑画进时间轴，但完成数统计不受影响');
  await S.Repo.upsert('duty', { code: 'P66G', name: 'P66甘特职责' });
  await S.Repo.upsert('work', { id: 'p66_gw', duty: 'P66G', code: 'W1', name: 'P66甘特工作', owner: '张三', year: new Date().getFullYear() });
  await S.Repo.upsert('task', { id: 'p66_gt', work: 'p66_gw', title: 'P66甘特任务', status: 'doing', plan_date: S.offsetDate(10), owner: '张三', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p66_gm_old', task: 'p66_gt', deliverable: 'P66五个月前的老里程碑',
    plan_date: S.offsetDate(-150), done: '1', actual_date: S.offsetDate(-150) });
  await S.Repo.upsert('milestone', { id: 'p66_gm_new', task: 'p66_gt', deliverable: 'P66最近的里程碑',
    plan_date: S.offsetDate(10), done: '0' });
  S.rebuildIndex();
  const ganttHtml = S.milestoneTreeHTML(S.DB.tasks.filter(t => !t.deleted_at && t.work === 'p66_gw'), new Set(['P66G']), new Set(['p66_gw']));
  ok('★老里程碑（5 个月前）的圆点没有画出来', !ganttHtml.includes('P66五个月前的老里程碑'));
  ok('最近的里程碑正常画出来了', ganttHtml.includes('data-id="p66_gt"'));
  ok('★完成数统计（2 个里程碑，1 个完成）依旧按完整列表算，不受轴裁剪影响', ganttHtml.includes('>1/2<'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
