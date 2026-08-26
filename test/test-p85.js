/* P85：两个新功能——
   1) 任务复制：任务列表操作列（原来只有"×"删除）左边加一个"⧉"复制按钮，表头也跟着加上；
      点了直接弹出（跟新建任务一样的）详情弹窗，字段/里程碑都照抄被复制那条，用户改完再存；
      保存时如果标题跟原任务一字不差，硬拦不让存。
   2) 里程碑复制：任务详情弹窗里每条里程碑"＋"按钮后面加一个"⧉"复制按钮，点了在这条下面插入
      一条内容完全一样的新里程碑；保存时如果同一任务下有两条里程碑所有字段都一样，硬拦不让存。
   用法：node test/test-p85.js */
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
  const bakMe = S.DB.settings.me, bakPM = S.DB.permissionMatrix;
  const restore = () => {
    S.DB.settings.me = bakMe;
    S.DB.permissionMatrix = bakPM;
    raw.document.querySelectorAll = () => [];
    S.closeModal();
  };

  section('①：cpRowHTML——复制按钮加在"＋"后面、"×"前面');
  const rowHtmlBlank = S.cpRowHTML(null);
  ok('★空白行也有复制按钮', rowHtmlBlank.includes('data-act="cp-copy-row"'));
  ok('★复制按钮在"插入"和"删除"之间', rowHtmlBlank.indexOf('cp-insert-after') < rowHtmlBlank.indexOf('cp-copy-row')
    && rowHtmlBlank.indexOf('cp-copy-row') < rowHtmlBlank.indexOf('cp-remove-row'));
  ok('★复用了 action-btn copy 样式类', /class="action-btn copy" data-act="cp-copy-row"/.test(rowHtmlBlank));

  section('②：findDuplicateCpIssue（纯函数）——日期/交付物/呈报层级/完成状态全都一样才算重复');
  ok('三条都不同，没问题', S.findDuplicateCpIssue([
    { plan_date: '2026-01-01', deliverable: 'A', report_level: 'section', done: '0' },
    { plan_date: '2026-02-01', deliverable: 'B', report_level: 'section', done: '0' },
    { plan_date: '2026-03-01', deliverable: 'C', report_level: 'section', done: '0' },
  ]) === '');
  const dupIssue = S.findDuplicateCpIssue([
    { plan_date: '2026-01-01', deliverable: 'A', report_level: 'section', done: '0' },
    { plan_date: '2026-02-01', deliverable: 'B', report_level: 'section', done: '0' },
    { plan_date: '2026-01-01', deliverable: 'A', report_level: 'section', done: '0' },
  ]);
  ok('★第 1 条和第 3 条完全一样，报出来了', dupIssue.includes('第 1 条') && dupIssue.includes('第 3 条'), dupIssue);
  ok('★只差一个字段（完成状态不同）不算重复', S.findDuplicateCpIssue([
    { plan_date: '2026-01-01', deliverable: 'A', report_level: 'section', done: '0' },
    { plan_date: '2026-01-01', deliverable: 'A', report_level: 'section', done: '1' },
  ]) === '');
  ok('空数组/一条都不报问题', S.findDuplicateCpIssue([]) === '' &&
    S.findDuplicateCpIssue([{ plan_date: '2026-01-01', deliverable: 'A', report_level: 'section', done: '0' }]) === '');

  section('③：ACTIONS[cp-copy-row]——复制这一行当前（哪怕刚被改过还没存）的字段值，完成状态原样带过去，不重置');
  let insertedPos = null, insertedHtml = null;
  const fakeRow = {
    querySelector(sel) {
      if (sel === '.cp-date') return { value: '2026-09-15' };
      if (sel === '.cp-deliv') return { value: 'P85交付物甲' };
      if (sel === '.cp-report-level') return { value: 'bank' };
      if (sel === '.cp-chk') return { checked: true };
      return null;
    },
  };
  const fakeEl = { closest: () => fakeRow, insertAdjacentHTML: undefined };
  fakeRow.insertAdjacentHTML = (pos, html) => { insertedPos = pos; insertedHtml = html; };
  S.ACTIONS['cp-copy-row']({}, fakeEl);
  ok('★插在这一行后面', insertedPos === 'afterend');
  ok('★日期带过去了', insertedHtml.includes('value="2026-09-15"'));
  ok('★交付物带过去了', insertedHtml.includes('value="P85交付物甲"'));
  ok('★呈报层级带过去了（行领导 bank 被选中）', /<option value="bank" selected>/.test(insertedHtml));
  ok('★完成状态原样带过去（勾着的还是勾着）——跟任务复制不一样，用户明确要求"复制所有信息"', /class="cp-chk" checked/.test(insertedHtml));
  ok('★新插入的行没有 data-ms-id，保存时会当成全新记录', /data-ms-id=""/.test(insertedHtml));

  section('④：ACTIONS[task-copy]——权限：不是自己负责/参与、又没有 view_others_detail 权限时不能复制');
  await S.Repo.upsert('duty', { code: 'P85D', name: 'P85职责' });
  await S.Repo.upsert('work', { id: 'p85_w', duty: 'P85D', code: 'W1', name: 'P85工作', owner: '测试管理员' });
  await S.Repo.upsert('task', {
    id: 'p85_orig', work: 'p85_w', title: 'P85原始任务', status: 'doing', priority: '1',
    owner: '测试管理员', assignees: ['P85参与者'], plan_date: S.offsetDate(10), progress: 40,
  });
  await S.Repo.upsert('milestone', { id: 'p85_ms1', task: 'p85_orig', plan_date: S.offsetDate(3), deliverable: 'P85交付物A', report_level: 'section', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p85_ms2', task: 'p85_orig', plan_date: S.offsetDate(8), deliverable: 'P85交付物B', report_level: 'bank', done: '1', actual_date: S.offsetDate(-1) });
  S.rebuildIndex();

  S.DB.users.push({ name: 'P85旁观员工', role: 'staff', salt: 's', hash: 'h', iterations: 1 });
  S.DB.permissionMatrix = { staff: { ...S.DEFAULT_PERMISSION_MATRIX.staff, view_others_detail: false },
    comanager: S.DEFAULT_PERMISSION_MATRIX.comanager, director: S.DEFAULT_PERMISSION_MATRIX.director };
  S.DB.settings.me = 'P85旁观员工';
  S.closeModal();
  S.ACTIONS['task-copy']({ id: 'p85_orig' });
  ok('★没权限，弹窗没打开', !q('#modal-overlay').classList.contains('show'));
  ok('★给了提示', q('#snack-msg').textContent.includes('为了防止误操作'));

  S.DB.permissionMatrix = bakPM;
  S.DB.settings.me = bakMe;

  section('④：ACTIONS[task-copy]——有权限时：弹窗预填字段，状态/进度/实际完成日期重置，里程碑一起复制过来（完成状态清零）');
  S.ACTIONS['task-copy']({ id: 'p85_orig' });
  ok('★弹窗标题是"新建任务"（走的是新建流程，不是编辑）', q('#modal-title').textContent === '新建任务');
  const copyModalHTML = q('#modal-body').innerHTML;
  ok('★标题预填了原任务的标题', copyModalHTML.includes('value="P85原始任务"'));
  ok('★优先级预填了', /id="td-priority"[\s\S]{0,300}value="1" selected|<option value="1" selected/.test(copyModalHTML) || copyModalHTML.includes('selected'));
  ok('★参与人预填了', copyModalHTML.includes('P85参与者'));
  ok('★里程碑带过来了两条', (copyModalHTML.match(/data-cp-row/g) || []).length === 2);
  ok('★里程碑交付物文字带过来了', copyModalHTML.includes('P85交付物A') && copyModalHTML.includes('P85交付物B'));
  ok('★复制过来的里程碑完成状态清零（原来 B 是已完成，复制过来不该带着"已交付"）', !/class="cp-chk" checked/.test(copyModalHTML));
  ok('★复制过来的里程碑都没有 data-ms-id（保存时当新记录建）', (copyModalHTML.match(/data-ms-id=""/g) || []).length === 2);

  section('⑤：保存拦截——标题跟原任务一模一样，不让存');
  raw.document.querySelectorAll = sel => sel === '#cp-list [data-cp-row]' ? [] : [];
  q('#td-title').value = 'P85原始任务';   // 没改
  q('#td-work').value = 'p85_w';
  q('#td-owner').value = '测试管理员';
  q('#td-assignees').value = '';
  q('#td-status').value = 'todo';
  q('#td-priority').value = '1';
  q('#td-plan_date').value = S.offsetDate(10);
  const taskCountBefore = S.DB.tasks.length;
  await S.modalCallback(); await tick();
  ok('★提示要求先改名', q('#snack-msg').textContent.includes('复制出来的任务名称跟原任务一模一样'));
  ok('★没有创建新任务', S.DB.tasks.length === taskCountBefore, { before: taskCountBefore, after: S.DB.tasks.length });
  ok('★弹窗还开着（没被误关）', q('#modal-overlay').classList.contains('show'));

  section('⑤：改名之后能正常保存，编号自动生成，原任务不受影响');
  q('#td-title').value = 'P85复制出来的新任务';
  await S.modalCallback(); await tick();
  ok('★新任务创建成功', S.DB.tasks.length === taskCountBefore + 1);
  const newTask = S.DB.tasks.find(t => t.title === 'P85复制出来的新任务');
  ok('★新任务存在', !!newTask);
  if (newTask) {
    ok('★新任务编号自动生成了，且不是空的', !!newTask.code, newTask.code);
    ok('★新任务编号跟原任务不一样', newTask.code !== S.byId('task', 'p85_orig').code);
    ok('★状态重置成"未开始"', newTask.status === 'todo', newTask.status);
    ok('★进度重置成 0', newTask.progress === 0, newTask.progress);
    ok('★实际完成日期是空的', !newTask.actual_date);
    ok('★所属工作复制过来了', newTask.work === 'p85_w');
  }
  const origAfterCopy = S.byId('task', 'p85_orig');
  ok('★原任务标题/状态/进度都没被动过', origAfterCopy.title === 'P85原始任务' && origAfterCopy.status === 'doing' && origAfterCopy.progress === 40);
  ok('★原任务名下的里程碑数量没变（复制不影响原任务）', S.DB.milestones.filter(m => m.task === 'p85_orig' && !m.deleted_at).length === 2);
  raw.document.querySelectorAll = () => [];

  section('⑥：保存拦截——同一任务下两条里程碑完全一样，不让存');
  const targetTask = newTask;   // 用刚复制出来的这条任务测里程碑重复校验，省得再造一条
  S.openTaskDetail(targetTask.id);
  const dupFakeRow = (date, deliv, done, level) => ({
    querySelector(sel) {
      if (sel === '.cp-date') return { value: date };
      if (sel === '.cp-deliv') return { value: deliv };
      if (sel === '.cp-chk') return { checked: done };
      if (sel === '.cp-report-level') return { value: level };
      return null;
    },
  });
  raw.document.querySelectorAll = sel => sel === '#cp-list [data-cp-row]'
    ? [dupFakeRow('2026-10-01', 'P85重复交付物', false, 'section'), dupFakeRow('2026-10-01', 'P85重复交付物', false, 'section')]
    : [];
  const msCountBefore = S.DB.milestones.filter(m => !m.deleted_at).length;
  await S.modalCallback(); await tick();
  ok('★提示两条里程碑完全一样', q('#snack-msg').textContent.includes('完全一样'), q('#snack-msg').textContent);
  ok('★没有新增里程碑', S.DB.milestones.filter(m => !m.deleted_at).length === msCountBefore);

  section('⑥：改掉其中一条之后能正常保存');
  raw.document.querySelectorAll = sel => sel === '#cp-list [data-cp-row]'
    ? [dupFakeRow('2026-10-01', 'P85重复交付物', false, 'section'), dupFakeRow('2026-10-02', 'P85重复交付物', false, 'section')]
    : [];
  await S.modalCallback(); await tick();
  const msAfter = S.DB.milestones.filter(m => m.task === targetTask.id && !m.deleted_at);
  ok('★两条日期不同的里程碑都保存成功了', msAfter.length === 2, msAfter.length);
  raw.document.querySelectorAll = () => [];

  section('⑦：任务列表——表头和行内按钮位置');
  S.renderTasks();
  const headHTML = q('#tasks-head').innerHTML;
  ok('★表头带上了复制图标（⧉），不再只显示删除的 ✕', headHTML.includes('⧉') && headHTML.includes('✕'));
  const someTask = S.taskRows.find(t => !t.deleted_at);
  const rowHTML = S.renderTaskRow(someTask);
  ok('★行内复制按钮在删除按钮左边', rowHTML.indexOf('data-act="task-copy"') > -1
    && rowHTML.indexOf('data-act="task-copy"') < rowHTML.indexOf('data-act="task-del"'));
  ok('★复制按钮带上了这一行的任务 id', rowHTML.includes(`data-act="task-copy" data-id="${someTask.id}"`));

  restore();
  await S.Repo.upsert('task', { id: 'p85_orig', deleted_at: new Date().toISOString() });
  if (newTask) await S.Repo.upsert('task', { id: newTask.id, deleted_at: new Date().toISOString() });
  await S.Repo.upsert('work', { id: 'p85_w', deleted_at: new Date().toISOString() });
  await S.Repo.upsert('duty', { code: 'P85D', deleted_at: new Date().toISOString() });
  S.rebuildIndex();

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
