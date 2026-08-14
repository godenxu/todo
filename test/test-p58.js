/* P58：本轮六项改动测试——
   ① personBars 补全为图表页"按人"的完整搬运（加上牵头/参与比例条），移除冗余的"人员工作情况"模块
   ② 优先级/来源/标签分布拆成三个模块（报告页可选、图表页同一行并排三个独立面板）
   ③ 各年度/各职责工作数量拆成两个模块（报告页可选、图表页同一行并排两个独立面板）
   ④ 图表页"按里程碑"：完成情况分布 + 呈报层级分布 改成同一行并排
   ⑤ 修复报告页"到期分布"模块右侧留白过多（barChart 加 viewBox，真正撑满所在的 flex 容器）
   ⑥ "二、当期处室工作状态"改名"二、本期处室工作进展"
   用法：node test/test-p58.js */
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

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.settings.me = bakMe;
    S.DB.reportConfig = null;
    S.setFileHandle(null);
  };
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();

  /* ====================== ① personBars 补全 + 移除 people ====================== */
  section('①：people 模块已经彻底移除，personBars 是唯一的人员任务量模块');
  ok('★REPORT_MODULE_MAP 里已经没有 people 这个 key 了', !S.REPORT_MODULE_MAP.people);
  ok('personBars 还在', !!S.REPORT_MODULE_MAP.personBars);
  ok('REPORT_MODULES 里也找不到 key 为 people 的条目', !S.REPORT_MODULES.some(m => m.key === 'people'));

  // P80 后期改版在最前面插了"一、处室工作整体统计"，"人员工作情况"从第四段挪到第五段——
  // 这里改用标题文字定位那一段，不再依赖具体下标，以后再插段落也不会跟着炸
  section('①：默认编排"人员工作情况"这段用 personBars 呈现，不再是 people');
  S.DB.reportConfig = null;
  const defSecs = S.reportSections();
  const peopleSec = defSecs.find(s => s.title.includes('人员工作情况'));
  ok('这段标题是"五、人员工作情况"（区域标题本身没变，变的是它下面挂的模块）',
    !!peopleSec && peopleSec.title === '五、人员工作情况');
  ok('★这段的模块换成了 personBars', peopleSec.modules.join(',') === 'personBars');

  section('①：personBars 是图表页"按人"的完整搬运，包含牵头/参与比例条（不是阉割版）');
  const d = S.buildReportData('week', 0);
  const h1 = S.REPORT_MODULE_MAP.personBars.html(d, { width: 900 });
  ok('★有牵头/参与比例条（track-role），不是只有状态条', h1.includes('track-role'));
  ok('★比例条上带着牵头/参与的具体数字（num-role）', h1.includes('num-role'));
  ok('图例里有牵头/参与的颜色说明', h1.includes('牵头') && h1.includes('参与'));
  ok('每一行还能点击跳到任务页按人筛选（跟图表页一致）', h1.includes('data-act="filter-person"'));
  ok('用的是跟图表页同一个 bar-row-person 类名（同一套 CSS 尺寸）', h1.includes('bar-row-person'));

  /* ====================== ② 优先级/来源/标签拆成三个模块 ====================== */
  section('②：taskFieldDist 已经不存在了，拆成三个独立模块');
  ok('★旧的合并模块 taskFieldDist 已经没有了', !S.REPORT_MODULE_MAP.taskFieldDist);
  ['taskPriorityPie', 'taskSourceBars', 'taskTagBars'].forEach(k =>
    ok(`★${k} 存在，且属于"任务分布"分类`, !!S.REPORT_MODULE_MAP[k] && S.REPORT_MODULE_MAP[k].group === 'task'));

  section('②：三个模块各自 html/text 都能正常渲染，内容互不重复');
  const priHtml = S.REPORT_MODULE_MAP.taskPriorityPie.html(d, { width: 300 });
  const srcHtml = S.REPORT_MODULE_MAP.taskSourceBars.html(d, { width: 300 });
  const tagHtml = S.REPORT_MODULE_MAP.taskTagBars.html(d, { width: 300 });
  ok('优先级模块只画饼图，不含来源/标签的横条列表', priHtml.includes('<svg') && !priHtml.includes('bar-row'));
  ok('来源模块是横向列表，不是饼图', srcHtml.includes('bar-row') || srcHtml.includes('empty-mini'));
  ok('三个模块互不包含对方的说明文字', !priHtml.includes('自由填写字段') && srcHtml.includes('自由填写字段') && tagHtml.includes('自由填写字段'));

  section('②：图表页"按任务" tab 里，这三块拆成了三个独立面板，同一行并排');
  S.goto('charts');
  S.ACTIONS['chart-tab']({ k: 'task' });
  let chH = q('#page-charts').innerHTML;
  ok('★三个独立的面板标题（不再是合并的"优先级 / 来源 / 标签分布"）',
    chH.includes('▤ 优先级分布') && chH.includes('▤ 任务来源分布') && chH.includes('▤ 任务标签分布'));
  ok('旧的合并标题已经不在了', !chH.includes('▤ 优先级 / 来源 / 标签分布'));
  ok('★三个面板包在同一个 .rep-row 容器里（同一行并排）',
    /class="rep-row"[\s\S]{0,300}▤ 优先级分布[\s\S]{0,3000}▤ 任务来源分布[\s\S]{0,3000}▤ 任务标签分布/.test(chH));
  ok('每个面板都有自己的 rep-col', (chH.match(/panel rep-col/g) || []).length >= 3);
  ok('每个面板独立"看数据表"（各自的 chartTableView id 不同）',
    chH.includes('data-id="taskPri"') && chH.includes('data-id="taskSource"') && chH.includes('data-id="taskTag"'));

  /* ====================== ③ 年度/职责工作数量拆成两个模块 ====================== */
  section('③：workYearDuty 已经不存在了，拆成两个独立模块');
  ok('★旧的合并模块 workYearDuty 已经没有了', !S.REPORT_MODULE_MAP.workYearDuty);
  ['worksByYearBars', 'worksByDutyBars'].forEach(k =>
    ok(`★${k} 存在，且属于"职责与工作"分类`, !!S.REPORT_MODULE_MAP[k] && S.REPORT_MODULE_MAP[k].group === 'duty'));

  section('③：图表页"按工作" tab 里，这两块拆成了两个独立面板，同一行并排');
  S.ACTIONS['chart-tab']({ k: 'work' });
  chH = q('#page-charts').innerHTML;
  ok('★两个独立的面板标题（不再是合并的"各年度工作数量 / 各职责工作数量"）',
    chH.includes('▤ 各年度工作数量') && chH.includes('▤ 各职责工作数量'));
  ok('旧的合并标题已经不在了', !chH.includes('各年度工作数量 / 各职责工作数量'));
  ok('★两个面板包在同一个 .rep-row 容器里', /class="rep-row"[\s\S]{0,300}▤ 各年度工作数量[\s\S]{0,3000}▤ 各职责工作数量/.test(chH));
  ok('工作总览 + 各职责/工作推进情况 这两块没受影响，还在', chH.includes('工作总览') && chH.includes('各职责/工作推进情况'));

  /* ====================== ④ 里程碑 tab 两个饼图同一行 ====================== */
  section('④：图表页"按里程碑" tab 的完成情况分布 + 呈报层级分布，同一行并排');
  S.ACTIONS['chart-tab']({ k: 'gantt' });
  chH = q('#page-charts').innerHTML;
  ok('两块标题都在', chH.includes('▤ 里程碑完成情况分布') && chH.includes('▤ 交付物呈报层级分布'));
  ok('★包在同一个 .rep-row 容器里（以前是纵向堆叠的两个独立 panel）',
    /class="rep-row"[\s\S]{0,300}▤ 里程碑完成情况分布[\s\S]{0,3000}▤ 交付物呈报层级分布/.test(chH));
  ok('甘特图本身没受影响，还在下面', chH.includes('里程碑甘特图'));

  /* ====================== ⑤ barChart 右侧留白修复 ======================
     P58 当时用 viewBox + CSS width:100% 撑满容器，P59 发现这个办法会把 SVG 内嵌的
     <text font-size> 也一起等比缩放，导致到期分布的字体跟其他模块不一致（P59 用户反馈的
     第 2 项）。P59 改成 fitFlexBarChart()：渲染后量出真实 DOM 宽度，差得多就照实际宽度
     重画一遍，SVG 始终 1:1 声明宽度=渲染宽度，不缩放、不失真。这里的断言相应更新为验证
     新方案，不再要求 viewBox/width:100%（那是已经被替换掉的旧实现）。 */
  section('⑤：barChart 恢复为不缩放的定宽 SVG，不再靠 viewBox/width:100% 撑满容器');
  const svgOut = S.barChart([{ label: 'A', n: 3, cls: 'bar-norm' }], 500);
  ok('svg 没有 viewBox 了（避免内嵌文字被跟着等比缩放变形）', !svgOut.includes('viewBox'));
  ok('svg 没有 width:100% 的拉伸样式了', !svgOut.includes('width:100%'));
  ok('svg 的 width 属性就是传入的真实宽度（1:1，不缩放）', svgOut.includes('width="500"'));

  section('⑤：fitFlexBarChart 存在，用来在渲染后按真实 DOM 宽度重画，替代 viewBox 缩放');
  ok('★fitFlexBarChart 函数存在', typeof S.fitFlexBarChart === 'function');
  ok('传入 null 容器不报错（防御性早退）', (() => { try { S.fitFlexBarChart(null, []); return true; } catch (e) { return false; } })());

  section('⑤：报告页"到期分布"模块能正常渲染，柱状图容器带着 data-due-fit 供后续重画');
  const dueHtml = S.REPORT_MODULE_MAP.taskDueDist.html(d, { width: 900 });
  ok('到期分布模块渲染出了 svg', dueHtml.includes('<svg'));
  ok('★柱状图外层带 data-due-fit（renderReport 靠它找到容器做measure-and-redraw）', dueHtml.includes('data-due-fit'));
  // dueHtml 里还有一个右侧占比饼图（pieChart），它本来就一直用 viewBox 画自己的坐标系，
  // 跟这里要验证的柱状图 barChart 无关——只挑 data-due-fit 容器里紧跟着的那个 svg 来看
  const dueBarSvgTag = dueHtml.slice(dueHtml.indexOf('data-due-fit')).match(/<svg[^>]*>/)[0];
  ok('这个柱状图 svg 不再带 viewBox（同一个函数，天然享受到修复）', !dueBarSvgTag.includes('viewBox'));

  /* ====================== ⑥ 区域标题改名 ====================== */
  // P80 后期改版又在最前面插了一段"一、处室工作整体统计"，"本期处室工作进展"整体挪到第三段，
  // 标题前缀也从"二、"变成"三、"——这里只认标题文字本身，不再依赖具体是第几段
  section('⑥："当期处室工作状态"改成了"本期处室工作进展"');
  S.DB.reportConfig = null;
  ok('★DEFAULT_REPORT_SECTIONS 里有一段标题是"三、本期处室工作进展"',
    S.reportSections().some(s => s.title === '三、本期处室工作进展'));
  ok('旧文字"当期处室工作状态"已经不在默认编排里了',
    !S.reportSections().some(s => s.title.includes('当期处室工作状态')));
  S.goto('report');
  const repH = q('#page-report').innerHTML;
  ok('页面上确实渲染出了新标题', repH.includes('三、本期处室工作进展'));
  ok('纯文本简报里也是新标题', S.buildReportText().includes('三、本期处室工作进展'));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
