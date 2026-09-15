/* P122：第三十轮排查——共享文件被人手工改出异常值

   代码里多处承认"共享文件就是网盘上一个明文 JSON，谁都能用记事本打开改"。这一轮把各类异常值塞进文件，
   走一遍同步，再把全部页面渲染一遍。实测复现过，修复前的版本会红。

   ① ★整页白屏：标题/牵头人/职责名写成数字或 null、账号名写成数字、日志的修改人/摘要写成数字——
      同步进来之后，工作台、任务页、图表、任务详情、日志页、权限页一打开就抛异常（排序时 localeCompare 不是函数），
      要等有人把 JSON 改回来才恢复。类型规整原来只把空值变成空串，非文字值原样放行；账号和日志根本不规整。
      现在：文字字段一律转成字符串（值不丢）；多值字段元素统一成文字；账号、日志、墓碑也规整；启动读缓存时同样处理
   ② 日期写法不统一（2026/3/5、20260405）原样放行，按字符串比先后会算错逾期和归期。
      现在能认出来的规整成 YYYY-MM-DD；认不出来的（abc、2026-02-30）原样保留不删，并在数据体检里列出来
   ③ 进度 150、-20 原样放行。现在限制在 0～100
   刻意不改：认不出来的状态值（可能是更新版本 html 新加的状态，改掉会破坏混版本兼容）

   ★ 已核实：真实生产数据规整前后零变化，上线后不会引发全处批量改写 ★

   查过没问题的：撤销（Ctrl+Z）在没有同步基线时照样能推出去（原操作留下的整条标记仍在）；
   新建任务/工作编号时已删除的记录都算在"已用"里，不会把回收站里那条的编号再发一次。

   用法：node test/test-p122.js */
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

const PAGES = ['dashboard', 'tasks', 'works', 'duties', 'charts', 'report', 'logs', 'data', 'permissions'];
async function renderAll() {
  const crashed = [];
  for (const pg of PAGES) {
    try { S.setPage(pg); S.renderShell(); S.renderPage(); await tick(20); } catch (e) { crashed.push(pg + '：' + e.message); }
  }
  for (const id of ['TW0', 'TW1']) {
    try { S.closeModal(); S.openTaskDetail(id); await tick(20); } catch (e) { crashed.push('任务详情 ' + id + '：' + e.message); }
  }
  S.closeModal();
  return crashed;
}

async function main() {
  await tick(150);

  section('① ★共享文件被人用记事本改坏：同步进来之后，任何页面都不许白屏');
  {
    world();
    await S.Repo.persist(S.DB); await tick(40);
    colleague(p => {
      const base = p.tasks[0];
      p.tasks.push(Object.assign({}, base, { id: 'TW0', rev: 50, title: 456, owner: 123, assignees: '张三,李四', plan_date: '2026/3/5', actual_date: 'abc', progress: 150 }));
      p.tasks.push(Object.assign({}, base, { id: 'TW1', rev: 50, title: null, owner: ['甲', '乙'], assignees: [1, null, '王五'], plan_date: '20260405', actual_date: '2026-02-30', progress: -20, status: 'finished' }));
      p.milestones.push(Object.assign({}, p.milestones[0], { id: 'MW', task: 'T2', deliverable: 789, plan_date: 'garbage', rev: 50 }));
      p.works.push(Object.assign({}, p.works[0], { id: 'WW', code: 12, name: null, collaborators: '甲、乙', rev: 50 }));
      p.duties.push({ code: 3, name: null, category: '一、前瞻研判', rev: 50 });
      p.users.push({ name: 123, role: 'staff', rev: 1 });
      p.changelog = (p.changelog || []).concat([null, { id: 'bad1', at: 'x', by: 999, summary: 12345, kind: 'edit', entity: 'task', refId: 'T1' }]);
      p.purged = [null, { entity: 'task', id: 555, at: 'x' }];
    });
    let syncErr = '';
    try { await S.pullFromFile(); await tick(40); await S.Repo.persist(S.DB); await tick(40); } catch (e) { syncErr = e.message; }
    ok('同步本身不抛异常', !syncErr, syncErr);
    const crashed = await renderAll();
    ok('★九个页面和任务详情全部能打开（原来工作台/任务页/图表/任务详情/日志/权限页白屏）', crashed.length === 0, crashed);

    const t0 = S.byId('task', 'TW0'), t1 = S.byId('task', 'TW1');
    ok('文字字段转成了字符串，值没丢（标题 456、牵头人 123）', t0.title === '456' && t0.owner === '123', { title: t0.title, owner: t0.owner });
    ok('数组写进文字字段：按顿号拼起来', t1.owner === '甲、乙', t1.owner);
    ok('多值字段里的非文字元素统一成文字、空的剔除', JSON.stringify(t1.assignees) === '["1","王五"]', t1.assignees);
    ok('★能认出来的日期写法规整成 YYYY-MM-DD', t0.plan_date === '2026-03-05' && t1.plan_date === '2026-04-05', [t0.plan_date, t1.plan_date]);
    ok('★认不出来的日期原样保留，不替人删掉', t0.actual_date === 'abc' && t1.actual_date === '2026-02-30', [t0.actual_date, t1.actual_date]);
    ok('进度限制在 0～100', t0.progress === 100 && t1.progress === 0, [t0.progress, t1.progress]);
    ok('认不出来的状态值不改（可能是新版本加的状态，改掉会破坏混版本兼容）', t1.status === 'finished', t1.status);
    ok('账号名、日志、墓碑里的非文字值也规整了、空条目剔除', S.DB.users.every(u => typeof u.name === 'string')
      && S.DB.changelog.every(e => e && (e.by == null || typeof e.by === 'string') && (e.summary == null || typeof e.summary === 'string'))
      && S.DB.purged.every(p => p && typeof p.id === 'string'));
  }

  section('② 数据体检列出认不出来的日期（只列不改）');
  {
    const h = S.healthCheck();
    const it = h.issues.find(i => i.k === 'badDate');
    ok('★体检报出了认不出来的日期', !!it && it.n >= 3, it && it.items.map(x => x.label));
    ok('这一项不提供自动修复', it && it.fix === null);
  }

  section('③ ★真实生产数据：规整前后一个字都不能变（否则上线后第一次同步就全处批量改写）');
  {
    const prodPath = path.join(__dirname, '..', '科技规划处工作管理.json');
    if (!fs.existsSync(prodPath)) { ok('（没有生产数据文件，跳过）', true); }
    else {
      const raw = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
      const p = JSON.parse(JSON.stringify(raw));
      S.normalizeMergedRecords(p);
      let changed = 0;
      for (const k of ['duties', 'works', 'milestones', 'tasks', 'users', 'changelog', 'purged']) {
        if ((raw[k] || []).length !== (p[k] || []).length) changed++;
        (raw[k] || []).forEach((r, i) => { if (JSON.stringify(r) !== JSON.stringify((p[k] || [])[i])) changed++; });
      }
      ok('★生产数据规整后零变化', changed === 0, changed);
      S.DB.tasks = raw.tasks; S.DB.milestones = raw.milestones; S.DB.works = raw.works; S.DB.duties = raw.duties; S.rebuildIndex();
      ok('生产数据里没有认不出来的日期', !S.healthCheck().issues.some(i => i.k === 'badDate'));
    }
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
