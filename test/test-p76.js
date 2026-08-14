/* P76：用户反馈"图片导出不是光人员工作矩阵模块问题，还有其他模块都不对，全部检查修复"。

   逐个模块排查了 REPORT_MODULES 里所有没配 canvas() 的模块，区分"退回 text() 真的会丢内容/
   看不出形状"和"退回 text() 只是没那么好看但数据不缺"两类，只处理前一类：
   ① myDesk（我的工作台）：html() 是一份完整的在办任务清单，text() 却只有一句"牵头 X 项、
      在办 Y 条"的统计摘要——"在办的到底是哪几条任务"整个不见了。加了 canvas()，直接复用
      已有的 a.taskRows 原语画出清单。
   ② backlogTrend（待办总量趋势）/ ③ planDueTrend（各月计划完成量）：都是"看形状/看对比"
      的图表，text() 拆成一行行数字后，涨跌方向、任务数跟里程碑数谁多谁少这些关系全没了。
      新增两个 canvas 原语——trendLine（折线，照抄 lineChart() 的坐标算法）、
      groupedBar（两组并排柱子，照抄 groupedBarChart() 的算法）。
   ④ msGantt（里程碑甘特图）：数据丢得最狠的一个——text() 把所有职责/工作下的里程碑打散
      揉成一个纯按日期排的全局列表，只取前 20 条，职责/工作/任务这层归属关系全没了，
      超过 20 条的直接砍掉。新增 msTreeOutline 原语，画一份职责→工作→任务的缩进大纲，
      三层结构原样保留，不设数量上限。
   ⑤ workOverview（工作项状态总览）：text() 漏了 SPI（html() 里明明有这张卡片）。
   ⑥ dashCards（整体统计卡片）：text() 8 个数字只念了 4 个，漏了任务/里程碑各自的
      "今日到期""本周到期"。⑤⑥ 都是直接把 text() 本身补全，不建 canvas
      （数字直接摆成几行文字已经够用，不像上面四个那样"必须看形状/看层级"）。

   personBars / dutyCategoryBars / dutyItemBars / taskDueDist / taskPriorityPie /
   taskSourceBars / taskTagBars / worksByYearBars / worksByDutyBars / msCompletionPie /
   msLevelPie / recentActivity 这些模块的 text() 本来就跟 html() 数据对得上、条目也不多，
   逐条核对过没有真的丢数据，维持现状，不是漏检。
   用法：node test/test-p76.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, q, raw } = require('./harness.js');

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

  /* ================= 通用夹具：一个有职责/工作/任务/里程碑的数据集 ================= */
  await S.Repo.upsert('duty', { code: 'P76D', name: 'P76图片导出全面排查职责' });
  await S.Repo.upsert('work', { id: 'p76_w', duty: 'P76D', code: 'W1', name: 'P76图片导出全面排查工作', owner: '测试管理员', year: 2020 });
  await S.Repo.upsert('task', { id: 'p76_t1', work: 'p76_w', title: 'P76在办任务A', status: 'doing', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(5) });
  await S.Repo.upsert('task', { id: 'p76_t2', work: 'p76_w', title: 'P76在办任务B', status: 'todo', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(2) });
  await S.Repo.upsert('milestone', { id: 'p76_ms1', task: 'p76_t1', plan_date: S.todayStr(), deliverable: 'P76交付物1', report_level: 'section', done: '0' });
  S.rebuildIndex();
  const d = S.buildReportData('week', 0);

  /* ================= ①：myDesk ================= */
  section('①：myDesk——之前没配 canvas()，会退回只有一句统计摘要的 text()，任务清单本身不见了');
  ok('★personMatrix 之后紧跟着，myDesk 模块定义里也确实多了 canvas: (d, a) => {...} 这个出口',
    /key: 'myDesk'[\s\S]*?canvas: \(d, a\) => \{/.test(html));
  ok('★canvas() 里复用了已有的 a.taskRows 原语画清单，不是又拿 text() 兜底',
    /key: 'myDesk'[\s\S]{0,2000}?a\.taskRows\(mineOpen, '暂无在办任务'\);/.test(html));

  /* ================= ②③：backlogTrend / planDueTrend ================= */
  section('②：backlogTrend——新增 trendLine 折线原语，canvas() 里调用它');
  ok('★trendLine 原语存在，坐标算法（网格/折线/点）照抄自 lineChart()',
    /const trendLine = \(series, aKey, aLabel\) => \{/.test(html));
  ok('★backlogTrend 模块的 canvas() 调用了 a.trendLine(series, \'backlog\', \'待办总量\')',
    /key: 'backlogTrend'[\s\S]{0,2000}?a\.trendLine\(series, 'backlog', '待办总量'\);/.test(html));

  section('③：planDueTrend——新增 groupedBar 并排双柱原语，canvas() 里调用它');
  ok('★groupedBar 原语存在，坐标算法照抄自 groupedBarChart()', /const groupedBar = \(series, aKey, bKey, aLabel, bLabel\) => \{/.test(html));
  ok('★planDueTrend 模块的 canvas() 调用了 a.groupedBar(series, \'tasks\', \'milestones\', ...)',
    /key: 'planDueTrend'[\s\S]{0,2000}?a\.groupedBar\(series, 'tasks', 'milestones', '计划完成任务数', '计划完成里程碑数'\);/.test(html));

  /* ================= ④：msGantt ================= */
  // P82 起 msTreeOutline（纯文字缩进大纲）被 ganttChart（真正画跨度条+节点的时间轴）取代了——
  // 用户反馈"里程碑甘特图模块导出图片还不对，都是文字"，光有结构没有图形还是不够，
  // 这里只保留"职责/工作/任务归属不丢、不设数量上限"这两条还成立的断言，新增的部分见 test-p82.js
  section('④：msGantt——之前退回 text() 是全局打散排序 + 只取前 20 条，职责/工作/任务归属全丢了');
  ok('★新增了 ganttChart 原语，用 msTreeGroups() 保留职责→工作→任务三层结构',
    /const ganttChart = tasks => \{\s*const \{ msByTask, byDutyWork \} = msTreeGroups\(tasks\);/.test(html));
  ok('★msGantt 模块的 canvas() 调用了 a.ganttChart(d.tasks)，不再走 text() 兜底',
    /key: 'msGantt'[\s\S]{0,2000}?canvas: \(d, a\) => a\.ganttChart\(d\.tasks\) \}/.test(html));

  /* ================= ⑤：workOverview ================= */
  section('⑤：workOverview——text() 直接调用验证，SPI 这一行真的出现了');
  const workOverviewLines = [];
  S.REPORT_MODULE_MAP.workOverview.text(d, t => workOverviewLines.push(t));
  ok('★text() 输出里有一行是 SPI（以前完全没有这行，html() 里却明明画了 SPI 卡片）',
    workOverviewLines.some(l => l.includes('SPI')));
  ok('WORK_STATUS 那几行状态计数还在（没有因为加 SPI 把原来的弄丢）',
    workOverviewLines.length >= S.WORK_STATUS.length + 1);

  /* ================= ⑥：dashCards 的继任者们 ================= */
  // P81 后期改版：dashCards 拆成了职责/工作/任务/里程碑四个独立模块（overallDuty/overallWork/
  // overallTask/overallMs），任务/里程碑维度的口径（总数+已完成/进行中/未开始/逾期，里程碑
  // 没有进行中/未开始）没变，只是从"一个模块四个 stat-group"变成"四个各自独立的模块"
  section('⑥：overallDuty/overallWork/overallTask/overallMs——text() 直接调用验证，四个维度的数字都在了');
  const overallDutyLines = [];
  S.REPORT_MODULE_MAP.overallDuty.text(d, t => overallDutyLines.push(t));
  ok('★职责总览有总数', overallDutyLines.some(l => l.includes('总数')));
  const overallWorkLines = [];
  S.REPORT_MODULE_MAP.overallWork.text(d, t => overallWorkLines.push(t));
  ok('★工作总览有总数/进行中/已完成/暂停', overallWorkLines.some(l =>
    l.includes('总数') && l.includes('进行中') && l.includes('已完成') && l.includes('暂停')));
  // P81 更后期改版：未开始并进"进行中"算，四张卡变成总数/已完成/进行中/逾期
  const overallTaskLines = [];
  S.REPORT_MODULE_MAP.overallTask.text(d, t => overallTaskLines.push(t));
  ok('★任务总览有总数 + 已完成/进行中/逾期（未开始已经并进"进行中"了，不再单独出现）', overallTaskLines.some(l =>
    l.includes('总数') && l.includes('已完成') && l.includes('进行中') && l.includes('逾期')));
  const overallMsLines = [];
  S.REPORT_MODULE_MAP.overallMs.text(d, t => overallMsLines.push(t));
  ok('★里程碑总览有总数 + 已完成/未完成/逾期', overallMsLines.some(l =>
    l.includes('总数') && l.includes('已完成') && l.includes('未完成') && l.includes('逾期')));

  /* ================= 回归：所有改过的模块一起塞进图片导出，不能抛异常 ================= */
  section('★回归——exportReportImage() 在没有真实 canvas 环境的沙盒里，塞进本轮全部改动的模块依然优雅降级');
  S.DB.reportConfig = {
    activeId: 'preset_p76', presets: [{ id: 'preset_p76', name: 'p76test', sections: [
      { id: 'sec_p76', title: 'P76全面排查测试区',
        modules: ['personMatrix', 'myDesk', 'backlogTrend', 'planDueTrend', 'msGantt', 'workOverview', 'overallDuty', 'overallWork', 'overallTask', 'overallMs'], inline: [] },
    ] }],
  };
  let threw = false;
  try { await S.exportReportImage(); } catch (e) { threw = true; console.error(e); }
  ok('★调用 exportReportImage() 不会抛出未捕获异常', threw === false);

  section('★回归——空数据（没有任何职责/工作/任务/里程碑）时同样不抛异常，各模块的空状态分支都兜住了');
  const bak = { tasks: S.DB.tasks, works: S.DB.works, duties: S.DB.duties, milestones: S.DB.milestones };
  S.DB.tasks = []; S.DB.works = []; S.DB.duties = []; S.DB.milestones = [];
  S.rebuildIndex();
  let threwEmpty = false;
  try { await S.exportReportImage(); } catch (e) { threwEmpty = true; console.error(e); }
  ok('★空数据下 exportReportImage() 依然不抛异常', threwEmpty === false);
  S.DB.tasks = bak.tasks; S.DB.works = bak.works; S.DB.duties = bak.duties; S.DB.milestones = bak.milestones;
  S.rebuildIndex();

  S.DB.reportConfig = null;

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
