/* P131：第三十九轮排查——给领导看的那些数字必须自洽（报表/图表口径）

   前几轮都在"数据会不会丢"上。这一轮换到另一端：数据没丢，但**数字算错了**——不会报错、不会白屏，
   只会让汇报材料上的数对不上账，而且往往几个月没人发现。
   新写了 sim/sim17.js：随机造数据（掺进挂起、无日期、跨年、已删除、未指派），
   对 周/月/季/年 × 前后若干期 × 全处/每个人 取报表数据，验 37 条必须成立的代数性质。
   三个真问题都是它撞出来的，而且都属于同一类——**同一条规则，有的地方做了，有的地方漏了**：

   ① ★报告页的「即将到期」和「逾期」会同时列出同一条任务。
      isOverdue 不只看任务自己的计划完成时间，名下里程碑拖期了也算逾期。于是一条"自己的截止日还在本期、
      但里程碑已经拖了"的任务，两张清单里各出现一次，照着念的人会把它数两遍。
      图表页的到期分布柱图早就按"逾期优先、不重复计入"做了（dueBuckets 里每个非逾期桶都排掉 isOverdue，
      那边注释还写明"否则总数对不上"），报告页这两张清单一直漏着。
   ② ★到期分布柱图里，计划完成日正好排在第 43 天的任务，哪个桶都进不去，在图上凭空消失。
      六个周桶覆盖"今天起第 1～42 天"，而"更远"要求严格晚于第 43 天——中间漏掉一整天。
   ③ ★到期饼图的「无日期」没有排除已算逾期的任务：一条"没填计划完成时间、但里程碑拖期"的任务
      在"已逾期"和"无日期"里各算一次；而"更远"是拿总数减出来的，被多减一次会变成负数，
      那一块在饼图上直接消失、各块比例也全错。

   这三处都不影响数据本身，但都直接影响汇报口径，属于"错了也没人报错"的那一类。

   用法：node test/test-p131.js */
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
const d2 = n => String(n).padStart(2, '0');
const dayOff = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())}`; };
const T = (id, extra) => S.stampMeta(S.blank('task', Object.assign({ id, work: 'w1', code: '0101' + id, title: '任务' + id,
  owner: '管理员', assignees: [], status: 'doing', priority: '2', progress: 0, plan_date: '', actual_date: '', source: '', custom: '' }, extra)));
const MS = (id, task, extra) => S.stampMeta(S.blank('milestone', Object.assign({ id, task, plan_date: dayOff(10),
  deliverable: '交付物' + id, report_level: 'section', done: '0' }, extra)));
const sumN = list => (list || []).reduce((a, b) => a + (b.n || 0), 0);

async function main() {
  await tick(150);

  section('① ★同一条任务不许同时出现在「逾期」和「即将到期」两张清单里');
  {
    world({ tasks: [], milestones: [] });
    // 这条任务自己的计划完成时间还在本月内（没到期），但名下里程碑已经拖了 5 天 → isOverdue 判它逾期
    S.DB.tasks = [T('TA', { plan_date: dayOff(3) })];
    S.DB.milestones = [MS('MA', 'TA', { plan_date: dayOff(-5) })];
    S.rebuildIndex();
    const d = S.buildReportData('month', 0, '');
    const inOverdue = d.overdue.some(t => t.id === 'TA');
    const inSoon = d.soonTasks.some(t => t.id === 'TA');
    ok('前提：它确实被判成逾期（里程碑拖期了）', inOverdue, { overdue: d.overdue.map(t => t.id) });
    ok('★它不再重复出现在「即将到期」里', !inSoon, { soon: d.soonTasks.map(t => t.id) });
    ok('★状态四类之和仍然等于当期任务数（不许因为排除而漏掉）',
      d.statusStat.done + d.statusStat.doing + d.statusStat.todo + d.statusStat.late === d.periodTasks.length,
      { st: d.statusStat, n: d.periodTasks.length });

    // 对照：一条真正"只是快到期"的任务，照常进「即将到期」
    S.DB.tasks.push(T('TB', { plan_date: dayOff(2) }));
    S.rebuildIndex();
    const d2r = S.buildReportData('month', 0, '');
    ok('只是快到期、没有拖期的照常列进来', d2r.soonTasks.some(t => t.id === 'TB'), d2r.soonTasks.map(t => t.id));
  }

  section('② ★到期分布柱图：第 43 天那一天不许掉进缝里');
  {
    world({ tasks: [], milestones: [] });
    // 逐天铺满 0～50 天，每天一条任务：每一条都必须落进某个桶
    S.DB.tasks = [];
    for (let i = 0; i <= 50; i++) S.DB.tasks.push(T('D' + i, { plan_date: dayOff(i) }));
    S.DB.milestones = [];
    S.rebuildIndex();
    const live = S.DB.tasks;
    const buckets = S.dueBuckets(live);
    ok('★各桶之和 === 还开着的任务数（一条都不能漏）', sumN(buckets) === live.filter(S.isOpen).length,
      { sum: sumN(buckets), open: live.filter(S.isOpen).length, buckets });
    // 单独盯住第 43 天那一条：它必须出现在"更远"里
    const far = buckets.find(b => b.label === '更远');
    ok('★正好排在第 43 天的那条进了「更远」', far && far.n >= 1, buckets);
    ok('六个周桶覆盖第 1～42 天，一天不多一天不少',
      buckets.filter(b => b.cls === 'bar-soon' || (b.cls === 'bar-norm' && /天$/.test(b.label))).reduce((a, b) => a + b.n, 0) === 42,
      buckets.map(b => [b.label, b.n]));
  }

  section('③ ★到期饼图：「无日期」不许把已算逾期的再数一遍');
  {
    world({ tasks: [], milestones: [] });
    // 没填计划完成时间，但名下里程碑拖期 → 逾期；它只能算进"已逾期"这一类
    S.DB.tasks = [T('TC', { plan_date: '' }), T('TD', { plan_date: '' }), T('TE', { plan_date: dayOff(2) })];
    S.DB.milestones = [MS('MC', 'TC', { plan_date: dayOff(-3) })];
    S.rebuildIndex();
    const live = S.DB.tasks;
    const pie = S.dueSummary(live);
    ok('★四类之和 === 还开着的任务数', sumN(pie) === live.filter(S.isOpen).length, { sum: sumN(pie), open: live.filter(S.isOpen).length, pie });
    ok('★没有负数的那一块（"更远"是减出来的，多减一次就会变负）', pie.every(x => x.n >= 0), pie);
    const none = pie.find(x => x.key === 'none');
    ok('★"无日期"里只剩真正没日期又没拖期的那一条', none && none.n === 1, pie);
    const late = pie.find(x => x.key === 'late');
    ok('拖期的那条算进"已逾期"', late && late.n === 1, pie);
  }

  section('④ 周期边界（跨年也要对）——报表口径的地基');
  {
    for (const off of [-8, -5, -1, 0, 1, 5, 8]) {
      const w = S.periodRange('week', off);
      const ws = new Date(w.start + 'T00:00:00'), we = new Date(w.end + 'T00:00:00');
      ok('周：周一到周日整 7 天', ws.getDay() === 1 && we.getDay() === 0 && Math.round((we - ws) / 86400000) === 6, { off, w });
      const m = S.periodRange('month', off);
      const me = new Date(m.end + 'T00:00:00');
      ok('月：1 号到当月最后一天', /-01$/.test(m.start) && new Date(me.getFullYear(), me.getMonth() + 1, 0).getDate() === me.getDate(), { off, m });
      const q = S.periodRange('quarter', off);
      const qs = new Date(q.start + 'T00:00:00'), qe = new Date(q.end + 'T00:00:00');
      ok('季：季初 1 号到季末最后一天', qs.getDate() === 1 && qs.getMonth() % 3 === 0 && qe.getMonth() % 3 === 2, { off, q });
      const y = S.periodRange('year', off);
      ok('年：1 月 1 日到 12 月 31 日，同一年', /-01-01$/.test(y.start) && /-12-31$/.test(y.end) && y.start.slice(0, 4) === y.end.slice(0, 4), { off, y });
    }
  }

  section('⑤ 一批"必须成立"的口径关系（随机长跑 sim17 验的就是这些，这里钉几条确定性的）');
  {
    world({ tasks: [], milestones: [] });
    S.DB.tasks = [
      T('P1', { plan_date: dayOff(-9), status: 'doing' }),                               // 自己逾期
      T('P2', { plan_date: dayOff(4), status: 'todo' }),                                 // 快到期
      T('P3', { plan_date: dayOff(-20), status: 'done', actual_date: dayOff(-2) }),      // 本期完成
      T('P4', { plan_date: dayOff(5), status: 'hold' }),                                 // 挂起：不算逾期、不进待办
    ];
    S.DB.milestones = [MS('PM1', 'P1', { plan_date: dayOff(-8) }), MS('PM2', 'P3', { plan_date: dayOff(-3), done: '1', actual_date: dayOff(-3) })];
    S.rebuildIndex();
    const d = S.buildReportData('month', 0, '');
    ok('挂起的任务不算逾期', !d.overdue.some(t => t.id === 'P4'), d.overdue.map(t => t.id));
    ok('挂起的任务不计入待办存量', S.backlogAsOf(S.DB.tasks, S.todayStr()) === 2,
      S.backlogAsOf(S.DB.tasks, S.todayStr()));
    ok('本期完成的任务确实已完成、实际完成日在本期',
      d.doneInRange.every(t => t.status === 'done' && t.actual_date >= d.rangeStart && t.actual_date <= d.rangeEnd) && d.doneInRange.length === 1,
      d.doneInRange.map(t => [t.id, t.actual_date]));
    ok('本期已交付的里程碑属于"当期涉及"', d.deliveredInRange.every(m => d.periodMs.some(x => x.id === m.id)),
      { delivered: d.deliveredInRange.map(m => m.id), periodMs: d.periodMs.map(m => m.id) });
    ok('每个人四类之和 === 当期任务里他牵头或参与的条数',
      d.peopleStat.every(p => p.total === d.periodTasks.filter(t => (S.personUnion('task', t).length ? S.personUnion('task', t) : ['（未指派）']).includes(p.nm)).length),
      d.peopleStat.map(p => [p.nm, p.total]));
    ok('里程碑三态之和 === 里程碑总数', (() => {
      const b = S.msStatusBreakdown(S.DB.milestones);
      return b.done + b.overdue + b.notDue === S.DB.milestones.length;
    })());
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { raw.document.querySelectorAll = origQSA; console.error('测试异常：', e); process.exit(1); });
