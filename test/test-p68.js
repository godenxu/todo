/* P68：五项反馈——
   ① 图表页"人员工作矩阵"：左边职责/工作列放宽到 3 倍，人员列只留够放 4 个汉字的宽度，
      行高对齐"各职责/工作推进情况"（不然全部展开后整页高度失控）
   ② 报告里所有"当期"字样统一改成"本期"
   ③ 报告编排：一个模块已经用在某个区域，就不会再出现在其它区域的候选（＋号）列表里，
      确保同一份报表里每个模块只出现一次
   ④ "当期交付物层级统计"整个并进"本期已交付里程碑"——不再用数据表切换，直接饼图在上、
      清单在下，清单里交付日期后面多一列呈报层级；标题后面带上本期已交付的总数
   ⑤ 本期已完成任务/高优先级未完成任务/逾期任务/逾期里程碑/即将到期任务/即将到期里程碑
      六个模块，标题后面都要带上各自的汇总数字
   用法：node test/test-p68.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, q } = require('./harness.js');

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

  /* ================= ①：人员工作矩阵布局 ================= */
  section('①：★根因——table-layout 不是 fixed 时，per-cell 的 width 只是建议，浏览器按内容自动摊算列宽，列宽声明形同虚设');
  ok('★matrix-table 用了 table-layout: fixed', /\.matrix-table \{[^}]*table-layout: fixed/.test(html));
  // 具体列宽数值在 P70 又调整过一轮（510px→约 20 个汉字宽），这里只认"用 colgroup 控制"这个机制本身，
  // 精确数值和字号/行高的验证挪到 test-p70.js
  ok('★列宽交给 <colgroup> 的 <col> 决定，不再指望每个单元格自己声明（fixed 布局下这是唯一可靠的办法）',
    /\.matrix-table col\.col-label \{ width: \d+px/.test(html) && /\.matrix-table col\.col-person \{ width: 46px/.test(html));

  section('①：左边职责/工作列比人员列宽得多，人员列只留 4 个汉字的宽度');
  ok('★人员列宽 46px（够放 4 个汉字）', /col\.col-person \{ width: 46px/.test(html));
  ok('行间距也收紧了（border-spacing 纵向 1px）', /\.matrix-table \{[^}]*border-spacing: 2px 1px/.test(html));

  section('①：实际渲染出来的表格真的带 colgroup，两种列宽都在');
  await S.Repo.upsert('duty', { code: 'P68MX', name: 'P68布局验证职责' });
  await S.Repo.upsert('work', { id: 'p68_mxw', duty: 'P68MX', code: 'W1', name: 'P68布局验证工作', owner: '张三', year: new Date().getFullYear() });
  await S.Repo.upsert('task', { id: 'p68_mxt', work: 'p68_mxw', title: 'P68布局验证任务', status: 'doing', owner: '甲', assignees: [], plan_date: S.offsetDate(5) });
  S.rebuildIndex();
  const matrixOut = S.personMatrixHTML(
    S.statsByDuty(S.DB.tasks.filter(t => !t.deleted_at)).filter(x => x.code === 'P68MX'),
    S.statsByWork(S.DB.tasks.filter(t => !t.deleted_at)),
    ['甲'], S.personDutyWorkHeat(S.DB.tasks.filter(t => !t.deleted_at)), new Set(), 'chart-matrix-duty-toggle');
  ok('★输出的 <table> 里确实有 <colgroup>', matrixOut.includes('<colgroup>'));
  ok('★colgroup 第一列是 col-label', /<colgroup><col class="col-label">/.test(matrixOut));
  ok('★后面每一列都是 col-person（有几个人就几列）', matrixOut.match(/<col class="col-person">/g).length === 1);

  /* ================= ②：报告"当期"→"本期" ================= */
  section('②：全面扫一遍——报告模块的正文/标题/说明文字里不再有"当期"这个词');
  const dAll = S.buildReportData('week', 0);
  const leftover = [];
  S.REPORT_MODULES.forEach(m => {
    if ((m.label || '').includes('当期')) leftover.push(m.key + ':label');
    if ((m.desc || '').includes('当期')) leftover.push(m.key + ':desc');
    try { if ((m.html(dAll, { width: 900 }) || '').includes('当期')) leftover.push(m.key + ':html'); }
    catch (e) { leftover.push(m.key + ':html抛异常 ' + e.message); }
  });
  ok('★没有任何模块的 label/desc/正文里还留着"当期"字样', leftover.length === 0, leftover);
  ok('★REPORT_GROUPS 分类标签没有"当期"了', S.REPORT_GROUPS.every(g => !g.label.includes('当期')));
  ok('★DEFAULT_REPORT_SECTIONS 区域标题没有"当期"了', S.DEFAULT_REPORT_SECTIONS.every(s => !s.title.includes('当期')));
  // P81 后期改版：periodScope/periodPlan 这两个旧 key 下线了，内容被 periodOverallScope/
  // periodOverallPlan（新分类"本期处室统计"）取代，这里跟着改成认新 key
  ok('具体几个改名对了：periodOverallScope→本期涉及范围', S.REPORT_MODULE_MAP.periodOverallScope.label === '本期涉及范围');
  // P82 这轮改名"本期计划完成度"→"本期计划开展"
  ok('periodOverallPlan→本期计划开展', S.REPORT_MODULE_MAP.periodOverallPlan.label === '本期计划开展');
  ok('periodStatus→本期完成进度（含 SPI）', S.REPORT_MODULE_MAP.periodStatus.label === '本期完成进度（含 SPI）');
  // P80 后期改版在最前面插了"一、处室工作整体统计"，"本期处室工作进展"从第二段挪到第三段——
  // 认标题文字本身，不依赖具体下标
  ok('★有一段标题是"三、本期处室工作进展"', S.DEFAULT_REPORT_SECTIONS.some(s => s.title === '三、本期处室工作进展'));

  /* ================= ③：模块在同一份报表里只出现一次 ================= */
  section('③：一个模块已经用在某个区域，就不会再出现在别的区域的添加器里');
  S.DB.reportConfig = {
    activeId: 'preset_p68', presets: [{ id: 'preset_p68', name: 'p68test', sections: [
      { id: 'sec_a', title: 'A区', modules: ['doneTasks'] },
      { id: 'sec_b', title: 'B区', modules: [] },
    ] }],
  };
  S.setReportConfigOpen(true);
  S.goto('report');
  let cfgH = q('#page-report').innerHTML;
  ok('前置：doneTasks 在 A 区的"已选"列表里（带移除按钮）',
    /data-act="report-mod-remove"[^>]*data-sec="sec_a"[^>]*data-mod="doneTasks"/.test(cfgH));
  ok('★doneTasks 不会出现在 B 区的添加器里（已经用在 A 区了）',
    !cfgH.includes('data-act="report-mod-add" data-sec="sec_b" data-mod="doneTasks"'));
  ok('B 区的添加器里还有别的没用过的模块（不是整个添加器都空了）',
    /data-act="report-mod-add" data-sec="sec_b" data-mod="/.test(cfgH));

  section('③：把 doneTasks 从 A 区移除之后，它又重新出现在两边的添加器里');
  await S.ACTIONS['report-mod-remove']({ sec: 'sec_a', mod: 'doneTasks' });
  await tick();
  cfgH = q('#page-report').innerHTML;
  ok('★移除后，B 区的添加器里又能看到 doneTasks 了',
    cfgH.includes('data-act="report-mod-add" data-sec="sec_b" data-mod="doneTasks"'));
  ok('A 区的添加器里也重新有它了',
    cfgH.includes('data-act="report-mod-add" data-sec="sec_a" data-mod="doneTasks"'));
  S.DB.reportConfig = null;
  S.setReportConfigOpen(false);

  /* ================= ④：交付物层级统计并入本期已交付里程碑 ================= */
  section('④：deliveredMsLevelPie 独立模块被删掉了，功能整个并进 deliveredMs');
  ok('★REPORT_MODULE_MAP 里已经没有 deliveredMsLevelPie', !S.REPORT_MODULE_MAP.deliveredMsLevelPie);
  ok('★deliveredMs 不再需要"看数据表"（table 不是 true）', !S.REPORT_MODULE_MAP.deliveredMs.table);

  section('④：deliveredMs 正文——上面饼图、下面清单，清单里日期后面多一列呈报层级');
  await S.Repo.upsert('duty', { code: 'P68D', name: 'P68交付职责' });
  await S.Repo.upsert('work', { id: 'p68_w', duty: 'P68D', code: 'W1', name: 'P68交付工作', owner: '张三', year: new Date().getFullYear() });
  await S.Repo.upsert('task', { id: 'p68_t', work: 'p68_w', title: 'P68交付任务', status: 'doing', owner: '甲', assignees: [], plan_date: S.offsetDate(5) });
  await S.Repo.upsert('milestone', { id: 'p68_ms1', task: 'p68_t', deliverable: 'P68交付物甲',
    plan_date: S.todayStr(), actual_date: S.todayStr(), done: '1', report_level: 'department' });
  await S.Repo.upsert('milestone', { id: 'p68_ms2', task: 'p68_t', deliverable: 'P68交付物乙',
    plan_date: S.todayStr(), actual_date: S.todayStr(), done: '1', report_level: 'bank' });
  S.rebuildIndex();
  const d4 = S.buildReportData('week', 0);
  ok('前置：两条都进了本期已交付清单', d4.deliveredInRange.filter(m => m.id === 'p68_ms1' || m.id === 'p68_ms2').length === 2);
  const deliveredHtml = S.REPORT_MODULE_MAP.deliveredMs.html(d4);
  ok('★正文里有饼图（呈报层级分布）', deliveredHtml.includes('<svg'));
  ok('★正文里有清单（两条交付物名字都在）', deliveredHtml.includes('P68交付物甲') && deliveredHtml.includes('P68交付物乙'));
  ok('★清单每一行的呈报层级用 class="lvl" 那个 span 带出来了', deliveredHtml.includes('class="lvl"'));
  ok('层级文字对了（部门领导、行领导）', deliveredHtml.includes('部门领导') && deliveredHtml.includes('行领导'));
  // "看数据表"这个开关已经不需要了，但保险起见确认就算手滑打开 chartTableView 也不会崩
  S.chartTableView.rep_deliveredMs = true;
  ok('就算 chartTableView 里意外留了这个 key，deliveredMs 正文照样正常渲染（没有 table:true，不会走那条分支）',
    S.REPORT_MODULE_MAP.deliveredMs.html(d4).includes('<svg'));
  delete S.chartTableView.rep_deliveredMs;

  section('④：★标题后面带上本期已交付里程碑的总数');
  ok('★titleCount 就是 deliveredInRange 的条数', S.REPORT_MODULE_MAP.deliveredMs.titleCount(d4) === d4.deliveredInRange.length);
  const headOut4 = S.reportModHead(S.REPORT_MODULE_MAP.deliveredMs, '', S.REPORT_MODULE_MAP.deliveredMs.titleCount(d4));
  ok(`★面板头文字是"本期已交付里程碑（${d4.deliveredInRange.length}）"`,
    headOut4.includes(`本期已交付里程碑（${d4.deliveredInRange.length}）`));

  /* ================= ⑤：另外六个模块标题带汇总数字 ================= */
  section('⑤：本期已完成任务/高优先级未完成任务/逾期任务/逾期里程碑/即将到期任务/即将到期里程碑，标题都带数字');
  await S.Repo.upsert('task', { id: 'p68_done', work: 'p68_w', title: 'P68已完成任务', status: 'done',
    plan_date: S.offsetDate(-1), actual_date: S.todayStr(), owner: '甲', assignees: [] });
  await S.Repo.upsert('task', { id: 'p68_hi', work: 'p68_w', title: 'P68高优先级任务', status: 'todo', priority: '1',
    plan_date: S.offsetDate(3), owner: '甲', assignees: [] });
  await S.Repo.upsert('task', { id: 'p68_overdue', work: 'p68_w', title: 'P68逾期任务', status: 'todo',
    plan_date: S.offsetDate(-3), owner: '甲', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p68_overdue_ms', task: 'p68_t', deliverable: 'P68逾期里程碑',
    plan_date: S.offsetDate(-2), done: '0' });
  await S.Repo.upsert('task', { id: 'p68_soon', work: 'p68_w', title: 'P68即将到期任务', status: 'todo',
    plan_date: S.offsetDate(2), owner: '甲', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p68_soon_ms', task: 'p68_t', deliverable: 'P68即将到期里程碑',
    plan_date: S.offsetDate(2), done: '0' });
  S.rebuildIndex();
  const d5 = S.buildReportData('week', 0);
  const CHECK = {
    doneTasks: ['本期已完成任务', d5.doneInRange.length],
    highPriority: ['高优先级未完成任务', d5.highPriTasks.length],
    overdueTasks: ['逾期任务', d5.overdue.length],
    overdueMs: ['逾期里程碑', d5.overdueMs.length],
    soonTasks: ['即将到期任务', d5.soonTasks.length],
    soonMs: ['即将到期里程碑', d5.soonMs.length],
  };
  Object.entries(CHECK).forEach(([key, [label, n]]) => {
    const m = S.REPORT_MODULE_MAP[key];
    ok(`前置：${key} 这批测试数据下数字大于 0（否则下面的断言测不出东西）`, n > 0, n);
    ok(`★${key}.titleCount(d) === ${n}`, m.titleCount(d5) === n, m.titleCount(d5));
    const head = S.reportModHead(m, '', m.titleCount(d5));
    ok(`★面板头文字是"${label}（${n}）"`, head.includes(`${label}（${n}）`));
  });

  section('⑤：★端到端——报告页真实渲染时，面板标题上确实带着数字');
  S.DB.reportConfig = null;
  S.goto('report');
  const repH = q('#page-report').innerHTML;
  // highPriority 在默认编排第三段里，一定会被渲染出来（doneTasks/deliveredMs 不在默认编排，这里不测它们）
  ok(`★"高优先级未完成任务（${d5.highPriTasks.length}）"真的出现在页面上`,
    repH.includes(`高优先级未完成任务（${d5.highPriTasks.length}）`));
  ok(`逾期任务的数字也在`, repH.includes(`逾期任务（${d5.overdue.length}）`));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
