/* P129：第三十七轮排查——把多实例长跑扩到"工作/职责/账号/权限/编排"，并补上写入竞争的最后一块兜底

   这一轮先扩仿真（sim16）：除了任务和里程碑，随机动作里加进了表格里双击改工作名/职责名、改账号角色、
   开关权限矩阵、改报告编排、点数据体检的自动修复；并新增四条铁律——
     · 有里程碑的任务，进度必须等于"已交付 / 全部"；
     · 不许出现一模一样的里程碑；
     · 本来有 PIN 的账号不许变成"待设置"（那等于谁都能认领这个账号）；
     · 账号角色必须等于最后一次真有人去改的那个值（被合并悄悄改回去、或凭空升级都算问题）。

   长跑反复撞出来的仍然是"几个人同时保存"那一类，于是这一轮补的是它的兜底：

   ① ★写入竞争之后按【我自己的变更记录】把被顶掉的格子自动补回来。
      原来只有一条兜底：把基线回滚到"我那次写之前"，让我手里的值重新算成待推送。它有两种救不了的情况——
      我这台机器中途刷新过页面（回滚要用的基线只在内存里），或者覆盖之后我先拉过一次文件
      （那一轮合并已经把对方的旧值吸收进本机，手里的值已经不是我改的那个）。
      这时候证据其实是齐的：我的日志写着"这一格我改成了 X"，现在它不是 X，而且之后没人对这一格留过记录——
      正是「按日志核对数据」判定"对不上"的条件。于是就地做一次【只针对我自己、只针对最近这次写入窗口】的
      按日志修复，走跟人工修复完全同一份代码（applyAuditFix），逐条留痕。
   ② ★补回的值必须推得出去：修复是【就地改记录】的，而合并结果里一大半记录就是从文件里读出来的那个对象——
      基线要是等修复之后才拍，就会记成"文件里已经是我补好的值"，补回的内容永远推不出去，
      下一轮还被文件里的旧值顶回来（探针实测到这一幕）。现在拉取那条路在合并之前先把基线拍好。
   ③ ★时钟不同步的提醒阈值从 5 分钟收到 2 分钟：长跑里一两分钟的表差就足以让"两人先后改同一格"判反——
      慢表那台真正后做的改动被当成旧值丢掉。没有服务器就没有权威时间，这类判错只能靠早点校表来避免。
      但「按日志核对」那边的容差不跟着收紧（另立 AUDIT_SKEW_TOLERANCE_MS = 5 分钟）：
      那边宁可放宽也不能误报，误报会害管理员把新数据改回旧值。

   用法：node test/test-p129.js */
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
function colleague(fn, keepRing) {
  const p = JSON.parse(FILE);
  const oldRing = Array.isArray(p.writeIds) ? p.writeIds.slice() : ['w0'];
  fn(p);
  p.writeId = 'wC' + Math.random(); p.writeIds = (keepRing ? oldRing : ['w0']).concat(p.writeId);
  FILE = JSON.stringify(p); handle._mtime++;
}
const bump = r => Object.assign(r, { rev: (r.rev || 1) + 5, updated_at: LATER(), updated_by: '同事' });
const F = () => JSON.parse(FILE);
const fRec = (ent, key, id) => (F()[ent] || []).find(x => x[key] === id);
// 模拟"打开之前就发出去的那一轮同步，在确认框/编辑框开着时落地"
async function landSync(fn, keepRing) { colleague(fn, keepRing); await S.pullFromFile(); await tick(60); }
async function confirmNow() {
  const cb = S.modalCallback;
  if (typeof cb === 'function') { await cb(); await tick(200); }
  return typeof cb === 'function';
}

function cpRow(id, pd, dv, rl, dn) {
  return { getAttribute: k => (k === 'data-ms-id' ? id : null),
    querySelector: sel => ({ '.cp-date': { value: pd }, '.cp-deliv': { value: dv }, '.cp-report-level': { value: rl }, '.cp-chk': { checked: dn === '1' } }[sel]) };
}
const origQSA = raw.document.querySelectorAll;
const withRows = async (rows, fn) => {
  raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? rows : (origQSA ? origQSA(sel) : []));
  try { await fn(); } finally { raw.document.querySelectorAll = origQSA; }
};
const saveDetail = async () => { fillTaskForm(); await S.modalCallback(); await tick(30); if (typeof S.modalCallback === 'function') { await S.modalCallback(); await tick(30); } await tick(120); };
// 任务详情里各格按当前记录填好（沙盒里的输入框默认是空的，不填就等于把任务字段清空后保存）
function fillTaskForm() {
  const t = S.byId('task', 'T1');
  S.schema('task').fields.filter(f => !f.virtual).forEach(f => {
    const v = t[f.key];
    q('#td-' + f.key).value = Array.isArray(v) ? v.join(f.type === 'lines' ? '\n' : ',') : String(v == null ? '' : v);
  });
}
const rowM1 = () => cpRow('M1', '2026-09-20', '调研报告', 'section', '0');


function mkTd() {
  let input = null;
  return { innerHTML: '', appendChild(el) { input = el; }, get input() { return input; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }), closest: () => null };
}
const iso = ms => new Date(ms).toISOString();
// 在单元格里改一格并等它落库（走真实入口：双击打开 → 改 → 点到别处）
async function cellEdit(id, key, val) {
  const td = mkTd();
  S.openEditor('task', id, key, td);
  td.input.value = val;
  td.input._on.blur.forEach(fn => fn());
  await tick(300);
}
// 模拟"页面刷新过"：回滚要用的内存基线没了，老兜底救不了，只剩按日志补回这一条
const asAfterReload = () => S.setPreWriteBase(null);

async function main() {
  await tick(150);

  section('① ★被同事用过期内容覆盖后：按我自己的日志把被顶掉的格子补回来');
  {
    world({ tasks: [], milestones: [] });
    await S.Repo.persist(S.DB); await tick(60);
    await cellEdit('T1', 'title', '我改的标题');
    ok('前提：我的改动已经进了共享文件', fRec('tasks', 'id', 'T1').title === '我改的标题', fRec('tasks', 'id', 'T1').title);
    asAfterReload();
    // 同事拿一份"我改之前"的内容写了一次（写入链里没有我那次写的标记 = 覆盖）
    await landSync(p => { const t = p.tasks.find(x => x.id === 'T1'); t.title = '任务T1'; });
    await tick(200);
    ok('★被顶掉的标题自动补回来了', S.byId('task', 'T1').title === '我改的标题', S.byId('task', 'T1').title);
    ok('★留了痕：日志里写明是自动补回的、依据是哪一次改动',
      S.DB.changelog.some(e => /自动补回/.test(e.summary || '')), S.DB.changelog.slice(-2).map(e => e.summary));
    ok('★告警里说清楚了这件事（顶栏提示 + 日志）',
      S.DB.changelog.some(e => e.kind === S.ALERT_LOG_KIND && /自动补回/.test(e.summary || '')));
    await S.Repo.persist(S.DB); await tick(150);
    ok('★★补回来的值真的推回了共享文件（基线要是记成"文件里已经是我的值"，这里就会失败）',
      fRec('tasks', 'id', 'T1').title === '我改的标题', fRec('tasks', 'id', 'T1').title);
    await S.pullFromFile(); await tick(120);
    ok('★再同步一轮也不会被文件里的旧值顶回去', S.byId('task', 'T1').title === '我改的标题', S.byId('task', 'T1').title);
  }

  section('② ★删除被撤回：同样按日志重新删掉');
  {
    world({ milestones: [] });
    await S.Repo.persist(S.DB); await tick(60);
    S.openTaskDetail('T1'); await tick(20);
    await withRows([], saveDetail);   // 把唯一的里程碑 M1 删掉
    ok('前提：删除已经落到共享文件', !!fRec('milestones', 'id', 'M1').deleted_at);
    asAfterReload();
    await landSync(p => { const m = p.milestones.find(x => x.id === 'M1'); delete m.deleted_at; });
    await tick(250);
    ok('★被撤回的删除又被重新删掉了', !!S.byId('milestone', 'M1').deleted_at, S.byId('milestone', 'M1').deleted_at);
    await S.Repo.persist(S.DB); await tick(150);
    ok('★共享文件里也是删除状态', !!fRec('milestones', 'id', 'M1').deleted_at);
  }

  section('③ ★只补自己的、只补最近的：别人正经改过的不许顶，老日志不许翻出来');
  {
    world({ tasks: [], milestones: [] });
    await S.Repo.persist(S.DB); await tick(60);
    await cellEdit('T1', 'title', '我改的标题');
    asAfterReload();
    await landSync(p => {
      const t = p.tasks.find(x => x.id === 'T1');
      t.title = '同事后来改的'; bump(t);
      p.changelog = (p.changelog || []).concat([{ id: 'lx', at: iso(Date.now() + 5000), by: '小王', kind: 'edit',
        entity: 'task', refId: 'T1', summary: '任务：我改的标题→同事后来改的',
        changes: [{ k: 'title', from: '我改的标题', to: '同事后来改的' }] }]);
    });
    await tick(200);
    ok('★同事那次有记录的修改留着（我的日志不是这一格最后一条，不补）', S.byId('task', 'T1').title === '同事后来改的', S.byId('task', 'T1').title);

    // 我自己的那条日志已经是一小时前的（超出写入竞争窗口）：不翻旧账
    world({ tasks: [], milestones: [] });
    await S.Repo.persist(S.DB); await tick(60);
    S.DB.changelog.push({ id: 'lold', at: iso(Date.now() - 3600000), by: S.DB.settings.me, kind: 'edit',
      entity: 'task', refId: 'T1', summary: '任务：任务T1→很久以前改的', changes: [{ k: 'title', from: '任务T1', to: '很久以前改的' }] });
    S.setLastWriteId('w-me'); S.DB.settings.lastWriteId = 'w-me'; S.DB.settings.lastWriteIdAt = iso(Date.now() - 60000);
    asAfterReload();
    await landSync(p => { const t = p.tasks.find(x => x.id === 'T1'); t.title = '任务T1'; });
    await tick(200);
    ok('★一小时前那条日志不会被翻出来改数据', S.byId('task', 'T1').title === '任务T1', S.byId('task', 'T1').title);
  }

  section('④ ★一次要补的太多：只报警、不自动动数据');
  {
    world({ tasks: Array.from({ length: 60 }, (_, i) => ({ id: 'TX' + i })), milestones: [] });
    await S.Repo.persist(S.DB); await tick(60);
    const me = S.DB.settings.me;
    // 伪造"我刚刚把 60 条任务的标题都改了"的日志，而数据里都不是那个值
    /* 要让它们真的够格被自动补回：日志里的"改之前"就是现在这个值（看起来像是被整个退回了），
       而且记录在那条日志之后没被人动过（最后修改时间停在更早） */
    S.DB.changelog = S.DB.tasks.filter(t => /^TX/.test(t.id)).map((t, i) => {
      t.updated_at = iso(Date.now() - 120000);
      return { id: 'lm' + i, at: iso(Date.now() - 1000), by: me, kind: 'edit', entity: 'task', refId: t.id,
        summary: '任务：改过了', changes: [{ k: 'title', from: t.title, to: '日志里的标题' + i }] };
    });
    const n0 = S.DB.tasks.filter(t => /日志里的标题/.test(t.title || '')).length;
    S.setPreWriteBase(null);
    S.setLastWriteId('w-me2'); S.DB.settings.lastWriteId = 'w-me2'; S.DB.settings.lastWriteIdAt = iso(Date.now());
    await landSync(p => { p.lastWriteBy = '小王'; });
    await tick(250);
    ok('★没有自动改数据（超过一次能补的上限）', S.DB.tasks.filter(t => /日志里的标题/.test(t.title || '')).length === n0);
    ok('★但一定说出来了，并指到"按日志核对数据"那个工具',
      S.DB.changelog.some(e => /数量太多没有自动补回/.test(e.summary || '')), S.DB.changelog.slice(-2).map(e => e.summary));
  }

  section('⑥ ★覆盖是在保存过程中（而不是拉取时）才发现的：照样要补回并推出去');
  {
    world({ tasks: [], milestones: [] });
    await S.Repo.persist(S.DB); await tick(60);
    await cellEdit('T1', 'title', '我改的标题');
    ok('前提：我的改动进了共享文件', fRec('tasks', 'id', 'T1').title === '我改的标题');
    asAfterReload();
    /* 同事拿一份【我改之前】的副本写了回去：内容、最后修改时间都停在我改之前（真正的过期副本），
       写入链里也没有我那次写入的标记。这次我不先拉取，直接保存——覆盖是在保存过程中才被发现的。 */
    colleague(p => { const t = p.tasks.find(x => x.id === 'T1'); t.title = '任务T1'; t.updated_at = '2026-01-01T00:00:00.000Z'; t.updated_by = '小王'; });
    await S.Repo.persist(S.DB); await tick(200);
    ok('★保存过程中发现被覆盖 → 当场补回', S.byId('task', 'T1').title === '我改的标题', S.byId('task', 'T1').title);
    ok('★★并且这次保存把补回的值写进了共享文件', fRec('tasks', 'id', 'T1').title === '我改的标题', fRec('tasks', 'id', 'T1').title);
  }

  section('⑦ ★同事真的动过这条记录（哪怕没留逐字段记录）：绝不拿我的旧值去盖他');
  {
    world({ tasks: [], milestones: [] });
    await S.Repo.persist(S.DB); await tick(60);
    await cellEdit('T1', 'title', '我改的标题');
    asAfterReload();
    // 同事把标题改成了别的（比如他还在用旧版本 html，那次修改没留逐字段记录），记录的最后修改时间是新的
    await landSync(p => { const t = p.tasks.find(x => x.id === 'T1'); t.title = '同事写的新值'; bump(t); });
    await tick(200);
    ok('★同事的值留着，没有被我的日志顶回去', S.byId('task', 'T1').title === '同事写的新值', S.byId('task', 'T1').title);
    ok('★也没有凭空写一条“自动补回”的记录', !S.DB.changelog.some(e => /自动补回/.test(e.summary || '')));
  }
  section('⑧ ★同事有意把它改回原值（旧版本客户端不留逐字段记录）：不许我的机器再自动改回去');
  {
    world({ tasks: [], milestones: [] });
    await S.Repo.persist(S.DB); await tick(60);
    await cellEdit('T1', 'title', '我改的标题');
    asAfterReload();
    /* 同事觉得原来那个标题更好，手动改了回去。他那台还是旧版本 html，这次修改没留逐字段记录，
       所以从日志上看跟"我的改动被覆盖了"一模一样——区别只有一个：这条记录在我那条日志之后被【他】动过。 */
    await landSync(p => { const t = p.tasks.find(x => x.id === 'T1'); t.title = '任务T1'; bump(t); });
    await tick(200);
    ok('★同事改回去的就让它回去，不自动再改一遍（否则两台机器会来回打架）', S.byId('task', 'T1').title === '任务T1', S.byId('task', 'T1').title);
    ok('★也没写自动补回的记录', !S.DB.changelog.some(e => /自动补回/.test(e.summary || '')));
  }
  section('⑤ ★时钟：提醒阈值收紧到 2 分钟，核对容差仍是 5 分钟');
  {
    ok('提醒阈值 2 分钟', S.CLOCK_SKEW_LIMIT_MS === 2 * 60 * 1000, S.CLOCK_SKEW_LIMIT_MS);
    ok('核对容差 5 分钟（比提醒宽，避免误报害人改回旧值）', S.AUDIT_SKEW_TOLERANCE_MS === 5 * 60 * 1000, S.AUDIT_SKEW_TOLERANCE_MS);
    world();
    S.setClockSkewWarned(false); S.setSnackPriorityUntil(0);
    S.checkClockSkew({ lastWriteAt: iso(Date.now() + 150000), lastWriteBy: '小王' });
    ok('★差 2 分半就提醒了（原来要差 5 分钟才提醒）', /时间比小王那台机器慢/.test(q('#snack-msg').textContent), q('#snack-msg').textContent);

    // 核对：两人的日志差 3 分钟（超过提醒阈值、仍在核对容差内）→ 先后分不清，不报
    world();
    S.byId('task', 'T1').status = 'doing';
    const now = Date.now();
    S.DB.changelog = [
      { id: 'a1', at: iso(now - 180000), by: '老李', kind: 'edit', entity: 'task', refId: 'T1', summary: '状态', changes: [{ k: 'status', from: 'todo', to: 'doing' }] },
      { id: 'a2', at: iso(now), by: '小王', kind: 'edit', entity: 'task', refId: 'T1', summary: '状态', changes: [{ k: 'status', from: 'doing', to: 'todo' }] },
    ];
    ok('★差 3 分钟仍按"先后分不清"处理，不误报', !S.auditByChangelog().some(i => i.field === 'status'));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { raw.document.querySelectorAll = origQSA; console.error('测试异常：', e); process.exit(1); });
