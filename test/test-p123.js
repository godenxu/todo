/* P123：第三十一轮排查——异常日期让图表失效、让页面卡死

   上一轮决定"认不出来的日期原样保留、不删"，这一轮回头查它的副作用，并把图表页全部标签、
   任务页全部视图、报告导出都渲染了一遍（上一轮只打开了各页面的默认视图，甘特图没覆盖到）。
   实测复现过，修复前的版本会红。

   ① ★一个认不出来的里程碑日期（"garbage"）算出 NaN，Math.max 整体变 NaN——
      整张甘特图所有里程碑的位置一起失效（--today:NaN%），不只是那一条。图表页和工作台都受影响。
      现在甘特图只取认得出来的日期（认不出来的由数据体检 badDate 列出）
   ② ★★一个日期手滑写成 9999-12-31：时间轴跨度几百万天，画刻度是逐天循环——
      图表页甘特图渲染 20 秒、报告导出图片 25 秒，工作台每次同步重绘都冻住一次。
      现在时间轴最多铺三年，超出的不画（"时间趋势"那张图早就有 120 个月封顶，甘特图是漏掉的那两处）
   ③ "按月计划完成"序列里，"abc" 按字符串比比所有年份都大，把序列一路撑到 120 个月封顶。现在只认合法月份

   查过没问题的：搜索/筛选没有用用户输入拼正则（输入括号、星号不会出错）；
   CSV 导出再覆盖导入，逗号、双引号、换行、=/-/+/@ 开头的公式前缀、多值字段，全部往返无损（钉成 ④）。

   用法：node test/test-p123.js */
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

const { elCache } = require('./harness.js');
const exportCsv = ent => { const h = S.csvHeaders(ent); return '﻿' + [h.join(',')].concat(S.coll(ent).map(r => h.map(k => S.toCSVField(S.csvCell(ent, r, k))).join(','))).join('\r\n'); };
const htmlHas = pat => { for (const [, el] of elCache) if (typeof el.innerHTML === 'string' && el.innerHTML.indexOf(pat) !== -1) return true; return false; };
const clearHtml = () => { for (const [, el] of elCache) el.innerHTML = ''; };
const T = (id, extra) => S.stampMeta(S.blank('task', Object.assign({ id, work: 'w1', code: '0101' + id, title: '任务' + id, owner: '管理员', status: 'doing', progress: 30 }, extra)));
const MS = (id, task, plan_date, extra) => S.stampMeta(S.blank('milestone', Object.assign({ id, task, plan_date, deliverable: '交付物' + id, done: '0' }, extra)));

async function main() {
  await tick(150);

  section('① ★一个认不出来的里程碑日期，不许让整张甘特图的位置全部失效');
  {
    world();
    S.DB.tasks.push(T('TA'), T('TC'));
    S.DB.milestones.push(MS('MA', 'TA', 'garbage'), MS('MB', 'TC', '2026-11-11'));
    S.DB.works[0].year = 2026; S.rebuildIndex();
    clearHtml(); S.ACTIONS['chart-tab']({ k: 'gantt' }); S.setPage('charts'); S.renderPage(); await tick(20);
    ok('★图表页甘特图没有 NaN 位置（原来 --today:NaN%，所有里程碑一起错位）', !htmlHas('NaN'));
    ok('正常的里程碑照样画出来', htmlHas('gantt-pt'));
    clearHtml(); S.setPage('dashboard'); S.renderPage(); await tick(20);
    ok('工作台上的甘特图也没有 NaN', !htmlHas('NaN'));
  }

  section('② ★一个日期手滑写成 9999-12-31，甘特图不许卡死');
  {
    world();
    S.DB.tasks.push(T('TA'), T('TB'));
    S.DB.milestones.push(MS('MA', 'TA', '2026-09-01'), MS('MF', 'TB', '9999-12-31'));
    S.DB.works[0].year = 2026; S.rebuildIndex();
    let t0 = Date.now();
    S.ACTIONS['chart-tab']({ k: 'gantt' }); S.setPage('charts'); S.renderPage();
    const ms1 = Date.now() - t0;
    ok('★图表页甘特图 3 秒内画完（原来要 20 秒，工作台每次同步重绘都冻一次）', ms1 < 3000, ms1 + 'ms');
    await S.saveReportConfig(cfg => { S.reportPresetIn(cfg).sections = [{ id: 'sg', title: '甘特', modules: ['msGantt'] }]; });
    S.setPage('report'); S.renderPage();
    t0 = Date.now();
    await S.exportReportImage();
    const ms2 = Date.now() - t0;
    ok('★报告导出图片里的甘特图 3 秒内画完（原来 25 秒）', ms2 < 3000, ms2 + 'ms');
  }

  section('③ "按月计划完成"序列：认不出来的日期不许把序列一路撑到 120 个月');
  {
    const s1 = S.planDueSeries([{ plan_date: 'abc' }, { plan_date: S.todayStr() }], []);
    ok('★序列长度正常（原来被 "abc" 撑到封顶 120 个月）', s1.length <= 2, s1.length);
  }

  section('④ 回归护栏：CSV 导出再覆盖导入，逗号/引号/换行/公式前缀一个字都不许变');
  {
    world();
    const t = S.byId('task', 'T1');
    Object.assign(t, { title: '含,逗号|含"双引号"|第一行\n第二行|=1+1|-减号|@at| 前后空格 ', source: '=HYPERLINK("x")', owner: '张,三', assignees: ['李"四', '王\n五', '=赵六'] });
    const w = S.byId('work', 'w1'); Object.assign(w, { name: '工作,"名"\n换行', content: ['第一条,含逗号', '"第二条"', '=第三条'], collaborators: ['甲,乙', '丙'] });
    const d = S.byId('duty', '01'); d.name = '职责"一",含逗号';
    [t, w, d].forEach(r => S.stampMeta(r));
    S.rebuildIndex(); await S.Repo.persist(S.DB); await tick(60);
    const diffs = [];
    for (const ent of ['task', 'work', 'duty']) {
      const before = JSON.parse(JSON.stringify(S.coll(ent)));
      await S.applyCSVImport(ent, 'overwrite', exportCsv(ent)); await tick(60);
      const pk = S.schema(ent).pk;
      before.forEach(b => {
        const a = S.coll(ent).find(x => x[pk] === b[pk]);
        S.schema(ent).fields.filter(f => !f.virtual).forEach(f => { if (!a || JSON.stringify(a[f.key]) !== JSON.stringify(b[f.key])) diffs.push(`${ent}.${f.key}`); });
      });
      if (S.coll(ent).length !== before.length) diffs.push(ent + ' 条数变了');
    }
    ok('CSV 往返无损', diffs.length === 0, diffs);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
