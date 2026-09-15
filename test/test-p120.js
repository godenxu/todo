/* P120：第二十八轮排查——共享文件本身出事的时候

   前几轮查的都是"两个人同时改"。这一轮查"文件本身被弄乱了"：被挪走、被清空、被一份旧内容替换、选错了文件夹。
   这类事故没有服务器兜底，一旦发生是全处级别的。全部实测复现过，修复前的版本逐条会红。

   ── 共享文件被一份旧内容整个替换 ──
   ① ★★共享文件被清空后，由一台一个月没开的旧缓存机器用旧数据重建（或者 IT 从旧备份拷回去）——
      【所有】在线同事的电脑同步时，把一个月的改动当成"对方改回了旧值"，全部跟着倒退，再写回文件。
      原有的"保存被覆盖"检测只保护最近半小时写过文件的那一台，其他人毫无防护，也没有任何告警。
      修法：写入链里找不到"我这份基线对应的那次写入" + 这条记录版本号比我基线还低且内容不同，
      两者同时成立才判为旧内容，本机较新的值胜出并推回；对方在旧底子上留有逐字段日志的真实修改照常采纳。
   ② 没有基线的合并"整条以本机为准"时沿用本机偏低的版本号——P118"版本号倒退"的漏网分支，
      也会让 ① 的检测误判

   ── 连接共享文件夹 ──
   ③ ★首次连接到一个还没有数据文件的文件夹：本机数据被一份空数据整批替换（任务 2→0）。
      管理员把共享文件夹迁到新位置（先断开、再连新文件夹）就会撞上
   ④ 连到空文件夹（选错了）时只提示"已连接"，程序在那里新建文件、从此跟全处分家，两边都看不出来
   ⑤ 重新连接那条合并路径补上 ① 的检测

   ── 查过没问题的 ──
   时区（时间戳截日期都走了 localDay）、界面转义（动态注入标记渲染了全部页面和主要弹窗，全部正确转义）、
   读到 0 字节文件时本机数据不丢、正常多设备协作长跑中 ① 的检测零误触发。

   用法：node test/test-p120.js */
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
const LATER = () => new Date(Date.now() + 60000).toISOString();

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
let FILE = null;
const handle = { name: 'shared.json', _mtime: 1,
  async getFile() { const s = FILE; return { lastModified: handle._mtime, text: async () => s }; },
  async createWritable() { return { async write(t) { handle._p = t; },
    async close() { FILE = handle._p; handle._mtime++; } }; } };

const USER = (name, role) => ({ name, role, salt: 's', hash: 'h', iterations: 1, rev: 1,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' });
const OLD = new Date(Date.now() - 200 * 86400000).toISOString();

function world(opt) {
  const o = opt || {};
  S.closeModal();
  S.DB.settings.me = '管理员';
  S.DB.users = [USER('管理员', 'admin'), USER('小王', 'staff')].concat(o.users || []);
  S.DB.permissionMatrix = null;
  S.DB.duties = [
    S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' })),
    S.stampMeta(S.blank('duty', { code: '02', category: '一、前瞻研判', name: '职责二' })),
  ];
  S.DB.works = [
    S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一', owner: '管理员', year: 2026, status: 'doing' })),
    S.stampMeta(S.blank('work', { id: 'w2', code: '0102', duty: '01', name: '工作二', owner: '管理员', year: 2026, status: 'doing' })),
  ];
  const T = (id, extra) => S.stampMeta(S.blank('task', Object.assign({ id, work: 'w1', code: '01012' + id, title: '任务' + id,
    owner: '管理员', assignees: [], status: 'doing', priority: '2', progress: 0,
    plan_date: '2026-12-31', actual_date: '', source: '', custom: '' }, extra)));
  S.DB.tasks = [T('T1'), T('T2')].concat((o.tasks || []).map(x => T(x.id, x)));
  S.DB.milestones = [S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', plan_date: '2026-09-20',
    deliverable: '调研报告', report_level: 'section', done: '0' }))].concat(o.milestones || []);
  S.DB.changelog = []; S.DB.purged = [];
  S.DB.settings.year = 2026; S.DB.settings.pendingSync = false; S.DB.settings.maxSeenAppVersion = '';
  S.DB.settings.lastBackupAt = new Date().toISOString();
  S.clearSyncBaseline(S.DB); S.undoStack.length = 0;
  S.setSnackPriorityUntil(0); S.setLocalSaveFailedAt(0); S.setStaleAppBlocked(false);
  S.UI.tasks.sel.clear(); S.UI.tasks.filters = {}; S.UI.tasks.search = '';
  S.rebuildIndex();
  const filePart = o.file ? o.file(cp(S.DB)) : cp(S.DB);
  FILE = JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
    writeId: 'w0', writeIds: ['w0'], lastWriteApp: S.APP_VERSION,
    tasks: filePart.tasks, works: filePart.works, duties: filePart.duties,
    milestones: filePart.milestones, users: filePart.users }));
  handle._mtime = 1; S.setFileHandle(handle); S.setEverConnected(true);
}
// 同事改文件：fn 拿到 payload 直接改；被改的记录自己负责抬 rev / updated_at
function colleague(fn) {
  const p = JSON.parse(FILE);
  fn(p);
  p.writeId = 'wC' + Math.random(); p.writeIds = ['w0', p.writeId];
  FILE = JSON.stringify(p); handle._mtime++;
}
const bump = r => Object.assign(r, { rev: (r.rev || 1) + 5, updated_at: LATER(), updated_by: '同事' });
const F = () => JSON.parse(FILE);
const fRec = (ent, key, id) => (F()[ent] || []).find(x => x[key] === id);
// 模拟"打开之前就发出去的那一轮同步，在确认框/编辑框开着时落地"
async function landSync(fn) { colleague(fn); await S.pullFromFile(); await tick(60); }
async function confirmNow() {
  const cb = S.modalCallback;
  if (typeof cb === 'function') { await cb(); await tick(200); }
  return typeof cb === 'function';
}

function makeFakeIndexedDB() {
  const store = new Map();
  function makeTx() {
    const tx = { onerror: null };
    tx.objectStore = () => ({
      get(key) {
        const req = {};
        setTimeout(() => { req.result = store.get(key); if (req.onsuccess) req.onsuccess(); }, 0);
        return req;
      },
      put(val, key) { store.set(key, val); },
      delete(key) { store.delete(key); },
    });
    let _oncomplete = null;
    Object.defineProperty(tx, 'oncomplete', {
      get() { return _oncomplete; },
      set(fn) { _oncomplete = fn; setTimeout(() => fn && fn(), 0); },
    });
    return tx;
  }
  return {
    open() {
      const req = {};
      const db = { transaction: () => makeTx(), createObjectStore() {} };
      setTimeout(() => { req.result = db; if (req.onupgradeneeded) req.onupgradeneeded(); if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
  };
}
// 连接流程在本机没有账号时会停在'等待登录'上不返回——测试不能因此卡死，最多等 2 秒再断言
const connectWithin = () => Promise.race([S.connectSharedFile(), tick(2000)]).then(() => tick(250));
const alertsMatching = re => S.DB.changelog.filter(e => e.kind === S.ALERT_LOG_KIND && re.test(e.summary || ''));

async function main() {
  await tick(150);

  section('① ★★共享文件被一台旧缓存机器用一个月前的数据重建');
  {
    world();
    const stale = JSON.parse(FILE);
    const t = S.byId('task', 'T1'); t.title = '一个月后的新标题'; t.status = 'done'; t.progress = 100; t.actual_date = '2026-09-01';
    S.stampMeta(t); S.stampMeta(t); S.stampMeta(t);
    const m = S.byId('milestone', 'M1'); m.done = '1'; m.actual_date = '2026-08-20'; S.stampMeta(m); S.stampMeta(m);
    // 这一个月里我也改过 T2 的优先级——这样 T2 在旧文件里才是"比我看到的还旧"的那种记录
    const mt2 = S.byId('task', 'T2'); mt2.priority = '1'; S.stampMeta(mt2); S.stampMeta(mt2);
    await S.Repo.persist(S.DB); await tick(60);
    // 旧机器 A 在旧底子上也真改了一处（T2 的来源），并留下了逐字段日志
    const t2 = stale.tasks.find(x => x.id === 'T2'); t2.source = 'A 在旧数据上改的来源'; t2.rev = (t2.rev || 1) + 1;
    stale.changelog = [{ id: 'logA1', at: LATER(), by: '老机器A', kind: 'edit', entity: 'task', refId: 'T2', taskId: 'T2',
      summary: '来源：空→A 在旧数据上改的来源', changes: [{ k: 'source', from: '', to: 'A 在旧数据上改的来源' }] }];
    stale.writeId = 'wA'; stale.writeIds = ['*reset*', 'wA'];   // 从空文件重建：链以哨兵开头
    stale.lastWriteBy = '老机器A'; stale.lastWriteAt = LATER(); stale.lastWriteApp = S.APP_VERSION;
    stale.datasetId = JSON.parse(FILE).datasetId;
    FILE = JSON.stringify(stale); handle._mtime++;
    S.setLastWriteId(''); S.DB.settings.lastWriteId = ''; S.DB.settings.lastWriteIdAt = '';   // 我近期没写过，"被覆盖"检测管不到
    await S.pullFromFile(); await tick(60);
    const lt = S.byId('task', 'T1'), lm = S.byId('milestone', 'M1');
    ok('★本机没有跟着倒退（标题、已完成、里程碑交付）', lt.title === '一个月后的新标题' && lt.status === 'done' && lm.done === '1',
      { title: lt.title, status: lt.status, done: lm.done });
    ok('★旧机器在旧底子上留有日志的真实修改照常采纳', S.byId('task', 'T2').source === 'A 在旧数据上改的来源', S.byId('task', 'T2').source);
    ok('★同一条记录上我这一个月改的优先级没有跟着倒退', S.byId('task', 'T2').priority === '1', S.byId('task', 'T2').priority);
    ok('★记了告警，点名是谁的文件', alertsMatching(/疑似被一份旧内容整个替换/).some(e => /老机器A/.test(e.summary)));
    await S.Repo.persist(S.DB); await tick(60);
    ok('★较新的内容推回了共享文件', fRec('tasks', 'id', 'T1').title === '一个月后的新标题' && fRec('milestones', 'id', 'M1').done === '1');

    // 正常协作：同事在我那份上接着写（链续上），不许误报、不许干预
    world();
    await S.Repo.persist(S.DB); await tick(40);
    const before = alertsMatching(/疑似被一份旧内容/).length;
    colleague(p => { bump(Object.assign(p.tasks.find(x => x.id === 'T1'), { title: '同事改的' })); });
    { const p = F(); p.writeIds = (JSON.parse(FILE).writeIds || []); FILE = JSON.stringify(p); }
    const p = F(); const baseW = S.DB.syncBase.writeId; p.writeIds = [baseW, 'wC2']; p.writeId = 'wC2'; FILE = JSON.stringify(p); handle._mtime++;
    await S.pullFromFile(); await tick(40);
    ok('正常接着写的文件：同事的改动照常进来', S.byId('task', 'T1').title === '同事改的');
    ok('正常接着写的文件：不报旧内容告警', alertsMatching(/疑似被一份旧内容/).length === before);
  }

  section('② 没有基线、整条以本机为准时，版本号不许比文件低');
  {
    const local = { id: 'X', title: '本机', status: 'doing', rev: 3, updated_by: '甲', updated_at: '2026-09-02T00:00:00.000Z' };
    const remote = { id: 'X', title: '文件', status: 'doing', rev: 8, updated_by: '乙', updated_at: '2026-09-01T00:00:00.000Z' };
    const r = S.mergeWithoutBase('task', local, remote, { fields: new Map([['task X', null]]), dirty: new Set() });
    ok('以本机为准', r.title === '本机');
    ok('★版本号压过文件那条（原来沿用本机的 3，文件 8→3 倒退）', r.rev > 8, r.rev);
  }

  section('③④ 连接到一个还没有数据文件的文件夹');
  {
    raw.indexedDB = makeFakeIndexedDB();
    const dir = { kind: 'directory', name: '新文件夹', async requestPermission() { return 'granted'; },
      async queryPermission() { return 'granted'; }, async getFileHandle() { return handle; } };
    raw.window.showDirectoryPicker = async () => dir;

    world();
    S.setFileHandle(null); S.setEverConnected(false);
    FILE = ''; handle._mtime = 1;
    const n0 = S.DB.tasks.length;
    await connectWithin();
    ok('★首次连接空文件夹：本机数据还在（原来被空数据整批替换）', S.DB.tasks.length === n0 && !!S.byId('task', 'T1'), S.DB.tasks.length);
    let fileTasks = -1; try { fileTasks = JSON.parse(FILE).tasks.length; } catch (e) {}
    ok('★本机数据作为初始内容写进了新文件', fileTasks === n0, fileTasks);
    ok('★明确告警"原来没有数据文件、已新建"，并提醒选错要断开', alertsMatching(/原来没有数据文件/).some(e => /立刻断开/.test(e.summary)));

    // 非首次（这个假 IndexedDB 里已经存过句柄了）：再连到另一个空文件夹
    world();
    S.setFileHandle(null);
    FILE = ''; handle._mtime = 1;
    const a0 = alertsMatching(/原来没有数据文件/).length;
    await connectWithin();
    ok('★非首次连到空文件夹同样告警（选错文件夹会悄悄跟全处分家）', alertsMatching(/原来没有数据文件/).length === a0 + 1);
    ok('本机数据仍在', !!S.byId('task', 'T1'));

    // 回归：首次连接到有数据的文件夹，仍然整份采用文件（丢掉本机）
    raw.indexedDB = makeFakeIndexedDB();
    world();
    const filePayloadWithData = JSON.parse(FILE);
    filePayloadWithData.tasks = [Object.assign({}, filePayloadWithData.tasks[0], { id: 'TF', title: '文件里的任务' })];
    S.setFileHandle(null);
    FILE = JSON.stringify(filePayloadWithData); handle._mtime = 1;
    await connectWithin();
    ok('回归：首次连接有数据的文件夹，照旧整份采用文件', !!S.byId('task', 'TF') && !S.byId('task', 'T2'));
    delete raw.window.showDirectoryPicker; delete raw.indexedDB;
    S.setFileHandle(handle);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
