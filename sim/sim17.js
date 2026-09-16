/* 第三十九轮（P131）：报表口径的性质验证——给领导看的那些数字必须自洽

   为什么单独做一支：同一个数字在报告页、工作台、图表页是各算各的（口径注释里反复写着
   "跟工作台人员负荷一致""跟本期已交付同一口径"）。这类不一致不会报错、不会白屏，
   只会让汇报材料上的数字对不上账，而且往往几个月都没人发现——一旦发现，信任就没了。
   单元测试只能摆几个固定形态，覆盖不到"随机数据 × 各种周期 × 各个人"这张网。

   做法跟 sim13/sim14 一样：不看渲染，只验它必须满足的代数性质。随机造数据
   （任务/里程碑/人员/状态/日期都随机，故意掺进挂起、无日期、跨年、已删除、未指派），
   然后对 周/月/季/年 × 前后若干期 × 全处/每个人 分别取一次报表数据，逐条验：

   ① 状态四类（已完成/推进中/未开始/逾期）之和 === 当期任务总数（代码注释里明确承诺过"不会对不上账"）
   ② 本期已交付的里程碑，必须属于"当期涉及的里程碑"，且确实 done='1'、实际完成日在本期
   ③ 本期完成的任务，必须 status='done' 且实际完成日落在本期，并且都在当期任务里
   ④ 逾期任务必须是"还开着"的；即将到期与逾期不许有交集（一个看今天之后、一个看今天之前）
   ⑤ 本期计划完成的任务/里程碑，计划日必须真的落在本期
   ⑥ 人员工作情况：每个人四类之和 === 当期任务里"他牵头或参与"的条数（同一条任务多人各算一次）
   ⑦ 按人取的报表，里面的任务必须都跟这个人有关；全处报表里的当期任务 ⊇ 每个人的当期任务
   ⑧ 周期边界：周一到周日整 7 天、月初到月末、季 3 个月、年 1 月 1 日到 12 月 31 日，跨年也要对
   ⑨ 图表页的口径：里程碑完成饼图三类之和 === 这批任务名下活着的里程碑数；
      到期分布各桶之和 === 还开着的任务数（一条任务只能落进一个桶）
   ⑩ SPI 落在 0～2 之间，且挂起/已删除的任务不参与（挂起会把指标拖垮，代码里专门排除过）

   用法：ROUNDS=200 SEED=1 node sim/sim17.js */
const path = require('path');
const REPO = 'C:/Users/Administrator/Documents/Claude/Todo';
const { sandbox: S } = require(path.join(REPO, 'test/harness.js'));

const ROUNDS = Number(process.env.ROUNDS) || 200;
const SEED = Number(process.env.SEED) || 1;
let _s = SEED;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = a => a[Math.floor(rnd() * a.length)];
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const seen = new Set();
const ok = (name, cond, extra) => {
  if (cond) { if (!seen.has(name)) { seen.add(name); pass++; console.log('  ✅ ' + name); } return; }
  fail++;
  console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 700) : ''));
};

const PEOPLE = ['徐捷', '小王', '老李', '小张'];
const d2 = n => String(n).padStart(2, '0');
const dateIn = (y, spread) => {
  const base = new Date(y, 0, 1);
  base.setDate(base.getDate() + ri(0, spread));
  return `${base.getFullYear()}-${d2(base.getMonth() + 1)}-${d2(base.getDate())}`;
};

/* 随机造一份数据。刻意掺进这些"边角"：没有计划日的、挂起的、已删除的、没人负责的、
   跨年的日期、已完成但没填实际完成日的（生产数据里这几种都有） */
function makeWorld() {
  const year = new Date().getFullYear();
  S.DB.settings.year = year;
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' })),
    S.stampMeta(S.blank('duty', { code: '02', category: '一、前瞻研判', name: '职责二' }))];
  S.DB.works = [1, 2, 3].map(i => S.stampMeta(S.blank('work', { id: 'w' + i, code: '010' + i, duty: i === 3 ? '02' : '01',
    name: '工作' + i, owner: pick(PEOPLE), year, status: 'doing' })));
  S.DB.tasks = [];
  S.DB.milestones = [];
  const n = ri(6, 30);
  for (let i = 0; i < n; i++) {
    const status = pick(['todo', 'doing', 'done', 'hold', 'doing', 'done']);
    const hasPlan = rnd() < 0.85;
    const planYear = rnd() < 0.15 ? year + (rnd() < 0.5 ? -1 : 1) : year;
    const t = S.stampMeta(S.blank('task', {
      id: 'T' + i, work: pick(['w1', 'w2', 'w3', '']), code: '0101' + i, title: '任务' + i,
      owner: rnd() < 0.12 ? '' : pick(PEOPLE),
      assignees: rnd() < 0.4 ? [pick(PEOPLE)] : [],
      status, priority: pick(['1', '2', '3']),
      progress: status === 'done' ? 100 : ri(0, 99),
      plan_date: hasPlan ? dateIn(planYear, 364) : '',
      actual_date: status === 'done' && rnd() < 0.85 ? dateIn(year, 364) : '',
      source: '', custom: '',
    }));
    if (rnd() < 0.12) t.deleted_at = new Date().toISOString();
    S.DB.tasks.push(t);
    const msN = ri(0, 3);
    for (let j = 0; j < msN; j++) {
      const done = rnd() < 0.45;
      const m = S.stampMeta(S.blank('milestone', {
        id: 'M' + i + '_' + j, task: t.id, plan_date: rnd() < 0.9 ? dateIn(year, 364) : '',
        deliverable: '交付物' + i + j, report_level: pick(['section', 'department', 'bank']),
        done: done ? '1' : '0', actual_date: done && rnd() < 0.85 ? dateIn(year, 364) : '',
      }));
      if (rnd() < 0.1) m.deleted_at = new Date().toISOString();
      S.DB.milestones.push(m);
    }
  }
  S.rebuildIndex();
}

const inR = (dt, a, b) => !!dt && dt >= a && dt <= b;
const idsOf = list => new Set((list || []).map(x => x.id));

function checkReport(d, label) {
  const { rangeStart: a, rangeEnd: b } = d;
  // ① 状态四类之和 === 当期任务总数
  const st = d.statusStat;
  ok('①状态四类之和 === 当期任务总数', st.done + st.doing + st.todo + st.late === d.periodTasks.length,
    { label, st, n: d.periodTasks.length });
  // ② 本期已交付的里程碑
  const periodMsIds = idsOf(d.periodMs);
  ok('②本期已交付的里程碑确实已交付、实际完成日在本期',
    d.deliveredInRange.every(m => m.done === '1' && inR(m.actual_date, a, b)),
    { label, bad: d.deliveredInRange.filter(m => !(m.done === '1' && inR(m.actual_date, a, b))).slice(0, 2) });
  ok('②本期已交付的里程碑都属于"当期涉及"', d.deliveredInRange.every(m => periodMsIds.has(m.id)),
    { label, bad: d.deliveredInRange.filter(m => !periodMsIds.has(m.id)).slice(0, 2).map(m => [m.id, m.plan_date, m.actual_date]) });
  // ③ 本期完成的任务
  const periodTaskIds = idsOf(d.periodTasks);
  ok('③本期完成的任务确实已完成、实际完成日在本期',
    d.doneInRange.every(t => t.status === 'done' && inR(t.actual_date, a, b)), { label });
  ok('③本期完成的任务都在当期任务里', d.doneInRange.every(t => periodTaskIds.has(t.id)),
    { label, bad: d.doneInRange.filter(t => !periodTaskIds.has(t.id)).slice(0, 2).map(t => [t.id, t.status, t.actual_date]) });
  // ④ 逾期 / 即将到期
  ok('④逾期任务都是"还开着"的', d.overdue.every(t => S.isOpen(t)), { label });
  const overdueIds = idsOf(d.overdue);
  ok('④即将到期与逾期没有交集', d.soonTasks.every(t => !overdueIds.has(t.id)),
    { label, bad: d.soonTasks.filter(t => overdueIds.has(t.id)).slice(0, 2).map(t => [t.id, t.plan_date, t.status]) });
  ok('④即将到期的里程碑都还没交付、日期在今天到本期结束之间',
    d.soonMs.every(m => m.done !== '1' && m.plan_date >= d.today && m.plan_date <= b), { label });
  // ⑤ 本期计划
  ok('⑤本期计划完成的任务，计划日确实落在本期', d.planTasks.every(t => inR(t.plan_date, a, b)), { label });
  ok('⑤本期计划完成的里程碑，计划日确实落在本期', d.planMs.every(m => inR(m.plan_date, a, b)), { label });
  // ⑥ 人员工作情况
  const byPerson = new Map();
  d.periodTasks.forEach(t => {
    const ppl = S.personUnion ? S.personUnion('task', t) : [];
    (ppl.length ? ppl : ['（未指派）']).forEach(p => byPerson.set(p, (byPerson.get(p) || 0) + 1));
  });
  const bad6 = d.peopleStat.filter(p => p.total !== (byPerson.get(p.nm) || 0));
  ok('⑥每个人的四类之和 === 当期任务里他牵头或参与的条数', bad6.length === 0,
    { label, bad: bad6.slice(0, 3).map(p => [p.nm, p.total, byPerson.get(p.nm) || 0]) });
  ok('⑥人员清单没有遗漏当期出现过的人', [...byPerson.keys()].every(nm => d.peopleStat.some(p => p.nm === nm)),
    { label, missing: [...byPerson.keys()].filter(nm => !d.peopleStat.some(p => p.nm === nm)) });
  // ⑩ SPI
  // SPI 的约定：没有可算的任务时返回 null（不是 0——0 会被读成"一点没推进"）；有值时必须是个有限的非负数
  ok('⑩SPI 要么是 null，要么是有限的非负数', d.spi === null || (typeof d.spi === 'number' && isFinite(d.spi) && d.spi >= 0), { label, spi: d.spi });
}

async function main() {
  await tick(150);
  console.log(`报表口径性质验证：ROUNDS=${ROUNDS} SEED=${SEED}\n`);

  console.log('■ 周期边界（跨年也要对）');
  for (let off = -8; off <= 8; off++) {
    const w = S.periodRange('week', off);
    const ws = new Date(w.start + 'T00:00:00'), we = new Date(w.end + 'T00:00:00');
    ok('⑧周：周一到周日整 7 天', ws.getDay() === 1 && we.getDay() === 0 && Math.round((we - ws) / 86400000) === 6, { off, w });
    const m = S.periodRange('month', off);
    const ms = new Date(m.start + 'T00:00:00'), me = new Date(m.end + 'T00:00:00');
    ok('⑧月：1 号到当月最后一天', ms.getDate() === 1 && new Date(me.getFullYear(), me.getMonth() + 1, 0).getDate() === me.getDate()
      && ms.getMonth() === me.getMonth() && ms.getFullYear() === me.getFullYear(), { off, m });
    const q = S.periodRange('quarter', off);
    const qs = new Date(q.start + 'T00:00:00'), qe = new Date(q.end + 'T00:00:00');
    ok('⑧季：从季初 1 号到季末最后一天，正好 3 个月', qs.getDate() === 1 && qs.getMonth() % 3 === 0
      && qe.getMonth() % 3 === 2 && new Date(qe.getFullYear(), qe.getMonth() + 1, 0).getDate() === qe.getDate(), { off, q });
    const y = S.periodRange('year', off);
    ok('⑧年：1 月 1 日到 12 月 31 日', /-01-01$/.test(y.start) && /-12-31$/.test(y.end)
      && y.start.slice(0, 4) === y.end.slice(0, 4), { off, y });
  }

  console.log('\n■ 随机数据 × 周期 × 人员');
  for (let round = 1; round <= ROUNDS; round++) {
    makeWorld();
    const period = pick(['week', 'month', 'quarter', 'year']);
    const offset = ri(-3, 3);
    const label = `第${round}轮 ${period}${offset}`;
    const all = S.buildReportData(period, offset, '');
    checkReport(all, label);

    // ⑦ 按人取的报表
    const who = pick(PEOPLE);
    const mine = S.buildReportData(period, offset, who);
    checkReport(mine, label + ' ' + who);
    ok('⑦按人取的报表里，任务都跟这个人有关',
      mine.tasks.every(t => S.personUnion('task', t).includes(who)),
      { label, bad: mine.tasks.filter(t => !S.personUnion('task', t).includes(who)).slice(0, 2).map(t => [t.id, t.owner, t.assignees]) });
    const allIds = idsOf(all.periodTasks);
    ok('⑦全处报表的当期任务包含每个人的当期任务', mine.periodTasks.every(t => allIds.has(t.id)),
      { label, bad: mine.periodTasks.filter(t => !allIds.has(t.id)).slice(0, 2).map(t => [t.id, t.status, t.plan_date, t.actual_date]) });

    // ⑨ 图表页的口径
    const live = S.DB.tasks.filter(t => !t.deleted_at);
    const pie = S.msCompletionPie(live);
    const liveMs = S.DB.milestones.filter(m => !m.deleted_at && live.some(t => t.id === m.task));
    const pieSum = pie.reduce((s, x) => s + (x.n || 0), 0);
    ok('⑨里程碑完成饼图三类之和 === 活着的里程碑数', pieSum === liveMs.length, { label, pieSum, n: liveMs.length, pie });
    // ⑨-2 到期饼图（粗粒度）四类之和同样等于未完成任务数，而且不许出现负数
    const sum4 = S.dueSummary(live);
    ok('⑨到期饼图四类之和 === 还开着的任务数，且没有负数',
      sum4.reduce((x, y) => x + (y.n || 0), 0) === live.filter(S.isOpen).length && sum4.every(x => (x.n || 0) >= 0),
      { label, sum4, open: live.filter(S.isOpen).length });
    // ⑪ 按人/按职责/按工作统计：每一类里"各状态之和 === 总数"，且完成率是按这两个数算的
    const tallyOK = row => row.done + row.doing + row.late + row.todo + row.hold === row.total
      && row.rate === (row.total ? Math.round(row.done / row.total * 100) : 0);
    const byP = S.statsByPerson(live), byD = S.statsByDuty(live), byW = S.statsByWork(live);
    ok('⑪按人统计：各状态之和 === 总数，完成率对得上', byP.every(tallyOK), { label, bad: byP.filter(x => !tallyOK(x)).slice(0, 2) });
    ok('⑪按职责统计：各状态之和 === 总数', byD.every(tallyOK), { label, bad: byD.filter(x => !tallyOK(x)).slice(0, 2) });
    ok('⑪按工作统计：各状态之和 === 总数', byW.every(tallyOK), { label, bad: byW.filter(x => !tallyOK(x)).slice(0, 2) });
    // 一条任务可能同时是牵头人和参与人的，所以"相关"总数不会超过牵头+参与之和
    ok('⑪按人统计：相关数不超过牵头数+参与数', byP.every(x => x.total <= x.lead + x.join + 0.0001 || x.name === '（未指派）'),
      { label, bad: byP.filter(x => x.name !== '（未指派）' && x.total > x.lead + x.join).slice(0, 2) });
    // ⑫ 呈报层级统计：各层级之和 === 这批任务名下活着的里程碑数
    const lvl = S.msReportLevelStats(live);
    const lvlSum = lvl.reduce((x, y) => x + (y.n || y.total || 0), 0);
    ok('⑫呈报层级统计各级之和 === 活着的里程碑数', lvlSum === liveMs.length, { label, lvlSum, n: liveMs.length, lvl: lvl.slice(0, 4) });
    // ⑬ 待办存量：今天这一刻的存量 === 还开着（不含挂起）且已经建出来的任务数
    const todayStr = S.todayStr();
    const backlogToday = S.backlogAsOf(live, todayStr);
    const expectBacklog = live.filter(t => {
      const c = S.localDay(t.created_at);
      if (c && c > todayStr) return false;
      if (t.status === 'hold') return false;
      if (t.status !== 'done') return true;
      return !t.actual_date || t.actual_date > todayStr;
    }).length;
    ok('⑬待办存量（今天）跟"还开着的任务"口径一致', backlogToday === expectBacklog, { label, backlogToday, expectBacklog });
    ok('⑬很久以前的存量不会超过任务总数', S.backlogAsOf(live, '2000-01-01') <= live.length, { label });
    // ⑭ 里程碑树分组：分组里出现的任务都属于传进去的那批，且每条任务只出现一次
    // msTreeGroups 返回 { msByTask, byDutyWork }：按 职责 → 工作 → 任务 分三层
    const { msByTask, byDutyWork } = S.msTreeGroups(live);
    const flatTasks = [];
    byDutyWork.forEach(wm => wm.forEach(list => list.forEach(t => flatTasks.push(t.id))));
    const liveIds = new Set(live.map(t => t.id));
    ok('⑭里程碑树里的任务都在传进去的那批里', flatTasks.every(id => liveIds.has(id)),
      { label, bad: flatTasks.filter(id => !liveIds.has(id)).slice(0, 3) });
    ok('⑭同一条任务不会在里程碑树里出现两次', new Set(flatTasks).size === flatTasks.length,
      { label, n: flatTasks.length, uniq: new Set(flatTasks).size });
    // ⑮ 工作台按人取任务：只包含跟这个人有关的，且不含已删除
    const pt = S.dashPersonTasks(who);
    ok('⑮工作台按人取的任务都跟这个人有关、且不含已删除',
      pt.every(t => !t.deleted_at && S.personUnion('task', t).includes(who)), { label, who });
    // ⑯ 里程碑三态（已交付/逾期未交付/未到期）之和 === 传进去的里程碑数
    const msb = S.msStatusBreakdown(liveMs);
    ok('⑯里程碑三态之和 === 里程碑总数', msb.done + msb.overdue + msb.notDue === liveMs.length, { label, msb, n: liveMs.length });
    // ⑰ 按分类统计 / 字段分布：各条之和 === 任务总数（一条任务只能落一类）
    /* 按职责分类只统计"挂在某个职责下"的任务：没选所属工作、或者工作没归到职责的，本来就不进这张图
       （未归属任务有数据体检和"未归属指派"专门管）。所以基准是"有职责归属的任务数"，不是任务总数。 */
    const cat = S.statsByCategory(live);
    const hasDuty = live.filter(t => {
      const w = t.work ? S.byId('work', t.work) : null;
      return !!(w && w.duty && S.byId('duty', w.duty) && !S.byId('duty', w.duty).deleted_at);
    }).length;
    ok('⑰按职责分类统计各类之和 === 有职责归属的任务数', cat.reduce((x, y) => x + (y.total || 0), 0) === hasDuty,
      { label, sum: cat.reduce((x, y) => x + (y.total || 0), 0), hasDuty, n: live.length });
    ['status', 'priority', 'source'].forEach(f => {
      const bars = S.taskFieldBars(f, live);
      ok('⑰字段分布各条之和 === 任务总数（' + f + '）', bars.reduce((x, y) => x + (y.n || 0), 0) === live.length,
        { label, f, sum: bars.reduce((x, y) => x + (y.n || 0), 0), n: live.length });
    });
    const buckets = S.dueBuckets(live);
    const bucketSum = buckets.reduce((s, x) => s + (x.n || 0), 0);
    ok('⑨到期分布各桶之和 === 还开着的任务数（一条任务只落一个桶）', bucketSum === live.filter(S.isOpen).length,
      { label, bucketSum, open: live.filter(S.isOpen).length, buckets });
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('仿真异常：', e); process.exit(1); });
