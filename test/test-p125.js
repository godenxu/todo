/* P125：第三十三轮排查——"还没保存就丢了"和共用电脑

   实测复现过，修复前的版本会红。

   ① 关闭/刷新标签页时没有任何离开提醒：任务详情里填了一大段、手滑点了关闭或按了 F5，内容当场没了。
      现在弹窗里有输入框、单元格正在编辑、或正在往共享文件夹写时，浏览器会问一句；
      程序自己发起的跳转（静默升级、强制刷新、在这个标签页继续使用）放行，被别的标签页接管的页面不提醒
   ② ★点弹窗外的遮罩：在标题框里拖着鼠标选字、松手时滑出了弹窗边缘，浏览器把这次点击算在遮罩上，
      整个弹窗当场被关掉、内容全丢。现在要按下和松开都在遮罩上才算；
      带输入框的表单弹窗点外面不关（要关请点取消或按 Esc），纯确认框维持点外面就关
   ③ ★共用一台电脑换人登录后，撤销栈没清：B 一按 Ctrl+Z 就以 B 的名义撤销了 A 的工作——
      而且撤销会把账号列表、权限矩阵恢复到快照，员工能借此推翻管理员刚做的角色调整。
      现在撤销入口核对"快照是谁做的"，换了人就拒绝并清空撤销栈

   用法：node test/test-p125.js */
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

const unloadEv = () => ({ prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } });
const fireUnload = () => { const ev = unloadEv(); (raw.window._on.beforeunload || []).forEach(fn => fn(ev)); return ev; };
const overlay = () => q('#modal-overlay');
const body = () => q('#modal-body');

async function main() {
  await tick(150);

  section('① ★关闭/刷新标签页时手上有没保存的东西：浏览器要问一句');
  {
    world();
    S.closeModal();
    ok('什么都没开时不打扰', !fireUnload().prevented);
    S.openTaskDetail('T1'); await tick(20);
    ok('★任务详情开着（有输入框）时关页面会被拦下问一句', fireUnload().prevented);
    const qs0 = body().querySelector;
    body().querySelector = () => null;   // 模拟纯确认框：弹窗里没有输入框
    ok('纯确认框开着时不打扰', !fireUnload().prevented);
    body().querySelector = qs0;
    S.closeModal();

    let lastInput = null;
    const _ce = raw.document.createElement;
    raw.document.createElement = function (tg) { const e = _ce.call(this, tg); if (String(tg) === 'input') lastInput = e; return e; };
    S.openEditor('task', 'T1', 'title', q('#td'));
    raw.document.createElement = _ce;
    ok('★单元格正在编辑时关页面会被拦下', fireUnload().prevented);
    S.commitActiveEdit(); await tick(100);

    S.openTaskDetail('T1'); await tick(20);
    const href0 = raw.location.href;
    S.ACTIONS['force-reload']();
    ok('★程序自己发起的跳转（强制刷新）放行，不许被离开提醒卡住', !fireUnload().prevented);
    raw.location.href = href0;
    S.closeModal();
  }

  section('② ★点弹窗外面的遮罩：拖着选字滑出边缘不许关弹窗，表单弹窗点外面也不关');
  {
    world();
    S.openTaskDetail('T1'); await tick(20);
    // 在标题框里按下鼠标、拖到弹窗外松开：click 的 target 是遮罩，但按下处不在遮罩上
    overlay().fire('mousedown', { target: q('#td-title') });
    overlay().fire('click', { target: overlay() });
    ok('★拖动选字松手在弹窗外，弹窗没有被关掉', overlay().classList.contains('show'));
    overlay().fire('mousedown', { target: overlay() });
    overlay().fire('click', { target: overlay() });
    ok('★带输入框的表单弹窗，点外面也不关（要关点取消或按 Esc）', overlay().classList.contains('show'));
    const qs0 = body().querySelector;
    body().querySelector = () => null;   // 纯确认框：第二道护栏（表单点外面不关）管不到，单独验第一道
    overlay().fire('mousedown', { target: q('#modal-body') });
    overlay().fire('click', { target: overlay() });
    ok('★纯确认框上按下、拖到外面松开，也不许关（第一道护栏单独生效）', overlay().classList.contains('show'));
    overlay().fire('mousedown', { target: overlay() });
    overlay().fire('click', { target: overlay() });
    ok('纯确认框：真的点在外面，照常关', !overlay().classList.contains('show'));
    body().querySelector = qs0;
  }

  section('③ ★换人登录之后，不能再撤销上一个人的操作');
  {
    world();
    S.DB.settings.me = '管理员';
    const t = S.byId('task', 'T1');
    S.snapshot(); t.title = '管理员改的标题'; S.stampMeta(t); await S.Repo.persist(S.DB); await tick(40);
    // 管理员退出，小王在同一台电脑上登录
    S.DB.settings.me = '小王';
    await S.undoLast(); await tick(80);
    ok('★小王按撤销没有推翻管理员的改动', S.byId('task', 'T1').title === '管理员改的标题', S.byId('task', 'T1').title);
    ok('撤销栈被清空，并说明了原因', S.undoStack.length === 0 && /换人登录之后不能再撤销/.test(q('#snack-msg').textContent), q('#snack-msg').textContent);

    world();
    S.DB.settings.me = '管理员';
    const t2 = S.byId('task', 'T1');
    S.snapshot(); t2.title = '自己改的'; S.stampMeta(t2); await S.Repo.persist(S.DB); await tick(40);
    await S.undoLast(); await tick(80);
    ok('同一个人照常能撤销自己的操作', S.byId('task', 'T1').title !== '自己改的', S.byId('task', 'T1').title);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
