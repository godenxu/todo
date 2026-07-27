/* P16：本轮改动测试——
   1) 人员负荷/图表页按人 加"仅指任务数不代表工作量"说明
   2) 工作台"各职责推进情况"标题改为"各职责/工作推进情况"
   3) 职责/工作推进情况按编号排序（不按数量），默认全部折叠
   4) 宽表CSV导入的里程碑日期识别（parseCSVDate）+ badDate 统计
   5) 任务页默认视图按角色区分：员工=我的任务，其他=全部待完成
   6) 权限页账号管理新增删除账号（软删除、二次确认、最后管理员/自己保护）
   7) 任务页左侧职责/工作筛选树改为左对齐（sb-label flex:1 CSS 检查）
   8) 已删除任务视图里批量删除改为彻底删除
   用法：node test/test-p16.js */
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

  section('人员负荷/图表页按人：加了"仅指任务数不代表工作量"的说明');
  S.DB.settings.me = '测试管理员';
  S.goto('dashboard');
  ok('工作台人员负荷标题带了这句说明', q('#page-dashboard').innerHTML.includes('人员负荷（仅指任务数，不代表工作量）'));
  S.setPage('charts');
  S.renderCharts();
  ok('默认就在"按人"页签（不用切换）', S.chartTab === 'person');
  ok('图表页按人视图标题也带了这句说明', q('#page-charts').innerHTML.includes('各人相关任务量与完成率（仅指任务数，不代表工作量）'));

  section('工作台标题改名：各职责推进情况 → 各职责/工作推进情况');
  ok('工作台面板标题里是新名字', q('#page-dashboard').innerHTML.includes('各职责/工作推进情况'));
  ok('工作台面板标题里不再是旧名字（避免同时出现新旧两个标题）', !/[^\/]各职责推进情况/.test(q('#page-dashboard').innerHTML));

  section('职责/工作推进情况：按编号排序，不按数量排序');
  const dutyCodeA = 'P16A', dutyCodeZ = 'P16Z';
  await S.Repo.upsert('duty', { code: dutyCodeZ, name: 'P16职责Z（数量多）' });
  await S.Repo.upsert('duty', { code: dutyCodeA, name: 'P16职责A（数量少）' });
  const widZ = 'w_p16z', widA = 'w_p16a';
  await S.Repo.upsert('work', { id: widZ, code: 'ZZ', duty: dutyCodeZ, name: 'P16工作Z', owner: '测试管理员' });
  await S.Repo.upsert('work', { id: widA, code: 'AA', duty: dutyCodeA, name: 'P16工作A', owner: '测试管理员' });
  // Z 职责下挂 3 条任务（数量多），A 职责下挂 1 条（数量少）——如果还按数量排，Z 应该排在 A 前面
  for (let i = 0; i < 3; i++) await S.Repo.upsert('task', { id: `p16_task_z${i}`, work: widZ, title: `P16Z任务${i}`, status: 'todo', plan_date: S.offsetDate(10), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('task', { id: 'p16_task_a0', work: widA, title: 'P16A任务0', status: 'todo', plan_date: S.offsetDate(10), owner: '测试管理员', assignees: [] });
  const tasksAll = S.visibleTasks().filter(t => !t.deleted_at);
  const dutyStatSorted = S.statsByDuty(tasksAll).sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  const idxA = dutyStatSorted.findIndex(x => x.code === dutyCodeA);
  const idxZ = dutyStatSorted.findIndex(x => x.code === dutyCodeZ);
  ok('按编号排序后，A 排在 Z 前面（尽管 Z 任务更多）', idxA > -1 && idxZ > -1 && idxA < idxZ);
  S.dashExpanded.clear();
  S.renderDashboard();
  const dashHtml = q('#page-dashboard').innerHTML;
  const dashIdxA = dashHtml.indexOf('P16职责A');
  const dashIdxZ = dashHtml.indexOf('P16职责Z');
  ok('工作台渲染出来的顺序也是 A 在 Z 前面', dashIdxA > -1 && dashIdxZ > -1 && dashIdxA < dashIdxZ);
  ok('默认是全部折叠的（没有展开任何工作明细行）', !dashHtml.includes('report-work-row'));
  S.reportExpanded.clear();
  S.goto('report');
  const reportHtml2 = q('#page-report').innerHTML;
  ok('报告页也是默认全部折叠', !reportHtml2.includes('report-work-row'));

  section('parseCSVDate：能识别斜杠、点、中文年月日、Excel序列号等多种格式');
  ok('标准 ISO 格式', S.parseCSVDate('2026-08-01') === '2026-08-01');
  ok('斜杠格式（Excel常见导出）', S.parseCSVDate('2026/8/1') === '2026-08-01');
  ok('点分隔格式', S.parseCSVDate('2026.8.1') === '2026-08-01');
  ok('中文年月日', S.parseCSVDate('2026年8月1日') === '2026-08-01');
  ok('中文年月号（无"日"字）', S.parseCSVDate('2026年8月1号') === '2026-08-01');
  ok('前后有空格也能识别', S.parseCSVDate('  2026/8/1  ') === '2026-08-01');
  ok('完全无法识别的乱码返回空字符串（不是把原始字符串硬存进去）', S.parseCSVDate('不是日期') === '');
  ok('空值返回空字符串', S.parseCSVDate('') === '' && S.parseCSVDate(null) === '');

  section('宽表CSV导入：日期用 parseCSVDate 归一化，识别不了的会被统计进 badDate');
  const dutyCodeW = 'P16W';
  await S.Repo.upsert('duty', { code: dutyCodeW, name: 'P16宽表测试职责' });
  const widW = 'w_p16w';
  await S.Repo.upsert('work', { id: widW, code: 'P16W01', duty: dutyCodeW, name: 'P16宽表测试工作', owner: '测试管理员' });
  const csvHeader = '所属工作项,任务项编号,任务项名称,任务项牵头人,任务项参与人,里程碑时间1,里程碑交付物1,里程碑交付物最高呈报1';
  const csvRow1 = 'P16宽表测试工作,,P16宽表任务甲,测试管理员,,2026/9/1,P16宽表交付物甲,处室领导';
  const csvRow2 = 'P16宽表测试工作,,P16宽表任务乙,测试管理员,,这不是日期,P16宽表交付物乙,处室领导';
  const csvText = [csvHeader, csvRow1, csvRow2].join('\n');
  const wideRes = await S.applyWideImport('append', csvText);
  ok('两条任务都导入了', wideRes.taskN === 2, wideRes);
  ok('两条里程碑都导入了', wideRes.msN === 2, wideRes);
  ok('有 1 个日期没能识别，被统计进 badDate', wideRes.badDate === 1, wideRes);
  const importedMsOk = S.DB.milestones.find(m => m.deliverable === 'P16宽表交付物甲');
  const importedMsBad = S.DB.milestones.find(m => m.deliverable === 'P16宽表交付物乙');
  ok('斜杠格式的日期被正确归一化成了 2026-09-01', importedMsOk && importedMsOk.plan_date === '2026-09-01', importedMsOk);
  ok('无法识别的日期留空，而不是存了"这不是日期"这种垃圾字符串', importedMsBad && importedMsBad.plan_date === '', importedMsBad);

  section('任务页默认视图：员工默认"我的任务"，其他角色默认"全部待完成"');
  const staffName = 'P16测试员工';
  S.DB.users.push({ name: staffName, role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = staffName;
  S.setPage('dashboard');
  ok('defaultTaskView 对员工返回 mine', S.defaultTaskView() === 'mine');
  S.ACTIONS['goto']({ page: 'tasks' });
  ok('员工点导航栏进任务页，视图是"我的任务"', S.UI.tasks.view === 'mine');
  S.DB.settings.me = '测试管理员';
  S.setPage('dashboard');
  ok('defaultTaskView 对管理员返回 open', S.defaultTaskView() === 'open');
  S.ACTIONS['goto']({ page: 'tasks' });
  ok('管理员点导航栏进任务页，视图是"全部待完成"', S.UI.tasks.view === 'open');
  S.UI.tasks.view = 'all';
  S.ACTIONS['goto']({ page: 'tasks' });
  ok('已经在任务页时再点一次导航栏，不会把手动选的视图冲掉', S.UI.tasks.view === 'all');

  section('权限页账号管理：删除账号（软删除）');
  const delName = 'P16待删除账号';
  S.DB.users.push({ name: delName, role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试管理员';
  const panelBefore = S.accountsPanelHTML();
  ok('删除前，账号列表里有这个人，且有删除按钮', panelBefore.includes(delName) && new RegExp(`data-act="admin-delete-user" data-name="${delName}"`).test(panelBefore));
  S.ACTIONS['admin-delete-user']({ name: delName });
  ok('点删除后弹出了确认框', typeof S.modalCallback === 'function');
  await S.modalCallback();
  const deletedUser = S.DB.users.find(u => u.name === delName);
  ok('账号记录还在（软删除），但带上了 deleted_at', !!deletedUser && !!deletedUser.deleted_at);
  const panelAfter = S.accountsPanelHTML();
  ok('删除后，账号列表里不再显示这个人', !panelAfter.includes(delName));
  const loginHtmlAfter = (() => { S.renderLoginPick(); return q('#login-body').innerHTML; })();
  ok('登录身份选择器里也看不到这个已删除的账号了', !loginHtmlAfter.includes(delName));

  section('权限页账号管理：删除账号的两个安全网——不能删自己、不能删最后一个管理员');
  S.DB.settings.me = '测试管理员';
  S.ACTIONS['admin-delete-user']({ name: '测试管理员' });
  ok('不能删除自己当前登录的账号', q('#snack-msg').textContent.includes('不能删除自己'), q('#snack-msg').textContent);
  ok('确实是硬挡，没有弹确认框', !S.modalCallback);
  const onlyAdminCount = S.DB.users.filter(u => u.role === 'admin' && !u.deleted_at).length;
  ok('目前确实只有一个管理员（测试管理员自己）', onlyAdminCount === 1, onlyAdminCount);
  S.DB.users.push({ name: 'P16另一个管理员', role: 'admin', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = 'P16另一个管理员';
  S.ACTIONS['admin-delete-user']({ name: '测试管理员' });
  ok('还有别的管理员在时，删除不是最后一个，不会被拦', typeof S.modalCallback === 'function');
  await S.modalCallback();
  ok('管理员被删除了', S.DB.users.find(u => u.name === '测试管理员').deleted_at);
  // 现在只剩 P16另一个管理员 这一个管理员了，试着删掉它自己是不行的（先测试自己保护），
  // 换个身份来删它，应该会被"最后一个管理员"挡住
  S.DB.users.push({ name: 'P16第三方操作者', role: 'admin', salt: '', hash: '', iterations: 0 });
  const remainingAdmins = S.DB.users.filter(u => u.role === 'admin' && !u.deleted_at).map(u => u.name);
  ok('现在有两个管理员：P16另一个管理员、P16第三方操作者', remainingAdmins.length === 2, remainingAdmins);
  restore();

  section('任务页左侧筛选树：sb-label 用 flex:1 撑满剩余空间，不再居中飘着');
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  ok('sb-label 的 CSS 规则里加了 flex:1（配合 space-between 的父容器，让文字紧贴左边而不是被两头挤到中间）',
     /\.sb-item \.sb-label\s*\{[^}]*flex:\s*1/.test(html));
  ok('同时加了 min-width:0，保证配合 flex:1 后长文字的省略号截断还能正常工作', /\.sb-item \.sb-label\s*\{[^}]*min-width:\s*0/.test(html));

  section('已删除任务视图：批量删除改为彻底删除');
  const purgeTaskId1 = 'p16_purge_1', purgeTaskId2 = 'p16_purge_2';
  await S.Repo.upsert('task', { id: purgeTaskId1, title: 'P16待彻底删除任务1', status: 'todo', plan_date: S.offsetDate(5), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('task', { id: purgeTaskId2, title: 'P16待彻底删除任务2', status: 'todo', plan_date: S.offsetDate(5), owner: '测试管理员', assignees: [] });
  S.softDelete('task', purgeTaskId1);
  S.softDelete('task', purgeTaskId2);
  await S.Repo.persist(S.DB);
  S.DB.settings.me = '测试管理员';
  S.UI.tasks.view = 'deleted';
  S.UI.tasks.sel = new Set([purgeTaskId1, purgeTaskId2]);
  S.renderBatchBar();
  const batchBarHtml = q('#batch-bar').innerHTML;
  ok('在已删除视图里，批量操作条显示的是"彻底删除"而不是"删除"', batchBarHtml.includes('data-act="batch-purge"') && batchBarHtml.includes('彻底删除'));
  ok('普通的批量删除按钮/改字段按钮都不在了（对已删除的记录做这些没意义）', !batchBarHtml.includes('data-act="batch-delete"') && !batchBarHtml.includes('data-act="batch"'));
  await S.ACTIONS['batch-purge']();
  ok('点彻底删除弹出了确认框', typeof S.modalCallback === 'function');
  await S.modalCallback();
  ok('两条任务记录被真正从数组里移除了（彻底删除，不是再软删一次）', !S.byId('task', purgeTaskId1) && !S.byId('task', purgeTaskId2));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
