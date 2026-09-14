/* 第十七轮 新切法①：把合并当成数学对象，验它必须满足的性质。
   前几轮都是"构造一个场景看结果对不对"，这次反过来——先写下"任何正确的合并都必须满足"
   的几条性质，再让机器随机造几百种交错去撞它们。

   性质一（最强）：【串行写入不许丢】
     每次改动都立刻同步到底再换下一台设备改，那么每一次写入都因果地晚于前一次，
     最终每个字段必须等于"最后那次写"的值。一个都不许丢、也不许变成别的值。
   性质二：【收敛】任意交错之后，把所有设备都同步到静止，它们和共享文件必须完全一致。
   性质三：【不凭空造值】最终每个字段的值，必须是某台设备真的写过的值（或初始值）。
   性质四：【幂等】已经一致之后再同步任意多轮，内容不变、也不该反复写文件。

   用法：ROUNDS=200 SEED=1 node sim13.js */
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
let FILE = null;   // 共享文件的文本
const handle = {
  name: 'shared.json', _mtime: 1,
  async getFile() { const s = FILE; return { lastModified: handle._mtime, text: async () => s }; },
  async createWritable() { return { async write(t) { handle._p = t; }, async close() { FILE = handle._p; handle._mtime++; } }; },
};

/* 每台设备 = 一份完整的本机状态（数据 + 基线 + 本机凭据标记 + 写入链标记）。
   切换设备时把这些整套换掉，模拟"不同机器上的浏览器"。 */
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

const TASKS = ['T1', 'T2', 'T3'];
const FIELDS = ['title', 'owner', 'custom', 'priority', 'plan_date'];
const VALS = {
  title: i => '标题' + i, owner: i => '人员' + (i % 5), custom: i => '备注' + i,
  priority: i => String((i % 3) + 1), plan_date: i => '2026-' + String((i % 12) + 1).padStart(2, '0') + '-15',
};

function seedWorld() {
  S.DB.settings.me = '设备1';
  S.DB.users = [{ name: '设备1', role: 'admin', salt: '', hash: '', iterations: 0,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '设备1', rev: 1 }];
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    owner: '设备1', year: 2026, status: 'doing' }))];
  S.DB.tasks = TASKS.map((id, i) => S.stampMeta(S.blank('task', { id, work: 'w1', code: '010126' + (i + 1),
    title: '初始标题', owner: '初始人', custom: '初始备注', status: 'doing', priority: '2',
    plan_date: '2026-10-01', progress: 0 })));
  S.DB.milestones = [];
  S.DB.changelog = []; S.DB.purged = [];
  S.DB.permissionMatrix = null; S.DB.reportConfig = null; S.DB.dashboardConfig = null; S.DB.shareConfig = null;
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.setSnackPriorityUntil(0);
  S.rebuildIndex();
  FILE = JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'] }));
  S.setFileHandle(handle); S.setEverConnected(true);
}
// 走真实编辑路径：改一个字段 + 写逐字段日志 + 盖戳
function editField(taskId, field, val) {
  const t = S.byId('task', taskId); if (!t) return;
  const before = JSON.parse(JSON.stringify(t));
  t[field] = val;
  S.logRecordChange('task', taskId, before, t, [field]);
  S.stampMeta(t);
}
const fileTasks = () => (JSON.parse(FILE).tasks || []);
const fileTask = id => fileTasks().find(x => x.id === id) || {};

async function main() {
  await tick(150);
  console.log(`sim13：合并的代数性质（ROUNDS=${ROUNDS} SEED=${SEED}）`);

  /* ───────── 性质一：串行写入不许丢 ───────── */
  console.log('\n■ 性质一：每次改完立刻同步到底，最后每个字段都必须等于"最后那次写"');
  {
    seedWorld();
    const devs = [snapshotDev(), snapshotDev(), snapshotDev()];
    devs.forEach((d, i) => { d.settings.me = '设备' + (i + 1); });
    // 每台设备先各自跟文件对一次账，拿到基线
    for (let i = 0; i < devs.length; i++) {
      restoreDev(devs[i]); await S.Repo.persist(S.DB); await tick(15); devs[i] = snapshotDev();
    }
    const truth = {};        // "最后一次写"的真值表：task|field -> value
    for (let n = 1; n <= ROUNDS; n++) {
      const di = Math.floor(rnd() * devs.length);
      const task = pick(TASKS), field = pick(FIELDS), val = VALS[field](n);
      restoreDev(devs[di]);
      // 改之前先拉一次，模拟"人在界面上看到的是最新的"
      await S.pullFromFile(); await tick(10);
      editField(task, field, val);
      await S.Repo.persist(S.DB); await tick(12);
      devs[di] = snapshotDev();
      truth[task + '|' + field] = val;
    }
    // 所有设备同步到静止
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < devs.length; i++) {
        restoreDev(devs[i]); await S.pullFromFile(); await tick(10);
        await S.Repo.persist(S.DB); await tick(10); devs[i] = snapshotDev();
      }
    }
    const lost = [];
    Object.keys(truth).forEach(k => {
      const [task, field] = k.split('|');
      if (String(fileTask(task)[field]) !== String(truth[k])) {
        lost.push(`${task}.${field} 期望 ${JSON.stringify(truth[k])} 实际 ${JSON.stringify(fileTask(task)[field])}`);
      }
    });
    ok(`★★★串行写入一个都没丢（共对账 ${Object.keys(truth).length} 个字段、${ROUNDS} 次写入）`,
      lost.length === 0, lost.slice(0, 8));
    // 每台设备也必须跟文件一致
    const diffDev = [];
    devs.forEach((d, i) => {
      restoreDev(d);
      TASKS.forEach(t => FIELDS.forEach(f => {
        if (String((S.byId('task', t) || {})[f]) !== String(fileTask(t)[f])) diffDev.push(`设备${i + 1} ${t}.${f}`);
      }));
    });
    ok('★★所有设备跟共享文件完全一致', diffDev.length === 0, diffDev.slice(0, 8));
  }

  /* ───────── 性质二/三：任意交错之后收敛，且不凭空造值 ───────── */
  console.log('\n■ 性质二/三：随机交错（改了不立刻同步）之后必须收敛，且不出现没人写过的值');
  {
    seedWorld();
    const devs = [snapshotDev(), snapshotDev(), snapshotDev()];
    devs.forEach((d, i) => { d.settings.me = '设备' + (i + 1); });
    for (let i = 0; i < devs.length; i++) {
      restoreDev(devs[i]); await S.Repo.persist(S.DB); await tick(15); devs[i] = snapshotDev();
    }
    const written = {};      // task|field -> 所有被写过的值（含初始值）
    TASKS.forEach(t => FIELDS.forEach(f => {
      written[t + '|' + f] = new Set([String(({ title: '初始标题', owner: '初始人', custom: '初始备注',
        priority: '2', plan_date: '2026-10-01' })[f])]);
    }));
    for (let n = 1; n <= ROUNDS; n++) {
      const di = Math.floor(rnd() * devs.length);
      restoreDev(devs[di]);
      const act = rnd();
      if (act < 0.55) {
        const task = pick(TASKS), field = pick(FIELDS), val = VALS[field](n);
        editField(task, field, val);
        written[task + '|' + field].add(String(val));
      } else if (act < 0.8) {
        await S.Repo.persist(S.DB); await tick(10);
      } else {
        await S.pullFromFile(); await tick(10);
      }
      devs[di] = snapshotDev();
    }
    // 同步到静止
    for (let r = 0; r < 4; r++) {
      for (let i = 0; i < devs.length; i++) {
        restoreDev(devs[i]); await S.pullFromFile(); await tick(10);
        await S.Repo.persist(S.DB); await tick(10); devs[i] = snapshotDev();
      }
    }
    const notConverged = [], invented = [];
    const ref = {};
    TASKS.forEach(t => FIELDS.forEach(f => { ref[t + '|' + f] = String(fileTask(t)[f]); }));
    devs.forEach((d, i) => {
      restoreDev(d);
      TASKS.forEach(t => FIELDS.forEach(f => {
        const v = String((S.byId('task', t) || {})[f]);
        if (v !== ref[t + '|' + f]) notConverged.push(`设备${i + 1} ${t}.${f}=${v} 文件=${ref[t + '|' + f]}`);
      }));
    });
    Object.keys(ref).forEach(k => {
      if (!written[k].has(ref[k])) invented.push(`${k} 最终值 ${JSON.stringify(ref[k])} 没人写过`);
    });
    ok('★★★任意交错之后所有设备收敛到同一份', notConverged.length === 0, notConverged.slice(0, 8));
    ok('★★★没有凭空造出来的值（每个最终值都是某台设备真写过的）', invented.length === 0, invented.slice(0, 8));
  }

  /* ───────── 性质四：幂等——静止之后不该再反复写文件 ───────── */
  console.log('\n■ 性质四：已经一致之后再同步，内容不变，也不该反复写文件');
  {
    const before = FILE;
    const w0 = handle._mtime;
    const devs = [snapshotDev()];
    for (let r = 0; r < 5; r++) {
      restoreDev(devs[0]); await S.pullFromFile(); await tick(10);
      await S.Repo.persist(S.DB); await tick(10); devs[0] = snapshotDev();
    }
    ok('★静止之后内容不变', JSON.parse(FILE).tasks.length === JSON.parse(before).tasks.length);
    const t0 = JSON.parse(before).tasks, t1 = JSON.parse(FILE).tasks;
    const changed = t0.filter(a => {
      const b = t1.find(x => x.id === a.id) || {};
      return FIELDS.some(f => String(a[f]) !== String(b[f]));
    });
    ok('★★静止之后字段一个都没再变', changed.length === 0, changed.map(x => x.id));
    ok('★★静止之后不再反复写文件（写入次数不该一直涨）', handle._mtime - w0 <= 1,
      { 静止前: w0, 静止后: handle._mtime });
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('sim13 异常：', e); process.exit(1); });
