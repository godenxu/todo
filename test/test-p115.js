/* P115：第二十三轮排查——静默投产后的版本/缓存全链路，外加一个更要命的发现

   ── 真问题（3 个） ──
   ① ★★详情弹窗开着期间发生一次同步，这次编辑就整个丢了，界面还提示"已保存"
      同步的最后一步是 Object.assign(DB, merged)——DB.tasks 被整个换成合并结果那个新数组，
      记录也是新对象。而详情弹窗的闭包里捏着的是打开那一刻的 t，它当场变成【孤儿】：
      不在 DB.tasks 里了，谁也看不见。用户点保存，Object.assign(t, collected) 改的就是
      这个被丢弃的对象，改动进不了 DB、也同步不出去，可界面照样弹"已保存"。
      定时同步几十秒一轮，详情弹窗又是开得最久的界面——这个组合在生产里一定经常发生，
      而它正是「我明明改了也保存了，回头一看没了」最直接的一条来路。
      修法：保存那一刻按 id 重新取一次记录；记录已被同事删掉时如实说明、不假装保存成功。

   ② 弹窗开着期间同事改了同一条任务，保存会把弹窗里的旧值原样写回去
      这一条跟①是同一个场景的另一面：就算拿到了最新对象，readControl 把每一格
      原样读回来，同事刚改的那一格也会被打开那一刻的旧值顶掉。
      三方合并救不了——从数据上看，这台机器"确实"把那一格改成了旧值（rev 更高、时间更新）。
      修法：拿保存时读到的值跟【打开那一刻的快照】比，一模一样就说明我没碰过这一格，
      那就不提交它，让同步进来的值留着；并且如实告诉用户哪几格保留了同事的改动
      （静默保住同样会让人意外——他明明看着旧值点的保存）。

   ③ 旧版门禁对"手上还压着没推出去的改动"的人只字不提
      门禁第三步写着"重新复制一份 html 覆盖本机这份"。有积压的人照做时如果换了个目录打开，
      浏览器存储是按来源隔离的，那些改动就再也找不回来了；退一步说，他压根不知道自己正压着东西，
      可能顺手就清了浏览器数据。
      修法：有积压时把这件事顶到最前面，讲清"会自动补推"和"在那之前别做什么"，
      并就地给一个导出按钮。这个导出刻意不走 exportJSON——那一条要 bulk_ops 权限，
      而走到这一屏的多半是普通同事，按下去只会被自己的权限闸拦住；
      而它要 bulk_ops 是有道理的（里面带着全部账号的 PIN 校验信息）。
      所以单独导一份剥掉账号的应急备份：业务数据一条不少，不需要任何权限，也不泄露校验信息。

   ── 查过没问题的，钉成护栏 ──
   静默投产整条路：读到更新版本写的文件会自动带 ?_=时间戳 重载一次（绕开浏览器缓存）；
   同一版本只自动试一次，之后改摆门禁（缓存顽固时不会陷入无限刷新）；
   开着弹窗/没有水位时不刷；升上去之后"试过"的标记会清掉（下次投产还能再自动刷）；
   被判定为旧版之后确实写不进共享文件、并挂上积压标记；
   管理员回滚版本时全处会被水位挡住，但"我确认要继续用这一份"这个逃生口真的管用；
   被停写期间攒的多轮改动，升级后会全部自动补推上去。
   另外：回收站过期记录不会在同步时被悄悄彻底删掉（只能管理员手工清且要求先有备份）；
   批量编辑 / 批量指派这两个长时间开着的界面都在回调里按 id 重新取，没有孤儿对象问题。

   用法：node test/test-p115.js */
const { sandbox: S, raw, q } = require('./harness.js');
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
let FILE = null;
const handle = { name: 'shared.json', _mtime: 1, _writes: 0,
  async getFile() { const s = FILE; return { lastModified: handle._mtime, text: async () => s }; },
  async createWritable() { return { async write(t) { handle._p = t; },
    async close() { FILE = handle._p; handle._mtime++; handle._writes++; } }; } };

// 记录"整页重载"有没有被触发（真实环境里就是换 location.href）
let _navigated = null;
const origLocation = raw.location;
function watchNav() {
  _navigated = null;
  raw.location = { get href() { return origLocation.href; }, set href(v) { _navigated = v; }, hash: '' };
  raw.window.location = raw.location;
}
function unwatchNav() { raw.location = origLocation; raw.window.location = origLocation; }

const origQSA = raw.document.querySelectorAll;
const stubCp = rows => { raw.document.querySelectorAll = sel =>
  (sel === '#cp-list [data-cp-row]' ? rows : (origQSA ? origQSA(sel) : [])); };
const unstubCp = () => { raw.document.querySelectorAll = origQSA; };

const NEWER = 'v29991231235959';
function world() {
  S.DB.settings.me = '管理员';
  S.DB.users = [
    { name: '管理员', role: 'admin', salt: 's', hash: 'h', iterations: 1, rev: 1,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' },
    { name: '同事小王', role: 'staff', salt: 's', hash: 'h', iterations: 1, rev: 1,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' },
  ];
  S.DB.permissionMatrix = null;
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    owner: '管理员', year: 2026, status: 'doing' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261', title: '原始标题',
    owner: '管理员', assignees: [], status: 'doing', priority: '2', progress: 0,
    plan_date: '2026-10-01', source: '原始来源', custom: '原始标签' }))];
  S.DB.milestones = []; S.DB.changelog = []; S.DB.purged = [];
  S.DB.settings.year = 2026;
  S.DB.settings.pendingSync = false;
  S.DB.settings.maxSeenAppVersion = '';
  S.clearSyncBaseline(S.DB); S.undoStack.length = 0;
  S.setSnackPriorityUntil(0); S.setLocalSaveFailedAt(0);
  S.setStaleAppBlocked(false); S.closeModal();
  try { S.storage.removeItem(S.STALE_RELOAD_KEY); } catch (e) {}
  S.rebuildIndex();
  FILE = JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
    writeId: 'w0', writeIds: ['w0'], lastWriteApp: S.APP_VERSION,
    tasks: cp(S.DB.tasks), works: cp(S.DB.works), duties: cp(S.DB.duties), users: cp(S.DB.users) }));
  handle._mtime = 1; handle._writes = 0;
  S.setFileHandle(handle); S.setEverConnected(true);
}
// 同事改了这条任务并推上去
function colleagueEdits(patch) {
  const p = JSON.parse(FILE);
  const t = (p.tasks || []).find(x => x.id === 'T1');
  Object.assign(t, patch, { rev: (t.rev || 1) + 5,
    updated_at: new Date(Date.now() + 10000).toISOString(), updated_by: '同事' });
  p.writeId = 'wC'; p.writeIds = ['w0', 'wC'];
  FILE = JSON.stringify(p); handle._mtime++;
}
// 管理员静默投产：共享文件变成"由更新版本写过"
function adminDeploys() {
  const p = JSON.parse(FILE);
  p.lastWriteApp = NEWER; p.lastWriteBy = '管理员'; p.lastWriteAt = new Date().toISOString();
  p.writeId = 'wNew'; p.writeIds = ['w0', 'wNew'];
  FILE = JSON.stringify(p); handle._mtime++;
}
function remoteWrittenBy(ver) {
  return Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
    writeId: 'w0', writeIds: ['w0'], lastWriteApp: ver, lastWriteBy: '管理员',
    tasks: cp(S.DB.tasks), works: cp(S.DB.works), duties: cp(S.DB.duties), users: cp(S.DB.users) });
}
// 把详情弹窗里每一格都填成"打开那一刻的值"，模拟用户什么都没动
function fillFormFromOpenState(t) {
  ['title', 'owner', 'source', 'custom', 'plan_date'].forEach(k => { q('#td-' + k).value = t[k]; });
  q('#td-priority').value = t.priority;
  q('#td-status').value = t.status;
}

async function main() {
  await tick(120);

  /* ═════════ ① 详情弹窗的孤儿对象 ═════════ */
  section('①-1 ★★弹窗开着期间同步过一次，保存还算不算数');
  {
    world();
    stubCp([]);
    S.openTaskDetail('T1'); await tick(50);
    const tOld = S.byId('task', 'T1');
    const arrOld = S.DB.tasks;
    // 后台同步（同事改了别的字段）
    colleagueEdits({ custom: '同事改的标签' });
    await S.pullFromFile(); await tick(80);
    ok('（前提）同步确实把 DB.tasks 换成了新数组', arrOld !== S.DB.tasks);
    ok('（前提）记录也换成了新对象——弹窗闭包里那个 t 已经是孤儿',
      tOld !== S.byId('task', 'T1'));
    // 用户改了标题后保存
    fillFormFromOpenState(tOld);
    q('#td-title').value = '我改的标题';
    q('#snack-msg').textContent = '';
    await S.modalCallback(); await tick(150);
    unstubCp();
    const t = S.byId('task', 'T1');
    ok('★★改动真的写进了 DB（原来写到被丢弃的孤儿对象上，整次编辑白做，'
      + '界面还提示"已保存"——这正是"我明明改了也保存了，回头一看没了"的来路）',
      t.title === '我改的标题', { title: t.title });
    ok('★同事在这期间改的别的字段没被波及', t.custom === '同事改的标签', t.custom);
    ok('★改动也推到了共享文件里',
      ((JSON.parse(FILE).tasks || []).find(x => x.id === 'T1') || {}).title === '我改的标题');
  }

  section('①-2 弹窗开着时这条被同事删了，保存不能假装成功');
  {
    world();
    stubCp([]);
    S.openTaskDetail('T1'); await tick(50);
    // 同事把它彻底删了（不是软删——软删的记录 byId 还找得到）
    const p = JSON.parse(FILE);
    p.tasks = []; p.purged = [{ entity: 'task', id: 'T1', at: new Date().toISOString(), by: '同事' }];
    p.writeId = 'wD'; p.writeIds = ['w0', 'wD'];
    FILE = JSON.stringify(p); handle._mtime++;
    await S.pullFromFile(); await tick(80);
    ok('（前提）这条记录已经不在了', !S.byId('task', 'T1'));
    q('#snack-msg').textContent = '';
    let err = '';
    try { await S.modalCallback(); await tick(120); } catch (e) { err = e.message; }
    unstubCp();
    ok('不抛异常', !err, err);
    const msg = q('#snack-msg').textContent || '';
    ok('★★如实说明这次修改没保存，而不是弹一句"已保存"',
      /已经被删掉|没有保存/.test(msg), msg);
    ok('★没有把删掉的记录又造回来（记录复活会被推回共享文件，替所有人抹掉那次删除）',
      !S.byId('task', 'T1'));
  }

  section('①-3 ★同事改过的那一格，不能被弹窗里的旧值顶回去');
  {
    world();
    stubCp([]);
    S.openTaskDetail('T1'); await tick(50);
    const tOpen = cp(S.byId('task', 'T1'));
    fillFormFromOpenState(tOpen);
    q('#td-source').value = '我改的来源';        // 我只动了这一格
    colleagueEdits({ title: '同事改的标题' });    // 同事动的是标题
    await S.pullFromFile(); await tick(80);
    q('#snack-msg').textContent = '';
    await S.modalCallback(); await tick(150);
    unstubCp();
    const t = S.byId('task', 'T1');
    ok('★★同事改的标题保住了（我没碰过这一格，不该拿打开时的旧值去盖他）',
      t.title === '同事改的标题', t.title);
    ok('★我真正改的那一格写进去了', t.source === '我改的来源', t.source);
    const msg = q('#snack-msg').textContent || '';
    ok('★★而且告诉了我哪几格保留了同事的改动——静默保住同样会让人意外，'
      + '我明明看着旧值点的保存', /被同事改过|保留他的改动/.test(msg), msg);
  }

  section('①-4 我和同事改的是同一格：以我为准（我是明确要改它的）');
  {
    world();
    stubCp([]);
    S.openTaskDetail('T1'); await tick(50);
    fillFormFromOpenState(cp(S.byId('task', 'T1')));
    q('#td-title').value = '我改的标题';
    colleagueEdits({ title: '同事改的标题' });
    await S.pullFromFile(); await tick(80);
    await S.modalCallback(); await tick(150);
    unstubCp();
    ok('★★我明确改过的那一格以我为准（这才是"保存"的本意）',
      S.byId('task', 'T1').title === '我改的标题', S.byId('task', 'T1').title);
  }

  section('①-5 没有并发时一切照旧（别为了这道检查把正常保存弄坏）');
  {
    world();
    stubCp([]);
    S.openTaskDetail('T1'); await tick(50);
    fillFormFromOpenState(cp(S.byId('task', 'T1')));
    q('#td-title').value = '我改的标题';
    q('#td-source').value = '我改的来源';
    q('#snack-msg').textContent = '';
    await S.modalCallback(); await tick(150);
    unstubCp();
    const t = S.byId('task', 'T1');
    ok('★两格都写进去了', t.title === '我改的标题' && t.source === '我改的来源',
      { title: t.title, source: t.source });
    ok('★没有无谓的"同事改过"提示', !/被同事改过/.test(q('#snack-msg').textContent || ''),
      q('#snack-msg').textContent);
  }

  section('①-6 新建任务不走这套（没有"打开时的样子"可比）');
  {
    world();
    stubCp([]);
    let err = '';
    try {
      S.openNewTask(); await tick(50);
      q('#td-title').value = '新建的任务';
      if (typeof S.modalCallback === 'function') { await S.modalCallback(); await tick(150); }
    } catch (e) { err = e.message; }
    unstubCp();
    ok('新建路径不抛异常', !err, err);
    ok('★新建照常能建起来', S.DB.tasks.filter(x => !x.deleted_at).length === 2,
      S.DB.tasks.filter(x => !x.deleted_at).length);
    ok('★源码里这道检查挂在 openSnap 上，而 openSnap 对新建是 null',
      /const openSnap = isNew \? null : clone\(t\);/.test(SRC));
  }

  section('①-7 源码层面：保存时必须按 id 重新取记录');
  {
    ok('★★闭包里那个 t 声明成了 let（否则重新取不了）',
      /let t = isNew \? draft : byId\('task', id\);/.test(SRC));
    ok('★★保存回调开头按 id 重新取了一次',
      /const fresh = byId\('task', id\);/.test(SRC) && /t = fresh;/.test(SRC));
    ok('★取不到（被同事删了）时如实说明，不假装保存成功',
      /这条任务已经被删掉了（可能是同事刚删的），这次的修改没有保存/.test(SRC)
      || /这条任务已经被删掉了/.test(SRC));
  }

  /* ═════════ ② 静默投产 / 浏览器缓存 ═════════ */
  section('②-1 读到更新版本写的文件，要自己带缓存破坏参数重载一次');
  {
    world();
    watchNav();
    const okv = S.checkAppVersion(remoteWrittenBy(NEWER));
    unwatchNav();
    ok('判定为旧版、停写', okv === false);
    ok('★记下了版本水位', S.DB.settings.maxSeenAppVersion === NEWER, S.DB.settings.maxSeenAppVersion);
    ok('★★自动触发了整页重载（"同事只要刷新就能用上新版"全指望这一步）', !!_navigated, _navigated);
    ok('★★地址带了 ?_=时间戳 绕开浏览器缓存（不带的话浏览器多半又把旧的那份给回来）',
      /\?_=\d+/.test(_navigated || ''), _navigated);
  }

  section('②-2 ★刷完还是旧的（缓存顽固）——不许陷入无限刷新');
  {
    world();
    watchNav();
    S.checkAppVersion(remoteWrittenBy(NEWER));
    const first = _navigated;
    _navigated = null;
    S.setStaleAppBlocked(false);
    S.checkAppVersion(remoteWrittenBy(NEWER));
    const second = _navigated;
    unwatchNav();
    ok('第一次自动刷了', !!first);
    ok('★★同一个版本只自动试一次，第二次改为摆门禁（否则缓存顽固时页面会一直刷，'
      + '同事什么都干不了）', !second, second);
    ok('★门禁摆出来了，并给了 Ctrl+F5 等具体办法',
      /旧版本/.test(q('#login-body').innerHTML || '') && /Ctrl/.test(q('#login-body').innerHTML || ''));
  }

  section('②-3 自动刷新的几道闸：开着弹窗 / 没有水位时不许刷');
  {
    world();
    /* 必须先把水位摆上，否则 autoReloadForNewVersion 第一行
       （没有水位就直接返回）就把函数挡住了，后面那道"开着弹窗别刷"的闸根本走不到——
       这条断言会变成永远绿的空壳（变异测试当场抓到过）。 */
    S.DB.settings.maxSeenAppVersion = NEWER;
    try { S.storage.removeItem(S.STALE_RELOAD_KEY); } catch (e) {}
    ok('（前提）水位在、标记也清了，这时候本来是该刷的',
      !!S.DB.settings.maxSeenAppVersion);
    q('#modal-overlay').classList.add('show');
    watchNav();
    const r1 = S.autoReloadForNewVersion();
    unwatchNav();
    q('#modal-overlay').classList.remove('show');
    ok('★★开着弹窗时不刷新（整页重载会把人正在填的东西全冲掉）', !r1 && !_navigated, _navigated);
    // 反面：关掉弹窗就该刷了，证明上面挡住它的确实是"弹窗开着"这一条
    watchNav();
    const r1b = S.autoReloadForNewVersion();
    unwatchNav();
    ok('★关掉弹窗之后确实会刷（证明挡住它的就是弹窗那道闸）', r1b && !!_navigated, _navigated);
    world();
    S.DB.settings.maxSeenAppVersion = '';
    watchNav();
    const r2 = S.autoReloadForNewVersion();
    unwatchNav();
    ok('★没有水位时不刷新（无谓的整页重载）', !r2 && !_navigated);
  }

  section('②-4 升上去之后要把"试过"的标记清掉');
  {
    world();
    watchNav();
    S.checkAppVersion(remoteWrittenBy(NEWER));
    unwatchNav();
    let mark = '';
    try { mark = S.storage.getItem(S.STALE_RELOAD_KEY) || ''; } catch (e) {}
    ok('自动刷新时留下了标记（防重复刷）', mark === NEWER, mark);
    S.DB.settings.maxSeenAppVersion = S.APP_VERSION;
    S.setStaleAppBlocked(false);
    S.checkAppVersion(remoteWrittenBy(S.APP_VERSION));
    let mark2 = 'x';
    try { mark2 = S.storage.getItem(S.STALE_RELOAD_KEY); } catch (e) {}
    ok('★★升上去之后标记清掉了——不清的话下次投产这台机器不会再自动刷，'
      + '同事又得手工 Ctrl+F5，静默投产就没意义了', mark2 === null, mark2);
  }

  section('②-5 被判定为旧版之后，确实写不进共享文件');
  {
    world();
    adminDeploys();
    S.setStaleAppBlocked(false);
    await S.pullFromFile(); await tick(60);
    ok('（前提）被停写了', S.staleAppBlocked);
    const before = FILE;
    const t = S.byId('task', 'T1');
    t.progress = 88; S.stampMeta(t);
    await S.Repo.persist(S.DB); await tick(80);
    const remoteT = (JSON.parse(FILE).tasks || []).find(x => x.id === 'T1') || {};
    ok('★★旧版本的改动没有写进共享文件（旧版可能带着已经修好的 bug，'
      + '它一写就可能把大家的数据改坏）', remoteT.progress !== 88, remoteT.progress);
    ok('★★但挂上了积压标记，改动没被静默丢掉', S.DB.settings.pendingSync);
    ok('★本机内存里的改动还在', S.byId('task', 'T1').progress === 88);
  }

  section('②-6 ★★升级之后，被停写期间攒的改动要全部自动补推上去');
  {
    // 接着上一节的状态：还压着 progress=88
    const t = S.byId('task', 'T1');
    t.source = '停写期间改的来源'; S.stampMeta(t);
    S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: 'Mx', task: 'T1',
      plan_date: '2026-09-30', deliverable: '停写期间新建的交付物', report_level: 'section', done: '0' })));
    S.rebuildIndex();
    await S.Repo.persist(S.DB); await tick(60);
    ok('（前提）还压着', S.DB.settings.pendingSync);
    // 同事升级了：本机不再落后
    S.DB.settings.maxSeenAppVersion = S.APP_VERSION;
    S.setStaleAppBlocked(false);
    const p = JSON.parse(FILE); p.lastWriteApp = S.APP_VERSION; FILE = JSON.stringify(p);
    await S.Repo.persist(S.DB); await tick(120);
    const rp = JSON.parse(FILE);
    const rt = (rp.tasks || []).find(x => x.id === 'T1') || {};
    const rm = (rp.milestones || []).find(x => x.id === 'Mx');
    ok('★★停写期间改的字段补推上去了', rt.source === '停写期间改的来源', rt.source);
    ok('★★停写期间新建的里程碑也补上了', !!rm);
    ok('★积压标记撤掉了（顶栏那个红色提示该消失了）', !S.DB.settings.pendingSync);
  }

  section('②-7 管理员回滚版本时，逃生口要真的管用');
  {
    world();
    S.checkAppVersion(remoteWrittenBy(NEWER));
    ok('（前提）水位被抬高了', S.DB.settings.maxSeenAppVersion === NEWER);
    S.setStaleAppBlocked(false);
    ok('（前提）管理员换回旧版后，全处仍被自己的水位挡着',
      S.checkAppVersion(remoteWrittenBy(S.APP_VERSION)) === false);
    /* 水位只升不降是刻意的（防止旧版客户端把 lastWriteApp 写回旧版号来自行解除封锁）。
       代价就是这一幕：管理员投产一个有问题的版本再退回去，全处所有人被永久挡住。
       所以这个逃生口不是可有可无的装饰。 */
    S.ACTIONS['ignore-stale-app-confirm']();
    await tick(60);
    ok('★★"我确认要继续用这一份"把水位压回了当前版本',
      S.DB.settings.maxSeenAppVersion === S.APP_VERSION, S.DB.settings.maxSeenAppVersion);
    S.setStaleAppBlocked(false);
    ok('★★之后不再被挡（否则管理员一旦回滚，全处永久停写，救不回来）',
      S.checkAppVersion(remoteWrittenBy(S.APP_VERSION)) === true);
  }

  section('②-8 本机缓存写不进去时，版本水位落不了盘要说话');
  {
    world();
    const store = S.storage, orig = store.setItem;
    store.setItem = function (k, v) {
      if (k === S.STORAGE_KEY) { const e = new Error('Quota'); e.name = 'QuotaExceededError'; throw e; }
      return orig.call(store, k, v);
    };
    S.setLocalSaveFailedAt(0);
    q('#snack-msg').textContent = '';
    watchNav();
    S.checkAppVersion(remoteWrittenBy(NEWER));
    unwatchNav();
    store.setItem = orig;
    ok('内存里的水位记住了', S.DB.settings.maxSeenAppVersion === NEWER);
    ok('★★落盘失败会说话——水位存不住的话，刷新之后门禁就失效了，'
      + '旧版客户端会继续往共享文件里写',
      /本机缓存写不进去|存储满/.test(q('#snack-msg').textContent || ''), q('#snack-msg').textContent);
    S.setLocalSaveFailedAt(0);
  }

  /* ═════════ ③ 门禁对"压着改动"的人 ═════════ */
  section('③-1 有积压 / 没积压时，门禁说的话不一样');
  {
    world();
    S.DB.settings.pendingSync = false;
    S.showStaleAppGate();
    const plain = q('#login-body').innerHTML || '';
    S.DB.settings.pendingSync = true;
    S.showStaleAppGate();
    const withPending = q('#login-body').innerHTML || '';
    ok('★没积压时不吓唬人（说了反而让人不敢升级）',
      !/还有改动没有推到共享文件/.test(plain));
    ok('★★有积压时把这件事顶到最前面——门禁第三步写着"重新复制一份 html 覆盖本机这份"，'
      + '他要是换个目录打开，浏览器存储按来源隔离，那些改动就找不回来了',
      /还有改动没有推到共享文件/.test(withPending));
    for (const [what, re] of [
      ['升级后会自动补推', /自动补推/],
      ['别清浏览器缓存/站点数据', /不要清理浏览器缓存|站点数据/],
      ['换 html 要覆盖原文件、别换目录', /覆盖原来那个文件|不要复制到别的文件夹/],
    ]) ok('★提示里讲到了' + what, re.test(withPending));
    ok('★有积压时给了导出按钮', /data-act="stale-export-backup"/.test(withPending));
    ok('★没积压时不摆这个按钮（无谓的噪音）', !/data-act="stale-export-backup"/.test(plain));
  }

  section('③-2 ★那个应急导出：普通员工要按得动，且不能漏 PIN 信息');
  {
    world();
    S.DB.settings.me = '同事小王';     // 员工，没有 bulk_ops
    S.DB.settings.pendingSync = true;
    S.rebuildIndex();
    ok('（前提）员工确实没有 bulk_ops', !S.hasPermission('bulk_ops'));
    let out = '';
    const origBlob = raw.Blob;
    raw.Blob = function (parts) { out = (parts || []).join(''); return { size: 1 }; };
    let err = '';
    try { S.ACTIONS['stale-export-backup'](); await tick(40); } catch (e) { err = e.message; }
    raw.Blob = origBlob;
    ok('不抛异常', !err, err);
    ok('★★员工按得动——走到这一屏的多半就是普通同事，'
      + '不能给一根按不动的救命稻草（exportJSON 那条要 bulk_ops）', !!out, out.length);
    let d = null;
    try { d = JSON.parse(out); } catch (e) {}
    ok('导出的是合法 JSON', !!d);
    ok('★★账号整个剥掉了，不泄露任何 PIN 校验信息（全量备份要 bulk_ops 正是因为带着这些）',
      d && !('users' in d), d && Object.keys(d).filter(k => k === 'users'));
    ok('★业务数据一条不少（这才是他怕丢的东西）', d && (d.tasks || []).length > 0);
    ok('★标了来路，管理员拿到时分得清这是什么文件', d && d._staleEmergency === true);
    ok('★也不含本机私有的同步基线（跟正式备份同一个口径）', d && !('syncBase' in d));
  }

  /* ═════════ ④ 重查：别的长时间开着的界面有没有同样的孤儿问题 ═════════ */
  section('④-1 批量编辑：勾好之后同步过一次，确定还算不算数');
  {
    world();
    S.setPage('tasks'); S.renderTasks(); await tick(20);
    S.UI.tasks.sel.clear();
    S.ACTIONS['sel-row']({ id: 'T1' }, { checked: true });
    ok('（前提）勾中了', S.UI.tasks.sel.size === 1);
    S.openBatchEdit('priority'); await tick(50);
    colleagueEdits({ custom: '同事改的标签' });
    await S.pullFromFile(); await tick(80);
    q('#be-priority').value = '1';
    let err = '';
    try { await S.modalCallback(); await tick(150); } catch (e) { err = e.message; }
    ok('不抛异常', !err, err);
    ok('★★批量编辑在同步之后照样生效（它的回调里是按 id 重新取的，没有孤儿问题）',
      S.byId('task', 'T1').priority === '1', S.byId('task', 'T1').priority);
  }

  section('④-2 回收站过期记录不会在同步时被悄悄彻底删掉');
  {
    world();
    S.DB.shareConfig = S.stampMeta({ recycleKeepDays: 30 });
    const old = S.stampMeta(S.blank('task', { id: 'TOLD', work: 'w1', code: '0101299',
      title: '很久以前删的', owner: '管理员', status: 'doing', priority: '2' }));
    old.deleted_at = '2020-01-01T00:00:00.000Z';
    S.DB.tasks.push(old); S.rebuildIndex();
    ok('（前提）这条确实过期了', old.deleted_at < S.recycleCutoff());
    const before = S.DB.tasks.length;
    await S.pullFromFile(); await tick(60);
    await S.Repo.persist(S.DB); await tick(60);
    ok('★★同步不会自动彻底删除过期记录——彻底删除不可撤销，'
      + '不该在没人看着的时候发生（只能管理员在回收站页手工清，而且要求先有备份）',
      S.DB.tasks.length === before, { before, after: S.DB.tasks.length });
    const calls = (SRC.match(/purgeRecycleBin\(/g) || []).length;
    ok('★purgeRecycleBin 只有定义和那一个手工入口', calls === 2, calls);
  }

  section('④-3 「按日志修复」不会去动派生字段');
  {
    world();
    // 造一条有里程碑的任务：它的 progress 从此是派生的
    S.DB.milestones = [S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1',
      plan_date: '2026-09-20', deliverable: '材料', report_level: 'section', done: '0' }))];
    S.rebuildIndex();
    const t = S.byId('task', 'T1');
    const before = cp(t);
    t.progress = 100; S.stampMeta(t);
    S.logRecordChange('task', 'T1', before, t, ['progress']);
    S.recalcProgress(t);   // 派生重算：1 条未完成 → 0%
    const issues = S.auditByChangelog();
    const prog = issues.filter(i => i.field === 'progress');
    ok('核对报出了这处对不上', prog.length === 1, issues.map(i => i.field));
    ok('★★但它被标成派生字段', prog.length === 1 && prog[0].derived === true, prog[0]);
    ok('★★不参与修复（修了会被重算回去，还会留下一条假的修复记录，越点越多）',
      S.repairableIssues(issues).filter(i => i.field === 'progress').length === 0);
    const r = await S.repairByChangelog(issues);
    await tick(60);
    ok('★修复报告如实说"跳过"，不虚报', r.ok === 0 && r.skipped >= 1, r);
    ok('★数据一动不动', S.byId('task', 'T1').progress === 0, S.byId('task', 'T1').progress);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { unwatchNav(); unstubCp(); console.error('测试异常：', e); process.exit(1); });
