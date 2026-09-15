/* P126：处里报上来的真实事故——"删掉的里程碑过一阵自己回来了，日志里核对得出来却按日志改不回去"

   现场（截图）：09:26 徐捷删除里程碑「组织召开处室周例会，并组织形成《处室例会纪要》」，进度 57→67；
   15:05 同一条又被删了一次（说明这期间它回来过）；截图时它又回来了（任务名下 7 个里程碑，进度 57）。
   两次回来都没有任何恢复日志。按日志核对只看得到"进度对不上"，而进度是按里程碑自动算的，修不了。
   拿不到事故时的共享文件，所以把"已删记录复活、且不留日志"的每条路径逐条查、逐条修、逐条钉成测试：

   ① ★任务详情保存时误把删除撤回（实测复现）：判断"这一行我动没动"拿存储原值直接比，
      而界面读回会把交付物首尾空白去掉——交付物末尾带个空格/换行（Excel 粘贴、CSV 导入很常见），
      同事在删除落地期间开着这条任务的详情、一个字没动点了保存，删除就被撤回。现在按界面呈现的样子比，没动的格子不写
   ② ★删除状态在日志里是隐形的：删除只写一句话、没有明细；撤回删除时明细里也不含这一项。
      现在删除/恢复/撤回都带"删除状态"明细；按日志核对认得出"日志说删了、现在却还在"（及反过来），并能按日志重新删除
   ③ ★撤销（Ctrl+Z）一条日志都不写：上一轮修掉的"在输入框里按 Ctrl+Z 会撤销上一次数据操作"，
      正会在用户毫无察觉时把刚才的删除撤回，而事后什么都查不到。现在撤销给每条改回的记录补一条带明细的日志
   ④ 同步合并把本机已删的记录撤回成没删、对方文件里又找不到恢复日志：记告警，点名文件是谁用哪个版本写的——
      下次再发生能直接定位到源头那台电脑（多半是还在用旧版本 html 的同事）

   用法：node test/test-p126.js */
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
const DELIV = '组织召开处室周例会，并组织形成《处室例会纪要》。';
// 跟事故里一样：一条任务下若干里程碑，其中一条要被删
function meetingWorld(delivOfMD) {
  // 用 world 的 milestones 参数建，共享文件跟本机才是同一份（world 自带一条 M1「调研报告」）
  world({ milestones: [
    S.stampMeta(S.blank('milestone', { id: 'MK', task: 'T1', plan_date: '2026-09-10', deliverable: '保留的', report_level: 'section', done: '1', actual_date: '2026-09-10' })),
    S.stampMeta(S.blank('milestone', { id: 'MD', task: 'T1', plan_date: '2026-09-15', deliverable: delivOfMD, report_level: 'section', done: '0' })),
  ] });
}
// 任务详情里各格按当前记录填好（沙盒里的输入框默认是空的，不填就等于把任务字段清空后保存）
function fillTaskForm() {
  const t = S.byId('task', 'T1');
  S.schema('task').fields.filter(f => !f.virtual).forEach(f => {
    const v = t[f.key];
    q('#td-' + f.key).value = Array.isArray(v) ? v.join(f.type === 'lines' ? '\n' : ',') : String(v == null ? '' : v);
  });
}
const rowM1 = () => cpRow('M1', '2026-09-20', '调研报告', 'section', '0');
const rowKeep = () => cpRow('MK', '2026-09-10', '保留的', 'section', '1');
const rowMD = () => cpRow('MD', '2026-09-15', DELIV, 'section', '0');   // 界面读回时交付物被 trim 了
const alerts = re => S.DB.changelog.filter(e => e.kind === S.ALERT_LOG_KIND && re.test(e.summary || ''));

async function main() {
  await tick(150);

  section('① ★交付物末尾带空格：同事一次"什么都没改的保存"不许撤回别人的删除（实测复现出来的一条事故路径）');
  {
    meetingWorld(DELIV + ' ');
    await S.Repo.persist(S.DB); await tick(40);
    S.openTaskDetail('T1'); await tick(20);                       // 同事先打开了这条任务
    await landSync(p => bump(Object.assign(p.milestones.find(x => x.id === 'MD'), { deleted_at: LATER() })));   // 删除落地
    await withRows([rowM1(), rowKeep(), rowMD()], saveDetail);               // 同事一个字没动，点保存
    ok('★删除没有被撤回（本机 + 共享文件）', !!S.byId('milestone', 'MD').deleted_at && !!fRec('milestones', 'id', 'MD').deleted_at);
    ok('没动过的格子不拿界面读回的值去重写（交付物末尾那个空格原样留着）', fRec('milestones', 'id', 'MK').deliverable === '保留的');
  }

  section('② ★按日志核对：认得出"日志说删了、现在却还在"，并能按日志重新删除');
  {
    meetingWorld(DELIV);
    await S.Repo.persist(S.DB); await tick(40);
    // 我在任务详情里删掉 MD
    S.openTaskDetail('T1'); await tick(20);
    await withRows([rowM1(), rowKeep()], saveDetail);
    const delLog = S.DB.changelog.filter(e => e.refId === 'MD' && /删除里程碑/.test(e.summary || '')).pop();
    ok('删除日志带上了删除状态的明细', delLog && (delLog.changes || []).some(c => c.k === 'deleted_at' && c.to), delLog);
    ok('进度按剩下的里程碑重算（3 条里交付 1 条 → 2 条里交付 1 条 = 50）', S.byId('task', 'T1').progress === 50, S.byId('task', 'T1').progress);
    // 某台机器上的程序在不该撤回的时候把它撤回了（没有任何恢复日志），同步过来
    await landSync(p => { const m = p.milestones.find(x => x.id === 'MD'); delete m.deleted_at; bump(m); });
    ok('前提：本机这条又回来了、进度又变回 33', !S.byId('milestone', 'MD').deleted_at && S.byId('task', 'T1').progress === 33, S.byId('task', 'T1').progress);
    const issues = S.auditByChangelog();
    const it = issues.find(x => x.entity === 'milestone' && x.id === 'MD' && x.field === 'deleted_at');
    ok('★核对列出了这条里程碑的删除状态对不上（原来根本看不见，只能看到进度对不上）', !!it, issues.map(x => [x.entity, x.field]));
    ok('★这一项可以按日志修复（不是派生字段）', it && S.repairableIssues([it]).length === 1);
    const r = await S.repairByChangelog([it]); await tick(150);
    ok('★按日志修复后重新删除了（本机 + 共享文件），而且确认落地了', r.ok === 1 && !!S.byId('milestone', 'MD').deleted_at && !!fRec('milestones', 'id', 'MD').deleted_at, r);
    ok('进度随之回到 50', S.byId('task', 'T1').progress === 50, S.byId('task', 'T1').progress);
    ok('再核对一次，这一项没了', !S.auditByChangelog().some(x => x.id === 'MD' && x.field === 'deleted_at'));
  }

  section('③ ★撤销（Ctrl+Z）必须留痕：撤回一次删除后，核对不许再误报"日志说删了"');
  {
    meetingWorld(DELIV);
    await S.Repo.persist(S.DB); await tick(40);
    S.openTaskDetail('T1'); await tick(20);
    await withRows([rowM1(), rowKeep()], saveDetail);
    ok('前提：删掉了', !!S.byId('milestone', 'MD').deleted_at);
    await S.undoLast(); await tick(150);
    ok('撤销后它回来了', !S.byId('milestone', 'MD').deleted_at);
    const undoLog = S.DB.changelog.filter(e => e.refId === 'MD' && /撤销/.test(e.summary || '')).pop();
    ok('★撤销留下了一条带删除状态明细的日志（原来一条都没有，事后查不到是谁撤回的）',
      undoLog && (undoLog.changes || []).some(c => c.k === 'deleted_at' && !c.to), S.DB.changelog.slice(-3).map(e => e.summary));
    await S.Repo.persist(S.DB); await tick(60);
    ok('★核对不再把"撤销掉的删除"误报成对不上', !S.auditByChangelog().some(x => x.id === 'MD' && x.field === 'deleted_at'));
  }

  section('④ ★同步撤回了本机已删的记录、又找不到恢复日志：报告警并点名来源');
  {
    meetingWorld(DELIV);
    await S.Repo.persist(S.DB); await tick(40);
    S.openTaskDetail('T1'); await tick(20);
    await withRows([rowM1(), rowKeep()], saveDetail);
    const a0 = alerts(/被这次同步撤回成了没删/).length;
    await landSync(p => {
      const m = p.milestones.find(x => x.id === 'MD'); delete m.deleted_at; bump(m);
      p.lastWriteBy = '小王'; p.lastWriteApp = 'v20260901000000';
    });
    const hit = alerts(/被这次同步撤回成了没删/);
    ok('★报了告警', hit.length === a0 + 1, S.DB.changelog.slice(-2).map(e => e.summary));
    ok('★告警里点名了是谁、用哪个版本写的文件', hit.length && /小王/.test(hit[hit.length - 1].summary) && /v20260901000000/.test(hit[hit.length - 1].summary));

    // 对照：同事是用恢复按钮正经恢复的（留了恢复日志），不报
    meetingWorld(DELIV);
    await S.Repo.persist(S.DB); await tick(40);
    S.openTaskDetail('T1'); await tick(20);
    await withRows([rowM1(), rowKeep()], saveDetail);
    const a1 = alerts(/被这次同步撤回成了没删/).length;
    await landSync(p => {
      const m = p.milestones.find(x => x.id === 'MD'); delete m.deleted_at; bump(m);
      p.changelog = (p.changelog || []).concat([{ id: 'logR', at: LATER(), by: '小王', kind: 'edit', entity: 'milestone', refId: 'MD',
        summary: '恢复了已删除的里程碑「' + DELIV + '」', changes: [{ k: 'deleted_at', from: 'x', to: '' }] }]);
    });
    ok('有正常恢复日志的，不误报', alerts(/被这次同步撤回成了没删/).length === a1);

    // 对照：同事"恢复任务"把名下里程碑一并带回（里程碑自己没有单独的恢复日志）——这是合法路径，不误报
    meetingWorld(DELIV);
    await S.Repo.persist(S.DB); await tick(40);
    S.openTaskDetail('T1'); await tick(20);
    await withRows([rowM1(), rowKeep()], saveDetail);
    const a2 = alerts(/被这次同步撤回成了没删/).length;
    await landSync(p => {
      const m = p.milestones.find(x => x.id === 'MD'); delete m.deleted_at; bump(m);
      p.changelog = (p.changelog || []).concat([{ id: 'logRT', at: LATER(), by: '小王', kind: 'edit', entity: 'task', refId: 'T1',
        summary: '恢复了任务「任务T1」', changes: [{ k: 'deleted_at', from: '已删除', to: '' }] }]);
    });
    ok('恢复任务连带带回的里程碑，不误报', alerts(/被这次同步撤回成了没删/).length === a2);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { raw.document.querySelectorAll = origQSA; console.error('测试异常：', e); process.exit(1); });
