/* P93：混版本上线（新版本进生产、同事浏览器里还开着旧 html）
   场景：共享文件里有几个月的真实数据，管理员换上新版本，其他人手上还是旧版本。
   这一批测的是新旧共存期间的行为，以及新版本对"还有人在用旧版本写入"的可见性。

   关键机制：停写门禁（checkAppVersion）要等旧客户端【读到】一次新版本的写入才生效；
   而旧客户端自己写文件时会把 lastWriteApp 盖回它自己的旧版本号，把这个信号擦掉——
   于是它可能很久都不被拦住，期间继续按旧规则整条覆盖记录。旧版本代码改不动，
   能做的是在新版本这边把它【看见】：读到比自己旧的写入就记下来并提示管理员。
   用法：node test/test-p93.js */
const { sandbox: S, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));
const OLD_APP = 'v20260101000000';   // 假想的旧版本号（一定小于当前 APP_VERSION）

/* 旧版本客户端的语义：syncPayload 里没有 dashboardConfig，合并是整条比大小 */
const OLD_KEYS = ['duties', 'works', 'milestones', 'tasks', 'changelog', 'users', 'permissionMatrix', 'shareConfig', 'reportConfig', 'purged'];
function oldSyncPayload(db) { const o = {}; OLD_KEYS.forEach(k => { o[k] = db[k]; }); return o; }
function oldNewer(a, b) {
  const ra = a.rev || 0, rb = b.rev || 0;
  if (ra !== rb) return ra > rb;
  const ta = a.updated_at || '', tb = b.updated_at || '';
  if (ta !== tb) return ta > tb;
  return !!a.deleted_at !== !!b.deleted_at ? !!a.deleted_at : false;
}
function oldMergeList(pk, l, r) {
  const m = new Map((l || []).map(x => [x[pk], x]));
  (r || []).forEach(x => { const c = m.get(x[pk]); if (!c || oldNewer(x, c)) m.set(x[pk], x); });
  return [...m.values()];
}
function oldClientWrite(db, file) {
  const merged = {
    duties: oldMergeList('code', db.duties, file.payload.duties),
    works: oldMergeList('id', db.works, file.payload.works),
    milestones: oldMergeList('id', db.milestones, file.payload.milestones),
    tasks: oldMergeList('id', db.tasks, file.payload.tasks),
    changelog: (() => { const m = new Map((db.changelog || []).map(e => [e.id, e]));
      (file.payload.changelog || []).forEach(e => { if (!m.has(e.id)) m.set(e.id, e); }); return [...m.values()]; })(),
    users: oldMergeList('name', db.users, file.payload.users),
    permissionMatrix: db.permissionMatrix || file.payload.permissionMatrix,
    shareConfig: db.shareConfig || file.payload.shareConfig,
    reportConfig: db.reportConfig || file.payload.reportConfig,
    purged: (db.purged || []).concat(file.payload.purged || []),
  };
  Object.assign(db, merged);
  file.payload = Object.assign(cp(oldSyncPayload(merged)), {
    schemaVersion: 2, writeId: 'w_old', lastWriteBy: '旧版同事', lastWriteApp: OLD_APP,
    lastWriteAt: new Date().toISOString(),
  });
}
function newDb(seed) {
  return Object.assign({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
    permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null, purged: [],
    syncBase: null, settings: { me: '管理员' } }, cp(seed || {}));
}
function newClientWrite(db, file) {
  const local = S.syncPayload(db);
  const merged = S.normalizeMergedRecords(S.mergeSyncPayload(local, file.payload, db.syncBase));
  Object.assign(db, merged);
  if (!S.hasLocalContribution(local, file.payload, db.syncBase)) { db.syncBase = S.buildSyncBase(file.payload); return false; }
  file.payload = Object.assign(cp(merged), { schemaVersion: 2, writeId: 'w_new',
    lastWriteBy: '管理员', lastWriteApp: S.APP_VERSION, lastWriteAt: new Date().toISOString() });
  db.syncBase = S.buildSyncBase(merged);
  return true;
}

async function main() {
  await tick(60);
  const bakMe = S.DB.settings.me, bakSettings = cp(S.DB.settings);

  section('①：前提——数据格式版本没变，旧版本仍然能读共享文件（不能把全处锁死）');
  ok('★DATA_SCHEMA_VERSION 保持不变，旧版本不会被"数据格式太新"挡住读取', S.DATA_SCHEMA_VERSION === 2, S.DATA_SCHEMA_VERSION);
  ok('★新版本写出去的文件仍然带旧版认识的那些字段', ['duties', 'works', 'milestones', 'tasks', 'changelog', 'users', 'purged']
    .every(k => k in S.syncPayload(S.DB)));

  section('②：★旧客户端写文件会把新增的顶层字段抹掉，但新版本再同步一次能自己长回来');
  const task0 = { id: 'r1', title: '原标题', status: 'todo', assignees: [], work: '', rev: 3,
    updated_at: '2026-09-01T00:00:00.000Z', updated_by: '老数据', created_at: '2026-08-01T00:00:00.000Z' };
  const file = { payload: Object.assign(S.syncPayload(newDb({ tasks: [cp(task0)] })), {
    schemaVersion: 2, lastWriteApp: OLD_APP, lastWriteBy: '旧版同事', lastWriteAt: '2026-09-01T00:00:00.000Z' }) };
  const admin = newDb({ tasks: [cp(task0)] });
  admin.dashboardConfig = { presets: [{ id: 'p1', name: '管理员编排' }], activeId: 'p1', rev: 1,
    updated_at: '2026-09-04T05:00:00.000Z', updated_by: '管理员' };
  newClientWrite(admin, file);
  ok('管理员写完，文件里有工作台编排', !!file.payload.dashboardConfig);
  const oldDb = { duties: [], works: [], milestones: [], tasks: [cp(task0)], changelog: [], users: [],
    permissionMatrix: null, shareConfig: null, reportConfig: null, purged: [] };
  oldClientWrite(oldDb, file);
  ok('★旧客户端写完之后编排被抹掉了（旧版本的 syncPayload 里没有这个字段）', !file.payload.dashboardConfig);
  newClientWrite(admin, file);
  ok('★★管理员再同步一次，编排自己长回来了（不需要人工干预）', !!file.payload.dashboardConfig,
    file.payload.dashboardConfig && file.payload.dashboardConfig.activeId);

  section('②：旧客户端的改动同样不会被新版本弄丢（双向都要安全）');
  const t2 = { id: 'r2', title: '旧版同事新建的', status: 'todo', assignees: [], work: '', rev: 1,
    updated_at: '2026-09-04T06:00:00.000Z', updated_by: '旧版同事', created_at: '2026-09-04T06:00:00.000Z' };
  oldDb.tasks.push(cp(t2));
  oldClientWrite(oldDb, file);
  newClientWrite(admin, file);
  ok('★旧版同事新建的任务，新版本这边收到了', (file.payload.tasks || []).some(t => t.id === 'r2'));
  ok('★而且没被合并弄丢标题', (file.payload.tasks.find(t => t.id === 'r2') || {}).title === '旧版同事新建的');

  section('③：★新版本产生的记录级字段，旧客户端搬运时不会导致报错或丢记录');
  const withMark = file.payload.tasks.find(t => t.id === 'r1');
  withMark.merged_from = '某同事';
  file.payload.changelog.push({ id: 'lg1', at: '2026-09-04T07:00:00.000Z', by: '管理员', kind: 'edit',
    entity: 'task', refId: 'r1', summary: '状态：未开始→已完成', changes: [{ k: 'status', from: 'todo', to: 'done' }] });
  oldClientWrite(oldDb, file);
  ok('★记录本身没丢', (file.payload.tasks || []).some(t => t.id === 'r1'));
  ok('★日志里的结构化明细被旧客户端原样搬运了（日志按 id 取并集，整条对象搬）',
    ((file.payload.changelog || []).find(e => e.id === 'lg1') || {}).changes !== undefined);

  section('④：★"还有人用旧版本写入"必须能被发现（这是混版本期间唯一可靠的抓手）');
  // 这条提示只给"看得到数据页的人"，所以得先有个真实的管理员账号，光设 settings.me 是不够的
  if (!S.DB.users.some(u => u.name === '管理员')) {
    S.DB.users.push({ name: '管理员', role: 'admin', salt: 's', hash: 'h', iterations: 1 });
  }
  S.DB.settings.me = '管理员';
  delete S.DB.settings.oldWriter;
  S.setOldWriterWarned(false);
  S.setSnackPriorityUntil(0);
  S.noteOldWriter({ lastWriteApp: OLD_APP, lastWriteBy: '旧版同事', lastWriteAt: '2026-09-04T08:00:00.000Z' });
  ok('★记下了是谁、用的哪一版', S.DB.settings.oldWriter && S.DB.settings.oldWriter.by === '旧版同事'
    && S.DB.settings.oldWriter.app === OLD_APP, S.DB.settings.oldWriter);
  ok('★给管理员弹了提示', q('#snack-msg').textContent.includes('还在用旧版本'), q('#snack-msg').textContent);
  const panel = S.oldWriterPanelHTML();
  ok('★数据页上有一块醒目的说明', panel.includes('还有人在用旧版本写入') && panel.includes('旧版同事'));
  ok('★说明里告诉管理员该怎么处理（让对方重新打开新版）', panel.includes('重新打开新版'));
  ok('★并且说清楚了对方本机的改动不会丢', panel.includes('不会丢'));

  section('④：不能误报、也不能刷屏');
  delete S.DB.settings.oldWriter;
  S.noteOldWriter({ lastWriteApp: S.APP_VERSION, lastWriteBy: '管理员' });
  ok('★文件是当前版本写的 → 不报', !S.DB.settings.oldWriter);
  S.noteOldWriter({ lastWriteApp: 'v99991231235959', lastWriteBy: '未来版本' });
  ok('★文件是更新版本写的 → 也不报（那是自己该升级，走另一道门禁）', !S.DB.settings.oldWriter);
  S.noteOldWriter({});
  S.noteOldWriter({ lastWriteApp: '' });
  ok('★缺字段时安静跳过，不报错', !S.DB.settings.oldWriter);
  S.setSnackPriorityUntil(0);
  q('#snack-msg').textContent = '';
  S.noteOldWriter({ lastWriteApp: OLD_APP, lastWriteBy: '旧版同事甲' });
  ok('★一次会话只弹一次提示（每 5 分钟同步一轮，弹多了就成噪音）', q('#snack-msg').textContent === '',
    q('#snack-msg').textContent);
  ok('但记录仍然更新成最近这一次，数据页上看得到', S.DB.settings.oldWriter.by === '旧版同事甲');

  section('④：普通同事不该被这条提示打扰（他也处理不了）');
  S.DB.users.push({ name: 'P93员工', role: 'staff', salt: 's', hash: 'h', iterations: 1 });
  S.DB.permissionMatrix = { staff: Object.assign({}, S.DEFAULT_PERMISSION_MATRIX.staff, { view_data: false }),
    comanager: S.DEFAULT_PERMISSION_MATRIX.comanager, director: S.DEFAULT_PERMISSION_MATRIX.director };
  S.DB.settings.me = 'P93员工';
  S.setOldWriterWarned(false);
  S.setSnackPriorityUntil(0);
  q('#snack-msg').textContent = '';
  S.noteOldWriter({ lastWriteApp: OLD_APP, lastWriteBy: '旧版同事' });
  ok('★看不到数据页的人不弹提示', q('#snack-msg').textContent === '', q('#snack-msg').textContent);
  S.DB.permissionMatrix = null;
  S.DB.settings.me = '管理员';

  section('⑤：★升级后第一次同步：本机还没有基线，必须退回老规则且不能出错');
  const fresh = newDb({ tasks: [cp(task0)] });
  ok('前置：刚升级的机器没有基线', fresh.syncBase === null);
  const file2 = { payload: Object.assign(S.syncPayload(newDb({ tasks: [Object.assign(cp(task0), { title: '共享文件里的新标题', rev: 9, updated_at: '2026-09-04T09:00:00.000Z' })] })), { schemaVersion: 2 }) };
  newClientWrite(fresh, file2);
  ok('★第一次合并按老规则走：共享文件里版本更高，采用它', fresh.tasks[0].title === '共享文件里的新标题', fresh.tasks[0].title);
  ok('★★这一次之后基线就建立起来了，后面才受逐字段保护', !!fresh.syncBase && !!fresh.syncBase.task,
    fresh.syncBase && Object.keys(fresh.syncBase));

  S.DB.settings = bakSettings;
  S.DB.settings.me = bakMe;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
