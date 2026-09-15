/* P118：第二十六轮排查——「孤儿对象」这个病根，在弹窗/确认框/单元格编辑之外还藏着多少

   P115/P116 在任务详情弹窗和 commitTaskStatus 上修过同一个病：界面打开时捏住一条记录，
   用户点确认/保存之前，【之前就已经发出去的】一轮同步落地，Object.assign(DB, merged)
   把整个数组换掉，捏着的那条成了孤儿。P116 当时扫了全部 Repo.upsert 调用点，结论是"排干净了"——
   ★ 那次扫描的判据有漏洞 ★：它只看"对象是不是 byId 取来的"，没看"是【什么时候】取的"。
   在确认框/编辑框打开【之前】byId 取的，跟闭包里捏着的旧引用没有区别。
   这一轮按"取对象"和"写对象"之间隔没隔着一次用户等待重新扫了一遍，又挖出下面这些，全部实测复现过：

   ── 拿旧的整条记录去盖同事的改动 ──
   ① 单元格内联编辑（输入框开着时 syncBlocked 只挡"开始新的一轮"，挡不住已经在路上的那轮）
   ② 日期格填"实际完成时间"→ 弹"一并勾完里程碑"确认框 → 点确认
   ③ 多行文本编辑器（工作的"主要工作内容"）；顺带：内容没改点保存不再整条写一遍

   ── 删除被撤销 ──
   ④ ★删除任务：按 id 给新记录盖了 deleted_at，紧接着却 upsert 打开时的旧对象（身上没有 deleted_at）
      ——提示"已删除"，任务原样还在
   ⑤ 删除职责：同上

   ── 日志说做了，实际没做 ──
   ⑥ ★重置 PIN：清在孤儿身上，对方拿旧 PIN 照样能登录，管理员却以为处理掉了
   ⑦ 删除账号、⑧ 改自己角色（含"最后一个管理员"护栏按此刻名单重判）、⑨ 确认越权角色

   ── 不可撤销的操作照着打开时的旧名单执行 ──
   ⑩ ★彻底删除（单条/批量）：确认期间同事恢复了它，照样抹掉，还带墓碑传到所有机器
   ⑪ ★清空回收站：同上，改成按确认时刻重算、取交集
   ⑫ 体检彻底清理无主里程碑：原来连"先跟共享文件对账"都没做（清空回收站早就做了）
   ⑬ 指派未归属任务：确认期间同事已经给其中几条指派好的，会被统一指派覆盖
   ⑬b 停用/恢复工作：名下任务按确认时刻重数

   ── 顺着同一思路又挖出的 ──
   ③b 多选弹层（参与人等）一个没改就点确定，会拿打开时的旧名单顶掉同事刚改的（弹层根本不挡同步）
   ⑨b ★首次设置 PIN：读文件/算 PBKDF2 的等待里账号对象被换掉，PIN 写在孤儿上——
      眼前"已登录"，账号实际仍无 PIN，刷新后谁都能再认领（账号劫持）
   ⑬d 把"取记录→隔着等待→写"的判据写成全文扫描护栏（修复前版本能列出全部 10 处，修复后 0 处）
   ⑭ ★★写入覆盖恢复（rollbackBaseForClobber）：覆盖方副本比我连续两次写入都旧、而我之后又改回中间值时，
      我最新的改动被吃掉——这就是上一轮 sim15 SEED=99 没归因的那条红，是产品真 bug，不是模拟器问题
   ⑮ ★合并让文件里的版本号倒退：同事原样保存过（内容没变、rev 更高）时，合并直接沿用本机较低的 rev 写回；
      之后一旦被"我写之前那份"覆盖，恢复逻辑把旧副本当成"同事的新改动"尊重下来，我的改动永久丢失。
      本轮改动让 sim12 种子 99 的随机路径分叉后撞出来的，修复前版本同样复现（早就存在）

   另外修了回归汇总脚本 sim/runall.js：它只认一种结果行格式，p102～p110 的断言没进合计（4091 vs 4584），
   而且不论有没有失败都返回 0。

   用法：node test/test-p118.js */
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

async function main() {
  await tick(150);

  section('① 单元格内联编辑：输入框开着时同步落地，再提交');
  {
    let lastInput = null;
    const _ce = raw.document.createElement;
    raw.document.createElement = function (t) { const e = _ce.call(this, t); if (String(t) === 'input') lastInput = e; return e; };
    world();
    S.openEditor('task', 'T1', 'title', q('#td'));
    raw.document.createElement = _ce;
    ok('输入框出来了（前提）', !!lastInput);
    lastInput.value = '我改的标题';
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { source: '同事改的来源' })));
    S.commitActiveEdit(); await tick(200);
    ok('我改的标题落地（本机 + 共享文件）', S.byId('task', 'T1').title === '我改的标题' && fRec('tasks', 'id', 'T1').title === '我改的标题');
    ok('★同事那期间改的来源没被旧整条记录顶掉', fRec('tasks', 'id', 'T1').source === '同事改的来源',
      fRec('tasks', 'id', 'T1').source);
  }

  section('② 日期格填实际完成时间 → 确认框 → 期间同步 → 点确认');
  {
    world();
    S.openDatePicker('task', 'T1', 'actual_date', q('#td'));
    await S.dpCommit('2026-09-10'); await tick(60);
    ok('弹出了"一并勾完里程碑"确认框（前提）', typeof S.modalCallback === 'function');
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { source: '同事改的来源' })));
    await confirmNow();
    const ft = fRec('tasks', 'id', 'T1');
    ok('状态改成已完成、实际完成时间落地', ft.status === 'done' && ft.actual_date === '2026-09-10', ft);
    ok('里程碑一并勾上了', (fRec('milestones', 'id', 'M1') || {}).done === '1');
    ok('★同事改的来源没被顶掉', ft.source === '同事改的来源', ft.source);
  }

  section('③ 多行文本编辑器：弹窗开着时同步，再保存');
  {
    world();
    S.openLinesEditor('work', 'w1', 'content'); await tick(60);
    q('#lines-ta').value = '第一条\n第二条';
    await landSync(p => bump(Object.assign(p.works.find(w => w.id === 'w1'), { name: '同事改的工作名' })));
    await confirmNow();
    const fw = fRec('works', 'id', 'w1');
    ok('我写的内容落地', JSON.stringify(fw.content) === JSON.stringify(['第一条', '第二条']), fw.content);
    ok('★同事改的工作名没被顶掉', fw.name === '同事改的工作名', fw.name);

    world();
    S.openLinesEditor('work', 'w1', 'content'); await tick(60);
    q('#lines-ta').value = '';   // 打开时就是空的，我一个字没改
    await landSync(p => bump(Object.assign(p.works.find(w => w.id === 'w1'), { content: ['同事写的内容'] })));
    await confirmNow();
    ok('★弹窗开着时同事改了这一格、我没改就点保存 → 同事的内容不被我打开时的旧值顶掉',
      JSON.stringify(fRec('works', 'id', 'w1').content) === JSON.stringify(['同事写的内容']), fRec('works', 'id', 'w1').content);
  }

  section('③b 多选弹层（参与人）：弹层开着时同事改了这一格');
  {
    world();
    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'assignees'), q('#td')); await tick(30);
    // 弹层不挡同步——不只是"已经在路上的那轮"，新的一轮也照常跑
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { assignees: ['小王'] })));
    await S.spCommitMulti(); await tick(200);
    ok('★我一个没改就点确定 → 同事刚加的参与人不被顶掉', JSON.stringify(fRec('tasks', 'id', 'T1').assignees) === '["小王"]',
      fRec('tasks', 'id', 'T1').assignees);

    world();
    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'assignees'), q('#td')); await tick(30);
    S.sp.order.push('小李');   // 相当于在输入框里新增了一个人
    await S.spCommitMulti(); await tick(200);
    ok('真改了照常写入', JSON.stringify(fRec('tasks', 'id', 'T1').assignees) === '["小李"]', fRec('tasks', 'id', 'T1').assignees);
  }

  section('④ ★删除任务：确认框开着时同步落地');
  {
    world();
    S.ACTIONS['task-del']({ id: 'T1' }); await tick(40);
    ok('弹出确认框（前提）', typeof S.modalCallback === 'function');
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T1'), { source: '同事改的来源' })));
    await confirmNow();
    ok('★本机这条确实删掉了（不是被旧对象顶回"没删"）', !!S.byId('task', 'T1').deleted_at);
    ok('★共享文件里也是已删除', !!fRec('tasks', 'id', 'T1').deleted_at, fRec('tasks', 'id', 'T1'));
    ok('名下里程碑一并删除', !!fRec('milestones', 'id', 'M1').deleted_at);
    ok('同事改的来源还在', fRec('tasks', 'id', 'T1').source === '同事改的来源');

    world();
    S.ACTIONS['task-del']({ id: 'T1' }); await tick(40);
    await confirmNow();
    ok('基线：不发生同步时删除照常生效', !!fRec('tasks', 'id', 'T1').deleted_at);
  }

  section('⑤ 删除职责：确认框开着时同步落地');
  {
    world();
    S.ACTIONS['duty-del']({ code: '02' }); await tick(40);
    await landSync(p => bump(Object.assign(p.duties.find(d => d.code === '02'), { name: '同事改的职责名' })));
    await confirmNow();
    ok('★职责确实删掉了（本机 + 共享文件）', !!S.byId('duty', '02').deleted_at && !!fRec('duties', 'code', '02').deleted_at,
      fRec('duties', 'code', '02'));
    ok('同事改的职责名还在', fRec('duties', 'code', '02').name === '同事改的职责名');
  }

  section('⑥ ★重置 PIN：确认框开着时同步落地');
  {
    world();
    S.ACTIONS['admin-reset-pin']({ name: '小王' }); await tick(40);
    ok('弹出确认框（前提）', typeof S.modalCallback === 'function');
    // 小王本人恰好在自己机器上登录（心跳）——管理员给他重置 PIN 时这再常见不过
    await landSync(p => { const w = p.users.find(u => u.name === '小王'); w.lastSeenAt = LATER(); w.lastAppVersion = S.APP_VERSION; });
    await confirmNow();
    const u = S.DB.users.find(x => x.name === '小王');
    ok('★本机 DB 里小王的 PIN 确实清掉了', u && !u.hash, u);
    ok('★共享文件里小王的 PIN 也清掉了（不然他拿旧 PIN 照样登录）', !fRec('users', 'name', '小王').hash, fRec('users', 'name', '小王'));
  }

  section('⑦ 删除账号：确认框开着时同步落地');
  {
    world();
    S.ACTIONS['admin-delete-user']({ name: '小王' }); await tick(40);
    await landSync(p => { const w = p.users.find(u => u.name === '小王'); w.lastSeenAt = LATER(); w.lastAppVersion = S.APP_VERSION; });
    await confirmNow();
    ok('★共享文件里小王确实被删了', !!fRec('users', 'name', '小王').deleted_at, fRec('users', 'name', '小王'));
    ok('小王那次登录的心跳也保留着', !!fRec('users', 'name', '小王').lastSeenAt);
  }

  section('⑧ 改自己角色：确认期间另一个管理员被同事删掉 → 最后一个管理员护栏按此刻名单重判');
  {
    world({ users: [USER('老张', 'admin')] });
    await S.ACTIONS['account-role-change']({ name: '管理员' }, { value: 'staff' }); await tick(40);
    ok('弹出确认框（前提：有两个管理员，允许降自己）', typeof S.modalCallback === 'function');
    await landSync(p => { bump(Object.assign(p.users.find(u => u.name === '老张'), { deleted_at: LATER() })); });
    await confirmNow();
    const me = S.DB.users.find(x => x.name === '管理员');
    ok('★没有把系统里最后一个管理员降掉', me.role === 'admin', me.role);

    world({ users: [USER('老张', 'admin')] });
    await S.ACTIONS['account-role-change']({ name: '管理员' }, { value: 'director' }); await tick(40);
    await landSync(p => { p.users.push(USER('小李', 'staff')); });
    await confirmNow();
    ok('★正常情况：改角色落在 DB 里真正那条上（不是孤儿）',
      S.DB.users.find(x => x.name === '管理员').role === 'director' && fRec('users', 'name', '管理员').role === 'director',
      fRec('users', 'name', '管理员'));
  }

  section('⑨ 确认越权角色：确认框开着时同步落地');
  {
    /* P119 改成真实场景：原来这里文件没被篡改，"确认角色"本来就没东西可写，
       账号改成逐字段合并之后它不再白抬一次版本号，那条断言也就不成立了。 */
    world();
    await S.pullFromFile(); await tick(40);
    colleague(p => { Object.assign(p.users.find(u => u.name === '小王'), { role: 'admin', rev: 5, updated_at: LATER(), updated_by: '小王' }); });
    await S.pullFromFile(); await tick(40);
    ok('前提：本机拦下了越权，小王仍是员工', S.DB.users.find(x => x.name === '小王').role === 'staff');
    ok('★越权告警记下了', S.DB.changelog.some(e => e.kind === S.ALERT_LOG_KIND && /小王/.test(e.summary || '')));
    S.ACTIONS['seal-role']({ name: '小王' }); await tick(40);
    ok('弹出确认框（前提）', typeof S.modalCallback === 'function');
    // 确认框开着时小王本人的心跳落地：DB.users 里那条换成新对象
    await landSync(p => { const w = p.users.find(u => u.name === '小王'); w.lastSeenAt = LATER(); w.lastAppVersion = S.APP_VERSION; });
    await confirmNow();
    const fw = fRec('users', 'name', '小王');
    ok('★点了确认之后，本机认定的角色在共享文件里，而且版本号压过了被篡改的那一版（不是改在孤儿上）',
      fw.role === 'staff' && (fw.rev || 0) > 5, fw);
  }

  section('⑨b ★首次设置 PIN：读共享文件/算 PBKDF2 的等待里同步落地');
  {
    world();
    const w = S.DB.users.find(u => u.name === '小王'); delete w.salt; delete w.hash; delete w.iterations;
    colleague(p => { const x = p.users.find(u => u.name === '小王'); delete x.salt; delete x.hash; delete x.iterations; });
    S.DB.settings.me = '';
    q('#login-new-pin').value = '2468'; q('#login-new-pin2').value = '2468';
    // 在 set-pin 读共享文件的那次等待里，让"之前发出去的一轮同步"落地：DB.users 换成新数组、新对象
    const g0 = handle.getFile; let landed = false;
    handle.getFile = async function () {
      const r = await g0.call(this);
      if (!landed) { landed = true; S.DB.users = S.DB.users.map(u => Object.assign({}, u)); S.rebuildIndex(); }
      return r;
    };
    await S.ACTIONS['login-set-pin']({ name: '小王' }); await tick(300);
    handle.getFile = g0;
    ok('前提：等待期间确实换过对象', landed);
    const u = S.DB.users.find(x => x.name === '小王');
    ok('★PIN 写在了 DB 里真正那条账号上（否则刷新后谁都能再"首次设置"一次）', !!(u && u.hash), u);
    ok('★共享文件里也有了', !!(fRec('users', 'name', '小王') || {}).hash, fRec('users', 'name', '小王'));
    S.DB.settings.me = '管理员';
  }

  section('⑩ ★彻底删除（单条）：确认期间同事把它恢复了');
  {
    world({ tasks: [{ id: 'T9', deleted_at: OLD }] });
    S.ACTIONS['task-purge']({ id: 'T9' }); await tick(40);
    ok('弹出确认框（前提）', typeof S.modalCallback === 'function');
    await landSync(p => { const t = p.tasks.find(x => x.id === 'T9'); delete t.deleted_at; bump(t); });
    await confirmNow();
    ok('★同事刚恢复的任务没有被彻底删掉', !!S.byId('task', 'T9') && !!fRec('tasks', 'id', 'T9'));
    ok('也没有留下墓碑', !(F().purged || []).some(p => p.id === 'T9') && !(S.DB.purged || []).some(p => p.id === 'T9'));

    world({ tasks: [{ id: 'T9', deleted_at: OLD }] });
    S.ACTIONS['task-purge']({ id: 'T9' }); await tick(40);
    await confirmNow();
    ok('基线：没人恢复时照常彻底删除', !S.byId('task', 'T9') && !fRec('tasks', 'id', 'T9'));
  }

  section('⑩b 批量彻底删除：确认期间同事恢复了其中一条');
  {
    world({ tasks: [{ id: 'T8', deleted_at: OLD }, { id: 'T9', deleted_at: OLD }] });
    S.UI.tasks.sel.add('T8'); S.UI.tasks.sel.add('T9');
    S.ACTIONS['batch-purge'](); await tick(40);
    await landSync(p => { const t = p.tasks.find(x => x.id === 'T9'); delete t.deleted_at; bump(t); });
    await confirmNow();
    ok('没被恢复的 T8 照常彻底删除', !S.byId('task', 'T8') && !fRec('tasks', 'id', 'T8'));
    ok('★刚被恢复的 T9 留下了', !!S.byId('task', 'T9') && !fRec('tasks', 'id', 'T9').deleted_at);
  }

  section('⑪ ★清空回收站：确认期间同事恢复了其中一条');
  {
    world({ tasks: [{ id: 'T8', deleted_at: OLD }, { id: 'T9', deleted_at: OLD }] });
    S.purgeRecycleBin(); await tick(150);
    ok('弹出确认框（前提）', typeof S.modalCallback === 'function');
    await landSync(p => { const t = p.tasks.find(x => x.id === 'T9'); delete t.deleted_at; bump(t); });
    await confirmNow();
    ok('没被恢复的 T8 照常清掉', !S.byId('task', 'T8') && !fRec('tasks', 'id', 'T8'));
    ok('★刚被恢复的 T9 没被清掉', !!S.byId('task', 'T9') && !!fRec('tasks', 'id', 'T9'));
    ok('日志里说清了跳过几条', S.DB.changelog.some(e => /清空回收站/.test(e.summary || '') && /另有 1 条/.test(e.summary || '')),
      S.DB.changelog.map(e => e.summary));
  }

  section('⑫ 体检彻底清理无主里程碑：本机没对过账时不许误判');
  {
    const MX = S.stampMeta(S.blank('milestone', { id: 'MX', task: 'TX', plan_date: '2026-10-01',
      deliverable: '同事那条任务下的里程碑', report_level: 'section', done: '0' }));
    world({ milestones: [MX], file: db => {
      // 共享文件里有 TX（同事刚建的），本机还没同步到
      db.tasks.push(Object.assign(cp(db.tasks[0]), { id: 'TX', title: '同事的任务', code: '0101299' }));
      return db;
    } });
    ok('前提：本机此刻会把 MX 判成无主', (S.healthCheck().orphanMs || []).some(m => m.id === 'MX'));
    await S.purgeHealth('orphanMs'); await tick(150);
    if (typeof S.modalCallback === 'function') await confirmNow();
    ok('★MX 没被彻底删除（先对账，TX 已经进来了）', !!S.byId('milestone', 'MX') && !!fRec('milestones', 'id', 'MX'));

    world({ milestones: [cp(MX)] });
    await S.purgeHealth('orphanMs'); await tick(150);
    ok('确认框弹出（前提：此时它确实无主）', typeof S.modalCallback === 'function');
    await landSync(p => { p.tasks.push(Object.assign(cp(p.tasks[0]), { id: 'TX', title: '同事的任务', code: '0101299', rev: 9, updated_at: LATER() })); });
    await confirmNow();
    ok('★确认期间所属任务出现了 → 不再删', !!S.byId('milestone', 'MX'));
  }

  section('⑬ 指派未归属任务：确认期间同事已经给其中一条指派了');
  {
    world({ tasks: [{ id: 'T5', work: '' }, { id: 'T6', work: '' }] });
    S.openOrphanAssign(); await tick(40);
    q('#oa-work').value = 'w1';
    const origQSA = raw.document.querySelectorAll;
    raw.document.querySelectorAll = sel => (sel === '.oa-cb:checked' ? [{ value: 'T5' }, { value: 'T6' }] : (origQSA ? origQSA(sel) : []));
    await landSync(p => bump(Object.assign(p.tasks.find(t => t.id === 'T6'), { work: 'w2', code: '0102261' })));
    await confirmNow();
    raw.document.querySelectorAll = origQSA;
    ok('T5 照常指派到 w1', S.byId('task', 'T5').work === 'w1');
    ok('★同事给 T6 指派的 w2 没被覆盖', S.byId('task', 'T6').work === 'w2' && fRec('tasks', 'id', 'T6').work === 'w2',
      fRec('tasks', 'id', 'T6'));
  }

  section('⑬b 停用工作：名下任务按确认时刻重数');
  {
    world();
    S.ACTIONS['work-del']({ id: 'w1' }); await tick(40);
    await landSync(p => {
      bump(Object.assign(p.tasks.find(t => t.id === 'T2'), { work: 'w2' }));           // 同事把 T2 挪走了
      p.tasks.push(Object.assign(cp(p.tasks[0]), { id: 'T7', title: '同事新建', code: '0101277', rev: 3, updated_at: LATER() }));
    });
    await confirmNow();
    ok('工作停用了', !!S.byId('work', 'w1').deleted_at);
    ok('原本就在的 T1 一并删除', !!S.byId('task', 'T1').deleted_at);
    ok('★被同事挪到别的工作的 T2 没被误删', !S.byId('task', 'T2').deleted_at);
    ok('★同事刚在这项工作下新建的 T7 也一并删除（不留挂在已停用工作下的活任务）', !!(S.byId('task', 'T7') || {}).deleted_at);
  }

  section('⑭ ★★写入覆盖恢复：覆盖方的副本比我连续两次写入都旧，而我之后又改回了中间那个值（sim15 种子 99）');
  {
    const T0 = () => ({ id: 'TC', work: '', code: '', title: '覆盖演示', owner: '甲', assignees: [],
      status: 'todo', priority: '2', plan_date: '2026-09-20', progress: 0, actual_date: '',
      source: '', custom: '', rev: 5, created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-05T01:00:00.000Z', updated_by: '原作者' });
    const M0 = () => ({ id: 'MC', task: 'TC', plan_date: '2026-09-18', deliverable: '材料', report_level: 'section',
      done: '0', actual_date: '', rev: 3, created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-05T01:00:00.000Z', updated_by: '原作者' });
    const run = async (label, entity, listKey, id, field, vals, otherField, otherVal) => {
      S.closeModal();
      ['tasks', 'works', 'duties', 'milestones', 'changelog', 'purged'].forEach(k => { S.DB[k] = []; });
      S.DB.users = [USER('管理员', 'admin')]; S.DB.settings.me = '甲';
      S.clearSyncBaseline(S.DB); S.setLastWriteId(''); S.setPreWriteBase(null); S.rebuildIndex();
      const v0 = S.filePayload(Object.assign(EMPTY(), { tasks: [T0()], milestones: [M0()] }), S.DB, 'w0', { writeIds: ['w0prev'] });
      FILE = JSON.stringify(v0); handle._mtime = 1; S.setFileHandle(handle);
      await S.pullFromFile();
      const 乙读到的 = JSON.parse(FILE);
      const edit = v => { const r = S.byId(entity, id); r[field] = v; S.stampMeta(r); };
      edit(vals[0]); await S.syncToFile(S.DB);        // 第一次写
      edit(vals[1]); await S.syncToFile(S.DB);        // 第二次写（比如"勾上→马上取消"连着存）
      edit(vals[0]);                                   // 之后在本机又改回来，还没推
      // 乙这时才写：手里是 v0（比我两次写都旧），并且改了另一格
      const stale = { tasks: [T0()], milestones: [M0()] };
      // 乙读的是 v0，改完一格版本号只会 +1——不能随手写个大数：rev 超过我写进去的那一版，
      // 就等于声明"乙在我写完之后正经改过这条"，那是另一种情形（真冲突，按新旧定胜负并记告警）
      stale[listKey][0][otherField] = otherVal; stale[listKey][0].rev = stale[listKey][0].rev + 1;
      stale[listKey][0].updated_at = new Date().toISOString(); stale[listKey][0].updated_by = '乙';
      FILE = JSON.stringify(S.filePayload(Object.assign(EMPTY(), stale), S.DB, 'w_乙', 乙读到的)); handle._mtime++;
      await S.syncToFile(S.DB);
      const fr = (F()[listKey] || []).find(x => x.id === id) || {};
      ok(`${label}：★我最后改回来的「${vals[0]}」补推回去了（原来被覆盖方的旧值吃掉）`,
        String(fr[field]) === String(vals[0]) && String(S.byId(entity, id)[field]) === String(vals[0]), { file: fr[field], local: S.byId(entity, id)[field] });
      ok(`${label}：乙在那次写里改的另一格保住了（不能反过来吃掉别人的）`, String(fr[otherField]) === String(otherVal), fr[otherField]);
    };
    await run('任务状态', 'task', 'tasks', 'TC', 'status', ['done', 'doing'], 'priority', '1');
    await run('里程碑勾选', 'milestone', 'milestones', 'MC', 'done', ['1', '0'], 'deliverable', '乙改的材料名');
    S.setFileHandle(handle);
  }

  section('⑮ ★合并不许让文件里的版本号倒退（sim12 种子 99 严格模式）');
  {
    const base = { id: 'TR', title: 'x', status: 'todo', priority: '2', rev: 7, updated_at: '2026-09-01T00:00:00.000Z', updated_by: '乙' };
    const local = Object.assign({}, base, { priority: '1', rev: 6, updated_by: '甲' });   // 我改了，但我手里 rev 较低
    const remote = Object.assign({}, base, { rev: 9 });                                  // 同事原样保存过：内容没变、rev 更高
    const r = S.mergeRecordThreeWay('task', local, remote, base).rec;
    ok('我的改动胜出', r.priority === '1');
    ok('★合并结果的版本号高于文件原来那条（原来直接沿用本机 rev 6，文件 rev 9→6 倒退）', r.rev > 9, r.rev);
    const r2 = S.mergeRecordThreeWay('task', Object.assign({}, base, { priority: '1', rev: 12 }), Object.assign({}, base, { rev: 9 }), base).rec;
    ok('本机版本号本来就最高时不额外抬（不制造来回白写）', r2.rev === 12, r2.rev);

    // 端到端：同事两次原样保存 → 我改优先级同步 → 被"我写之前那份"覆盖 → 必须补推回来
    S.closeModal();
    ['tasks', 'works', 'duties', 'milestones', 'changelog', 'purged'].forEach(k => { S.DB[k] = []; });
    S.DB.users = [USER('管理员', 'admin')]; S.DB.settings.me = '甲';
    S.clearSyncBaseline(S.DB); S.setLastWriteId(''); S.setPreWriteBase(null); S.rebuildIndex();
    const T = { id: 'TR', work: '', code: '', title: '版本号演示', owner: '甲', assignees: [], status: 'todo', priority: '2',
      plan_date: '2026-09-20', progress: 0, actual_date: '', source: '', custom: '', rev: 5,
      created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-05T01:00:00.000Z', updated_by: '原作者' };
    FILE = JSON.stringify(S.filePayload(Object.assign(EMPTY(), { tasks: [T] }), S.DB, 'w0', { writeIds: ['w0prev'] }));
    handle._mtime = 1; S.setFileHandle(handle);
    await S.pullFromFile();
    for (let i = 0; i < 2; i++) colleague(p => { const x = p.tasks[0]; x.rev += 1; x.updated_at = new Date(Date.now() + 1000 * (i + 1)).toISOString(); x.updated_by = '乙'; });
    // colleague() 会把写入链重置，这里要的是"正常续上的链"，手工补回
    { const p = F(); p.writeIds = ['w0prev', 'w0', 'wnoop']; p.writeId = 'wnoop'; FILE = JSON.stringify(p); handle._mtime++; }
    const t = S.byId('task', 'TR'); t.priority = '1'; S.stampMeta(t);
    const beforeMyWrite = FILE;
    await S.syncToFile(S.DB);
    ok('写完之后文件里的 rev 没有倒退', F().tasks[0].rev > JSON.parse(beforeMyWrite).tasks[0].rev,
      { before: JSON.parse(beforeMyWrite).tasks[0].rev, after: F().tasks[0].rev });
    const stale = JSON.parse(beforeMyWrite);
    stale.tasks[0].plan_date = '2026-12-12'; stale.tasks[0].rev += 1; stale.tasks[0].updated_at = LATER(); stale.tasks[0].updated_by = '乙';
    stale.writeId = 'w_乙race'; stale.writeIds = stale.writeIds.concat('w_乙race');
    FILE = JSON.stringify(stale); handle._mtime++;
    for (let k = 0; k < 3; k++) await S.syncToFile(S.DB);
    ok('★被"我写之前那份"覆盖后，我的优先级补推回来了', F().tasks[0].priority === '1', F().tasks[0].priority);
    ok('乙那次改的日期也在', F().tasks[0].plan_date === '2026-12-12', F().tasks[0].plan_date);
    S.setFileHandle(handle);
  }

  section('⑬c 源码层面的护栏：这些回调里不再直接写打开时捏着的对象');
  {
    ok('task-del 不再 upsert 打开时的 t', !/pushChangeLog\('task', d\.id, `删除了任务「\$\{t\.title\}」`\);\s*await Repo\.upsert\('task', t\);/.test(SRC));
    ok('duty-del 不再 upsert 打开时的 dt', !/await Repo\.upsert\('duty', dt\);\s*renderPage\(\); showSnack\('已删除'\);/.test(SRC));
    ok('purgeHealth 先对账再算名单', /async function purgeHealth[\s\S]{0,700}pullFromFile\(\)[\s\S]{0,200}healthCheck\(\)/.test(SRC));
  }

  section('⑬d ★全文扫描护栏：取记录 → 隔着确认框/await/闭包 → 写同一个变量，一处都不许有');
  {
    /* P116 那次"排干净了"的结论之所以错，是因为只看了对象从哪来、没看什么时候来。
       这里把正确的判据写成机器检查：取记录（byId / DB.xxx.find / myUser）之后，
       只要中间出现过 await、确认框/弹窗、或者一个闭包定义，再写这个变量就算违规——
       除非是在闭包里重新取过（重新声明同名变量）。
       这支扫描在修复前的版本上能把本轮 10 处对象型问题全部列出来（验证过），修复后为 0。
       它是粗筛，不追踪跨函数的传参；传参那一类靠 commitTaskStatus 这种"进函数先重取"的约定兜住。 */
    const lines = SRC.split(/\r?\n/);
    const GET = /\b(?:const|let)\s+(\w+)\s*=\s*(?:byId\(|DB\.(?:users|tasks|works|duties|milestones)\.find\(|myUser\(\))/;
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(GET); if (!m) continue;
      const v = m[1].replace(/[$]/g, '\\$');
      const WRITE = new RegExp('(\\b' + v + '\\.\\w+\\s*=[^=]|\\b' + v + '\\[[^\\]]+\\]\\s*=[^=]|delete\\s+' + v + '\\.|Object\\.assign\\(' + v + '\\b|stampMeta\\(' + v + '\\)|Repo\\.upsert\\([^,]+,\\s*' + v + '\\))');
      const REDECL = new RegExp('\\b(?:const|let)\\s+' + v + '\\s*=');
      let boundary = 0;
      for (let j = i + 1; j < Math.min(lines.length, i + 160); j++) {
        const L = lines[j];
        if (REDECL.test(L)) break;
        if (/^(?:async\s+)?function\s/.test(L) || /^\s{2}'[\w-]+':\s/.test(L) || /^\s{2}[a-zA-Z]+:\s*(?:async\s*)?\(/.test(L)) break;
        if (/^\s*(\/\/|\/\*|\*)/.test(L) || /^\s+[^\s]*[一-龥]/.test(L) && !/[;{}]\s*$/.test(L)) continue;   // 注释行不算
        const b = /\bawait\b/.test(L) || /(confirmModal|openModal|openDoneAutoFillModal|promptModal|confirmOwnerChange)\(/.test(L)
          || /(=>\s*\{|addEventListener\(|setTimeout\()/.test(L);
        // "await Repo.upsert(x, v)" 这一行本身就是写入，中间没有等待，不算
        if (b && !boundary && !(WRITE.test(L) && /await\s+Repo\.upsert/.test(L))) boundary = j + 1;
        if (boundary && boundary !== j + 1 && WRITE.test(L)) { hits.push(`${i + 1} ${m[1]} → 写@${j + 1}: ${L.trim().slice(0, 70)}`); break; }
        if (boundary === j + 1 && WRITE.test(L) && !/await\s+Repo\.upsert/.test(L)) { hits.push(`${i + 1} ${m[1]} → 写@${j + 1}: ${L.trim().slice(0, 70)}`); break; }
      }
    }
    ok('没有"隔着等待写打开时取来的记录"的地方', hits.length === 0, hits);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
