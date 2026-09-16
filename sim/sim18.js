/* 第四十一轮（P133）：数据体检的每一条"自动修复"都必须站得住

   为什么单独做一支：数据体检是管理员手里唯一一个"一键改几百条"的按钮。修错了比不修更糟——
   人是冲着"把数据弄干净"去点的，出了偏差既不会报错，也不会有人怀疑到它头上。
   而它有十几种修复动作，彼此还会互相影响（删任务会造出孤儿里程碑、补日期会改变逾期判定、
   清重复会改变进度分母……），固定用例只能覆盖到"我想得到的那几种组合"。

   做法：给每一种问题各造一份【带这个毛病 + 一堆随机噪声】的数据，跑一次修复，然后逐条验：
   ① 修复必须真的修掉它声称的问题（这一项的体检结果归零）
   ② 不许制造新问题（别的体检项的条数一条都不许涨）
   ③ 幂等：紧接着再修一次，数据一个字都不许变
   ④ 留痕：动了数据就必须能在变更记录里查到（不留痕的话，事后没人说得清这批数据是怎么变的）
   ⑤ 声明"可撤销"的，Ctrl+Z 之后数据必须真的回到修复前
   ⑥ 修完之后，报表口径那几条铁律（sim17 验的那些）必须仍然成立——
      修复动作会动进度、日期、删除状态，正是最容易把统计弄歪的地方

   用法：ROUNDS=40 SEED=1 node sim/sim18.js */
const path = require('path');
const REPO = 'C:/Users/Administrator/Documents/Claude/Todo';
const { sandbox: S } = require(path.join(REPO, 'test/harness.js'));

const ROUNDS = Number(process.env.ROUNDS) || 40;
const SEED = Number(process.env.SEED) || 1;
const ONLY = process.env.ONLY || '';
let _s = SEED;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = a => a[Math.floor(rnd() * a.length)];
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

let pass = 0, fail = 0;
const seen = new Set();
const ok = (name, cond, extra) => {
  if (cond) { if (!seen.has(name)) { seen.add(name); pass++; console.log('  ✅ ' + name); } return; }
  fail++;
  console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 600) : ''));
};

const PEOPLE = ['徐捷', '小王', '老李'];
const d2 = n => String(n).padStart(2, '0');
const dayOff = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())}`; };

/* 底噪：随机一份正常数据。每种毛病在这之上单独"下药"，这样修复动作要面对的不是干净实验室，
   而是一堆跟它无关的数据——真实环境就是这样。 */
function baseWorld() {
  const year = new Date().getFullYear();
  S.DB.settings.year = year;
  S.DB.settings.me = '管理员';
  S.DB.users = [{ name: '管理员', role: 'admin', salt: 's', hash: 'h', iterations: 1, rev: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' }];
  S.DB.permissionMatrix = null;
  S.DB.changelog = [];
  S.DB.purged = [];
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' })),
    S.stampMeta(S.blank('duty', { code: '02', category: '一、前瞻研判', name: '职责二' }))];
  S.DB.works = [1, 2, 3].map(i => S.stampMeta(S.blank('work', { id: 'w' + i, code: '010' + i, duty: i === 3 ? '02' : '01',
    name: '工作' + i, owner: pick(PEOPLE), year, status: 'doing' })));
  S.DB.tasks = []; S.DB.milestones = [];
  const n = ri(4, 12);
  for (let i = 0; i < n; i++) {
    const status = pick(['todo', 'doing', 'done', 'hold']);
    const t = S.stampMeta(S.blank('task', { id: 'T' + i, work: pick(['w1', 'w2', 'w3']), code: '0101' + i, title: '任务' + i,
      owner: pick(PEOPLE), assignees: [], status, priority: pick(['1', '2', '3']),
      progress: status === 'done' ? 100 : ri(0, 90), plan_date: dayOff(ri(-30, 60)),
      actual_date: status === 'done' ? dayOff(ri(-30, 0)) : '', source: '', custom: '' }));
    S.DB.tasks.push(t);
    for (let j = 0; j < ri(0, 2); j++) {
      const done = rnd() < 0.5;
      S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: 'M' + i + '_' + j, task: t.id,
        plan_date: dayOff(ri(-20, 40)), deliverable: '交付物' + i + j, report_level: pick(['section', 'department', 'bank']),
        done: done ? '1' : '0', actual_date: done ? dayOff(ri(-20, 0)) : '' })));
    }
  }
  // 进度按里程碑对齐一次，免得底噪自带 progressMismatch
  S.DB.tasks.forEach(t => S.recalcProgress(t));
  plantHistory();
  S.rebuildIndex();
}

/* 给这份底噪配上"以前有人改过"的变更记录：每条任务、每个里程碑都留一条逐字段日志，
   说的正是它现在的值。这不是装饰——「按日志核对数据」就是拿每一格最后一条日志比现在的值，
   没有历史日志的话，体检修复改掉什么它都不会吭声，⑦那条性质就等于没验。
   真实数据里这些日志本来就有：处里每条任务的日期、状态、进度都被人改过不止一次。 */
function plantHistory() {
  const at = new Date(Date.now() - 60 * 60000).toISOString();
  const push = (entity, id, taskId, changes) => S.DB.changelog.push({ id: 'H' + S.DB.changelog.length,
    kind: 'edit', entity, refId: id, taskId, at, by: '管理员', summary: '（历史修改）', changes });
  S.DB.tasks.forEach(t => push('task', t.id, t.id, [
    { k: 'work', from: '', to: t.work }, { k: 'plan_date', from: '', to: t.plan_date },
    { k: 'status', from: 'todo', to: t.status }, { k: 'progress', from: 0, to: t.progress },
    { k: 'deleted_at', from: at, to: '' },
  ]));
  S.DB.milestones.forEach(m => push('milestone', m.id, m.task, [
    { k: 'plan_date', from: '', to: m.plan_date }, { k: 'done', from: '0', to: m.done },
    { k: 'deleted_at', from: at, to: '' },
  ]));
}

/* 每种毛病怎么"下药"。返回 false 表示这种毛病这一轮没造出来（跳过） */
const PLANT = {
  orphanTask: () => { const t = pick(S.DB.tasks); t.work = 'w_不存在'; S.stampMeta(t); return true; },
  noWork: () => { const t = pick(S.DB.tasks); t.work = ''; S.stampMeta(t); return true; },
  orphanMs: () => { S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: 'M_orphan', task: 'T_不存在',
    plan_date: dayOff(5), deliverable: '没有主人的交付物', report_level: 'section', done: '0' }))); return true; },
  taskOfDeletedWork: () => { const w = S.DB.works[0]; w.deleted_at = new Date().toISOString(); S.stampMeta(w);
    const t = S.DB.tasks.find(x => x.work === w.id);
    if (!t) { const t2 = pick(S.DB.tasks); t2.work = w.id; S.stampMeta(t2); }
    return true; },
  msOfDeletedTask: () => { const t = S.DB.tasks.find(x => S.DB.milestones.some(m => m.task === x.id && !m.deleted_at));
    if (!t) return false; t.deleted_at = new Date().toISOString(); S.stampMeta(t); return true; },
  badDuty: () => { const w = pick(S.DB.works); w.duty = '99'; S.stampMeta(w); return true; },
  dupCode: () => { const [a, b] = S.DB.works; b.code = a.code; b.year = a.year; S.stampMeta(b); return true; },
  dupTaskCode: () => { const [a, b] = S.DB.tasks; if (!b) return false; b.code = a.code; S.stampMeta(b); return true; },
  dupTask: () => { const a = S.DB.tasks[0];
    const c = S.stampMeta(S.blank('task', Object.assign(cp(a), { id: 'T_dup', code: a.code + '9' })));
    S.DB.tasks.push(c); return true; },
  dupWork: () => { const a = S.DB.works[0];
    S.DB.works.push(S.stampMeta(S.blank('work', Object.assign(cp(a), { id: 'w_dup' })))); return true; },
  dupMs: () => { const m = S.DB.milestones.find(x => !x.deleted_at);
    if (!m) return false;
    S.DB.milestones.push(S.stampMeta(S.blank('milestone', Object.assign(cp(m), { id: 'M_dup' })))); return true; },
  msLateThanTask: () => { const m = S.DB.milestones.find(x => !x.deleted_at);
    if (!m) return false;
    const t = S.byId('task', m.task); if (!t) return false;
    m.plan_date = dayOff(90); t.plan_date = dayOff(10); S.stampMeta(m); S.stampMeta(t); return true; },
  progressMismatch: () => { const t = S.DB.tasks.find(x => !S.hasCheckpoints(x));
    if (!t) return false; t.status = 'todo'; t.progress = 60; S.stampMeta(t); return true; },
  doneWithOpenCp: () => { const m = S.DB.milestones.find(x => !x.deleted_at && x.done !== '1');
    if (!m) return false; const t = S.byId('task', m.task); if (!t) return false;
    t.status = 'done'; t.actual_date = dayOff(-1); S.stampMeta(t); return true; },
  noDateHasMs: () => { const m = S.DB.milestones.find(x => !x.deleted_at);
    if (!m) return false; const t = S.byId('task', m.task); if (!t) return false;
    t.plan_date = ''; t.status = 'doing'; S.stampMeta(t); return true; },
  noDate: () => { const t = S.DB.tasks.find(x => S.isOpen(x)); if (!t) return false; t.plan_date = ''; S.stampMeta(t); return true; },
};

const issuesOf = r => (r && r.issues) || [];
const countOf = (issues, k) => { const i = (issues || []).find(x => x.k === k); return i ? i.n : 0; };
/* 比数据时把 rev / updated_at / updated_by 摘掉：它们是"这次写入要压过同事那一份"的元数据，
   而撤销本身也是一次新的写入（见 undoLast），撤完这三样必然往前走。
   拿它们判"有没有回到修复前"会永远判红，真正要看的是业务字段的值。 */
const META = /^(rev|updated_at|updated_by|_dirtyFields|_dirtyAt)$/;
const biz = o => { const c = {}; Object.keys(o).forEach(k => { if (!META.test(k)) c[k] = o[k]; }); return c; };
const snapshotData = () => JSON.stringify({ tasks: S.DB.tasks.map(biz), works: S.DB.works.map(biz),
  duties: S.DB.duties.map(biz), milestones: S.DB.milestones.map(biz), purged: S.DB.purged });

// 报表口径那几条铁律（跟 sim17 同源，这里只取跟修复动作最相关的几条）
function reportInvariants(label) {
  const live = S.DB.tasks.filter(t => !t.deleted_at);
  const liveMs = S.DB.milestones.filter(m => !m.deleted_at && live.some(t => t.id === m.task));
  const cnt = new Map();
  liveMs.forEach(m => { if (!m.task) return; if (!cnt.has(m.task)) cnt.set(m.task, { t: 0, d: 0 });
    const c = cnt.get(m.task); c.t++; if (m.done === '1') c.d++; });
  const badProgress = live.filter(t => { const c = cnt.get(t.id); return c && c.t && Math.round(c.d / c.t * 100) !== (Number(t.progress) || 0); });
  ok('⑥修完之后进度仍然等于里程碑完成比例', badProgress.length === 0,
    { label, bad: badProgress.slice(0, 3).map(t => [t.id, t.progress, cnt.get(t.id)]) });
  const buckets = S.dueBuckets(live);
  ok('⑥修完之后到期分布各桶之和 === 还开着的任务数',
    buckets.reduce((a, b) => a + (b.n || 0), 0) === live.filter(S.isOpen).length, { label });
  const st = S.taskStatusBreakdown(live);
  ok('⑥修完之后状态四类之和 === 任务数', st.done + st.doing + st.todo + st.late === live.length, { label });
}

async function main() {
  await tick(150);
  console.log(`数据体检修复的性质验证：ROUNDS=${ROUNDS} SEED=${SEED}\n`);
  const kinds = Object.keys(PLANT).filter(k => !ONLY || k === ONLY);

  for (let round = 1; round <= ROUNDS; round++) {
    for (const kind of kinds) {
      baseWorld();
      if (!PLANT[kind]()) continue;
      S.rebuildIndex();
      const label = `第${round}轮 ${kind}`;
      const before = issuesOf(S.healthCheck());
      const n0 = countOf(before, kind);
      if (!n0) continue;                       // 这一轮没造出来（被底噪冲掉了），跳过
      const meta = S.healthMeta(kind);
      const dataBefore = snapshotData();
      const logsBefore = (S.DB.changelog || []).length;
      const auditBefore = S.auditByChangelog().length;
      const canFix = !!(before.find(x => x.k === kind) || {}).fix;
      if (!canFix) continue;                   // info 级：本来就没有"修复"这回事

      await S.fixHealth(kind);
      await tick(40);
      const after = issuesOf(S.healthCheck());

      // ① 这一项必须归零
      ok(`①「${kind}」修完之后这一项归零`, countOf(after, kind) === 0, { label, before: n0, after: countOf(after, kind) });
      // ② 别的项不许变多
      const worse = [];
      /* 有一对是按设计发生的，不算"制造新问题"：孤儿任务（指向的工作已经不存在）修完就是"未归属"，
         而"未归属"本身是体检里的提示项（noWork，只提示不修）。这正是这条修复声称要做的事。 */
      const BY_DESIGN = { orphanTask: ['noWork'] };
      after.forEach(x => {
        if (x.k === kind || (BY_DESIGN[kind] || []).includes(x.k)) return;
        if (x.n > countOf(before, x.k)) worse.push([x.k, countOf(before, x.k), x.n]);
      });
      ok(`②「${kind}」修复不制造新问题`, worse.length === 0, { label, worse });
      // ④ 留痕
      const changedData = snapshotData() !== dataBefore;
      ok(`④「${kind}」动了数据就留得下记录`, !changedData || (S.DB.changelog || []).length > logsBefore,
        { label, changedData, logs: (S.DB.changelog || []).length - logsBefore });
      /* ⑦ 修复不许制造新的"对不上"（P133 这一轮的正题）
         体检和「按日志核对数据」是同一个管理员手里的两个按钮。体检改了数据却不留痕，
         核对就会把这些格子报成"日志说 A、现在 B"，管理员一点"按日志修复"，
         体检刚修好的原样退回去，下一次体检再报同一条——两个工具来回拉锯。 */
      const auditAfter = S.auditByChangelog();
      ok(`⑦「${kind}」修完之后「按日志核对」不会多报对不上`, auditAfter.length <= auditBefore,
        { label, before: auditBefore, after: auditAfter.length,
          样本: auditAfter.slice(0, 3).map(i => [i.entity, i.id, i.field, i.to, i.now]) });
      // ⑥ 报表口径
      reportInvariants(label);
      // ③ 幂等
      const dataAfter = snapshotData();
      const logsAfter = (S.DB.changelog || []).length;
      await S.fixHealth(kind);
      await tick(40);
      ok(`③「${kind}」再修一次不会再动数据`, snapshotData() === dataAfter, { label });
      // 没修到东西就不该留下记录，否则每点一次体检都往变更记录里塞一条，把真正的历史挤掉
      ok(`③「${kind}」再修一次也不会再留下记录`, (S.DB.changelog || []).length === logsAfter,
        { label, 多出来的记录: (S.DB.changelog || []).slice(logsAfter).map(e => e.summary) });
      // ⑤ 可撤销的要真能撤
      if (meta.undoable && changedData) {
        // 注意：上面多跑了一次"幂等"修复，撤销栈里压着两次快照，撤两次才回到修复前
        await S.undoLast(); await tick(60);
        await S.undoLast(); await tick(60);
        ok(`⑤「${kind}」声明可撤销，Ctrl+Z 之后确实回到了修复前`, snapshotData() === dataBefore,
          { label, sameAsAfter: snapshotData() === dataAfter });
        /* 撤销把数据退回去了，修复留下的那些记录也得跟着撤掉，否则核对反过来报
           「日志说改了、现在却没改」——留痕和撤销必须是同一笔账的两面 */
        ok(`⑤「${kind}」撤销之后「按日志核对」也不会多报`, S.auditByChangelog().length <= auditBefore,
          { label, before: auditBefore, after: S.auditByChangelog().map(i => [i.entity, i.id, i.field, i.to, i.now]).slice(0, 3) });
      }
    }
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('仿真异常：', e); process.exit(1); });
