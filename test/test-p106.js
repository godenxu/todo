/* P106：第十四轮——"同事改完的数据被莫名其妙退回旧状态"的根

   处里第二次报同一个表象。这次找到的是 mergeEntityListWithBase 里那条【没有基线时】的回退规则：
   原来写的是"整条比较、谁 rev 高听谁的"。

   问题在于 rev 是【每台设备各自 +1】的计数，不是全局序号（mergeRecordThreeWay 开头那一大段
   早就写明过这件事），而且每次三方合并都取 max(两边)+1，所以经常同步的设备 rev 会被顶得很高。
   于是一台【rev 被顶高过、之后又丢了基线】的设备重新连上来，它手里那份几天前的旧内容
   会整条赢过文件里的最新值，并且被写回共享文件 —— 全处一起退回旧状态。
   rev 平局时比 updated_at，本机时钟快一点同样会赢。
   实测（scratchpad/probe-stale.js）：rev 更高、rev 平局+时钟更快，两种都能复现，
   而且不只是本机，共享文件也一起被改坏。

   什么时候会没有基线，一点都不罕见：本机缓存是引入基线机制之前那一版留下的（同事很久没打开
   过页面）、从备份恢复之后、以共享文件为准重置缓存之后、断开又连到另一个共享文件夹之后。

   修法（见 mergeWithoutBase）：没有基线时这台设备拿不出任何凭据证明手里的值是"我改的"，
   那就不能赌。凭据用【变更日志】——本机有、文件里没有的条目就是"我做过、还没推上去"的铁证，
   而且带 refId 和 changes：
     · 有逐字段凭据 → 以文件为底，只把日志记过的那几个字段换成本机的值；
     · 有凭据但说不清字段（老日志没明细）→ 退回整条竞争，至少不凭空丢改动；
     · 一点凭据都没有 → 以文件为准，并记一条告警（同步给全处），不悄无声息。

   这个文件两个方向都要钉住：旧缓存顶不回去，真活也丢不了。

   用法：node test/test-p106.js */
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

const DUTY = { code: '01', category: '一、前瞻研判', name: '职责一', rev: 2,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '李四' };
const WORK = { id: 'w1', code: '0101', duty: '01', name: '工作一', content: [], owner: '李四',
  collaborators: [], year: 2026, status: 'doing', rev: 2,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '李四' };
// 共享文件里是团队最新状态
function freshFile(rev, taskOver) {
  return Object.assign(EMPTY(), {
    schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'wFresh', writeIds: ['wFresh'],
    lastWriteApp: S.APP_VERSION, lastWriteBy: '李四', lastWriteAt: '2026-09-10T10:00:00.000Z',
    duties: [Object.assign({}, DUTY)], works: [Object.assign({}, WORK)],
    tasks: [Object.assign({
      id: 'T1', work: 'w1', code: '0101261', title: '最新标题', owner: '李四', assignees: ['王五'],
      status: 'doing', priority: '1', plan_date: '2026-10-01', progress: 80, actual_date: '',
      source: '', custom: '最新备注', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-09-10T10:00:00.000Z', updated_by: '李四', rev,
    }, taskOver || {})],
  });
}
// 旧缓存客户端本机那一份（几天前那一版，rev 被历史合并顶得很高）
function staleLocal(rev, over) {
  S.DB.settings.me = '旧缓存同事';
  S.DB.duties = [Object.assign({}, DUTY)];
  S.DB.works = [Object.assign({}, WORK)];
  S.DB.tasks = [Object.assign({
    id: 'T1', work: 'w1', code: '0101261', title: '旧标题', owner: '张三', assignees: [],
    status: 'todo', priority: '3', plan_date: '2026-08-01', progress: 30, actual_date: '',
    source: '', custom: '旧备注', created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-09-05T08:00:00.000Z', updated_by: '旧缓存同事', rev,
  }, over || {})];
  S.DB.milestones = []; S.DB.changelog = []; S.DB.purged = [];
  S.DB.settings.pendingSync = false;
  S.undoStack.length = 0;
  S.setSnackPriorityUntil(0);
  q('#snack-msg').textContent = '';
  S.clearSyncBaseline(S.DB);        // ← 关键前提：没有同步基线
  S.rebuildIndex();
}
function mount(fileRev, taskOver) {
  _h = mkHandle(JSON.stringify(freshFile(fileRev, taskOver)));
  S.setFileHandle(_h);
  S.setEverConnected(true);
}
const t1 = () => S.byId('task', 'T1');
const f1 = () => ((fileOf(_h).tasks || []).find(x => x.id === 'T1') || {});
// 往本机日志里塞一条"我改过这条记录"的凭据（只在本机、文件里没有）
function localLog(field, from, to, opts) {
  const e = { id: S.uid('log'), at: new Date().toISOString(), by: '旧缓存同事',
    kind: (opts && opts.kind) || 'edit', entity: 'task',
    refId: (opts && 'refId' in opts) ? opts.refId : 'T1',
    taskId: (opts && 'refId' in opts) ? opts.refId : 'T1',
    summary: '（本机）改了' + field };
  if (!(opts && opts.noChanges)) e.changes = [{ k: field, from, to }];
  S.DB.changelog.push(e);
  return e;
}
const alertHit = kw => (S.DB.changelog || []).filter(e =>
  S.logKind(e) === S.ALERT_LOG_KIND && String(e.summary).indexOf(kw) !== -1);

async function main() {
  await tick(150);

  section('一、★★旧缓存顶不回去（用户报的就是这个）');
  {
    staleLocal(30); mount(9);     // 本机 rev 30 > 文件 rev 9，但本机没有任何改动凭据
    await S.Repo.persist(S.DB); await tick(35);
    ok('★★本机那份旧内容没有赢（原来整条赢）', t1().title === '最新标题', t1().title);
    ok('★★共享文件也没被改坏（原来连文件一起退回旧状态）', f1().title === '最新标题', f1().title);
    ok('★每个字段都以文件为准', t1().owner === '李四' && t1().progress === 80 && t1().custom === '最新备注',
      { owner: t1().owner, progress: t1().progress, custom: t1().custom });
    ok('★留了一条告警，说明"本机有内容但找不到凭据，已按文件为准"',
      alertHit('找不到').length === 1, (S.DB.changelog || []).map(e => String(e.summary).slice(0, 40)));
    const a = alertHit('找不到')[0];
    ok('★告警里点了名（是哪条记录、哪些字段）', a && /任务「最新标题」/.test(a.summary) && /标题/.test(a.summary),
      a && a.summary.slice(0, 200));
    ok('★告警里告诉了当事人"如果是你刚改的请重新改一次"', a && /重新改一次/.test(a.summary));
    ok('★★这条告警推进了共享文件（只让那台机器知道没有意义）',
      (fileOf(_h).changelog || []).some(e => /找不到/.test(String(e.summary))));
    ok('★提示条也当场说了一句', /说不清来路/.test(q('#snack-msg').textContent), q('#snack-msg').textContent);
  }

  section('一之二、★rev 平局 + 本机时钟更快，同样顶不回去');
  {
    staleLocal(9, { updated_at: '2026-09-30T00:00:00.000Z' });
    mount(9);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★★时间戳更晚也赢不了（没凭据就是没凭据）', t1().title === '最新标题' && f1().title === '最新标题',
      { 本机: t1().title, 文件: f1().title });
  }

  section('一之三、★本机 rev 更低（原来就没问题，不能改坏）；而且这一轮除了告警没别的要推');
  {
    staleLocal(4);
    /* 账号名单也要跟文件对齐，否则"本机有个文件里没有的账号"本身就构成"有东西要推"，
       这一轮就会照常写文件，测不出"告警有没有被单独推出去" */
    const f = freshFile(9);
    f.users = JSON.parse(JSON.stringify(S.DB.users));
    _h = mkHandle(JSON.stringify(f)); S.setFileHandle(_h); S.setEverConnected(true);
    await S.Repo.persist(S.DB); await tick(35);
    ok('照样以文件为准', t1().title === '最新标题' && f1().title === '最新标题');
    /* 这个场景里本机 rev 比文件低、内容又全部以文件为准，于是"有没有东西要推"的判断会说
       "没有" → 走到"不写文件"那条分支。但这一轮确实往日志里写过一条告警，
       它必须跟着推出去，否则就只有那台机器自己知道（跟 noteFieldConflicts 同一个道理）。 */
    ok('★★这一轮没有别的要推，但告警仍然被推进了共享文件',
      (fileOf(_h).changelog || []).some(e => /找不到/.test(String(e.summary))),
      (fileOf(_h).changelog || []).map(e => String(e.summary).slice(0, 40)));
  }

  section('二、★★反方向：真正没推上去的改动必须还能推上去');
  {
    staleLocal(30, { title: '我离线时改的标题' });
    localLog('title', '旧标题', '我离线时改的标题');     // ← 本机日志凭据
    mount(9);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★★我改过的那个字段推上去了（不能因为防旧缓存把真活弄丢）',
      t1().title === '我离线时改的标题', t1().title);
    ok('★★共享文件里也是我那个值', f1().title === '我离线时改的标题', f1().title);
    ok('★★我没改过的字段一律听文件的（这才是关键：只拿回我动过的那几格）',
      t1().owner === '李四' && t1().progress === 80 && t1().custom === '最新备注',
      { owner: t1().owner, progress: t1().progress, custom: t1().custom });
    ok('★版本号压得住双方', t1().rev > 30, t1().rev);
    ok('★没改过的那些字段虽然没被采用，也报出来了（本机确实有不一样的内容）',
      alertHit('找不到').length === 1, alertHit('找不到').map(e => e.summary.slice(0, 120)));
  }

  section('二之二、★多个字段的凭据都要认');
  {
    staleLocal(30, { title: '我改的标题', progress: 55 });
    localLog('title', '旧标题', '我改的标题');
    localLog('progress', 30, 55);
    mount(9);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★两个字段都推上去了', t1().title === '我改的标题' && t1().progress === 55,
      { title: t1().title, progress: t1().progress });
    ok('★其余字段仍然听文件的', t1().owner === '李四' && t1().custom === '最新备注');
  }

  section('二之三、★老日志没有逐字段明细时，退回整条竞争（至少不凭空丢改动）');
  {
    staleLocal(30, { title: '我改的标题' });
    localLog('title', '', '', { noChanges: true });     // 只知道动过这条记录，不知道动了哪几格
    mount(9);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★整条竞争：本机 rev 高 → 保住本机那份（不丢改动，但会连带拿回旧字段）',
      t1().title === '我改的标题', t1().title);
    ok('★这种情况不报"找不到凭据"（它是有凭据的，只是说不清字段）',
      alertHit('找不到').length === 0, alertHit('找不到').map(e => e.summary.slice(0, 80)));
  }

  section('三、★什么不算凭据');
  {
    // ① 文件里已经有这条日志 → 说明这次改动早就推上去了，不能再当"还没推"的凭据
    staleLocal(30, { title: '旧标题' });
    const e = localLog('title', '更早的值', '旧标题');
    const file = freshFile(9);
    file.changelog = [Object.assign({}, e)];           // 文件里也有同一条日志
    _h = mkHandle(JSON.stringify(file)); S.setFileHandle(_h); S.setEverConnected(true);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★文件里已有那条日志 → 不算凭据，以文件为准', t1().title === '最新标题', t1().title);

    // ② 登录/告警这类日志不是"我改了哪条业务记录"
    staleLocal(30); localLog('title', 'a', 'b', { kind: 'login' });
    mount(9);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★登录类日志不算凭据', t1().title === '最新标题', t1().title);

    // ③ 批量动作那种 refId 为空的汇总日志定位不到具体记录
    staleLocal(30); localLog('title', 'a', 'b', { refId: '' });
    mount(9);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★refId 为空的汇总日志定位不到记录，不算凭据', t1().title === '最新标题', t1().title);
    ok('★这种情况会报出来，让人知道本机有说不清来路的内容', alertHit('找不到').length === 1);
  }

  section('四、★软删除方向：没凭据的未推软删除会被撤回（刻意选的方向）');
  {
    staleLocal(30, { deleted_at: '2026-09-06T00:00:00.000Z' });   // 本机把它删了，但没留凭据
    mount(9);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★★记录回来了（多回来一条、人看见再删一次就行；反过来把别人数据删掉救不回来）',
      !t1().deleted_at, t1().deleted_at);
    ok('★并且报出来了', alertHit('找不到').length === 1, alertHit('找不到').map(e => e.summary.slice(0, 140)));

    // 有凭据的软删除照样生效
    staleLocal(30, { deleted_at: '2026-09-06T00:00:00.000Z' });
    localLog('deleted_at', '', '2026-09-06T00:00:00.000Z');
    mount(9);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★有凭据的软删除照样推上去', !!t1().deleted_at, t1().deleted_at);
  }

  section('五、★回归：有基线时仍然走逐字段三方合并，一点没变');
  {
    staleLocal(30); mount(9);
    // 建一份跟本机数据一致的基线（正常离线那几天应有的状态）
    S.DB.syncBase = S.buildSyncBase(S.syncPayload(S.DB));
    await S.Repo.persist(S.DB); await tick(35);
    ok('★有基线时照旧：本机没改过 → 以文件为准', t1().title === '最新标题', t1().title);
    ok('★有基线时不报"找不到凭据"（那条路径根本没走）', alertHit('找不到').length === 0);

    // 有基线 + 本机真改过一个字段 → 那个字段照样推上去，别的听文件
    staleLocal(30); mount(9);
    S.DB.syncBase = S.buildSyncBase(S.syncPayload(S.DB));
    t1().title = '有基线时我改的';
    S.stampMeta(t1());
    await S.Repo.persist(S.DB); await tick(35);
    ok('★有基线 + 我改过 → 我那个字段赢', t1().title === '有基线时我改的', t1().title);
    ok('★我没改的字段听文件的', t1().owner === '李四' && t1().progress === 80);
  }

  section('六、★本机独有的记录（文件里没有）不受影响');
  {
    staleLocal(30);
    S.DB.tasks.push({ id: 'TLOCAL', work: 'w1', code: '0101299', title: '本机新建的任务',
      owner: '旧缓存同事', assignees: [], status: 'todo', priority: '2', plan_date: '', progress: 0,
      actual_date: '', source: '', custom: '', created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), updated_by: '旧缓存同事', rev: 1 });
    S.rebuildIndex();
    mount(9);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★本机新建的记录照样推上去了（这条规则只管"两边都有"的记录）',
      !!S.byId('task', 'TLOCAL') && !!(fileOf(_h).tasks || []).find(x => x.id === 'TLOCAL'));
    ok('★文件里新增的记录也照样收进来', !!S.byId('duty', '01'));
  }

  section('六之二、★★第二种凭据：批量/导入类动作只写汇总日志，靠 stampMeta 的标记兜住');
  {
    /* CSV 导入、宽表导入、批量操作、年度复制、体检修复这些一次改几百条的动作，
       按设计只写一条汇总日志（refId 是空的，定位不到具体记录）。只认日志凭据的话，
       它们在"没有基线"时会被当成说不清来路的内容整批丢掉 ——
       一位缓存还是旧版（没有基线）的同事，打开页面第一件事就是导一份 CSV，那次导入会原地消失。
       所以 stampMeta 会顺手记下"这条是我改的"，作为更粗但覆盖得全的第二种凭据。 */
    staleLocal(30);
    S.clearLocallyChanged(S.DB);
    mount(9);
    // 模拟一次导入/批量动作：直接改字段 + stampMeta（不写逐字段日志），这正是那些动作的形态
    const t = t1();
    t.title = '导入改的标题';
    S.stampMeta(t);
    ok('前置：stampMeta 留下了"这条是我改的"标记',
      (S.DB.settings.dirtyKeys || []).indexOf('T1') !== -1, S.DB.settings.dirtyKeys);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★★没有基线、也没有逐字段日志，导入的内容照样保住了', t1().title === '导入改的标题', t1().title);
    ok('★★也推进了共享文件', f1().title === '导入改的标题', f1().title);

    /* 反向：旧缓存不能靠"陈年标记"翻身。
       "清空我对共享文件的全部记忆"这个动作（从备份恢复、以共享文件为准重置缓存、
       断开再连别的文件夹）必须把这些标记一起清掉，否则那台设备上几个月前留下的标记
       会被当成凭据，旧内容照样能顶回去。
       这里刻意在【标记非空】的时刻调 clearSyncBaseline，不然测不出它有没有真的清。 */
    S.markLocallyChanged({ id: 'T1' });
    S.markLocallyChanged({ id: 'w1' });
    ok('前置：标记里确实有东西', (S.DB.settings.dirtyKeys || []).indexOf('T1') !== -1,
      S.DB.settings.dirtyKeys);
    S.clearSyncBaseline(S.DB);
    ok('★★clearSyncBaseline 把"我改过"的标记一并清掉了（不然旧缓存靠陈年标记又能顶回去）',
      (S.DB.settings.dirtyKeys || []).length === 0, S.DB.settings.dirtyKeys);

    // 端到端再确认一次：旧缓存 + 陈年标记已清 → 顶不回去
    staleLocal(30);   // staleLocal 里也调了 clearSyncBaseline
    mount(9);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★旧缓存仍然顶不回去', t1().title === '最新标题', t1().title);
  }

  section('六之三、★标记本身的行为：写成功后清空、有上限、认得出各类主键');
  {
    staleLocal(30);
    S.clearLocallyChanged(S.DB);
    mount(9);
    const t = t1(); t.title = 'x'; S.stampMeta(t);
    ok('前置：标记里有东西', (S.DB.settings.dirtyKeys || []).length > 0);
    await S.Repo.persist(S.DB); await tick(35);
    ok('★★成功写进共享文件之后标记被清空（已经推上去了，不该再攒着）',
      (S.DB.settings.dirtyKeys || []).length === 0, S.DB.settings.dirtyKeys);

    S.clearLocallyChanged(S.DB);
    ok('★任务/工作/里程碑按 id 记', S.localKeyOf({ id: 't_1', code: '01' }) === 't_1');
    ok('★职责按编号记', S.localKeyOf({ code: '07' }) === '07');
    ok('★账号按姓名记', S.localKeyOf({ name: '张三' }) === '张三');
    ok('空记录不抛异常', S.localKeyOf(null) === '' && S.localKeyOf({}) === '');
    S.markLocallyChanged({ id: 'A' }); S.markLocallyChanged({ id: 'A' });
    ok('★同一条不会记两遍', (S.DB.settings.dirtyKeys || []).filter(k => k === 'A').length === 1);
    for (let i = 0; i < S.LOCAL_DIRTY_LIMIT + 50; i++) S.markLocallyChanged({ id: 'K' + i });
    ok('★有上限，不会无限长大', (S.DB.settings.dirtyKeys || []).length === S.LOCAL_DIRTY_LIMIT,
      (S.DB.settings.dirtyKeys || []).length);
    S.clearLocallyChanged(S.DB);
  }

  section('七、★凭据表本身的口径');
  {
    const mk = (id, over) => Object.assign({ id, kind: 'edit', entity: 'task', refId: 'T1',
      at: '2026-09-01T00:00:00.000Z', summary: 's', changes: [{ k: 'title' }] }, over || {});
    let m = S.buildLocalOnlyChangeMap([mk('L1')], []);
    ok('★本机独有、带明细 → 记下字段', m.get('task T1') instanceof Set && m.get('task T1').has('title'));
    m = S.buildLocalOnlyChangeMap([mk('L1')], [mk('L1')]);
    ok('★文件里也有同一条 → 不算凭据', m.size === 0, m.size);
    m = S.buildLocalOnlyChangeMap([mk('L1', { changes: undefined })], []);
    ok('★本机独有、没明细 → 记成 null（说不清字段）', m.get('task T1') === null);
    m = S.buildLocalOnlyChangeMap([mk('L1'), mk('L2', { changes: undefined })], []);
    ok('★同一条记录既有明细又有无明细 → 按"说不清字段"算（更保守）', m.get('task T1') === null);
    m = S.buildLocalOnlyChangeMap([mk('L1', { kind: 'login' })], []);
    ok('★非 edit 类不算', m.size === 0);
    m = S.buildLocalOnlyChangeMap([mk('L1', { refId: '', taskId: '' })], []);
    ok('★refId 为空不算', m.size === 0);
    ok('传空不抛异常', S.buildLocalOnlyChangeMap(null, null).size === 0);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
