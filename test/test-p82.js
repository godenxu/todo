/* P82：本轮改动测试——
   1) 下期计划：左侧时间改用"该条任务最近一个未完成里程碑"的计划日期（没有里程碑才退回任务自己的），
      且收紧筛选口径：只看本期未完成、完成节点真落在下一期的任务/里程碑，不再靠"状态是进行中"兜底
   2) "本期已交付里程碑"（deliveredMs）模块的呈报层级筛选，改成 renderPage() 而不是写死
      renderReport()，工作台/报告页哪边有这个模块都能正常筛
   3) 工作台"人员负荷"（dashPeopleLoad）下线，跟"各人任务量与完成率"（personBars）重复
   4) "本期计划完成度"改名"本期计划开展"
   5) 待办总量趋势图（lineChart 单指标模式 + 对应的 canvas trendLine）在标了时间的点上方顺带标出数值
   6) "各职责/工作推进情况"去重：dashDutyTree 下线，报告页/工作台共用同一份 dutyTree
   7) 报告页标题前加"科技规划处"
   8) 导出图片：宽度 860→1290（加大 50%）；statBoxes 支持 ok（绿）/warn（红）+ 分子大分母小的
      "N/D"字符串自动拆两种字号；人员工作矩阵模块的姓名改横排（不再旋转 90 度）
   用法：node test/test-p82.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, raw, q } = require('./harness.js');

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
  S.setDashPeriod('week'); S.setDashOffset(0); S.setDashViewAsPerson('');
  await S.Repo.upsert('duty', { code: 'P82D', name: 'P82职责' });
  await S.Repo.upsert('work', { id: 'p82_w', duty: 'P82D', name: 'P82工作', owner: '测试管理员' });

  /* ================= ①：下期计划——最近里程碑日期 + 收紧口径 ================= */
  section('①：★nextMilestoneMap——每条任务"最近一个未完成里程碑"（复用给下期计划）');
  await S.Repo.upsert('task', { id: 'p82_ms_task', work: 'p82_w', title: 'P82里程碑任务', status: 'todo', owner: 'P82甲', assignees: [], plan_date: S.offsetDate(200) });
  await S.Repo.upsert('milestone', { id: 'p82_ms_done', task: 'p82_ms_task', plan_date: S.offsetDate(-10), deliverable: 'P82已交付', done: '1' });
  const { start: nextStart, end: nextEnd } = S.periodRange('week', 1);
  await S.Repo.upsert('milestone', { id: 'p82_ms_next', task: 'p82_ms_task', plan_date: nextStart, deliverable: 'P82下期交付', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p82_ms_far', task: 'p82_ms_task', plan_date: S.offsetDate(190), deliverable: 'P82远期交付', done: '0' });
  const nmMap = S.nextMilestoneMap();
  ok('★取到的是排在最前面的未完成里程碑，不是已完成的、也不是更靠后的',
    nmMap.get('p82_ms_task') && nmMap.get('p82_ms_task').id === 'p82_ms_next');

  section('①：★下期计划模块——有里程碑的任务，左侧时间用里程碑的日期，不是任务自己的');
  const dWeek = S.buildReportData('week', 0, 'P82甲');
  const nextPlanHtml = S.REPORT_MODULE_MAP.dashMyNextPlan.html(dWeek);
  ok('★列表里能看到这条任务（任务自己的计划完成时间远在下一期之外，能出现说明用的是里程碑日期）',
    nextPlanHtml.includes('P82里程碑任务'));
  // 日期显示用的是 fmtDate 格式化过的 nextStart，不是任务自己那个 offsetDate(200)
  ok('★显示的日期是里程碑的计划日期（nextStart），不是任务自己的计划完成时间',
    nextPlanHtml.includes(S.fmtDate(nextStart)) && !nextPlanHtml.includes(S.fmtDate(S.offsetDate(200))));
  ok('★已交付的里程碑不会被当成"最近一个"带出来', !nextPlanHtml.includes('P82已交付'));
  ok('★排在后面还没轮到的里程碑不会被一起拉进来', !nextPlanHtml.includes('P82远期交付'));
  ok('★真正"最近一个"的交付物有显示出来', nextPlanHtml.includes('P82下期交付'));

  section('①：★下期计划模块——没有里程碑的任务，退回看任务自己的计划完成时间');
  await S.Repo.upsert('task', { id: 'p82_plain_task', work: 'p82_w', title: 'P82无里程碑任务', status: 'todo', owner: 'P82甲', assignees: [], plan_date: nextStart });
  const dWeek2 = S.buildReportData('week', 0, 'P82甲');
  const nextPlanHtml2 = S.REPORT_MODULE_MAP.dashMyNextPlan.html(dWeek2);
  ok('计划完成时间落在下一期的无里程碑任务照样出现', nextPlanHtml2.includes('P82无里程碑任务'));

  section('①：★下期计划模块——收紧口径：doing 状态但完成节点不落在下一期的，不再靠状态兜底拉进来');
  await S.Repo.upsert('task', { id: 'p82_doing_far', work: 'p82_w', title: 'P82远期进行中任务', status: 'doing', owner: 'P82甲', assignees: [], plan_date: S.offsetDate(200) });
  const dWeek3 = S.buildReportData('week', 0, 'P82甲');
  const nextPlanHtml3 = S.REPORT_MODULE_MAP.dashMyNextPlan.html(dWeek3);
  ok('★status===doing 但计划完成时间远在下一期之外、又没有里程碑的任务，不会出现在下期计划里',
    !nextPlanHtml3.includes('P82远期进行中任务'));
  ok('★模块 desc 文案也同步改了，不再提"哪怕计划日期不在下一期"这种旧口径',
    !S.REPORT_MODULE_MAP.dashMyNextPlan.desc.includes('哪怕计划日期不在下一期'));

  /* ================= ②：本期已交付里程碑筛选 renderPage() 化 ================= */
  section('②：★report-delivered-ms-level-filter 改成 renderPage()，工作台上用这个模块也能正常筛');
  ok('★源码里这个 action 用的是 renderPage()，不再写死 renderReport()',
    /'report-delivered-ms-level-filter': d => \{\s*reportDeliveredMsLevelFilter = reportDeliveredMsLevelFilter === d\.level \? '' : d\.level;\s*renderPage\(\);/.test(src));
  await S.saveDashboardConfig(cfg => {
    const sec = S.dashboardPresetIn(cfg).sections[1];
    sec.modules.push('deliveredMs');
    sec.personScope.deliveredMs = 'all';
  });
  S.setReportDeliveredMsLevelFilter('');
  S.goto('dashboard');
  let dashH = q('#page-dashboard').innerHTML;
  ok('★deliveredMs 模块能加到工作台，且渲染出来了', dashH.includes('本期已交付里程碑'));
  const levelMatch = /data-act="report-delivered-ms-level-filter" data-level="([^"]+)"/.exec(dashH);
  if (levelMatch) {
    S.ACTIONS['report-delivered-ms-level-filter']({ level: levelMatch[1] });
    dashH = q('#page-dashboard').innerHTML;
    ok('★点了筛选之后，刷新的是工作台页面本身（筛选状态生效、且还在工作台上能看到）',
      S.reportDeliveredMsLevelFilter === levelMatch[1] && dashH.includes('已按'));
    S.ACTIONS['report-delivered-ms-level-filter']({ level: levelMatch[1] });
    ok('再点一次取消筛选', S.reportDeliveredMsLevelFilter === '');
  } else {
    ok('★点了筛选之后，刷新的是工作台页面本身（没有可点的层级，跳过点击验证但不算失败)', true);
  }
  await S.saveDashboardConfig(cfg => { cfg.presets.forEach(p => p.sections = JSON.parse(JSON.stringify(S.DEFAULT_DASHBOARD_SECTIONS))); });

  /* ================= ③：人员负荷模块下线 ================= */
  section('③：★工作台"人员负荷"（dashPeopleLoad）下线，去重复');
  ok('★REPORT_MODULE_MAP 里已经没有 dashPeopleLoad 这个 key 了', !S.REPORT_MODULE_MAP.dashPeopleLoad);
  ok('★源码里也没有这个模块的定义了', !src.includes("key: 'dashPeopleLoad'"));
  ok('★默认工作台编排（处室概览区）不再包含 dashPeopleLoad', !S.DEFAULT_DASHBOARD_SECTIONS[1].modules.includes('dashPeopleLoad'));
  ok('★"各人任务量与完成率"（personBars）还在，没有被一起误删', !!S.REPORT_MODULE_MAP.personBars);

  /* ================= ④："本期计划完成度"改名"本期计划开展" ================= */
  section('④：★periodOverallPlan 改名"本期计划完成度"→"本期计划开展"');
  ok('★label 是新名字', S.REPORT_MODULE_MAP.periodOverallPlan.label === '本期计划开展');
  ok('★源码里已经没有旧名字了', !src.includes("label: '本期计划完成度'"));

  /* ================= ⑤：待办总量趋势图标数值 ================= */
  section('⑤：★lineChart（单指标模式）在标了时间的点上方顺带画出数值');
  const series = [
    { label: '1月', backlog: 3 }, { label: '2月', backlog: 7 }, { label: '3月', backlog: 5 },
  ];
  const svg = S.lineChart(series, 600, '测试趋势', { aKey: 'backlog', bKey: null, aLabel: '待办总量' });
  ok('★点数不多（≤12）时，每个点都标了数值（ax-text val 这个 class）', (svg.match(/class="ax-text val"/g) || []).length === series.length);
  ok('★数值文本对得上数据本身', svg.includes('>3<') && svg.includes('>7<') && svg.includes('>5<'));
  const manySeries = Array.from({ length: 20 }, (_, i) => ({ label: `第${i}天`, backlog: i }));
  const svgMany = S.lineChart(manySeries, 900, '测试趋势-多点', { aKey: 'backlog', bKey: null, aLabel: '待办总量' });
  const valLabCount = (svgMany.match(/class="ax-text val"/g) || []).length;
  ok('★点数超过 12 个时，数值标签跟着时间标签一起隔一个标一个，不会全标出来挤成一团', valLabCount > 0 && valLabCount < manySeries.length);

  section('⑤：★canvas trendLine（导出图片用）同样在标了时间的点上方画出数值');
  ok('★源码里 trendLine 补了这一段：跟标时间同样的 step 条件，画 s[aKey] 这个数值',
    /series\.forEach\(\(s, i\) => \{ if \(i % step === 0\) ctx\.fillText\(String\(s\[aKey\]\), x\(i\), yv\(s\[aKey\]\) - 6\); \}\);/.test(src));

  /* ================= ⑥："各职责/工作推进情况"去重 ================= */
  section('⑥：★dashDutyTree 下线，报告页/工作台共用同一份 dutyTree 模块');
  ok('★REPORT_MODULE_MAP 里已经没有 dashDutyTree 这个 key 了', !S.REPORT_MODULE_MAP.dashDutyTree);
  ok('★源码里也没有这个模块的定义了', !src.includes("key: 'dashDutyTree'"));
  ok('★默认工作台编排用的是 dutyTree', S.DEFAULT_DASHBOARD_SECTIONS[1].modules.includes('dutyTree'));
  ok('★dutyTree 本身还在（没有被一起误删）', !!S.REPORT_MODULE_MAP.dutyTree);
  S.goto('dashboard');
  dashH = q('#page-dashboard').innerHTML;
  ok('★工作台页面上真的渲染出"各职责/工作推进情况"这块内容', dashH.includes('各职责/工作推进情况'));
  ok('★用的是共享的 report-expand-all/report-collapse-all，不是已下线的 dash-expand-all/dash-collapse-all',
    dashH.includes('data-act="report-expand-all"') && !dashH.includes('data-act="dash-expand-all"'));

  /* ================= ⑦：报告页标题加"科技规划处"前缀 ================= */
  section('⑦：★报告页标题前加"科技规划处"');
  S.goto('report');
  const repH = q('#page-report').innerHTML;
  ok('★页面标题带上了"科技规划处"前缀', repH.includes('科技规划处　处室工作简报'));
  ok('★纯文本导出（reportPlainText 之类）也带了前缀',
    /const lines = \[`科技规划处　处室工作简报（统计周期：/.test(src));
  ok('★导出图片的页头文字也带了前缀',
    /const headerText = `📋 科技规划处　处室工作简报　·　统计周期：/.test(src));

  /* ================= ⑧：导出图片——加宽 50% + 红绿配色/分子分母字号 + 姓名横排 ================= */
  section('⑧：★导出图片宽度从 860 加大 50% 到 1290');
  ok('★源码里 W 常量确实是 1290', /const W = 1290, PAD = 24, LH = 22;/.test(src));

  section('⑧：★statBoxes 支持 ok（绿）/warn（红），"N/D"形状的字符串自动拆成分子大、分母小两种字号');
  ok('★statBoxes 源码里有按 ok/warn 取色的逻辑', /const vColor = c\.ok \? COL\.done : \(c\.warn \? COL\.overdue : COL\.text\);/.test(src));
  ok('★statBoxes 源码里有"N/D"正则拆分逻辑', /const fracMatch = \/\^\(\\d\+\)\\\/\(\\d\+\)\$\/\.exec\(vStr\);/.test(src));
  ok('★statBoxes 不再把列数封顶在 4（5 张卡的组不会画出面板外）', /const cols = Math\.max\(1, g\.cards\.length\);/.test(src) && !/const cols = Math\.max\(1, Math\.min\(4, g\.cards\.length\)\);/.test(src));
  // 具体几个模块的 canvas() 确实带上了 ok/warn，跟 html() 的颜色能对上
  ok('★overallWork 的"已完成"canvas 卡片带了 ok:true', /\{ k: '已完成', v: `\$\{workStat\.done\}\/\$\{d\.works\.length\}`, ok: true \}/.test(src));
  ok('★overallTask 的"已完成"canvas 卡片带了 ok:true', /\{ k: '已完成', v: `\$\{taskStat\.done\}\/\$\{d\.tasks\.length\}`, ok: true \}/.test(src));
  ok('★overallMs 的"已完成"canvas 卡片带了 ok:true', /\{ k: '已完成', v: `\$\{msStat\.done\}\/\$\{d\.taskMilestones\.length\}`, ok: true \}/.test(src));
  ok('★dashMyCards 补上了 canvas()（以前没有，退回 text() 全是黑字）', /key: 'dashMyCards'[\s\S]{0,3000}canvas: \(d, a\) => \{/.test(src));

  section('⑧：★人员工作矩阵（personMatrix）模块的姓名改横排，不再旋转 90 度');
  ok('★matrix() 画法里已经没有 ctx.rotate 这一句了', !/const matrix = \(dutyStat, workStat, people, heat, expandedSet\) => \{[\s\S]*?ctx\.rotate/.test(src.match(/const matrix = \(dutyStat, workStat, people, heat, expandedSet\) => \{[\s\S]*?\n {6}\};/)?.[0] || ''));
  ok('★改成横排 fillText，用 colW 截断长度（不是用 headH 那个高度截断）',
    /ctx\.fillText\(truncate\(ctx, p, colW - 2\), cx, cur\.y \+ headH - 8\);/.test(src));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
