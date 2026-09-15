/* P107：第十五轮——"是不是每个改数据的动作都留痕了"的全面排查

   处里的问题："是否所有变动都有日志？比如某人挂起一条任务等。"

   做法：先用源码扫描把 189 个 ACTIONS 里"改了数据却看不到日志调用"的挑出来，
   再逐个真去点一遍看 DB.changelog 有没有新增（scratchpad/probe-log.js、probe-log2.js）。
   结论是绝大多数动作早就有痕迹（挂起任务、改优先级/牵头人/日期、删除恢复、
   彻底删除、批量、导入、账号增删改、权限矩阵、回收站恢复 …… 都有），
   真正缺的是四个，而且都集中在"破坏力大或者影响全处"的那一类：

     ① 清除全部测试任务（clear-test）—— 一次彻底删除，退不回来，却一条日志都没有
     ② 以共享文件为准重置本机缓存（reset-local-cache）—— 丢弃本机全部未同步改动，
        而且它正是"本机没有同步基线"这个状态的制造者之一（见 P106 的 mergeWithoutBase），
        事后排查"某台机器的东西怎么没了""那天怎么冒出一堆按文件为准的告警"全靠它对时间
     ③ 共享文件夹配置（updateShareConfig）—— 回收站保留期这类**同步给全处**的设置，
        它直接决定"多久以前删的算过期、可以被彻底清理"。从 180 天改成 30 天，
        下次清空回收站就会多删一大批，事后完全查不到是谁什么时候改的
     ④ 报告页 / 工作台编排（saveReportConfig / saveDashboardConfig）—— 整份生效、
        同步给全处，一个人改完所有人看到的页面都变了，却没有任何痕迹
     ⑤ 清空全部数据（reset-all）—— 顺带补上

   编排是拖着改的，一次调整能触发十几二十次保存，所以④用 pushCoalescedAdminLog
   把连续动作合并成一条，避免把日志页刷屏、也避免挤占带明细变更记录的 800 条额度。

   顺带修掉一个上一轮（P105）自己引入的瑕疵：改「计划完成时间」时日志把同一处改动
   写了两遍（"计划完成：A→B；计划完成：A→B"），因为联动字段列表里 plan_date 重复了。

   用法：node test/test-p107.js */
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

function reset() {
  S.DB.settings.me = '测试管理员';
  S.DB.users = [{ name: '测试管理员', role: 'admin', salt: '', hash: '', iterations: 0,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '测试管理员', rev: 1 }];
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    owner: '测试管理员', year: 2026, status: 'doing' }))];
  S.DB.tasks = [
    S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261', title: '正常任务',
      owner: '测试管理员', status: 'doing', priority: '2', plan_date: '2026-10-01', progress: 20 })),
    S.stampMeta(S.blank('task', { id: 'TT1', work: 'w1', code: '0101262', title: '测试任务甲',
      owner: '测试管理员', status: 'doing', priority: '2', progress: 0, custom: '测试' })),
    S.stampMeta(S.blank('task', { id: 'TT2', work: 'w1', code: '0101263', title: '测试任务乙',
      owner: '测试管理员', status: 'doing', priority: '2', progress: 0, custom: '测试' })),
  ];
  S.DB.milestones = [S.stampMeta(S.blank('milestone', { id: 'M1', task: 'TT1',
    deliverable: '测试交付物', plan_date: '2026-06-30', done: '0' }))];
  S.DB.changelog = []; S.DB.purged = [];
  S.DB.permissionMatrix = null; S.DB.reportConfig = null; S.DB.dashboardConfig = null; S.DB.shareConfig = null;
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.undoStack.length = 0;
  S.setSnackPriorityUntil(0);
  S.UI.tasks.sel.clear();
  q('#snack-msg').textContent = '';
  S.rebuildIndex();
  _h = mkHandle(JSON.stringify(Object.assign(EMPTY(), {
    schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'] })));
  S.setFileHandle(_h); S.setEverConnected(true);
}
async function confirmAll() {
  for (let i = 0; i < 5; i++) {
    await tick(15);
    if (!q('#modal-overlay').classList.contains('show')) break;
    const cb = S.modalCallback; if (typeof cb !== 'function') break;
    await cb(); await tick(25);
  }
  if (q('#modal-overlay').classList.contains('show')) S.closeModal();
  await tick(30);
}
const since = n => S.DB.changelog.slice(n);
const hit = (list, kw) => list.filter(e => String(e.summary).indexOf(kw) !== -1);
const inFile = kw => (fileOf(_h).changelog || []).some(e => String(e.summary).indexOf(kw) !== -1);

async function main() {
  await tick(150);

  section('一、★★清除全部测试任务：一次彻底删除，必须点名留痕');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const n0 = S.DB.changelog.length;
    S.ACTIONS['clear-test']();
    await confirmAll();
    ok('前置：测试任务确实被彻底删了', !S.byId('task', 'TT1') && !S.byId('task', 'TT2'));
    const m = hit(since(n0), '清除测试数据');
    ok('★★留下了日志（原来一条都没有）', m.length === 1, since(n0).map(e => e.summary));
    ok('★写明了条数', m.length === 1 && /彻底删除了 2 条/.test(m[0].summary), m[0] && m[0].summary);
    ok('★★点了名（彻底删除退不回来，事后只剩这条日志能对上是哪几条）',
      m.length === 1 && /测试任务甲/.test(m[0].summary) && /测试任务乙/.test(m[0].summary), m[0] && m[0].summary);
    ok('★说明了连里程碑一起删了', m.length === 1 && /里程碑/.test(m[0].summary));
    ok('★★这条日志真的推进了共享文件', inFile('清除测试数据'));
    ok('回归：留了墓碑，不会从别的机器飘回来',
      (S.DB.purged || []).filter(p => p.id === 'TT1' || p.id === 'TT2').length === 2);
  }

  section('二、★★以共享文件为准重置本机缓存：丢弃本机未同步改动，必须留痕');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    // 共享文件里有一条本机没有的任务，重置之后应该从文件里拉回来
    const f = fileOf(_h);
    f.tasks.push({ id: 'TR', work: 'w1', code: '0101299', title: '文件里的任务', owner: '同事乙',
      assignees: [], status: 'todo', priority: '2', plan_date: '', progress: 0, actual_date: '',
      source: '', custom: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      updated_by: '同事乙', rev: 1 });
    _h._text = JSON.stringify(f); _h._mtime++;
    S.ACTIONS['reset-local-cache']();
    await confirmAll();
    ok('前置：已经用共享文件那份替换掉了', !!S.byId('task', 'TR'), S.DB.tasks.map(t => t.id));
    const m = hit(S.DB.changelog, '重置本机缓存');
    ok('★★留下了日志（原来一条都没有，而这一步会丢掉本机全部未同步改动）',
      m.length === 1, S.DB.changelog.map(e => e.summary));
    ok('★是告警级别（这事值得所有人看见）', m.length === 1 && S.logKind(m[0]) === S.ALERT_LOG_KIND);
    ok('★写明了是谁做的', m.length === 1 && /测试管理员/.test(m[0].summary), m[0] && m[0].summary);
    ok('★★写明了丢掉了多少（原有 3 条任务）', m.length === 1 && /任务 3/.test(m[0].summary), m[0] && m[0].summary);
    ok('★★这条日志写在清空之后，没被一起抹掉', m.length === 1);
    ok('★★并且推进了共享文件（本机自己知道没有意义）', inFile('重置本机缓存'));
  }

  section('三、★★共享文件夹配置：同步给全处的设置，改了要查得到');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const n0 = S.DB.changelog.length;
    await S.ACTIONS['recycle-keep-change']({}, { value: '30' });
    await tick(30);
    ok('前置：配置生效了', (S.DB.shareConfig || {}).recycleKeepDays === 30);
    const m = hit(since(n0), '共享文件夹配置');
    ok('★★留下了日志（原来一条都没有）', m.length === 1, since(n0).map(e => e.summary));
    ok('★★写清楚了改的是哪一项、从多少改到多少',
      m.length === 1 && /回收站保留期/.test(m[0].summary) && /30/.test(m[0].summary), m[0] && m[0].summary);
    ok('★说明了这份配置同步给全处', m.length === 1 && /同步给全处/.test(m[0].summary));
    ok('★★推进了共享文件', inFile('共享文件夹配置'));

    // 值没变时不该记流水账
    const n1 = S.DB.changelog.length;
    await S.ACTIONS['recycle-keep-change']({}, { value: '30' });
    await tick(30);
    ok('★值没变就不记（别把日志刷成流水账）', hit(since(n1), '共享文件夹配置').length === 0,
      since(n1).map(e => e.summary));
  }

  section('四、★报告页 / 工作台编排：整份生效、同步给全处，改了要查得到');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const n0 = S.DB.changelog.length;
    await S.saveReportConfig(n => { n.presets = [{ id: 'p1', name: '季度汇报版', sections: [] }]; n.activeId = 'p1'; });
    await tick(30);
    const m = hit(since(n0), '报告页编排');
    ok('★★报告页编排留下了日志', m.length === 1, since(n0).map(e => e.summary));
    ok('★写明了是哪个预案', m.length === 1 && /季度汇报版/.test(m[0].summary), m[0] && m[0].summary);
    ok('★说明了同步给全处', m.length === 1 && /同步给全处/.test(m[0].summary));

    const n1 = S.DB.changelog.length;
    await S.saveDashboardConfig(n => { n.presets = [{ id: 'd1', name: '处长视角', sections: [] }]; n.activeId = 'd1'; });
    await tick(30);
    ok('★★工作台编排也留下了日志', hit(since(n1), '工作台编排').length === 1, since(n1).map(e => e.summary));
    ok('★★都推进了共享文件', inFile('报告页编排') && inFile('工作台编排'));
  }

  section('四之二、★★连续拖拽只留一条，不刷屏（编排一次调整能触发十几次保存）');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const n0 = S.DB.changelog.length;
    for (let i = 1; i <= 12; i++) {
      await S.saveReportConfig(n => { n.presets = [{ id: 'p1', name: '第' + i + '次', sections: [] }]; n.activeId = 'p1'; });
      await tick(8);
    }
    const m = hit(since(n0), '报告页编排');
    ok('★★拖了 12 次，日志里只有一条（原来会是 12 条，把带明细的变更记录挤掉）',
      m.length === 1, m.map(e => e.summary));
    ok('★内容是最后那一次的状态', m.length === 1 && /第12次/.test(m[0].summary), m[0] && m[0].summary);

    // 工作台编排是另一件事，不能被合并进去
    const n1 = S.DB.changelog.length;
    await S.saveDashboardConfig(n => { n.presets = [{ id: 'd1', name: '另一件事', sections: [] }]; n.activeId = 'd1'; });
    await tick(20);
    ok('★不同的事不会被错误合并', hit(since(n1), '工作台编排').length === 1);

    // 换个人做同一件事，要另起一条（合并只合并"同一个人的连续动作"）
    const n2 = S.DB.changelog.length;
    S.DB.settings.me = '另一个管理员';
    await S.saveReportConfig(n => { n.presets = [{ id: 'p1', name: '别人改的', sections: [] }]; n.activeId = 'p1'; });
    await tick(20);
    ok('★★换了人就另起一条（不能把别人的操作并进我这条里）',
      hit(since(n2), '报告页编排').length === 1, since(n2).map(e => e.by + ':' + e.summary));
    S.DB.settings.me = '测试管理员';
  }

  section('五、★清空全部数据也要留痕');
  {
    reset();
    S.setFileHandle(null);   // 连着共享文件夹时不许清空，这是既有的保护
    const n0 = S.DB.changelog.length;
    S.ACTIONS['reset-all']();
    await confirmAll();
    ok('前置：数据被清空了', S.DB.tasks.length === 0 && S.DB.works.length === 0);
    const m = hit(since(n0), '清空了本机全部业务数据');
    ok('★★留下了日志（而且没被清空一起抹掉——这个动作不清 changelog）',
      m.length === 1, since(n0).map(e => e.summary));
    ok('★写明了清掉多少', m.length === 1 && /任务 3/.test(m[0].summary), m[0] && m[0].summary);
    S.setFileHandle(_h);
  }

  section('六、★修掉 P105 引入的瑕疵：改日期时日志重复写了两遍');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const n0 = S.DB.changelog.length;
    S.openDatePicker('task', 'T1', 'plan_date', q('#td'));
    await tick(10);
    await S.dpCommit('2026-12-01');
    await tick(30);
    const e = since(n0)[0];
    ok('★摘要里同一处改动只写一遍',
      e && e.summary === '计划完成：2026-10-01→2026-12-01', e && e.summary);
    ok('★结构化明细里字段不重复',
      e && (e.changes || []).length === 1 && e.changes[0].k === 'plan_date',
      e && (e.changes || []).map(c => c.k));
  }

  section('七、回归：那些本来就有日志的动作，一条都不许丢');
  {
    const cases = [
      ['挂起任务（处里举的例子）', async () => {
        S.openSelectPopup('task', 'T1', S.fieldDef('task', 'status'), q('#td'));
        await tick(10); await S.spCommitSingle('hold');
      }, '状态'],
      ['改优先级', async () => {
        S.openSelectPopup('task', 'T1', S.fieldDef('task', 'priority'), q('#td'));
        await tick(10); await S.spCommitSingle('1');
      }, '优先级'],
      ['删除任务', async () => { await S.ACTIONS['task-del']({ id: 'T1' }); }, '删除了任务'],
      // 彻底删除只对已删除的任务出现（P118 起确认时会核对），跟真实操作一样先删
      ['彻底删除任务', async () => { S.softDelete('task', 'T1'); S.rebuildIndex(); await S.ACTIONS['task-purge']({ id: 'T1' }); }, '彻底删除了任务'],
      ['停用工作', async () => { await S.ACTIONS['work-del']({ id: 'w1' }); }, '停用了工作'],
      ['删除职责', async () => { await S.ACTIONS['duty-del']({ code: '01' }); }, '删除了职责'],
      ['批量删除', async () => {
        S.setPage('tasks'); S.renderTasks(); await tick(10);
        ['T1', 'TT1'].forEach(id => S.ACTIONS['sel-row']({ id }, { checked: true }));
        S.ACTIONS['batch-delete']();
      }, '批量删除'],
      ['CSV 导入', async () => { await S.applyCSVImport('task', 'merge', 'code,status\n0101261,done\n'); }, 'CSV 导入'],
      ['回收站恢复', async () => {
        S.cascadeSoftDeleteTask('T1'); await S.Repo.persist(S.DB); await tick(20);
        await S.ACTIONS['recycle-restore']({ entity: 'task', id: 'T1' });
      }, '从回收站恢复'],
      ['改角色', async () => {
        S.DB.users.push({ name: '同事乙', role: 'staff', salt: 's', hash: 'h', iterations: 1000,
          created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '测试管理员', rev: 1 });
        await S.ACTIONS['account-role-change']({ name: '同事乙' }, { value: 'comanager' });
      }, '角色'],
      ['权限矩阵', async () => {
        await S.ACTIONS['perm-toggle']({ key: 'bulk_ops', role: 'staff' }, { checked: true });
      }, '权限矩阵'],
    ];
    for (const [name, fn, kw] of cases) {
      reset();
      await S.Repo.persist(S.DB); await tick(25);
      const n0 = S.DB.changelog.length;
      await fn();
      await confirmAll();
      ok(name + ' 有日志', hit(since(n0), kw).length >= 1,
        since(n0).map(e => String(e.summary).slice(0, 50)));
    }
    // 权限矩阵那条日志的文案：PERMISSIONS 用的是 key 字段，取错会写成「undefined」
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const n0 = S.DB.changelog.length;
    await S.ACTIONS['perm-toggle']({ key: 'bulk_ops', role: 'staff' }, { checked: true });
    await tick(25);
    ok('★权限矩阵日志里权限名写对了，不是「undefined」',
      !/undefined/.test(String((since(n0)[0] || {}).summary)), (since(n0)[0] || {}).summary);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
