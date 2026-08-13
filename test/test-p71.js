/* P71：用户反馈的两项——
   ① "本期完成进度（含 SPI）"模块里的"已完成"数字，跟"本期已完成任务"清单的条数对不上：
      根因是 periodTasks 对已完成任务的归期判断跟 doneInRange 不是同一套口径——periodTasks 原来
      对 status==='done' 的任务也走"计划日或实际完成日落在本期"，doneInRange 只认实际完成日。
      一条任务提前完成、实际完成日其实落在上一期，但计划日还在本期，就会被 periodTasks 算进本期、
      从而被 statusStat.done 计一次，但 doneInRange（只认实际完成日）里却没有它——两个数字就对不上。
      修法：periodTasks 对已完成任务的归期判断也只认实际完成日，跟 doneInRange 变成同一个口径；
      未完成任务的归期逻辑（计划日/推进中/逾期结转）完全不动。
   ② 任务标记"已完成"（任务页下拉、任务详情弹窗两条路径）时，如果计划完成时间/实际完成时间没填、
      或者名下还有里程碑没勾完成，弹窗提示确认后会一并自动填写/勾选——两条路径共用同一套判断
      （doneAutoFillNeeded/openDoneAutoFillModal），不再各管各的（以前详情弹窗那条路径完全不问，
      日期还悄悄自动补；列表下拉那条路径只问里程碑，不管日期）。不提供"只补日期、不动里程碑"的
      选项，确认就是日期+里程碑一起补齐，避免出现"任务已完成、里程碑却没完成"的矛盾状态。
   用法：node test/test-p71.js */
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

  /* ================= ①：本期完成数字口径统一 ================= */
  section('①：★通用不变量——不管数据长什么样，statusStat.done 必须恒等于 doneInRange.length');
  const { start: wkStart, end: wkEnd } = S.periodRange('week', 0);
  let dd = S.buildReportData('week', 0);
  ok('★种子数据下，"本期完成进度"里的已完成数 === "本期已完成任务"清单条数',
    dd.statusStat.done === dd.doneInRange.length, { done: dd.statusStat.done, doneInRange: dd.doneInRange.length });

  section('①：★复现用户描述的场景——提前完成，计划日在本期、实际完成日却在上一期');
  await S.Repo.upsert('duty', { code: 'P71D', name: 'P71口径验证职责' });
  await S.Repo.upsert('work', { id: 'p71_w', duty: 'P71D', code: 'W1', name: 'P71口径验证工作', owner: '甲', year: new Date().getFullYear() });
  const earlyDoneId = 'p71_early_done';
  await S.Repo.upsert('task', {
    id: earlyDoneId, work: 'p71_w', title: 'P71提前完成任务', status: 'done',
    plan_date: wkStart, actual_date: S.offsetDate(-30), progress: 100, owner: '甲', assignees: [],
  });
  S.rebuildIndex();
  dd = S.buildReportData('week', 0);
  ok('★计划日在本期、但实际完成日在上期的任务，不再被算进本期的 periodTasks',
    !dd.periodTasks.some(t => t.id === earlyDoneId));
  ok('★同理也不在"本期已完成任务"清单里（跟 periodTasks 保持一致，两边不会再对不上）',
    !dd.doneInRange.some(t => t.id === earlyDoneId));
  ok('★加了这条之后，两个数字依然相等（这正是用户反馈要修的那个对不上）',
    dd.statusStat.done === dd.doneInRange.length, { done: dd.statusStat.done, doneInRange: dd.doneInRange.length });

  section('①：反过来——计划日是上期欠账、但实际就是本期完成的，仍然要算进本期（不能矫枉过正）');
  const onTimeDoneId = 'p71_ontime_done';
  await S.Repo.upsert('task', {
    id: onTimeDoneId, work: 'p71_w', title: 'P71按期完成任务（计划日是上期欠账）', status: 'done',
    plan_date: S.offsetDate(-60), actual_date: S.todayStr(), progress: 100, owner: '乙', assignees: [],
  });
  S.rebuildIndex();
  dd = S.buildReportData('week', 0);
  ok('★实际完成日落在本期，哪怕计划日是很久以前欠下的账，一样算进本期 periodTasks',
    dd.periodTasks.some(t => t.id === onTimeDoneId));
  ok('★同样出现在本期已完成清单里', dd.doneInRange.some(t => t.id === onTimeDoneId));
  ok('★数字继续保持一致', dd.statusStat.done === dd.doneInRange.length);

  section('①：回归——未完成任务的归期逻辑（计划日/推进中/逾期结转）完全没被这次改动影响');
  const doingCarryId = 'p71_doing_carry';
  await S.Repo.upsert('task', {
    id: doingCarryId, work: 'p71_w', title: 'P71推进中但计划日在很远的将来', status: 'doing',
    plan_date: S.offsetDate(400), progress: 30, owner: '丙', assignees: [],
  });
  const overdueCarryId = 'p71_overdue_carry';
  await S.Repo.upsert('task', {
    id: overdueCarryId, work: 'p71_w', title: 'P71上期欠账未完成', status: 'todo',
    plan_date: S.offsetDate(-90), progress: 0, owner: '丁', assignees: [],
  });
  S.rebuildIndex();
  dd = S.buildReportData('week', 0);
  ok('★"推进中"哪怕计划日在本期之外，照样算进当期涉及（口径没变）', dd.periodTasks.some(t => t.id === doingCarryId));
  ok('★未完成、计划日是上期欠账的，照样带进本期（口径没变）', dd.periodTasks.some(t => t.id === overdueCarryId));

  /* ================= ②：标记已完成时的自动补全确认 ================= */
  section('②：doneAutoFillNeeded 纯函数——三个条件任一为真就要弹窗');
  ok('计划/实际完成时间都填了、里程碑也都完成了：不需要弹窗', S.doneAutoFillNeeded('2026-08-01', '2026-08-02', 0) === false);
  ok('计划完成时间没填：需要弹窗', S.doneAutoFillNeeded('', '2026-08-02', 0) === true);
  ok('实际完成时间没填：需要弹窗', S.doneAutoFillNeeded('2026-08-01', '', 0) === true);
  ok('还有未完成的里程碑：需要弹窗', S.doneAutoFillNeeded('2026-08-01', '2026-08-02', 2) === true);
  ok('三个条件都占了：当然也要弹窗', S.doneAutoFillNeeded('', '', 3) === true);

  section('②：openDoneAutoFillModal——弹窗内容跟着"缺什么"变化');
  S.openDoneAutoFillModal(true, true, 2, () => {});
  let body = q('#modal-body').innerHTML;
  ok('★计划+实际完成时间都缺时，提示语里两个都提到了', body.includes('计划完成时间') && body.includes('实际完成时间'));
  ok('★提到了会自动填成今天', body.includes(S.todayStr()));
  ok('★有未完成里程碑时，正文里点出了具体数量、并说明会一并标记完成',
    body.includes('2') && body.includes('个里程碑没有标记为完成') && body.includes('一并标记为已完成'));
  ok('★不再提供"不动里程碑、只补日期"这个选项——避免确认完还是"任务已完成、里程碑却没完成"的矛盾状态',
    !body.includes('只补日期') && !S.ACTIONS['status-done-only']);
  ok('★主按钮文案统一是"确定"，不再区分有没有里程碑要处理', q('#modal-ok-btn').textContent === '确定');
  S.closeModal();

  S.openDoneAutoFillModal(false, false, 0, () => {});
  body = q('#modal-body').innerHTML;
  ok('★什么都不缺时不会走到这个弹窗（这里只是单测函数本身）——正文应为空', body.trim() === '');
  S.closeModal();

  S.openDoneAutoFillModal(true, false, 0, () => {});
  body = q('#modal-body').innerHTML;
  ok('★只缺计划完成时间：正文只提计划完成时间，不提实际完成时间', body.includes('计划完成时间') && !body.includes('实际完成时间'));
  S.closeModal();

  section('②：openDoneAutoFillModal——确认后 onConfirm() 不带参数，调用方统一按"日期+里程碑都补齐"处理');
  let confirmed = false;
  S.openDoneAutoFillModal(true, true, 1, () => { confirmed = true; });
  await S.modalCallback();
  ok('★点确定后，回调被触发了', confirmed === true);

  section('②：commitTaskStatus 现在计划完成时间也会一起自动补今天（以前只补实际完成时间）');
  await S.Repo.upsert('duty', { code: 'P71D2', name: 'P71状态测试职责' });
  await S.Repo.upsert('work', { id: 'p71_w2', duty: 'P71D2', code: 'W1', name: 'P71状态测试工作', owner: '甲', year: new Date().getFullYear() });
  const cmTaskId = 'p71_commit_task';
  await S.Repo.upsert('task', { id: cmTaskId, work: 'p71_w2', title: 'P71 commitTaskStatus 测试', status: 'todo', plan_date: '', actual_date: '', progress: 0, owner: '甲', assignees: [] });
  await S.commitTaskStatus(S.byId('task', cmTaskId), 'done', false);
  const cmTask = S.byId('task', cmTaskId);
  ok('★标记已完成后，计划完成时间被自动补成了今天', cmTask.plan_date === S.todayStr());
  ok('实际完成时间同理也被补成了今天', cmTask.actual_date === S.todayStr());

  section('②：spCommitSingle——即使里程碑全部完成，只要日期缺了照样要弹窗（不再只看里程碑）');
  const spNoMsId = 'p71_sp_no_ms';
  await S.Repo.upsert('task', { id: spNoMsId, work: 'p71_w2', title: 'P71下拉测试（无里程碑，日期缺）', status: 'todo', plan_date: '', actual_date: '', progress: 0, owner: '甲', assignees: [] });
  const elMock = q('#tasks-body');
  S.ACTIONS['edit']({ entity: 'task', id: spNoMsId, field: 'status' }, elMock);
  await S.ACTIONS['sp-pick']({ val: 'done' });
  ok('★没有任何里程碑、但计划/实际完成时间都没填，照样弹出确认框', typeof S.modalCallback === 'function' && S.byId('task', spNoMsId).status === 'todo');
  await S.modalCallback();
  await tick();
  ok('确认后计划/实际完成时间都补成了今天', S.byId('task', spNoMsId).plan_date === S.todayStr() && S.byId('task', spNoMsId).actual_date === S.todayStr());
  ok('确认后状态变成已完成', S.byId('task', spNoMsId).status === 'done');

  section('②：openTaskDetail 保存流程——用"即将保存"的表单值判断缺什么，不是用旧的数据库值');
  await S.Repo.upsert('duty', { code: 'P71D3', name: 'P71详情弹窗测试职责' });
  await S.Repo.upsert('work', { id: 'p71_w3', duty: 'P71D3', code: 'W1', name: 'P71详情弹窗测试工作', owner: '甲', year: new Date().getFullYear() });
  const tdTaskId = 'p71_td_task';
  await S.Repo.upsert('task', { id: tdTaskId, work: 'p71_w3', title: 'P71详情弹窗自动补全测试', status: 'todo', plan_date: '', actual_date: '', progress: 0, owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p71_td_ms1', task: tdTaskId, plan_date: '2026-08-01', deliverable: 'P71详情弹窗交付物', report_level: 'section', done: '0' });

  const fakeCpRow = (deliv, checked) => ({
    getAttribute: n => n === 'data-ms-id' ? 'p71_td_ms1' : null,
    querySelector: sel => {
      if (sel === '.cp-date') return { value: '20260801' };
      if (sel === '.cp-deliv') return { value: deliv };
      if (sel === '.cp-chk') return { checked };
      if (sel === '.cp-report-level') return { value: 'section' };
      return null;
    },
  });

  S.openTaskDetail(tdTaskId);
  q('#td-status').value = 'done';
  raw.document.querySelectorAll = sel => sel === '#cp-list [data-cp-row]' ? [fakeCpRow('P71详情弹窗交付物', false)] : [];
  await S.modalCallback();
  ok('★表单里计划/实际完成时间都是空的、里程碑没勾完成：弹出自动补全确认框，没有直接保存',
    typeof S.modalCallback === 'function' && S.byId('task', tdTaskId).status === 'todo');
  ok('确认框正文提到了计划完成时间和实际完成时间都缺', q('#modal-body').innerHTML.includes('计划完成时间') && q('#modal-body').innerHTML.includes('实际完成时间'));
  ok('确认框正文提到了 1 个里程碑没完成', q('#modal-body').innerHTML.includes('1') && q('#modal-body').innerHTML.includes('个里程碑没有标记为完成'));
  await S.modalCallback();
  await tick();
  const tdSaved = S.byId('task', tdTaskId);
  ok('★确认后任务变成已完成', tdSaved.status === 'done');
  ok('★计划完成时间自动补成了今天', tdSaved.plan_date === S.todayStr());
  ok('★实际完成时间自动补成了今天', tdSaved.actual_date === S.todayStr());
  ok('★里程碑也一并被标记完成了', S.byId('milestone', 'p71_td_ms1').done === '1');
  raw.document.querySelectorAll = () => [];

  section('②：openTaskDetail——用户刚在表单里把日期填上、里程碑勾完，即使旧数据库记录里还缺，也不该再弹窗');
  const tdTaskId2 = 'p71_td_task2';
  await S.Repo.upsert('task', { id: tdTaskId2, work: 'p71_w3', title: 'P71详情弹窗——表单已经补齐', status: 'todo', plan_date: '', actual_date: '', progress: 0, owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p71_td_ms2', task: tdTaskId2, plan_date: '2026-08-01', deliverable: 'P71详情弹窗交付物2', report_level: 'section', done: '0' });
  S.openTaskDetail(tdTaskId2);
  q('#td-status').value = 'done';
  q('#td-plan_date').value = '20260901';
  q('#td-actual_date').value = '20260901';
  raw.document.querySelectorAll = sel => sel === '#cp-list [data-cp-row]' ? [fakeCpRow('P71详情弹窗交付物2', true)] : [];
  await S.modalCallback();
  await tick();
  ok('★表单里该填的都填了、里程碑也勾完了：直接保存成功，不会再弹自动补全确认框',
    S.byId('task', tdTaskId2).status === 'done' && S.byId('task', tdTaskId2).plan_date === '2026-09-01');
  raw.document.querySelectorAll = () => [];

  section('②：openTaskDetail——任务本来就已经是"已完成"，这次只是改别的字段，不该重新弹自动补全框');
  const tdTaskId3 = 'p71_td_task3';
  await S.Repo.upsert('task', { id: tdTaskId3, work: 'p71_w3', title: 'P71已完成任务改标题', status: 'done', plan_date: S.todayStr(), actual_date: S.todayStr(), progress: 100, owner: '测试管理员', assignees: [] });
  S.openTaskDetail(tdTaskId3);
  // 测试用的 DOM 桩不会像真浏览器那样自动把 value="..." 属性回显到 .value 上（select 的 selected 也一样），
  // 这里手动把这次不打算改的字段维持成原值，只改标题——否则 readControl 会把它们读成空/0，
  // 连带触发 reconcileStatusAndProgress 里"进度不到 100 却状态是已完成"的降级分支，跟这次要测的东西无关
  q('#td-status').value = 'done';
  q('#td-progress').value = '100';
  q('#td-plan_date').value = S.todayStr().replace(/-/g, '');
  q('#td-actual_date').value = S.todayStr().replace(/-/g, '');
  q('#td-title').value = 'P71已完成任务改标题（改过了）';
  raw.document.querySelectorAll = () => [];
  await S.modalCallback();
  await tick();
  ok('★没有弹自动补全确认框，标题直接改掉了', S.byId('task', tdTaskId3).title === 'P71已完成任务改标题（改过了）');
  ok('状态还是已完成，日期没被莫名其妙改动', S.byId('task', tdTaskId3).status === 'done' && S.byId('task', tdTaskId3).actual_date === S.todayStr());

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
