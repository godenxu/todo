/* P15：本轮改动测试——
   1) 里程碑计划日期晚于任务计划完成时间：保存时自动顺延 + 数据体检新增检查项/一键修复
   2) 报告页/工作台"各职责推进情况"：一键展开全部/折叠全部
   3) hBar 进度条左侧留白 bug 修复（0 值的段不再渲染，避免 flex gap 占位）
   4) 展开的工作条用浅色区分于职责条（工作台 + 报告页共用）
   5) 报告页"本期总览"改用工作台风格的大卡片
   用法：node test/test-p15.js */
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
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const restore = () => { S.DB.users = JSON.parse(JSON.stringify(bakUsers)); S.DB.settings.me = bakMe; };

  section('hBar：数量为 0 的段不渲染，避免 flex gap 在最左边留白');
  const barAllZeroExceptDone = S.hBar('测试职责', { total: 5, done: 5, doing: 0, late: 0, todo: 0, rate: 100 }, 5);
  ok('done=5/doing=0/late=0 时，只渲染了 seg-done 这一个段', (barAllZeroExceptDone.match(/class="seg /g) || []).length === 1);
  const barMixed = S.hBar('测试职责2', { total: 10, done: 0, doing: 4, late: 3, todo: 3, rate: 0 }, 10);
  ok('done=0 时不渲染 seg-done（避免它占一个 0 宽度还带 gap 的空位）', !barMixed.includes('class="seg seg-done"'));
  ok('doing/late 都 >0，各自的段还在', barMixed.includes('class="seg seg-doing"') && barMixed.includes('class="seg seg-late"'));

  section('hBar：muted 参数控制展开的工作条使用浅色');
  const normalBar = S.hBar('普通条', { total: 4, done: 4, doing: 0, late: 0, todo: 0, rate: 100 }, 4);
  const mutedBar = S.hBar('浅色条', { total: 4, done: 4, doing: 0, late: 0, todo: 0, rate: 100 }, 4, '', true);
  ok('不传 muted 时没有 bar-row-muted 这个类', !normalBar.includes('bar-row-muted'));
  ok('传 muted=true 时带上了 bar-row-muted 类', mutedBar.includes('bar-row-muted'));

  section('dutyTreeRowsHTML：展开的工作条确实用了 muted/浅色，职责条本身不受影响');
  const dutyCode = 'P15FIX';
  await S.Repo.upsert('duty', { code: dutyCode, name: 'P15测试职责' });
  const wid1 = 'w_p15_a', wid2 = 'w_p15_b';
  await S.Repo.upsert('work', { id: wid1, duty: dutyCode, name: 'P15工作甲', owner: '测试管理员' });
  await S.Repo.upsert('work', { id: wid2, duty: dutyCode, name: 'P15工作乙', owner: '测试管理员' });
  await S.Repo.upsert('task', { id: 'p15_task_a', work: wid1, title: 'P15任务甲', status: 'done', plan_date: S.todayStr(), actual_date: S.todayStr(), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('task', { id: 'p15_task_b', work: wid2, title: 'P15任务乙', status: 'todo', plan_date: S.offsetDate(10), owner: '测试管理员', assignees: [] });
  const tasksAll = S.visibleTasks().filter(t => !t.deleted_at);
  const dutyStatAll = S.statsByDuty(tasksAll);
  const workStatAll = S.statsByWork(tasksAll);
  const expanded = new Set([dutyCode]);
  const treeHtml = S.dutyTreeRowsHTML(dutyStatAll, workStatAll, expanded, 'test-toggle');
  const dutyRowIdx = treeHtml.indexOf('P15测试职责');
  const workRowIdx = treeHtml.indexOf('report-work-row');
  ok('展开状态下渲染了 report-work-row（工作明细行）', workRowIdx > -1);
  ok('工作明细行在职责行之后', dutyRowIdx > -1 && dutyRowIdx < workRowIdx);
  ok('工作明细行的进度条带 bar-row-muted（浅色）', /report-work-row[\s\S]{0,40}bar-row-muted/.test(treeHtml));
  ok('职责自己的那一行没有 bar-row-muted', !/report-duty-row[\s\S]{0,120}bar-row-muted/.test(treeHtml.slice(0, workRowIdx)));

  section('工作台"各职责推进情况"：一键展开全部/一键折叠全部');
  S.setPage && S.setPage('dashboard');
  S.dashExpanded.clear();
  S.renderDashboard();
  ok('默认折叠，没有工作明细行', !q('#page-dashboard').innerHTML.includes('report-work-row'));
  ok('有全部展开/全部折叠按钮', q('#page-dashboard').innerHTML.includes('data-act="dash-expand-all"') && q('#page-dashboard').innerHTML.includes('data-act="dash-collapse-all"'));
  S.ACTIONS['dash-expand-all']();
  ok('点了全部展开后，能看到工作明细行了', q('#page-dashboard').innerHTML.includes('report-work-row'));
  ok('展开状态里包含这次新建的职责', S.dashExpanded.has(dutyCode));
  S.ACTIONS['dash-collapse-all']();
  ok('点了全部折叠后，工作明细行又没有了', !q('#page-dashboard').innerHTML.includes('report-work-row'));
  ok('展开状态清空了', S.dashExpanded.size === 0);

  section('报告页"各职责/工作推进情况"：一键展开全部/一键折叠全部');
  S.reportExpanded.clear();
  S.goto('report');
  ok('默认折叠', !q('#page-report').innerHTML.includes('report-work-row'));
  ok('有全部展开/全部折叠按钮', q('#page-report').innerHTML.includes('data-act="report-expand-all"') && q('#page-report').innerHTML.includes('data-act="report-collapse-all"'));
  S.ACTIONS['report-expand-all']();
  ok('展开全部后能看到工作明细行', q('#page-report').innerHTML.includes('report-work-row'));
  S.ACTIONS['report-collapse-all']();
  ok('折叠全部后工作明细行消失', !q('#page-report').innerHTML.includes('report-work-row'));
  ok('reportExpanded 清空了', S.reportExpanded.size === 0);

  section('报告页"本期总览"改用工作台风格的大卡片');
  S.goto('report');
  const reportHtml = q('#page-report').innerHTML;
  /* P55 之后写死的"本期总览"面板没有了，取而代之的是可配置编排里的
     「当期涉及范围」「当期工作计划量」「当期完成进度」三个模块——数字变多了、分得更细了，
     但"报告页的统计数字用跟工作台同一套大卡片样式"这条约定没变，这里改成验证这个。
     P59 把面板头换成了 reportModHead()（统一加"全量"标记/note/看数据表按钮的位置），
     标题到 panel-b 之间的间隔比以前写死的 panel-h 标记长一些，{0,40} 放宽一点 */
  ok('当期统计模块仍然用 .cards/.card 这套跟工作台一样的卡片样式',
    /当期涉及范围[\s\S]{0,120}<div class="panel-b">\s*<div class="cards">/.test(reportHtml));
  ok('statCard 生成的卡片带 k/v 两层结构', S.statCard('测试指标', 5).includes('class="k"') && S.statCard('测试指标', 5).includes('class="v'));

  section('里程碑计划日期晚于任务计划完成时间：保存时自动顺延任务的计划完成时间');
  const lateTaskId = 'p15_late_task';
  await S.Repo.upsert('task', { id: lateTaskId, work: wid1, title: 'P15里程碑超期测试任务', status: 'todo', plan_date: '2026-08-01', owner: '测试管理员', assignees: [] });
  S.DB.settings.me = '测试管理员';
  S.openTaskDetail(lateTaskId);
  // 手动伪造一行里程碑，日期比任务的计划完成时间（2026-08-01）晚
  const fakeRow = (date, deliv, done, reportLevel) => ({
    querySelector: sel => {
      if (sel === '.cp-date') return { value: date };
      if (sel === '.cp-deliv') return { value: deliv };
      if (sel === '.cp-chk') return { checked: done };
      if (sel === '.cp-report-level') return { value: reportLevel || '' };
      return null;
    },
  });
  raw.document.querySelectorAll = sel => sel === '#cp-list [data-cp-row]' ? [fakeRow('2026-08-20', 'P15超期交付物', false, 'section')] : [];
  await S.modalCallback(); await tick();
  raw.document.querySelectorAll = () => [];
  const afterLateTask = S.byId('task', lateTaskId);
  ok('任务的计划完成时间被顺延到了里程碑的日期（2026-08-20）', afterLateTask.plan_date === '2026-08-20', afterLateTask.plan_date);
  ok('保存提示里说明了顺延这件事', q('#snack-msg').textContent.includes('顺延'), q('#snack-msg').textContent);

  section('里程碑计划日期晚于任务计划完成时间：数据体检能发现，且一键修复能改回来');
  const lateTaskId2 = 'p15_late_task2';
  await S.Repo.upsert('task', { id: lateTaskId2, work: wid1, title: 'P15体检测试任务', status: 'todo', plan_date: '2026-09-01', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p15_late_ms2', task: lateTaskId2, plan_date: '2026-09-15', deliverable: 'P15体检交付物', report_level: 'section', done: '0' });
  const hc = S.healthCheck();
  ok('体检发现了这条里程碑晚于任务计划完成时间的问题', hc.issues.some(i => i.k === 'msLateThanTask' && i.n >= 1));
  await S.fixHealth('msLateThanTask');
  const fixedTask2 = S.byId('task', lateTaskId2);
  ok('一键修复后任务计划完成时间顺延到了里程碑日期', fixedTask2.plan_date === '2026-09-15', fixedTask2.plan_date);
  const hcAfter = S.healthCheck();
  ok('修复后体检问题消失了', !hcAfter.issues.some(i => i.k === 'msLateThanTask'));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
