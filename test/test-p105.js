/* P105：任务标成"已完成"时，里程碑没有被一并勾完

   处里报上来的原话："任务完成了，但里程碑没有自动勾选都完成，导致日志检查时也会出错"。

   把"把任务标成已完成"的每一条入口走了一遍（scratchpad/probe-done.js），
   发现有两条路径只改状态、里程碑一个不动：

     ③ 批量改状态 → 已完成（openBatchEdit）★ 影响最大，一次能放倒几十条
     ④ 双击「实际完成时间」填一个日期（dpCommit 会顺手把状态改成已完成）

   而任务列表的状态下拉、任务详情保存这两条早就做对了（先用 openDoneAutoFillModal
   问一句，再由 commitTaskStatus 一并勾完）。两类入口行为不一致，使用者完全没法预料。

   留下的是这么一条矛盾记录：状态=已完成、进度却卡在 33%、里程碑还挂着未交付。连带三处出问题：
     · 进度上不到 100% —— 有里程碑的任务，进度是按已交付比例算出来的（recalcProgress）；
     · 交付统计和报表少算 —— 本期已交付里程碑、交付物层级分布这些口径只认 done='1'，
       活干完了却不体现在给领导看的报表里；
     · 数据体检一直报"进度和状态对不上"，而那一项的修复方向是【反的】——
       它会"按当前进度自动纠正状态"，把状态从已完成打回进行中，
       看起来就像系统自己把做完的任务改回去了。

   修法：
     · 把"勾完名下里程碑"收口成 completeCheckpointsOf，四条入口全部改走它；
     · 批量改状态 → 已完成时，先把"会顺带勾掉几个里程碑、补哪些日期"问清楚再动手，
       跟单条那条路径同一套规矩；不提供"只改状态、不动里程碑"的选项（那正是矛盾的来源）；
     · 双击实际完成时间同样走 openDoneAutoFillModal；
     · 这两条以前还漏了「计划完成时间」没补 —— 缺了会让按日期归期的统计漏掉这条任务；
     · 勾了几个里程碑要写进日志（里程碑自己不单独留变更记录，不写就查不出是谁一次性勾完的）；
     · 新增体检项 doneWithOpenCp，把修复前已经产生的那批脏数据找出来，
       往"补齐里程碑"的方向修，而不是把状态打回去。

   用法：node test/test-p105.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 400) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
function mkHandle(text) {
  const h = { name: 'shared.json', _text: text, _mtime: 1, _writes: 0,
    async getFile() { const s = h._text; return { lastModified: h._mtime, text: async () => s }; },
    async createWritable() { return { async write(t) { h._p = t; }, async close() { h._writes++; h._text = h._p; h._mtime++; } }; } };
  return h;
}
const fileOf = h => JSON.parse(h._text);
let _h = null;

/* T1 / T2：各带 3 个里程碑（1 个已交付）→ 派生进度 33
   T3：名下没有里程碑 → 进度手填 */
function reset() {
  S.DB.settings.me = '测试管理员';
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一', owner: '张三', year: 2026 }))];
  S.DB.tasks = ['T1', 'T2', 'T3'].map((id, i) => S.stampMeta(S.blank('task', { id, work: 'w1',
    code: '010126' + (i + 1), title: '任务' + (i + 1), owner: '张三', assignees: [], status: 'doing',
    priority: '2', plan_date: '', progress: i === 2 ? 40 : 33 })));
  S.DB.milestones = [];
  ['T1', 'T2'].forEach(tid => {
    for (let k = 1; k <= 3; k++) {
      S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: tid + '_M' + k, task: tid,
        deliverable: '交付物' + k, plan_date: '2026-0' + (k + 3) + '-30',
        done: k === 1 ? '1' : '0', actual_date: k === 1 ? '2026-04-20' : '' })));
    }
  });
  S.DB.changelog = []; S.DB.purged = [];
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  // 批量操作的"已选中"集合必须清掉：sel-row 是切换语义，上一节留下的选中项
  // 会让这一节的"选中 T1"反而把 T1 取消掉，测的就不是想测的那几条了
  S.UI.tasks.sel.clear();
  S.undoStack.length = 0;
  S.setSnackPriorityUntil(0);
  q('#snack-msg').textContent = '';
  S.rebuildIndex();
  _h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'] })));
  S.setFileHandle(_h);
  S.setEverConnected(true);
}
// 连续点掉可能出现的多层确认框（批量改状态是"批量修改"弹窗 → 再一层"批量标记为已完成"确认）
async function confirmAll() {
  let shown = 0;
  for (let i = 0; i < 5; i++) {
    await tick(15);
    if (!q('#modal-overlay').classList.contains('show')) break;
    const cb = S.modalCallback; if (typeof cb !== 'function') break;
    shown++;
    await cb(); await tick(25);
  }
  if (q('#modal-overlay').classList.contains('show')) S.closeModal();
  await tick(30);
  return shown;
}
const msOf = id => S.DB.milestones.filter(m => m.task === id && !m.deleted_at);
const doneN = id => msOf(id).filter(m => m.done === '1').length;
const logHit = kw => (S.DB.changelog || []).filter(e => String(e.summary).indexOf(kw) !== -1);

async function main() {
  await tick(150);

  section('一、收口函数本身');
  {
    reset();
    ok('★还差几个没交付，算得对', S.incompleteCheckpointCount(S.byId('task', 'T1')) === 2,
      S.incompleteCheckpointCount(S.byId('task', 'T1')));
    ok('没有里程碑的任务算 0', S.incompleteCheckpointCount(S.byId('task', 'T3')) === 0);
    ok('传空不抛异常', S.incompleteCheckpointCount(null) === 0);
    // 逐条记下动手之前的版本号，后面要精确断言"被勾的那几个版本号涨了、没动的那个没涨"
    const revBefore = {};
    msOf('T1').forEach(m => { revBefore[m.id] = m.rev || 0; });
    const n = S.completeCheckpointsOf(S.byId('task', 'T1'));
    ok('★勾完之后返回"这次勾了几个"', n === 2, n);
    ok('★★三个里程碑全部已交付', doneN('T1') === 3, doneN('T1'));
    ok('★★新勾的那两个都补上了实际完成日期', msOf('T1').every(m => !!m.actual_date),
      msOf('T1').map(m => m.deliverable + ':' + m.actual_date));
    ok('★本来就已交付的那个，实际完成日期没被改成今天（别把历史抹掉）',
      (msOf('T1').find(m => m.id === 'T1_M1') || {}).actual_date === '2026-04-20');
    ok('★★被勾的那两个都盖了戳、版本号涨了（不盖戳这次改动传不到别人那里）',
      ['T1_M2', 'T1_M3'].every(id => (S.byId('milestone', id) || {}).rev > revBefore[id]),
      ['T1_M2', 'T1_M3'].map(id => id + ':' + revBefore[id] + '→' + (S.byId('milestone', id) || {}).rev));
    ok('★本来就已交付的那个一点没动（版本号也没涨）',
      (S.byId('milestone', 'T1_M1') || {}).rev === revBefore['T1_M1'],
      revBefore['T1_M1'] + '→' + (S.byId('milestone', 'T1_M1') || {}).rev);
    ok('★没碰另一条任务的里程碑', doneN('T2') === 1, doneN('T2'));
    ok('再调一次返回 0（幂等，不会重复动）', S.completeCheckpointsOf(S.byId('task', 'T1')) === 0);
  }

  section('二、★★批量改状态 → 已完成（用户报的就是这条）');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    S.setPage('tasks');
    S.renderTasks(); await tick(10);
    ['T1', 'T2'].forEach(id => S.ACTIONS['sel-row']({ id }, { checked: true }));
    await tick(10);
    S.openBatchEdit('status');
    await tick(15);
    const el = q('#be-status'); if (el) el.value = 'done';
    const layers = await confirmAll();
    ok('★弹了确认框把后果先讲清楚（原来一句话都不问）', layers >= 2, layers);
    ok('★★T1 名下里程碑被一并勾完（原来一个都不勾）', doneN('T1') === 3, doneN('T1'));
    ok('★★T2 也一样（批量就是要一次都处理好）', doneN('T2') === 3, doneN('T2'));
    ok('★★进度跟着到 100%（原来卡在 33%）',
      S.byId('task', 'T1').progress === 100 && S.byId('task', 'T2').progress === 100,
      [S.byId('task', 'T1').progress, S.byId('task', 'T2').progress]);
    ok('★状态是已完成', S.byId('task', 'T1').status === 'done');
    ok('★实际完成时间补上了', !!S.byId('task', 'T1').actual_date);
    ok('★★计划完成时间也补上了（原来只补了实际完成时间，缺了会让按日期归期的统计漏掉这条）',
      !!S.byId('task', 'T1').plan_date, S.byId('task', 'T1').plan_date);
    ok('★新勾的里程碑都有实际完成日期', msOf('T1').every(m => !!m.actual_date));
    ok('★★体检不再报"进度和状态对不上"',
      !(S.healthCheck().progressMismatch || []).some(x => x.id === 'T1'));
    ok('★★体检也不报"已完成但里程碑没勾完"',
      !(S.healthCheck().doneWithOpenCp || []).some(x => x.id === 'T1'));
    ok('★日志里写明了勾了几个里程碑（里程碑自己不单独留记录，不写就查不出来）',
      logHit('里程碑一并标记为已交付').length >= 2,
      logHit('里程碑一并标记为已交付').map(e => e.summary));
    ok('★★改动真的推进了共享文件',
      (fileOf(_h).milestones || []).filter(m => m.task === 'T1' && m.done === '1').length === 3,
      (fileOf(_h).milestones || []).filter(m => m.task === 'T1').map(m => m.done));
    ok('★提示条里说了勾了几个', /里程碑一并标记为已交付/.test(q('#snack-msg').textContent),
      q('#snack-msg').textContent);
    ok('按日志核对是干净的', S.auditByChangelog().length === 0,
      S.auditByChangelog().map(a => a.field + ':' + JSON.stringify(a.to)));
    ok('回归：可以 Ctrl+Z 撤销', S.undoStack.length > 0);
  }

  section('二之一点五、★离线时批量标已完成，进度也要当场算对');
  {
    /* 连着共享文件夹时，就算批量这一步忘了重算进度，同步路径上的派生重算
       （reconcileDerivedAfterMerge）也会顺手把它补对——于是"忘了重算"这个缺陷被掩盖了。
       离线时没有那层兜底，进度必须在当场就算对，否则界面上就是
       "状态已完成、进度却卡在 33%"。所以这一条专门断开共享文件夹来测。 */
    reset();
    S.setFileHandle(null);
    S.setPage('tasks'); S.renderTasks(); await tick(10);
    S.ACTIONS['sel-row']({ id: 'T1' }, { checked: true });
    S.openBatchEdit('status');
    await tick(15);
    const el = q('#be-status'); if (el) el.value = 'done';
    await confirmAll();
    ok('★★离线时进度也当场算到 100%（不能指望同步那层兜底）',
      S.byId('task', 'T1').progress === 100, S.byId('task', 'T1').progress);
    ok('★里程碑也勾完了', doneN('T1') === 3, doneN('T1'));
    S.setFileHandle(_h);
  }

  section('二之二、★批量改成别的状态、以及没有里程碑的任务，不受影响');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    S.setPage('tasks'); S.renderTasks(); await tick(10);
    ['T1'].forEach(id => S.ACTIONS['sel-row']({ id }, { checked: true }));
    S.openBatchEdit('status');
    await tick(15);
    const el = q('#be-status'); if (el) el.value = 'hold';
    const layers = await confirmAll();
    ok('★改成"已挂起"不弹那层确认（只有改成已完成才问）', layers === 1, layers);
    ok('★里程碑一个都没被动', doneN('T1') === 1, doneN('T1'));
    ok('★状态改成了已挂起', S.byId('task', 'T1').status === 'hold');

    // 没有里程碑的任务批量标已完成：不该弹"要勾里程碑"那句，但日期还是要补
    reset();
    S.byId('task', 'T3').plan_date = '2026-11-01';
    S.byId('task', 'T3').actual_date = '2026-11-01';
    await S.Repo.persist(S.DB); await tick(25);
    S.setPage('tasks'); S.renderTasks(); await tick(10);
    S.ACTIONS['sel-row']({ id: 'T3' }, { checked: true });
    S.openBatchEdit('status');
    await tick(15);
    const el2 = q('#be-status'); if (el2) el2.value = 'done';
    const layers2 = await confirmAll();
    ok('★日期齐全、又没有里程碑的任务，不用多问一层', layers2 === 1, layers2);
    ok('★进度直接到 100%', S.byId('task', 'T3').progress === 100, S.byId('task', 'T3').progress);
  }

  section('二之三、回归：批量改状态仍然跳过"不是我负责/参与"的任务');
  {
    reset();
    S.DB.users = [{ name: '测试管理员', role: 'staff', salt: '', hash: '', iterations: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: '测试管理员', rev: 1 }];
    S.DB.permissionMatrix = null;
    S.byId('task', 'T1').owner = '别人'; S.byId('task', 'T1').assignees = [];
    S.byId('task', 'T2').owner = '测试管理员';
    await S.Repo.persist(S.DB); await tick(25);
    S.setPage('tasks'); S.renderTasks(); await tick(10);
    ['T1', 'T2'].forEach(id => S.ACTIONS['sel-row']({ id }, { checked: true }));
    S.openBatchEdit('status');
    await tick(15);
    const el = q('#be-status'); if (el) el.value = 'done';
    await confirmAll();
    ok('★不是自己的那条被跳过了，里程碑也没被动', doneN('T1') === 1 && S.byId('task', 'T1').status !== 'done',
      { done: doneN('T1'), status: S.byId('task', 'T1').status });
    ok('★自己那条正常处理', doneN('T2') === 3 && S.byId('task', 'T2').status === 'done');
  }

  section('三、★双击「实际完成时间」填日期（会顺手把状态改成已完成）');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    S.openDatePicker('task', 'T1', 'actual_date', q('#dummy-td'));
    await tick(15);
    await S.dpCommit('2026-09-11');
    const layers = await confirmAll();
    ok('★弹了确认框（原来悄悄就把状态改了）', layers >= 1, layers);
    ok('★★里程碑被一并勾完', doneN('T1') === 3, doneN('T1'));
    ok('★状态变成已完成、进度到 100%',
      S.byId('task', 'T1').status === 'done' && S.byId('task', 'T1').progress === 100,
      { status: S.byId('task', 'T1').status, progress: S.byId('task', 'T1').progress });
    ok('★实际完成时间就是填的那个日期', S.byId('task', 'T1').actual_date === '2026-09-11');
    ok('★计划完成时间也补上了', !!S.byId('task', 'T1').plan_date);
    ok('★日志里写明了勾了几个', logHit('里程碑一并标记为已交付').length >= 1,
      logHit('里程碑一并标记为已交付').map(e => e.summary));
    ok('★体检干净', !(S.healthCheck().doneWithOpenCp || []).length);
  }

  section('三之二、★没有里程碑、或者任务本来就已完成时，不要多此一问');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    S.openDatePicker('task', 'T3', 'actual_date', q('#dummy-td'));
    await tick(15);
    await S.dpCommit('2026-09-11');
    const layers = await confirmAll();
    ok('★没有里程碑的任务不弹框', layers === 0, layers);
    ok('★照样变成已完成、进度 100%',
      S.byId('task', 'T3').status === 'done' && S.byId('task', 'T3').progress === 100);

    // 任务本来就是已完成：只改日期，不该再问一次
    reset();
    S.byId('task', 'T1').status = 'done';
    await S.Repo.persist(S.DB); await tick(25);
    S.openDatePicker('task', 'T1', 'actual_date', q('#dummy-td'));
    await tick(15);
    await S.dpCommit('2026-09-12');
    const layers2 = await confirmAll();
    ok('★本来就已完成时不弹框（这次只是在改日期）', layers2 === 0, layers2);
    ok('★日期改了', S.byId('task', 'T1').actual_date === '2026-09-12');

    // 工作/职责上的日期字段不该被这套逻辑牵连
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    S.openDatePicker('task', 'T1', 'plan_date', q('#dummy-td'));
    await tick(15);
    await S.dpCommit('2026-12-01');
    const layers3 = await confirmAll();
    ok('★改的是「计划完成时间」，不触发"标记已完成"那一套', layers3 === 0 && S.byId('task', 'T1').status === 'doing',
      { layers: layers3, status: S.byId('task', 'T1').status });
  }

  section('四、★回归：单条改状态那条路径仍然正常，而且日志里也写明了勾了几个');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    await S.commitTaskStatus(S.byId('task', 'T1'), 'done', true);
    await tick(30);
    ok('里程碑勾完了', doneN('T1') === 3);
    ok('进度 100%', S.byId('task', 'T1').progress === 100);
    ok('★日志里写明了勾了几个（原来没写）', logHit('里程碑一并标记为已交付').length === 1,
      logHit('里程碑一并标记为已交付').map(e => e.summary));
    // 不带 alsoCompleteCheckpoints 时不该动里程碑
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    await S.commitTaskStatus(S.byId('task', 'T2'), 'doing', false);
    await tick(25);
    ok('★改成非已完成状态时不动里程碑', doneN('T2') === 1);
  }

  section('五、★新增体检项：已完成但里程碑没勾完（清理修复前留下的脏数据）');
  {
    reset();
    // 手工造出修复前那种矛盾记录：状态已完成、里程碑没勾、进度卡在 33
    S.byId('task', 'T1').status = 'done';
    S.byId('task', 'T1').actual_date = '2026-09-01';
    await S.Repo.persist(S.DB); await tick(25);
    const h = S.healthCheck();
    const item = h.issues.find(i => i.k === 'doneWithOpenCp');
    ok('★★体检能发现它', !!item, h.issues.map(i => i.k));
    ok('★算成"需要修复"那一档（报表会少算，属于明确的状态不一致）', item && item.level === 'error', item && item.level);
    ok('★条数对', item && item.n === 1, item && item.n);
    ok('★明细里写了还差几个里程碑', item && /还有 2 个里程碑未交付/.test(item.items[0].label),
      item && item.items[0].label);
    ok('★修复说明写的是"补齐里程碑"，不是"把状态打回去"',
      !!item && /标记为已交付/.test(item.fix) && !/纠正状态/.test(item.fix), item && item.fix);
    const prev = S.fixHealthPreview('doneWithOpenCp');
    ok('★干跑预览说得清楚', prev && /标记为已交付/.test(prev.what), prev && prev.what);

    await S.fixHealth('doneWithOpenCp');
    await tick(35);
    ok('★★修完：里程碑补齐了', doneN('T1') === 3, doneN('T1'));
    ok('★★进度重算到 100%', S.byId('task', 'T1').progress === 100, S.byId('task', 'T1').progress);
    ok('★★状态仍然是已完成（方向对：补里程碑，不是把状态打回进行中）',
      S.byId('task', 'T1').status === 'done', S.byId('task', 'T1').status);
    ok('★留了痕', logHit('数据体检').length >= 1, logHit('数据体检').map(e => e.summary));
    ok('★推进了共享文件',
      (fileOf(_h).milestones || []).filter(m => m.task === 'T1' && m.done === '1').length === 3);
    ok('★修完体检就干净了', !(S.healthCheck().doneWithOpenCp || []).length);
    ok('★也不再报"进度和状态对不上"',
      !(S.healthCheck().progressMismatch || []).some(x => x.id === 'T1'));
    ok('回归：可以 Ctrl+Z 撤销', S.undoStack.length > 0);
  }

  section('五之二、★体检这一项不该误伤正常数据');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    ok('进行中的任务里程碑没勾完，不算问题', !(S.healthCheck().doneWithOpenCp || []).length);
    S.byId('task', 'T3').status = 'done';
    S.byId('task', 'T3').progress = 100;
    ok('★已完成、但名下本来就没有里程碑的任务，不算问题',
      !(S.healthCheck().doneWithOpenCp || []).some(x => x.id === 'T3'));
    // 已完成 + 里程碑也都勾完 → 正常
    S.completeCheckpointsOf(S.byId('task', 'T1'));
    S.byId('task', 'T1').status = 'done';
    S.recalcProgress(S.byId('task', 'T1'));
    ok('★已完成且里程碑都勾完了，不算问题',
      !(S.healthCheck().doneWithOpenCp || []).some(x => x.id === 'T1'));
    // 已删除的任务不参与
    S.byId('task', 'T2').status = 'done';
    S.softDelete('task', 'T2');
    ok('★回收站里的任务不参与体检', !(S.healthCheck().doneWithOpenCp || []).some(x => x.id === 'T2'));
    // 里程碑被软删掉的不算"没交付"
    S.undelete('task', 'T2');
    msOf('T2').filter(m => m.done !== '1').forEach(m => S.softDelete('milestone', m.id));
    ok('★已删除的里程碑不算"还没交付"', !(S.healthCheck().doneWithOpenCp || []).some(x => x.id === 'T2'),
      S.incompleteCheckpointCount(S.byId('task', 'T2')));
  }

  section('六、★同一个 index.html 默默投产：检测到新版本自己静默重载一次');
  {
    /* 以前为了绕开浏览器缓存，每次投产都要换文件名（index0911.html → index0912.html），
       同事每次都得重新找文件。现在：共享文件里出现更新的版本号时，页面自己带一个
       查询串重载一次（file:// 下这样能绕开缓存），同事刷一下（或等一轮自动同步）就升上去了。 */
    const nav = [];
    const realLoc = raw.location;
    raw.location = { hash: '', href: 'file:///C:/share/index.html',
      get _nav() { return nav; },
      set href(v) { nav.push(v); }, };
    // 上面那个 setter 会把初始 href 也吃掉，重新摆一个干净的
    raw.location = Object.defineProperty({ hash: '' }, 'href', {
      get() { return 'file:///C:/share/index.html'; },
      set(v) { nav.push(v); },
    });
    const clear = () => { try { S.storage.removeItem(S.STALE_RELOAD_KEY); } catch (e) {} };

    reset();
    S.setStaleAppBlocked(false);
    S.closeModal();
    clear();
    S.DB.settings.maxSeenAppVersion = '';
    ok('没见过更新版本时不重载', S.autoReloadForNewVersion() === false && nav.length === 0);

    S.DB.settings.maxSeenAppVersion = 'v29991231235959';   // 假装共享文件里有个更新的版本
    const did = S.autoReloadForNewVersion();
    ok('★★检测到更新的版本 → 自己重载一次', did === true && nav.length === 1, nav);
    ok('★★重载地址带了查询串（这才绕得开浏览器缓存，file:// 下同样有效）',
      nav.length === 1 && /index\.html\?_=\d+/.test(nav[0]), nav[0]);
    ok('★重载地址还是原来那个文件名（投产不用再换文件名了）',
      nav.length === 1 && nav[0].indexOf('file:///C:/share/index.html?') === 0, nav[0]);

    ok('★★同一个目标版本不会重复自动重载（否则本机那份 html 真是旧的时候会无限刷新）',
      S.autoReloadForNewVersion() === false && nav.length === 1, nav);

    // 真的升上去了（本机变成最新版）→ 标记要清掉，下一次投产才能再自动试一次
    S.DB.settings.maxSeenAppVersion = S.APP_VERSION;
    ok('前置：现在本机就是最新版', !S.checkAppVersion({ lastWriteApp: S.APP_VERSION }) === false);
    S.DB.settings.maxSeenAppVersion = 'v29991231235959';
    ok('★下一次投产能再自动试一次（上一轮的标记被清掉了）',
      S.autoReloadForNewVersion() === true && nav.length === 2, nav);

    // 手上有没保存的东西时不许刷
    clear(); nav.length = 0;
    S.DB.settings.maxSeenAppVersion = 'v29991231235959';
    S.DB.settings.pendingSync = true;
    ok('★有积压未同步的改动时不刷（刷了等于把人没保存的东西抹掉）',
      S.autoReloadForNewVersion() === false && nav.length === 0);
    S.DB.settings.pendingSync = false;
    clear();
    S.openModal('占着一个弹窗', 'x', '确定', () => {});
    ok('★开着弹窗时不刷', S.autoReloadForNewVersion() === false && nav.length === 0);
    S.closeModal();

    // 升不上去时要退回门禁，而不是一直刷
    clear(); nav.length = 0;
    S.setStaleAppBlocked(false);
    S.DB.settings.maxSeenAppVersion = 'v29991231235959';
    q('#login-body').innerHTML = '';
    S.checkAppVersion({ lastWriteApp: 'v29991231235959' });
    ok('★★第一次：自动重载，不摆门禁', nav.length === 1 && q('#login-body').innerHTML === '', nav);
    S.setStaleAppBlocked(false);
    S.checkAppVersion({ lastWriteApp: 'v29991231235959' });
    ok('★★第二次（说明重载没解决）：退回门禁，按步骤让人处理',
      nav.length === 1 && /旧版本/.test(q('#login-body').innerHTML),
      q('#login-body').innerHTML.slice(0, 60));
    ok('★门禁上仍然留着"强制刷新试试"那个按钮',
      /data-act="force-reload"/.test(q('#login-body').innerHTML));

    raw.location = realLoc;
    S.setStaleAppBlocked(false);
    clear();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
