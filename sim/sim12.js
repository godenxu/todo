/* 第十二轮：界面动作级模糊测试。

   sim8/9/10 都是"直接调同步层的函数"，能覆盖合并算法，但覆盖不到
   【真实动作 → 落盘 → 合并】这一整条链上的接线问题。
   sim11 把动作一个个点了一遍，但顺序是我排的，覆盖不到"某两个动作连着做才出问题"。

   这里让机器自己随机点：从一池会改数据的真实界面动作里随机抽，随机挑目标记录，
   中间随机插入"同事那台机器写了一次共享文件"和"我这边同步一次"，
   每一步做完都验一遍不变量。任何一条不变量破了就停下来把动作序列打出来。

   验的不变量：
     ① 索引和数组对得上（byId 查得到、主键不重复）
     ② 活着的里程碑，它的任务必须存在
     ③ 已删除任务名下不该有活着的里程碑
     ④ 每条记录的 rev 只能涨不能退（退了就是被旧内容盖过）
     ⑤ 每一页都渲染得出来
     ⑥ 收敛之后：本机 == 共享文件
   用法：ROUNDS=400 SEED=1 node scratchpad/sim12.js
*/
const REPO = 'C:/Users/Administrator/Documents/Claude/Todo';
const { sandbox: S, q } = require(REPO + '/test/harness.js');
const tick = (ms = 12) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

const ROUNDS = Number(process.env.ROUNDS) || 400;
const SEED = Number(process.env.SEED) || 20260909;
let _s = SEED;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 800) : '')); }
};

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });

function mkHandle(text) {
  const h = {
    name: 'shared.json', _text: text, _mtime: 1000, _writes: 0,
    async getFile() { const snap = h._text; return { lastModified: h._mtime, text: async () => snap }; },
    async createWritable() {
      return { async write(t) { h._pending = t; }, async close() { h._writes++; h._text = h._pending; h._mtime += 1; } };
    },
  };
  return h;
}
const fileOf = h => JSON.parse(h._text);

/* ---------------- 起始数据 ----------------
   PROD=<路径> 时改用真实生产数据（只读，绝不回写）。合成数据是我按自己的想象造的，
   形状太干净；真实数据里有历史遗留的重复编号、挂在已停用工作下的任务、
   早年缺字段的记录——这些正是最容易把同步逻辑绊倒的东西。 */
function seedFromProd(p) {
  const d = JSON.parse(require('fs').readFileSync(p, 'utf8'));
  S.DB.duties = d.duties || []; S.DB.works = d.works || [];
  S.DB.milestones = d.milestones || []; S.DB.tasks = d.tasks || [];
  S.DB.changelog = d.changelog || []; S.DB.purged = d.purged || [];
  S.DB.users = d.users || [];
  S.DB.permissionMatrix = d.permissionMatrix || null;
  S.DB.shareConfig = d.shareConfig || null;
  S.DB.reportConfig = d.reportConfig || null;
  S.DB.dashboardConfig = d.dashboardConfig || null;
  ['duty', 'work', 'milestone', 'task'].forEach(e => S.coll(e).forEach(r => S.normalize(e, r)));
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.undoStack.length = 0;
  S.setSnackPriorityUntil(0);
  S.DB.settings.me = (S.DB.users.find(u => u.role === 'admin') || { name: '测试管理员' }).name;
  if (!S.DB.users.some(u => u.name === S.DB.settings.me)) {
    S.DB.users.push({ name: S.DB.settings.me, role: 'admin', salt: '', hash: '', iterations: 0,
      created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', updated_by: 'x', rev: 1 });
  }
  S.rebuildIndex();
}
function seed() {
  if (process.env.PROD) { seedFromProd(process.env.PROD); return; }
  S.DB.duties = []; S.DB.works = []; S.DB.milestones = []; S.DB.tasks = [];
  S.DB.changelog = []; S.DB.purged = [];
  S.DB.permissionMatrix = null; S.DB.reportConfig = null; S.DB.dashboardConfig = null; S.DB.shareConfig = null;
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.undoStack.length = 0;
  S.setSnackPriorityUntil(0);
  for (let d = 1; d <= 3; d++) {
    S.DB.duties.push(S.stampMeta(S.blank('duty', { code: '0' + d, category: '分类' + d, name: '职责' + d })));
    for (let w = 1; w <= 2; w++) {
      const wid = 'w_0' + d + '0' + w;
      S.DB.works.push(S.stampMeta(S.blank('work', {
        id: wid, code: '0' + d + '0' + w, duty: '0' + d, name: `工作${d}-${w}`, owner: '测试管理员', year: 2026 })));
      for (let t = 1; t <= 3; t++) {
        const tid = 'T' + d + w + t;
        S.DB.tasks.push(S.stampMeta(S.blank('task', {
          id: tid, work: wid, code: '0' + d + '0' + w + '26' + t, title: `任务${tid}`,
          owner: '测试管理员', status: 'todo', plan_date: '2026-10-1' + t, priority: '2' })));
        S.DB.milestones.push(S.stampMeta(S.blank('milestone', {
          id: 'M' + tid, task: tid, deliverable: '交付物' + tid, plan_date: '2026-10-2' + t })));
      }
    }
  }
  S.DB.users = [
    { name: '测试管理员', role: 'admin', salt: '', hash: '', iterations: 0, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', updated_by: '测试管理员', rev: 1 },
    { name: '同事乙', role: 'staff', salt: '', hash: '', iterations: 0, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', updated_by: '测试管理员', rev: 1 },
  ];
  S.DB.settings.me = '测试管理员';
  S.rebuildIndex();
}

async function confirmIfAny() {
  for (let i = 0; i < 3; i++) {
    if (!q('#modal-overlay').classList.contains('show')) break;
    const cb = S.modalCallback;
    if (typeof cb !== 'function') break;
    await cb();
    await tick(8);
  }
  if (q('#modal-overlay').classList.contains('show')) S.closeModal();
}

const aliveTasks = () => S.DB.tasks.filter(t => !t.deleted_at);
const anyTask = () => { const l = aliveTasks(); return l.length ? pick(l) : null; };
const anyDeadTask = () => { const l = S.DB.tasks.filter(t => t.deleted_at); return l.length ? pick(l) : null; };
const anyWork = () => { const l = S.DB.works.filter(w => !w.deleted_at); return l.length ? pick(l) : null; };
const anyMs = () => { const l = S.DB.milestones.filter(m => !m.deleted_at); return l.length ? pick(l) : null; };

/* ---------------- 动作池 ---------------- */
const OPS = [
  ['改状态', async () => { const t = anyTask(); if (!t) return; S.ACTIONS['edit']({ entity: 'task', id: t.id, field: 'status' }, q('#x')); await tick(6); await S.spCommitSingle(pick(['todo', 'doing', 'done', 'hold'])); }],
  ['改优先级', async () => { const t = anyTask(); if (!t) return; S.ACTIONS['edit']({ entity: 'task', id: t.id, field: 'priority' }, q('#x')); await tick(6); await S.spCommitSingle(pick(['1', '2', '3'])); }],
  ['改计划日期', async () => { const t = anyTask(); if (!t) return; S.ACTIONS['edit']({ entity: 'task', id: t.id, field: 'plan_date' }, q('#x')); await tick(6); await S.dpCommit('2026-1' + (1 + Math.floor(rnd() * 2)) + '-0' + (1 + Math.floor(rnd() * 8))); }],
  ['改牵头人', async () => { const t = anyTask(); if (!t) return; S.ACTIONS['edit']({ entity: 'task', id: t.id, field: 'owner' }, q('#x')); await tick(6); await S.spCommitSingle(pick(['测试管理员', '同事乙'])); }],
  ['删任务', async () => { const t = anyTask(); if (!t) return; S.ACTIONS['task-del']({ id: t.id }); await confirmIfAny(); }],
  ['恢复任务', async () => { const t = anyDeadTask(); if (!t) return; await S.ACTIONS['task-restore']({ id: t.id }); }],
  ['彻底删任务', async () => { const t = anyTask(); if (!t) return; S.ACTIONS['task-purge']({ id: t.id }); await confirmIfAny(); }],
  ['撤销', async () => { await S.ACTIONS['undo'](); }],
  ['停用工作', async () => { const w = anyWork(); if (!w) return; S.ACTIONS['work-del']({ id: w.id }); await confirmIfAny(); }],
  ['恢复工作', async () => { const l = S.DB.works.filter(w => w.deleted_at); if (!l.length) return; await S.ACTIONS['work-restore']({ id: pick(l).id }); }],
  ['里程碑标完成', async () => { const m = anyMs(); if (!m) return; S.ACTIONS['edit']({ entity: 'milestone', id: m.id, field: 'done' }, q('#x')); await tick(6); await S.spCommitSingle(pick(['0', '1'])); }],
  ['改回收站保留期', async () => { const el = q('#recycle-keep'); el.value = String(30 + Math.floor(rnd() * 200)); await S.ACTIONS['recycle-keep-change'](null, el); }],
  ['改备份间隔', async () => { const el = q('#bk-hours'); el.value = String(1 + Math.floor(rnd() * 48)); await S.ACTIONS['backup-interval-change'](null, el); }],
  ['改权限矩阵', async () => { const el = q('#perm-x'); el.checked = rnd() < 0.5; await S.ACTIONS['perm-toggle']({ role: 'staff', key: pick(['bulk_ops', 'view_logs', 'view_data']) }, el); }],
  ['改工作台编排', async () => { S.ACTIONS['dash-sec-add'](); await tick(6); const inp = q('#prompt-input'); if (inp) inp.value = '区域' + Math.floor(rnd() * 1000); await confirmIfAny(); }],
  ['改报告编排', async () => { S.ACTIONS['report-sec-add'](); await tick(6); const inp = q('#prompt-input'); if (inp) inp.value = '区域' + Math.floor(rnd() * 1000); await confirmIfAny(); }],
  ['体检修复', async () => { await S.ACTIONS['health-fix']({ k: pick(['progressMismatch', 'orphanTask', 'taskOfDeletedWork']) }); await confirmIfAny(); }],
];

/* 同事那台机器：直接在共享文件上改一条，模拟"别人推了一版上来" */
function colleagueWrite(h) {
  const F = fileOf(h);
  const alive = (F.tasks || []).filter(t => !t.deleted_at);
  if (!alive.length) return;
  const t = alive[Math.floor(rnd() * alive.length)];
  const field = pick(['title', 'status', 'owner', 'priority']);
  t[field] = field === 'title' ? (t.title + '·乙') : pick(field === 'status' ? ['todo', 'doing', 'done'] : field === 'owner' ? ['同事乙', '测试管理员'] : ['1', '2', '3']);
  t.rev = (t.rev || 0) + 1;
  t.updated_at = new Date(Date.now() + 60000).toISOString();   // 同事那台表快一分钟
  t.updated_by = '同事乙';
  F.writeId = 'w_乙_' + h._writes;
  F.writeIds = (F.writeIds || []).concat(F.writeId).slice(-200);
  F.lastWriteBy = '同事乙'; F.lastWriteAt = t.updated_at;
  h._text = JSON.stringify(F); h._mtime += 1; h._writes++;
}

/* ---------------- 不变量 ---------------- */
function invariants(where) {
  const bad = [];
  [['duty', 'code', 'duties'], ['work', 'id', 'works'], ['milestone', 'id', 'milestones'], ['task', 'id', 'tasks']].forEach(([e, pk, k]) => {
    const seen = new Set();
    (S.DB[k] || []).forEach(r => {
      if (!r || r[pk] == null) { bad.push(k + ' 有没有主键的记录'); return; }
      if (seen.has(r[pk])) bad.push(k + ' 主键重复：' + r[pk]);
      seen.add(r[pk]);
      if (S.byId(e, r[pk]) !== r) bad.push(k + ' ' + r[pk] + ' 索引跟数组对不上');
    });
  });
  const taskById = new Map(S.DB.tasks.map(t => [t.id, t]));
  S.DB.milestones.forEach(m => {
    if (m.deleted_at) return;
    const t = taskById.get(m.task);
    if (m.task && !t) bad.push('无主里程碑 ' + m.id + '→' + m.task);
    else if (t && t.deleted_at) bad.push('任务已删除但里程碑还活着 ' + m.id + '→' + m.task);
  });
  return bad.length ? (where + '：' + bad.slice(0, 4).join('；')) : '';
}
// rev 只能涨不能退
const revSnap = () => {
  const m = new Map();
  [['duties', 'code'], ['works', 'id'], ['milestones', 'id'], ['tasks', 'id']].forEach(([k, pk]) =>
    (S.DB[k] || []).forEach(r => m.set(k + ' ' + r[pk], r.rev || 0)));
  return m;
};
function revRegress(prev) {
  const now = revSnap();
  for (const [k, v] of now) { const p = prev.get(k); if (p !== undefined && v < p) return k + ' rev ' + p + '→' + v; }
  return '';
}

const LISTS = [['duty', 'code', 'duties'], ['work', 'id', 'works'], ['milestone', 'id', 'milestones'], ['task', 'id', 'tasks'], ['user', 'name', 'users']];
function diffDbVsFile(F) {
  const out = [];
  LISTS.forEach(([e, pk, k]) => {
    const fm = new Map((F[k] || []).map(r => [r[pk], r]));
    (S.DB[k] || []).forEach(r => {
      const o = fm.get(r[pk]);
      if (!o) { out.push(k + ' ' + r[pk] + '：文件里没有'); return; }
      if (JSON.stringify(r) !== JSON.stringify(o)) out.push(k + ' ' + r[pk] + '：内容不一致');
    });
    (F[k] || []).forEach(r => { if (!(S.DB[k] || []).some(x => x[pk] === r[pk])) out.push(k + ' ' + r[pk] + '：本机没有'); });
  });
  ['permissionMatrix', 'shareConfig', 'reportConfig', 'dashboardConfig'].forEach(k => {
    if (JSON.stringify(S.DB[k] || null) !== JSON.stringify(F[k] || null)) out.push(k + '：不一致');
  });
  return out;
}

async function main() {
  await tick(120);
  seed();
  const h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
    writeId: 'w_seed', writeIds: ['w_seed'] })));
  S.setFileHandle(h);
  S.setEverConnected(true);
  await S.Repo.persist(S.DB);
  await tick(20);
  console.log(`起始：任务 ${S.DB.tasks.length} 条、里程碑 ${S.DB.milestones.length} 个；${ROUNDS} 轮，种子 ${SEED}\n`);

  const trail = [];
  let firstBad = '', firstRev = '', firstCrash = '';
  for (let r = 0; r < ROUNDS; r++) {
    const before = revSnap();
    const x = rnd();
    let label;
    if (x < 0.12) { label = '同事写一版'; colleagueWrite(h); }
    else if (x < 0.20) { label = '拉取一次'; await S.pullFromFile(); }
    else {
      const [n, fn] = pick(OPS);
      label = n;
      try { await fn(); await confirmIfAny(); } catch (e) { if (!firstCrash) firstCrash = n + '：' + e.message; }
    }
    await tick(10);
    trail.push(label);
    if (trail.length > 12) trail.shift();

    if (!firstBad) { const b = invariants('第' + r + '轮（' + label + '）'); if (b) firstBad = b + ' | 最近动作：' + trail.join(' → '); }
    if (!firstRev && x >= 0.12) { const g = revRegress(before); if (g) firstRev = '第' + r + '轮（' + label + '）' + g + ' | 最近动作：' + trail.join(' → '); }
    if (r % 40 === 0) {
      try { ['tasks', 'works', 'charts', 'data'].forEach(p => { S.setPage(p); S.renderPage(); }); S.renderDashboard(); }
      catch (e) { if (!firstCrash) firstCrash = '第' + r + '轮渲染：' + e.message; }
    }
  }

  ok('★动作序列没有把不变量跑坏（索引/主键/无主里程碑）', !firstBad, firstBad);
  ok('★没有记录的 rev 倒退（倒退 = 被旧内容盖过）', !firstRev, firstRev);
  ok('★整个过程没有抛异常 / 渲染没崩', !firstCrash, firstCrash);

  // 收敛
  let settled = false;
  for (let i = 0; i < 30; i++) {
    const res = await S.syncToFile(S.DB);
    await tick(10);
    if (res === 'nochange') { settled = true; break; }
  }
  ok('★系统会收敛（不会一直有东西要推）', settled);
  const F = fileOf(h);
  const d = diffDbVsFile(F);
  ok('★★收敛之后本机与共享文件完全一致', d.length === 0, d.slice(0, 5));
  ok('★没有"改动还没同步出去"的积压', !S.DB.settings.pendingSync);
  const fin = invariants('收敛后');
  ok('★收敛之后不变量仍然成立', !fin, fin);
  console.log(`\n共享文件写了 ${h._writes} 次，最终任务 ${F.tasks.length} 条、里程碑 ${F.milestones.length} 个、墓碑 ${(F.purged || []).length} 条`);

  /* ================================================================
     ★★ 第二段：严格模式 —— 系统在这里没有任何借口 ★★

     上面那段是乱序并发，真出现"两个人同时改同一个字段"时，系统只能按时间戳定胜负，
     所以不能拿"最后改的人一定赢"去要求它。这一段把并发拿掉：
       · 我每改一次，立刻同步推上去；
       · 同事每写一次，写的都是我推完之后的那一版。
     于是每一个字段都有明确的"最后是谁改的、改成了什么"，不存在任何真冲突。
     这种情况下【最后那次改动必须原样活到最后】——活不下来就是实实在在写丢了，
     正是同事反映的"我改的东西过一阵又变回去了"。 */
  console.log('\n■ 严格模式：真并发，但两个人碰的字段互不重叠 —— 一条改动都不许丢');
  seed();
  h._text = JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w_s', writeIds: ['w_s'] }));
  S.clearSyncBaseline(S.DB);
  await S.Repo.persist(S.DB);
  await tick(15);

  /* ★ 为什么要"字段互不重叠" ★
     只要两个人真的同时改了同一个字段，系统就只能按时间戳定胜负（时钟还不同步），
     那时候"最后改的人一定赢"本来就不成立，拿它当判据只会得到一堆假失败。
     把字段分成两半——我只碰状态/优先级，同事只碰牵头人/计划日期——之后：
       · 并发是真的（两边可以在完全不同的版本上各改各的、乱序推）；
       · 但任何一个字段都只有一个人在动，于是"这个字段最后那次改动必须活下来"
         成了一条【系统必须无条件满足】的硬要求。
     这正是三方合并存在的意义（"甲没碰过的状态根本不参与竞争"），
     所以这一段是直接冲着那句承诺去的：丢一条就是它没做到。 */
  let races = 0;
  const oracle = new Map();     // 'id|field' → { who, val }
  const MY_FIELDS = ['status', 'priority'];
  const THEIR_FIELDS = ['owner', 'plan_date'];
  const FIELDS = MY_FIELDS.concat(THEIR_FIELDS);
  const setLocal = async (t, f, v) => {
    S.ACTIONS['edit']({ entity: 'task', id: t.id, field: f }, q('#x'));
    await tick(6);
    if (f === 'plan_date') await S.dpCommit(v); else await S.spCommitSingle(v);
    // 改成"已完成"时程序会弹一个"要不要顺带补日期/勾完里程碑"的确认框，得替用户点掉，
    // 不点的话这次改动根本没落地——那是用例没点，不是程序丢了
    await confirmIfAny();
    await tick(8);
    const now = S.byId('task', t.id);
    if (!now || String(now[f] == null ? '' : now[f]) !== String(v)) return;   // 这次改动没真正落地，不记进对账表
    oracle.set(t.id + '|' + f, { who: '我', val: v });
  };
  const setRemote = (id, f, v) => {
    const F = fileOf(h);
    const t = (F.tasks || []).find(x => x.id === id);
    if (!t) return false;
    t[f] = v;
    t.rev = (t.rev || 0) + 1;
    t.updated_at = new Date(Date.now() + 60000).toISOString();
    t.updated_by = '同事乙';
    F.writeId = 'w_乙s_' + h._writes;
    F.writeIds = (F.writeIds || []).concat(F.writeId).slice(-200);
    F.lastWriteBy = '同事乙'; F.lastWriteAt = t.updated_at;
    h._text = JSON.stringify(F); h._mtime += 1; h._writes++;
    oracle.set(id + '|' + f, { who: '乙', val: v });
    return true;
  };
  const VALS = { status: ['todo', 'doing', 'done', 'hold'], priority: ['1', '2', '3'],
    owner: ['测试管理员', '同事乙'], plan_date: ['2026-10-01', '2026-11-02', '2026-12-03'] };

  /* ★ 必须制造"真正的分叉"，否则这一段什么都测不到 ★
     第一版是"我改一条就立刻同步一次"，结果本机和文件永远是同一份，
     合并算法根本没被用上——把三方合并整个拆掉，这一段照样全绿（变异测试当场戳穿）。
     所以改成模拟处里最常见的那个形态：
       断开 / 网盘挂了一阵 → 我在本机连着改好几条 → 这期间同事那边也推了好几版
       → 我重新连上，一次性推 → 这一刻才是三方合并真正干活的时候。 */
  for (let phase = 0; phase < 60; phase++) {
    // ① 离线期：我本机连着改若干条（改动全部积压，进不了文件）
    S.setFileHandle(null);
    const myN = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < myN; i++) {
      const t = anyTask(); if (!t) break;
      const f = pick(MY_FIELDS);
      await setLocal(t, f, pick(VALS[f]));
    }
    // ② 同一段时间里，同事在共享文件上推了若干版
    const theirN = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < theirN; i++) {
      const F = fileOf(h);
      const alive = (F.tasks || []).filter(t => !t.deleted_at);
      if (!alive.length) break;
      const t = alive[Math.floor(rnd() * alive.length)];
      const f = pick(THEIR_FIELDS);
      setRemote(t.id, f, pick(VALS[f]));
    }
    // ③ 我重新连上：这一步才是三方合并真正要干活的时刻
    S.setFileHandle(h);
    if (rnd() < 0.35) { await S.pullFromFile(); await tick(8); }   // 有时先只读拉一次再推

    /* ④ 偶尔制造一次"写入竞争"：同事手里拿的是我这次写【之前】那一版，
       等我写完之后他才落盘，于是我刚推上去的东西被一份过期内容整个盖掉。
       写后校验挡不住这一半（见 index.html 里 detectClobberedWrite 那段），
       程序对此的承诺是：靠写入链事后发现 + 把基线回滚 + 下一轮自动补推。
       所以这里照样要求"我那次改动最后必须还在"——补不回来就是那套机制没兑现承诺。 */
    const raceThisPhase = rnd() < 0.3;
    const beforeMyWrite = raceThisPhase ? h._text : null;
    await S.Repo.persist(S.DB);
    await tick(10);
    if (raceThisPhase && beforeMyWrite && h._text !== beforeMyWrite) {
      const stale = JSON.parse(beforeMyWrite);
      const alive = (stale.tasks || []).filter(t => !t.deleted_at);
      if (alive.length) {
        const t = alive[Math.floor(rnd() * alive.length)];
        const f = pick(THEIR_FIELDS);
        const v = pick(VALS[f]);
        t[f] = v; t.rev = (t.rev || 0) + 1;
        t.updated_at = new Date(Date.now() + 60000).toISOString();
        t.updated_by = '同事乙';
        stale.writeId = 'w_乙race_' + h._writes;
        stale.writeIds = (stale.writeIds || []).concat(stale.writeId).slice(-200);
        stale.lastWriteBy = '同事乙'; stale.lastWriteAt = t.updated_at;
        h._text = JSON.stringify(stale); h._mtime += 1; h._writes++;
        oracle.set(t.id + '|' + f, { who: '乙', val: v });
        races++;
      }
    }
    // 竞争之后再给几次同步机会——"下一轮自动补推"本来就是这套机制的一部分
    for (let k = 0; k < 3; k++) { const r2 = await S.syncToFile(S.DB); await tick(8); if (r2 === 'nochange') break; }
  }
  for (let i = 0; i < 10; i++) { const r = await S.syncToFile(S.DB); await tick(8); if (r === 'nochange') break; }

  {
    const F = fileOf(h);
    const byIdF = new Map((F.tasks || []).map(t => [t.id, t]));
    const lost = [];
    oracle.forEach((v, k) => {
      const [id, f] = k.split('|');
      const t = byIdF.get(id);
      if (!t || t.deleted_at) return;                 // 记录被删了，不参与对账
      if (String(t[f] == null ? '' : t[f]) !== String(v.val)) lost.push(`${id}.${f} 最后是${v.who}改成 ${v.val}，文件里却是 ${t[f]}`);
    });
    ok('★★★ 两人碰的字段不重叠时，每一个字段最后那次改动都原样活到了最后（共对账 ' + oracle.size + ' 个字段）',
      lost.length === 0, lost.slice(0, 6));
    ok('★确实造出了足够多的写入竞争（否则这段等于没测）', races >= 5, races);
    const dd = diffDbVsFile(F);
    ok('★严格模式结束后本机与共享文件也完全一致', dd.length === 0, dd.slice(0, 5));
  }

  console.log('\n' + '='.repeat(56));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('异常：', e); process.exit(1); });
