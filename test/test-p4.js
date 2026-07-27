/* P4 图表页测试。用法：node test/test-p4.js */
const { sandbox: S, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const render = tab => { S.setPage('charts'); if (tab) S.ACTIONS['chart-tab']({ k: tab }); else S.renderCharts(); return q('#page-charts').innerHTML; };
const rawHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
// 从 SVG 属性里抽数值
const nums = (h, re) => [...h.matchAll(re)].map(m => +m[1]);

async function main() {
  await tick(60);
  let tasks = S.visibleTasks().filter(t => !t.deleted_at);

  section('页签');
  let h = render();
  ok('六个页签', (h.match(/data-act="chart-tab"/g) || []).length === 6);
  ['按人', '按职责', '按任务', '按工作', '按时间', '按里程碑'].forEach(t => ok('含页签：' + t, h.includes(t)));
  ok('默认选中「按人」', /class="t on" data-act="chart-tab" data-k="person"/.test(h));
  h = render('time');
  ok('切换页签生效', /class="t on" data-act="chart-tab" data-k="time"/.test(h) && S.chartTab === 'time');

  section('统计口径');
  let st = S.statsByPerson(tasks);
  ok('人员统计非空', st.length > 0, st.length);
  ok('各人分段之和等于合计', st.every(s => s.done + s.doing + s.late + s.todo + s.hold === s.total));
  ok('完成率计算正确', st.every(s => s.rate === (s.total ? Math.round(s.done / s.total * 100) : 0)));
  // 现在的"合计"是"牵头∪参与"去重后的相关任务数，不再是纯牵头数：
  // 一条任务贡献给"相关合计"总和的次数 = 它的相关人数（personUnion），没有相关人的算未指派，记 1 次
  const relatedTotal = st.reduce((a, s) => a + s.total, 0);
  const expectedRelatedTotal = tasks.reduce((a, t) => a + Math.max(1, S.personUnion('task', t).length), 0);
  ok('相关合计之和 = 每条任务的相关人数之和（无相关人的算未指派，记1次）',
    relatedTotal === expectedRelatedTotal, [relatedTotal, expectedRelatedTotal]);
  const leadSum = st.reduce((a, s) => a + s.lead, 0);
  ok('牵头计数之和 = 任务总数（每条任务只有一个牵头人桶，含未指派）', leadSum === tasks.length, [leadSum, tasks.length]);
  const joinSum = st.reduce((a, s) => a + s.join, 0);
  const expectedJoinSum = tasks.reduce((a, t) => a + (t.assignees || []).length, 0);
  ok('参与计数之和 = 全部任务的参与人数之和', joinSum === expectedJoinSum, [joinSum, expectedJoinSum]);
  ok('逾期段不含挂起任务', tasks.filter(S.isOverdue).every(t => t.status !== 'hold'));
  ok('一条任务只落一个段', tasks.every(t => ['done', 'doing', 'late', 'todo', 'hold'].includes(S.bucketOf(t))));

  section('按人：统计口径改为"牵头∪参与"（相关任务），而不是只看牵头');
  await S.Repo.upsert('task', {
    id: 'p4_union_t1', code: 'P4U01', title: 'P4口径验证任务', status: 'doing',
    owner: 'P4牵头甲', assignees: ['P4参与乙'], plan_date: S.offsetDate(5),
  });
  tasks = S.visibleTasks().filter(t => !t.deleted_at);
  st = S.statsByPerson(tasks);
  const leadRow = st.find(s => s.name === 'P4牵头甲');
  const joinRow = st.find(s => s.name === 'P4参与乙');
  ok('牵头人 P4牵头甲 的相关合计里包含这条任务', leadRow && leadRow.total >= 1 && leadRow.lead >= 1);
  ok('参与人 P4参与乙 的相关合计里也包含这条任务（这就是本次要修的口径）', joinRow && joinRow.total >= 1 && joinRow.join >= 1);
  ok('参与人 P4参与乙 没有牵头这条任务，lead 计数不含它', joinRow.lead === 0);

  const duty = S.statsByDuty(tasks), cat = S.statsByCategory(tasks);
  ok('职责统计只含有任务的项', duty.every(d => d.total > 0));
  ok('类别合计 = 各职责合计', cat.reduce((a, c) => a + c.total, 0) === duty.reduce((a, d) => a + d.total, 0),
     [cat.reduce((a, c) => a + c.total, 0), duty.reduce((a, d) => a + d.total, 0)]);

  section('按人视图');
  h = render('person');
  ok('渲染横条', h.includes('bar-row'));
  ok('可点击按相关人员筛选（不再是只筛牵头人）', h.includes('data-act="filter-person"'));
  ok('有图例', h.includes('已完成') && h.includes('逾期'));
  const widths = [...h.matchAll(/<span class="track">([\s\S]*?)<\/span>\s*<span class="num">/g)];
  ok('堆叠段宽合计 ≤ 100%', widths.every(b =>
    [...b[1].matchAll(/width:([\d.]+)%/g)].map(m => +m[1]).reduce((a, c) => a + c, 0) <= 100.05), widths.length);
  ok('有说明文字', h.includes('chart-note'));
  ok('提示文案改为按拼音排序', h.includes('按姓名拼音排序'));
  const named = st.filter(s => s.name !== '（未指派）');
  ok('按姓名拼音排序而不是按数量', named.every((s, i) => i === 0 || s.name.localeCompare(named[i - 1].name, 'zh') >= 0), named.map(s => s.name));
  const unassignedIdx = st.findIndex(s => s.name === '（未指派）');
  if (unassignedIdx >= 0) ok('存在未指派时固定放最后一位', unassignedIdx === st.length - 1, unassignedIdx);

  section('按人视图：右侧改成牵头/参与比例条（不再是饼图）');
  ok('右侧不再有"全部任务状态占比"这个饼图了', !h.includes('全部任务状态占比'));
  ok('渲染了牵头/参与两种颜色的比例条', h.includes('seg-lead') && h.includes('seg-join'));
  ok('比例条图例写明了"牵头"和"参与"', h.includes('>牵头</span>') && h.includes('>参与</span>'));
  const leadOnlyRow = st.find(s => s.name === 'P4牵头甲');
  const joinOnlyRow = st.find(s => s.name === 'P4参与乙');
  ok('牵头甲的比例条提示准确反映了他的牵头/参与数',
    h.includes(`P4牵头甲：牵头 ${leadOnlyRow.lead} · 参与 ${leadOnlyRow.join}`));
  ok('参与乙的比例条提示准确反映了他的牵头/参与数',
    h.includes(`P4参与乙：牵头 ${joinOnlyRow.lead} · 参与 ${joinOnlyRow.join}`));
  // 回归：比例条这一行没有 .nm（左边名字列），比左边 hBar 那一行天然矮一截（.nm 撑出的行高比 .track/.num 都高），
  // 差个 1-2px 逐行累积下来，十几个人排下来右边的条就跟左边名字对不上了；.bar-row 要有 min-height 兜底
  ok('.bar-row 有 min-height 兜底，没有 .nm 的行（比例条）也能跟有 .nm 的行同高，不会累积错位',
    /\.bar-row\s*\{[^}]*min-height:\s*16px/.test(rawHtml));
  ok('比例条的数字列比左边横条的数字列窄很多（44px vs 82px），不会因为文字短、右对齐而离色条一大截',
    h.includes('class="num" style="width:44px"'));

  section('图表 / 表格切换（无障碍要求）');
  ok('提供切换按钮', h.includes('data-act="chart-view"'));
  S.ACTIONS['chart-view']({ id: 'person' });
  h = q('#page-charts').innerHTML;
  ok('切到表格视图', h.includes('class="dtable"') && !h.includes('bar-row'));
  ok('表头完整', ['姓名', '相关合计', '已完成', '完成率', '牵头', '参与'].every(t => h.includes(t)));
  const bodyRows = (h.match(/<tbody>([\s\S]*?)<\/tbody>/) || ['', ''])[1];
  ok('表格行数与统计一致', (bodyRows.match(/<tr>/g) || []).length === st.length);
  S.ACTIONS['chart-view']({ id: 'person' });
  ok('切回图表视图', q('#page-charts').innerHTML.includes('bar-row'));

  section('按分类视图');
  h = render('category');
  ok('含职责类别面板', h.includes('职责类别'));
  ok('含职责项面板', h.includes('职责项'));
  ok('职责可下钻', h.includes('data-act="duty-drill"'));
  S.CATEGORIES.forEach(c => {
    const has = cat.some(x => x.key === c.v);
    if (has) ok('类别显示：' + c.label, h.includes(c.label));
  });

  section('按时间：待办任务总量趋势（合并原来3张"新增与完成"图，改成存量口径+粒度切换）');
  const monthBacklog = S.backlogSeries(tasks, 'month');
  ok('12 个月数据点', monthBacklog.length === 12, monthBacklog.length);
  ok('每个月的待办总量跟单独重算一遍一致（抽查最后一个月=今天这个快照）',
    monthBacklog[11].backlog === S.backlogAsOf(tasks, S.todayStr()));
  const weekBacklog = S.backlogSeries(tasks, 'week');
  ok('12 个周数据点', weekBacklog.length === 12, weekBacklog.length);
  const dayBacklog = S.backlogSeries(tasks, 'day');
  ok('15 个日数据点', dayBacklog.length === 15, dayBacklog.length);
  ok('日粒度最后一天是今天', dayBacklog[dayBacklog.length - 1].m === S.todayStr());
  ok('日粒度最后一天的待办总量 = 未完成任务数', dayBacklog[dayBacklog.length - 1].backlog === tasks.filter(S.isOpen).length,
    [dayBacklog[dayBacklog.length - 1].backlog, tasks.filter(S.isOpen).length]);

  const svg = S.lineChart(monthBacklog, 800, '待办任务总量趋势', { aKey: 'backlog', bKey: null, aLabel: '待办总量' });
  ok('生成 SVG', svg.startsWith('<svg') && svg.includes('</svg>'));
  ok('单线模式只画一条折线（没有第二条 ln-done）', svg.includes('ln-new') && !svg.includes('ln-done'));
  ok('单线模式只有圆点标记（没有方块 mk-done）', svg.includes('<circle') && !svg.includes('mk-done'));
  ok('有自定义 aria-label', svg.includes('aria-label="待办任务总量趋势"'));
  ok('标记自带 title 提示', (svg.match(/<title>/g) || []).length >= monthBacklog.length);
  ok('有十字准线元素', svg.includes('id="ch-line"'));
  ok('有命中区（悬停用）', (svg.match(/data-tip=/g) || []).length === monthBacklog.length);
  // 几何：所有点必须落在绘图区内
  const cys = nums(svg, /cy="([\d.]+)"/g);
  ok('折线点纵坐标在画布内', cys.length && cys.every(v => v >= 0 && v <= 210), [Math.min(...cys), Math.max(...cys)]);
  const cxs = nums(svg, /cx="([\d.]+)"/g);
  ok('折线点横坐标在画布内', cxs.every(v => v >= 0 && v <= 800), [Math.min(...cxs), Math.max(...cxs)]);

  h = render('time');
  ok('渲染了"待办任务总量趋势"面板', h.includes('待办任务总量趋势'));
  ok('原来3张"新增与完成"图已经不在了', !h.includes('新增与完成'));
  ok('有月/周/日粒度切换按钮', h.includes('data-act="trend-granularity" data-g="month"')
    && h.includes('data-act="trend-granularity" data-g="week"') && h.includes('data-act="trend-granularity" data-g="day"'));
  ok('默认选中"月"这个粒度', /class="toggle-view on" data-act="trend-granularity" data-g="month"/.test(h));
  S.ACTIONS['trend-granularity']({ g: 'week' });
  h = q('#page-charts').innerHTML;
  ok('切到"周"粒度后 trendGranularity 变化', S.trendGranularity === 'week');
  ok('切到"周"粒度后"周"按钮变成选中态', /class="toggle-view on" data-act="trend-granularity" data-g="week"/.test(h));
  S.ACTIONS['chart-view']({ id: 'trendBacklog' });
  h = q('#page-charts').innerHTML;
  ok('看数据表能看到"待办总量"表头', h.includes('<table') && h.includes('待办总量'));
  S.ACTIONS['chart-view']({ id: 'trendBacklog' });
  S.ACTIONS['trend-granularity']({ g: 'month' });   // 切回默认粒度，避免影响后面的断言

  section('按时间：从本月起，各月计划完成的任务数与里程碑数（分组柱状图，口径从当月起往后延伸）');
  const msIds = new Set(tasks.map(t => t.id));
  const msForPlan = S.DB.milestones.filter(m => !m.deleted_at && m.plan_date && msIds.has(m.task));
  const planSeries = S.planDueSeries(tasks, msForPlan);
  const thisMonth = S.todayStr().slice(0, 7);
  ok('第一个月是当月（不是过去12个月那种固定窗口）', planSeries[0].m === thisMonth, planSeries[0].m);
  ok('至少包含当月这一个月', planSeries.length >= 1, planSeries.length);
  ok('月份序列连续递增、不重复', planSeries.every((s, i) => i === 0 || s.m > planSeries[i - 1].m));
  ok('每月任务数与实际按 plan_date 分月吻合（抽查第一个非零月）', (() => {
    const hit = planSeries.find(s => s.tasks > 0);
    if (!hit) return true;
    return tasks.filter(t => (t.plan_date || '').slice(0, 7) === hit.m).length === hit.tasks;
  })());
  const planChart = S.groupedBarChart(planSeries, 800, { aKey: 'tasks', bKey: 'milestones', aLabel: '计划完成任务数', bLabel: '计划完成里程碑数', ariaLabel: '按月计划完成的任务数与里程碑数' });
  ok('生成分组柱状图 SVG', planChart.startsWith('<svg') && planChart.includes('</svg>'));
  ok('自定义 aria-label 生效', planChart.includes('aria-label="按月计划完成的任务数与里程碑数"'));
  ok('提示文字用的是自定义 label（计划完成任务数/计划完成里程碑数）', planChart.includes('计划完成任务数') && planChart.includes('计划完成里程碑数'));
  ok('两种柱子颜色区分两个系列', planChart.includes('bar-norm') && planChart.includes('bar-done'));
  const valLabels = (planChart.match(/class="ax-text val"/g) || []).length;
  const nonZeroBars = planSeries.reduce((a, s) => a + (s.tasks ? 1 : 0) + (s.milestones ? 1 : 0), 0);
  ok('每根非零柱子上方都有数字标签', valLabels === nonZeroBars, { valLabels, nonZeroBars });

  h = render('time');
  ok('渲染了"从本月起，各月计划完成的任务数与里程碑数"面板', h.includes('从本月起，各月计划完成的任务数与里程碑数'));
  ok('这个面板排在"按时间"tab最后（在"未完成任务的到期分布"面板之后）',
    h.indexOf('未完成任务的到期分布') < h.indexOf('从本月起，各月计划完成的任务数与里程碑数'));
  ok('看数据表切换 id 是 trendPlan，且跟其它图独立', h.includes('data-act="chart-view" data-id="trendPlan"'));
  S.ACTIONS['chart-view']({ id: 'trendPlan' });
  h = q('#page-charts').innerHTML;
  ok('切到数据表能看到"计划完成任务数"表头', h.includes('<table') && h.includes('计划完成任务数') && h.includes('计划完成里程碑数'));
  S.ACTIONS['chart-view']({ id: 'trendPlan' });

  section('按时间：柱状图');
  const buckets = S.dueBuckets(tasks);
  ok('分桶含已逾期与无日期', buckets[0].label === '已逾期' && buckets.some(b => b.label === '无日期'));
  const open = tasks.filter(S.isOpen);
  ok('分桶总数 = 未完成任务数', buckets.reduce((a, b) => a + b.n, 0) === open.length,
     [buckets.reduce((a, b) => a + b.n, 0), open.length]);
  const bsvg = S.barChart(buckets, 800);
  ok('生成柱状 SVG', bsvg.startsWith('<svg'));
  ok('每桶一根柱', (bsvg.match(/<rect class="bar-/g) || []).length === buckets.length);
  ok('柱子有 title 提示', (bsvg.match(/<title>/g) || []).length === buckets.length);
  const hs = nums(bsvg, /height="([\d.]+)"/g);
  ok('柱高非负且在画布内', hs.every(v => v >= 0 && v <= 190), [Math.min(...hs), Math.max(...hs)]);

  section('按里程碑（职责→工作→任务树状展开）');
  h = render('gantt');
  const ms = S.DB.milestones.filter(m => !m.deleted_at && m.plan_date);
  if (ms.length) {
    ok('渲染了树状行（职责/工作层级）', h.includes('gantt-row'));
    ok('默认折叠：职责行自己聚合展示跨度条/圆点（不用展开就能看到大致分布）', h.includes('gantt-span') && h.includes('gantt-pt') && h.includes('--today:'));
    ok('默认折叠：还看不到任务级别的行（要展开到工作层级才有）', !h.includes('gantt-row-task'));
    ok('有全部展开/展开到工作层/全部折叠入口', h.includes('data-act="ms-expand-all"') && h.includes('data-act="ms-expand-to-work"') && h.includes('data-act="ms-collapse-all"'));
    S.ACTIONS['ms-expand-all']();
    h = q('#page-charts').innerHTML;
    ok('全部展开后能看到任务级的跨度条', h.includes('gantt-span'));
    ok('全部展开后能看到里程碑圆点', h.includes('gantt-pt'));
    ok('全部展开后有今天基准线', h.includes('--today:'));
    ok('点击工作行可下钻查看其任务', h.includes('data-act="work-drill"'));
    ok('点击职责行可下钻查看其工作', h.includes('data-act="duty-drill"'));
    ok('点击任务行可查看任务详情', h.includes('data-act="task-detail"'));
    const lefts = nums(h, /class="gantt-pt [a-z]+" style="left:([\d.]+)%/g);
    ok('圆点均在轴范围内', lefts.length > 0 && lefts.every(v => v >= 0 && v <= 100), [Math.min(...lefts), Math.max(...lefts)]);
    const spans = [...h.matchAll(/class="gantt-span" style="left:([\d.]+)%;width:([\d.]+)%/g)].map(m => [+m[1], +m[2]]);
    ok('跨度条不超出右边界', spans.every(([l, w]) => l + w <= 100.05), spans.slice(0, 3));
    ok('有月份刻度', h.includes('class="tk"'));
    S.ACTIONS['ms-collapse-all']();
    h = q('#page-charts').innerHTML;
    ok('全部折叠后任务级明细行又不见了（只剩职责行自己聚合的跨度条）', !h.includes('gantt-row-task') && h.includes('gantt-span'));
    ok('含"里程碑完成情况分布"面板', h.includes('里程碑完成情况分布'));
  } else ok('（无里程碑，跳过）', true);

  section('边界：空数据不炸');
  const bak = { d: S.DB.duties, w: S.DB.works, m: S.DB.milestones, t: S.DB.tasks };
  S.DB.duties = []; S.DB.works = []; S.DB.milestones = []; S.DB.tasks = [];
  let crashed = null;
  for (const tab of ['person', 'category', 'task', 'work', 'time', 'gantt']) {
    try { render(tab); } catch (e) { crashed = tab + ': ' + e.message; }
  }
  ok('六个页签在空数据下都不报错', !crashed, crashed);
  // 单点也不能除零
  S.DB.tasks = [bak.t[0]];
  try { render('time'); } catch (e) { crashed = 'single: ' + e.message; }
  ok('单条数据不触发除零', !crashed, crashed);
  S.DB.duties = bak.d; S.DB.works = bak.w; S.DB.milestones = bak.m; S.DB.tasks = bak.t;

  section('回归：P1–P3 未被破坏');
  S.setPage('dashboard'); S.renderDashboard();
  ok('工作台仍正常', q('#page-dashboard').innerHTML.includes('需要关注'));
  S.setPage('tasks'); S.renderTasks();
  ok('任务页仍正常', S.taskRows.length > 0, S.taskRows.length);
  ok('两级树仍工作', /data-act="tree-pick"/.test(S.renderTaskTree(S.taskRows)));
  S.ACTIONS['sel-all']();
  ok('批量选择仍工作', S.UI.tasks.sel.size === S.taskRows.length);
  S.ACTIONS['sel-clear']();
  ok('CSV 表头仍完整', S.csvHeaders('task').includes('code'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
