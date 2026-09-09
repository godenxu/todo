/* 第八轮排查：拿真实形状的演示数据（236KB、157 任务 / 182 里程碑 / 34 工作）
   做"多台设备长时间协同"的整机仿真。
   跟 test-p88 的区别：
     1) 用真数据，不是三五条构造记录——很多问题只在"记录之间有引用关系"时才出得来；
     2) 同步路径补齐 normalizeMergedRecords + reconcileDerivedAfterMerge（p88 写的时候还没有）；
     3) 模拟"两台设备交错读写"（真正的写入竞争），检验写后校验+重试；
     4) 模拟长期不同步的旧页面、时钟不同步、只读拉取的观众设备；
     5) 收敛之后跑一遍 healthCheck，看同步过程有没有自己造出脏数据。
   用法：ROUNDS=400 SEED=1 node scratchpad/sim8.js
   （轮数/种子走环境变量：argv[2] 被 harness.js 占用，它拿那个当 index.html 的路径）
*/
const fs = require('fs');
const path = require('path');
const REPO = 'C:/Users/Administrator/Documents/Claude/Todo';
const { sandbox: S } = require(REPO + '/test/harness.js');

const ROUNDS = Number(process.env.ROUNDS) || 400;
const SEED = Number(process.env.SEED) || 20260908;
const cp = o => JSON.parse(JSON.stringify(o));
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

let _s = SEED;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];

const TRACE = process.env.TRACE || '';      // 要追踪的记录 id
let ROUND = 0;
const trace = (...a) => { if (TRACE) console.log('   [追踪 r' + ROUND + ']', ...a); };
const msDone = (db, id) => { const m = (db.milestones || []).find(x => x.id === id); return m ? m.done + '/rev' + m.rev : '无'; };
const baseDone = (b, id) => (b && b.milestone && b.milestone[id]) ? b.milestone[id].done + '/rev' + b.milestone[id].rev : '无';
// 每台设备的 done 值一变就打一行，连基线一起打——就是要看"本机=0 而基线=1"这种组合是怎么出现的
function watch(dev, where) {
  if (!TRACE) return;
  const now = msDone(dev.db, TRACE) + ' 基线=' + baseDone(dev.base, TRACE);
  if (dev._watch !== now) { console.log('   [值变 r' + ROUND + ']', dev.name, where, dev._watch + ' → ' + now); dev._watch = now; }
}
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 900) : '')); }
};
const section = t => console.log('\n■ ' + t);

/* ---------------- 共享文件 ---------------- */
function mkFile(payload) { return { text: JSON.stringify(payload), writes: 0 }; }
function fileRead(f) { return JSON.parse(f.text); }                       // 每次读都反序列化，跟真实情况一致（拿到的是独立副本）
function fileWrite(f, payload) { f.text = JSON.stringify(payload); f.writes++; }

/* ---------------- 一台设备 ---------------- */
function mkDevice(name, file, opts) {
  opts = opts || {};
  return {
    name, db: fileRead(file), base: S.buildSyncBase(fileRead(file)),
    skewMs: (opts.skewMin || 0) * 60000,
    readonly: !!opts.readonly,          // 只看不改的"观众"（领导那台）
    offline: !!opts.offline,            // 长期不同步的旧页面
    lastWriteId: '', lastWriteIdAt: '', preWriteBase: null,   // 写入链检测用（对应 index.html 里那三个）
    edits: [],                          // 这台机器改过什么，用于最终对账
    clobbered: 0,                       // 发现"自己那次写被人盖掉"的次数
  };
}
const nowOf = dev => new Date(Date.now() + dev.skewMs).toISOString();

/* 照 stampMeta 的规则盖章（含 delete merged_from） */
function devStamp(dev, rec) {
  if (!rec.created_at) rec.created_at = nowOf(dev);
  rec.updated_at = nowOf(dev);
  rec.updated_by = dev.name;
  rec.rev = (rec.rev || 0) + 1;
  delete rec.merged_from;
  return rec;
}

/* ---------------- 同步：严格照 syncToFileInner / pullFromFileInner ---------------- */
function syncPayloadOf(db) {
  return { duties: db.duties, works: db.works, milestones: db.milestones, tasks: db.tasks,
    changelog: db.changelog, users: db.users, permissionMatrix: db.permissionMatrix,
    shareConfig: db.shareConfig, reportConfig: db.reportConfig || null,
    dashboardConfig: db.dashboardConfig || null, purged: db.purged || [] };
}
// 对应 noteClobberedWrite：读到的这份文件里，还有没有"我上次写的那个标记"
function devNoteClobber(dev, remote) {
  const fake = { settings: { lastWriteId: dev.lastWriteId, lastWriteIdAt: dev.lastWriteIdAt }, syncBase: dev.base };
  S.setLastWriteId('');                       // 走 db.settings 那条分支，别让沙盒里的模块级变量串味
  if (!S.detectClobberedWrite(remote, fake)) return false;
  dev.clobbered++;
  const before = TRACE ? baseDone(dev.base, TRACE) : '';
  // 走程序自己的逐条回滚（带版本号护栏），别在仿真里另写一套
  const holder = { syncBase: dev.base };
  S.setPreWriteBase(dev.preWriteBase);
  if (dev.preWriteBase) { S.rollbackBaseForClobber(holder, remote); dev.base = holder.syncBase; }
  S.setPreWriteBase(null);
  if (TRACE) console.log('   [值变 r' + ROUND + ']', dev.name, '★发现被盖掉，回滚基线 ' + before + ' → ' + baseDone(dev.base, TRACE));
  if (TRACE) dev._watch = msDone(dev.db, TRACE) + ' 基线=' + baseDone(dev.base, TRACE);
  dev.lastWriteId = ''; dev.lastWriteIdAt = ''; dev.preWriteBase = null;
  return true;
}
// 读—合并—写。remoteOverride：模拟"我读到的是几毫秒前那份"（交错写入场景）
function devSync(dev, file, remoteOverride) {
  if (dev.offline) return 'offline';
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = attempt === 0 && remoteOverride ? remoteOverride : fileRead(file);
    devNoteClobber(dev, cur);
    const localPayload = syncPayloadOf(dev.db);
    const merged = S.normalizeMergedRecords(S.mergeSyncPayload(localPayload, cur, dev.base));
    const derivedFixed = S.reconcileDerivedAfterMerge(merged);
    Object.assign(dev.db, merged);
    if (!derivedFixed && !S.hasLocalContribution(localPayload, cur, dev.base)) {
      dev.base = S.buildSyncBase(cur);
      watch(dev, '跳过写入后');
      return 'skip';
    }
    dev.base = S.buildSyncBase(cur);   // P100：本机已经吸收了 cur，基线要跟着推进（跟 index.html 一致）
    const preBase = dev.base ? cp(dev.base) : null;
    // ★ 写之前再确认一次文件没被抢先（对应新增的 fresh 读取）
    const fresh = fileRead(file);
    if ((fresh.writeId || '') !== (cur.writeId || '')) { if (TRACE) trace(dev.name, '写前确认发现被抢先，重来'); continue; }
    const writeId = 'w_' + dev.name + '_' + (file.writes + 1);
    const out = Object.assign({}, merged, {
      writeId, writeIds: S.buildWriteIdRing(cur, writeId), lastWriteBy: dev.name, lastWriteAt: nowOf(dev),
    });
    fileWrite(file, out);
    dev.base = S.buildSyncBase(merged);
    dev.lastWriteId = writeId; dev.lastWriteIdAt = new Date().toISOString(); dev.preWriteBase = preBase;
    watch(dev, '写入 ' + writeId + ' 后');
    return 'write';
  }
  return 'giveup';
}
// 只读拉取
function devPull(dev, file) {
  if (dev.offline) return 'offline';
  const remote = fileRead(file);
  devNoteClobber(dev, remote);
  const merged = S.normalizeMergedRecords(S.mergeSyncPayload(syncPayloadOf(dev.db), remote, dev.base));
  S.reconcileDerivedAfterMerge(merged);
  Object.assign(dev.db, merged);
  dev.base = S.buildSyncBase(remote);
  watch(dev, '只读拉取后');
  return 'pull';
}
/* ★ 真正的写入竞争 ★ 甲、乙同时读到同一份，甲先写完并校验通过，乙才拿着过期内容写。
   乙的"写前确认"这时已经做过了（它读的也是那份旧的），所以这一半竞争仍然会发生——
   它正是靠写入链事后发现、下一轮补推兜住的。这里如实模拟这个最坏时序。 */
function devSyncRace(devA, devB, file) {
  const snapshot = fileRead(file);
  devSync(devA, file, snapshot);
  // 乙：手里是过期快照，而且它的"写前确认"也是拿这份快照比的 → 确认不出来，直接盖上去
  devNoteClobber(devB, snapshot);
  const preBase = devB.base ? cp(devB.base) : null;   // 真实代码里这一份是一定留着的，别在仿真里少给
  const localPayload = syncPayloadOf(devB.db);
  const merged = S.normalizeMergedRecords(S.mergeSyncPayload(localPayload, snapshot, devB.base));
  S.reconcileDerivedAfterMerge(merged);
  Object.assign(devB.db, merged);
  const writeId = 'w_' + devB.name + '_race' + (file.writes + 1);
  fileWrite(file, Object.assign({}, merged, {
    writeId, writeIds: S.buildWriteIdRing(snapshot, writeId), lastWriteBy: devB.name, lastWriteAt: nowOf(devB),
  }));
  devB.base = S.buildSyncBase(merged);
  devB.lastWriteId = writeId; devB.lastWriteIdAt = new Date().toISOString(); devB.preWriteBase = preBase;
  if (TRACE) console.log('   [竞争 r' + ROUND + ']', devA.name + ' 先写，' + devB.name + ' 拿旧快照盖上去 → 文件=' + msDone(fileRead(file), TRACE));
  watch(devB, '竞争写入后');
  return 'race';
}

/* ---------------- 设备上的各种操作 ---------------- */
function aliveTasks(db) { return db.tasks.filter(t => !t.deleted_at); }
function msOf(db, tid) { return db.milestones.filter(m => m.task === tid && !m.deleted_at); }
function recalc(db, t) {
  const cps = msOf(db, t.id);
  if (cps.length) t.progress = Math.round(cps.filter(m => m.done === '1').length / cps.length * 100);
}
// 记一笔"我改了某条记录的某个字段成什么值"，最终对账要用
function note(dev, entity, id, field, value) { dev.edits.push({ dev: dev.name, entity, id, field, value, seq: dev.edits.length }); }

const OPS = [
  function editStatus(dev) {
    const t = pick(aliveTasks(dev.db)); if (!t) return;
    const v = pick(['todo', 'doing', 'done', 'hold']);
    t.status = v; devStamp(dev, t); note(dev, 'task', t.id, 'status', v);
  },
  function editPriority(dev) {
    const t = pick(aliveTasks(dev.db)); if (!t) return;
    const v = pick(['1', '2', '3']);
    t.priority = v; devStamp(dev, t); note(dev, 'task', t.id, 'priority', v);
  },
  function editPlanDate(dev) {
    const t = pick(aliveTasks(dev.db)); if (!t) return;
    const v = S.offsetDate(Math.floor(rnd() * 60) - 20);
    t.plan_date = v; devStamp(dev, t); note(dev, 'task', t.id, 'plan_date', v);
  },
  function editOwner(dev) {
    const t = pick(aliveTasks(dev.db)); if (!t) return;
    const v = pick(['凌象政', '卞一茗', '孙宇颉', '徐捷', '朱轶杰', '李兰', '周雨桐', '何昀']);
    t.owner = v; devStamp(dev, t); note(dev, 'task', t.id, 'owner', v);
  },
  function editTitle(dev) {
    const t = pick(aliveTasks(dev.db)); if (!t) return;
    const v = t.title.replace(/（改\d+）$/, '') + '（改' + Math.floor(rnd() * 900 + 100) + '）';
    t.title = v; devStamp(dev, t); note(dev, 'task', t.id, 'title', v);
  },
  function toggleMs(dev) {                                  // 勾里程碑 → 任务进度联动重算（跟详情页保存一致）
    const ms = dev.db.milestones.filter(m => !m.deleted_at); const m = pick(ms); if (!m) return;
    m.done = m.done === '1' ? '0' : '1';
    m.actual_date = m.done === '1' ? S.todayStr() : '';
    devStamp(dev, m); note(dev, 'milestone', m.id, 'done', m.done);
    if (TRACE && m.id === TRACE) trace(dev.name, '改了 done →', m.done, 'rev' + m.rev);
    const t = dev.db.tasks.find(x => x.id === m.task);
    if (t && !t.deleted_at) { recalc(dev.db, t); devStamp(dev, t); }
  },
  function addMs(dev) {
    const t = pick(aliveTasks(dev.db)); if (!t) return;
    const m = devStamp(dev, { id: 'm_sim_' + dev.name + '_' + dev.edits.length + '_' + Math.floor(rnd() * 1e6),
      task: t.id, plan_date: S.offsetDate(Math.floor(rnd() * 40)), deliverable: '仿真交付物',
      report_level: pick(['section', 'department', 'bank']), done: '0', actual_date: '' });
    dev.db.milestones.push(m); note(dev, 'milestone', m.id, '_exists', true);
    recalc(dev.db, t); devStamp(dev, t);
  },
  function addTask(dev) {
    const w = pick(dev.db.works.filter(x => !x.deleted_at)); if (!w) return;
    const t = devStamp(dev, { id: 't_sim_' + dev.name + '_' + dev.edits.length + '_' + Math.floor(rnd() * 1e6),
      work: w.id, code: '', title: '仿真新建任务 ' + dev.name + dev.edits.length, owner: dev.name,
      assignees: [], status: 'todo', priority: '2', plan_date: S.offsetDate(15), progress: 0,
      actual_date: '', source: '内部发起', custom: '' });
    dev.db.tasks.push(t); note(dev, 'task', t.id, '_exists', true);
  },
  function softDeleteTask(dev) {                            // 级联：任务 + 名下里程碑
    const t = pick(aliveTasks(dev.db)); if (!t) return;
    const at = nowOf(dev);
    t.deleted_at = at; devStamp(dev, t); note(dev, 'task', t.id, 'deleted_at', at);
    msOf(dev.db, t.id).forEach(m => { m.deleted_at = at; devStamp(dev, m); });
  },
  function undeleteTask(dev) {
    const t = pick(dev.db.tasks.filter(x => x.deleted_at)); if (!t) return;
    t.deleted_at = ''; devStamp(dev, t); note(dev, 'task', t.id, 'deleted_at', '');
  },
  function editWork(dev) {
    const w = pick(dev.db.works.filter(x => !x.deleted_at)); if (!w) return;
    const v = pick(['doing', 'done', 'hold']);
    w.status = v; devStamp(dev, w); note(dev, 'work', w.id, 'status', v);
  },
  function editDuty(dev) {
    const d = pick(dev.db.duties.filter(x => !x.deleted_at)); if (!d) return;
    const v = d.name.replace(/（改\d+）$/, '') + '（改' + Math.floor(rnd() * 900 + 100) + '）';
    d.name = v; devStamp(dev, d); note(dev, 'duty', d.code, 'name', v);
  },
  function pushLog(dev) {
    dev.db.changelog.push({ id: 'log_sim_' + dev.name + '_' + dev.edits.length + '_' + Math.floor(rnd() * 1e6),
      at: nowOf(dev), by: dev.name, kind: 'edit', entity: 'task', refId: '', taskId: '', summary: '仿真日志' });
  },
  function hardDelete(dev) {                                // 彻底删除 + 墓碑（照 cascadeRemoveHardTask：里程碑也要留墓碑）
    const t = pick(dev.db.tasks.filter(x => x.deleted_at)); if (!t) return;
    const at = nowOf(dev);
    const kill = (entity, id) => {
      dev.db.purged = (dev.db.purged || []).filter(p => !(p.entity === entity && p.id === id));
      dev.db.purged.push({ entity, id, at, by: dev.name });
    };
    dev.db.milestones.filter(m => m.task === t.id).forEach(m => kill('milestone', m.id));
    dev.db.milestones = dev.db.milestones.filter(m => m.task !== t.id);
    dev.db.tasks = dev.db.tasks.filter(x => x.id !== t.id);
    kill('task', t.id);
    note(dev, 'task', t.id, '_purged', true);
  },
  function editMatrix(dev) {
    const pm = cp(dev.db.permissionMatrix || S.DEFAULT_PERMISSION_MATRIX);
    pm.staff.view_logs = !pm.staff.view_logs;
    devStamp(dev, pm); dev.db.permissionMatrix = pm;
  },
];

/* ---------------- 跑 ---------------- */
async function main() {
  await tick();
  const demo = JSON.parse(fs.readFileSync(path.join(REPO, 'demo', '科技规划处工作管理.json'), 'utf8'));
  delete demo.schemaVersion; delete demo.writeId; delete demo.lastWriteBy;
  delete demo.lastWriteApp; delete demo.lastWriteAt;

  demo.writeId = 'w_seed';
  demo.writeIds = ['w_seed'];      // 起始文件带一条完好的写入链（不插哨兵，检测才生效）
  const file = mkFile(demo);
  const devs = [
    mkDevice('甲·徐捷', file, {}),
    mkDevice('乙·邱洋', file, { skewMin: 7 }),          // 表快 7 分钟
    mkDevice('丙·朱轶杰', file, { skewMin: -4 }),        // 表慢 4 分钟
    mkDevice('丁·周雨桐', file, {}),
    mkDevice('戊·孙宇颉', file, { readonly: true }),      // 领导，只看不改
    mkDevice('己·旧页面', file, { }),                    // 前 3/4 轮离线（开着不动的旧页面）
  ];
  const stale = devs[5];
  stale.offline = true;

  console.log(`起始：任务 ${demo.tasks.length}、里程碑 ${demo.milestones.length}、日志 ${demo.changelog.length}`);
  console.log(`设备 ${devs.length} 台，${ROUNDS} 轮，种子 ${SEED}\n`);

  let races = 0, writes = 0, skips = 0;
  for (let r = 0; r < ROUNDS; r++) {
    ROUND = r;
    if (r === Math.floor(ROUNDS * 0.75)) stale.offline = false;   // 旧页面在这一刻恢复联网（最危险的时刻）
    const dev = pick(devs);
    if (!dev.readonly && !dev.offline) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) pick(OPS)(dev);
    }
    const roll = rnd();
    if (roll < (process.env.RACE === '0' ? -1 : 0.12)) {   // 12% 概率制造写入竞争（RACE=0 关掉）
      const a = pick(devs.filter(d => !d.readonly && !d.offline));
      const b = pick(devs.filter(d => d !== a && !d.readonly && !d.offline));
      if (a && b) { devSyncRace(a, b, file); races++; }
    } else if (dev.readonly || roll < 0.35) {
      devPull(dev, file);
    } else {
      const res = devSync(dev, file);
      if (res === 'write') writes++; else if (res === 'skip') skips++;
    }
  }
  // 收尾：所有设备来回同步几轮直到收敛
  stale.offline = false;
  for (let i = 0; i < 8; i++) devs.forEach(d => devSync(d, file));
  for (let i = 0; i < 3; i++) devs.forEach(d => devPull(d, file));

  const finalFile = fileRead(file);
  console.log(`跑完：文件写入 ${file.writes} 次（其中"没东西可推所以没写" ${skips} 次、竞争 ${races} 次）\n`);

  /* ============ 不变量 ============ */
  section('一、收敛：所有设备跟文件内容必须一模一样');
  const keyOf = (e, r) => (e === 'duty' ? r.code : e === 'user' ? r.name : r.id);
  const ENTS = [['duty', 'duties'], ['work', 'works'], ['task', 'tasks'], ['milestone', 'milestones']];
  ENTS.forEach(([e, k]) => {
    const fileMap = new Map(finalFile[k].map(r => [keyOf(e, r), r]));
    devs.forEach(d => {
      const dm = new Map(d.db[k].map(r => [keyOf(e, r), r]));
      const missing = [...fileMap.keys()].filter(id => !dm.has(id));
      const extra = [...dm.keys()].filter(id => !fileMap.has(id));
      const diff = [...fileMap.keys()].filter(id => dm.has(id) &&
        JSON.stringify(dm.get(id)) !== JSON.stringify(fileMap.get(id)));
      ok(`${d.name} 的 ${k} 与文件一致（${fileMap.size} 条）`, !missing.length && !extra.length && !diff.length,
        { missing: missing.slice(0, 3), extra: extra.slice(0, 3), diff: diff.slice(0, 3) });
    });
  });
  devs.forEach(d => ok(`${d.name} 的日志条数与文件一致`, d.db.changelog.length === finalFile.changelog.length,
    { dev: d.db.changelog.length, file: finalFile.changelog.length }));

  section('二、不丢改动：只有一台设备碰过的字段，最终值必须就是它改的那个');
  const byField = new Map();      // "entity id field" -> [{dev, value, seq}]
  devs.forEach(d => d.edits.forEach(e => {
    if (e.field.startsWith('_')) return;
    const k = e.entity + '|' + e.id + '|' + e.field;
    if (!byField.has(k)) byField.set(k, []);
    byField.get(k).push(e);
  }));
  const findRec = (e, id) => {
    const k = e === 'duty' ? 'duties' : e === 'work' ? 'works' : e === 'task' ? 'tasks' : 'milestones';
    return finalFile[k].find(r => keyOf(e, r) === id);
  };
  let solo = 0, soloBad = [];
  byField.forEach((list, k) => {
    const owners = new Set(list.map(x => x.dev));
    if (owners.size !== 1) return;                       // 多台改过同一字段 → 有胜负，不在本条断言范围
    const [entity, id, field] = k.split('|');
    if (field === 'deleted_at') return;                  // 删除/恢复另有断言
    const last = list[list.length - 1];
    const rec = findRec(entity, id);
    if (!rec) return;                                    // 被彻底删掉了，另有断言
    solo++;
    // 进度是算出来的，可能被别人加的里程碑改掉；标题等普通字段必须是我改的那个
    if (String(rec[field]) !== String(last.value)) soloBad.push({ k, 归谁改: last.dev, 期望: last.value,
      实际: rec[field], 记录最后修改人: rec.updated_by, rev: rec.rev, 合并吸收自: rec.merged_from || '' });
  });
  ok(`独占字段共 ${solo} 处，全部保住了`, soloBad.length === 0, soloBad.slice(0, 8));

  section('三、删除相关');
  const purgedIds = new Set((finalFile.purged || []).filter(p => p.entity === 'task').map(p => p.id));
  ok(`彻底删除的 ${purgedIds.size} 条任务没有一条复活`,
    !finalFile.tasks.some(t => purgedIds.has(t.id)),
    finalFile.tasks.filter(t => purgedIds.has(t.id)).map(t => t.id));
  ok('彻底删除的任务，名下里程碑也没复活',
    !finalFile.milestones.some(m => purgedIds.has(m.task)),
    finalFile.milestones.filter(m => purgedIds.has(m.task)).map(m => m.id).slice(0, 5));

  section('四、版本号不无限膨胀');
  const maxRev = Math.max(...finalFile.tasks.map(t => t.rev || 0));
  const totalEdits = devs.reduce((n, d) => n + d.edits.length, 0);
  ok(`任务最高 rev=${maxRev}，远小于总操作数 ${totalEdits}（不是每同步一轮就 +1）`, maxRev < totalEdits, maxRev);
  ok('没有任何记录的 rev 是 0 或缺失',
    ![...finalFile.tasks, ...finalFile.milestones, ...finalFile.works].some(r => !(r.rev > 0)));

  section('五、派生字段：任务进度必须等于它名下里程碑的完成比例');
  const bad = [];
  finalFile.tasks.filter(t => !t.deleted_at).forEach(t => {
    const cps = finalFile.milestones.filter(m => m.task === t.id && !m.deleted_at);
    if (!cps.length) return;
    const want = Math.round(cps.filter(m => m.done === '1').length / cps.length * 100);
    if (Number(t.progress) !== want) bad.push({ id: t.id, title: t.title, 存的: t.progress, 应该是: want });
  });
  ok(`有里程碑的任务共 ${finalFile.tasks.filter(t => !t.deleted_at && finalFile.milestones.some(m => m.task === t.id && !m.deleted_at)).length} 条，进度全部对得上`,
    bad.length === 0, bad.slice(0, 6));

  section('六、引用完整性没被同步破坏');
  const wIds = new Set(finalFile.works.map(w => w.id));
  const tIds = new Set(finalFile.tasks.map(t => t.id));
  const dCodes = new Set(finalFile.duties.map(d => d.code));
  ok('每项工作的职责都还在', finalFile.works.every(w => dCodes.has(w.duty)));
  ok('每条任务的工作都还在', finalFile.tasks.every(t => !t.work || wIds.has(t.work)),
    finalFile.tasks.filter(t => t.work && !wIds.has(t.work)).map(t => t.id).slice(0, 5));
  ok('每个里程碑的任务都还在', finalFile.milestones.every(m => tIds.has(m.task)),
    finalFile.milestones.filter(m => !tIds.has(m.task)).map(m => m.id).slice(0, 5));

  section('七、日志：产生过的每一条都还在（没超上限的前提下）');
  const allLogIds = new Set();
  devs.forEach(d => d.db.changelog.forEach(e => allLogIds.add(e.id)));
  const fileLogIds = new Set(finalFile.changelog.map(e => e.id));
  ok(`日志 ${finalFile.changelog.length} 条，未超上限 ${S.CHANGELOG_LIMIT}`, finalFile.changelog.length <= S.CHANGELOG_LIMIT);
  const lostLogs = [...allLogIds].filter(id => !fileLogIds.has(id));
  ok('没有日志在合并中丢失', finalFile.changelog.length < S.CHANGELOG_LIMIT ? lostLogs.length === 0 : true, lostLogs.slice(0, 5));
  ok('日志没有重复 id', fileLogIds.size === finalFile.changelog.length,
    { 唯一: fileLogIds.size, 总数: finalFile.changelog.length });

  section('八、账号：角色没被无授权改动，最近连接没丢');
  const roleNow = new Map(finalFile.users.map(u => [u.name, u.role]));
  const roleWas = new Map(demo.users.map(u => [u.name, u.role]));
  const changed = [...roleWas.keys()].filter(n => roleNow.get(n) !== roleWas.get(n));
  ok('没有账号的角色在仿真中被改动（仿真里没人改角色）', changed.length === 0, changed);
  ok('每个账号都还留着 lastSeenAt', finalFile.users.every(u => u.deleted_at || u.lastSeenAt),
    finalFile.users.filter(u => !u.deleted_at && !u.lastSeenAt).map(u => u.name));

  section('九、整体对象（权限矩阵 / 编排配置 / 共享配置）没丢');
  ok('权限矩阵还在', !!finalFile.permissionMatrix);
  ok('报告页编排还在，且预设没少', !!finalFile.reportConfig && (finalFile.reportConfig.presets || []).length === 2);
  ok('工作台编排还在，且预设没少', !!finalFile.dashboardConfig && (finalFile.dashboardConfig.presets || []).length === 2);
  ok('共享文件夹配置还在', !!finalFile.shareConfig && finalFile.shareConfig.recycleKeepDays === 60);

  section('十、把最终结果装进程序，跑一遍数据体检');
  Object.assign(S.DB, S.normalizeMergedRecords(S.mergeSyncPayload(
    { duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [], purged: [],
      permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null }, finalFile, null)));
  S.DB.settings.me = '徐捷';
  S.rebuildIndex();
  const hc = S.healthCheck();
  const errs = (hc.issues || []).filter(i => i.level === 'error');
  console.log('  体检结果：' + (hc.issues || []).map(i => `${i.k}×${i.n}`).join('、'));
  ok('没有出现"无主里程碑 / 指向不存在工作的任务"这类同步造成的结构性损坏',
    !(hc.issues || []).some(i => ['orphanTask', 'orphanMs', 'msOfDeletedTask'].includes(i.k)),
    (hc.issues || []).filter(i => ['orphanTask', 'orphanMs', 'msOfDeletedTask'].includes(i.k)).map(i => i.k + '×' + i.n));
  ok('每一页都还能渲染', (() => {
    try { S.PAGES.forEach(p => { S.setPage(typeof p === 'string' ? p : p.key); S.renderPage(); }); return true; }
    catch (e) { console.log('    渲染异常：' + e.message); return false; }
  })());

  console.log('\n' + '='.repeat(56));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('仿真异常：', e); process.exit(1); });
