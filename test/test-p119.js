/* P119：第二十七轮排查——账号合并、导入、备份恢复这几条"批量改真实数据"的路

   上一轮挖出"版本号可以倒退 / 被旧副本超过"会丢改动。这一轮顺着"还有哪些地方靠版本号整条定胜负"查，
   又去复查了导入、恢复这几条一次能改几百条记录的入口。全部实测复现过，修复前的版本逐条会红。

   ── 账号：从"整条比版本号"改成逐字段三方合并 ──
   ① ★小王在自己电脑上首次设了 PIN，管理员那边没同步、给他连改两次角色（rev 更高）——
      一同步，小王的 PIN 被【静默抹掉】（连冲突告警都不记），账号退回"待设置"，谁都能认领
   ② 两台管理员机器同时各做一件事（一边重置 PIN、一边降角色），版本号打平，整条取一份，另一件丢了
   ③ 越权检查拦截时原来整条换回本机那份——逐字段合并下会把同事同时做的合法改动（比如本人刚设的 PIN）一起丢掉，
      下一轮还会被当成"我删了 PIN"推出去；改成只把角色换回来
      PIN 的 salt/hash/iterations 当成一个整体合并，绝不拼出"甲的盐 + 乙的哈希"
      顺带更正了越权检查里一句与实际行为不符的注释（"故意不推回文件"——实际上一直会随下一次写入推回）

   ── CSV 导入 ──
   ④ ★拿一份旧导出回来覆盖导入：导出之后同事改的字段被整批改回、同事删的记录被复活。
      现在用变更日志还原"导出那一刻"的值，表里没改的格子保留现状，导出后才删的不复活
   ⑤ 用「编号,状态」小表把有里程碑的任务标成已完成：里程碑不动、日期不补，落下矛盾记录。
      现在跟其它"标已完成"入口一样一并勾完、补日期，并在提示里说清楚

   ── 宽表导入 ──
   ⑥ ★同名交付物（月度报告）按数组顺序认领：表里月份顺序一换，1 月的交付记录被改成 2 月的日期。
      现在先认"名称+日期都对上"的，再在同名里挑日期最近的

   ── 从备份恢复 ──
   ⑦ 本机新建、还没同步出去的记录会被整批替换直接抹掉（对话框承诺"备份之后新建的不会消失"）

   ── 权限 ──
   ⑧ 日期格、换所属工作、直接敲字、多行文本四个提交点补上"落库这一刻"的权限复核（单选/多选早就有）

   用法：node test/test-p119.js */
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
const noPin = u => { delete u.salt; delete u.hash; delete u.iterations; return u; };

async function main() {
  await tick(150);

  section('① ★小王首次设 PIN 已推上去，管理员这边没同步、给他连改两次角色');
  {
    world();
    noPin(S.DB.users.find(u => u.name === '小王'));
    colleague(p => noPin(p.users.find(u => u.name === '小王')));
    await S.pullFromFile(); await tick(40);
    colleague(p => Object.assign(p.users.find(u => u.name === '小王'),
      { salt: 'SS', hash: 'HH', iterations: 1000, rev: 2, updated_at: LATER(), updated_by: '小王' }));
    S.setFileHandle(null);
    await S.ACTIONS['account-role-change']({ name: '小王' }, { value: 'comanager' }); await tick(20);
    await S.ACTIONS['account-role-change']({ name: '小王' }, { value: 'director' }); await tick(20);
    S.setFileHandle(handle);
    await S.Repo.persist(S.DB); await tick(80);
    const fu = fRec('users', 'name', '小王');
    ok('★小王自己设的 PIN 还在（原来被整条盖掉，账号退回待设置）', fu.hash === 'HH' && fu.salt === 'SS' && fu.iterations === 1000, fu);
    ok('管理员改的角色也在', fu.role === 'director', fu.role);
    ok('本机与文件一致', S.DB.users.find(u => u.name === '小王').hash === 'HH');
  }

  section('② 两台管理员机器：一边重置 PIN、一边把角色降级（版本号打平）');
  {
    world();
    S.DB.users.find(u => u.name === '小王').role = 'comanager';
    colleague(p => { p.users.find(u => u.name === '小王').role = 'comanager'; });
    await S.pullFromFile(); await tick(40);
    S.setFileHandle(null);
    S.ACTIONS['admin-reset-pin']({ name: '小王' }); await tick(20); await S.modalCallback(); await tick(30);
    colleague(p => Object.assign(p.users.find(u => u.name === '小王'), { role: 'staff', rev: 2, updated_at: LATER(), updated_by: '老张' }));
    S.setFileHandle(handle);
    await S.Repo.persist(S.DB); await tick(80);
    const fu = fRec('users', 'name', '小王');
    ok('★重置 PIN 生效', !fu.hash && !fu.salt, fu);
    ok('★老张的降级也生效（原来整条取一份，丢一件）', fu.role === 'staff', fu.role);
  }

  section('③ 越权检查只把角色换回来，同事同时做的合法改动（本人设 PIN）保留');
  {
    world();
    noPin(S.DB.users.find(u => u.name === '小王'));
    colleague(p => noPin(p.users.find(u => u.name === '小王')));
    await S.pullFromFile(); await tick(40);
    // 文件里小王被人越权抬成管理员，同时带着他本人刚设的 PIN
    colleague(p => Object.assign(p.users.find(u => u.name === '小王'),
      { role: 'admin', salt: 'S2', hash: 'H2', iterations: 1000, rev: 4, updated_at: LATER(), updated_by: '小王' }));
    await S.pullFromFile(); await tick(40);
    const lu = S.DB.users.find(u => u.name === '小王');
    ok('越权的角色被拦下', lu.role === 'staff', lu.role);
    ok('★本人刚设的 PIN 没被一起丢掉', lu.hash === 'H2' && lu.salt === 'S2', lu);
    for (let k = 0; k < 2; k++) { await S.Repo.persist(S.DB); await tick(30); }
    ok('★之后的写入不会把 PIN 当成"我删了"推出去', fRec('users', 'name', '小王').hash === 'H2', fRec('users', 'name', '小王'));
  }

  section('③b PIN 三个字段整体合并：两边都改了 PIN，结果不许拼出"甲的盐 + 乙的哈希"');
  {
    /* 真正会拼坏的场景：甲把 PIN 重置了（三格清空），乙那边本人重新设了 PIN（迭代次数跟原来一样）。
       逐格判的话，"迭代次数"那格乙没变、甲清空了 → 取甲的空值；盐和哈希两边都变 → 取更新的乙——
       拼出"乙的盐 + 乙的哈希 + 没有迭代次数"，谁的 PIN 都验不过。 */
    const base = { name: 'X', role: 'staff', salt: 's0', hash: 'h0', iterations: 1000, rev: 3, updated_at: '2026-09-01T00:00:00.000Z', updated_by: 'a' };
    const local = { name: 'X', role: 'staff', rev: 4, updated_at: '2026-09-02T00:00:00.000Z', updated_by: '甲' };   // 重置：三格都删了
    const remote = Object.assign({}, base, { salt: 'sR', hash: 'hR', rev: 4, updated_at: '2026-09-03T00:00:00.000Z', updated_by: '乙' });
    S.setObjConflicts([]);
    const r = S.mergeUserThreeWay(local, remote, base);
    const combo = [r.salt, r.hash, r.iterations].map(v => v == null ? '空' : v).join('|');
    ok('★结果是某一方完整的一套 PIN（要么整套清空，要么乙完整的那套）', combo === '空|空|空' || combo === 'sR|hR|1000', combo);
  }

  section('④ ★旧导出覆盖导入：导出之后同事改的字段、删的记录都不许被改回/复活');
  {
    world();
    const csv = exportCsv('task');
    await landSync(p => {
      bump(Object.assign(p.tasks.find(t => t.id === 'T2'), { deleted_at: LATER() }));
      bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { owner: '小王', source: '同事写的来源' }));
      p.changelog = (p.changelog || []).concat([{ id: 'logC1', at: LATER(), by: '同事', kind: 'edit', entity: 'task',
        refId: 'T1', taskId: 'T1', summary: '牵头人：管理员→小王；来源：空→同事写的来源',
        changes: [{ k: 'owner', from: '管理员', to: '小王' }, { k: 'source', from: '', to: '同事写的来源' }] }]);
    });
    // 我在 Excel 里改了 T1 的标题，同时【也改了来源】（真冲突，我明确改过的格子照写）
    const lines = csv.split('\r\n');
    const hdr = lines[0].split(','), iT = hdr.indexOf('title'), iS = hdr.indexOf('source');
    const rows = lines.map((l, i) => { if (i === 0) return l; const c = l.split(','); if (c[hdr.indexOf('id')] === 'T1') { c[iT] = '我在Excel改的标题'; c[iS] = '我写的来源'; } return c.join(','); });
    S.setSnackPriorityUntil(0);
    await S.applyCSVImport('task', 'overwrite', rows.join('\r\n')); await tick(200);
    const t1 = fRec('tasks', 'id', 'T1'), t2 = fRec('tasks', 'id', 'T2');
    ok('我改的标题进去了', t1.title === '我在Excel改的标题', t1.title);
    ok('★同事导出之后改的牵头人没被改回（原来被旧表改回管理员）', t1.owner === '小王', t1.owner);
    ok('我明确改过的来源照写（真冲突时表里的明确修改算数）', t1.source === '我写的来源', t1.source);
    ok('★同事导出之后删掉的 T2 没被复活', !!t2.deleted_at);
    ok('提示/日志里说清楚了', /导出之后被人改过/.test(S.DB.changelog.map(e => e.summary || '').join('\n')));

    world();
    await S.applyCSVImport('task', 'overwrite', 'code,owner\r\n01012T1,小王\r\n'); await tick(150);
    ok('回归：不带 rev 列的手工小表照常覆盖', fRec('tasks', 'id', 'T1').owner === '小王');
  }

  section('⑤ 小表把有里程碑的任务标成已完成：跟别的入口一样一并勾完、补日期');
  {
    world();
    await S.applyCSVImport('task', 'overwrite', 'code,status\r\n01012T1,done\r\n'); await tick(150);
    const t = S.byId('task', 'T1');
    ok('★里程碑一并勾完', S.byId('milestone', 'M1').done === '1');
    ok('★进度 100、实际完成时间补上', t.progress === 100 && !!t.actual_date, { p: t.progress, a: t.actual_date });
    ok('体检里没有"已完成却有未交付里程碑"', !(S.healthCheck().doneWithOpenCp || []).length);
  }

  section('⑥ ★宽表导入：同名交付物按日期对号，不按数组顺序');
  {
    world();
    S.DB.milestones = [
      S.stampMeta(S.blank('milestone', { id: 'MJ', task: 'T1', plan_date: '2026-01-31', deliverable: '月度报告', report_level: 'section', done: '1', actual_date: '2026-01-30' })),
      S.stampMeta(S.blank('milestone', { id: 'MF', task: 'T1', plan_date: '2026-02-28', deliverable: '月度报告', report_level: 'section', done: '0', actual_date: '' })),
    ];
    S.rebuildIndex();
    await S.applyWideImport('merge', wideRow({ '所属工作项': '工作一', '任务项编号': '01012T1', '任务项名称': '任务T1',
      '里程碑时间1': '2026-02-28', '里程碑交付物1': '月度报告', '里程碑时间2': '2026-01-31', '里程碑交付物2': '月度报告' }));
    await tick(80);
    const mj = S.byId('milestone', 'MJ'), mf = S.byId('milestone', 'MF');
    ok('★1 月那条仍是 1 月、已交付、交付日期不变', mj.plan_date === '2026-01-31' && mj.done === '1' && mj.actual_date === '2026-01-30', mj);
    ok('★2 月那条仍是 2 月、未交付', mf.plan_date === '2026-02-28' && mf.done === '0', mf);

    // 两遍认领：前一组按名称就近时，不许抢走后一组完全对得上的那条
    world();
    S.DB.milestones = [
      S.stampMeta(S.blank('milestone', { id: 'MA', task: 'T1', plan_date: '2026-03-31', deliverable: '季报', report_level: 'section', done: '1', actual_date: '2026-03-30' })),
      S.stampMeta(S.blank('milestone', { id: 'MB', task: 'T1', plan_date: '2026-06-30', deliverable: '季报', report_level: 'section', done: '0', actual_date: '' })),
    ];
    S.rebuildIndex();
    await S.applyWideImport('merge', wideRow({ '所属工作项': '工作一', '任务项编号': '01012T1', '任务项名称': '任务T1',
      '里程碑时间1': '2026-05-15', '里程碑交付物1': '季报', '里程碑时间2': '2026-03-31', '里程碑交付物2': '季报' }));
    await tick(80);
    ok('★完全对得上的那组先认领：3 月那条（已交付）原样不动', S.byId('milestone', 'MA').plan_date === '2026-03-31' && S.byId('milestone', 'MA').done === '1');
    ok('另一组认领剩下那条并改日期', S.byId('milestone', 'MB').plan_date === '2026-05-15');
  }

  section('⑦ 从备份恢复：本机新建、还没同步出去的记录不许被抹掉');
  {
    world();
    const backup = JSON.stringify(S.backupSnapshot());
    S.setFileHandle(null);   // 离线新建了一条
    S.DB.tasks.push(S.stampMeta(S.blank('task', { id: 'TNEW', work: 'w1', code: '0101299', title: '离线新建的任务', owner: '管理员' })));
    S.rebuildIndex();
    S.setFileHandle(handle);
    S.importBackup(backup); await tick(30);
    await S.modalCallback(); await tick(250);
    ok('★本机新建的那条还在（本机 + 共享文件）', !!S.byId('task', 'TNEW') && !!fRec('tasks', 'id', 'TNEW'));
    ok('备份里的记录照常恢复', !!S.byId('task', 'T1'));
  }

  section('⑧ 单元格编辑落库前复核权限：日历开着时我被移出了参与人');
  {
    world();
    S.DB.settings.me = '小王';
    const t = S.byId('task', 'T1'); t.owner = '管理员'; t.assignees = ['小王']; S.rebuildIndex();
    await S.Repo.persist(S.DB); await tick(40);
    S.openDatePicker('task', 'T1', 'plan_date', q('#td'));
    await landSync(p => bump(Object.assign(p.tasks.find(x => x.id === 'T1'), { assignees: [] })));
    await S.dpCommit('2026-11-11'); await tick(100);
    ok('★不再有权限时，这次改动不落库', S.byId('task', 'T1').plan_date !== '2026-11-11' && fRec('tasks', 'id', 'T1').plan_date !== '2026-11-11',
      S.byId('task', 'T1').plan_date);
    S.DB.settings.me = '管理员';
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
