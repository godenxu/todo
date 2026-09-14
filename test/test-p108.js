/* P108：第十六轮——专查"这几轮修复之间的相互影响"

   处里的要求：改了这么多轮，之前排查过的领域也要重查，因为修复之间可能互相影响。
   所以这一轮不再单独打某一条规则，而是把两轮以上的修复叠在一起跑
   （scratchpad/probe-cross.js、probe-cross2.js，共 16 个组合场景）。

   查出来两个真的互相拆台，根子是同一个：★"整条"粒度的凭据不够用 ★

     A. 离线做备份还原 → 联网后还原被整批丢弃（P104 备份还原 × P106 无基线保护）
        离线时读不到共享文件，P104 那句"把基线对齐到文件当前内容"走不到，基线只能留空；
        而还原刻意不盖 stampMeta（要保住"最后是谁改的"那条线索），于是既没有基线、
        也没有任何凭据 —— P106 的保护把整次还原当成"说不清来路的内容"丢掉了。
        表象跟最早那个"点了确认恢复、数据一个字没变"一模一样。

     C. 缓存很旧（没有基线）的机器上来就做一次 CSV 导入 → 导入被丢弃（P103 × P106）
        导入按设计只写一条汇总日志（refId 是空的，定位不到具体记录），凭据只能到"整条"粒度，
        而"整条"又是拿 rev 定胜负的 —— "rev 高 ≠ 内容新"正是 mergeWithoutBase 要摆脱的东西，
        于是这次导入被文件里 rev 更高的旧记录顶掉了。

   修法：给那几个【确切知道自己写了哪些字段】的入口补上字段级凭据
   （markLocallyChangedFields）：CSV 导入知道表头里有哪几列、宽表导入知道它只碰任务的哪几项、
   备份还原就是整条都算。这样它们跟"带明细的变更日志"享受同一种逐字段合并——
   我写过的那几格用我的，没写过的听文件的。
   另外把"只知道动过整条"的判定方向改掉：以前是回头用 rev 比，现在一律以本机为准——
   这种标记只在 clearSyncBaseline 和"成功写进文件之后"之间存在，
   它存在就意味着这台机器确实写过、还没推上去，那就是真的本机改动。

   用法：node test/test-p108.js */
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
function mkHandle(text, opts) {
  const h = { name: 'shared.json', _text: text, _mtime: 1, _writes: 0, _fail: (opts && opts.fail) || false,
    async getFile() { const s = h._text; return { lastModified: h._mtime, text: async () => s }; },
    async createWritable() {
      if (h._fail) throw new Error('模拟：网盘写不进去');
      return { async write(t) { h._p = t; }, async close() { h._writes++; h._text = h._p; h._mtime++; } };
    } };
  return h;
}
const fileOf = h => JSON.parse(h._text);
let _h = null;

function base() {
  S.DB.settings.me = '测试管理员';
  S.DB.users = [{ name: '测试管理员', role: 'admin', salt: '', hash: '', iterations: 0,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '测试管理员', rev: 1 }];
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    owner: '测试管理员', year: 2026, status: 'doing' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261', title: '原标题',
    owner: '甲', assignees: ['乙'], status: 'doing', priority: '2', plan_date: '2026-10-01',
    progress: 50, custom: '原备注' }))];
  S.DB.milestones = [
    S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', deliverable: '交付物一', plan_date: '2026-04-30', done: '1', actual_date: '2026-04-20' })),
    S.stampMeta(S.blank('milestone', { id: 'M2', task: 'T1', deliverable: '交付物二', plan_date: '2026-12-31', done: '0' })),
  ];
  S.DB.changelog = []; S.DB.purged = [];
  S.DB.permissionMatrix = null; S.DB.reportConfig = null; S.DB.dashboardConfig = null; S.DB.shareConfig = null;
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.undoStack.length = 0; S.setSnackPriorityUntil(0); S.UI.tasks.sel.clear();
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
const t1 = () => S.byId('task', 'T1');
const ft = () => ((fileOf(_h).tasks || []).find(x => x.id === 'T1') || {});
// 共享文件里那条被"同事"改一改（rev 顶得比本机高，模拟经常同步的机器）
function colleagueEdits(over, revBump) {
  const f = fileOf(_h);
  const x = f.tasks.find(y => y.id === 'T1');
  Object.assign(x, over);
  x.rev = (x.rev || 1) + (revBump || 40);
  x.updated_at = new Date(Date.now() + 1000).toISOString();
  x.updated_by = '同事乙';
  _h._text = JSON.stringify(f); _h._mtime++;
}

async function main() {
  await tick(150);

  section('一、★★离线做备份还原 → 联网后还原必须生效（P104 × P106）');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    const backup = JSON.stringify(S.DB, null, 1);
    const t = t1(); t.title = '被改坏的标题'; S.stampMeta(t); S.stampMeta(t);
    await S.Repo.persist(S.DB); await tick(30);
    ok('前置：坏数据已经进了共享文件', ft().title === '被改坏的标题');

    S.setFileHandle(null);          // ★ 断网之后才做还原
    S.importBackup(backup);
    await confirmAll();
    ok('离线时还原在本机生效了', t1().title === '原标题', t1().title);
    ok('★离线时读不到文件，基线只能留空（这正是当初丢掉还原的前提）', !S.DB.syncBase);
    ok('★★但留下了字段级凭据（还原不盖 stampMeta，只能靠它）',
      Object.keys(S.DB.settings.dirtyFields || {}).indexOf('T1') !== -1,
      Object.keys(S.DB.settings.dirtyFields || {}));

    S.setFileHandle(_h); S.setEverConnected(true);
    await S.Repo.persist(S.DB); await tick(40);
    ok('★★★联网之后还原没有被丢掉（原来会被当成说不清来路的内容整批丢弃）',
      t1().title === '原标题', t1().title);
    ok('★★共享文件里也回到了备份那一份', ft().title === '原标题', ft().title);
  }

  section('二、★★旧缓存（无基线）上来就做 CSV 导入（P103 × P106）');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    colleagueEdits({ owner: '同事乙改的牵头人' });
    S.clearSyncBaseline(S.DB);      // 模拟"缓存是引入基线机制之前那一版"
    await S.applyCSVImport('task', 'merge', 'code,title\n0101261,导入改的标题\n');
    await tick(40);
    ok('★★导入的内容保住了（原来被文件里 rev 更高的旧记录顶掉）',
      t1().title === '导入改的标题', t1().title);
    ok('★★共享文件里也是导入后的值', ft().title === '导入改的标题', ft().title);
    ok('★★★同事改的牵头人也保住了（导入只写了标题那一列，不该顺手盖掉别的）',
      t1().owner === '同事乙改的牵头人', t1().owner);
  }

  section('二之二、★两边改同一个字段时，本机这次导入胜出');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    colleagueEdits({ title: '同事改的标题' });
    S.clearSyncBaseline(S.DB);
    await S.applyCSVImport('task', 'merge', 'code,title\n0101261,导入改的标题\n');
    await tick(40);
    ok('★本机刚做的导入胜出（不能因为文件里 rev 高就把刚做完的活判出去）',
      t1().title === '导入改的标题', t1().title);
  }

  section('三、★宽表导入只碰它那几项，别的听文件的（P103 × P106）');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    colleagueEdits({ custom: '同事写的备注', plan_date: '2026-11-11' });
    S.clearSyncBaseline(S.DB);
    await S.applyWideImport('merge',
      '所属工作项,任务项编号,任务项名称,任务项牵头人,任务项参与人,里程碑时间1,里程碑交付物1,里程碑交付物最高呈报1\n'
      + '工作一,0101261,宽表改的名字,丙,,2026-04-30,交付物一,\n');
    await tick(40);
    ok('★宽表改的名称生效了', t1().title === '宽表改的名字', t1().title);
    ok('★★宽表没碰的「备注」保住了同事那份', t1().custom === '同事写的备注', t1().custom);
    ok('★★宽表没碰的「计划完成」也保住了同事那份', t1().plan_date === '2026-11-11', t1().plan_date);
  }

  section('四、★无基线 + 单条编辑（有逐字段日志）仍然逐字段合并');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    colleagueEdits({ priority: '1' });
    S.clearSyncBaseline(S.DB);
    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'status'), q('#td'));
    await tick(10);
    await S.spCommitSingle('hold');
    await confirmAll();
    ok('★我改的状态推上去了', t1().status === 'hold', t1().status);
    ok('★同事改的优先级保住了', t1().priority === '1', t1().priority);
  }

  section('五、★★成功同步之后凭据必须清干净（否则陈年凭据会一直顶）');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    S.clearSyncBaseline(S.DB);
    await S.applyCSVImport('task', 'merge', 'code,title\n0101261,导入改的标题\n');
    await tick(40);
    ok('★★整条标记清空了', (S.DB.settings.dirtyKeys || []).length === 0, S.DB.settings.dirtyKeys);
    ok('★★字段标记也清空了', Object.keys(S.DB.settings.dirtyFields || {}).length === 0,
      Object.keys(S.DB.settings.dirtyFields || {}));
    // 之后同事再改，本机不该拿上一次导入的陈年凭据去顶
    colleagueEdits({ title: '同事后来改的标题' });
    S.clearSyncBaseline(S.DB);
    await S.Repo.persist(S.DB); await tick(40);
    ok('★★同事后来改的保住了（陈年凭据没有再顶一次）',
      t1().title === '同事后来改的标题', t1().title);
  }

  section('六、★没有基线又一直写不进去时，告警不许刷屏');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    colleagueEdits({ title: '同事改的标题' });
    S.clearSyncBaseline(S.DB);
    _h._fail = true;
    const n0 = S.DB.changelog.length;
    for (let i = 0; i < 5; i++) { await S.Repo.persist(S.DB); await tick(25); }
    const n = (S.DB.changelog || []).filter(e => /找不到/.test(String(e.summary))).length;
    ok('★连写 5 轮，同样的告警只有一条（不会把日志刷满）', n <= 1, n);
    ok('★这几轮也没有攒出一堆别的日志', S.DB.changelog.length - n0 <= 2, S.DB.changelog.length - n0);
    _h._fail = false;
  }

  section('七、★彻底删除 → 备份救回 → 连跑三轮同步（P100 × P104 × P106）');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    const backup = JSON.stringify(S.DB, null, 1);
    S.cascadeRemoveHardTask('T1');
    await S.Repo.persist(S.DB); await tick(30);
    ok('前置：任务被彻底删了、墓碑进了文件',
      !S.byId('task', 'T1') && (fileOf(_h).purged || []).some(p => p.id === 'T1'));
    S.importBackup(backup);
    await confirmAll();
    for (let i = 0; i < 3; i++) { await S.Repo.persist(S.DB); await tick(20); await S.pullFromFile(); await tick(20); }
    ok('★★救回来的记录活过了三轮同步', !!S.byId('task', 'T1') && !!ft().id);
    ok('★墓碑被标成"已撤销"', (S.DB.purged || []).some(p => p.id === 'T1' && p.undone));
  }

  section('八、★无基线时把任务标已完成（P105 勾里程碑 × P102 派生进度 × P106 凭据）');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    S.clearSyncBaseline(S.DB);
    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'status'), q('#td'));
    await tick(10);
    await S.spCommitSingle('done');
    await confirmAll();
    const live = S.DB.milestones.filter(m => m.task === 'T1' && !m.deleted_at);
    const fm = (fileOf(_h).milestones || []).filter(m => m.task === 'T1' && !m.deleted_at);
    ok('★里程碑都勾完了', live.filter(m => m.done === '1').length === 2, live.map(m => m.done));
    ok('★进度到 100', t1().progress === 100, t1().progress);
    ok('★★共享文件里也是勾完的（别被无基线保护挡回去）',
      fm.filter(m => m.done === '1').length === 2, fm.map(m => m.done));
  }

  section('八之二、★★"只知道动过整条"那条凭据：以本机为准，而且要报出来');
  {
    /* 里程碑被勾成已交付时只盖 stampMeta，不单独写变更日志、也没有字段标记
       （见 completeCheckpointsOf），所以它落在"只知道这条是我动过的"这条路径上。
       以前这里是回头用 rev 定胜负——而文件里那条 rev 可能被别的机器顶得很高，
       刚勾完的交付状态就会被判出去。现在一律以本机为准。 */
    base();
    await S.Repo.persist(S.DB); await tick(30);
    S.clearSyncBaseline(S.DB);
    S.clearLocallyChanged(S.DB);
    // 文件里那条里程碑被同事顶到很高的 rev
    const f = fileOf(_h);
    const m = f.milestones.find(x => x.id === 'M2');
    m.rev = 99; m.updated_at = new Date(Date.now() + 5000).toISOString(); m.updated_by = '同事乙';
    _h._text = JSON.stringify(f); _h._mtime++;
    // 本机把它勾成已交付（只盖戳，不写逐字段日志——跟 completeCheckpointsOf 一个形态）
    const local = S.byId('milestone', 'M2');
    local.done = '1'; local.actual_date = '2026-12-30';
    S.stampMeta(local);
    ok('前置：只有"整条"标记，没有字段标记',
      (S.DB.settings.dirtyKeys || []).indexOf('M2') !== -1
      && !((S.DB.settings.dirtyFields || {}).M2),
      { keys: S.DB.settings.dirtyKeys, fields: Object.keys(S.DB.settings.dirtyFields || {}) });
    const n0 = S.DB.changelog.length;
    await S.Repo.persist(S.DB); await tick(40);
    ok('★★刚勾的交付状态保住了（原来会被文件里 rev 99 那条顶掉）',
      (S.byId('milestone', 'M2') || {}).done === '1', (S.byId('milestone', 'M2') || {}).done);
    ok('★★共享文件里也是勾上的',
      ((fileOf(_h).milestones || []).find(x => x.id === 'M2') || {}).done === '1');
    const a = S.DB.changelog.slice(n0).filter(e => /以本机为准/.test(String(e.summary)));
    ok('★★报了出来，而且说清楚是"本机覆盖了文件"这个方向（不是"本机被丢弃"）',
      a.length === 1, S.DB.changelog.slice(n0).map(e => String(e.summary).slice(0, 60)));
    ok('★告警里说明了可能盖到同事、请核对', a.length === 1 && /核对/.test(a[0].summary),
      a[0] && a[0].summary);
  }

  section('八之三、★★★"整条以本机为准"绝不能把同事的删除撤销掉');
  {
    /* 这是我在第十六轮差点放进生产的一个回归：把"只知道动过整条"改成一律以本机为准之后，
       同事删掉的记录会在一台"带着整条标记"的机器上复活，而且被推回共享文件——
       等于替所有人把那次删除撤销掉。P49 那三条端到端用例当场变红。
       别的字段被盖掉，人看见了再改回来就行；记录复活是另一个量级的问题，
       而且正是这套系统最早那批事故（"删了又自己回来"）的形态。 */
    base();
    await S.Repo.persist(S.DB); await tick(30);
    S.clearSyncBaseline(S.DB);
    S.clearLocallyChanged(S.DB);
    // 同事把里程碑 M2 删了并推上去
    const f = fileOf(_h);
    const m = f.milestones.find(x => x.id === 'M2');
    m.deleted_at = new Date().toISOString();
    m.rev = (m.rev || 1) + 1;
    m.updated_at = new Date().toISOString(); m.updated_by = '同事乙';
    _h._text = JSON.stringify(f); _h._mtime++;
    // 本机这条恰好带着"我动过"的整条标记（只盖戳、没写逐字段日志）
    const local = S.byId('milestone', 'M2');
    local.report_level = 'section';
    S.stampMeta(local);
    ok('前置：本机这条有整条标记、而且还活着',
      (S.DB.settings.dirtyKeys || []).indexOf('M2') !== -1 && !local.deleted_at);
    await S.Repo.persist(S.DB); await tick(40);
    ok('★★★同事的删除生效了，没有被"以本机为准"撤销掉',
      !!(S.byId('milestone', 'M2') || {}).deleted_at, (S.byId('milestone', 'M2') || {}).deleted_at);
    ok('★★共享文件里它也还是删除状态（不能被推回去复活）',
      !!((fileOf(_h).milestones || []).find(x => x.id === 'M2') || {}).deleted_at);
    // 反方向：本机删、文件里还活着 → 本机的删除照常推出去
    base();
    await S.Repo.persist(S.DB); await tick(30);
    S.clearSyncBaseline(S.DB);
    S.clearLocallyChanged(S.DB);
    const mine = S.byId('milestone', 'M2');
    mine.deleted_at = new Date().toISOString();
    S.stampMeta(mine);
    await S.Repo.persist(S.DB); await tick(40);
    ok('★反方向不受影响：本机的删除照常推得出去',
      !!((fileOf(_h).milestones || []).find(x => x.id === 'M2') || {}).deleted_at);
  }

  section('九、★日志被登录记录挤过一轮之后，凭据还在（P103 分等级裁剪 × P106）');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    S.clearSyncBaseline(S.DB);
    const t = t1(); const b = JSON.parse(JSON.stringify(t));
    t.title = '我改的标题';
    S.logRecordChange('task', 'T1', b, t, ['title']);
    S.stampMeta(t);
    for (let i = 0; i < S.CHANGELOG_LIMIT + 200; i++) S.pushLoginLog('同事' + (i % 12), '登录');
    ok('★带明细的凭据没被登录记录挤掉',
      (S.DB.changelog || []).some(e => Array.isArray(e.changes) && e.changes.some(c => c.k === 'title')));
    colleagueEdits({}, 80);
    await S.Repo.persist(S.DB); await tick(40);
    ok('★★所以这次改动照样推得上去', t1().title === '我改的标题', t1().title);
  }

  section('十、★多轮同步之后不会来回打架（无基线设备混在里面）');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    const a = t1(); const ab = JSON.parse(JSON.stringify(a));
    a.custom = '甲写的备注';
    S.logRecordChange('task', 'T1', ab, a, ['custom']);
    S.stampMeta(a);
    await S.Repo.persist(S.DB); await tick(30);
    S.clearSyncBaseline(S.DB);
    const b2 = t1(); const bb = JSON.parse(JSON.stringify(b2));
    b2.title = '乙写的标题';
    S.logRecordChange('task', 'T1', bb, b2, ['title']);
    S.stampMeta(b2);
    await S.Repo.persist(S.DB); await tick(30);
    for (let i = 0; i < 3; i++) { await S.pullFromFile(); await tick(20); await S.Repo.persist(S.DB); await tick(20); }
    ok('★★两处改动都在，且不再变化', t1().title === '乙写的标题' && t1().custom === '甲写的备注',
      { title: t1().title, custom: t1().custom });
    ok('★★共享文件跟本机一致', ft().title === '乙写的标题' && ft().custom === '甲写的备注',
      { title: ft().title, custom: ft().custom });
  }

  section('十一、★提示变量不会跨轮泄漏（P102 / P103 的本机提示 × 多条同步路径）');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    const f = fileOf(_h);
    f.milestones.forEach(m => { if (m.id === 'M2') { m.done = '1'; m.rev = 9; m.updated_at = new Date().toISOString(); } });
    _h._text = JSON.stringify(f); _h._mtime++;
    await S.pullFromFile(); await tick(30);
    q('#snack-msg').textContent = ''; S.setSnackPriorityUntil(0);
    await S.Repo.persist(S.DB); await tick(30);
    await S.pullFromFile(); await tick(30);
    ok('★第二轮空同步不会冒出上一轮的提示',
      !/进回收站|没有保留/.test(q('#snack-msg').textContent), q('#snack-msg').textContent);
  }

  section('十二、★有未同步改动时不许自动重载（P105 × 未同步保护）');
  {
    base();
    await S.Repo.persist(S.DB); await tick(30);
    const nav = [];
    const realLoc = raw.location;
    raw.location = Object.defineProperty({ hash: '' }, 'href', {
      get() { return 'file:///C:/share/index.html'; }, set(v) { nav.push(v); } });
    try { S.storage.removeItem(S.STALE_RELOAD_KEY); } catch (e) {}
    S.DB.settings.pendingSync = true;
    S.DB.settings.maxSeenAppVersion = 'v29991231235959';
    ok('★有积压未同步时不自动重载', S.autoReloadForNewVersion() === false && nav.length === 0, nav);
    S.DB.settings.pendingSync = false;
    ok('★没有积压时才自动重载', S.autoReloadForNewVersion() === true && nav.length === 1, nav);
    raw.location = realLoc;
    try { S.storage.removeItem(S.STALE_RELOAD_KEY); } catch (e) {}
  }

  section('十三、★字段级凭据本身的口径');
  {
    base();
    S.clearLocallyChanged(S.DB);
    S.markLocallyChangedFields({ id: 'X' }, ['title', 'owner']);
    ok('记下了字段', JSON.stringify((S.DB.settings.dirtyFields || {}).X) === '["title","owner"]',
      (S.DB.settings.dirtyFields || {}).X);
    S.markLocallyChangedFields({ id: 'X' }, ['owner', 'status']);
    ok('★同一条记录多次标记取并集、不重复',
      JSON.stringify((S.DB.settings.dirtyFields || {}).X) === '["title","owner","status"]',
      (S.DB.settings.dirtyFields || {}).X);
    S.markLocallyChangedFields({ id: 'X' }, []);
    ok('空字段列表不动它', JSON.stringify((S.DB.settings.dirtyFields || {}).X) === '["title","owner","status"]');
    S.markLocallyChangedFields(null, ['a']);
    S.markLocallyChangedFields({}, ['a']);
    ok('空记录不抛异常', Object.keys(S.DB.settings.dirtyFields || {}).length === 1);
    S.clearLocallyChanged(S.DB);
    ok('★clearLocallyChanged 两种标记一起清',
      (S.DB.settings.dirtyKeys || []).length === 0 && Object.keys(S.DB.settings.dirtyFields || {}).length === 0);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
