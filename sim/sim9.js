/* 第九轮：基线之外那四类东西的多设备仿真
   前八轮的仿真（sim8）盯的是职责/工作/任务/里程碑——它们有三方合并的基线保护。
   而【账号、权限矩阵、报告页编排、工作台编排、共享文件夹配置、变更日志、墓碑】
   统统不在基线里，各有各的合并规则，一直没被系统地压过。这个仿真专门打这四类：

     · 账号：整条 LWW + 心跳单独取最大 + 角色提升要过授权检查
     · 四个整体配置对象：整份 LWW（谁版本号/时间新就整份采用谁的）
     · 变更日志：按 id 并集、按时间排序封顶
     · 墓碑：按 (entity,id) 去重取最晚、封顶

   重点断言是"独占改动必须生效"：每个配置对象指定一台设备当唯一的修改者，
   在时钟不同步、别的设备不停读写的干扰下，它的每一次修改都必须最终落到文件里。
   共享文件夹配置那个"rev 永远是 1"的 bug，就是被这条断言逮住的形态。

   用法：ROUNDS=600 SEED=1 node scratchpad/sim9.js
   （轮数/种子走环境变量：argv[2] 被 harness.js 当作 index.html 的路径占用了）
*/
const REPO = 'C:/Users/Administrator/Documents/Claude/Todo';
const { sandbox: S } = require(REPO + '/test/harness.js');

const ROUNDS = Number(process.env.ROUNDS) || 600;
const SEED = Number(process.env.SEED) || 20260909;
const cp = o => JSON.parse(JSON.stringify(o));
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

let _s = SEED;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 700) : '')); }
};
const section = t => console.log('\n■ ' + t);

/* ---------------- 共享文件 ---------------- */
function mkFile(payload) { return { text: JSON.stringify(payload), writes: 0 }; }
const fileRead = f => JSON.parse(f.text);
function fileWrite(f, payload) { f.text = JSON.stringify(payload); f.writes++; }

/* ---------------- 设备 ---------------- */
function mkDevice(name, file, skewMin) {
  return { name, db: fileRead(file), base: S.buildSyncBase(fileRead(file)),
    skewMs: (skewMin || 0) * 60000, lastWriteId: '', lastWriteIdAt: '', preWriteBase: null,
    logsWritten: [], purgesWritten: [] };
}
const nowOf = d => new Date(Date.now() + d.skewMs).toISOString();
function devStamp(dev, rec) {
  if (!rec.created_at) rec.created_at = nowOf(dev);
  rec.updated_at = nowOf(dev);
  rec.updated_by = dev.name;
  rec.rev = (rec.rev || 0) + 1;
  delete rec.merged_from;
  return rec;
}
function syncPayloadOf(db) {
  return { duties: db.duties, works: db.works, milestones: db.milestones, tasks: db.tasks,
    changelog: db.changelog, users: db.users, permissionMatrix: db.permissionMatrix,
    shareConfig: db.shareConfig, reportConfig: db.reportConfig || null,
    dashboardConfig: db.dashboardConfig || null, purged: db.purged || [] };
}
function devNoteClobber(dev, remote) {
  const fake = { settings: { lastWriteId: dev.lastWriteId, lastWriteIdAt: dev.lastWriteIdAt }, syncBase: dev.base };
  S.setLastWriteId('');
  if (!S.detectClobberedWrite(remote, fake)) return;
  const holder = { syncBase: dev.base };
  S.setPreWriteBase(dev.preWriteBase);
  if (dev.preWriteBase) { S.rollbackBaseForClobber(holder, remote); dev.base = holder.syncBase; }
  S.setPreWriteBase(null);
  dev.lastWriteId = ''; dev.lastWriteIdAt = ''; dev.preWriteBase = null;
}
function devSync(dev, file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = fileRead(file);
    devNoteClobber(dev, cur);
    const localPayload = syncPayloadOf(dev.db);
    const merged = S.normalizeMergedRecords(S.mergeSyncPayload(localPayload, cur, dev.base));
    const derivedFixed = S.reconcileDerivedAfterMerge(merged);
    Object.assign(dev.db, merged);
    if (!derivedFixed && !S.hasLocalContribution(localPayload, cur, dev.base)) {
      dev.base = S.buildSyncBase(cur);
      return 'skip';
    }
    const fresh = fileRead(file);
    if ((fresh.writeId || '') !== (cur.writeId || '')) continue;
    const preBase = dev.base ? cp(dev.base) : null;
    const writeId = 'w_' + dev.name + '_' + (file.writes + 1);
    fileWrite(file, Object.assign({}, merged, {
      writeId, writeIds: S.buildWriteIdRing(cur, writeId), lastWriteBy: dev.name, lastWriteAt: nowOf(dev),
    }));
    dev.base = S.buildSyncBase(merged);
    dev.lastWriteId = writeId; dev.lastWriteIdAt = new Date().toISOString(); dev.preWriteBase = preBase;
    return 'write';
  }
  return 'giveup';
}
function devPull(dev, file) {
  const remote = fileRead(file);
  devNoteClobber(dev, remote);
  const merged = S.normalizeMergedRecords(S.mergeSyncPayload(syncPayloadOf(dev.db), remote, dev.base));
  S.reconcileDerivedAfterMerge(merged);
  Object.assign(dev.db, merged);
  dev.base = S.buildSyncBase(remote);
}

/* ---------------- 账号与配置上的各种操作 ---------------- */
const PEOPLE = ['凌象政', '卞一茗', '孙宇颉', '朱轶杰', '李兰', '梁怡飞', '蒋双樑', '诸慧玲', '郭妙吉', '周雨桐'];
const ROLES = ['staff', 'comanager', 'director'];

// 心跳：刻意不 stampMeta（跟 markUserSeen 一致），只写 lastSeenAt / lastAppVersion
function heartbeat(dev) {
  const u = dev.db.users.find(x => x.name === dev.name);
  if (!u) return;
  u.lastSeenAt = nowOf(dev);
  u.lastAppVersion = S.APP_VERSION;
}
function changeRole(dev) {                    // 只有管理员设备干这事，并且留下授权凭证
  if (dev.name !== '甲·管理员') return;
  const u = pick(dev.db.users.filter(x => !x.deleted_at && x.role !== 'admin'));
  if (!u) return;
  const from = u.role, to = pick(ROLES.filter(r => r !== from));
  u.role = to; devStamp(dev, u);
  const id = 'log_role_' + dev.name + '_' + dev.logsWritten.length + '_' + Math.floor(rnd() * 1e6);
  dev.db.changelog.push({ id, at: nowOf(dev), by: dev.name, kind: S.ADMIN_LOG_KIND, taskId: '',
    summary: `把 ${u.name} 的角色从「${from}」改为「${to}」`, target: u.name, roleFrom: from, roleTo: to });
  dev.logsWritten.push(id);
}
function resetPin(dev) {
  if (dev.name !== '甲·管理员') return;
  const u = pick(dev.db.users.filter(x => !x.deleted_at && x.name !== dev.name));
  if (!u) return;
  u.salt = ''; u.hash = ''; u.iterations = 0; devStamp(dev, u);
}
function addUser(dev) {
  if (dev.name !== '甲·管理员') return;
  const name = '新人' + Math.floor(rnd() * 1e6);
  const u = devStamp(dev, { name, role: 'staff', salt: '', hash: '', iterations: 0 });
  dev.db.users.push(u);
  const id = 'log_new_' + dev.name + '_' + dev.logsWritten.length + '_' + Math.floor(rnd() * 1e6);
  dev.db.changelog.push({ id, at: nowOf(dev), by: dev.name, kind: S.ADMIN_LOG_KIND, taskId: '',
    summary: `新建账号 ${name}`, target: name, roleTo: 'staff' });
  dev.logsWritten.push(id);
}
function pushLog(dev) {
  const id = 'log_' + dev.name + '_' + dev.logsWritten.length + '_' + Math.floor(rnd() * 1e6);
  dev.db.changelog.push({ id, at: nowOf(dev), by: dev.name, kind: 'edit', entity: 'task', refId: '', taskId: '', summary: '仿真日志' });
  dev.logsWritten.push(id);
}
function pushPurge(dev) {
  const id = 'gone_' + dev.name + '_' + dev.purgesWritten.length + '_' + Math.floor(rnd() * 1e6);
  dev.db.purged = (dev.db.purged || []).concat([{ entity: 'task', id, at: nowOf(dev), by: dev.name }]);
  dev.purgesWritten.push(id);
}

/* 每个整体配置对象指定唯一的修改者：没有并发，它的每一次改动都必须最终生效。
   这正是"共享文件夹配置 rev 永远是 1"那个 bug 表现出来的形态——
   表慢的那台设备改了却推不上去，而且再改多少次也推不上去。 */
const OWNERS = {};   // 配置名 -> 负责的设备名
function editShareCfg(dev) {
  if (OWNERS.shareConfig !== dev.name) return;
  const bak = S.DB.shareConfig, bakMe = S.DB.settings.me;
  S.DB.shareConfig = dev.db.shareConfig ? cp(dev.db.shareConfig) : null;
  S.DB.settings.me = dev.name;
  S.updateShareConfig({ recycleKeepDays: 10 + Math.floor(rnd() * 300) });   // 走程序自己的更新路径
  const cfg = S.DB.shareConfig;
  cfg.updated_at = nowOf(dev); cfg.updated_by = dev.name;                   // 换成这台机器的表
  dev.db.shareConfig = cp(cfg);
  dev.expect = Object.assign(dev.expect || {}, { shareConfig: cfg.recycleKeepDays });
  S.DB.shareConfig = bak; S.DB.settings.me = bakMe;
}
function editReportCfg(dev) {
  if (OWNERS.reportConfig !== dev.name) return;
  const cur = dev.db.reportConfig || { presets: [{ id: 'p1', name: '默认', sections: [] }], activeId: 'p1' };
  const next = cp(cur);
  next.presets[0].name = '编排' + Math.floor(rnd() * 1e6);
  next.rev = (cur.rev || 0) + 1; next.updated_at = nowOf(dev); next.updated_by = dev.name;
  dev.db.reportConfig = next;
  dev.expect = Object.assign(dev.expect || {}, { reportConfig: next.presets[0].name });
}
function editDashCfg(dev) {
  if (OWNERS.dashboardConfig !== dev.name) return;
  const cur = dev.db.dashboardConfig || { presets: [{ id: 'd1', name: '默认', sections: [] }], activeId: 'd1' };
  const next = cp(cur);
  next.presets[0].name = '工作台' + Math.floor(rnd() * 1e6);
  next.rev = (cur.rev || 0) + 1; next.updated_at = nowOf(dev); next.updated_by = dev.name;
  dev.db.dashboardConfig = next;
  dev.expect = Object.assign(dev.expect || {}, { dashboardConfig: next.presets[0].name });
}
function editMatrix(dev) {
  if (OWNERS.permissionMatrix !== dev.name) return;
  const cur = dev.db.permissionMatrix || cp(S.DEFAULT_PERMISSION_MATRIX);
  const next = Object.assign({}, cur, { staff: Object.assign({}, cur.staff) });
  next.staff.view_logs = !next.staff.view_logs;
  next.rev = (cur.rev || 0) + 1; next.updated_at = nowOf(dev); next.updated_by = dev.name;
  dev.db.permissionMatrix = next;
  /* ★ 跟真实程序保持一致：在权限页点一次开关，除了改矩阵还会写一条管理日志 ★（P132）
     别人的机器现在会校验"放宽权限有没有有权限的人批过"（见 guardPermissionMatrix）——
     不写这条日志，这次调整在全处每台机器上都会被当成未经授权的放宽挡下来，
     那是仿真没模拟到位，不是产品的问题。 */
  dev.db.changelog.push({ id: 'log_mx' + Math.random().toString(36).slice(2, 10),
    at: nowOf(dev), by: dev.name, kind: S.ADMIN_LOG_KIND,
    summary: `权限矩阵：${next.staff.view_logs ? '开启' : '关闭'}了「员工」的「查看日志页」` });
  dev.expect = Object.assign(dev.expect || {}, { permissionMatrix: next.staff.view_logs });
}

const OPS = [heartbeat, heartbeat, changeRole, resetPin, addUser, pushLog, pushLog, pushPurge,
  editShareCfg, editReportCfg, editDashCfg, editMatrix];

/* ---------------- 跑 ---------------- */
async function main() {
  await tick();

  const seedUsers = ['甲·管理员'].concat(PEOPLE).map((name, i) => ({
    name, role: name === '甲·管理员' ? 'admin' : 'staff',
    salt: 'aa', hash: 'bb', iterations: 1000,
    lastSeenAt: '2026-09-01T00:00:00.000Z', lastAppVersion: S.APP_VERSION,
    rev: 1, created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z', updated_by: '初始',
  }));
  const seed = {
    duties: [], works: [], milestones: [], tasks: [],
    changelog: [], users: seedUsers, purged: [],
    permissionMatrix: cp(S.DEFAULT_PERMISSION_MATRIX),
    shareConfig: { fileName: 'x.json', autoBackupEnabled: false, autoBackupHours: 24, recycleKeepDays: 60,
      rev: 1, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', updated_by: '初始' },
    reportConfig: { presets: [{ id: 'p1', name: '默认', sections: [] }], activeId: 'p1', rev: 1,
      updated_at: '2026-09-01T00:00:00.000Z', updated_by: '初始' },
    dashboardConfig: { presets: [{ id: 'd1', name: '默认', sections: [] }], activeId: 'd1', rev: 1,
      updated_at: '2026-09-01T00:00:00.000Z', updated_by: '初始' },
    writeId: 'w_seed', writeIds: ['w_seed'],
  };
  seed.permissionMatrix.rev = 1;
  seed.permissionMatrix.updated_at = '2026-09-01T00:00:00.000Z';
  seed.permissionMatrix.updated_by = '初始';

  const file = mkFile(seed);
  const devs = [
    mkDevice('甲·管理员', file, 0),
    mkDevice('乙·表快7分', file, 7),
    mkDevice('丙·表慢12分', file, -12),     // ★ 表慢的那台：配置由它负责改，看能不能推得上去
    mkDevice('丁·普通', file, 0),
  ];
  // 表慢的那台负责改共享文件夹配置和工作台编排——最容易暴露"版本号失效、只剩时钟"的问题
  OWNERS.shareConfig = '丙·表慢12分';
  OWNERS.dashboardConfig = '丙·表慢12分';
  OWNERS.reportConfig = '乙·表快7分';
  OWNERS.permissionMatrix = '甲·管理员';

  console.log(`设备 ${devs.length} 台，${ROUNDS} 轮，种子 ${SEED}`);
  console.log('配置对象的唯一修改者：' + Object.keys(OWNERS).map(k => `${k}=${OWNERS[k]}`).join('、') + '\n');

  for (let r = 0; r < ROUNDS; r++) {
    const dev = pick(devs);
    const n = 1 + Math.floor(rnd() * 2);
    for (let k = 0; k < n; k++) pick(OPS)(dev);
    const roll = rnd();
    if (roll < 0.35) devPull(dev, file); else devSync(dev, file);
  }
  for (let i = 0; i < 10; i++) devs.forEach(d => devSync(d, file));
  for (let i = 0; i < 3; i++) devs.forEach(d => devPull(d, file));

  const F = fileRead(file);
  console.log(`跑完：写文件 ${file.writes} 次，账号 ${F.users.length} 个，日志 ${F.changelog.length} 条，墓碑 ${(F.purged || []).length} 条\n`);

  section('一、收敛');
  devs.forEach(d => {
    ok(`${d.name} 的账号与文件一致`, JSON.stringify(d.db.users) === JSON.stringify(F.users));
    ok(`${d.name} 的四个配置对象与文件一致`,
      ['permissionMatrix', 'shareConfig', 'reportConfig', 'dashboardConfig']
        .every(k => JSON.stringify(d.db[k]) === JSON.stringify(F[k])));
  });

  section('二、★独占改动必须生效（没有并发，改了就必须推得上去）');
  devs.forEach(d => {
    if (!d.expect) return;
    Object.keys(d.expect).forEach(k => {
      const want = d.expect[k];
      const got = k === 'shareConfig' ? F.shareConfig.recycleKeepDays
        : k === 'permissionMatrix' ? F.permissionMatrix.staff.view_logs
          : F[k].presets[0].name;
      ok(`${d.name} 独占修改的「${k}」最终生效了`, got === want, { 期望: want, 实际: got, rev: F[k] && F[k].rev });
    });
  });

  section('三、账号');
  const byName = new Map(F.users.map(u => [u.name, u]));
  ok('新建的账号一个都没丢',
    devs.every(d => d.db.users.every(u => byName.has(u.name))),
    devs.flatMap(d => d.db.users.filter(u => !byName.has(u.name)).map(u => u.name)).slice(0, 5));
  ok('★"最近连接"取的是各设备心跳里最晚的那个（心跳不走 stampMeta，必须单独合并）',
    F.users.every(u => {
      const mx = devs.reduce((m, d) => {
        const x = d.db.users.find(y => y.name === u.name);
        return x && (x.lastSeenAt || '') > m ? x.lastSeenAt : m;
      }, '');
      return !mx || (u.lastSeenAt || '') >= mx;
    }));
  ok('★管理员改的角色没有被"未经授权的提权"检查误挡（每次改角色都留了凭证）',
    (S.integrityAlerts || []).length === 0, S.integrityAlerts);
  ok('账号没有重复', new Set(F.users.map(u => u.name)).size === F.users.length);

  section('四、日志与墓碑');
  const logIds = new Set(F.changelog.map(e => e.id));
  ok(`日志 ${F.changelog.length} 条，没超上限 ${S.CHANGELOG_LIMIT}`, F.changelog.length <= S.CHANGELOG_LIMIT);
  ok('日志没有重复 id', logIds.size === F.changelog.length);
  const allLogs = devs.flatMap(d => d.logsWritten);
  const lostLogs = allLogs.filter(id => !logIds.has(id));
  ok(`产生的 ${allLogs.length} 条日志一条都没丢（没到上限时这是硬要求）`,
    F.changelog.length < S.CHANGELOG_LIMIT ? lostLogs.length === 0 : true, lostLogs.slice(0, 5));
  ok('★角色变更的凭证日志都在（缺了会让别人的机器把这次提权当成篡改挡下来）',
    F.changelog.filter(e => e.kind === S.ADMIN_LOG_KIND && e.roleTo).length > 0);
  const purgeIds = new Set((F.purged || []).map(p => p.id));
  const allPurges = devs.flatMap(d => d.purgesWritten);
  ok(`墓碑 ${(F.purged || []).length} 条，没超上限 ${S.PURGED_LIMIT}`, (F.purged || []).length <= S.PURGED_LIMIT);
  ok('产生的墓碑一条都没丢', (F.purged || []).length < S.PURGED_LIMIT
    ? allPurges.every(id => purgeIds.has(id)) : true,
    allPurges.filter(id => !purgeIds.has(id)).slice(0, 5));

  section('五、配置对象的版本号必须真的在涨（涨不动就只剩时钟能定胜负）');
  // 只对"这一轮真被改过"的配置断言：负责人有可能一次都没被随机选中，那时 rev 还是初始值，不算问题
  const touched = new Set(devs.flatMap(d => Object.keys(d.expect || {})));
  ['permissionMatrix', 'shareConfig', 'reportConfig', 'dashboardConfig'].forEach(k => {
    if (!touched.has(k)) { console.log(`  ·（「${k}」这一轮没人改过，跳过）`); return; }
    ok(`「${k}」的 rev 涨上去了（当前 ${F[k] && F[k].rev}）`, (F[k] && F[k].rev || 0) > 1, F[k] && F[k].rev);
  });

  console.log('\n' + '='.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('仿真异常：', e); process.exit(1); });
