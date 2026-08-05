/* P59：本轮三项改动测试——
   ① 图表页"按任务"里优先级/来源/标签分布切到"看数据表"时内容溢出模块区域：
      dataTable() 统一包一层 overflow-x:auto
   ② 报告页"到期分布"字体大小跟其他模块不一致：barChart 不再用 viewBox 缩放，
      改用 fitFlexBarChart() 渲染后按真实宽度重画
   ③ 报告模块凡是在图表页/工作台有对应"看数据表"/月周日/展开全部/折叠全部按钮的，
      报告页也要有，且位置对齐（面板头，而不是正文里），且点了真的有效果：
      reportIsTable()/reportModHead() 新基建 + 'chart-view'/'trend-granularity' 改成
      调用 renderPage() 而不是死板刷图表页
   用法：node test/test-p59.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
// chartTableView 是沙盒里那个对象的引用，直接 S.chartTableView = {} 只是换掉 S 上的这个属性，
// 沙盒内部代码手里还攥着旧对象——清空必须操作同一个对象自身的 key，不能整个重新赋值
const clearCTV = () => { Object.keys(S.chartTableView).forEach(k => delete S.chartTableView[k]); };

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.settings.me = bakMe;
    clearCTV();
    S.setReportPeriod('week'); S.setReportOffset(0);
    S.setFileHandle(null);
  };
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();
  const d = S.buildReportData('week', 0);

  /* ====================== ① dataTable 溢出修复 ====================== */
  section('①：dataTable() 统一包了一层 overflow-x:auto，看数据表不再撑出所在模块');
  ok('★源码里 dataTable() 的输出用 overflow-x:auto 包了一层',
    /function dataTable\(headers, rows\) \{[\s\S]{0,600}overflow-x:auto/.test(html));
  const tblOut = S.dataTable(['列1', '列2'], [['甲', 1], ['乙', 2]]);
  ok('★dataTable() 实际输出确实带 overflow-x:auto 的外层容器', /^<div style="overflow-x:auto">/.test(tblOut));
  ok('.dtable 本身还在这层容器里面（没有破坏原有结构）', tblOut.includes('<table class="dtable">'));

  section('①：图表页"按任务"tab 的优先级/来源/标签三个模块切到看数据表，输出也带这层容器');
  S.goto('charts');
  S.ACTIONS['chart-tab']({ k: 'task' });
  S.ACTIONS['chart-view']({ id: 'taskPri' });
  S.ACTIONS['chart-view']({ id: 'taskSource' });
  S.ACTIONS['chart-view']({ id: 'taskTag' });
  let chH = q('#page-charts').innerHTML;
  ok('三个面板都在看数据表状态', S.chartTableView.taskPri && S.chartTableView.taskSource && S.chartTableView.taskTag);
  ok('★页面里出现了三个 overflow-x:auto 包裹的表格（每个模块各一个）',
    (chH.match(/overflow-x:auto/g) || []).length >= 3);
  S.ACTIONS['chart-view']({ id: 'taskPri' });
  S.ACTIONS['chart-view']({ id: 'taskSource' });
  S.ACTIONS['chart-view']({ id: 'taskTag' });

  /* ====================== ② 到期分布字体大小修复 ====================== */
  section('②：barChart 不再用 viewBox 缩放（P58 那个办法会把内嵌文字一起等比缩放，字体跟着变形）');
  // 函数体里留了一段注释解释"以前为什么用过 viewBox、现在为什么不用了"，注释本身当然会
  // 提到 viewBox 这个词——真正要断言的是 return 出去的 <svg ...> 模板字符串本身，
  // 不是拿整个函数源码（连注释一起）做字符串匹配，那样注释就把测试写死成"永远失败"了
  ok('★barChart 的 return 模板字符串里没有 viewBox（不是注释，是真正拼出来的那行）',
    html.includes('return `<svg width="${w}" height="${h}" role="img" aria-label="未完成任务的到期分布">'));
  const svgOut = S.barChart([{ label: 'A', n: 3, cls: 'bar-norm' }], 400);
  ok('实际渲染出的 svg 没有 viewBox 属性', !svgOut.includes('viewBox'));
  ok('实际渲染出的 svg 没有 width:100% 的拉伸样式', !svgOut.includes('width:100%'));
  ok('svg 的 width 就是原样传入的真实像素值（1:1，不会连带缩放字体）', svgOut.includes('width="400"'));

  section('②：fitFlexBarChart() 存在，负责渲染后测真实宽度、差得多就按实际宽度重画');
  ok('★fitFlexBarChart 函数存在', typeof S.fitFlexBarChart === 'function');
  ok('容器为空时安全早退，不报错', (() => { try { S.fitFlexBarChart(null, []); return true; } catch (e) { return false; } })());

  section('②：报告页"到期分布"模块的柱状图容器带 data-due-fit 标记，且 renderReport 里接了这条重画逻辑');
  const dueHtml = S.REPORT_MODULE_MAP.taskDueDist.html(d, { width: 900 });
  ok('★到期分布柱状图外层带 data-due-fit（跟图表页"按时间"tab 的到期分布用同一套机制）', dueHtml.includes('data-due-fit'));
  // dueHtml 里有两个 svg：柱状图（barChart，不该有 viewBox）+ 右边的占比饼图（pieChart，
  // 饼图本来就一直用 viewBox 画自己的坐标系，跟 P58 那个"拉伸撑满容器"的技法无关，
  // 只挑 data-due-fit 容器里紧跟着的第一个 <svg ...> 标签来断言，别把饼图也算进去
  const barSvgTag = dueHtml.slice(dueHtml.indexOf('data-due-fit')).match(/<svg[^>]*>/)[0];
  ok('★柱状图那个 svg 没有 viewBox 了（同一个 barChart，天然享受修复）', !barSvgTag.includes('viewBox'));
  ok('★renderReport() 源码里确实调用了 fitFlexBarChart（不是只加了标记没接上）',
    /function renderReport\(\)[\s\S]{0,6000}fitFlexBarChart\(dueEl, dueBuckets/.test(html));
  S.goto('report');
  ok('报告页真实渲染一遍不报错，且能找到 data-due-fit 容器', !!q('#page-report').querySelector('[data-due-fit]'));

  /* ====================== ③ 报告模块按钮对齐图表页/工作台 ====================== */
  section('③：reportIsTable/reportModHead 基建函数存在');
  ok('★reportIsTable 函数存在', typeof S.reportIsTable === 'function');
  ok('★reportModHead 函数存在', typeof S.reportModHead === 'function');

  section('③：所有跟图表页/工作台有"看图表/看数据表"按钮对应的报告模块，都标了 table:true');
  const TABLE_MODULES = ['personBars', 'dutyCategoryBars', 'dutyItemBars', 'taskStatusPie', 'taskDueDist',
    'taskPriorityPie', 'taskSourceBars', 'taskTagBars', 'workOverview', 'worksByYearBars', 'worksByDutyBars',
    'msCompletionPie', 'msLevelPie', 'msGantt', 'backlogTrend', 'planDueTrend'];
  TABLE_MODULES.forEach(k => ok(`★${k}.table === true`, S.REPORT_MODULE_MAP[k].table === true));

  section('③：reportModHead 渲染出的按钮，位置在面板头（跟图表页 panelHead 视觉一致）');
  const headOut = S.reportModHead(S.REPORT_MODULE_MAP.taskStatusPie, '');
  ok('★面板头里有"看数据表"按钮（初始未开表格态）', headOut.includes('看数据表'));
  ok('按钮的 data-act 是 chart-view（跟图表页共用同一套开关逻辑）', headOut.includes('data-act="chart-view"'));
  ok('★按钮的 data-id 带 rep_ 前缀（跟图表页自己的 chartTableView id 空间隔离）', headOut.includes('data-id="rep_taskStatusPie"'));
  ok('面板头包在 panel-h 里', headOut.startsWith('<div class="panel-h">'));

  section('③：★关键防撞车——workOverview 这个 key 报告页和图表页都在用，两边的看数据表状态必须互不影响');
  clearCTV();
  S.chartTableView.workOverview = true; // 模拟"刚才在图表页把工作总览切到了数据表"
  ok('报告页的 workOverview 模块不受影响，仍然是看图表状态', S.reportIsTable('workOverview') === false);
  const workOverviewHtml1 = S.REPORT_MODULE_MAP.workOverview.html(d);
  ok('报告页 workOverview 渲染的还是饼图，不是表格', workOverviewHtml1.includes('<svg') || workOverviewHtml1.includes('empty-mini'));
  S.chartTableView.rep_workOverview = true;
  const workOverviewHtml2 = S.REPORT_MODULE_MAP.workOverview.html(d);
  ok('把 rep_workOverview 打开后，报告页才切换成表格', workOverviewHtml2.includes('<table class="dtable">'));
  clearCTV();

  section('③：每个 table:true 模块打开 reportIsTable 之后，html() 真的输出对应表头的 dataTable');
  const EXPECT_COLS = {
    personBars: ['姓名', '相关合计', '已完成', '进行中', '逾期', '未开始', '完成率', '牵头', '参与'],
    dutyCategoryBars: ['类别', '合计', '已完成', '进行中', '逾期', '未开始', '完成率'],
    dutyItemBars: ['职责', '合计', '已完成', '进行中', '逾期', '未开始', '完成率'],
    taskStatusPie: ['状态', '数量'],
    taskDueDist: ['区间', '任务数'],
    taskPriorityPie: ['优先级', '数量'],
    taskSourceBars: ['来源', '数量'],
    taskTagBars: ['标签', '数量'],
    workOverview: ['状态', '数量'],
    worksByYearBars: ['年度', '工作数'],
    worksByDutyBars: ['职责', '工作数'],
    msCompletionPie: ['情况', '数量'],
    msLevelPie: ['呈报层级', '数量'],
    planDueTrend: ['月份', '计划完成任务数', '计划完成里程碑数'],
    backlogTrend: ['时间点', '待办总量'],
  };
  Object.keys(EXPECT_COLS).forEach(k => {
    clearCTV(); S.chartTableView['rep_' + k] = true;
    const out = S.REPORT_MODULE_MAP[k].html(d, { width: 900 });
    const cols = EXPECT_COLS[k];
    ok(`${k}：看数据表输出 <table class="dtable">`, out.includes('<table class="dtable">'));
    ok(`${k}：表头跟图表页同名面板完全一致（${cols.join('/')}）`, cols.every(c => out.includes(`<th>${c}</th>`)));
  });
  clearCTV();
  S.chartTableView.rep_msGantt = true;
  const msGanttTableOut = S.REPORT_MODULE_MAP.msGantt.html(d);
  ok('msGantt：看数据表输出用的是 ganttDataTable()（跟图表页甘特图共用同一张表）', msGanttTableOut.includes('<table class="dtable">'));
  clearCTV();

  section('③：msGantt / backlogTrend / dutyTree 的展开折叠、月周日按钮，挪进了 note（面板头），不再堆在正文里');
  const msGanttNote = S.REPORT_MODULE_MAP.msGantt.note(d);
  ok('★msGantt.note 存在且带三个展开/折叠按钮', typeof S.REPORT_MODULE_MAP.msGantt.note === 'function');
  ok('全部展开按钮在 note 里', msGanttNote.includes('data-act="report-ms-expand-all"'));
  ok('展开到工作层按钮在 note 里', msGanttNote.includes('data-act="report-ms-expand-to-work"'));
  ok('全部折叠按钮在 note 里', msGanttNote.includes('data-act="report-ms-collapse-all"'));
  const msGanttHtml = S.REPORT_MODULE_MAP.msGantt.html(d);
  ok('★正文 html() 里不再重复这三个展开/折叠按钮（已经搬到 note 了，不是复制一份）',
    !msGanttHtml.includes('data-act="report-ms-expand-all"'));

  const backlogNote = S.REPORT_MODULE_MAP.backlogTrend.note(d);
  ok('★backlogTrend.note 存在且带月/周/日切换', typeof S.REPORT_MODULE_MAP.backlogTrend.note === 'function');
  ok('月按钮在 note 里', backlogNote.includes('data-act="trend-granularity"') && backlogNote.includes('data-g="month"'));
  ok('周按钮在 note 里', backlogNote.includes('data-g="week"'));
  ok('日按钮在 note 里', backlogNote.includes('data-g="day"'));
  const backlogHtml = S.REPORT_MODULE_MAP.backlogTrend.html(d, { width: 900 });
  ok('★正文 html() 里不再重复月/周/日按钮', !backlogHtml.includes('data-act="trend-granularity"'));

  const dutyTreeNote = S.REPORT_MODULE_MAP.dutyTree.note(d);
  ok('dutyTree.note 存在且带展开/折叠', dutyTreeNote.includes('report-expand-all') && dutyTreeNote.includes('report-collapse-all'));

  section('③：报告页实际渲染时，note 出现在面板头，"看数据表"按钮出现在面板头，跟图表页视觉一致');
  S.DB.reportConfig = null;
  S.goto('report');
  let repH = q('#page-report').innerHTML;
  ok('页面上确实渲染出了"看数据表"按钮（至少一个 table:true 模块在默认编排里）', repH.includes('看数据表') || repH.includes('看图表'));

  // 默认编排（DEFAULT_REPORT_SECTIONS）本来就没放 backlogTrend，要验证它的月/周/日按钮
  // 真的出现在页面上，得先把它排进编排里——不依赖默认编排恰好包含哪些模块
  S.DB.reportConfig = { activeId: 'preset_p59test',
    presets: [{ id: 'preset_p59test', name: 'p59test', sections: [{ id: 'sec_t', title: '测试区域', modules: ['backlogTrend'] }] }] };
  S.goto('report');
  repH = q('#page-report').innerHTML;
  ok('待办总量趋势模块的月/周/日按钮出现在页面上', repH.includes('data-act="trend-granularity"'));
  S.DB.reportConfig = null;

  section('③：★核心修复——从报告页点"看数据表"，用的是 renderPage()，不是死板刷图表页');
  ok('★源码里 chart-view 这个 ACTIONS handler 调用的是 renderPage()，不是硬编码 renderCharts()',
    /'chart-view':\s*d\s*=>\s*\{\s*chartTableView\[d\.id\]\s*=\s*!chartTableView\[d\.id\];\s*renderPage\(\);\s*\}/.test(html));
  ok('★trend-granularity 同理，调用的是 renderPage()', /'trend-granularity':\s*d\s*=>\s*\{\s*trendGranularity\s*=\s*d\.g;\s*renderPage\(\);\s*\}/.test(html));

  section('③：从报告页实际点击"看数据表"，报告页自己的内容真的变了（不是点了没反应）');
  S.DB.reportConfig = null;
  S.goto('report');
  repH = q('#page-report').innerHTML;
  const hadTable = /taskStatusPie/, m0 = S.REPORT_MODULE_MAP.taskStatusPie;
  // 找一个默认编排里真的存在的 table:true 模块来实测点击效果，比写死某个 key 更稳
  const sections0 = S.reportSections();
  let targetKey = null;
  sections0.forEach(sec => sec.rows.forEach(row => row.forEach(k => {
    if (!targetKey && S.REPORT_MODULE_MAP[k] && S.REPORT_MODULE_MAP[k].table) targetKey = k;
  })));
  ok('默认编排里至少有一个 table:true 模块（否则下面这条测试没法测）', !!targetKey);
  if (targetKey) {
    const beforeHtml = q('#page-report').innerHTML;
    ok('点击前，该模块面板里没有 <table class="dtable">（默认是看图状态）',
      !new RegExp(`data-id="rep_${targetKey}"[\\s\\S]{0,4000}<table class="dtable">`).test(beforeHtml)
      || S.chartTableView['rep_' + targetKey]);
    S.ACTIONS['chart-view']({ id: 'rep_' + targetKey });
    ok('★点击后 currentPage 还是 report（renderPage 分发对了页面）', S.currentPage === 'report');
    const afterHtml = q('#page-report').innerHTML;
    ok('★点击后报告页自己的 DOM 真的变了，出现了这个模块的数据表', afterHtml.includes('<table class="dtable">'));
    ok('再点一次能切回去', (S.ACTIONS['chart-view']({ id: 'rep_' + targetKey }), !S.chartTableView['rep_' + targetKey]));
  }

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
