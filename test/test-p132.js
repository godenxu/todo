/* P132：第四十轮排查——权限这条线："藏起来"不等于"拦得住"

   界面上看不见按钮，不代表那个动作调不到：同事之间传个链接、浏览器控制台、
   将来多一个入口，都会绕过"看不见"这一层。所以这一轮把权限当成一张网从头扫了一遍：

   · 静态清点：ACTIONS 里 55 个会改数据的动作，逐个看有没有权限闸（自己有，或者它调用的函数里有）——一个不落。
   · 动态清扫：造一个"什么权限都没开、也不负责任何任务"的员工，把 191 个动作逐个点一遍（弹确认框就点确认），
     每个动作前后比对全部业务数据。只有 3 个动作看起来动了数据，逐个查实后都不是漏洞
     （批量删除确实一条都没删掉、切换身份没改数据、立即同步只动了"最近连接"心跳）。
   · 记录级：员工改【别人的】任务，7 条入口（单元格双击、下拉弹层、日历、改状态、详情保存、删除、批量修改）逐条验。
   · 时序：弹层/确认框开着的这几秒里管理员把权限收回（同步带进来），落库那一刻必须按【新的】权限判。

   查出两处，都修了：

   ① ★「改状态」这条落库函数没有做落库前的权限复核。
      P119 那一轮把单元格编辑、日期、多选、多行文本、换所属工作统一收口到 commitEditAllowed，唯独漏了它，
      而它恰恰是【隔着一个确认框】走完的（"标已完成时要不要把名下里程碑一并勾完"）——
      框开着的几秒到几分钟里，完全可能同步进来"同事把我从参与人里去掉了""管理员刚关掉了我的权限"。
      它一次会改掉状态、进度、完成日期，还会把名下里程碑全部勾成已交付。

   ② ★权限矩阵被放宽时没有任何把关。
      角色提升早就有这道闸（没有管理员的操作记录佐证就不采纳、记告警）；可"谁能做什么"的另一半写在权限矩阵里，
      它一直是整份按版本号合并、谁写进去算谁的。共享文件就躺在网盘上，把 staff 那一行的
      "批量导入/编辑他人任务/管理账号"改成 true 塞回去，全处每台机器下一轮同步就照单全收，界面上一个字都没有。
      现在按同一套规矩办：只管【放宽】（收紧不拦），佐证认"处室领导及以上留下的权限矩阵操作记录"和"从文件导入账号"，
      挡下来时保留本机这份并记告警（进导航栏红点和日志页待处理清单）。
      顺带给两处合法路径补上留痕——账号导入一并带进矩阵、撤销把矩阵改回上一步——
      不补的话，它们会在全处每台机器上被当成"没人批过的放宽"挡掉。

   用法：node test/test-p132.js */
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
const OFF = () => { const o = {}; S.PERMISSIONS.forEach(p => { o[p.key] = false; }); return o; };
const U = (name, role) => ({ name, role, salt: 's', hash: 'h', iterations: 1, rev: 1,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' });

/* 一个"什么权限都没开、也不负责任何任务"的员工；T1 是别人的，T2 是他自己的。
   改动都以管理员身份盖戳并推上共享文件，免得后面第一次同步把布置好的场景冲掉。 */
async function asPowerlessStaff(matrix) {
  world({ tasks: [], milestones: [] });
  S.DB.users = [U('管理员', 'admin'), U('小兵', 'staff')];
  const t1 = S.byId('task', 'T1'); t1.owner = '管理员'; t1.assignees = []; t1.title = '别人的任务'; t1.status = 'doing';
  const t2 = S.byId('task', 'T2'); t2.owner = '小兵'; t2.assignees = []; t2.title = '我的任务';
  S.DB.permissionMatrix = matrix || { staff: OFF(), comanager: OFF(), director: OFF(), gm: OFF(),
    rev: 2, updated_at: new Date(Date.now() - 60000).toISOString(), updated_by: '管理员' };
  S.DB.settings.me = '管理员';
  [t1, t2].forEach(t => S.stampMeta(t));
  S.rebuildIndex();
  await S.Repo.persist(S.DB); await tick(80);
  S.DB.settings.me = '小兵';
  S.saveLocalCache(S.DB);
}
const snapTask = id => JSON.stringify(cp(S.byId('task', id)));

async function main() {
  await tick(150);

  section('① ★员工改「别人的」任务：每条入口都要拦住（不是靠界面藏按钮）');
  {
    const paths = [
      ['单元格双击改标题', async id => { const td = mkTd(); S.openEditor('task', id, 'title', td);
        if (td.input) { td.input.value = '被改了'; td.input._on.blur.forEach(f => f()); } await tick(200); }],
      ['下拉弹层改优先级', async id => { S.openSelectPopup('task', id, S.fieldDef('task', 'priority'), mkTd()); await S.spCommitSingle('1'); await tick(150); }],
      ['日历改计划完成时间', async id => { S.openDatePicker('task', id, 'plan_date', mkTd()); await S.dpCommit('2026-12-25'); await tick(150); }],
      ['★改状态（隔着确认框那条路）', async id => { await S.commitTaskStatus(S.byId('task', id), 'done', true); await tick(150); }],
      ['任务详情里保存', async id => {
        S.openTaskDetail(id); await tick(20);
        if (!q('#modal-overlay').classList.contains('show')) return;
        S.schema('task').fields.filter(f => !f.virtual).forEach(f => { const v = (S.byId('task', id) || {})[f.key];
          q('#td-' + f.key).value = Array.isArray(v) ? v.join('、') : String(v == null ? '' : v); });
        q('#td-title').value = '被改了';
        await withRows([], async () => { await S.modalCallback(); await tick(30);
          if (typeof S.modalCallback === 'function' && q('#modal-overlay').classList.contains('show')) { await S.modalCallback(); await tick(30); } });
        await tick(150);
      }],
      ['删除任务', async id => { S.ACTIONS['task-del']({ id }); await confirmNow(); await tick(150); }],
      ['批量改优先级', async id => { S.UI.tasks.sel = new Set([id]); S.openBatchEdit('priority'); await tick(20);
        if (q('#modal-overlay').classList.contains('show')) { q('#be-val').value = '1'; await S.modalCallback(); await tick(150); } }],
    ];
    for (const [name, run] of paths) {
      await asPowerlessStaff();
      const before = snapTask('T1');
      await run('T1');
      ok(name + '：别人的任务纹丝不动', snapTask('T1') === before,
        { title: (S.byId('task', 'T1') || {}).title, status: (S.byId('task', 'T1') || {}).status, deleted: !!(S.byId('task', 'T1') || {}).deleted_at });
      S.closeModal();
    }
    // 对照：自己的任务照常能改，别把人拦死
    await asPowerlessStaff();
    const td = mkTd(); S.openEditor('task', 'T2', 'title', td);
    if (td.input) { td.input.value = '我自己改的'; td.input._on.blur.forEach(f => f()); }
    await tick(250);
    ok('对照：自己的任务照常改得动', (S.byId('task', 'T2') || {}).title === '我自己改的', (S.byId('task', 'T2') || {}).title);
  }

  section('② ★弹层/确认框开着时权限被收回：落库那一刻按新权限判');
  {
    const withEditOthers = () => { const on = OFF(); on.edit_others_task = true;
      return { staff: on, comanager: Object.assign({}, on), director: Object.assign({}, on), gm: Object.assign({}, on),
        rev: 2, updated_at: new Date(Date.now() - 60000).toISOString(), updated_by: '管理员' }; };
    const revoke = async () => {
      await landSync(p => {
        p.permissionMatrix = { staff: OFF(), comanager: OFF(), director: OFF(), gm: OFF(), rev: 9,
          updated_at: new Date(Date.now() + 60000).toISOString(), updated_by: '管理员' };
        p.changelog = (p.changelog || []).concat([{ id: 'adm-off', at: new Date(Date.now() + 61000).toISOString(),
          by: '管理员', kind: S.ADMIN_LOG_KIND, summary: '权限矩阵：关闭了「员工」的「编辑他人负责/参与的任务、工作」' }]);
      });
      await tick(60);
    };
    await asPowerlessStaff(withEditOthers());
    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'priority'), mkTd());
    await revoke();
    await S.spCommitSingle('1'); await tick(200);
    ok('下拉弹层：收回之后不再写进去', (S.byId('task', 'T1') || {}).priority !== '1', (S.byId('task', 'T1') || {}).priority);

    await asPowerlessStaff(withEditOthers());
    await revoke();
    await S.commitTaskStatus(S.byId('task', 'T1'), 'done', true); await tick(200);
    ok('★改状态：收回之后不再写进去（这一处原来是漏的）', (S.byId('task', 'T1') || {}).status !== 'done', (S.byId('task', 'T1') || {}).status);
    ok('★名下里程碑也没有被顺手勾成已交付', S.DB.milestones.filter(m => m.task === 'T1').every(m => m.done !== '1'),
      S.DB.milestones.filter(m => m.task === 'T1').map(m => m.done));
  }

  section('③ ★权限矩阵被放宽：没人批过就不许采纳，而且要说出来');
  {
    await asPowerlessStaff();
    S.setSnackPriorityUntil(0);
    await landSync(p => {
      const on = OFF(); on.bulk_ops = true; on.edit_others_task = true; on.manage_staff_accounts = true;
      p.permissionMatrix = { staff: on, comanager: OFF(), director: OFF(), gm: OFF(), rev: 99,
        updated_at: new Date(Date.now() + 60000).toISOString(), updated_by: '小兵' };
    });
    await tick(150);
    ok('★没采纳：本机仍然一项权限都没有', !S.hasPermission('bulk_ops') && !S.hasPermission('edit_others_task') && !S.hasPermission('manage_staff_accounts'));
    const al = (S.DB.changelog || []).filter(e => e.kind === S.ALERT_LOG_KIND && /未经授权放宽权限/.test(e.summary || '')).pop();
    ok('★记了告警，点明新开了哪几项', !!al && /批量导入|编辑他人/.test(al.summary || ''), al && (al.summary || '').slice(0, 80));
    ok('★进了"待处理"清单（导航栏红点靠它）', S.unresolvedRoleAlerts().some(a => a.target === '权限矩阵'),
      S.unresolvedRoleAlerts().map(a => a.target));

    // 管理员正经点开的（有操作记录）：必须照常生效
    await asPowerlessStaff();
    await landSync(p => {
      const on = OFF(); on.bulk_ops = true;
      p.permissionMatrix = { staff: on, comanager: OFF(), director: OFF(), gm: OFF(), rev: 99,
        updated_at: new Date(Date.now() + 60000).toISOString(), updated_by: '管理员' };
      p.changelog = (p.changelog || []).concat([{ id: 'adm-on', at: new Date(Date.now() + 61000).toISOString(),
        by: '管理员', kind: S.ADMIN_LOG_KIND, summary: '权限矩阵：开启了「员工」的「CSV 批量导入、年度复制…」' }]);
    });
    await tick(150);
    ok('★管理员正经点开的照常生效', S.hasPermission('bulk_ops'));

    // 收紧：不拦、不报警
    const on2 = OFF(); on2.bulk_ops = true;
    await asPowerlessStaff({ staff: on2, comanager: OFF(), director: OFF(), gm: OFF(), rev: 3,
      updated_at: new Date(Date.now() - 30000).toISOString(), updated_by: '管理员' });
    const mx = () => (S.DB.changelog || []).filter(e => e.kind === S.ALERT_LOG_KIND && /放宽权限/.test(e.summary || '')).length;
    const n0 = mx();
    await landSync(p => {
      p.permissionMatrix = { staff: OFF(), comanager: OFF(), director: OFF(), gm: OFF(), rev: 99,
        updated_at: new Date(Date.now() + 60000).toISOString(), updated_by: '老李' };
    });
    await tick(150);
    ok('收紧权限照常生效，也不报警', !S.hasPermission('bulk_ops') && mx() === n0);

    // 本机还没有矩阵（新机器第一次连）：不拦
    await asPowerlessStaff();
    S.DB.permissionMatrix = null; S.saveLocalCache(S.DB);
    await landSync(p => {
      const on3 = OFF(); on3.bulk_ops = true;
      p.permissionMatrix = { staff: on3, comanager: OFF(), director: OFF(), gm: OFF(), rev: 5,
        updated_at: new Date().toISOString(), updated_by: '管理员' };
    });
    await tick(150);
    ok('新机器第一次连，照常接受文件里的矩阵', S.hasPermission('bulk_ops'));
  }

  section('④ 合法路径要留痕，否则会被自己的守卫挡掉');
  {
    ok('★撤销把矩阵改回上一步时，会留一条操作记录',
      /pushAdminLog\('撤销（Ctrl\+Z）把权限矩阵改回了上一步的样子'\)/.test(SRC));
    ok('★账号导入一并带进矩阵时，会留一条操作记录',
      /pushAdminLog\('从文件导入账号时一并导入了权限矩阵'\)/.test(SRC));
    ok('★守卫只认"处室领导及以上"签的字（自己给自己开权限不算）',
      /ROLE_RANK\[roleOfIn\(users, e\.by\)\] \?\? -1\) >= ROLE_RANK\.director/.test(SRC));
  }

  section('⑤ 静态清点：ACTIONS 里会改数据的动作，必须都有权限闸');
  {
    const lines = SRC.split('\n');
    const aStart = lines.findIndex(l => /^const ACTIONS = \{/.test(l));
    let depth = 0, aEnd = -1;
    for (let i = aStart; i < lines.length; i++) {
      for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
      if (depth === 0 && i > aStart) { aEnd = i; break; }
    }
    const fnBody = {};
    lines.forEach((l, i) => {
      const m = /^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/.exec(l);
      if (!m) return;
      let d = 0, j = i;
      for (; j < lines.length; j++) { for (const ch of lines[j]) { if (ch === '{') d++; else if (ch === '}') d--; } if (d === 0 && j > i) break; }
      fnBody[m[1]] = lines.slice(i, j + 1).join('\n');
    });
    const MUT = /Repo\.(upsert|bulk|persist|removeHard)|softDelete\(|undelete\(|removeHard\(|recordPurge\(|stampMeta\(|cascade(SoftDelete|Restore|RemoveHard)Task\(|saveReportConfig\(|saveDashboardConfig\(|applyCSVImport\(|applyWideImport\(|importBackup\(|importAccounts\(|purgeRecycleBin\(|fixHealth\(/;
    const GUARD = /requirePermission\(|requireRole\(|roleAtLeast\(|canEditRecord\(|commitEditAllowed\(|canManageAccount\(|hasPermission\(|assignableRoles\(|isRecordOwnerOrParticipant\(/;
    const bad = [];
    let n = 0;
    for (let i = aStart + 1; i < aEnd; i++) {
      const m = /^  '([^']+)':/.exec(lines[i]);
      if (!m) continue;
      let d = 0, j = i;
      for (; j < aEnd; j++) { for (const ch of lines[j]) { if ('{(['.includes(ch)) d++; else if ('})]'.includes(ch)) d--; } if (d <= 0 && j > i) break; if (d === 0 && j === i) break; }
      const body = lines.slice(i, j + 1).join('\n');
      if (!MUT.test(body)) continue;
      n++;
      if (GUARD.test(body)) continue;
      const calls = [...new Set((body.match(/\b([A-Za-z_$][\w$]*)\s*\(/g) || []).map(x => x.replace(/\s*\($/, '')))];
      if (calls.some(fn => fnBody[fn] && GUARD.test(fnBody[fn]))) continue;
      bad.push(m[1]);
    }
    ok(`★${n} 个会改数据的动作，全都有权限闸（自己有，或者它调用的函数里有）`, bad.length === 0, bad);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { raw.document.querySelectorAll = origQSA; console.error('测试异常：', e); process.exit(1); });
