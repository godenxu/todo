/* P24：本轮改动测试——图表页"按里程碑"（原"里程碑甘特"）重构
   1) tab 改名"按里程碑"
   2) 树状展开：职责 -> 工作 -> 任务，叶子（任务）才是真正的甘特时间线，不再是"按工作"合并展示
   3) "里程碑完成情况分布"从"按任务"tab 移到了这里
   4) "看数据表"切换（原来就有的功能）仍然正常
   用法：node test/test-p24.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const render = tab => { S.setPage('charts'); if (tab) S.ACTIONS['chart-tab']({ k: tab }); else S.renderCharts(); return q('#page-charts').innerHTML; };

async function main() {
  await tick(60);

  section('准备数据：两个职责，每个职责下一项工作，每项工作下两条任务，任务各自挂里程碑');
  await S.Repo.upsert('duty', { code: 'P24A', name: 'P24职责甲' });
  await S.Repo.upsert('duty', { code: 'P24B', name: 'P24职责乙' });
  await S.Repo.upsert('work', { id: 'w_p24a', duty: 'P24A', code: '01', name: 'P24工作甲', owner: '测试管理员' });
  await S.Repo.upsert('work', { id: 'w_p24b', duty: 'P24B', code: '01', name: 'P24工作乙', owner: '测试管理员' });
  await S.Repo.upsert('task', { id: 'p24_ta1', work: 'w_p24a', code: '0101', title: 'P24任务甲一', status: 'todo', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('task', { id: 'p24_ta2', work: 'w_p24a', code: '0102', title: 'P24任务甲二', status: 'todo', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('task', { id: 'p24_tb1', work: 'w_p24b', code: '0101', title: 'P24任务乙一', status: 'todo', owner: '测试管理员', assignees: [] });
  // 甲一：一个已完成、一个未完成的里程碑；甲二：没有里程碑（不该出现在树里）；乙一：一个逾期未完成的里程碑
  await S.Repo.upsert('milestone', { id: 'p24_ms1', task: 'p24_ta1', plan_date: S.offsetDate(-3), deliverable: 'P24交付物1', report_level: 'section', done: '1' });
  await S.Repo.upsert('milestone', { id: 'p24_ms2', task: 'p24_ta1', plan_date: S.offsetDate(10), deliverable: 'P24交付物2', report_level: 'section', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p24_ms3', task: 'p24_tb1', plan_date: S.offsetDate(-20), deliverable: 'P24交付物3（逾期）', report_level: 'section', done: '0' });
  const tasksNow = S.visibleTasks().filter(t => !t.deleted_at);

  section('msTreeGroups：分组结构正确性');
  const { msByTask, byDutyWork } = S.msTreeGroups(tasksNow);
  ok('有里程碑的任务才出现在 msByTask 里', msByTask.has('p24_ta1') && msByTask.has('p24_tb1') && !msByTask.has('p24_ta2'));
  ok('P24职责甲下有 w_p24a 这项工作', byDutyWork.has('P24A') && byDutyWork.get('P24A').has('w_p24a'));
  ok('w_p24a 下只有 p24_ta1 这一条任务（p24_ta2 没有里程碑，不出现）',
    byDutyWork.get('P24A').get('w_p24a').length === 1 && byDutyWork.get('P24A').get('w_p24a')[0].id === 'p24_ta1');
  ok('P24职责乙下有 w_p24b，下面是 p24_tb1', byDutyWork.get('P24B').get('w_p24b')[0].id === 'p24_tb1');
  ok('里程碑按计划日期升序排列', msByTask.get('p24_ta1')[0].id === 'p24_ms1' && msByTask.get('p24_ta1')[1].id === 'p24_ms2');

  section('图表页"按里程碑"：默认折叠，逐级展开能看到正确的完成数/总数统计');
  let h = render('gantt');
  ok('tab 标签是"按里程碑"', S.CHART_TABS.find(t => t.key === 'gantt').label === '按里程碑');
  ok('面板标题改成了"里程碑甘特图"', h.includes('里程碑甘特图'));
  ok('渲染了职责级别的行', h.includes('P24A') || h.includes('P24职责甲'));
  ok('职责折叠状态下自己就聚合展示了跨度条/圆点', h.includes('gantt-span') && h.includes('gantt-pt'));
  // 展开 P24A 这个职责
  S.ACTIONS['ms-duty-toggle']({ code: 'P24A' });
  h = q('#page-charts').innerHTML;
  ok('展开职责后能看到工作级别的行', h.includes('P24工作甲'));
  ok('工作级别行上显示的完成数是 1/2（甲一的两条里程碑，一条完成一条没完成）',
    new RegExp(`P24工作甲[\\s\\S]{0,60}1/2`).test(h) || h.includes('1/2'));
  ok('工作折叠状态下自己聚合展示跨度条/圆点', h.includes('gantt-span') && h.includes('gantt-pt'));
  ok('还没展开到工作层级之前看不到任务名', !h.includes('P24任务甲一'));
  // 展开 w_p24a 这项工作
  S.ACTIONS['ms-work-toggle']({ id: 'w_p24a' });
  h = q('#page-charts').innerHTML;
  ok('展开工作后能看到任务级别的甘特行（带编号前缀 0101 P24任务甲一）', h.includes('0101 P24任务甲一'));
  ok('没有里程碑的 P24任务甲二 不会出现在树里', !h.includes('P24任务甲二'));
  ok('任务行上有跨度条和圆点', h.includes('gantt-span') && h.includes('gantt-pt'));

  section('"展开到工作层"：展开所有职责但不展开工作，工作行自己聚合展示');
  S.ACTIONS['ms-collapse-all']();
  S.ACTIONS['ms-expand-to-work']();
  h = q('#page-charts').innerHTML;
  ok('两个职责都展开了（能看到两项工作）', h.includes('P24工作甲') && h.includes('P24工作乙'));
  ok('展开状态：两个职责都在 msDutyExpanded 里', S.msDutyExpanded.has('P24A') && S.msDutyExpanded.has('P24B'));
  ok('展开状态：msWorkExpanded 是空的（工作没有展开）', S.msWorkExpanded.size === 0);
  ok('看不到任务名（还没展开到任务层级）', !h.includes('P24任务甲一') && !h.includes('P24任务乙一'));
  ok('工作行自己聚合展示了跨度条/圆点', h.includes('gantt-span') && h.includes('gantt-pt'));
  S.ACTIONS['ms-collapse-all']();

  section('"里程碑完成情况分布"已经从"按任务"移到"按里程碑"里');
  const taskTabHtml = render('task');
  ok('"按任务"tab 里已经没有这个面板了', !taskTabHtml.includes('里程碑完成情况分布'));
  const ganttTabHtml = render('gantt');
  ok('"按里程碑"tab 里有这个面板', ganttTabHtml.includes('里程碑完成情况分布'));
  const msPie = S.msCompletionPie(tasksNow);
  ok('饼图统计：至少有一条逾期未完成（P24交付物3）', msPie.find(x => x.label === '逾期未完成').n >= 1);
  ok('饼图统计：至少有一条已完成（P24交付物1）', msPie.find(x => x.label === '已完成').n >= 1);

  section('新增："交付物呈报层级分布"面板（按最高呈报层级分类统计）');
  // p24_ms1 是 section（种子数据默认），补两条不同层级的里程碑方便断言分类是否正确
  await S.Repo.upsert('milestone', { id: 'p24_ms5', task: 'p24_ta2', plan_date: S.offsetDate(3), deliverable: 'P24交付物5（部门级）', report_level: 'department', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p24_ms6', task: 'p24_tb1', plan_date: S.offsetDate(8), deliverable: 'P24交付物6（行级）', report_level: 'bank', done: '0' });
  const tasksNow2 = S.visibleTasks().filter(t => !t.deleted_at);
  const levelStats = S.msReportLevelStats(tasksNow2);
  ok('三个层级都统计到了', levelStats.map(s => s.label).join('/') === '处室领导/部门领导/行领导', levelStats.map(s => s.label));
  ok('部门领导那一档至少有 1 条（P24交付物5）', levelStats.find(s => s.label === '部门领导').n >= 1);
  ok('行领导那一档至少有 1 条（P24交付物6）', levelStats.find(s => s.label === '行领导').n >= 1);
  ok('没填 report_level 的按处室领导算，至少覆盖前面几条种子里程碑', levelStats.find(s => s.label === '处室领导').n >= 1);
  h = render('gantt');
  ok('渲染了"交付物呈报层级分布"面板', h.includes('交付物呈报层级分布'));
  ok('这个面板跟"里程碑完成情况分布"是两个不同面板（各自饼图不冲突）',
    h.indexOf('里程碑完成情况分布') < h.indexOf('交付物呈报层级分布') && h.indexOf('交付物呈报层级分布') < h.indexOf('里程碑甘特图'));
  ok('有独立的"看数据表"切换（msLevel）', h.includes('data-act="chart-view" data-id="msLevel"'));
  S.ACTIONS['chart-view']({ id: 'msLevel' });
  h = q('#page-charts').innerHTML;
  ok('切到数据表能看到三个层级的行', h.includes('处室领导') && h.includes('部门领导') && h.includes('行领导'));
  S.ACTIONS['chart-view']({ id: 'msLevel' });

  section('"看数据表"切换（原有功能）在改名/重构之后仍然正常');
  h = render('gantt');
  ok('有"看数据表"切换按钮', h.includes('data-act="chart-view" data-id="gantt"'));
  S.ACTIONS['chart-view']({ id: 'gantt' });
  h = q('#page-charts').innerHTML;
  ok('切到数据表视图后是表格（含"任务"这一列表头）', h.includes('<table') && h.includes('任务'));
  ok('数据表里能看到具体的交付物内容', h.includes('P24交付物1') || h.includes('P24交付物3（逾期）'));
  S.ACTIONS['chart-view']({ id: 'gantt' });
  h = q('#page-charts').innerHTML;
  ok('切回图表视图后又是树状结构', h.includes('gantt-row-duty') || h.includes('gantt-row'));

  section('回归：ms-expand-all / ms-collapse-all 整体正常工作');
  S.ACTIONS['ms-expand-all']();
  h = q('#page-charts').innerHTML;
  ok('全部展开后两个职责下的任务都看得到', h.includes('P24任务甲一') && h.includes('P24任务乙一'));
  ok('展开状态里两个职责都在', S.msDutyExpanded.has('P24A') && S.msDutyExpanded.has('P24B'));
  ok('展开状态里两项工作都在', S.msWorkExpanded.has('w_p24a') && S.msWorkExpanded.has('w_p24b'));
  S.ACTIONS['ms-collapse-all']();
  h = q('#page-charts').innerHTML;
  ok('全部折叠后任务名都不见了', !h.includes('P24任务甲一') && !h.includes('P24任务乙一'));
  ok('展开状态清空', S.msDutyExpanded.size === 0 && S.msWorkExpanded.size === 0);

  section('职责/工作行完成数与任务行对齐：每一行都恰好有一个 gantt-track（有的画点，有的是空撑开）');
  S.ACTIONS['ms-duty-toggle']({ code: 'P24A' });   // 展开职责，工作行折叠（聚合展示）
  h = q('#page-charts').innerHTML;
  let rowCount = (h.match(/class="gantt-row /g) || []).length;
  let trackCount = (h.match(/class="gantt-track/g) || []).length;
  ok('展开职责、工作折叠时：行数与 track 数一致', rowCount === trackCount, { rowCount, trackCount });
  S.ACTIONS['ms-work-toggle']({ id: 'w_p24a' });   // 再展开工作，出现表头行（无聚合）+ 任务行
  h = q('#page-charts').innerHTML;
  rowCount = (h.match(/class="gantt-row /g) || []).length;
  trackCount = (h.match(/class="gantt-track/g) || []).length;
  ok('展开到工作层（工作表头行本身无聚合点，但补了空 track 撑开对齐）：行数与 track 数仍一致', rowCount === trackCount, { rowCount, trackCount });
  // 表头行的空 track 之前没带 --today，会默认成 0%，导致今天竖线在职责/工作层跟任务层错开、连不成一条直线；
  // 修复后所有 --today 取值必须完全一致
  let todays = [...h.matchAll(/class="gantt-track"[^>]*--today:([\d.]+)%/g)].map(m => +m[1]);
  ok('展开到工作层时：所有 gantt-track 的 --today 取值一致（今天竖线贯穿不错位）',
    todays.length > 0 && todays.every(v => Math.abs(v - todays[0]) < 0.01), todays.slice(0, 8));
  S.ACTIONS['ms-collapse-all']();

  /* P80 起工作台改版：面板改名"我的里程碑时间线"，天生就是按"当前查看的人"筛过的，不再有
     "我的里程碑"这个开关（整个"我的"区本来就该是个人视角，用不着再单独切换"只看我的"）。
     换成靠 dashViewAsPerson（处室/部门领导、管理员才能改）切换在看谁。 */
  section('工作台"我的里程碑时间线"面板：独立一份展开状态，天生按查看的人筛过');
  await S.Repo.upsert('duty', { code: 'P24C', name: 'P24职责丙' });
  await S.Repo.upsert('work', { id: 'w_p24c', duty: 'P24C', code: '01', name: 'P24工作丙', owner: '张三' });
  await S.Repo.upsert('task', { id: 'p24_tc1', work: 'w_p24c', code: '0101', title: 'P24任务丙一', status: 'todo', owner: '张三', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p24_ms4', task: 'p24_tc1', plan_date: S.offsetDate(5), deliverable: 'P24交付物4', report_level: 'section', done: '0' });

  // "各职责/工作推进情况"面板是处室概览的，不受个人视角影响，会无条件显示全部职责，
  // 所以校验"我的里程碑时间线"效果时只能看这个面板自己的一段 HTML，不能看整页。
  // P80 起该面板独占一整行、挪到了"处室概览"标题前，所以往后找到下一个 rep-region-title 为止即可
  const msPanelHtml = h2 => (h2.match(/我的里程碑时间线[\s\S]*?(?=<div class="rep-region-title")/) || [''])[0];

  S.DB.settings.me = '测试管理员';   // '测试管理员' 是种子账号里的 admin，view_others_dashboard 靠 roleAtLeast('admin') 天然放行
  S.setDashViewAsPerson('');
  S.setPage('dashboard'); S.renderDashboard();
  let dh = q('#page-dashboard').innerHTML;
  ok('工作台含"我的里程碑时间线"面板', dh.includes('我的里程碑时间线'));
  // 回归：milestoneTreeHTML 之前把 caret 的 data-act 写死成 ms-duty-toggle/ms-work-toggle，
  // 工作台复用这份 HTML 时点箭头会误触图表页的 action（改的是 msDutyExpanded 然后 renderCharts()，
  // 工作台画面完全没反应）。这里直接断言工作台渲染出来的 caret 用的是 dash- 前缀的 action。
  ok('工作台职责箭头绑定的是 dash-ms-duty-toggle（不是图表页的 ms-duty-toggle）',
    msPanelHtml(dh).includes('data-act="dash-ms-duty-toggle"') && !msPanelHtml(dh).includes('data-act="ms-duty-toggle"'));
  ok('默认看自己：职责丙（张三牵头，不是当前使用者）不出现在甘特面板里',
    !msPanelHtml(dh).includes('P24职责丙') && !msPanelHtml(dh).includes('P24C'));
  ok('默认看自己：自己牵头的职责甲在', msPanelHtml(dh).includes('P24A') || msPanelHtml(dh).includes('P24职责甲'));

  ok('管理员默认就有 view_others_dashboard（走 roleAtLeast(\'admin\') 直通，不用矩阵配）', S.hasPermission('view_others_dashboard'));
  S.ACTIONS['dash-view-as']({}, { value: '张三' });
  ok('切换查看的人之后 dashViewAsPerson 变成了张三', S.dashViewAsPerson === '张三');
  dh = q('#page-dashboard').innerHTML;
  ok('切到张三的视角后能看到属于他的职责丙', msPanelHtml(dh).includes('P24C') || msPanelHtml(dh).includes('P24职责丙'));
  ok('切人时展开状态被清空（避免上一个人展开到的职责/工作在下一个人视角里还留着）',
    S.dashMsDutyExpanded.size === 0 && S.dashMsWorkExpanded.size === 0);
  ok('工作台的展开状态跟图表页那份是独立的两个 Set', S.dashMsDutyExpanded !== S.msDutyExpanded);
  S.ACTIONS['dash-ms-duty-toggle']({ code: 'P24C' });
  ok('工作台展开职责后图表页的展开状态没被牵连', !S.msDutyExpanded.has('P24C'));
  dh = q('#page-dashboard').innerHTML;
  ok('工作台自己展开 P24C 后能看到 P24工作丙', msPanelHtml(dh).includes('P24工作丙'));
  ok('工作台工作行箭头绑定的是 dash-ms-work-toggle（不是图表页的 ms-work-toggle）',
    msPanelHtml(dh).includes('data-act="dash-ms-work-toggle"') && !msPanelHtml(dh).includes('data-act="ms-work-toggle"'));

  S.ACTIONS['dash-view-as']({}, { value: '' });
  ok('切回"本人"，dashViewAsPerson 变回空字符串', S.dashViewAsPerson === '');
  dh = q('#page-dashboard').innerHTML;
  ok('切回本人后甘特面板里职责丙又不见了', !msPanelHtml(dh).includes('P24职责丙') && !msPanelHtml(dh).includes('P24C'));

  S.ACTIONS['dash-view-as']({}, { value: '张三' });   // 切到张三，方便下面"展开到工作层"覆盖到职责丙
  S.ACTIONS['dash-ms-expand-to-work']();
  ok('"展开到工作层"：张三名下的职责丙在展开集合里', S.dashMsDutyExpanded.has('P24C'));
  ok('"展开到工作层"：工作台没有工作被展开', S.dashMsWorkExpanded.size === 0);
  S.ACTIONS['dash-ms-collapse-all']();
  ok('全部折叠后工作台展开状态清空', S.dashMsDutyExpanded.size === 0 && S.dashMsWorkExpanded.size === 0);
  S.ACTIONS['dash-view-as']({}, { value: '' });

  section('工作台"查看"权限门禁：没有 view_others_dashboard 的角色改不了 dashViewAsPerson');
  S.DB.users.push({ name: '测试员工-工作台', role: 'staff', salt: '', hash: '', iterations: 0 });
  const bakMePermCheck = S.DB.settings.me;
  S.DB.settings.me = '测试员工-工作台';
  S.ACTIONS['dash-view-as']({}, { value: '张三' });
  ok('普通员工没有这个权限，dash-view-as 不生效，还是空字符串', S.dashViewAsPerson === '');
  S.DB.settings.me = bakMePermCheck;

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
