/* 第十一轮：墓碑生命周期的多设备长跑仿真。

   这一轮新引入的东西是"墓碑可以被撤销"——同一把钥匙上，时间最晚的那条说了算：
   普通墓碑 = 这条彻底删了；undone 声明 = 那块墓碑作废了。
   删 → 撤 → 再删 → 再撤 …… 可以来回好多轮，而且发生在【好几台时钟不同步的机器上】，
   中间还夹着写入竞争和长期离线。单元测试只能摆出几个固定形态，这类"来回切换 + 乱序传播"
   必须靠长跑才敢说没问题。

   判据（每一轮跑完都验）：
     1) 所有设备和共享文件对同一条记录的"死活"必须一致（不允许甲看得见、乙看不见）；
     2) 死活必须等于"这把钥匙上时间最晚那条条目"说的（这是整个机制唯一的规则）；
     3) 墓碑表里同一把钥匙只能有一条；
     4) 不许留下无主里程碑（所属任务已经彻底不在了，里程碑却还活着）；
     5) 被撤销之后还活着的记录，内容不能丢（标题/牵头人还在）。
   用法：ROUNDS=600 SEED=1 node scratchpad/sim10.js
*/
const REPO = 'C:/Users/Administrator/Documents/Claude/Todo';
const { sandbox: S } = require(REPO + '/test/harness.js');

const ROUNDS = Number(process.env.ROUNDS) || 600;
const SEED = Number(process.env.SEED) || 20260908;
const cp = o => JSON.parse(JSON.stringify(o));
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

let _s = SEED;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 900) : '')); }
};

/* ---------------- 共享文件 ---------------- */
function mkFile(p) { return { text: JSON.stringify(p), writes: 0 }; }
const fread = f => JSON.parse(f.text);
const fwrite = (f, p) => { f.text = JSON.stringify(p); f.writes++; };

/* ---------------- 设备 ---------------- */
function mkDevice(name, file, skewMin) {
  return {
    name, db: fread(file), base: S.buildSyncBase(fread(file)),
    skewMs: (skewMin || 0) * 60000, offline: false,
    lastWriteId: '', lastWriteIdAt: '', preWriteBase: null,
    undoStack: [],          // 这台机器自己那几次彻底删除的"删之前快照"
    purges: 0, revokes: 0,
  };
}
const nowOf = d => new Date(Date.now() + d.skewMs).toISOString();
function stamp(dev, r) {
  if (!r.created_at) r.created_at = nowOf(dev);
  r.updated_at = nowOf(dev); r.updated_by = dev.name; r.rev = (r.rev || 0) + 1;
  delete r.merged_from;
  return r;
}
const payloadOf = db => ({
  duties: db.duties, works: db.works, milestones: db.milestones, tasks: db.tasks,
  changelog: db.changelog, users: db.users, permissionMatrix: db.permissionMatrix,
  shareConfig: db.shareConfig, reportConfig: db.reportConfig || null,
  dashboardConfig: db.dashboardConfig || null, purged: db.purged || [],
});

/* ★ 墓碑相关一律借用 index.html 里那几个真函数 ★
   仿真里另抄一份逻辑等于测自己抄得对不对，没有意义。这里把沙盒 DB 临时借给这台设备用。 */
function withDev(dev, fn) {
  const sp = S.DB.purged, sm = S.DB.settings.me;
  S.DB.purged = dev.db.purged || [];
  S.DB.settings.me = dev.name;
  try { return fn(); } finally { dev.db.purged = S.DB.purged; S.DB.purged = sp; S.DB.settings.me = sm; }
}
const devRecordPurge = (dev, entity, id) => withDev(dev, () => S.recordPurge(entity, id));
const devRevokePurge = (dev, entity, id) => withDev(dev, () => S.revokePurge(entity, id));

/* ---------------- 同步（严格照 syncToFileInner） ---------------- */
function noteClobber(dev, remote) {
  const holder = { settings: { lastWriteId: dev.lastWriteId, lastWriteIdAt: dev.lastWriteIdAt }, syncBase: dev.base };
  S.setLastWriteId('');
  if (!S.detectClobberedWrite(remote, holder)) return;
  S.setPreWriteBase(dev.preWriteBase);
  if (dev.preWriteBase) { S.rollbackBaseForClobber(holder, remote); dev.base = holder.syncBase; }
  S.setPreWriteBase(null);
  dev.lastWriteId = ''; dev.lastWriteIdAt = ''; dev.preWriteBase = null;
}
function devSync(dev, file, override) {
  if (dev.offline) return 'offline';
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = (attempt === 0 && override) ? override : fread(file);
    noteClobber(dev, cur);
    const local = payloadOf(dev.db);
    const merged = S.normalizeMergedRecords(S.mergeSyncPayload(local, cur, dev.base));
    const fixed = S.reconcileDerivedAfterMerge(merged);
    Object.assign(dev.db, merged);
    if (!fixed && !S.hasLocalContribution(local, cur, dev.base)) { dev.base = S.buildSyncBase(cur); return 'skip'; }
    dev.base = S.buildSyncBase(cur);                 // P100：吸收了 cur，基线跟着推进
    const preBase = dev.base ? cp(dev.base) : null;
    const fresh = fread(file);
    if ((fresh.writeId || '') !== (cur.writeId || '')) continue;
    const wid = 'w_' + dev.name + '_' + (file.writes + 1);
    fwrite(file, Object.assign({}, merged, {
      writeId: wid, writeIds: S.buildWriteIdRing(cur, wid), lastWriteBy: dev.name, lastWriteAt: nowOf(dev) }));
    dev.base = S.buildSyncBase(merged);
    dev.lastWriteId = wid; dev.lastWriteIdAt = new Date().toISOString(); dev.preWriteBase = preBase;
    return 'write';
  }
  return 'giveup';
}
function devPull(dev, file) {
  if (dev.offline) return 'offline';
  const remote = fread(file);
  noteClobber(dev, remote);
  const merged = S.normalizeMergedRecords(S.mergeSyncPayload(payloadOf(dev.db), remote, dev.base));
  S.reconcileDerivedAfterMerge(merged);
  Object.assign(dev.db, merged);
  dev.base = S.buildSyncBase(remote);
  return 'pull';
}
// 写入竞争：甲先写完，乙拿着更早那份盖上去（写前确认挡不住的那一半）
function devRace(a, b, file) {
  const snap = fread(file);
  devSync(a, file, snap);
  noteClobber(b, snap);
  const local = payloadOf(b.db);
  const merged = S.normalizeMergedRecords(S.mergeSyncPayload(local, snap, b.base));
  S.reconcileDerivedAfterMerge(merged);
  Object.assign(b.db, merged);
  const preBase = b.base ? cp(b.base) : null;
  const wid = 'w_' + b.name + '_race' + (file.writes + 1);
  fwrite(file, Object.assign({}, merged, {
    writeId: wid, writeIds: S.buildWriteIdRing(snap, wid), lastWriteBy: b.name, lastWriteAt: nowOf(b) }));
  b.base = S.buildSyncBase(merged);
  b.lastWriteId = wid; b.lastWriteIdAt = new Date().toISOString(); b.preWriteBase = preBase;
}

/* ---------------- 设备上的操作 ---------------- */
const aliveTasks = db => db.tasks.filter(t => !t.deleted_at);
function opEdit(dev) {
  const list = aliveTasks(dev.db);
  if (!list.length) return;
  const t = pick(list);
  t.title = t.id + ' 由' + dev.name + '改于' + (dev.editN = (dev.editN || 0) + 1);
  stamp(dev, t);
}
// 彻底删除（照 cascadeRemoveHardTask：名下里程碑一起留墓碑）
function opPurge(dev) {
  const list = aliveTasks(dev.db);
  if (!list.length) return;
  const t = pick(list);
  const ms = dev.db.milestones.filter(m => m.task === t.id);
  dev.undoStack.push({ task: cp(t), ms: cp(ms) });          // 删之前的快照，撤销要用
  ms.forEach(m => {
    dev.db.milestones = dev.db.milestones.filter(x => x.id !== m.id);
    devRecordPurge(dev, 'milestone', m.id);
  });
  dev.db.tasks = dev.db.tasks.filter(x => x.id !== t.id);
  devRecordPurge(dev, 'task', t.id);
  dev.purges++;
}
// 撤销自己最近那次彻底删除（照 undoLast：记录塞回来 + 给自己那批墓碑留作废声明）
function opUndoPurge(dev) {
  const s = dev.undoStack.pop();
  if (!s) return;
  if (!dev.db.tasks.some(t => t.id === s.task.id)) dev.db.tasks.push(cp(s.task));
  s.ms.forEach(m => { if (!dev.db.milestones.some(x => x.id === m.id)) dev.db.milestones.push(cp(m)); });
  devRevokePurge(dev, 'task', s.task.id);
  s.ms.forEach(m => devRevokePurge(dev, 'milestone', m.id));
  dev.revokes++;
}

/* ---------------- 起始数据 ---------------- */
function seedFile() {
  const tasks = [], ms = [];
  for (let i = 0; i < 14; i++) {
    const id = 'T' + String(i).padStart(2, '0');
    tasks.push({ id, work: '', code: '', title: id + ' 初始', owner: '甲', assignees: [],
      status: 'todo', priority: '2', plan_date: '2026-10-01', progress: 0, actual_date: '',
      source: '', custom: '', rev: 1, created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z', updated_by: '甲' });
    ms.push({ id: 'M' + String(i).padStart(2, '0'), task: id, deliverable: '交付物' + i,
      plan_date: '2026-10-10', done: '0', level: '', actual_date: '', note: '',
      rev: 1, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', updated_by: '甲' });
  }
  return { duties: [], works: [], milestones: ms, tasks, changelog: [], users: [], purged: [],
    permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null,
    schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w_seed', writeIds: ['w_seed'] };
}

async function main() {
  await tick(80);
  const file = mkFile(seedFile());
  const devs = [mkDevice('甲', file, 0), mkDevice('乙', file, 7), mkDevice('丙', file, -11), mkDevice('丁', file, 3)];
  console.log(`设备 ${devs.length} 台，${ROUNDS} 轮，种子 ${SEED}\n`);

  for (let r = 0; r < ROUNDS; r++) {
    // 丁 会阶段性离线（长期不同步的旧页面），在 75% 处恢复
    devs[3].offline = r < ROUNDS * 0.75 && (r % 40) < 25;
    const d = pick(devs);
    const x = rnd();
    if (x < 0.22) opEdit(d);
    else if (x < 0.36) opPurge(d);
    else if (x < 0.48) opUndoPurge(d);
    else if (x < 0.56) devPull(d, file);
    else if (x < 0.60) { const a = pick(devs), b = pick(devs.filter(v => v !== a)); if (!a.offline && !b.offline) devRace(a, b, file); }
    else devSync(d, file);
  }

  /* 收敛：所有人反复同步，直到"整整一轮没有任何设备再写文件"为止。
     不能拍脑袋定个固定轮数——那样最后一轮末尾那台设备写的东西，前面的设备还没看到，
     会被误判成"设备之间不一致"（这一点第一版就踩了）。真正的收敛判据只有一个：不动了。 */
  devs.forEach(v => { v.offline = false; });
  let settleRounds = 0, settled = false;
  for (let i = 0; i < 60; i++) {
    settleRounds++;
    const acted = devs.map(v => devSync(v, file));
    if (acted.every(a => a === 'skip')) { settled = true; break; }
  }
  ok('★★系统会收敛（不会永远有人在改来改去）', settled, settleRounds);

  const F = fread(file);
  console.log(`跑完：写文件 ${file.writes} 次，彻底删除 ${devs.reduce((a, v) => a + v.purges, 0)} 次，`
    + `撤销 ${devs.reduce((a, v) => a + v.revokes, 0)} 次，最终任务 ${F.tasks.length} 条、`
    + `里程碑 ${F.milestones.length} 个、墓碑 ${F.purged.length} 条\n`);

  ok('确实跑出了足够多的删除和撤销（不然这次仿真什么都没验到）',
    devs.reduce((a, v) => a + v.purges, 0) >= 20 && devs.reduce((a, v) => a + v.revokes, 0) >= 10,
    devs.map(v => [v.name, v.purges, v.revokes]));

  // ① 墓碑表里同一把钥匙只能有一条
  const cnt = new Map();
  (F.purged || []).forEach(p => { const k = p.entity + ' ' + p.id; cnt.set(k, (cnt.get(k) || 0) + 1); });
  const dup = [...cnt.entries()].filter(([, n]) => n > 1);
  ok('★墓碑表里同一把钥匙只有一条（删/撤是"换掉"，不是并排堆）', dup.length === 0, dup);

  // ② 死活必须等于"这把钥匙上时间最晚那条"说的
  const alive = new Set(F.tasks.map(t => t.id));
  const wrong = [];
  (F.purged || []).forEach(p => {
    if (p.entity !== 'task') return;
    const shouldLive = !!p.undone;
    if (shouldLive !== alive.has(p.id)) wrong.push({ id: p.id, undone: !!p.undone, inFile: alive.has(p.id) });
  });
  ok('★★共享文件里每条记录的死活，都跟它那把钥匙上最后一条说的一致',
    wrong.length === 0, wrong.slice(0, 8));

  // ③ 所有设备跟共享文件看到的是同一份死活
  const diffs = [];
  devs.forEach(v => {
    const mine = new Set(v.db.tasks.map(t => t.id));
    F.tasks.forEach(t => { if (!mine.has(t.id)) diffs.push([v.name, t.id, '文件有本机没有']); });
    v.db.tasks.forEach(t => { if (!alive.has(t.id)) diffs.push([v.name, t.id, '本机有文件没有']); });
  });
  if (diffs.length) {
    const bad = diffs[0][1];
    console.log('DEBUG key=', bad);
    console.log('  file purged:', JSON.stringify((F.purged||[]).filter(p=>p.id===bad)));
    devs.forEach(v => {
      console.log('  ' + v.name + ' has=' + v.db.tasks.some(t=>t.id===bad)
        + ' purged=' + JSON.stringify((v.db.purged||[]).filter(p=>p.id===bad))
        + ' lastSync=' + devSync(v, file));
      console.log('    after re-sync has=' + v.db.tasks.some(t=>t.id===bad));
    });
    console.log('  file now has=', fread(file).tasks.some(t=>t.id===bad), JSON.stringify((fread(file).purged||[]).filter(p=>p.id===bad)));
  }
  ok('★★四台设备跟共享文件完全一致（不允许甲看得见、乙看不见）', diffs.length === 0, diffs.slice(0, 10));

  // ④ 不许留下无主里程碑
  const orphan = (F.milestones || []).filter(m => m.task && !alive.has(m.task));
  ok('★没有无主里程碑（所属任务已经彻底不在了、里程碑却还活着）',
    orphan.length === 0, orphan.map(m => m.id + '→' + m.task).slice(0, 8));

  // ⑤ 被撤销回来的记录，名下里程碑也要跟着回来
  const undoneTasks = (F.purged || []).filter(p => p.entity === 'task' && p.undone).map(p => p.id);
  const msByTask = new Map();
  (F.milestones || []).forEach(m => { if (!msByTask.has(m.task)) msByTask.set(m.task, []); msByTask.get(m.task).push(m); });
  const lost = undoneTasks.filter(id => alive.has(id) && !(msByTask.get(id) || []).length);
  ok('★撤销回来的任务，名下里程碑也一起回来了', lost.length === 0, lost.slice(0, 8));

  // ⑥ 内容没被撤销机制搞坏
  const broken = F.tasks.filter(t => !t.id || !t.title || !Array.isArray(t.assignees));
  ok('★记录内容完好（不是塞回来一具空壳）', broken.length === 0, broken.slice(0, 3).map(t => t.id));

  // ⑦ 一条从来没被撤销过的墓碑，绝不能让记录复活
  const neverUndone = (F.purged || []).filter(p => p.entity === 'task' && !p.undone).map(p => p.id);
  ok('★没被撤销过的彻底删除，一条都没复活',
    !neverUndone.some(id => alive.has(id)), neverUndone.filter(id => alive.has(id)).slice(0, 8));

  // ⑧ 再多同步几轮不会翻来覆去（收敛性）
  const before = JSON.stringify(F.tasks.map(t => t.id).sort());
  for (let i = 0; i < 6; i++) devs.forEach(v => devSync(v, file));
  ok('★★再同步几轮，名单不再变（不会出现删了又活、活了又删的来回打架）',
    JSON.stringify(fread(file).tasks.map(t => t.id).sort()) === before,
    [before.slice(0, 200), JSON.stringify(fread(file).tasks.map(t => t.id).sort()).slice(0, 200)]);

  // ⑨ 页面还渲染得出来
  Object.assign(S.DB, { duties: F.duties, works: F.works, milestones: F.milestones, tasks: F.tasks,
    changelog: F.changelog, purged: F.purged });
  S.rebuildIndex();
  let crash = '';
  try { ['tasks', 'charts', 'data'].forEach(p => { S.setPage(p); S.renderPage(); }); S.renderDashboard(); }
  catch (e) { crash = e.message; }
  ok('★收敛之后每一页都还渲染得出来', !crash, crash);

  console.log('\n' + '='.repeat(56));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('仿真异常：', e); process.exit(1); });
