/* P121：第二十九轮排查——同一台电脑开两个标签页、编号撞号的连锁影响

   全部实测复现过，修复前的版本逐条会红。

   ── 多标签页 ──
   ① ★同一台电脑把系统开了两个标签页（很常见：收藏夹点一次、桌面快捷方式又点一次）。
      两个标签页各有一份内存数据，却共用同一份浏览器本地缓存，后保存的整份盖掉先保存的。
      离线/需要重新授权时改动只在本地缓存里——实测 A 标签页离线改的任务，被 B 标签页一次保存抹掉。
      修法：新打开的标签页启动时"举手"，旧标签页停止一切写入并盖上提示，点按钮可重新加载接管。

   ── 编号撞号（两人同时新建会撞，体检里有专门一项，说明真发生过）的连锁影响 ──
   ② ★CSV 覆盖导入：表里带着正确的 id，只要按编号能找到一条就改用编号那条——
      撞号时 T1、T2 两行都写到了 T1 上，T2 的修改丢失。现在 id 对得上就信 id；
      没有 id、编号又对应好几条时跳过不猜，并在提示里说明
   ③ 宽表导入（没有 id 列）按编号取第一条，同样写错任务。现在用"同工作同名"区分，分不清就跳过
   ④ ★数据体检"清理重复工作"只看同年度同编号——两位管理员撞号建的两项不同工作，被当复制品一键软删；
      "清理重复任务"只看同工作同名——牵头人、日期都不同的"月度数据报送"被当复制品删掉。
      现在工作要同名、任务要同牵头人同计划完成时间才算复制品；撞号的工作仍由"工作编号撞号"一项列出

   ── 没有同步基线时的"本机改动凭据"不全 ──
   ⑤ ★没有基线时（旧缓存、刚恢复过备份、刚重置过缓存），合并靠"整条动过"和"改了哪几格"两种凭据认本机改动，
      有字段明细时整条标记会被忽略。而软删除/恢复、一并勾完里程碑、指派未归属任务、体检修复、年度复制、
      宽表认领里程碑、换所属工作时的编号……这些入口只盖戳不留字段明细——
      一旦之后又被导入记了明细，前面那次改动就被文件旧值顶回。逐个补上字段凭据
   ⑥ 源码护栏：所有给业务记录盖戳的地方必须留字段级凭据，以后新加入口漏了会变红

   用法：node test/test-p121.js */
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

const exportCsv = ent => { const h = S.csvHeaders(ent); return [h.join(',')].concat(S.coll(ent).map(r => h.map(k => S.toCSVField(S.csvCell(ent, r, k))).join(','))).join('\r\n'); };
const wideRow = cells => { const hs = S.wideImportHeaders(); return hs.join(',') + '\r\n' + hs.map(h => cells[h] || '').join(',') + '\r\n'; };

async function tabsScenario() {
  // 第二个独立实例 = 同一台电脑上的另一个标签页；两者共用同一份本地存储
  const HP = require.resolve('./harness.js');
  const A = { sandbox: S, raw, q, store: require('./harness.js').store };
  delete require.cache[HP];
  const B = require('./harness.js');
  await tick(250);
  const shared = A.store;
  const other = inst => (inst === A ? B : A);
  const bind = inst => {
    inst.raw.localStorage.getItem = k => (shared.has(k) ? shared.get(k) : null);
    inst.raw.localStorage.setItem = (k, v) => {
      shared.set(k, String(v));
      (other(inst).raw.window._on.storage || []).forEach(fn => fn({ key: k, newValue: String(v) }));   // 浏览器只通知"别的"标签页
    };
    inst.raw.localStorage.removeItem = k => shared.delete(k);
  };
  bind(A); bind(B);
  for (const X of [A, B]) { X.sandbox.setFileHandle(null); X.sandbox.setEverConnected(true); }
  world();   // 只重置 A 这个实例
  S.setFileHandle(null);
  await S.Repo.persist(S.DB); await tick();
  const a1 = S.byId('task', 'T1'); a1.title = '在A标签页离线改的'; S.stampMeta(a1); await S.Repo.persist(S.DB); await tick();
  // B 标签页这时才打开：举手接管，再读本地缓存
  B.raw.localStorage.setItem('todo_v4_active_tab', JSON.stringify({ id: 'tabB', at: Date.now() })); await tick();
  const cache0 = JSON.parse(shared.get(S.STORAGE_KEY));
  B.sandbox.DB.tasks = cache0.tasks; B.sandbox.DB.milestones = cache0.milestones; B.sandbox.rebuildIndex();
  ok('★旧标签页盖上了"已在另一个标签页打开"的提示', q('#login-gate').classList.contains('show') && /另一个标签页/.test(q('#login-body').innerHTML));
  // 旧标签页残留的一次保存（它内存里没有 B 之后的改动）
  const a2 = S.byId('task', 'T2'); a2.title = '被接管之后A又改的'; S.stampMeta(a2); await S.Repo.persist(S.DB); await tick();
  const b2 = B.sandbox.byId('task', 'T2'); b2.source = '在B标签页改的来源'; B.sandbox.stampMeta(b2); await B.sandbox.Repo.persist(B.sandbox.DB); await tick();
  await S.Repo.persist(S.DB); await tick();   // 旧标签页再保存一次
  const cache = JSON.parse(shared.get(S.STORAGE_KEY));
  const T = id => cache.tasks.find(t => t.id === id);
  ok('★A 在被接管之前做的离线改动还在', T('T1').title === '在A标签页离线改的', T('T1').title);
  ok('★B 的改动没被旧标签页整份盖掉', T('T2').source === '在B标签页改的来源', T('T2'));
  ok('★被接管的旧标签页不能再往本地缓存里写', T('T2').title !== '被接管之后A又改的', T('T2').title);
  ok('被接管的旧标签页也不再碰共享文件', await S.syncToFile(S.DB) === 'blocked');
}

async function main() {
  await tick(150);

  section('② ★CSV 覆盖导入：编号撞号时按表里的 id 认领，不按编号');
  {
    world();
    S.byId('task', 'T2').code = S.byId('task', 'T1').code; S.stampMeta(S.byId('task', 'T2')); S.markLocallyChangedFields(S.byId('task', 'T2'), ['code']); S.rebuildIndex();   // 盖戳+字段凭据，跟真实入口一致：撞号是真实存在的本机数据
    const csv = exportCsv('task');
    const hdr = csv.split('\r\n')[0].split(','), iT = hdr.indexOf('title'), iId = hdr.indexOf('id');
    const out = csv.split('\r\n').map((l, i) => { if (!i) return l; const c = l.split(','); if (c[iId] === 'T1') c[iT] = 'T1新标题'; if (c[iId] === 'T2') c[iT] = 'T2新标题'; return c.join(','); }).join('\r\n');
    await S.applyCSVImport('task', 'overwrite', out); await tick(150);
    ok('★T1、T2 各归各的（原来两行都写到了 T1 上，T2 的修改丢失）',
      S.byId('task', 'T1').title === 'T1新标题' && S.byId('task', 'T2').title === 'T2新标题', [S.byId('task', 'T1').title, S.byId('task', 'T2').title]);

    world();
    S.byId('task', 'T2').code = S.byId('task', 'T1').code; S.stampMeta(S.byId('task', 'T2')); S.markLocallyChangedFields(S.byId('task', 'T2'), ['code']); S.rebuildIndex();   // 盖戳+字段凭据，跟真实入口一致：撞号是真实存在的本机数据
    await S.applyCSVImport('task', 'overwrite', `code,title\r\n${S.byId('task', 'T1').code},没有id的手工表\r\n`); await tick(150);
    ok('★没有 id、编号又对应两条：跳过不猜', S.byId('task', 'T1').title !== '没有id的手工表' && S.byId('task', 'T2').title !== '没有id的手工表');
    ok('★并在提示/日志里说明', /编号又同时对应好几条任务/.test(S.csvImportNote || '') || S.DB.changelog.some(e => /编号又同时对应好几条任务/.test(e.summary || '')));
  }

  section('③ 宽表导入：编号撞号时用"同工作同名"区分，分不清就跳过');
  {
    world();
    S.byId('task', 'T2').code = S.byId('task', 'T1').code; S.stampMeta(S.byId('task', 'T2')); S.markLocallyChangedFields(S.byId('task', 'T2'), ['code']); S.rebuildIndex();   // 盖戳+字段凭据，跟真实入口一致：撞号是真实存在的本机数据
    const code = S.byId('task', 'T1').code;
    const r = await S.applyWideImport('merge', wideRow({ '所属工作项': '工作一', '任务项编号': code, '任务项名称': '任务T2', '任务项牵头人': '小王' }));
    await tick(80);
    ok('★按同工作同名认领到了 T2（原来写到第一条 T1 上）', S.byId('task', 'T2').owner === '小王' && S.byId('task', 'T1').owner !== '小王');
    const r2 = await S.applyWideImport('merge', wideRow({ '所属工作项': '工作一', '任务项编号': code, '任务项名称': '改了名字', '任务项牵头人': '老张' }));
    await tick(80);
    ok('★分不清是哪一条时跳过，不去猜', r2 && r2.dupCodeSkipped === 1 && S.byId('task', 'T1').owner !== '老张' && S.byId('task', 'T2').owner !== '老张', r2);
  }

  section('④ ★数据体检的"重复"判据：撞号的真实工作、合法的同名任务不能被一键删掉');
  {
    world();
    S.DB.works.push(S.stampMeta(S.blank('work', { id: 'wA', code: '0103', duty: '01', name: '甲建的数据治理', owner: '管理员', year: 2026, status: 'doing' })));
    S.DB.works.push(S.stampMeta(S.blank('work', { id: 'wB', code: '0103', duty: '01', name: '乙建的安全评估', owner: '小王', year: 2026, status: 'doing' })));
    S.DB.tasks.push(S.stampMeta(S.blank('task', { id: 'TM1', work: 'w1', code: '0101901', title: '月度数据报送', owner: '管理员', plan_date: '2026-01-31' })));
    S.DB.tasks.push(S.stampMeta(S.blank('task', { id: 'TM2', work: 'w1', code: '0101902', title: '月度数据报送', owner: '小王', plan_date: '2026-02-28' })));
    S.DB.tasks.push(S.stampMeta(S.blank('task', { id: 'TD1', work: 'w1', code: '0101903', title: '导入两次的任务', owner: '管理员', plan_date: '2026-03-31' })));
    S.DB.tasks.push(S.stampMeta(S.blank('task', { id: 'TD2', work: 'w1', code: '0101904', title: '导入两次的任务', owner: '管理员', plan_date: '2026-03-31' })));
    S.rebuildIndex();
    const h = S.healthCheck();
    ok('★撞号但名称不同的两项工作不算复制品', !h.dupWorkIds.includes('wB') && !h.dupWorkIds.includes('wA'), h.dupWorkIds);
    ok('★牵头人、日期不同的同名任务不算复制品', !h.dupTaskIds.includes('TM2'), h.dupTaskIds);
    ok('真正一模一样的复制品照样查得出来', h.dupTaskIds.length === 1 && ['TD1', 'TD2'].includes(h.dupTaskIds[0]), h.dupTaskIds);
    ok('撞号的工作仍由"工作编号撞号"一项列出来', h.issues.some(i => i.k === 'dupCode'));
  }

  section('⑤ ★没有同步基线时：只盖戳不记明细的改动，不许被后来的导入凭据挤掉');
  {
    world({ tasks: [{ id: 'T5', work: '' }] });   // 一条未归属的任务；world 清了基线
    S.openOrphanAssign(); await tick(30);
    q('#oa-work').value = 'w2';
    const origQSA = raw.document.querySelectorAll;
    raw.document.querySelectorAll = sel => (sel === '.oa-cb:checked' ? [{ value: 'T5' }] : (origQSA ? origQSA(sel) : []));
    S.setFileHandle(null);   // 离线做的
    await S.modalCallback(); await tick(80);
    raw.document.querySelectorAll = origQSA;
    const code5 = S.byId('task', 'T5').code;
    // 还没同步，又用宽表改了这条任务的牵头人（宽表只记它碰过的那几个字段）
    await S.applyWideImport('merge', wideRow({ '所属工作项': '工作二', '任务项编号': code5, '任务项名称': '任务T5', '任务项牵头人': '小王' }));
    await tick(60);
    S.clearSyncBaseline && (S.DB.syncBase = null);
    S.setFileHandle(handle);
    await S.Repo.persist(S.DB); await tick(120);
    const f5 = fRec('tasks', 'id', 'T5');
    ok('★指派的工作和重新生成的编号都推上去了（原来被导入的字段凭据挤掉、文件里的旧值顶回）',
      f5.work === 'w2' && f5.code === code5 && !!code5, f5);
    ok('宽表改的牵头人也在', f5.owner === '小王', f5.owner);
  }

  section('⑥ 源码护栏：给业务记录盖戳的地方，都要留下字段级凭据');
  {
    const L = SRC.split(/\r?\n/);
    // 不涉及这条规矩的：账号/配置（有各自的合并规则）、新建记录（文件里本来没有）、Repo.upsert（调用方负责记日志）、演示数据
    const EXEMPT = /function stampMeta|stampMeta\((u|user|fresh|u2|next|cfg|DB\.permissionMatrix|copy)\)|stampMeta\(blank\(|\.push\(stampMeta|^\s*stampMeta\(rec\);$/;
    const bad = [];
    L.forEach((l, i) => {
      if (!/stampMeta\(/.test(l) || /^\s*(\/\/|\/\*|\*)/.test(l) || EXEMPT.test(l)) return;
      if (/[一-龥]/.test(l) && !/[;{}]\s*(\/\/.*)?$/.test(l)) return;   // 多行注释的续行
      if (/function seedAll/.test(L.slice(Math.max(0, i - 80), i).join('\n'))) return;
      const win = L.slice(Math.max(0, i - 12), i + 12).join('\n');
      if (!/logRecordChange\(|markLocallyChangedFields\(|diffRecordChanges/.test(win)) bad.push((i + 1) + ': ' + l.trim().slice(0, 80));
    });
    ok('没有"只盖戳、不留字段凭据"的业务记录改动入口', bad.length === 0, bad);
  }

  // 放在最后：跑完之后这个实例处于"被另一个标签页接管、停写"状态，放前面会让后面几段的保存全被静默拦下
  section('① ★同一台电脑开了两个标签页：只让最新打开的那个写');
  await tabsScenario();

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
