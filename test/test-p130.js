/* P130：第三十八轮排查——换到"导出/导入/备份/日志裁剪"这条线，并把仿真接上真实生产数据

   前几轮都在同步与并发上，这一轮查的是管理员真正用来救数据的那几条路，以及被它们依赖的日志本身：

   ① ★备份文件里夹着本机私有的状态：me（谁的机器）、dirtyKeys/dirtyFields（"我改过哪些记录/哪几格"的本机凭据，
      最多能攒 5000 条）、lastWriteId/lastWriteIdAt/pendingSync/lastSyncAt/lastKnownWrite 那几项、localAppVersion。
      恢复那边本来就只取年度（importBackup 里 ④），这些字段对恢复毫无用处，白白撑大每天都在写的备份文件，
      还把个人状态写进了会被到处拷贝的文件。现在只留 year 和 lastBackupAt。
   ② ★日志裁剪会先丢掉"带覆盖范围的汇总日志"：导入/批量指派只写一条汇总日志，P128 起它带着覆盖范围（scope），
      「按日志核对数据」正是靠它认出"这几格是被那次批量动作盖过的"。原来裁剪把"没有逐字段明细"的都归到
      第二批先丢——汇总日志正好在这一批。它一被丢掉，核对就又开始把整批导入报成"对不上"，
      管理员一点"按日志修复"就把导入的内容改回去了。现在它跟有明细的日志同级。
   ③ 覆盖范围的命中判断原来是数组逐个扫（一次导入可覆盖上百条、核对结果也可能上百条），改成集合，避免退化。

   另外三件事没有改产品代码，但值得记下来（都写进了 sim/sim16.js）：
   · 仿真加了 PROD= 模式：拿真实生产数据当共享文件的初始内容跑长跑。真实数据里有撞号的编号、
     几百条历史日志，压力跟合成数据完全不同；起跑时先记下"数据里本来就有的对不上"，长跑只报新增的。
   · 加了字段级写入史和告警普查：报"日志与数据对不上"时，能直接看出这一格被谁在第几轮写成了什么，
     以及当时文件里有没有对应的告警。用它核对了一遍——高并发长跑里剩下的那些对不上，
     文件里都带着"同一个字段被两个人同时改动"或"被人用过期内容覆盖"的告警，也就是说都被系统说出来了、
     能在「按日志核对数据」里查到并改回，不是悄悄丢的。
   · 拿仓库里几份真实备份跑「按日志核对数据」：09-07、09-11 那两份各有 3 处可修的对不上
     （两条任务的日志写着"已完成/100%"，数据却是"进行中/70%"），09-14 那份里已经没有了——
     处里报的那类事故，在他们自己的备份里留着历史实例。

   用法：node test/test-p130.js */
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


// 抓住"导出"真正生成的那份文本（正式代码里它会走浏览器下载）
let lastDownload = null;
raw.download = (name, text) => { lastDownload = { name, text }; };
const exportText = entity => { lastDownload = null; S.exportCSV(entity); return lastDownload ? lastDownload.text : ''; };
const META = ['updated_at', 'updated_by', 'rev'];
const snapshotOf = entity => {
  const m = {};
  S.coll(entity).forEach(r => { const c = cp(r); META.forEach(k => delete c[k]); m[r[S.schema(entity).pk]] = c; });
  return m;
};
const diffRecords = (a, b) => {
  const out = [];
  Object.keys(a).forEach(id => {
    const x = a[id], y = b[id];
    if (!y) { out.push([id, '整条不见了']); return; }
    Object.keys(x).forEach(k => { if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out.push([id, k, x[k], y[k]]); });
  });
  Object.keys(b).forEach(id => { if (!a[id]) out.push([id, '凭空多出来一条']); });
  return out;
};
const iso = ms => new Date(ms).toISOString();

async function main() {
  await tick(150);

  section('① ★备份文件：只带全处共同的数据，不带本机私有状态');
  {
    world({ tasks: [], milestones: [] });
    await S.Repo.persist(S.DB); await tick(60);
    // 造一点本机私有状态出来
    S.DB.settings.pendingSync = true;
    S.DB.settings.lastWriteId = 'w-local'; S.DB.settings.lastWriteIdAt = iso(Date.now());
    S.markLocallyChanged(S.byId('task', 'T1'));
    S.markLocallyChangedFields(S.byId('task', 'T1'), ['title', 'owner']);
    lastDownload = null;
    await S.exportJSON();
    ok('拿到了备份文件', !!lastDownload && lastDownload.text.length > 100);
    const d = JSON.parse(lastDownload.text);
    const keys = Object.keys(d.settings || {}).sort();
    ok('★settings 里只剩年度和上次备份时间', JSON.stringify(keys) === JSON.stringify(['lastBackupAt', 'year']), keys);
    ok('★没有 me（谁的机器）', !('me' in (d.settings || {})));
    ok('★没有 dirtyKeys / dirtyFields（本机凭据，最多能攒 5000 条）',
      !('dirtyKeys' in (d.settings || {})) && !('dirtyFields' in (d.settings || {})));
    ok('★没有写入链标记 / 待同步标记 / 同步时间', !/"lastWriteId"|"pendingSync"|"lastSyncAt"|"lastKnownWriteBy"/.test(lastDownload.text));
    ok('★同步基线也仍然不带（老规矩）', !/"syncBase"/.test(lastDownload.text));
    ok('业务数据一条不少', (d.tasks || []).length === S.DB.tasks.length && (d.milestones || []).length === S.DB.milestones.length
      && (d.users || []).length === S.DB.users.length && Array.isArray(d.purged), [d.tasks.length, S.DB.tasks.length]);

    // 往返：恢复之后业务数据一致
    const before = snapshotOf('task');
    await S.importBackup(lastDownload.text);
    await confirmNow(); await tick(250);
    ok('★备份恢复之后任务数据一个字没变', diffRecords(before, snapshotOf('task')).length === 0, diffRecords(before, snapshotOf('task')).slice(0, 4));
    ok('年度跟着备份走（恢复那边只取这一项）', S.DB.settings.year === d.settings.year, [S.DB.settings.year, d.settings.year]);
  }

  section('② 导出 CSV 再原样导回来，数据必须一个字都不变（含逗号、引号、换行、中文标点、首尾空格）');
  {
    world({ tasks: [], milestones: [] });
    Object.assign(S.byId('task', 'T1'), { title: '带,逗号和"引号"的任务 ', source: '会议、纪要',
      assignees: ['张三', '李四'], plan_date: '2026-10-01', progress: 35 });
    const t2 = S.byId('task', 'T2');
    t2.title = '换行\n也要活下来';
    t2.deleted_at = iso(Date.now());
    S.byId('work', 'w1').content = ['第一行，带逗号', '第二行"带引号"'];
    Object.assign(S.byId('milestone', 'M1'), { deliverable: '交付物，带标点；还有分号', report_level: 'bank', done: '1', actual_date: '2026-09-01' });
    S.rebuildIndex();
    await S.Repo.persist(S.DB); await tick(60);
    for (const entity of ['task', 'work', 'duty', 'milestone']) {
      const before = snapshotOf(entity);
      const text = exportText(entity);
      await S.applyCSVImport(entity, 'merge', text.replace(/^﻿/, ''));
      await tick(120);
      const d = diffRecords(before, snapshotOf(entity));
      ok(`★${entity}：导出→导入之后一个字都没变`, d.length === 0, d.slice(0, 4));
    }
  }

  section('③ ★日志裁剪：带覆盖范围的汇总日志不许先被丢掉（丢了核对就又开始误报整批导入）');
  {
    world({ tasks: [], milestones: [] });
    const mk = (i, extra) => Object.assign({ id: 'x' + i, at: iso(Date.now() - (500 - i) * 1000), by: '管理员', kind: 'edit',
      entity: 'task', refId: 'T1', summary: '第' + i + '条' }, extra);
    const list = [];
    /* 顺序要贴着真实情况：导入那条汇总日志往往比后来的零散修改更早。
       裁剪在同一档里是按数组顺序从前往后丢的，把汇总日志摆在最早处，才真的压到「它会不会先被丢掉」 */
    for (let i = 0; i < 5; i++) list.push(mk(i, { refId: '', summary: 'CSV 导入', scope: S.bulkScope('task', ['T1'], ['title']) }));
    for (let i = 5; i < 25; i++) list.push(mk(i, { kind: 'login', summary: '登录' }));          // 最先被丢
    for (let i = 25; i < 65; i++) list.push(mk(i));                                             // 只有一句话，其次被丢
    for (let i = 65; i < 75; i++) list.push(mk(i, { changes: [{ k: 'title', from: 'a', to: 'b' }] }));   // 有明细，最后才丢
    const kept = S.capChangelog(list, 50);
    ok('裁到了 50 条', kept.length === 50, kept.length);
    ok('★带覆盖范围的汇总日志一条都没丢', kept.filter(e => e.scope).length === 5, kept.filter(e => e.scope).length);
    ok('有逐字段明细的也都还在', kept.filter(e => e.changes).length === 10, kept.filter(e => e.changes).length);
    ok('先丢的是登录记录', kept.filter(e => e.kind === 'login').length === 0);
    ok('其次丢的是"只有一句话"的记录', kept.filter(e => e.kind === 'edit' && !e.changes && !e.scope).length === 35,
      kept.filter(e => e.kind === 'edit' && !e.changes && !e.scope).length);
  }

  section('④ 生产规模下核对要够快（它现在每次写入竞争都会被自动调用一次）');
  {
    world({ tasks: [], milestones: [] });
    S.DB.tasks = Array.from({ length: 230 }, (_, i) => S.stampMeta(S.blank('task', { id: 'PT' + i, work: 'w1', code: '0101' + i,
      title: '任务' + i, owner: '管理员', status: 'doing', priority: '2', progress: 0, plan_date: '2026-12-31' })));
    S.DB.milestones = Array.from({ length: 260 }, (_, i) => S.stampMeta(S.blank('milestone', { id: 'PM' + i, task: 'PT' + (i % 230),
      plan_date: '2026-09-20', deliverable: '交付物' + i, report_level: 'section', done: '0' })));
    S.rebuildIndex();
    const now = Date.now();
    S.DB.changelog = Array.from({ length: 2000 }, (_, i) => ({ id: 'pl' + i, at: iso(now - (2000 - i) * 60000),
      by: ['管理员', '小王', '老李'][i % 3], kind: 'edit', entity: i % 2 ? 'task' : 'milestone',
      refId: (i % 2 ? 'PT' : 'PM') + (i % 200), summary: '改了', changes: [{ k: i % 2 ? 'title' : 'done', from: 'a', to: 'b' + i }] }));
    for (let i = 0; i < 20; i++) S.DB.changelog.push({ id: 'pb' + i, at: iso(now), by: '管理员', kind: 'edit', entity: 'task',
      refId: '', summary: 'CSV 导入', scope: S.bulkScope('task', S.DB.tasks.map(t => t.id), ['title', 'owner']) });
    const t0 = Date.now();
    const issues = S.auditByChangelog();
    const ms = Date.now() - t0;
    ok(`★2000 条日志 + 490 条记录，核对耗时 ${ms}ms（要求 500ms 内，它是在同步流程里被自动调用的）`, ms < 500, ms);
    ok('覆盖范围认得出来：被导入盖过的那一批不再报', !issues.some(i => i.entity === 'task' && i.field === 'title'), issues.length);
  }

  section('⑤ 回收站清空：只清超过保留期的，而且要留墓碑');
  {
    world({ tasks: [], milestones: [] });
    await S.Repo.persist(S.DB); await tick(60);
    S.ACTIONS['task-del']({ id: 'T1' }); await confirmNow(); await tick(150);
    S.ACTIONS['task-del']({ id: 'T2' }); await confirmNow(); await tick(150);
    const t1 = S.byId('task', 'T1'); t1.deleted_at = iso(Date.now() - 400 * 86400000); S.stampMeta(t1);
    await S.Repo.persist(S.DB); await tick(150);
    S.setSnackPriorityUntil(0);
    await S.purgeRecycleBin(); await tick(80);
    const asked = await confirmNow(); await tick(300);
    ok('确认框出现了（这一步不可撤销，必须问）', asked);
    ok('★超过保留期的被彻底删了', !S.byId('task', 'T1'));
    ok('★刚删的那条还留在回收站里', !!S.byId('task', 'T2') && !!S.byId('task', 'T2').deleted_at);
    ok('★留了墓碑（否则会从别人机器上飘回来）', (S.DB.purged || []).some(p => p.id === 'T1'));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { raw.document.querySelectorAll = origQSA; console.error('测试异常：', e); process.exit(1); });
