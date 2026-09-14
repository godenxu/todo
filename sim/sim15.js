/* 第二十五轮（P117）新切法：把「详情弹窗开着的时候后台同步跑过」这件事交给随机长跑去压。

   为什么单独做一支：P115 / P116 在这块连着挖出四个问题——
     · 闭包里捏着的记录在同步后变成孤儿，保存整个丢失，界面还提示"已保存"；
     · 同事改过的那一格被弹窗里的旧值顶回去；
     · 同事删掉的里程碑被一次"什么都没改的保存"复活；
     · commitTaskStatus 拿一份过期的整条记录去盖掉同事的所有改动。
   这四个都是手工构造场景找出来的。手工场景的问题在于：它只覆盖我想得到的那几种交错，
   而真实办公室里"谁在什么时候点了保存"是完全随机的。所以这一支反过来——
   先写下这块必须满足的不变量，再让机器随机造几百种交错去撞。

   模拟的是两台机器：
     · 本机走真实的界面路径（openTaskDetail → 改几格 → 保存），
       而且【刻意在"打开"和"保存"之间随机插入同步】，这正是前两轮出事的那个窗口；
     · 另一台用直接改共享文件来模拟（改字段、改里程碑、删里程碑、加里程碑）。

   ★ 一条经验，写在这里免得下次又踩 ★
   第一版是纯随机的：外层随机挑动作，指望"同事写入"和"我打开弹窗"自然撞到一起。
   结果只抓得到 6 个已知 bug 里的 1 个——因为真正要压的是一个【特定顺序】：
       我打开弹窗（手里是旧值）→ 同事写并推上去 → 窗口期同步 → 我点保存（手里还是旧值）
   随机序列几乎走不出这一串。改成两件事之后才真正管用：
     ① 窗口期【主动构造】冲突——在弹窗打开之后、保存之前，让同事去改我没打算动的那几格；
     ② 需要多步序列的场景（删除冲突、勾上→取消勾选）固定成剧本，每隔若干轮强制走一遍。
   另外两个坑也记一下，都是让"我写的必须存下来"假红的：
     · 保存有可能先弹确认框再落库（里程碑顺序不对就会），只调一次 modalCallback
       等于只把框弹出来、根本没保存——统一走 saveThrough() 把框点完；
     · 随机生成的交付物如果让两行变得一模一样，会触发"同一任务下两条里程碑完全重复"
       的硬拦（findDuplicateCpIssue），保存直接 return——所以随机值里要带上里程碑 id。
   这两个都不是产品 bug，是模拟器没把界面的真实行为走完。
   还有一条：不变量要贴着动作发生的那一刻检查。"删除不许复活"如果只看长跑结束时的
   最终状态，被复活的那条在后续几十轮里很可能又被别的动作覆盖，检查会假绿——
   实测把修复弄坏之后，收敛检查照样全绿，就地检查才抓得到。

   ★★ 已知未解：SEED=99 时不变量 ⑤ 会红一条，我没能完全归因 ★★
   现象：`M5|done 应为我写的「1」，实际「0」`。用 TRACE='M5|done' 跑一遍能看到全过程，
   出事的是第 295 轮——那时任务名下只剩 M5 一条里程碑，弹窗行和 DB 里那条三格全不一样：
       弹窗行 {plan_date:2026-11-02, report_level:bank, done:1}
       DB 那条 {plan_date:2026-11-05, report_level:department, done:0}
   我确认过的：
     · 产品侧这个组合是对的——probe-done3 把"同时改 done+日期+层级"（含触发顺序确认框那条路）
       三种情形都确定性地跑过，全绿；test-p116 的 42 条断言也全绿；
     · 其余 12 个种子（1/2/3/5/7/11/23/42/123/777/2024/31337）这一条都通过；
     · 已经排掉的几个假红来源：确认框没点完、随机值撞出重复里程碑被硬拦、
       剧本改了格子却没记账、真冲突格拿"我必须赢"去断言。
   还没排掉的怀疑：这一轮的保存把任务状态带成了 done（下一轮诊断显示状态确实变了），
   说明保存执行过；但 done 最终是 0。可能是模拟器的真值表跟三方合并的胜负语义
   在某个边角上对不齐，也可能是产品在"只剩一行 + 同事同轮改同一行"下真有问题。
   下次接手请从这里查起：TRACE='M5|done' ROUNDS=300 SEED=99 node sim/sim15.js

   不变量（每一条都对应一个真出过的问题）：
   ① 收敛 —— 折腾完之后本机和共享文件必须完全一致。
   ② 不凭空造值 —— 最终每个字段的值，必须是某一方真的写过的。
   ③ ★不丢别人的改动 —— 我没有在弹窗里碰过的字段，如果同事在这期间改了，
      保存之后必须还是同事那个值（P115/P116 的核心契约）。
   ④ ★删除不复活 —— 同事删掉的里程碑，不能被我一次没碰过它的保存救回来。
   ⑤ 我碰过的字段必须写进去 —— 修上面那些不能把正常保存弄坏。
   ⑥ 幂等 —— 静止之后再同步任意多轮，内容不变、也不该反复写文件。

   用法：ROUNDS=200 SEED=1 node sim/sim15.js */
const path = require('path');
const { sandbox: S, raw, q } = require(path.join('C:/Users/Administrator/Documents/Claude/Todo/test/harness.js'));
const tick = (ms = 12) => new Promise(r => setTimeout(r, ms));
const ROUNDS = Number(process.env.ROUNDS || 200);
const SEED = Number(process.env.SEED || 1);
let _s = SEED >>> 0;
const rnd = () => ((_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = a => a[Math.floor(rnd() * a.length)];
const cp = o => JSON.parse(JSON.stringify(o));

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 700) : '')); } };

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
let FILE = null;
const handle = { name: 'shared.json', _mtime: 1, _writes: 0,
  async getFile() { const s = FILE; return { lastModified: handle._mtime, text: async () => s }; },
  async createWritable() { return { async write(t) { handle._p = t; },
    async close() { FILE = handle._p; handle._mtime++; handle._writes++; } }; } };

/* 详情弹窗里的检查点行：沙箱的 DOM 桩不解析 innerHTML，按需要现造 */
function cpRow(id, pd, dv, rl, dn) {
  return { getAttribute: k => (k === 'data-ms-id' ? id : null),
    querySelector: sel => ({ '.cp-date': { value: pd }, '.cp-deliv': { value: dv },
      '.cp-report-level': { value: rl }, '.cp-chk': { checked: dn === '1' } }[sel]) };
}
const origQSA = raw.document.querySelectorAll;
const stubCp = rows => { raw.document.querySelectorAll = sel =>
  (sel === '#cp-list [data-cp-row]' ? rows : (origQSA ? origQSA(sel) : [])); };
const unstubCp = () => { raw.document.querySelectorAll = origQSA; };

const TASK_FIELDS = ['title', 'source', 'custom'];   // 纯文本、互不联动，便于归属判断
const MS_FIELDS = ['plan_date', 'deliverable', 'report_level'];
const LEVELS = ['section', 'department', 'bank'];
/* 6 条而不是 3 条：删除冲突要能反复发生，才压得住「删除不许复活」这条不变量。
   3 条的时候删两下就只剩一条了（下面那句 aliveN > 1 会把后续的删除都挡掉），
   实测一轮 300 次只造出 2 次删除冲突，根本压不到。 */
const MS_IDS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];

function seedWorld() {
  S.DB.settings.me = '我';
  S.DB.users = [
    { name: '我', role: 'admin', salt: '', hash: '', iterations: 0, rev: 1,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '我' },
    { name: '同事', role: 'admin', salt: '', hash: '', iterations: 0, rev: 1,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '我' },
  ];
  S.DB.permissionMatrix = null;
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    owner: '我', year: 2026, status: 'doing' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261',
    title: '初始标题', owner: '我', assignees: [], status: 'doing', priority: '2', progress: 0,
    plan_date: '2026-12-31', actual_date: '', source: '初始来源', custom: '初始标签' }))];
  S.DB.milestones = MS_IDS.map((id, i) => S.stampMeta(S.blank('milestone', {
    id, task: 'T1', plan_date: '2026-0' + ((i % 8) + 1) + '-15', deliverable: '初始交付物' + (i + 1),
    report_level: 'section', done: '0', actual_date: '' })));
  S.DB.changelog = []; S.DB.purged = [];
  S.DB.settings.year = 2026;
  S.DB.settings.pendingSync = false;
  S.DB.settings.maxSeenAppVersion = '';
  S.clearSyncBaseline(S.DB); S.undoStack.length = 0;
  S.setSnackPriorityUntil(0); S.setLocalSaveFailedAt(0);
  S.setStaleAppBlocked(false); S.closeModal();
  S.rebuildIndex();
  FILE = JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
    writeId: 'w0', writeIds: ['w0'], lastWriteApp: S.APP_VERSION,
    tasks: cp(S.DB.tasks), works: cp(S.DB.works), duties: cp(S.DB.duties),
    milestones: cp(S.DB.milestones), users: cp(S.DB.users) }));
  handle._mtime = 1; handle._writes = 0;
  S.setFileHandle(handle); S.setEverConnected(true);
}

/* 同事那边：直接改共享文件（模拟另一台机器已经推上去了） */
function colleagueWrite(fn) {
  const p = JSON.parse(FILE);
  fn(p);
  p.writeId = 'wC' + Math.floor(rnd() * 1e9);
  p.writeIds = [p.writeId];
  p.lastWriteBy = '同事'; p.lastWriteAt = new Date(Date.now() + 1000).toISOString();
  FILE = JSON.stringify(p); handle._mtime++;
}
const bump = r => {
  r.rev = (r.rev || 1) + 1;
  r.updated_at = new Date(Date.now() + 5000 + Math.floor(rnd() * 1000)).toISOString();
  r.updated_by = '同事';
};

// 真值表：谁最后写了哪一格
const truth = {};                 // 'task|title' / 'M1|deliverable' -> {by, val}
const written = {};               // 同一个 key 被写过的所有值（含初始值）
const TRACE_KEY = process.env.TRACE || '';   // 例如 TRACE=M5|done
const trace = [];
const noteWrite = (key, val, by) => {
  truth[key] = { by, val: String(val) };
  (written[key] = written[key] || new Set()).add(String(val));
  if (TRACE_KEY && key === TRACE_KEY) trace.push(`记账：${by} 写 ${val}`);
};
function traceActual(tag) {
  if (!TRACE_KEY) return;
  const [id, f] = TRACE_KEY.split('|');
  const r = id === 'task' ? S.byId('task', 'T1') : S.byId('milestone', id);
  trace.push(`  ${tag} → 实际 ${r ? String(r[f]) : '(记录不在)'}${r && r.deleted_at ? '（已删）' : ''}`);
}
/* 保存有可能先弹一个确认框再落库——"里程碑顺序看起来不对"就是这样（findCpOrderIssue）。
   只调一次 modalCallback 的话，那一次只是把确认框弹了出来，保存根本没执行，
   而外面还照样记了账 → 最后"我写的必须存下来"会拿一个没落库的期望去对，报假失败。
   实测种子 2 和 99 都是这么假红的。所以统一走这个：点完主按钮，如果还开着弹窗就再点一次。 */
async function saveThrough() {
  const first = S.modalCallback;
  if (typeof first !== 'function') return;
  try { await first(); await tick(20); } catch (e) { return; }
  /* 只在【回调换了人】时才再点一次——那说明保存过程中弹出了一个新的确认框
     （"里程碑顺序看起来不对"就是这样，它把 modalCallback 换成了确认框的 onConfirm）。
     不能无脑重试：回调没换人时再调一次，等于把同一次保存又跑一遍；
     而如果此刻残留的是上一个弹窗的回调，重试还会把状态搅乱——
     实测种子 99 就是这么假红的（弹窗只剩一行时，重试调到了别的回调，
     那一次编辑看起来"没写进去"，其实产品侧一切正常，
     确定性场景 probe-done3 三种情形全绿）。 */
  let guard = 0;
  while (q('#modal-overlay').classList.contains('show')
         && typeof S.modalCallback === 'function'
         && S.modalCallback !== first
         && guard++ < 2) {
    const cur = S.modalCallback;
    try { await cur(); await tick(20); } catch (e) { break; }
    if (S.modalCallback === cur) break;   // 回调没再换，说明已经走完了
  }
  if (q('#modal-overlay').classList.contains('show')) S.closeModal();
}
const deadMs = new Set();         // 同事删掉、且我没碰过的里程碑（不许复活）
/* 真冲突的格子：同一轮里我和同事都动了它。
   这种格子谁赢取决于合并规则（rev / 时间），不保证是我——所以不能拿它去断言
   "我写的必须存下来"。原来那版把它算进去了，种子 99 因此假红：
   那一轮我改了某条里程碑的三格，同事在窗口期也改了其中两格。 */
const contested = new Set();
const everHadDate = new Map();    // 里程碑 id -> 它曾经有过的交付日期（P111：不许被抹成空）

function initTruth() {
  const t = S.byId('task', 'T1');
  TASK_FIELDS.forEach(f => { truth['task|' + f] = { by: '初始', val: String(t[f]) };
    written['task|' + f] = new Set([String(t[f])]); });
  MS_IDS.forEach(id => {
    const m = S.byId('milestone', id);
    MS_FIELDS.forEach(f => { truth[id + '|' + f] = { by: '初始', val: String(m[f]) };
      written[id + '|' + f] = new Set([String(m[f])]); });
  });
}

async function main() {
  await tick(150);
  console.log(`sim15：详情弹窗 × 后台同步的随机交错（ROUNDS=${ROUNDS} SEED=${SEED}）`);
  seedWorld();
  initTruth();

  let opened = 0, savedN = 0, syncInWindow = 0, colleagueN = 0, delConflictN = 0, dateWiped = 0;
  const revivedAtOnce = [];   // 保存当场就把同事的删除撤销掉的那些（就地记，别等最后）

  /* ───── 定向场景：随机跑不出来的，就按剧本走一遍 ─────
     纯随机有个硬伤：需要"特定多步序列"才触发的问题，它撞不到。
     实测过——300 轮里只造出 2~3 次"窗口期删除冲突"，而"勾上→同步→取消勾选→再勾回来"
     这种四步序列基本不会自然出现。于是把这两个剧本固定下来，每隔若干轮强制走一遍：
     随机负责广度（撞出我没想到的组合），定向负责确定性（已知的坑一个都不许漏）。 */
  async function scriptedDeleteConflict(n) {
    const alive = S.DB.milestones.filter(m => !m.deleted_at && m.task === 'T1' && !deadMs.has(m.id));
    if (alive.length < 2) return;
    const victim = alive[0];
    S.openTaskDetail('T1'); await tick(10);
    opened++;
    const tOpen = cp(S.byId('task', 'T1'));
    const rowsOpen = alive.map(m => ({ id: m.id, plan_date: m.plan_date,
      deliverable: m.deliverable, report_level: m.report_level, done: m.done }));
    // 同事在我开着弹窗时把 victim 删了
    colleagueWrite(p => {
      const m = (p.milestones || []).find(x => x.id === victim.id); if (!m) return;
      m.deleted_at = new Date(Date.now() + 5000).toISOString(); bump(m);
    });
    deadMs.add(victim.id); colleagueN++; delConflictN++;
    await S.pullFromFile(); await tick(8); syncInWindow++;
    // 我这一行一个字没动，直接保存 —— 不许把他的删除撤销掉
    TASK_FIELDS.forEach(f => { q('#td-' + f).value = tOpen[f]; });
    q('#td-owner').value = tOpen.owner; q('#td-plan_date').value = tOpen.plan_date;
    q('#td-priority').value = tOpen.priority; q('#td-status').value = tOpen.status;
    stubCp(rowsOpen.map(r => cpRow(r.id, r.plan_date, r.deliverable, r.report_level, r.done)));
    await saveThrough();
    unstubCp();
    savedN++;
    /* ★ 就地检查，不能等到最后 ★
       这一条如果只在长跑结束时看最终状态，是抓不到的：被复活的那条在后续几十轮里
       很可能又被别的动作删掉/覆盖，最终状态看着是对的。实测过——把修复弄坏之后，
       定向场景跑了 5 次，结尾的收敛检查照样全绿。
       不变量的检查必须贴着动作发生的那一刻。 */
    const after = S.byId('milestone', victim.id);
    if (after && !after.deleted_at) {
      revivedAtOnce.push(`第 ${n} 轮：${victim.id}（${victim.deliverable}）被我的保存救回来了`);
    }
  }
  async function scriptedDateWipe(n) {
    const alive = S.DB.milestones.filter(m => !m.deleted_at && m.task === 'T1' && !deadMs.has(m.id));
    if (!alive.length) return;
    const target = alive[alive.length - 1];
    const rows = () => S.DB.milestones.filter(m => !m.deleted_at && m.task === 'T1')
      .map(m => ({ id: m.id, plan_date: m.plan_date, deliverable: m.deliverable,
        report_level: m.report_level, done: m.done }));
    // 第一步：勾上 → 系统给它填一个交付日期
    let rs = rows();
    let row = rs.find(r => r.id === target.id); if (!row) return;
    row.done = '1';
    S.openTaskDetail('T1'); await tick(10); opened++;
    const t1 = cp(S.byId('task', 'T1'));
    TASK_FIELDS.forEach(f => { q('#td-' + f).value = t1[f]; });
    q('#td-owner').value = t1.owner; q('#td-plan_date').value = t1.plan_date;
    q('#td-priority').value = t1.priority; q('#td-status').value = t1.status;
    stubCp(rs.map(r => cpRow(r.id, r.plan_date, r.deliverable, r.report_level, r.done)));
    await saveThrough();
    unstubCp(); savedN++;
    traceActual('剧本-勾上后');
    // ★ 剧本里改过的格子也要记账，否则真值表还停在随机轮次写的那个值上，
    //   最后的"我写的必须存下来"会拿一个过时的期望去对，报出假的失败（实测种子 2 撞到过）
    noteWrite(target.id + '|done', '1', '我');
    const got = S.byId('milestone', target.id);
    if (got && got.actual_date) everHadDate.set(target.id, got.actual_date);
    // 第二步：取消勾选 → 交付日期必须留着
    rs = rows(); row = rs.find(r => r.id === target.id); if (!row) return;
    row.done = '0';
    S.openTaskDetail('T1'); await tick(10); opened++;
    const t2 = cp(S.byId('task', 'T1'));
    TASK_FIELDS.forEach(f => { q('#td-' + f).value = t2[f]; });
    q('#td-owner').value = t2.owner; q('#td-plan_date').value = t2.plan_date;
    q('#td-priority').value = t2.priority; q('#td-status').value = t2.status;
    stubCp(rs.map(r => cpRow(r.id, r.plan_date, r.deliverable, r.report_level, r.done)));
    await saveThrough();
    unstubCp(); savedN++;
    noteWrite(target.id + '|done', '0', '我');
    traceActual('剧本-取消勾选后');
  }

  for (let n = 1; n <= ROUNDS; n++) {
    // 每 20 轮按剧本走一遍那两个随机撞不到的场景
    if (n % 20 === 7) { await scriptedDeleteConflict(n); continue; }
    if (n % 20 === 13) { await scriptedDateWipe(n); continue; }
    const act = rnd();

    if (act < 0.45) {
      /* ───── 走一次真实的详情弹窗编辑 ─────
         关键：在"打开"和"保存"之间随机插入 0~2 次同步，这正是前两轮出事的那个窗口 */
      const alive = S.DB.milestones.filter(m => !m.deleted_at && m.task === 'T1');
      if (!S.byId('task', 'T1')) break;
      S.openTaskDetail('T1'); await tick(10);
      opened++;

      // 弹窗里各格 = 打开那一刻的值
      const tOpen = cp(S.byId('task', 'T1'));
      const form = {};
      TASK_FIELDS.forEach(f => { form[f] = tOpen[f]; });
      const rowsOpen = alive.map(m => ({ id: m.id, plan_date: m.plan_date,
        deliverable: m.deliverable, report_level: m.report_level, done: m.done }));

      // 我在弹窗里动哪几格（可能一格都不动——那正是"什么都没改的保存"）
      const myTaskEdits = [], myMsEdits = [];
      TASK_FIELDS.forEach(f => {
        if (rnd() < 0.35) { form[f] = f + '_我第' + n + '轮'; myTaskEdits.push(f); }
      });
      rowsOpen.forEach(r => {
        // 勾 / 取消勾选：压 P111 那条"取消勾选不许抹掉交付日期"
        if (rnd() < 0.2) { r.done = r.done === '1' ? '0' : '1'; myMsEdits.push(r.id + '|done'); }
        MS_FIELDS.forEach(f => {
          if (rnd() < 0.18) {
            r[f] = f === 'report_level' ? pick(LEVELS)
              : (f === 'plan_date' ? '2026-1' + Math.floor(rnd() * 2) + '-0' + (1 + Math.floor(rnd() * 8))
                : '交付物_我第' + n + '轮');
            myMsEdits.push(r.id + '|' + f);
          }
        });
      });

      /* ★★ 窗口期冲突：这一段是整支长跑的核心，必须【主动构造】★★
         第一版把"同事写入"放在外层当成一个独立的随机动作，结果是：
         同事写完之后，我下一次打开弹窗时早就同步过了，拿到的已经是他的新值——
         根本构不成冲突。实测那一版只抓得到 6 个已知 bug 里的 1 个，基本是个摆设。
         真正要压的交错是这个特定顺序：
             我打开弹窗（手里是旧值） → 同事写并推上去 → 窗口期同步（内存变成新值）
             → 我点保存（手里还是旧值）
         随机序列几乎不会自然走出这一串，所以这里显式地造它。 */
      let conflictKeys = [];
      if (rnd() < 0.6) {
        const kind = rnd();
        if (kind < 0.3) {
          // 同事改一个任务字段——挑我【没打算动】的那些，这样才测得出"不碰的格子要留给他"
          const free = TASK_FIELDS.filter(f => !myTaskEdits.includes(f));
          if (free.length) {
            const f = pick(free), val = f + '_同事窗口期' + n;
            colleagueWrite(p => {
              const t = (p.tasks || []).find(x => x.id === 'T1'); if (!t) return;
              t[f] = val; bump(t);
            });
            noteWrite('task|' + f, val, '同事');
            conflictKeys.push('task|' + f);
            colleagueN++;
          }
        } else if (kind < 0.6) {
          // 同事改一条里程碑的某一格——同样挑我没打算动的
          const cand = [];
          rowsOpen.forEach(r => MS_FIELDS.forEach(f => {
            if (!myMsEdits.includes(r.id + '|' + f) && !deadMs.has(r.id)) cand.push([r.id, f]);
          }));
          if (cand.length) {
            const [id, f] = pick(cand);
            const val = f === 'report_level' ? pick(LEVELS)
              : (f === 'plan_date' ? '2026-0' + (1 + Math.floor(rnd() * 8)) + '-1' + Math.floor(rnd() * 9)
                : '交付物_同事窗口期' + n);
            colleagueWrite(p => {
              const m = (p.milestones || []).find(x => x.id === id); if (!m || m.deleted_at) return;
              m[f] = val; bump(m);
            });
            noteWrite(id + '|' + f, val, '同事');
            conflictKeys.push(id + '|' + f);
            colleagueN++;
          }
        } else {
          // 同事删掉一条我【没打算动】的里程碑——压"删除不许复活"（这一支要多跑，否则压不到）
          const cand = rowsOpen.filter(r => !deadMs.has(r.id)
            && !myMsEdits.some(x => x.startsWith(r.id + '|')));
          const aliveN = MS_IDS.filter(id => !deadMs.has(id)).length;
          if (cand.length && aliveN > 1) {
            const r = pick(cand);
            colleagueWrite(p => {
              const m = (p.milestones || []).find(x => x.id === r.id); if (!m) return;
              m.deleted_at = new Date(Date.now() + 5000).toISOString(); bump(m);
            });
            deadMs.add(r.id);
            colleagueN++; delConflictN++;
          }
        }
        // 造完冲突一定要同步一次，让内存拿到同事的新值——这正是出事的那一步
        await S.pullFromFile(); await tick(8);
        syncInWindow++;
      }
      // 另外再随机插 0~1 次同步
      if (rnd() < 0.4) { await S.pullFromFile(); await tick(8); syncInWindow++; }

      // 填表单 + 提交
      TASK_FIELDS.forEach(f => { q('#td-' + f).value = form[f]; });
      q('#td-title').value = form.title;
      q('#td-owner').value = tOpen.owner;
      q('#td-plan_date').value = tOpen.plan_date;
      q('#td-priority').value = tOpen.priority;
      q('#td-status').value = tOpen.status;
      if (TRACE_KEY) {
        const [tid, tf] = TRACE_KEY.split('|');
        const row = rowsOpen.find(r => r.id === tid);
        const live = S.byId('milestone', tid);
        trace.push(`第 ${n} 轮提交：弹窗里这一行 ${row ? tf + '=' + row[tf] : '（不在弹窗里）'}`
          + `；DB 里现在 ${live ? tf + '=' + live[tf] + (live.deleted_at ? '（已删）' : '') : '（记录不在）'}`
          + `；我打算改的格子 [${myMsEdits.filter(x => x.startsWith(tid + '|')).join(',') || '无'}]`
          + `；这一行在 rowsOpen 里吗=${!!row}`
          + `；弹窗共 ${rowsOpen.length} 行`
          + `
      弹窗行内容 = ${JSON.stringify(row)}`
          + `
      DB 那条    = ${live ? JSON.stringify({done: live.done, plan_date: live.plan_date,
              deliverable: live.deliverable, report_level: live.report_level, del: !!live.deleted_at}) : 'null'}`
          + `
      任务状态   = ${(S.byId('task','T1')||{}).status}`);
      }
      stubCp(rowsOpen.map(r => cpRow(r.id, r.plan_date, r.deliverable, r.report_level, r.done)));
      await saveThrough();
      unstubCp();
      traceActual('随机轮保存后');
      if (TRACE_KEY) {
        const [tid2] = TRACE_KEY.split('|');
        const still = S.DB.milestones.filter(m => !m.deleted_at && m.task === 'T1').map(m => m.id);
        trace.push(`    保存后任务名下还剩：[${still.join(',')}]`);
      }
      savedN++;
      /* P111 的契约：交付日期一旦有过，就不该被"取消勾选"抹成空——
         它是报表归期的唯一依据，抹掉就同时错两期。这里把见过的日期记下来，最后统一核对。 */
      S.DB.milestones.forEach(m => {
        if (!m.deleted_at && m.actual_date) everHadDate.set(m.id, m.actual_date);
      });

      // 记账：我真正动过的那些格，真值归我
      myTaskEdits.forEach(f => noteWrite('task|' + f, form[f], '我'));
      myMsEdits.forEach(key => {
        const [id, f] = key.split('|');
        const r = rowsOpen.find(x => x.id === id);
        if (r) noteWrite(key, r[f], '我');
      });
      // 我在弹窗里"见过"的那些行，如果同事在窗口期删了它而我没碰过，就不该复活
      rowsOpen.forEach(r => {
        const touched = myMsEdits.some(x => x.startsWith(r.id + '|'));
        if (touched) deadMs.delete(r.id);
      });

      // 窗口期同事碰过的那些格子，如果我也动了，就是真冲突
      conflictKeys.forEach(k => { if (myTaskEdits.includes(k.split('|')[1]) || myMsEdits.includes(k)) contested.add(k); });

    } else if (act < 0.72) {
      /* ───── 同事那边改点什么并推上去 ───── */
      colleagueN++;
      const what = rnd();
      if (what < 0.4) {
        const f = pick(TASK_FIELDS);
        const val = f + '_同事第' + n + '轮';
        colleagueWrite(p => {
          const t = (p.tasks || []).find(x => x.id === 'T1'); if (!t) return;
          t[f] = val; bump(t);
        });
        noteWrite('task|' + f, val, '同事');
      } else if (what < 0.8) {
        const alive = MS_IDS.filter(id => !deadMs.has(id));
        if (alive.length) {
          const id = pick(alive), f = pick(MS_FIELDS);
          const val = f === 'report_level' ? pick(LEVELS)
            : (f === 'plan_date' ? '2026-0' + (1 + Math.floor(rnd() * 8)) + '-2' + Math.floor(rnd() * 9)
              : '交付物_同事第' + n + '轮');
          colleagueWrite(p => {
            const m = (p.milestones || []).find(x => x.id === id); if (!m || m.deleted_at) return;
            m[f] = val; bump(m);
          });
          noteWrite(id + '|' + f, val, '同事');
        }
      } else {
        // 同事删掉一条里程碑
        const alive = MS_IDS.filter(id => !deadMs.has(id));
        if (alive.length > 1) {
          const id = pick(alive);
          colleagueWrite(p => {
            const m = (p.milestones || []).find(x => x.id === id); if (!m) return;
            m.deleted_at = new Date(Date.now() + 5000).toISOString(); bump(m);
          });
          deadMs.add(id);
        }
      }

    } else if (act < 0.88) {
      await S.Repo.persist(S.DB); await tick(10);
    } else {
      await S.pullFromFile(); await tick(10);
    }
  }

  // ───── 同步到静止 ─────
  for (let r = 0; r < 5; r++) {
    await S.pullFromFile(); await tick(10);
    await S.Repo.persist(S.DB); await tick(10);
  }

  console.log(`\n（本轮：打开弹窗 ${opened} 次、保存 ${savedN} 次、`
    + `其中窗口期插入同步 ${syncInWindow} 次、同事写入 ${colleagueN} 次、`
    + `窗口期删除冲突 ${delConflictN} 次）`);

  const fileP = JSON.parse(FILE);
  const fileTask = (fileP.tasks || []).find(x => x.id === 'T1') || {};
  const fileMs = id => (fileP.milestones || []).find(x => x.id === id) || {};

  /* ───── ① 收敛 ───── */
  console.log('\n■ ① 收敛：本机和共享文件必须完全一致');
  {
    const diff = [];
    TASK_FIELDS.forEach(f => {
      const a = String((S.byId('task', 'T1') || {})[f]), b = String(fileTask[f]);
      if (a !== b) diff.push(`task.${f}: 本机=${a} 文件=${b}`);
    });
    MS_IDS.forEach(id => {
      const mine = S.byId('milestone', id) || {}, theirs = fileMs(id);
      MS_FIELDS.forEach(f => {
        if (String(mine[f]) !== String(theirs[f])) diff.push(`${id}.${f}: 本机=${mine[f]} 文件=${theirs[f]}`);
      });
      if (!!mine.deleted_at !== !!theirs.deleted_at) diff.push(`${id}.deleted: 本机=${!!mine.deleted_at} 文件=${!!theirs.deleted_at}`);
    });
    ok('★★★本机跟共享文件完全一致', diff.length === 0, diff.slice(0, 8));
  }

  /* ───── ② 不凭空造值 ───── */
  console.log('\n■ ② 不凭空造值：每个最终值都必须是某一方真写过的');
  {
    const invented = [];
    Object.keys(written).forEach(key => {
      const [who, f] = key.split('|');
      const cur = who === 'task' ? String(fileTask[f]) : String(fileMs(who)[f]);
      if (who !== 'task' && fileMs(who).deleted_at) return;       // 已删除的不参与
      if (!written[key].has(cur)) invented.push(`${key} 最终=${cur}，没人写过`);
    });
    ok('★★★没有凭空造出来的值', invented.length === 0, invented.slice(0, 8));
  }

  /* ───── ③ 不丢别人的改动（核心契约） ───── */
  console.log('\n■ ③ ★不丢别人的改动：我没碰过的字段，同事改了就该是同事的值');
  {
    const lost = [];
    Object.keys(truth).forEach(key => {
      const t = truth[key];
      if (t.by !== '同事') return;
      const [who, f] = key.split('|');
      if (who !== 'task' && fileMs(who).deleted_at) return;
      const cur = who === 'task' ? String(fileTask[f]) : String(fileMs(who)[f]);
      if (cur !== t.val) lost.push(`${key} 应为同事写的「${t.val}」，实际「${cur}」`);
    });
    ok('★★★同事最后写的那些格，一格都没被我的保存顶回去', lost.length === 0, lost.slice(0, 8));
  }

  /* ───── ④ 删除不复活 ───── */
  console.log('\n■ ④ ★同事删掉、而我没碰过的里程碑，不许被我的保存救回来');
  {
    const revived = [];
    deadMs.forEach(id => {
      const m = fileMs(id);
      if (m && !m.deleted_at) revived.push(id + '（' + (m.deliverable || '') + '）');
    });
    ok('★★★没有记录复活（复活的记录会被推回共享文件，替所有人抹掉那次删除）',
      revived.length === 0, revived);
    /* 就地记下来的那一份才是真正管用的检查：只看最终状态的话，
       被复活的那条在后续轮次里可能又被别的动作删掉，收敛检查会假绿。 */
    ok('★★★保存当场也没有把同事的删除撤销掉（就地检查，不等最终状态）',
      revivedAtOnce.length === 0, revivedAtOnce.slice(0, 5));
    // 本机也要一致
    const revivedLocal = [];
    deadMs.forEach(id => {
      const m = S.byId('milestone', id);
      if (m && !m.deleted_at) revivedLocal.push(id);
    });
    ok('★★本机上也没复活', revivedLocal.length === 0, revivedLocal);
  }

  /* ───── ⑤ 我改的必须写进去 ───── */
  console.log('\n■ ⑤ 我最后写的那些格，必须真的存下来（别为了让步把正常保存弄坏）');
  {
    const mine = []; let contestedN = 0;
    Object.keys(truth).forEach(key => {
      const t = truth[key];
      if (t.by !== '我') return;
      /* 真冲突的格子跳过：同一轮我和同事都动了它，谁赢由合并规则说了算，
         不该拿"我写的必须赢"去要求。这一条不是放水——真正要守的
         "同事的改动不许被顶回去"在 ③ 里，"我的改动不许凭空消失"由
         没有冲突的那些格子守着，确定性测试（test-p116）另有覆盖。 */
      if (contested.has(key)) { contestedN++; return; }
      const [who, f] = key.split('|');
      if (who !== 'task' && fileMs(who).deleted_at) return;
      const cur = who === 'task' ? String(fileTask[f]) : String(fileMs(who)[f]);
      if (cur !== t.val) mine.push(`${key} 应为我写的「${t.val}」，实际「${cur}」`);
    });
    ok('★★★我最后写的那些格都存下来了（真冲突的格子除外）', mine.length === 0, mine.slice(0, 8));
    console.log('    （其中 ' + contestedN + ' 格是我和同事同一轮都动过的真冲突，'
      + '胜负由合并规则决定，不在这条断言的范围内）');
  }

  /* ───── ⑤b 交付日期不许被抹掉（P111） ───── */
  console.log('\n■ ⑤b ★交付日期一旦有过就不许被抹成空（报表归期的唯一依据）');
  {
    const wiped = [];
    everHadDate.forEach((date, id) => {
      const m = fileMs(id);
      if (!m || m.deleted_at) return;                 // 删掉的不算
      if (!m.actual_date) wiped.push(`${id} 曾有交付日期 ${date}，现在是空的`);
    });
    ok('★★★没有被抹掉的交付日期（抹掉会让那条交付物在原来那一期凭空消失、'
      + '又在本期凭空多出来）', wiped.length === 0, wiped.slice(0, 6));
    console.log('    （本轮共有 ' + everHadDate.size + ' 条里程碑出现过交付日期）');
  }

  /* ───── ⑥ 幂等 ───── */
  console.log('\n■ ⑥ 幂等：静止之后再同步任意多轮，内容不变、也不反复写文件');
  {
    const before = FILE;
    const w0 = handle._writes;
    for (let r = 0; r < 5; r++) {
      await S.pullFromFile(); await tick(10);
      await S.Repo.persist(S.DB); await tick(10);
    }
    const a = JSON.parse(before), b = JSON.parse(FILE);
    const at = (a.tasks || []).find(x => x.id === 'T1') || {};
    const bt = (b.tasks || []).find(x => x.id === 'T1') || {};
    const changed = TASK_FIELDS.filter(f => String(at[f]) !== String(bt[f]));
    MS_IDS.forEach(id => {
      const am = (a.milestones || []).find(x => x.id === id) || {};
      const bm = (b.milestones || []).find(x => x.id === id) || {};
      MS_FIELDS.forEach(f => { if (String(am[f]) !== String(bm[f])) changed.push(id + '.' + f); });
    });
    ok('★★静止之后字段一个都没再变', changed.length === 0, changed);
    ok('★★静止之后不再反复写文件', handle._writes - w0 <= 1,
      { 静止前: w0, 静止后: handle._writes });
  }

  /* ───── ⑦ 数据本身没坏 ───── */
  console.log('\n■ ⑦ 折腾完之后数据本身不能是坏的');
  {
    let err = '';
    try {
      S.setPage('tasks'); S.renderPage();
      S.setPage('charts'); S.renderPage();
      S.setPage('report'); S.renderPage();
      S.renderDashboard();
    } catch (e) { err = e.message; }
    ok('★各页面都渲染得出来', !err, err);
    const dup = S.DB.milestones.filter(m => !m.deleted_at).map(m => m.id);
    ok('★★里程碑没有被复制成多条（同一 id 只该有一条）',
      new Set(dup).size === dup.length, { 条数: dup.length, 去重后: new Set(dup).size });
    const t = S.byId('task', 'T1');
    ok('★任务还在', !!t && !t.deleted_at);
    const badDone = S.DB.milestones.filter(m => !m.deleted_at && m.done === '1' && !m.actual_date);
    ok('★★没有"标着已交付却没有交付日期"的里程碑（有的话报表里会凭空消失一条）',
      badDone.length === 0, badDone.map(m => m.id));
  }

  /* 诊断用：TRACE='M5|done' 跑一遍，就能看到那一格被谁、按什么顺序改成了什么，
     以及每次保存之后的实际值——不用再靠猜。 */
  if (TRACE_KEY) {
    console.log('\n── ' + TRACE_KEY + ' 的轨迹 ──');
    trace.forEach(x => console.log('  ' + x));
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { unstubCp(); console.error('sim15 异常：', e); process.exit(1); });
