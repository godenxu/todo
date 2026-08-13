/* P79：用户反馈三件事——
   ① 报告导出图片：里程碑甘特图模块还是"都是文字"；部分模块标题下方第一行文字上面被切掉几个像素。
   ② 报告导出 PDF：待办总量趋势、各月计划完成量这两个模块还有横向滚动条。

   排查/修复如下：
   ① 里程碑甘特图：P76 那次新增的 msTreeOutline 虽然保留了职责→工作→任务的归属结构，
      但本质还是纯文字缩进大纲——用户说得对，"甘特图"这三个字本来指的就是"时间轴 + 跨度条 +
      节点"这种图形，光有层级列表看不出"哪条快到期、哪条已经逾期"。这次换成 ganttChart：
      坐标算法照抄 milestoneTreeHTML()（同一套 lo/hi 时间轴边界、pct() 换算），画出真正的
      时间轴 + 跨度条 + 状态分色的节点圆点 + 贯穿全程的"今天"竖线，职责/工作展开折叠状态
      也用的是同一个 reportMsDutyExpanded/reportMsWorkExpanded。
   ② 面板内容第一行文字被切：line()/rowLine() 一直是直接把 cur.y（当前行槽位的顶部）当成
      fillText 的基线用，字符的上升部分会往基线上方冒出去——大多数情况下这段冒出来的高度
      落进上一行槽位的下半截空白里看不出来，但面板里的第一行没有"上一行"接住它，直接怼进
      头部分隔线。bar()/hbars()/statBoxes() 这些原语其实早就在基线前加了 +8/+9/+10 的偏移量，
      这次给 line()/rowLine() 也补上同一量级的偏移，跟其它原语统一。
   ③ PDF 横向滚动条：到期分布之前就有 fitFlexBarChart()——插入 DOM 后量一次真实列宽，
      跟声明宽度差得多就照实际宽度重画一遍，因为 reportChartWidth(ctx) 这个估算值（来自
      renderReport 顶部按 flex 权重"算"出来的 colW，不是真的量出来的 DOM 宽度）跟真实渲染
      宽度免不了会有几像素出入，Chrome 打印 overflow:auto 容器时只要真的溢出一丁点就会把
      滚动条也印出来。待办总量趋势/各月计划完成量之前没有这个"插入 DOM 后按真实宽度重画"的
      补救，这次给它们（顺带给各年度工作数量）也配上，fitFlexBarChart 顺手抽成通用的
      fitFlexChart(wrapEl, redraw)，barChart/lineChart/groupedBarChart 都能用同一个函数。
   用法：node test/test-p79.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, q, raw } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, 20));

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();

  /* ================= ①：里程碑甘特图改成真正的时间轴 ================= */
  section('①：★里程碑甘特图——从纯文字缩进大纲换成真正画时间轴的 ganttChart');
  ok('★ganttChart 原语存在，坐标边界算法（lo/hi）照抄 milestoneTreeHTML()',
    /const ganttChart = tasks => \{/.test(html) && /let lo = Math\.max\(Math\.min\(0, \.\.\.allOffs\) - 5, twoMonthsAgoOffset\(\)\), hi = Math\.max\(\.\.\.allOffs\) \+ 5;/.test(html));
  ok('★节点按状态分色（逾期红/7天内橙/后续蓝/已完成绿），跟屏幕上是同一套颜色',
    /const STATUS_COLOR = \{ late: '#c0392b', soon: '#e0900a', norm: '#1a6aa8', done: '#1e7d45' \};/.test(html));
  ok('★展开/折叠状态读的是 reportMsDutyExpanded/reportMsWorkExpanded，跟屏幕上/PDF 保持一致',
    /const ganttChart = tasks => \{[\s\S]{0,3000}?reportMsDutyExpanded\.has\(code\)/.test(html)
    && /const ganttChart = tasks => \{[\s\S]{0,4000}?reportMsWorkExpanded\.has\(workId\)/.test(html));
  ok('★msGantt 模块的 canvas() 调用了 a.ganttChart(d.tasks)', /canvas: \(d, a\) => a\.ganttChart\(d\.tasks\) \}/.test(html));
  ok('★ganttChart 进了 api 对象', /const api = \{[^}]*\bganttChart\b[^}]*\};/.test(html));

  section('①：★运行时——真的把 ganttChart 跑一遍，读取绘制轨迹，确认画的是图形不是纯文字');
  await S.Repo.upsert('duty', { code: 'P79A', name: 'P79职责A' });
  await S.Repo.upsert('work', { id: 'p79_wa', duty: 'P79A', code: 'W1', name: 'P79工作A', owner: '甲', year: 2020 });
  await S.Repo.upsert('task', { id: 'p79_ta', work: 'p79_wa', title: 'P79任务A', status: 'doing', owner: '甲', assignees: [], plan_date: S.offsetDate(5) });
  await S.Repo.upsert('milestone', { id: 'p79_ms1', task: 'p79_ta', plan_date: S.offsetDate(-3), deliverable: 'P79交付物', report_level: 'section', done: '0' });
  S.rebuildIndex();
  S.DB.reportConfig = {
    activeId: 'preset_p79g', presets: [{ id: 'preset_p79g', name: 'p79g', sections: [
      { id: 'sec_p79g', title: 'P79甘特测试区', modules: ['msGantt'], inline: [], widths: {} },
    ] }],
  };
  let threwG = false;
  try { await S.exportReportImage(); } catch (e) { threwG = true; console.error(e); }
  ok('★调用 exportReportImage() 不会抛出未捕获异常', threwG === false);
  const cvG = raw.document._lastCanvas;
  const callsG = cvG && cvG._ctx ? cvG._ctx._calls : [];
  const arcCallsG = callsG.filter(c => c.op === 'arc');
  ok('★真的画了节点圆点（arc 调用），不是像以前那样只有 fillText',
    arcCallsG.length >= 1, arcCallsG.length);
  const strokeCallsG = callsG.filter(c => c.op === 'stroke');
  ok('★真的画了跨度条/今天竖线（stroke 调用）', strokeCallsG.length >= 1, strokeCallsG.length);

  /* ================= ②：面板内容第一行文字偏移修复 ================= */
  section('②：★line()/rowLine() 补上了基线偏移，跟 bar()/hbars() 等原语的画法统一');
  ok('★line() 的 fillText 用的是 cur.y + 9（以前是直接用 cur.y 当基线）',
    /const line = \(text, opts = \{\}\) => \{[\s\S]{0,300}?ctx\.fillText\(truncate\(ctx, text, cur\.w - \(opts\.indent \|\| 0\)\), cur\.x0 \+ \(opts\.indent \|\| 0\), cur\.y \+ 9\);/.test(html));
  ok('★rowLine() 三处 fillText 都用了 cur.y + 9',
    (() => {
      const m = html.match(/const rowLine = \(dateText, dateColor, title, sub\) => \{[\s\S]*?\n {6}\};/);
      if (!m) return false;
      const matches = m[0].match(/cur\.y \+ 9/g) || [];
      return matches.length === 3;
    })());

  section('②：★运行时——面板头部分隔线到第一行文字之间有正常的间距，不再贴在一起');
  S.DB.reportConfig = {
    activeId: 'preset_p79l', presets: [{ id: 'preset_p79l', name: 'p79l', sections: [
      { id: 'sec_p79l', title: 'P79首行偏移测试区', modules: ['myDesk'], inline: [], widths: {} },
    ] }],
  };
  S.DB.settings.me = null;   // 未登录，myDesk 会走 a.empty(...) → line()，正好是"面板内容第一行"
  let threwL = false;
  try { await S.exportReportImage(); } catch (e) { threwL = true; console.error(e); }
  ok('★调用 exportReportImage() 不会抛出未捕获异常', threwL === false);
  const cvL = raw.document._lastCanvas;
  const callsL = cvL && cvL._ctx ? cvL._ctx._calls : [];
  const headerCall = callsL.find(c => c.op === 'fillText' && String(c.args[0]).includes('我的工作台'));
  const emptyCall = callsL.find(c => c.op === 'fillText' && String(c.args[0]).includes('尚未登录'));
  ok('★能同时找到面板头部文字和内容第一行文字这两次 fillText 调用', !!headerCall && !!emptyCall,
    { headerCall: headerCall && headerCall.args.slice(1, 3), emptyCall: emptyCall && emptyCall.args.slice(1, 3) });
  if (headerCall && emptyCall) {
    const headerY = headerCall.args[2], contentY = emptyCall.args[2];
    // 头部文字基线在头部行内（PANEL_PAD+9=19px 处），内容第一行基线在头部+分隔线+PANEL_PAD 再加 9px 处
    // （PANEL_HEAD_H=28+PANEL_PAD=10+9=47px 处），两者应该差 28px 左右（不该只差个位数，
    // 差个位数就是"第一行文字贴着分隔线"这个 bug 的量化表现）
    ok('★内容第一行基线跟头部文字基线之间隔了完整的一个头部高度（约 28px），不是只隔几像素',
      contentY - headerY >= 24, { headerY, contentY, gap: contentY - headerY });
  }
  S.DB.settings.me = '测试管理员';

  /* ================= ③：PDF 横向滚动条 ================= */
  section('③：★fitFlexBarChart 抽成通用的 fitFlexChart(wrapEl, redraw)，barChart/lineChart/groupedBarChart 都能用');
  ok('★fitFlexChart 存在', /function fitFlexChart\(wrapEl, redraw\) \{/.test(html));
  ok('★fitFlexBarChart 现在是 fitFlexChart 的一层薄封装（不是另外重复一份逻辑）',
    /function fitFlexBarChart\(wrapEl, buckets\) \{ fitFlexChart\(wrapEl, w => barChart\(buckets, w\)\); \}/.test(html));

  section('③：★待办总量趋势/各月计划完成量/各年度工作数量都补上了跟到期分布同款的"插入 DOM 后按真实宽度重画"');
  ok('★backlogTrend 的图表包了一层 data-backlogtrend-fit', /data-backlogtrend-fit/.test(html));
  ok('★planDueTrend 的图表包了一层 data-plandue-fit', /data-plandue-fit/.test(html));
  ok('★worksByYearBars 的图表包了一层 data-yearbars-fit', /data-yearbars-fit/.test(html));
  ok('★renderReport() 里对这三个 data-*-fit 都调用了 fitFlexChart',
    /el = \$\('#page-report'\)\.querySelector\('\[data-backlogtrend-fit\]'\);\s*\n\s*if \(el\) fitFlexChart\(el, w => lineChart\(/.test(html)
    && /el = \$\('#page-report'\)\.querySelector\('\[data-plandue-fit\]'\);\s*\n\s*if \(el\) \{/.test(html)
    && /el = \$\('#page-report'\)\.querySelector\('\[data-yearbars-fit\]'\);\s*\n\s*if \(el\) fitFlexChart\(el, w => barChart\(/.test(html));

  section('③：★回归——这三个 fitFlexChart 调用不会让 renderReport() 抛异常（沙盒测不出真实溢出，见真实浏览器验证记录）');
  S.DB.reportConfig = {
    activeId: 'preset_p79s', presets: [{ id: 'preset_p79s', name: 'p79s', sections: [
      { id: 'sec_p79s', title: 'P79滚动条测试区', modules: ['backlogTrend', 'planDueTrend', 'worksByYearBars', 'taskDueDist'], inline: [], widths: {} },
    ] }],
  };
  let threwS = false;
  try { S.renderReport(); } catch (e) { threwS = true; console.error(e); }
  ok('★renderReport() 不会抛出未捕获异常', threwS === false);

  S.DB.reportConfig = null;
  S.renderReport();

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
