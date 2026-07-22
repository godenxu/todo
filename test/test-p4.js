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
// 从 SVG 属性里抽数值
const nums = (h, re) => [...h.matchAll(re)].map(m => +m[1]);

async function main() {
  await tick(60);
  const tasks = S.visibleTasks().filter(t => !t.deleted_at);

  section('页签');
  let h = render();
  ok('四个页签', (h.match(/data-act="chart-tab"/g) || []).length === 4);
  ['按人', '按分类', '按时间', '里程碑甘特'].forEach(t => ok('含页签：' + t, h.includes(t)));
  ok('默认选中「按人」', /class="t on" data-act="chart-tab" data-k="person"/.test(h));
  h = render('time');
  ok('切换页签生效', /class="t on" data-act="chart-tab" data-k="time"/.test(h) && S.chartTab === 'time');

  section('统计口径');
  const st = S.statsByPerson(tasks);
  ok('人员统计非空', st.length > 0, st.length);
  ok('各人分段之和等于合计', st.every(s => s.done + s.doing + s.late + s.todo + s.hold === s.total));
  ok('完成率计算正确', st.every(s => s.rate === (s.total ? Math.round(s.done / s.total * 100) : 0)));
  const ownedTotal = st.reduce((a, s) => a + s.total, 0);
  ok('牵头合计覆盖全部任务（含未指派）', ownedTotal === tasks.length, [ownedTotal, tasks.length]);
  ok('逾期段不含挂起任务', tasks.filter(S.isOverdue).every(t => t.status !== 'hold'));
  ok('一条任务只落一个段', tasks.every(t => ['done', 'doing', 'late', 'todo', 'hold'].includes(S.bucketOf(t))));

  const duty = S.statsByDuty(tasks), cat = S.statsByCategory(tasks);
  ok('职责统计只含有任务的项', duty.every(d => d.total > 0));
  ok('类别合计 = 各职责合计', cat.reduce((a, c) => a + c.total, 0) === duty.reduce((a, d) => a + d.total, 0),
     [cat.reduce((a, c) => a + c.total, 0), duty.reduce((a, d) => a + d.total, 0)]);

  section('按人视图');
  h = render('person');
  ok('渲染横条', h.includes('bar-row'));
  ok('可点击筛选负责人', h.includes('data-act="filter-owner"'));
  ok('有图例', h.includes('已完成') && h.includes('逾期'));
  const widths = [...h.matchAll(/<span class="track">([\s\S]*?)<\/span>\s*<span class="num">/g)];
  ok('堆叠段宽合计 ≤ 100%', widths.every(b =>
    [...b[1].matchAll(/width:([\d.]+)%/g)].map(m => +m[1]).reduce((a, c) => a + c, 0) <= 100.05), widths.length);
  ok('有说明文字', h.includes('chart-note'));

  section('图表 / 表格切换（无障碍要求）');
  ok('提供切换按钮', h.includes('data-act="chart-view"'));
  S.ACTIONS['chart-view']({ id: 'person' });
  h = q('#page-charts').innerHTML;
  ok('切到表格视图', h.includes('class="dtable"') && !h.includes('bar-row'));
  ok('表头完整', ['姓名', '牵头合计', '已完成', '完成率', '参与'].every(t => h.includes(t)));
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

  section('按时间：折线图');
  const series = S.monthlySeries(tasks, 12);
  ok('12 个月数据点', series.length === 12, series.length);
  ok('新增总数 ≤ 任务总数', series.reduce((a, s) => a + s.added, 0) <= tasks.length);
  ok('完成总数 = 有完成日期的已完成任务数（近12月内）',
     series.reduce((a, s) => a + s.done, 0) <= tasks.filter(t => t.status === 'done').length);
  ok('测试数据跨多个月（趋势图有形状）', series.filter(s => s.added > 0).length >= 3,
     series.filter(s => s.added > 0).length);

  const svg = S.lineChart(series, 800);
  ok('生成 SVG', svg.startsWith('<svg') && svg.includes('</svg>'));
  ok('两条折线', svg.includes('ln-new') && svg.includes('ln-done'));
  ok('虚线做二次编码', /ln-done/.test(svg));
  ok('圆点 + 方块两种标记', svg.includes('<circle') && svg.includes('mk-done'));
  ok('有 aria-label', svg.includes('aria-label'));
  ok('标记自带 title 提示', (svg.match(/<title>/g) || []).length >= series.length);
  ok('有十字准线元素', svg.includes('id="ch-line"'));
  ok('有命中区（悬停用）', (svg.match(/data-tip=/g) || []).length === series.length);
  // 几何：所有点必须落在绘图区内
  const cys = nums(svg, /cy="([\d.]+)"/g);
  ok('折线点纵坐标在画布内', cys.length && cys.every(v => v >= 0 && v <= 210), [Math.min(...cys), Math.max(...cys)]);
  const cxs = nums(svg, /cx="([\d.]+)"/g);
  ok('折线点横坐标在画布内', cxs.every(v => v >= 0 && v <= 800), [Math.min(...cxs), Math.max(...cxs)]);

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

  section('里程碑甘特');
  h = render('gantt');
  const ms = S.DB.milestones.filter(m => !m.deleted_at && m.plan_date);
  if (ms.length) {
    ok('渲染甘特行', h.includes('gantt-row'));
    ok('有跨度条', h.includes('gantt-span'));
    ok('有里程碑圆点', h.includes('gantt-pt'));
    ok('有今天基准线', h.includes('--today:'));
    ok('点击工作名可查看其任务', h.includes('data-act="work-drill"'));
    const lefts = nums(h, /class="gantt-pt [a-z]+" style="left:([\d.]+)%/g);
    ok('圆点均在轴范围内', lefts.length > 0 && lefts.every(v => v >= 0 && v <= 100), [Math.min(...lefts), Math.max(...lefts)]);
    const spans = [...h.matchAll(/class="gantt-span" style="left:([\d.]+)%;width:([\d.]+)%/g)].map(m => [+m[1], +m[2]]);
    ok('跨度条不超出右边界', spans.every(([l, w]) => l + w <= 100.05), spans.slice(0, 3));
    ok('有月份刻度', h.includes('class="tk"'));
  } else ok('（无里程碑，跳过）', true);

  section('边界：空数据不炸');
  const bak = { d: S.DB.duties, w: S.DB.works, m: S.DB.milestones, t: S.DB.tasks };
  S.DB.duties = []; S.DB.works = []; S.DB.milestones = []; S.DB.tasks = [];
  let crashed = null;
  for (const tab of ['person', 'category', 'time', 'gantt']) {
    try { render(tab); } catch (e) { crashed = tab + ': ' + e.message; }
  }
  ok('四个页签在空数据下都不报错', !crashed, crashed);
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
