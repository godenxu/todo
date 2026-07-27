/* P21：本轮改动测试——
   1) 工作台"人员负荷"分段顺序改为：已完成/进行中/逾期/未开始
   2) 连接共享文件夹提示框去掉"浏览器安全限制...断开重连"这段文案
   3) 任务详情里程碑：拖动手柄+任意位置插入 按钮、保存前顺序合理性校验、编辑期间实时进度预览（保存前不写回 t.progress）
   4) 任务页状态字段改为点击下拉选择；选"已完成"且里程碑未全部完成时，弹窗询问是否一并标记完成
   5) 去掉任务编号前的一键打勾完成列
   6) 任务详情弹窗进度字段加"%"，进度与实际完成之间加"已完成"按钮
   用法：node test/test-p21.js */
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

  section('人员负荷：分段顺序改为 已完成/进行中/逾期/未开始');
  const dutyCode = 'P21LOAD';
  await S.Repo.upsert('duty', { code: dutyCode, name: 'P21负荷测试职责' });
  const wid = 'w_p21load';
  await S.Repo.upsert('work', { id: wid, duty: dutyCode, name: 'P21负荷测试工作', owner: '测试管理员' });
  const owner = 'P21负荷测试人';
  await S.Repo.upsert('task', { id: 'p21_load_done', work: wid, title: 'P21已完成', status: 'done', plan_date: S.offsetDate(-1), actual_date: S.todayStr(), owner, assignees: [] });
  await S.Repo.upsert('task', { id: 'p21_load_doing', work: wid, title: 'P21进行中', status: 'doing', plan_date: S.offsetDate(10), owner, assignees: [] });
  await S.Repo.upsert('task', { id: 'p21_load_late', work: wid, title: 'P21逾期', status: 'todo', plan_date: S.offsetDate(-3), owner, assignees: [] });
  await S.Repo.upsert('task', { id: 'p21_load_todo', work: wid, title: 'P21未开始', status: 'todo', plan_date: S.offsetDate(10), owner, assignees: [] });
  S.setPage('dashboard'); S.renderDashboard();
  const dashH = q('#page-dashboard').innerHTML;
  const rowMatch = new RegExp(`data-owner="${owner}"[\\s\\S]{0,600}?</div>`).exec(dashH);
  ok('找到了这一行人员负荷', !!rowMatch);
  if (rowMatch) {
    const row = rowMatch[0];
    const order = [...row.matchAll(/class="seg (seg-\w+)"/g)].map(m => m[1]);
    ok('四段顺序是 done, doing, late, todo', order.join(',') === 'seg-done,seg-doing,seg-late,seg-todo', order);
  }

  section('连接共享文件夹提示框：不再有"浏览器安全限制...断开重连"这段文案');
  const bakShareConfig = S.DB.shareConfig;
  S.DB.shareConfig = { pathTemplate: 'A{工号}B{工号}C', fileName: 'x.json' };
  S.DB.settings.me = '测试管理员';
  const admin = S.DB.users.find(u => u.name === '测试管理员');
  const bakJobNo = admin.jobNo;
  admin.jobNo = '20260011';
  S.confirmConnectWithHint(() => {});
  const hintHTML = q('#modal-body').innerHTML;
  ok('提示框里还是有路径', hintHTML.includes('A20260011B20260011C'));
  ok('不再包含"安全限制"这几个字', !hintHTML.includes('安全限制'));
  ok('不再包含"断开重连"这几个字', !hintHTML.includes('断开重连'));
  admin.jobNo = bakJobNo;
  S.DB.shareConfig = bakShareConfig;
  S.ACTIONS['modal-cancel']();

  section('里程碑：新增拖动手柄和"在这条下面插入一条"按钮');
  const rowHtml = S.cpRowHTML(null);
  ok('每行都有拖动手柄', rowHtml.includes('cp-drag-handle') && rowHtml.includes('draggable="true"'));
  ok('每行都有插入按钮', rowHtml.includes('data-act="cp-insert-after"'));
  ok('删除按钮还在', rowHtml.includes('data-act="cp-remove-row"'));

  section('里程碑：保存前的顺序合理性校验（纯函数）');
  ok('顺序正常时不报问题', S.findCpOrderIssue([
    { plan_date: '2026-01-01' }, { plan_date: '2026-02-01' }, { plan_date: '2026-03-01' },
  ]) === '');
  const issue = S.findCpOrderIssue([
    { plan_date: '2026-03-01' }, { plan_date: '2026-01-01' },
  ]);
  ok('第一条比第二条晚，判定为不合理', issue.includes('第 1 条') && issue.includes('第 2 条'), issue);
  ok('没填日期的行不参与比较（跳过继续看后面）', S.findCpOrderIssue([
    { plan_date: '2026-01-01' }, { plan_date: '' }, { plan_date: '2026-02-01' },
  ]) === '');

  section('里程碑：编辑期间实时进度预览，不直接写回 t.progress');
  const dutyCode2 = 'P21MS';
  await S.Repo.upsert('duty', { code: dutyCode2, name: 'P21里程碑测试职责' });
  const wid2 = 'w_p21ms';
  await S.Repo.upsert('work', { id: wid2, duty: dutyCode2, name: 'P21里程碑测试工作', owner: '测试管理员' });
  const taskId = 'p21_ms_task';
  await S.Repo.upsert('task', { id: taskId, work: wid2, title: 'P21里程碑测试任务', status: 'todo', plan_date: S.offsetDate(30), progress: 0, owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p21_ms1', task: taskId, plan_date: '2026-08-01', deliverable: 'P21交付物1', report_level: 'section', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p21_ms2', task: taskId, plan_date: '2026-09-01', deliverable: 'P21交付物2', report_level: 'section', done: '0' });
  // 返回稳定的 checkbox 对象引用（而不是每次 querySelector 都现造一个新对象），
  // 这样 cp-mark-all-done 之类的动作把 .checked 设成 true 之后，测试这边才能看到同一个对象的变化
  const fakeCpRow = done => {
    const cb = { checked: done };
    return { querySelector: sel => sel === '.cp-chk' ? cb : null };
  };
  raw.document.querySelectorAll = sel => sel === '#cp-list [data-cp-row]' ? [fakeCpRow(true), fakeCpRow(false)] : [];
  S.updateCpProgressPreview();
  ok('进度预览文本显示了 1/2 已完成（50%）', q('#cp-progress-preview').textContent.includes('1/2') && q('#cp-progress-preview').textContent.includes('50%'), q('#cp-progress-preview').textContent);
  ok('保存之前，真实的 t.progress 没有被这次预览悄悄改掉', S.byId('task', taskId).progress === 0);
  raw.document.querySelectorAll = () => [];

  section('里程碑：保存时顺序不合理会先弹确认框，确认后才真的保存');
  S.DB.settings.me = '测试管理员';
  S.openTaskDetail(taskId);
  const fakeRow = (date, deliv) => ({
    querySelector: sel => {
      if (sel === '.cp-date') return { value: date };
      if (sel === '.cp-deliv') return { value: deliv };
      if (sel === '.cp-chk') return { checked: false };
      if (sel === '.cp-report-level') return { value: 'section' };
      return null;
    },
  });
  raw.document.querySelectorAll = sel => sel === '#cp-list [data-cp-row]'
    ? [fakeRow('2026-09-01', 'P21后一条但日期早'), fakeRow('2026-08-01', 'P21前一条但日期晚')] : [];
  await S.modalCallback();
  ok('顺序不合理时弹出了确认框，而不是直接保存', typeof S.modalCallback === 'function');
  ok('确认框标题提到了顺序问题', q('#modal-title').textContent.includes('顺序'));
  ok('确认框正文说明了具体是哪两条日期反了', q('#modal-body').innerHTML.includes('第 1 条') && q('#modal-body').innerHTML.includes('第 2 条'));
  await S.modalCallback();
  await tick();
  ok('确认后还是保存成功了', S.DB.milestones.some(m => m.task === taskId && m.deliverable === 'P21后一条但日期早' && !m.deleted_at));
  raw.document.querySelectorAll = () => [];

  section('任务页：状态字段改为点击就弹下拉，不再是循环切换');
  S.setPage('tasks'); S.renderTasks();
  const anyOpenTask = S.DB.tasks.find(t => !t.deleted_at && t.status !== 'done' && S.canEditRecord('task', t));
  const statusCellHTML = S.renderCellValue('task', anyOpenTask, S.fieldDef('task', 'status'), true);
  ok('状态徽章的 data-act 是 edit（点击直接弹选择框），不是 cycle', statusCellHTML.includes('data-act="edit"') && !statusCellHTML.includes('data-act="cycle"'));
  const priorityCellHTML = S.renderCellValue('task', anyOpenTask, S.fieldDef('task', 'priority'), true);
  ok('优先级还是原来的单击循环切换（没有被这次改动影响到无关字段）', priorityCellHTML.includes('data-act="cycle"'));

  section('任务页：任务编号前的一键打勾完成列已经去掉');
  ok('渲染的整行里已经没有 task-done 这个动作了', !S.renderTaskRow(anyOpenTask).includes('task-done'));
  ok('ACTIONS 里也没有 task-done 这个处理函数了', !S.ACTIONS['task-done']);

  section('commitTaskStatus / hasIncompleteCheckpoints：状态改完成时的核心逻辑');
  const statusTaskId = 'p21_status_task';
  await S.Repo.upsert('task', { id: statusTaskId, work: wid2, title: 'P21状态测试任务', status: 'todo', plan_date: S.offsetDate(30), progress: 0, owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p21_status_ms1', task: statusTaskId, plan_date: '2026-08-01', deliverable: 'P21状态交付物', report_level: 'section', done: '0' });
  ok('这个任务确实有没完成的里程碑', S.hasIncompleteCheckpoints(S.byId('task', statusTaskId)));
  await S.commitTaskStatus(S.byId('task', statusTaskId), 'done', false);
  ok('仅改状态：任务变成已完成', S.byId('task', statusTaskId).status === 'done');
  ok('仅改状态：里程碑没有被动', S.byId('milestone', 'p21_status_ms1').done === '0');
  ok('仅改状态：进度按里程碑完成比例重算（0/1=0%），不是强行 100%', S.byId('task', statusTaskId).progress === 0);
  // 重置回未完成，再测"一并标记"这条路径
  await S.Repo.upsert('task', { ...S.byId('task', statusTaskId), status: 'todo', actual_date: '' });
  await S.commitTaskStatus(S.byId('task', statusTaskId), 'done', true);
  ok('一并标记：任务变成已完成', S.byId('task', statusTaskId).status === 'done');
  ok('一并标记：里程碑也被标记完成了', S.byId('milestone', 'p21_status_ms1').done === '1');
  ok('一并标记：进度变成 100%', S.byId('task', statusTaskId).progress === 100);

  section('spCommitSingle：任务页状态下拉选"已完成"，里程碑没完成时会先弹确认');
  const spTaskId = 'p21_sp_task';
  await S.Repo.upsert('task', { id: spTaskId, work: wid2, title: 'P21下拉测试任务', status: 'todo', plan_date: S.offsetDate(30), progress: 0, owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p21_sp_ms1', task: spTaskId, plan_date: '2026-08-01', deliverable: 'P21下拉测试交付物', report_level: 'section', done: '0' });
  const el = q('#tasks-body');   // openSelectPopup 只用它算弹层定位，随便给个 mock 元素即可
  S.ACTIONS['edit']({ entity: 'task', id: spTaskId, field: 'status' }, el);
  await S.ACTIONS['sp-pick']({ val: 'done' });
  ok('里程碑未完成时，选"已完成"会先弹确认框，不会立刻改状态', typeof S.modalCallback === 'function' && S.byId('task', spTaskId).status === 'todo');
  ok('确认框上有"仅改任务状态"这个额外按钮', q('#modal-body').innerHTML.includes('data-act="status-done-only"'));
  await S.ACTIONS['status-done-only']();
  ok('点"仅改状态"后任务变成已完成', S.byId('task', spTaskId).status === 'done');
  ok('点"仅改状态"后里程碑没有被动', S.byId('milestone', 'p21_sp_ms1').done === '0');

  section('spCommitSingle：里程碑本来就都完成了，选"已完成"不会弹确认');
  const spTaskId2 = 'p21_sp_task2';
  await S.Repo.upsert('task', { id: spTaskId2, work: wid2, title: 'P21下拉测试任务2', status: 'todo', plan_date: S.offsetDate(30), progress: 0, owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p21_sp_ms2', task: spTaskId2, plan_date: '2026-08-01', deliverable: 'P21下拉测试交付物2', report_level: 'section', done: '1' });
  S.ACTIONS['edit']({ entity: 'task', id: spTaskId2, field: 'status' }, el);
  await S.ACTIONS['sp-pick']({ val: 'done' });
  ok('没有未完成的里程碑，直接改成已完成，不弹确认框', S.byId('task', spTaskId2).status === 'done' && !S.modalCallback);

  section('任务详情弹窗：进度字段加了 %，进度和实际完成之间有"已完成"按钮');
  const noMsTaskId = 'p21_progress_task';
  await S.Repo.upsert('task', { id: noMsTaskId, work: wid2, title: 'P21进度测试任务（无里程碑）', status: 'todo', plan_date: S.offsetDate(30), progress: 40, owner: '测试管理员', assignees: [] });
  S.openTaskDetail(noMsTaskId);
  let detailHTML = q('#modal-body').innerHTML;
  ok('进度输入框后面跟了一个 % 符号', /id="td-progress"[^>]*>\s*<span class="unit-suffix">%<\/span>/.test(detailHTML));
  ok('有"已完成"按钮（无里程碑时点了直接把进度设成100）', detailHTML.includes('data-act="progress-set-done"'));
  ok('进度字段的初始值是任务当前的进度', detailHTML.includes('value="40"'));
  S.ACTIONS['progress-set-done']();
  ok('点了"已完成"，进度输入框的值变成 100', q('#td-progress').value === '100');
  S.ACTIONS['modal-cancel']();

  section('任务详情弹窗：有里程碑时，进度只读显示，"已完成"按钮改成一并勾完里程碑');
  S.openTaskDetail(taskId);   // taskId 前面已经补了两条里程碑，都还没完成
  detailHTML = q('#modal-body').innerHTML;
  ok('有里程碑时"已完成"按钮走的是 cp-mark-all-done', detailHTML.includes('data-act="cp-mark-all-done"'));
  ok('没有 progress-set-done 这个按钮（进度是自动算的，不能直接设 100）', !detailHTML.includes('data-act="progress-set-done"'));
  const rowA = fakeCpRow(false), rowB = fakeCpRow(false);
  raw.document.querySelectorAll = sel => sel === '#cp-list [data-cp-row]' ? [rowA, rowB] : [];
  S.ACTIONS['cp-mark-all-done']();
  ok('点了"已完成"后，两行检查点都被勾上了', rowA.querySelector('.cp-chk').checked === true && rowB.querySelector('.cp-chk').checked === true);
  ok('进度预览也跟着刷新成 2/2（100%）', q('#cp-progress-preview').textContent.includes('2/2') && q('#cp-progress-preview').textContent.includes('100%'));
  raw.document.querySelectorAll = () => [];
  S.ACTIONS['modal-cancel']();

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
