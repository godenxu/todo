/* P127：第三十五轮排查——生产环境的数据拿不到，改用"多台电脑 × 真程序"随机长跑自己去撞

   上一轮的事故截图是生产环境的，仓库里是开发测试数据，对不上。这一轮换了个查法：
   新写了 sim/sim16.js——同一个 Node 进程里起好几份完整的 index.html（每台电脑、每个标签页各一份，
   各自的内存、各自的本机缓存、各自的时钟），连同一份共享文件，走真实的界面入口随机并发操作
   （任务详情删行/勾选/改字/加行、删除/恢复任务、Ctrl+Z、定时同步、切回标签页、刷新页面、授权失效后第一次点击、
   断网、同一台电脑开两个标签页、很久没开的电脑拿旧缓存重新连上、有人还开着旧版本 html），
   每写一次共享文件就查"有没有删掉的里程碑没留恢复日志就活了"。

   同样的长跑拿 git 里最后提交的版本（v20260914094606，生产上很可能还在跑它）对照：
   旧版本每个种子都撞出"无痕复活且事后没被纠正"，来路绝大多数是 Ctrl+Z（在输入框里打字按 Ctrl+Z 会撤销上一次保存、
   且不写日志），其次是同一台电脑两个标签页互相覆盖、写入竞争后回滚补推——跟事故现场（删了、进度 57→67 有日志，
   之后悄悄回到 57、无任何日志，同一天两次）完全吻合；这几条 P121/P124/P126 已修，当前版本同样的长跑不再出现。
   当前版本上长跑另外撞出、并逐条用确定性用例钉住的：

   ① ★恢复任务会把"删任务之前就被单独删掉的里程碑"一起救回来，而且里程碑上没有任何恢复日志
      ——"删掉的里程碑自己回来了、进度也跟着变"。现在只带回跟任务一起被删的（删除时间不早于任务），跟恢复工作带回任务同一个判据
   ② ★「恢复任务」先恢复、后拍撤销快照：恢复完按 Ctrl+Z，恢复撤不掉，反而把"恢复了任务"这条日志从本机抹掉
   ③ ★弹窗开着、焦点在按钮上时按 Ctrl+Z，照样撤销上一次保存并关掉弹窗；撤销成功一个字都不说，误按了没人察觉
   ④ ★两台电脑同时第一次往"还没有数据集指纹"的文件里写，各抽一个随机指纹，后写的覆盖先写的——
      先写那台被永久判成"共享文件里不是本处的数据"、整屏门禁停止同步，它那次的改动也推不回去了（确定性探针实测）
   ⑤ ★任务详情里"我动没动这一格"拿存储原值比：标题末尾带空格、参与人名字带空格、状态是新版本才有的值、
      所属工作不在下拉清单里——一次什么都没动的保存，会把同事期间的改动顶回去，或者悄悄改掉原值（P126 修了里程碑行，任务字段漏了）
   ⑥ 交付物带首尾空白时，什么都没动的保存在日志里写出假的「新增「X」；移除「X 」」；交付物中间有换行、
      呈报层级不在选项里时，P126 那道"没动过的行不复活"的保护仍然失效
   ⑦ 同步撤回删除的告警（P126）没留时钟容差：快表的机器删、慢表的机器紧接着恢复，被误报成"找不到恢复记录"

   用法：node test/test-p127.js */
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


// 界面行呈现的样子：单行输入框吞掉换行；呈报层级下拉框里没有这个值时浏览器显示第一项（处室领导）
const rowOf = m => cpRow(m.id, m.plan_date, String(m.deliverable || '').replace(/[\r\n]/g, ''),
  ['section', 'department', 'bank'].includes(m.report_level) ? m.report_level : 'section', m.done);
// 按"打开那一刻浏览器里控件显示的样子"填任务表单：文本框原样（含首尾空格），下拉框值不在选项里就显示第一项，工作不在下拉里显示"未归属"
function fillAsShown(snap) {
  S.schema('task').fields.filter(f => !f.virtual).forEach(f => {
    let v = snap[f.key];
    if (f.type === 'enum') v = f.options.some(o => o.v === String(v)) ? String(v) : f.options[0].v;
    if (f.key === 'work') { const w = S.byId('work', v); v = w && S.worksOfDuty(w.duty).some(x => x.id === v) ? v : ''; }
    q('#td-' + f.key).value = Array.isArray(v) ? v.join(f.type === 'lines' ? '\n' : '、') : String(v == null ? '' : v).replace(/[\r\n]/g, '');
  });
}
async function saveShown(snap, rows, edit) {
  await withRows(rows, async () => {
    fillAsShown(snap);
    if (edit) edit();
    await S.modalCallback(); await tick(30);
    if (typeof S.modalCallback === 'function' && q('#modal-overlay').classList.contains('show')) { await S.modalCallback(); await tick(30); }
    await tick(120);
  });
}
const openSnap = id => { S.openTaskDetail(id); return cp(S.byId('task', id)); };
const msRows = taskId => S.DB.milestones.filter(m => m.task === taskId && !m.deleted_at).map(rowOf);
const keyEv = (key, extra) => Object.assign({ key, ctrlKey: false, isComposing: false, keyCode: 0, preventDefault() { this.prevented = true; }, stopPropagation() {} }, extra);
const docKeydown = ev => (raw.document._on.keydown || []).forEach(fn => fn(ev));
const MS = (id, extra) => S.stampMeta(S.blank('milestone', Object.assign({ id, task: 'T1', plan_date: '2026-09-25', deliverable: '交付物' + id, report_level: 'section', done: '0' }, extra)));

async function main() {
  await tick(150);

  section('① ★恢复任务只带回跟它一起被删的里程碑，之前单独删掉的留在回收站');
  {
    world({ milestones: [MS('MA'), MS('MB', { plan_date: '2026-09-28' })] });
    await S.Repo.persist(S.DB); await tick(40);
    // 同事先在任务详情里单独删掉了 MA
    S.openTaskDetail('T1'); await tick(20);
    await withRows([rowOf(S.byId('milestone', 'M1')), rowOf(S.byId('milestone', 'MB'))], saveDetail);
    ok('前提：MA 单独删掉了', !!S.byId('milestone', 'MA').deleted_at && !!fRec('milestones', 'id', 'MA').deleted_at);
    await tick(20);
    // 过了一阵，有人把整条任务删了，又有人把任务恢复
    S.ACTIONS['task-del']({ id: 'T1' }); await confirmNow();
    ok('前提：任务删了，MB、M1 跟着删了', !!S.byId('task', 'T1').deleted_at && !!S.byId('milestone', 'MB').deleted_at && !!S.byId('milestone', 'M1').deleted_at);
    await S.ACTIONS['task-restore']({ id: 'T1' }); await tick(150);
    ok('任务恢复了，跟它一起被删的 MB、M1 也回来了', !S.byId('task', 'T1').deleted_at && !S.byId('milestone', 'MB').deleted_at && !S.byId('milestone', 'M1').deleted_at);
    ok('★之前单独删掉的 MA 没有被捎带救回来（本机 + 共享文件）', !!S.byId('milestone', 'MA').deleted_at && !!fRec('milestones', 'id', 'MA').deleted_at,
      [S.byId('milestone', 'MA').deleted_at, fRec('milestones', 'id', 'MA').deleted_at]);
    ok('进度按真正回来的里程碑算（剩 2 条都没交付）', S.byId('task', 'T1').progress === 0 && S.DB.milestones.filter(m => m.task === 'T1' && !m.deleted_at).length === 2);

    // 回收站里恢复是同一个函数，再走一遍
    S.ACTIONS['task-del']({ id: 'T1' }); await confirmNow();
    await S.ACTIONS['recycle-restore']({ entity: 'task', id: 'T1' }); await tick(150);
    ok('★回收站恢复同样不捎带 MA', !S.byId('task', 'T1').deleted_at && !S.byId('milestone', 'MB').deleted_at && !!S.byId('milestone', 'MA').deleted_at);

    // 合并补级联（同事删任务时我刚加的里程碑）用的是任务自己的删除时间：恢复时要能回来
    S.ACTIONS['task-del']({ id: 'T1' }); await confirmNow();
    const tdel = S.byId('task', 'T1').deleted_at;
    const mc = MS('MC'); mc.deleted_at = tdel; S.DB.milestones.push(mc); S.rebuildIndex();
    await S.ACTIONS['task-restore']({ id: 'T1' }); await tick(150);
    ok('删除时间正好等于任务删除时间的（合并补的级联）照样回来', !S.byId('milestone', 'MC').deleted_at);

    // 任务刚被同事恢复了，我这边再点恢复：不许把单独删掉的捞回来
    const before = S.DB.changelog.length;
    await S.ACTIONS['task-restore']({ id: 'T1' }); await tick(80);
    ok('★任务本来就没删时点恢复：里程碑一条不动，也不白写一条"恢复了任务"', !!S.byId('milestone', 'MA').deleted_at
      && !S.DB.changelog.slice(before).some(e => /恢复了任务/.test(e.summary || '')));
  }

  section('② ★恢复任务之后按 Ctrl+Z：真的撤销恢复，而且恢复日志不许凭空消失');
  {
    world({ milestones: [MS('MB')] });
    await S.Repo.persist(S.DB); await tick(40);
    S.ACTIONS['task-del']({ id: 'T1' }); await confirmNow();
    await S.ACTIONS['task-restore']({ id: 'T1' }); await tick(150);
    ok('前提：恢复了', !S.byId('task', 'T1').deleted_at && !S.byId('milestone', 'MB').deleted_at);
    await S.undoLast(); await tick(150);
    ok('★撤销真的把恢复撤回去了（原来快照拍在恢复之后，撤销是空操作）', !!S.byId('task', 'T1').deleted_at && !!S.byId('milestone', 'MB').deleted_at
      && !!fRec('tasks', 'id', 'T1').deleted_at, [S.byId('task', 'T1').deleted_at, S.byId('milestone', 'MB').deleted_at]);
    const logs = F().changelog.filter(e => e.refId === 'T1').map(e => e.summary);
    ok('★共享文件里"恢复了任务"和"撤销：重新删除了"两条都在，前后对得上', logs.some(s => /恢复了任务/.test(s)) && logs.some(s => /撤销：重新删除了/.test(s)), logs);
  }

  section('③ ★弹窗开着时 Ctrl+Z 不撤销数据；撤销成功要当场说出来');
  {
    world();
    const t = S.byId('task', 'T1');
    S.snapshot(); t.title = '改过的标题'; S.stampMeta(t); await S.Repo.persist(S.DB); await tick(40);
    S.openTaskDetail('T1'); await tick(20);
    const prevActive = raw.document.activeElement;
    raw.document.activeElement = { tagName: 'BUTTON', blur() {} };   // 刚点过里程碑行的"＋"
    docKeydown(keyEv('z', { ctrlKey: true })); await tick(80);
    ok('★焦点在按钮上：数据没被撤销、弹窗还开着', S.byId('task', 'T1').title === '改过的标题' && q('#modal-overlay').classList.contains('show'), S.byId('task', 'T1').title);
    S.closeModal();
    q('#login-gate').classList.add('show');
    docKeydown(keyEv('z', { ctrlKey: true })); await tick(80);
    ok('门禁开着时同样不撤销', S.byId('task', 'T1').title === '改过的标题');
    q('#login-gate').classList.remove('show');
    S.setSnackPriorityUntil(0);
    docKeydown(keyEv('z', { ctrlKey: true })); await tick(120);
    raw.document.activeElement = prevActive;
    ok('关掉弹窗再按：照常撤销', S.byId('task', 'T1').title !== '改过的标题');
    ok('★撤销成功当场点名改回了什么（原来 hideSnack 一声不响）', q('#snackbar').classList.contains('show') && /已撤销：改回了「/.test(q('#snack-msg').textContent), q('#snack-msg').textContent);
  }

  section('④ ★数据集指纹按内容算：同时第一次落指纹的几台电脑必然一致');
  {
    const base = { tasks: [{ id: 't_old', created_at: '2026-01-02T00:00:00.000Z' }], milestones: [{ id: 'm_old', created_at: '2026-01-03T00:00:00.000Z' }], duties: [{ code: '01', created_at: '2026-01-01T00:00:00.000Z' }] };
    const machineA = cp(base); machineA.tasks.push({ id: 't_newA', created_at: '2026-09-15T08:00:00.000Z' });
    const machineB = cp(base); machineB.milestones.push({ id: 'm_newB', created_at: '2026-09-15T08:00:01.000Z' });
    const other = { duties: [{ code: '01', created_at: '2025-03-01T00:00:00.000Z' }], tasks: [{ id: 't_x', created_at: '2025-03-02T00:00:00.000Z' }] };
    ok('★两台电脑各自多了一条自己的新记录，算出来的指纹仍然一样', S.deriveDatasetId(machineA) === S.deriveDatasetId(machineB), [S.deriveDatasetId(machineA), S.deriveDatasetId(machineB)]);
    ok('另一套数据（别的处室）算出来不一样，数据集识别照常有效', S.deriveDatasetId(other) !== S.deriveDatasetId(machineA));
    ok('一条记录都没有时退回随机', /^ds_/.test(S.deriveDatasetId({})) && S.deriveDatasetId({}) !== S.deriveDatasetId({}));
    world();
    S.DB.settings.datasetId = '';
    ok('前提：文件里没有指纹', !F().datasetId);
    const t = S.byId('task', 'T1'); t.title = '随手改一下'; S.stampMeta(t);
    await S.Repo.persist(S.DB); await tick(60);
    ok('★第一次写入落下的指纹就是按内容算出来的那个，本机记住的也是它', F().datasetId === S.deriveDatasetId(F()) && S.DB.settings.datasetId === F().datasetId, [F().datasetId, S.DB.settings.datasetId]);
    const p = S.filePayload({ tasks: [] }, { settings: { me: 'x' } }, 'w1', { datasetId: 'ds_file', writeIds: [] });
    ok('已经有指纹的文件照旧用文件里的', p.datasetId === 'ds_file');
  }

  section('⑤ ★任务详情里没动过的格子：按控件显示的样子比，不许顶掉同事的改动、不许悄悄改原值');
  {
    world({ tasks: [], milestones: [] });
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { title: '任务一 ', assignees: ['小王 '] })));
    const snapA = openSnap('T1');
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { title: '同事改的标题', assignees: ['小王', '老李'] })));
    await saveShown(snapA, msRows('T1'));
    ok('★标题末尾带空格：我没动，同事改的标题留着（本机 + 共享文件）', S.byId('task', 'T1').title === '同事改的标题' && fRec('tasks', 'id', 'T1').title === '同事改的标题', S.byId('task', 'T1').title);
    ok('★参与人名字带空格：同事加的参与人留着', JSON.stringify(S.byId('task', 'T1').assignees) === '["小王","老李"]', S.byId('task', 'T1').assignees);

    world({ tasks: [], milestones: [] });
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { status: 'review', title: '任务一 ' })));
    const snapB = openSnap('T1');
    await saveShown(snapB, msRows('T1'));
    ok('★状态是更新版本才认识的值：没动就不许被改成下拉框第一项', S.byId('task', 'T1').status === 'review', S.byId('task', 'T1').status);
    ok('★没动过的标题不许被悄悄去掉末尾空格（原值原样留着）', S.byId('task', 'T1').title === '任务一 ', JSON.stringify(S.byId('task', 'T1').title));

    world({ tasks: [], milestones: [] });
    const w9 = S.stampMeta(S.blank('work', { id: 'w9', code: '0109', duty: '01', name: '去年的工作', owner: '管理员', year: 2025, status: 'doing' }));
    await landSync(p => { p.works.push(cp(w9)); bump(Object.assign(p.tasks.find(t => t.id === 'T2'), { work: 'w9' })); });
    const snapE = openSnap('T2');
    const codeE = S.byId('task', 'T2').code;
    await saveShown(snapE, msRows('T2'));
    ok('★所属工作不在下拉清单里（别的年度）：没动就不许被移成"未归属"、编号不变', S.byId('task', 'T2').work === 'w9' && S.byId('task', 'T2').code === codeE, [S.byId('task', 'T2').work, S.byId('task', 'T2').code]);

    world({ tasks: [], milestones: [] });
    const snapF = openSnap('T1');
    await saveShown(snapF, msRows('T1'), () => { q('#td-title').value = '我真改了标题'; q('#td-priority').value = '1'; });
    ok('真改过的格子照常写进去（本机 + 共享文件）', S.byId('task', 'T1').title === '我真改了标题' && S.byId('task', 'T1').priority === '1' && fRec('tasks', 'id', 'T1').title === '我真改了标题');
  }

  section('⑥ 里程碑行：交付物带空白不写假日志；中间有换行、层级不在选项里时，没动过的行照样不许复活');
  {
    world({ milestones: [] });
    await landSync(p => bump(Object.assign(p.milestones.find(m => m.id === 'M1'), { deliverable: '调研报告 ' })));
    S.openTaskDetail('T1');
    const n0 = S.DB.changelog.length;
    await withRows(msRows('T1'), saveDetail);
    const logs = S.DB.changelog.slice(n0).map(e => e.summary);
    ok('★什么都没动：日志里不许出现"新增/移除"', !logs.some(s => /新增|移除/.test(s)), logs);

    world({ milestones: [MS('MN', { deliverable: '年度\n计划' }), MS('ML', { report_level: 'group', plan_date: '2026-09-26' })] });
    await S.Repo.persist(S.DB); await tick(40);
    S.openTaskDetail('T1'); await tick(20);
    const rows = msRows('T1');   // 界面上显示的样子：换行被吞掉、层级显示成第一项
    await landSync(p => { ['MN', 'ML'].forEach(id => bump(Object.assign(p.milestones.find(m => m.id === id), { deleted_at: LATER() }))); });
    await withRows(rows, saveDetail);
    ok('★交付物中间带换行：同事删掉的不许被我一次没动的保存复活（本机 + 共享文件）', !!S.byId('milestone', 'MN').deleted_at && !!fRec('milestones', 'id', 'MN').deleted_at);
    ok('★呈报层级不在选项里：同样不复活', !!S.byId('milestone', 'ML').deleted_at && !!fRec('milestones', 'id', 'ML').deleted_at);
  }

  section('⑦ 同步撤回删除的告警留时钟容差');
  {
    world();
    const now = Date.now();
    const iso = ms => new Date(ms).toISOString();
    const mDel = S.stampMeta(S.blank('milestone', { id: 'MX', task: 'T1', deliverable: '时钟', plan_date: '2026-09-30', done: '0' }));
    mDel.deleted_at = iso(now + 120000);   // 快表机器上删的，时间戳比真实时间快两分钟
    const mAlive = Object.assign({}, mDel); delete mAlive.deleted_at;
    S.DB.syncBase = S.buildSyncBase({ milestones: [mDel] });
    const restoreAt = at => ({ changelog: [{ id: 'lr', at, by: '老李', kind: 'edit', entity: 'milestone', refId: 'MX', summary: '恢复了已删除的里程碑「时钟」', changes: [{ k: 'deleted_at', from: 'x', to: '' }] }], lastWriteBy: '老李' });
    ok('★慢表机器紧接着恢复（日志时间比删除时间还早一点）：不误报', S.noteMergeRevivals({ milestones: [mDel] }, { milestones: [mAlive] }, restoreAt(iso(now))) === 0);
    ok('对照：恢复日志比删除早很多（远超时钟误差），仍然报', S.noteMergeRevivals({ milestones: [mDel] }, { milestones: [mAlive] }, restoreAt(iso(now - 3600000))) === 1);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { raw.document.querySelectorAll = origQSA; console.error('测试异常：', e); process.exit(1); });
