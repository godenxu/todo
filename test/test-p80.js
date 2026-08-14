/* P80：工作台大改版——用户反馈"工作台是每位同事登录后展现他关心的内容，或简单了解处室的
   工作"，据此提出并确认了完整方案：
   ① 工作台拆成"我的"（个人视角）+ "处室概览"两区，共用同一份顶部周期（本周/本月/本季/本年
      + 翻期），周二例会照着这页念上周/本月的个人进展。
   ② "我的"区分两层：全量层（我负责的全部工作/任务、里程碑时间线）不随周期变，默认就该看到
      "我手上到底有什么"；周期层（本期完成产出/本期未完成/下期计划）随顶部周期切换。
   ③ 下期计划把"正在推进中的"也算进去：任务看 status==='doing'，里程碑没有这个中间状态，
      改用"这条任务按计划日期排序、前面的都完成了、轮到它还没完成"反推（当时叫
      currentActiveMilestoneIds，返回 milestone id 的 Set；P82 这轮改成 nextMilestoneMap，
      返回 Map<任务id, 里程碑对象>，同一份排序逻辑，"下期计划"改成直接认这条里程碑的
      plan_date 决定归到哪一期，见 dashMyNextPlanLists）。
   ④ 处室/部门领导、管理员能用"查看"下拉切到任意人的"我的"区，不用切账号（新增权限
      view_others_dashboard，默认处室/部门领导 + 管理员）；周期状态不随切人重置。
   ⑤ "处室概览"的统计卡片/人员负荷随周期变（复用 buildReportData 的 periodTasks/peopleStat），
      但"各职责/工作推进情况"沿用全量口径——跟报告页 dutyTree 模块 scope:'all' 是同一个理由，
      也是为了保留 P28 那次"工作台与图表页职责进度条共享同一把标尺"的效果，见 test-p5.js。
      最近动态不随周期（"看看大家都在做什么"是一条时间线，不是回看某一期）。
   test-p3.js/test-p24.js 已经覆盖了大部分渲染层面的行为，这份测试补的是权限矩阵默认值、
   dashPersonTasks/dashViewedPerson 这两个辅助函数本身、以及 nextMilestoneMap 的边界情况。
   用法：node test/test-p80.js */
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
  S.setDashPeriod('week'); S.setDashOffset(0); S.setDashViewAsPerson('');

  /* ================= ①：新权限 view_others_dashboard 的默认矩阵 ================= */
  section('①：★新权限 view_others_dashboard 默认给处室领导/部门领导，员工/组长默认关闭');
  ok('★staff 默认 false', S.DEFAULT_PERMISSION_MATRIX.staff.view_others_dashboard === false);
  ok('★comanager 默认 false', S.DEFAULT_PERMISSION_MATRIX.comanager.view_others_dashboard === false);
  ok('★director（处室领导）默认 true', S.DEFAULT_PERMISSION_MATRIX.director.view_others_dashboard === true);
  ok('★gm（部门领导）默认 true', S.DEFAULT_PERMISSION_MATRIX.gm.view_others_dashboard === true);
  ok('管理员不靠矩阵，走 roleAtLeast(\'admin\') 直通', /function hasPermission\(key\) \{\s*if \(roleAtLeast\('admin'\)\) return true;/.test(html));

  /* ================= ②：dashPersonTasks / dashViewedPerson 辅助函数 ================= */
  section('②：★dashPersonTasks(person)——某个人牵头或参与的全部可见任务');
  await S.Repo.upsert('duty', { code: 'P80D', name: 'P80职责' });
  await S.Repo.upsert('work', { id: 'p80_w', duty: 'P80D', name: 'P80工作', owner: '测试管理员' });
  await S.Repo.upsert('task', { id: 'p80_lead', work: 'p80_w', title: 'P80牵头任务', status: 'todo', owner: 'P80甲', assignees: [] });
  await S.Repo.upsert('task', { id: 'p80_join', work: 'p80_w', title: 'P80参与任务', status: 'todo', owner: '别人', assignees: ['P80甲', '别人乙'] });
  await S.Repo.upsert('task', { id: 'p80_unrelated', work: 'p80_w', title: 'P80无关任务', status: 'todo', owner: '别人', assignees: [] });
  const p80Tasks = S.dashPersonTasks('P80甲');
  ok('★牵头的任务在列表里', p80Tasks.some(t => t.id === 'p80_lead'));
  ok('★参与（不是牵头）的任务也在列表里', p80Tasks.some(t => t.id === 'p80_join'));
  ok('★跟这个人无关的任务不在列表里', !p80Tasks.some(t => t.id === 'p80_unrelated'));
  ok('★传空字符串/undefined 返回空数组，不抛异常', S.dashPersonTasks('').length === 0 && S.dashPersonTasks(undefined).length === 0);

  section('②：★dashViewedPerson()——没权限或没切人时退回看自己');
  S.setDashViewAsPerson('P80甲');
  ok('★管理员切了人、有权限，dashViewedPerson() 返回切换目标', S.dashViewedPerson() === 'P80甲');
  S.DB.users.push({ name: '测试员工-P80', role: 'staff', salt: '', hash: '', iterations: 0 });
  const bakMe80 = S.DB.settings.me;
  S.DB.settings.me = '测试员工-P80';
  ok('★员工没有 view_others_dashboard，哪怕 dashViewAsPerson 里还留着值，也强制退回看自己',
    S.dashViewedPerson() === '测试员工-P80');
  S.DB.settings.me = bakMe80;
  S.setDashViewAsPerson('');

  /* ================= ③：nextMilestoneMap 边界情况（P82 由 currentActiveMilestoneIds 改名） ================= */
  section('③：★nextMilestoneMap——里程碑"最近一个（还没交的）"的判定边界');
  await S.Repo.upsert('task', { id: 'p80_ms_task_all_done', work: 'p80_w', title: 'P80全部完成的任务', status: 'done', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p80_ms_ad1', task: 'p80_ms_task_all_done', plan_date: S.offsetDate(-10), deliverable: 'x', done: '1' });
  await S.Repo.upsert('milestone', { id: 'p80_ms_ad2', task: 'p80_ms_task_all_done', plan_date: S.offsetDate(-5), deliverable: 'y', done: '1' });
  await S.Repo.upsert('task', { id: 'p80_ms_task_none', work: 'p80_w', title: 'P80无里程碑的任务', status: 'todo', owner: '测试管理员', assignees: [] });
  const nextMap = S.nextMilestoneMap();
  ok('★一个任务的里程碑全部完成时，这个任务不会出现在 Map 里（没有"最近一个"了）',
    !nextMap.has('p80_ms_task_all_done'));
  ok('★没有里程碑的任务不会报错、也不会凭空出现在 Map 里',
    !nextMap.has('p80_ms_task_none'));

  section('③：★nextMilestoneMap——没填计划日期的里程碑排最后，不会被误判成"最近一个"');
  await S.Repo.upsert('task', { id: 'p80_ms_task_nodate', work: 'p80_w', title: 'P80日期缺失测试任务', status: 'todo', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p80_ms_nd1', task: 'p80_ms_task_nodate', plan_date: '', deliverable: '没填日期的', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p80_ms_nd2', task: 'p80_ms_task_nodate', plan_date: S.offsetDate(5), deliverable: '填了日期的', done: '0' });
  const nextMap2 = S.nextMilestoneMap();
  const nd = nextMap2.get('p80_ms_task_nodate');
  ok('★取到的是有明确日期的那条，不是没填日期的那条',
    !!nd && nd.id === 'p80_ms_nd2');

  /* ================= ④：处室概览职责推进条沿用全量口径（不随周期变） ================= */
  // P82 这轮：工作台自己的 dashDutyTree（用 dashExpanded/dash-duty-toggle）跟报告页的 dutyTree
  // 内容完全一样，模块选择器里两个一模一样的东西挑花了眼，合并成只留 dutyTree 这一份共享定义，
  // 报告页/工作台都能加。这条断言原来认的是 dashDutyTree 那份，现在改成认唯一剩下的 dutyTree，
  // "用 d.dutyStat/d.workStat（全量口径），不重新按周期筛"这个关键约束没变
  section('④：★"各职责/工作推进情况"（dutyTree 模块，报告页/工作台共用）沿用 d.dutyStat/d.workStat（全量口径，不随周期变）');
  ok('★源码里不再有 dashDutyTree 这份重复定义', !html.includes("key: 'dashDutyTree'"));
  ok('★dutyTree 模块的 html() 用的是 d.dutyStat/d.workStat，不是重新按周期筛一遍',
    /html: d => dutyTreeRowsHTML\(d\.dutyStat, d\.workStat, reportExpanded, 'report-duty-toggle'\)/.test(html));
  ok('★工作台默认编排里放的是 dutyTree（不再是已下线的 dashDutyTree）',
    /modules: \['periodOverallScope', 'periodOverallStatus', 'periodOverallPlan', 'dutyTree', 'recentActivity'\]/.test(html));

  /* ================= ⑤：运行时——切换周期/切人不抛异常，各种边界数据下也不抛异常 ================= */
  section('⑤：★运行时——完整跑一遍新工作台，不同周期粒度、切人、空数据都不抛异常');
  let threw = false;
  try {
    for (const period of ['week', 'month', 'quarter', 'year']) {
      S.ACTIONS['dash-period']({ period });
    }
    S.ACTIONS['dash-view-as']({}, { value: 'P80甲' });
    S.ACTIONS['dash-view-as']({}, { value: '' });
  } catch (e) { threw = true; console.error(e); }
  ok('★切换周期/查看的人不抛异常', threw === false);

  const bak = { d: S.DB.duties, w: S.DB.works, m: S.DB.milestones, t: S.DB.tasks };
  S.DB.duties = []; S.DB.works = []; S.DB.milestones = []; S.DB.tasks = [];
  let threwEmpty = false;
  try { S.setPage('dashboard'); S.renderDashboard(); } catch (e) { threwEmpty = true; console.error(e); }
  ok('★空数据下工作台不抛异常', threwEmpty === false);
  S.DB.duties = bak.d; S.DB.works = bak.w; S.DB.milestones = bak.m; S.DB.tasks = bak.t;

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
