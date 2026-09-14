/* 第二十轮（P112）新切法：把 sim13 那套代数性质，搬到【里程碑】上重跑一遍。

   为什么要单独一支：sim13 只动任务的五个字段，从头到尾一条里程碑都不碰。
   而 P111 刚刚给里程碑补了逐字段变更记录，并且顺带让它进入了「本机独有改动」的证据表
   （无基线合并靠这份证据判谁该赢）——也就是说，里程碑的同步行为在那一轮发生了实质变化，
   却从来没有被任何多设备模拟器验证过。这正是"改了一处、影响别处"最容易漏掉的地方。

   在 sim13 的四条性质之外，里程碑还有两条自己的不变量，都是刚修过的地方：
   性质五：【交付日期不许被合并弄丢】
     done 从 1 改回 0 时 actual_date 要留着（P111），那么并发合并之后，
     任何一台设备上都不该出现"本来有交付日期、合并完没了"。
   性质六：【done 和 actual_date 不许合并成自相矛盾】
     这两个是各自独立的字段，字段级合并可能把它们判给不同的人。
     一旦出现 done='1' 却没有 actual_date，这条交付物会在报表"本期已交付"里彻底消失——
     数据看着没坏，报表却少一条，是最难查的那种。

   用法：ROUNDS=200 SEED=1 node sim/sim14.js */
const path = require('path');
const { sandbox: S, q } = require(path.join('C:/Users/Administrator/Documents/Claude/Todo/test/harness.js'));
const tick = (ms = 12) => new Promise(r => setTimeout(r, ms));
const ROUNDS = Number(process.env.ROUNDS || 200);
const SEED = Number(process.env.SEED || 1);
let _s = SEED >>> 0;
const rnd = () => ((_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = a => a[Math.floor(rnd() * a.length)];

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 600) : '')); } };

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
let FILE = null;
const handle = {
  name: 'shared.json', _mtime: 1,
  async getFile() { const s = FILE; return { lastModified: handle._mtime, text: async () => s }; },
  async createWritable() { return { async write(t) { handle._p = t; }, async close() { FILE = handle._p; handle._mtime++; } }; },
};

const DEV_KEYS = ['duties', 'works', 'milestones', 'tasks', 'changelog', 'users', 'purged',
  'permissionMatrix', 'shareConfig', 'reportConfig', 'dashboardConfig', 'syncBase'];
function snapshotDev() {
  const o = {};
  DEV_KEYS.forEach(k => { o[k] = JSON.parse(JSON.stringify(S.DB[k] === undefined ? null : S.DB[k])); });
  o.settings = JSON.parse(JSON.stringify(S.DB.settings));
  o.lastWriteId = S.lastWriteId;
  o.preWriteBase = S.preWriteBase ? JSON.parse(JSON.stringify(S.preWriteBase)) : null;
  return o;
}
function restoreDev(o) {
  DEV_KEYS.forEach(k => { S.DB[k] = JSON.parse(JSON.stringify(o[k])); });
  S.DB.settings = JSON.parse(JSON.stringify(o.settings));
  S.setLastWriteId(o.lastWriteId || '');
  S.setPreWriteBase(o.preWriteBase ? JSON.parse(JSON.stringify(o.preWriteBase)) : null);
  S.rebuildIndex();
}

const MSS = ['M1', 'M2', 'M3'];
const FIELDS = ['plan_date', 'deliverable', 'report_level'];
const INIT = { plan_date: '2026-09-20', deliverable: '初始交付物', report_level: 'section' };
const VALS = {
  plan_date: i => '2026-' + String((i % 12) + 1).padStart(2, '0') + '-1' + String(i % 9),
  deliverable: i => '交付物' + i,
  report_level: i => ['section', 'department', 'bank'][i % 3],
};

function seedWorld() {
  S.DB.settings.me = '设备1';
  S.DB.users = [{ name: '设备1', role: 'admin', salt: '', hash: '', iterations: 0,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '设备1', rev: 1 }];
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    owner: '设备1', year: 2026, status: 'doing' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261', title: '任务一',
    owner: '设备1', status: 'doing', priority: '2', plan_date: '2026-12-31', progress: 0 }))];
  // 三条里程碑，其中 M1 一开始就是"已交付"，用来盯住交付日期在并发里会不会丢
  S.DB.milestones = MSS.map((id, i) => S.stampMeta(S.blank('milestone', Object.assign({
    id, task: 'T1' }, INIT, i === 0 ? { done: '1', actual_date: '2026-08-05' } : { done: '0', actual_date: '' }))));
  S.DB.changelog = []; S.DB.purged = [];
  S.DB.permissionMatrix = null; S.DB.reportConfig = null; S.DB.dashboardConfig = null; S.DB.shareConfig = null;
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.setSnackPriorityUntil(0);
  S.rebuildIndex();
  FILE = JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'] }));
  S.setFileHandle(handle); S.setEverConnected(true);
}
// 走真实编辑路径：改一个字段 + 写逐字段日志（P111 补的那套）+ 盖戳
function editMs(msId, field, val) {
  const m = S.byId('milestone', msId); if (!m) return;
  const before = JSON.parse(JSON.stringify(m));
  m[field] = val;
  S.logRecordChange('milestone', msId, before, m, [field]);
  S.stampMeta(m);
}
/* 勾 / 取消勾选，走跟任务详情保存一致的规则：
   勾上时空日期才填今天；取消勾选【不清 actual_date】（P111） */
function toggleDone(msId, done) {
  const m = S.byId('milestone', msId); if (!m) return;
  const before = JSON.parse(JSON.stringify(m));
  m.done = done ? '1' : '0';
  m.actual_date = done ? (m.actual_date || S.todayStr()) : m.actual_date;
  S.logRecordChange('milestone', msId, before, m, ['done', 'actual_date']);
  S.stampMeta(m);
}
const fileMss = () => (JSON.parse(FILE).milestones || []);
const fileMs = id => fileMss().find(x => x.id === id) || {};

async function main() {
  await tick(150);
  console.log(`sim14：里程碑并发编辑的代数性质（ROUNDS=${ROUNDS} SEED=${SEED}）`);

  /* ───────── 性质一：串行写入不许丢 ───────── */
  console.log('\n■ 性质一：每次改完立刻同步到底，最后每个字段都必须等于"最后那次写"');
  {
    seedWorld();
    const devs = [snapshotDev(), snapshotDev(), snapshotDev()];
    devs.forEach((d, i) => { d.settings.me = '设备' + (i + 1); });
    for (let i = 0; i < devs.length; i++) {
      restoreDev(devs[i]); await S.Repo.persist(S.DB); await tick(15); devs[i] = snapshotDev();
    }
    const truth = {};
    for (let n = 1; n <= ROUNDS; n++) {
      const di = Math.floor(rnd() * devs.length);
      const ms = pick(MSS), field = pick(FIELDS), val = VALS[field](n);
      restoreDev(devs[di]);
      await S.pullFromFile(); await tick(10);
      editMs(ms, field, val);
      await S.Repo.persist(S.DB); await tick(12);
      devs[di] = snapshotDev();
      truth[ms + '|' + field] = val;
    }
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < devs.length; i++) {
        restoreDev(devs[i]); await S.pullFromFile(); await tick(10);
        await S.Repo.persist(S.DB); await tick(10); devs[i] = snapshotDev();
      }
    }
    const lost = [];
    Object.keys(truth).forEach(k => {
      const [ms, field] = k.split('|');
      if (String(fileMs(ms)[field]) !== String(truth[k])) {
        lost.push(`${ms}.${field} 期望 ${JSON.stringify(truth[k])} 实际 ${JSON.stringify(fileMs(ms)[field])}`);
      }
    });
    ok(`★★★串行写入一个都没丢（共对账 ${Object.keys(truth).length} 个字段、${ROUNDS} 次写入）`,
      lost.length === 0, lost.slice(0, 8));
    const diffDev = [];
    devs.forEach((d, i) => {
      restoreDev(d);
      MSS.forEach(m => FIELDS.forEach(f => {
        if (String((S.byId('milestone', m) || {})[f]) !== String(fileMs(m)[f])) diffDev.push(`设备${i + 1} ${m}.${f}`);
      }));
    });
    ok('★★所有设备跟共享文件完全一致', diffDev.length === 0, diffDev.slice(0, 8));
  }

  /* ───────── 性质二/三/五/六：随机交错 ───────── */
  console.log('\n■ 性质二/三：随机交错（含勾选/取消勾选）之后必须收敛，且不出现没人写过的值');
  {
    seedWorld();
    const devs = [snapshotDev(), snapshotDev(), snapshotDev()];
    devs.forEach((d, i) => { d.settings.me = '设备' + (i + 1); });
    for (let i = 0; i < devs.length; i++) {
      restoreDev(devs[i]); await S.Repo.persist(S.DB); await tick(15); devs[i] = snapshotDev();
    }
    const written = {};
    MSS.forEach(m => FIELDS.forEach(f => { written[m + '|' + f] = new Set([String(INIT[f])]); }));
    // 交付日期只可能是这几个值：初始的 8-05，或者某台设备勾选那天填进去的今天
    const legalDates = new Set(['', '2026-08-05', S.todayStr()]);

    for (let n = 1; n <= ROUNDS; n++) {
      const di = Math.floor(rnd() * devs.length);
      restoreDev(devs[di]);
      const act = rnd();
      if (act < 0.42) {
        const ms = pick(MSS), field = pick(FIELDS), val = VALS[field](n);
        editMs(ms, field, val);
        written[ms + '|' + field].add(String(val));
      } else if (act < 0.6) {
        toggleDone(pick(MSS), rnd() < 0.5);          // 勾 / 取消勾
      } else if (act < 0.82) {
        await S.Repo.persist(S.DB); await tick(10);
      } else {
        await S.pullFromFile(); await tick(10);
      }
      devs[di] = snapshotDev();
    }
    for (let r = 0; r < 4; r++) {
      for (let i = 0; i < devs.length; i++) {
        restoreDev(devs[i]); await S.pullFromFile(); await tick(10);
        await S.Repo.persist(S.DB); await tick(10); devs[i] = snapshotDev();
      }
    }
    const notConverged = [], invented = [];
    const ref = {};
    MSS.forEach(m => FIELDS.forEach(f => { ref[m + '|' + f] = String(fileMs(m)[f]); }));
    devs.forEach((d, i) => {
      restoreDev(d);
      MSS.forEach(m => FIELDS.forEach(f => {
        const v = String((S.byId('milestone', m) || {})[f]);
        if (v !== ref[m + '|' + f]) notConverged.push(`设备${i + 1} ${m}.${f}=${v} 文件=${ref[m + '|' + f]}`);
      }));
    });
    Object.keys(ref).forEach(k => {
      if (!written[k].has(ref[k])) invented.push(`${k} 最终值 ${JSON.stringify(ref[k])} 没人写过`);
    });
    ok('★★★任意交错之后所有设备收敛到同一份', notConverged.length === 0, notConverged.slice(0, 8));
    ok('★★★没有凭空造出来的值', invented.length === 0, invented.slice(0, 8));

    /* ───────── 性质五：交付日期不许被合并弄丢 ───────── */
    const badDate = fileMss().filter(m => !legalDates.has(String(m.actual_date || '')));
    ok('★★★交付日期始终是某台设备真写过的那几个值之一（没被合并揉出一个新日期）',
      badDate.length === 0, badDate.map(m => m.id + '=' + m.actual_date));
    /* M1 一开始就是已交付、日期 8-05。中途可能被取消勾选（P111 起不清日期），
       也可能被重新勾上（沿用 8-05）。所以无论怎么折腾，它的日期都不该变成空。 */
    const m1 = fileMs('M1');
    ok('★★★M1 那条"本来就有交付日期"的，折腾一通之后日期还在（P111 的保留契约在并发下也成立）',
      String(m1.actual_date || '') !== '', { done: m1.done, actual_date: m1.actual_date });

    /* ───────── 性质六：done 和 actual_date 不许自相矛盾 ───────── */
    const contradictory = fileMss().filter(m => m.done === '1' && !m.actual_date);
    ok('★★★没有"标着已交付、却没有交付日期"的记录（有的话会在报表"本期已交付"里凭空消失）',
      contradictory.length === 0, contradictory.map(m => m.id));
    // 每台设备上也要成立，不只是文件里
    const devContra = [];
    devs.forEach((d, i) => {
      restoreDev(d);
      S.DB.milestones.forEach(m => { if (m.done === '1' && !m.actual_date) devContra.push(`设备${i + 1} ${m.id}`); });
    });
    ok('★★每台设备上也没有这种自相矛盾的记录', devContra.length === 0, devContra.slice(0, 8));
  }

  /* ───────── 性质七：里程碑的变更记录不重不丢 ───────── */
  console.log('\n■ 性质七：一路同步下来，里程碑的变更记录不重复、也不凭空消失');
  {
    const logs = JSON.parse(FILE).changelog || [];
    const msLogs = logs.filter(e => e.entity === 'milestone');
    const ids = msLogs.map(e => e.id);
    ok('★里程碑的变更记录确实同步进了共享文件（P111 记了就要推得出去）', msLogs.length > 0,
      { 全部日志: logs.length, 里程碑日志: msLogs.length });
    ok('★★没有重复条目（合并是按 id 取并集，重复就说明 id 生成或合并有问题）',
      new Set(ids).size === ids.length, { 条数: ids.length, 去重后: new Set(ids).size });
    const withChanges = msLogs.filter(e => Array.isArray(e.changes) && e.changes.length);
    ok('★★带逐字段明细的那种占多数（"按日志核对数据"能用的只有这一种）',
      withChanges.length >= msLogs.length * 0.5,
      { 带明细: withChanges.length, 总数: msLogs.length });
    // 日志里记的"改成了什么"，不该指向一个谁都没写过的值
    const bogus = [];
    withChanges.forEach(e => (e.changes || []).forEach(c => {
      if (c.k === 'report_level' && !['section', 'department', 'bank'].includes(String(c.to))) {
        bogus.push(e.id + ':' + c.k + '=' + c.to);
      }
    }));
    ok('★日志里记下的目标值都是合法值（没有被合并弄脏）', bogus.length === 0, bogus.slice(0, 5));
  }

  /* ───────── 性质四：幂等 ───────── */
  console.log('\n■ 性质四：已经一致之后再同步，内容不变，也不该反复写文件');
  {
    const before = FILE;
    const w0 = handle._mtime;
    const devs = [snapshotDev()];
    for (let r = 0; r < 5; r++) {
      restoreDev(devs[0]); await S.pullFromFile(); await tick(10);
      await S.Repo.persist(S.DB); await tick(10); devs[0] = snapshotDev();
    }
    const b0 = JSON.parse(before).milestones, b1 = JSON.parse(FILE).milestones;
    ok('★静止之后条数不变', b0.length === b1.length, { 前: b0.length, 后: b1.length });
    const changed = b0.filter(a => {
      const b = b1.find(x => x.id === a.id) || {};
      return FIELDS.concat(['done', 'actual_date']).some(f => String(a[f]) !== String(b[f]));
    });
    ok('★★静止之后字段一个都没再变', changed.length === 0, changed.map(x => x.id));
    ok('★★静止之后不再反复写文件', handle._mtime - w0 <= 1, { 静止前: w0, 静止后: handle._mtime });
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('sim14 异常：', e); process.exit(1); });
