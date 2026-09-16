/* P128：第三十六轮排查——把"读回来的值 ≠ 存储的值"这条教训推到其它编辑入口，并给「按日志核对数据」做体检

   上一轮（P127）在任务详情里修掉了"我一个字没改的保存，把同事的改动顶回去"。这一轮先查同类：
   凡是"打开时拿到一个值、提交时再读回来比一比"的地方，只要控件会规整值（去首尾空白、吞换行、
   下拉值不在选项里就显示第一项、多行文本会剥掉行号），拿存储原值去比就会把"没改"判成"改了"。
   三个入口实测复现（探针 probe-p128a.js）：

   ① ★表格里双击单元格、一个字没改就点到别处（失焦即提交）：原值末尾有空格时被判成改过，
      同事在这期间改的这一格被顶回旧值，日志里还留下一条我根本没改过的记录
   ② ★多行文本编辑器（工作的「主要工作内容」）：内容带行号或末尾空格时，打开直接点保存同样会顶掉同事的改动
   ③ ★下拉弹层：同事改了这一格并同步过来，而弹层里高亮的还是我打开时那一项，我点一下"同一项"
      （用户的意思只是"就用我看到的这个"）就把他的改动改回去了。多选那条路早就防住了，单选一直漏着
   ④ 日期选择器同理：点的还是打开日历时的那一天，而这一格已经被同事改过

   然后给「按日志核对数据」本身做体检——它是事故发生后唯一的自救工具，它误报比漏报更危险
   （管理员照着"按日志修复"点下去，就把新数据改回旧值了）。多实例长跑（sim16 这轮加了单元格编辑、
   下拉、日历、多行文本四类动作，并把"静止之后核对必须一条不报"变成长跑判据）撞出四类误报：

   ⑤ ★几台电脑时钟差一两分钟时，"谁后改的"判反：甲的表快，他更早做的修改日志时间反而更晚，
      于是拿甲那条旧日志去比乙的新数据。现在：最后那条日志的时钟误差窗口内，只要另有一条日志
      正好说明了现在这个值，就认为先后分不清、不报（窗口用跟时钟不同步告警同一个阈值）
   ⑥ ★恢复任务会连带恢复跟它一起被删的里程碑，而那次恢复只在任务上留日志——核对把这些里程碑
      全报成"日志说删了、现在还在"，一修复又被重新删掉
   ⑦ ★把任务标成"已完成"时程序自动勾完名下里程碑（completeCheckpointsOf），这一步在里程碑上
      一条日志都不写：既查不到是谁勾的，核对也会报"日志说未完成、现在已完成"。现在逐条留痕
   ⑧ ★CSV 导入、宽表导入、未归属批量指派这些"一次改几百条、只写一条汇总日志"的动作，
      核对同样会把它们改过的每一格报成对不上。现在汇总日志带上覆盖范围（bulkScope），核对认得出来就跳过；
      从备份恢复、回滚异常同步这类整份覆盖的动作也一并认

   还顺手统一了核对里那个"一格一个键"的拼法：分隔符原来是就地写的一个 NUL 字符，肉眼看不出来，
   我按空格拼了第二处就永远查不到——收成 auditKeyOf 一个函数。

   用法：node test/test-p128.js */
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
// 任务详情里各格按当前记录填好（沙盒里的输入框默认是空的，不填就等于把任务字段清空后保存）
function fillTaskForm() {
  const t = S.byId('task', 'T1');
  S.schema('task').fields.filter(f => !f.virtual).forEach(f => {
    const v = t[f.key];
    q('#td-' + f.key).value = Array.isArray(v) ? v.join(f.type === 'lines' ? '\n' : ',') : String(v == null ? '' : v);
  });
}
const rowM1 = () => cpRow('M1', '2026-09-20', '调研报告', 'section', '0');


// 表格单元格：真实 DOM 里是现造一个 input 塞进 td。这里给一个最小 td 桩，把 input 抓出来
function mkTd() {
  let input = null;
  return { innerHTML: '', appendChild(el) { input = el; }, get input() { return input; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }), closest: () => null };
}
const blur = td => td.input._on.blur.forEach(fn => fn());
const iso = ms => new Date(ms).toISOString();
const logsOf = id => S.DB.changelog.filter(e => e.refId === id);

async function main() {
  await tick(150);

  section('① ★单元格双击打开、一个字没改就点到别处：不许顶掉同事的改动，也不许悄悄改原值');
  {
    world({ tasks: [], milestones: [] });
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { title: '任务一 ' })));
    const td = mkTd();
    S.openEditor('task', 'T1', 'title', td);
    ok('前提：输入框里是原值，末尾空格还在', td.input && td.input.value === '任务一 ', td.input && JSON.stringify(td.input.value));
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { title: '同事改的标题' })));
    const n0 = S.DB.changelog.length;
    blur(td); await tick(300);
    ok('★同事改的标题留着（我一个字没动）', S.byId('task', 'T1').title === '同事改的标题', S.byId('task', 'T1').title);
    ok('也没有凭空写一条"我改过"的日志', S.DB.changelog.length === n0, S.DB.changelog.slice(n0).map(e => e.summary));

    // 没人跟我抢的时候，原值原样留着（不许被悄悄 trim）
    world({ tasks: [], milestones: [] });
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { title: '任务一 ' })));
    const td2 = mkTd();
    S.openEditor('task', 'T1', 'title', td2);
    blur(td2); await tick(300);
    ok('末尾那个空格原样留着', S.byId('task', 'T1').title === '任务一 ', JSON.stringify(S.byId('task', 'T1').title));

    // 真改了照常写
    const td3 = mkTd();
    S.openEditor('task', 'T1', 'title', td3);
    td3.input.value = '我真改了';
    blur(td3); await tick(300);
    ok('真改过的照常存（本机 + 共享文件）', S.byId('task', 'T1').title === '我真改了' && fRec('tasks', 'id', 'T1').title === '我真改了');
  }

  section('② ★多行文本编辑器：内容带行号/末尾空格时，打开直接点保存不许顶掉同事的改动');
  {
    world({ tasks: [], milestones: [] });
    await landSync(p => { const w = p.works.find(x => x.id === 'w1'); w.content = ['1. 调研 ', '总结']; bump(w); });
    S.openLinesEditor('work', 'w1', 'content');
    q('#lines-ta').value = (S.byId('work', 'w1').content || []).join('\n');   // 用户一个字没改
    await landSync(p => { const w = p.works.find(x => x.id === 'w1'); w.content = ['同事重写的内容']; bump(w); });
    await S.modalCallback(); await tick(200);
    ok('★同事改的内容留着', JSON.stringify(S.byId('work', 'w1').content) === '["同事重写的内容"]', S.byId('work', 'w1').content);

    S.openLinesEditor('work', 'w1', 'content');
    q('#lines-ta').value = '第一条\n第二条';
    await S.modalCallback(); await tick(200);
    ok('真改过的照常存', JSON.stringify(S.byId('work', 'w1').content) === '["第一条","第二条"]', S.byId('work', 'w1').content);
  }

  section('③ ★下拉弹层：点的还是打开时那一项，而同事已经改过这一格');
  {
    world({ tasks: [], milestones: [] });
    await S.Repo.persist(S.DB); await tick(40);
    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'priority'), mkTd());
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { priority: '1' })));
    S.setSnackPriorityUntil(0);
    await S.spCommitSingle('2');   // 我看到的是"中"，点了"中"
    await tick(200);
    ok('★同事改的优先级留着', S.byId('task', 'T1').priority === '1', S.byId('task', 'T1').priority);
    ok('并且说清楚了为什么', /已保留他的改动/.test(q('#snack-msg').textContent), q('#snack-msg').textContent);

    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'priority'), mkTd());
    await S.spCommitSingle('3');   // 这次是真的要改
    await tick(200);
    ok('真选了别的照常写', S.byId('task', 'T1').priority === '3' && fRec('tasks', 'id', 'T1').priority === '3');
  }

  section('④ ★日期选择器：点的还是打开日历时的那一天，而同事已经改过这一格');
  {
    world({ tasks: [], milestones: [] });
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { plan_date: '2026-10-10' })));
    S.openDatePicker('task', 'T1', 'plan_date', mkTd());
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { plan_date: '2026-11-11' })));
    S.setSnackPriorityUntil(0);
    await S.dpCommit('2026-10-10');
    await tick(200);
    ok('★同事改的日期留着', S.byId('task', 'T1').plan_date === '2026-11-11', S.byId('task', 'T1').plan_date);
    S.openDatePicker('task', 'T1', 'plan_date', mkTd());
    await S.dpCommit('2026-12-12');
    await tick(200);
    ok('真选了别的日子照常写', S.byId('task', 'T1').plan_date === '2026-12-12');
  }

  section('⑤ ★核对：几台电脑时钟差一两分钟时，不许把先后判反');
  {
    world();
    S.byId('task', 'T1').status = 'doing';
    const now = Date.now();
    const mk = (id, at, by, from, to) => ({ id, at, by, kind: 'edit', entity: 'task', refId: 'T1',
      summary: '状态', changes: [{ k: 'status', from, to }] });
    S.DB.changelog = [mk('l1', iso(now - 113000), '老李', 'todo', 'doing'), mk('l2', iso(now), '小王', 'doing', 'todo')];
    ok('★时钟误差窗口内，现在这个值有日志来路 → 不报', !S.auditByChangelog().some(i => i.field === 'status'));
    S.DB.changelog[0].at = iso(now - 600000);
    ok('超出误差窗口（真的被谁改回去了）照常报', S.auditByChangelog().some(i => i.field === 'status'));
  }

  section('⑥ ★核对：里程碑跟着所属任务一起恢复回来，不算"日志说删了、现在还在"');
  {
    world({ milestones: [S.stampMeta(S.blank('milestone', { id: 'MB', task: 'T1', plan_date: '2026-09-25', deliverable: '交付物B', report_level: 'section', done: '0' }))] });
    await S.Repo.persist(S.DB); await tick(40);
    S.ACTIONS['task-del']({ id: 'T1' }); await confirmNow();
    ok('前提：任务和里程碑都删了', !!S.byId('task', 'T1').deleted_at && !!S.byId('milestone', 'MB').deleted_at);
    // 删任务只在任务上留日志，里程碑那条"删除"日志靠详情保存才有——这里手工补一条，模拟"先单独删过、又跟着任务删"的常见形态
    S.DB.changelog.push({ id: 'lm', at: iso(Date.now() - 1000), by: '管理员', kind: 'edit', entity: 'milestone', refId: 'MB',
      summary: '删除里程碑「交付物B」', changes: [{ k: 'deleted_at', from: '', to: S.byId('milestone', 'MB').deleted_at }] });
    await S.ACTIONS['task-restore']({ id: 'T1' }); await tick(150);
    ok('前提：任务恢复了，里程碑跟着回来', !S.byId('task', 'T1').deleted_at && !S.byId('milestone', 'MB').deleted_at);
    ok('★核对不把它报成对不上（原来会报，一修复又被重新删掉）',
      !S.auditByChangelog().some(i => i.entity === 'milestone' && i.id === 'MB'), S.auditByChangelog().map(i => [i.entity, i.id, i.field]));
  }

  section('⑦ ★自动勾完里程碑要逐条留痕，核对也不再误报');
  {
    world({ milestones: [S.stampMeta(S.blank('milestone', { id: 'MB', task: 'T1', plan_date: '2026-09-25', deliverable: '交付物B', report_level: 'section', done: '0' }))] });
    await S.Repo.persist(S.DB); await tick(40);
    // 先留一条"取消勾选"的日志，模拟之前有人改过这一格
    S.DB.changelog.push({ id: 'lc', at: iso(Date.now() - 60000), by: '小王', kind: 'edit', entity: 'milestone', refId: 'MB',
      summary: '已完成：已完成→未完成', changes: [{ k: 'done', from: '1', to: '0' }] });
    const n0 = S.DB.changelog.length;
    const n = S.completeCheckpointsOf(S.byId('task', 'T1'));
    ok('前提：勾完了', n === 2 && S.DB.milestones.filter(m => m.task === 'T1' && m.done === '1').length === 2, n);
    const msLogs = S.DB.changelog.slice(n0).filter(e => e.entity === 'milestone');
    ok('★每条里程碑都留下了带明细的日志（原来一条都不写，事后查不到是谁勾的）',
      msLogs.length === 2 && msLogs.every(e => (e.changes || []).some(c => c.k === 'done' && c.to === '1')), msLogs.map(e => e.summary));
    ok('★核对不再报"日志说未完成、现在已完成"', !S.auditByChangelog().some(i => i.id === 'MB' && i.field === 'done'),
      S.auditByChangelog().map(i => [i.id, i.field, i.to, i.now]));
  }

  section('⑧ ★核对：只写一条汇总日志的批量动作（导入、指派、整份恢复）盖过的格子不算对不上');
  {
    world({ tasks: [], milestones: [] });
    await S.Repo.persist(S.DB); await tick(40);
    // 之前有人逐字段改过牵头人
    S.DB.changelog.push({ id: 'lo', at: iso(Date.now() - 60000), by: '小王', kind: 'edit', entity: 'task', refId: 'T1',
      summary: '牵头人：管理员→小王', changes: [{ k: 'owner', from: '管理员', to: '小王' }] });
    S.byId('task', 'T1').owner = '小王'; S.stampMeta(S.byId('task', 'T1'));
    ok('前提：这会儿对得上', !S.auditByChangelog().some(i => i.id === 'T1' && i.field === 'owner'));
    // 管理员导了一份 CSV，把牵头人整批改成别人（只写一条汇总日志）
    const csv = 'id,title,owner\nT1,任务T1,老李\n';
    const nImp = await S.applyCSVImport('task', 'merge', csv); await tick(200);
    ok('前提：导入把牵头人改成了老李', nImp === 1 && S.byId('task', 'T1').owner === '老李', S.byId('task', 'T1').owner);
    const bulkLog = S.DB.changelog.filter(e => e.scope).pop();
    ok('★汇总日志带上了覆盖范围（改了哪些记录的哪几格）',
      bulkLog && bulkLog.scope.entity === 'task' && bulkLog.scope.ids.includes('T1') && bulkLog.scope.fields.includes('owner'), bulkLog && bulkLog.scope);
    ok('★核对不再把导入改过的格子报成对不上（原来报，一"修复"就把导入整批改回去）',
      !S.auditByChangelog().some(i => i.id === 'T1' && i.field === 'owner'), S.auditByChangelog().map(i => [i.id, i.field, i.to, i.now]));
    // 从备份恢复这类整份覆盖的动作同样认
    world({ tasks: [], milestones: [] });
    S.DB.changelog = [{ id: 'l1', at: iso(Date.now() - 60000), by: '小王', kind: 'edit', entity: 'task', refId: 'T1',
      summary: '牵头人：管理员→小王', changes: [{ k: 'owner', from: '管理员', to: '小王' }] }];
    ok('前提：现在报得出来', S.auditByChangelog().some(i => i.id === 'T1' && i.field === 'owner'));
    S.DB.changelog.push({ id: 'l2', at: iso(Date.now()), by: '管理员', kind: S.ALERT_LOG_KIND, summary: '管理员用一份备份覆盖了全处数据' });
    ok('★整份恢复之后不再按单条日志报', !S.auditByChangelog().some(i => i.id === 'T1' && i.field === 'owner'));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { raw.document.querySelectorAll = origQSA; console.error('测试异常：', e); process.exit(1); });
