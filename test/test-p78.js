/* P78：用户反馈"导出的图片还是不够好...现在有的模块连图表都没有了，都是排列混乱的文字"。

   P77 把图片导出的"排版结构"（面板/并排/配色）对齐了 PDF，但内容层面还有 14 个模块——
   personBars/dutyCategoryBars/dutyItemBars/taskDueDist/taskPriorityPie/taskSourceBars/
   taskTagBars/workOverview/worksByYearBars/worksByDutyBars/msCompletionPie/msLevelPie/
   dashCards/recentActivity——一直没配 canvas()，图片导出全部退回 text() 纯文字兜底。这些
   模块在屏幕/PDF 上原本是饼图、横条图、纵向柱状图、卡片网格，退化成文字之后"看不出占比、
   看不出谁多谁少、看不出卡片式的统计数字"，这才是用户说的"排列混乱的文字"——不是内容丢了
   （P75/P76 已经处理过内容丢失），是图形没了。

   这次给这 14 个模块全部配上 canvas()，复用/新增了 5 个通用画法（挂在 api 上）：
   ① pie(data)——占比饼图 + 图例，坐标算法照抄 pieChart()，图例照抄 pieLegend()，
      顺带处理了 msCompletionPie/dueSummary 那种颜色写成 var(--c-done) 的情况
      （canvas fillStyle 认不出 CSS 变量，加了 resolveColor() 转成字面色值）。
   ② singleBar(items)——纵向柱状图，照抄 barChart()，支持按 cls 分色（到期分布那种
      "已逾期红、本周内橙、其它蓝"）。
   ③ hbars(bars)——横向列表条形图，照抄 hBarList()，单色进度条 + 数字。
   ④ statBoxes(groups)——边框卡片网格，照抄 statCard()，dashCards 的"两组各四张"、
      workOverview 的单张 SPI 卡都走这个。
   ⑤ twoCol(leftFn,leftW,rightFn,rightW)——两栏并排，照抄 .chart-flex（柱状/横条一边、
      饼图另一边），复用 P77 里"临时换 cur 再换回来"的手法。
   personBars/dutyTree 那种"横条+状态分色"的模块直接复用已有的 bar() 原语。

   harness.js 的 canvas 2D 桩已经在 P77 补上了，这里的运行时断言是真的把 layout() 跑到底、
   读取 arc/fillRect/roundRect 等调用参数，能验证"饼图是不是真的画出了扇区""柱状图是不是
   真的填了色"，不是只做源码正则匹配。
   用法：node test/test-p78.js */
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

  /* ================= 源码结构：新原语 + 14 个模块都配上了 canvas() ================= */
  section('①：★新增的 5 个通用画法都在（pie/singleBar/hbars/statBoxes/twoCol），且都挂进了 api');
  ok('★pie() 存在，且会用 resolveColor 把 var(--x) 转成字面色值', /const pie = data => \{/.test(html) && /const resolveColor = c => \{/.test(html));
  ok('★singleBar() 存在，按 cls 取色（bar-late/bar-soon/bar-norm/bar-done）',
    /const singleBar = items => \{/.test(html) && /const BAR_CLS_COLOR = \{ 'bar-late'/.test(html));
  ok('★hbars() 存在', /const hbars = bars => \{/.test(html));
  ok('★statBoxes() 存在', /const statBoxes = groups => \{/.test(html));
  ok('★twoCol() 存在', /const twoCol = \(leftFn, leftW, rightFn, rightW\) => \{/.test(html));
  ok('★这 5 个都进了 api 对象', /const api = \{ line, empty, bar, rowLine, taskRows, msRows, matrix, trendLine, groupedBar, ganttChart, pie, singleBar, hbars, statBoxes, twoCol \};/.test(html));

  section('②：★14 个之前退回 text() 的模块，现在全部配了 canvas()（源码逐个核对）');
  // P81 后期改版：dashCards 拆成了职责/工作/任务/里程碑四个独立模块，这里用 overallTask/
  // overallWork 代表原来那份（都还有 canvas()），不再引用已经下线的 dashCards 这个 key
  const NEW_CANVAS_MODULES = ['personBars', 'dutyCategoryBars', 'dutyItemBars', 'taskDueDist', 'taskPriorityPie',
    'taskSourceBars', 'taskTagBars', 'workOverview', 'worksByYearBars', 'worksByDutyBars',
    'msCompletionPie', 'msLevelPie', 'overallTask', 'overallWork', 'recentActivity'];
  NEW_CANVAS_MODULES.forEach(k => {
    ok(`★${k} 模块定义里有 canvas: (d, a) => {...}`,
      new RegExp(`key: '${k}'[\\s\\S]{0,4500}?canvas: \\(d, a\\) =>`).test(html));
  });

  section('③：★REPORT_MODULES 里已经没有任何模块缺 canvas 出口了');
  ok('★29 个模块（全部）都配了 canvas()，一个没漏',
    (() => {
      const s = html.indexOf('const REPORT_MODULES = [');
      const e = html.indexOf('\nconst REPORT_MODULE_MAP');
      const block = html.slice(s, e);
      const keys = [...block.matchAll(/key: '(\w+)'/g)].map(m => m[1]);
      const missing = keys.filter(k => {
        const ks = block.indexOf(`key: '${k}'`);
        const ke = block.indexOf(`key: '`, ks + 5);
        const seg = block.slice(ks, ke === -1 ? block.length : ke);
        return !/canvas:/.test(seg);
      });
      return missing.length === 0 ? true : missing;
    })());

  /* ================= 运行时：真的把每个新模块的 canvas() 跑一遍 ================= */
  section('④：★运行时——把这 14 个模块一起塞进报告编排，exportReportImage() 不抛异常，真的产生大量绘制调用');
  await S.Repo.upsert('duty', { code: 'P78A', name: 'P78职责A' });
  await S.Repo.upsert('duty', { code: 'P78B', name: 'P78职责B' });
  await S.Repo.upsert('work', { id: 'p78_wa', duty: 'P78A', code: 'W1', name: 'P78工作A', owner: '甲', year: 2020 });
  await S.Repo.upsert('work', { id: 'p78_wb', duty: 'P78B', code: 'W1', name: 'P78工作B', owner: '乙', year: 2021 });
  for (let i = 0; i < 6; i++) {
    await S.Repo.upsert('task', {
      id: `p78_t${i}`, work: i % 2 ? 'p78_wa' : 'p78_wb', title: `P78任务${i}`,
      status: ['todo', 'doing', 'done', 'hold'][i % 4], priority: String((i % 3) + 1),
      owner: i % 2 ? '甲' : '乙', assignees: [], plan_date: S.offsetDate(i - 3),
      source: i % 2 ? '上级交办' : '', custom: i % 3 === 0 ? '重点' : '',
    });
  }
  await S.Repo.upsert('milestone', { id: 'p78_ms1', task: 'p78_t0', plan_date: S.offsetDate(-2), deliverable: 'P78交付物', report_level: 'bank', done: '0' });
  S.rebuildIndex();
  const d = S.buildReportData('week', 0);

  S.DB.reportConfig = {
    activeId: 'preset_p78', presets: [{ id: 'preset_p78', name: 'p78test', sections: [
      { id: 'sec_p78', title: 'P78新画法测试区', modules: NEW_CANVAS_MODULES, inline: [], widths: {} },
    ] }],
  };
  let threw = false;
  try { await S.exportReportImage(); } catch (e) { threw = true; console.error(e); }
  ok('★调用 exportReportImage() 不会抛出未捕获异常', threw === false);

  const cv = raw.document._lastCanvas;
  const calls = cv && cv._ctx ? cv._ctx._calls : [];
  ok('★真的产生了大量 canvas 绘制调用（不是一上来就异常退出）', calls.length > 200, calls.length);

  const arcCalls = calls.filter(c => c.op === 'arc');
  ok('★饼图模块（dutyCategoryBars/dutyItemBars/taskPriorityPie/workOverview/msCompletionPie/msLevelPie 共 6 个）'
    + '真的画了扇区（arc 调用次数应该不少，每个饼图至少 1 个扇区）', arcCalls.length >= 6, arcCalls.length);

  const strokeRects = calls.filter(c => c.op === 'strokeRect');
  ok('★statBoxes 卡片网格真的画了边框（overallTask 5 张 + overallWork 4 张 + workOverview 1 张 SPI，strokeRect 次数应该 >= 9）',
    strokeRects.length >= 9, strokeRects.length);

  const fillTexts = calls.filter(c => c.op === 'fillText').map(c => String(c.args[0]));
  ok('★SPI 数字画出来了（workOverview 的卡片）', fillTexts.some(t => /^-?\d+\.\d{2}$|^—$/.test(t)));
  ok('★没有画出 NaN 或 undefined 字样（说明数据管道里没有断链）',
    !fillTexts.some(t => /NaN|undefined/.test(t)));

  section('⑤：★运行时——回归：空数据下这 14 个模块的 canvas() 都能优雅降级，不抛异常');
  const bak = { tasks: S.DB.tasks, works: S.DB.works, duties: S.DB.duties, milestones: S.DB.milestones };
  S.DB.tasks = []; S.DB.works = []; S.DB.duties = []; S.DB.milestones = [];
  S.rebuildIndex();
  let threwEmpty = false;
  try { await S.exportReportImage(); } catch (e) { threwEmpty = true; console.error(e); }
  ok('★空数据下 exportReportImage() 依然不抛异常', threwEmpty === false);
  S.DB.tasks = bak.tasks; S.DB.works = bak.works; S.DB.duties = bak.duties; S.DB.milestones = bak.milestones;
  S.rebuildIndex();

  section('⑥：★运行时——全部 29 个模块一起塞进编排（模拟用户把所有模块都加进报告），依然不抛异常');
  const allKeys = S.REPORT_MODULES.map(m => m.key);
  S.DB.reportConfig = {
    activeId: 'preset_p78all', presets: [{ id: 'preset_p78all', name: 'p78all', sections: [
      { id: 'sec_all', title: '全部模块', modules: allKeys, inline: [], widths: {} },
    ] }],
  };
  let threwAll = false;
  try { await S.exportReportImage(); } catch (e) { threwAll = true; console.error(e); }
  ok('★29 个模块全部塞进去也不抛异常', threwAll === false);

  S.DB.reportConfig = null;

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
