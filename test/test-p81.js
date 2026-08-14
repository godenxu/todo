/* P81：处室卡片体系整理，分两轮改完——
   第一轮（早期）：
   ① "整体统计卡片"（dashCards）保留，新增职责/工作两个维度（原来只有任务/里程碑），
      任务/里程碑维度从"未完成/逾期/今日到期/本周到期"换成"总数+已完成/进行中/未开始/逾期"。
   ② 报告页"本期涉及范围/本期工作计划量/本期完成进度"三个模块底层抽成共享函数，工作台
      "处室概览统计卡片"（dashOverviewCards）直接调用同一份定义，不再各写一份。
   ③ 卡片全面改成"这期数 / 总量"的分数格式（fracStr）。
   ④ DEFAULT_REPORT_SECTIONS 最前面插入"一、处室工作整体统计"。
   第二轮（后期，用户反馈"还是很多重复"之后）：
   ⑤ dashCards 进一步拆成职责/工作/任务/里程碑四个独立可配置模块（overallDuty/overallWork/
      overallTask/overallMs），放进新分类"整体统计"；工作维度也补上分数表示法（原来只有任务/
      里程碑维度是分数）；所有卡片文字数字居中。
   ⑥ dashOverviewCards 彻底下线，它包的三组内容变成三个独立模块（periodOverallScope/
      periodOverallStatus/periodOverallPlan），放进新分类"本期处室统计"；periodScope/
      periodPlan 这两个旧 key 同时下线（内容被取代）；periodStatus 保留但不再默认展示，
      跟新拆出来的 periodOverallStatus 内容重复，怎么处理"等用户想想"；"未指派"卡片去掉了。
   ⑦ 报告页/工作台的默认布局跟着两轮改动同步更新，两边用的都是同一份模块定义。
   用法：node test/test-p81.js */
const { sandbox: S, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);
  S.DB.settings.me = '测试管理员';

  /* ================= ⑤：整体统计——四个独立模块 ================= */
  section('⑤：整体统计——职责/工作/任务/里程碑拆成四个独立模块，全量口径、不随周期变化');
  S.DB.duties = []; S.DB.works = []; S.DB.tasks = []; S.DB.milestones = [];
  S.rebuildIndex();
  S.DB.duties = [
    S.stampMeta(S.blank('duty', { code: 'P81D1', category: 'a', name: 'P81职责一' })),
    S.stampMeta(S.blank('duty', { code: 'P81D2', category: 'a', name: 'P81职责二' })),
    // 已删除的职责不该算进"职责总数"
    S.stampMeta(S.blank('duty', { code: 'P81D3', category: 'a', name: 'P81已删除职责', deleted_at: '2026-01-01T00:00:00.000Z' })),
  ];
  S.DB.works = [
    S.stampMeta(S.blank('work', { id: 'p81_w1', duty: 'P81D1', code: 'W1', name: 'P81工作一', owner: '甲', status: 'doing' })),
    S.stampMeta(S.blank('work', { id: 'p81_w2', duty: 'P81D1', code: 'W2', name: 'P81工作二', owner: '乙', status: 'done' })),
    S.stampMeta(S.blank('work', { id: 'p81_w3', duty: 'P81D2', code: 'W3', name: 'P81工作三', owner: '丙', status: 'hold' })),
  ];
  S.DB.tasks = [
    S.stampMeta(S.blank('task', { id: 'p81_t_done', work: 'p81_w1', title: 'P81已完成任务', status: 'done', progress: 100, plan_date: S.offsetDate(-5), actual_date: S.offsetDate(-3), owner: '甲', assignees: [] })),
    S.stampMeta(S.blank('task', { id: 'p81_t_doing', work: 'p81_w1', title: 'P81进行中任务', status: 'doing', progress: 40, plan_date: S.offsetDate(5), owner: '甲', assignees: [] })),
    S.stampMeta(S.blank('task', { id: 'p81_t_todo', work: 'p81_w2', title: 'P81未开始任务', status: 'todo', plan_date: S.offsetDate(10), owner: '乙', assignees: [] })),
    S.stampMeta(S.blank('task', { id: 'p81_t_late', work: 'p81_w3', title: 'P81逾期任务', status: 'todo', plan_date: S.offsetDate(-2), owner: '丙', assignees: [] })),
  ];
  S.DB.milestones = [
    S.stampMeta(S.blank('milestone', { id: 'p81_ms_done', task: 'p81_t_done', plan_date: S.offsetDate(-4), deliverable: 'P81已完成里程碑', done: '1' })),
    S.stampMeta(S.blank('milestone', { id: 'p81_ms_notdue', task: 'p81_t_doing', plan_date: S.offsetDate(5), deliverable: 'P81未到期里程碑', done: '0' })),
    // 挂在已经逾期的 p81_t_late 底下，不挂在 p81_t_todo——挂上去的话 hasOverdueMilestone()
    // 会把 p81_t_todo 也判成逾期，"未开始"那格就凑不出来了（这是应用本身的正确行为，
    // 是测试数据设计时该避开的坑，不是 bug）
    S.stampMeta(S.blank('milestone', { id: 'p81_ms_overdue', task: 'p81_t_late', plan_date: S.offsetDate(-2), deliverable: 'P81逾期里程碑', done: '0' })),
  ];
  S.rebuildIndex();

  const dAll = S.buildReportData('week', 0, '');

  const dutyHtml = S.REPORT_MODULE_MAP.overallDuty.html(dAll, { width: 900 });
  ok('★overallDuty：职责总数=2（已删除的那条职责不算）',
    dutyHtml.includes('<div class="k">职责总数</div><div class="v ">2</div>'), dutyHtml);

  const workHtml = S.REPORT_MODULE_MAP.overallWork.html(dAll, { width: 900 });
  ok('★overallWork：工作总数=3', workHtml.includes('<div class="k">工作总数</div><div class="v ">3</div>'));
  ok('★overallWork：进行中/已完成/暂停现在也是分数格式了（占工作总数的比例，跟任务/里程碑维度统一）',
    workHtml.includes('<div class="k">进行中</div><div class="v ">1<span class="frac-den">/3</span></div>')
    && workHtml.includes('<div class="k">已完成</div><div class="v ok">1<span class="frac-den">/3</span></div>')
    && workHtml.includes('<div class="k">暂停</div><div class="v ">1<span class="frac-den">/3</span></div>'));

  // P81 更后期改版：未开始并进"进行中"算，只保留 4 张卡（总数/已完成/进行中/逾期）——
  // 种子数据里 p81_t_doing(doing)+p81_t_todo(todo) 两条都该算进"进行中"，所以是 2/4 不是 1/4
  const taskHtml = S.REPORT_MODULE_MAP.overallTask.html(dAll, { width: 900 });
  ok('★overallTask：任务总数=4', taskHtml.includes('<div class="k">任务总数</div><div class="v ">4</div>'));
  ok('★overallTask：只剩四张卡，没有"未开始"了', !taskHtml.includes('未开始'));
  ok('★overallTask：已完成 1/4', taskHtml.includes('<div class="k">已完成</div><div class="v ok">1<span class="frac-den">/4</span></div>'));
  ok('★overallTask：进行中 2/4（未开始的 todo 也算进来了）',
    taskHtml.includes('<div class="k">进行中</div><div class="v ">2<span class="frac-den">/4</span></div>'));
  ok('★overallTask：逾期 1/4', taskHtml.includes('<div class="k">逾期</div><div class="v warn">1<span class="frac-den">/4</span></div>'));
  ok('任务总数/已完成/进行中/逾期都能点（进行中点了去 open 视图，todo+doing 都在里面）',
    taskHtml.includes('data-act="goto-view" data-page="tasks" data-view="all"')
    && taskHtml.includes('data-act="goto-view" data-page="tasks" data-view="done"')
    && taskHtml.includes('data-act="goto-view" data-page="tasks" data-view="open"')
    && taskHtml.includes('data-act="goto-view" data-page="tasks" data-view="overdue"'));

  const msHtml = S.REPORT_MODULE_MAP.overallMs.html(dAll, { width: 900 });
  ok('★overallMs：里程碑总数=3', msHtml.includes('<div class="k">里程碑总数</div><div class="v ">3</div>'));
  ok('★overallMs：三态分数——已完成 1/3、未完成 1/3、逾期 1/3（没有"进行中/未开始"这两个任务专属的词）',
    (msHtml.match(/1<span class="frac-den">\/3<\/span>/g) || []).length === 3 && !msHtml.includes('未开始'));
  ok('★overallMs 没有任何 data-act（没有里程碑列表页可以承接点击）', !msHtml.includes('data-act'));

  ok('四个模块都归到新分类"整体统计"（overallSnapshot）',
    ['overallDuty', 'overallWork', 'overallTask', 'overallMs'].every(k => S.REPORT_MODULE_MAP[k].group === 'overallSnapshot'));

  section('⑤：canvas() 导出走纯文本"12/45"拼法，不带 HTML 标签（statBoxes 直接 fillText，会把标签当文字画出来）');
  const workCanvasCalls = [];
  S.REPORT_MODULE_MAP.overallWork.canvas(dAll, { statBoxes: groups => workCanvasCalls.push(groups) });
  const workCards = workCanvasCalls[0][0].cards;
  ok('★canvas 里"进行中"的值是纯文本 "1/3"，不含 <span> 标签', workCards.find(c => c.k === '进行中').v === '1/3');

  section('⑤：所有卡片组模块不再带底部说明性文字（用户反馈"不需要"），HTML/导出图片都不例外');
  const dWeekForNotes = S.buildReportData('week', 0, '');
  const dPersonForNotes = S.buildReportData('week', 0, '甲');
  const cardGroupModules = ['overallDuty', 'overallWork', 'overallTask', 'overallMs',
    'periodOverallScope', 'periodOverallPlan', 'periodOverallStatus', 'periodStatus'];
  cardGroupModules.forEach(k => {
    const m = S.REPORT_MODULE_MAP[k];
    const html = m.html(dWeekForNotes, { width: 900 });
    ok(`★${k} 的 html() 里没有 chart-note`, !html.includes('chart-note'), html.slice(-200));
  });
  ok('★dashMyCards（我的统计卡片）也没有 chart-note', !S.REPORT_MODULE_MAP.dashMyCards.html(dPersonForNotes, { width: 900 }).includes('chart-note'));
  ok('★periodStatus 带饼图，但饼图本身没被牵连去掉（只是去掉了底部那段文字说明）',
    S.REPORT_MODULE_MAP.periodStatus.html(dWeekForNotes, { width: 900 }).includes('本期任务状态占比'));

  section('⑤：所有卡片文字/数字都居中（用户反馈）');
  ok('★.card 这条 CSS 规则本身带 text-align: center（statCard 全站共用同一个 class，一处改全站生效）',
    /\.card \{[^}]*text-align: center/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8')));

  /* ================= ⑥：本期处室统计——三个独立模块 ================= */
  section('⑥：本期涉及范围——分数分母是处室（或这个人）总量，不是本期涉及数自己的上限');
  S.setReportPeriod('week'); S.setReportOffset(0);
  const dWeek = S.buildReportData('week', 0, '');
  const periodScopeHtml = S.REPORT_MODULE_MAP.periodOverallScope.html(dWeek, { width: 900 });
  ok('★涉及职责的分母是处室职责总数（2，已删除那条不算）',
    new RegExp(`涉及职责</div><div class="v ">\\d+<span class="frac-den">/${S.visibleDutyCount()}</span>`).test(periodScopeHtml));
  ok('★涉及工作的分母是 d.works.length（3）',
    new RegExp(`涉及工作</div><div class="v ">\\d+<span class="frac-den">/${dWeek.works.length}</span>`).test(periodScopeHtml));
  ok('★涉及任务的分母是 d.tasks.length（4）',
    new RegExp(`涉及任务</div><div class="v ">\\d+<span class="frac-den">/${dWeek.tasks.length}</span>`).test(periodScopeHtml));
  ok('★涉及里程碑的分母是 d.taskMilestones.length（3）',
    new RegExp(`涉及里程碑</div><div class="v ">\\d+<span class="frac-den">/${dWeek.taskMilestones.length}</span>`).test(periodScopeHtml));

  section('⑥：本期计划开展——分数分母是本期涉及总数（不是处室总量）');
  const periodPlanHtml = S.REPORT_MODULE_MAP.periodOverallPlan.html(dWeek, { width: 900 });
  ok('★需推进任务/计划完成任务的分母是 periodTasks.length，不是处室任务总数',
    new RegExp(`需推进任务</div><div class="v ">\\d+<span class="frac-den">/${dWeek.periodTasks.length}</span>`).test(periodPlanHtml)
    && new RegExp(`计划完成任务</div><div class="v ">\\d+<span class="frac-den">/${dWeek.periodTasks.length}</span>`).test(periodPlanHtml));
  ok('★计划完成里程碑的分母是 periodMs.length',
    new RegExp(`计划完成里程碑</div><div class="v ">\\d+<span class="frac-den">/${dWeek.periodMs.length}</span>`).test(periodPlanHtml));

  section('⑥：本期状态分布——分数分母是 periodTasks.length，"未指派"卡片已经去掉了');
  const periodOverallStatusHtml = S.REPORT_MODULE_MAP.periodOverallStatus.html(dWeek, { width: 900 });
  ok('★已完成/进行中/未开始/逾期都是 X/periodTasks 总数 的格式',
    ['已完成', '进行中', '未开始', '逾期'].every(k =>
      new RegExp(`${k}</div><div class="v[^"]*">\\d+<span class="frac-den">/${dWeek.periodTasks.length}</span>`).test(periodOverallStatusHtml)));
  ok('SPI 仍然是裸数字，不是分数（比值本来就不该配分母）',
    /SPI<\/div><div class="v[^"]*">[\d.—]+<\/div>/.test(periodOverallStatusHtml));
  ok('★没有"未指派"这张卡（这个模块从来就没有过，是原来 dashOverviewCards 独有的）',
    !periodOverallStatusHtml.includes('未指派'));

  section('⑥：periodStatus（含 SPI 饼图的老模块）暂时保留，跟 periodOverallStatus 内容重复但先不处理');
  const periodStatusHtml = S.REPORT_MODULE_MAP.periodStatus.html(dWeek, { width: 900 });
  ok('★periodStatus 还在 REPORT_MODULE_MAP 里，没被删掉', !!S.REPORT_MODULE_MAP.periodStatus);
  ok('periodStatus 正文里也有饼图（这是它跟 periodOverallStatus 的差异，所以先留着）',
    periodStatusHtml.includes('本期任务状态占比'));
  ok('periodScope/periodPlan 这两个旧 key 已经下线了（内容被 periodOverallScope/periodOverallPlan 取代）',
    !S.REPORT_MODULE_MAP.periodScope && !S.REPORT_MODULE_MAP.periodPlan);

  section('⑥：三个新模块归到新分类"本期处室统计"（periodOverall），dashOverviewCards 彻底下线');
  ok('★三个模块都归到 periodOverall 分类', ['periodOverallScope', 'periodOverallStatus', 'periodOverallPlan']
    .every(k => S.REPORT_MODULE_MAP[k].group === 'periodOverall'));
  ok('★dashOverviewCards 这个 key 已经不存在了', !S.REPORT_MODULE_MAP.dashOverviewCards);

  /* ================= ⑦：工作台默认布局同步 ================= */
  section('⑦：工作台"处室概览"区默认布局直接用这三个新模块，不再包一层 dashOverviewCards');
  S.setDashPeriod('week'); S.setDashOffset(0); S.setDashViewAsPerson('');
  S.goto('dashboard');
  S.renderDashboard();
  const dashH = q('#page-dashboard').innerHTML;
  ok('★工作台"涉及职责"这张卡的分数跟报告页 periodOverallScope.html(dWeek) 里的一样',
    (() => {
      const m = periodScopeHtml.match(/涉及职责<\/div><div class="v ">(\d+<span class="frac-den">\/\d+<\/span>)<\/div>/);
      return !!m && dashH.includes(`<div class="k">涉及职责</div><div class="v ">${m[1]}</div>`);
    })());
  // P82 这轮改名"本期计划完成度"→"本期计划开展"
  ok('工作台看得到三个模块的标题：本期涉及范围/本期状态分布/本期计划开展',
    dashH.includes('本期涉及范围') && dashH.includes('本期状态分布') && dashH.includes('本期计划开展'));
  ok('★"未指派"卡片工作台上也没有了', !dashH.includes('<div class="k">未指派</div>'));
  ok('DEFAULT_DASHBOARD_SECTIONS 的"处室概览"区用的正是这三个新 key',
    S.DEFAULT_DASHBOARD_SECTIONS[1].modules.slice(0, 3).join(',') === 'periodOverallScope,periodOverallStatus,periodOverallPlan');

  /* ================= ⑧：DEFAULT_REPORT_SECTIONS 结构 ================= */
  section('⑧：默认报告模板最前面是"处室工作整体统计"（四个新模块），第二段用新的"本期处室统计"模块');
  ok('★五段，第一段是"一、处室工作整体统计"，含四个新模块',
    S.DEFAULT_REPORT_SECTIONS[0].title === '一、处室工作整体统计'
    && S.DEFAULT_REPORT_SECTIONS[0].modules.join(',') === 'overallDuty,overallWork,overallTask,overallMs');
  ok('第二段"本期处室工作目标"用 periodOverallScope/periodOverallPlan',
    S.DEFAULT_REPORT_SECTIONS[1].modules.join(',') === 'periodOverallScope,periodOverallPlan');
  ok('第三段"本期处室工作进展"还是用老的 periodStatus（含 SPI 饼图那个）',
    S.DEFAULT_REPORT_SECTIONS[2].modules.includes('periodStatus'));
  S.DB.reportConfig = null;
  S.goto('report');
  S.renderReport();
  const repH = q('#page-report').innerHTML;
  ok('★页面上真的渲染出"一、处室工作整体统计"这个区域，且里面有职责总数卡片',
    repH.includes('一、处室工作整体统计') && repH.includes('职责总数'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
