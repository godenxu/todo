/* P83：本轮改动测试——
   1) 修复"本期已交付里程碑"（deliveredMs）导出图片时饼图打印不出来：html() 明明是"呈报层级
      分布饼图 + 清单"两段，canvas() 却只画了清单那一段，饼图在图片里直接消失
   2) 顺带审查了 REPORT_MODULES 整个注册表，确认这是唯一一处"html() 画了图表、canvas() 却没有
      对应画法"的情况，其余所有带饼图/柱状图/甘特图/矩阵的模块 canvas() 都跟 html() 对得上
   用法：node test/test-p83.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);
  const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  S.DB.settings.me = '测试管理员';

  section('①：★deliveredMs 的 canvas() 补上了饼图');
  ok('★源码里 deliveredMs 的 canvas() 调用了 a.pie(...)，不再只有 a.msRows(...)',
    /key: 'deliveredMs'[\s\S]{0,3000}canvas: \(d, a\) => \{\s*const filtered = reportDeliveredMsLevelFilter[\s\S]{0,300}a\.pie\(msReportLevelStatsOf\(d\.deliveredInRange, DELIVERED_MS_LEVEL_ORDER\)\);\s*a\.msRows\(filtered,/.test(src));

  section('①：★deliveredMs 饼图统计口径——用全量分布（不跟着筛选走），清单用筛选后的结果');
  await S.Repo.upsert('duty', { code: 'P83D', name: 'P83职责' });
  await S.Repo.upsert('work', { id: 'p83_w', duty: 'P83D', name: 'P83工作', owner: '测试管理员' });
  await S.Repo.upsert('task', { id: 'p83_t1', work: 'p83_w', title: 'P83任务甲', status: 'done', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(-1), actual_date: S.todayStr() });
  await S.Repo.upsert('task', { id: 'p83_t2', work: 'p83_w', title: 'P83任务乙', status: 'done', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(-1), actual_date: S.todayStr() });
  await S.Repo.upsert('milestone', { id: 'p83_ms1', task: 'p83_t1', plan_date: S.offsetDate(-1), actual_date: S.todayStr(), deliverable: 'P83交付物甲', done: '1', report_level: 'section' });
  await S.Repo.upsert('milestone', { id: 'p83_ms2', task: 'p83_t2', plan_date: S.offsetDate(-1), actual_date: S.todayStr(), deliverable: 'P83交付物乙', done: '1', report_level: 'department' });
  const dWeek = S.buildReportData('week', 0, '');
  const stAll = S.msReportLevelStatsOf(dWeek.deliveredInRange, S.DELIVERED_MS_LEVEL_ORDER);
  ok('本期交付的两个层级都统计到了（甲=处室领导，乙=部门领导）', stAll.some(s => s.v === 'section' && s.n >= 1) && stAll.some(s => s.v === 'department' && s.n >= 1));

  section('②：★全面审查 REPORT_MODULES——html() 里画了饼图/柱状图/甘特图/矩阵的模块，canvas() 都有对应画法');
  // 这些模块的 html() 明确用了 pieChart()/barChart()/groupedBarChart()/milestoneTreeHTML()/
  // personMatrixHTML() 画图表，canvas() 必须也调用对应的 a.pie/a.bar/a.groupedBar/a.ganttChart/
  // a.matrix/a.singleBar/a.hbars/a.trendLine，不能只退回纯文字
  const chartModules = [
    { key: 'deliveredMs', mustInclude: 'a.pie(' },
    { key: 'periodStatus', mustInclude: 'a.pie(' },
    { key: 'dutyCategoryBars', mustInclude: 'a.pie(' },
    { key: 'dutyItemBars', mustInclude: 'a.pie(' },
    { key: 'taskDueDist', mustInclude: 'a.pie(' },
    { key: 'taskPriorityPie', mustInclude: 'a.pie(' },
    { key: 'workOverview', mustInclude: 'a.pie(' },
    { key: 'msCompletionPie', mustInclude: 'a.pie(' },
    { key: 'msLevelPie', mustInclude: 'a.pie(' },
    { key: 'msGantt', mustInclude: 'a.ganttChart(' },
    { key: 'backlogTrend', mustInclude: 'a.trendLine(' },
    { key: 'planDueTrend', mustInclude: 'a.groupedBar(' },
    { key: 'dutyTree', mustInclude: 'a.bar(' },
    { key: 'personMatrix', mustInclude: 'a.matrix(' },
    { key: 'personBars', mustInclude: 'a.bar(' },
    { key: 'worksByYearBars', mustInclude: 'a.singleBar(' },
    { key: 'worksByDutyBars', mustInclude: 'a.hbars(' },
    { key: 'taskSourceBars', mustInclude: 'a.hbars(' },
    { key: 'taskTagBars', mustInclude: 'a.hbars(' },
    { key: 'dashMyMsTimeline', mustInclude: 'a.ganttChart(' },
  ];
  chartModules.forEach(({ key, mustInclude }) => {
    const m = S.REPORT_MODULE_MAP[key];
    ok(`★${key} 模块存在`, !!m);
    if (!m) return;
    ok(`★${key} 有 canvas()`, typeof m.canvas === 'function');
    if (typeof m.canvas !== 'function') return;
    // 直接跑一遍 canvas()，喂一个记录调用名的假 api，确认真的调用到了对应的画图原语，
    // 不是侥幸源码里搜到字符串但实际没执行到那一行
    const calls = [];
    // twoCol 是"排版容器"，真正的画图调用（a.pie/a.bar 等）藏在传给它的两个闭包里——假 api
    // 如果对 twoCol 也只记名不执行，闭包永远不会跑，里面嵌套的 a.pie 之类也就永远记录不到。
    // 这里给 twoCol 一个"真的调用两个闭包"的实现，其余方法照旧只记名字
    const proxyA = new Proxy({
      twoCol: (leftFn, leftW, rightFn) => { leftFn(); rightFn(); },
    }, { get: (target, prop) => prop in target ? target[prop] : (...args) => { calls.push(String(prop)); } });
    const d = S.buildReportData('week', 0, key.startsWith('dashMy') ? '测试管理员' : '');
    try { m.canvas(d, proxyA); } catch (e) { /* 数据不齐全时画法本身可能提前 return，不算失败 */ }
    const fnName = mustInclude.replace('a.', '').replace('(', '');
    ok(`★${key} 的 canvas() 实际调用了 ${mustInclude}`, calls.includes(fnName), calls);
  });

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
