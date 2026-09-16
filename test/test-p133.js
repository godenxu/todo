/* P133：第四十一轮排查——数据体检改了数据，却什么都没记下来

   数据体检是管理员手里唯一一个"一键改几百条"的按钮。这一轮把它的每一种修复逐个验：
   修完这一项要归零、不许制造新问题、再点一次不许再动数据、动了数据要留得下记录、
   声明可撤销的要真能撤、修完报表口径不许歪（见 sim/sim18.js，共 7 条性质）。

   查出三处，是同一类毛病：

   ① ★体检的六种修复一个字都不记。
      清空指向已不存在工作的任务、跟随删除任务和里程碑、顺延和补填计划完成日期、清理重复里程碑——
      管理员点一下，几十上百条数据就改了，事后翻变更记录什么也查不到。
      更要紧的是它跟「按日志核对数据」正面打架：核对拿每一格【最后一条日志】比现在的值，
      这些悄悄改掉的格子只要以前有过日志（处里的任务日期、状态几乎都被人改过），
      就会被报成「日志说 A、现在 B」；管理员一点「按日志修复」，体检刚修好的原样退回去，
      下一次体检再报同一条——两个工具来回拉锯，数据在中间被反复改。

   ② ★清重复任务/工作那两条汇总日志没带覆盖范围。
      软删除改掉的 deleted_at 那一格没有逐条明细，核对照样报「日志说没删、现在却删了」，
      一键修复又把刚清掉的重复记录捞回来。

   ③ ★里程碑批量留痕超过 8 条时退回的那句汇总也没带覆盖范围。
      P128 专门修过这一幕（把已完成任务名下的里程碑自动勾完，核对全报对不上、一键修复又改回未交付），
      但那次只堵住了"条数不多"这条路；一条任务名下超过 8 个里程碑，同一幕原样重演。

   顺带一处：没修到东西也会写一句「清理了 0 条重复任务」，体检按钮点几次就往变更记录里塞几条，
   日志到了上限会把真正的历史挤出去。

   用法：node test/test-p133.js */
const path = require('path');
const { sandbox: S, raw } = require(path.join(__dirname, 'harness.js'));
const fs = require('fs');
const SRC = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const d2 = n => String(n).padStart(2, '0');
const dayOff = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())}`; };

/* 一份干净的小世界。histFields 决定给哪些格子留下"以前有人改过"的日志——
   核对就是拿这些日志比现在的值，没有它们，体检改掉什么核对都不会吭声。 */
function world() {
  S.closeModal();
  S.DB.settings.me = '管理员';
  S.DB.users = [{ name: '管理员', role: 'admin', salt: 's', hash: 'h', iterations: 1, rev: 1,
    created_at: ago(9999), updated_at: ago(9999), updated_by: '管理员' }];
  S.DB.permissionMatrix = null;
  S.DB.purged = [];
  S.DB.changelog = [];
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一', owner: '管理员', year: new Date().getFullYear(), status: 'doing' }))];
  S.DB.tasks = [];
  S.DB.milestones = [];
  S.rebuildIndex();
}
const addTask = o => { const t = S.stampMeta(S.blank('task', Object.assign({ work: 'w1', owner: '管理员', assignees: [], status: 'doing', progress: 0, plan_date: dayOff(10) }, o))); S.DB.tasks.push(t); return t; };
const addMs = o => { const m = S.stampMeta(S.blank('milestone', Object.assign({ plan_date: dayOff(5), report_level: 'section', done: '0' }, o))); S.DB.milestones.push(m); return m; };
const hist = (entity, id, taskId, changes) => S.DB.changelog.push({ id: 'H' + S.DB.changelog.length, kind: 'edit',
  entity, refId: id, taskId, at: ago(90), by: '管理员', summary: '（历史修改）', changes });
const logsSince = n => (S.DB.changelog || []).slice(n);

async function main() {
  await tick(200);

  /* ① 六种以前一个字都不记的修复，现在都留得下记录，而且核对不会因此多报 */
  section('① 体检的每一种修复都留得下记录，核对也不会因此多报对不上');
  const CASES = {
    noDateHasMs: () => {
      const t = addTask({ id: 'T1', code: '01011', title: '任务一', plan_date: '' });
      addMs({ id: 'M1', task: t.id, deliverable: '交付物一', plan_date: dayOff(20) });
      hist('task', 'T1', 'T1', [{ k: 'plan_date', from: dayOff(3), to: '' }]);
    },
    msLateThanTask: () => {
      const t = addTask({ id: 'T1', code: '01011', title: '任务一', plan_date: dayOff(2) });
      addMs({ id: 'M1', task: t.id, deliverable: '交付物一', plan_date: dayOff(40) });
      hist('task', 'T1', 'T1', [{ k: 'plan_date', from: dayOff(1), to: dayOff(2) }]);
    },
    orphanTask: () => {
      addTask({ id: 'T1', code: '01011', title: '任务一', work: 'w_已经不在了' });
      hist('task', 'T1', 'T1', [{ k: 'work', from: '', to: 'w_已经不在了' }]);
    },
    taskOfDeletedWork: () => {
      const t = addTask({ id: 'T1', code: '01011', title: '任务一' });
      addMs({ id: 'M1', task: t.id, deliverable: '交付物一' });
      S.DB.works[0].deleted_at = ago(30); S.stampMeta(S.DB.works[0]);
      hist('task', 'T1', 'T1', [{ k: 'deleted_at', from: ago(100), to: '' }]);
      hist('milestone', 'M1', 'T1', [{ k: 'deleted_at', from: ago(100), to: '' }]);
    },
    msOfDeletedTask: () => {
      const t = addTask({ id: 'T1', code: '01011', title: '任务一' });
      addMs({ id: 'M1', task: t.id, deliverable: '交付物一' });
      t.deleted_at = ago(30); S.stampMeta(t);
      hist('milestone', 'M1', 'T1', [{ k: 'deleted_at', from: ago(100), to: '' }]);
    },
    dupMs: () => {
      const t = addTask({ id: 'T1', code: '01011', title: '任务一' });
      addMs({ id: 'M1', task: t.id, deliverable: '交付物一', plan_date: dayOff(5) });
      addMs({ id: 'M2', task: t.id, deliverable: '交付物一', plan_date: dayOff(5) });
      hist('milestone', 'M2', 'T1', [{ k: 'deleted_at', from: ago(100), to: '' }]);
    },
    dupTask: () => {
      addTask({ id: 'T1', code: '01011', title: '任务一' });
      addTask({ id: 'T2', code: '010119', title: '任务一' });
      hist('task', 'T2', 'T2', [{ k: 'deleted_at', from: ago(100), to: '' }]);
    },
  };
  for (const kind of Object.keys(CASES)) {
    world(); CASES[kind](); S.rebuildIndex();
    const n0 = S.DB.changelog.length;
    const auditBefore = S.auditByChangelog().length;
    const before = JSON.stringify({ t: S.DB.tasks, m: S.DB.milestones, w: S.DB.works });
    await S.fixHealth(kind); await tick(40);
    const changed = JSON.stringify({ t: S.DB.tasks, m: S.DB.milestones, w: S.DB.works }) !== before;
    ok(`★「${kind}」改了数据就留得下记录`, changed && logsSince(n0).length > 0,
      { 改了数据: changed, 新增记录: logsSince(n0).map(e => e.summary) });
    const auditAfter = S.auditByChangelog();
    ok(`★「${kind}」修完之后「按日志核对」不会多报对不上`, auditAfter.length <= auditBefore,
      { 修复前: auditBefore, 修复后: auditAfter.map(i => [i.entity, i.id, i.field, i.to, i.now]) });
  }

  /* ② 拉锯：体检修好 → 核对报异常 → 一键修复退回去 → 体检再报。必须不再发生 */
  section('② 体检和「按日志核对」不再互相拆台');
  world();
  const t1 = addTask({ id: 'T1', code: '01011', title: '任务一', plan_date: '' });
  addMs({ id: 'M1', task: t1.id, deliverable: '交付物一', plan_date: dayOff(25) });
  hist('task', 'T1', 'T1', [{ k: 'plan_date', from: dayOff(3), to: '' }]);
  S.rebuildIndex();
  await S.fixHealth('noDateHasMs'); await tick(40);
  const fixedDate = S.byId('task', 'T1').plan_date;
  const issues = S.auditByChangelog();
  const repairable = S.repairableIssues(issues);
  ok('★体检补上日期之后，核对里没有它可修的条目', repairable.length === 0,
    repairable.map(i => [i.entity, i.id, i.field, i.to, i.now]));
  if (repairable.length) { await S.repairByChangelog(repairable); await tick(40); }
  ok('★一键「按日志修复」不会把体检补上的日期退回去', S.byId('task', 'T1').plan_date === fixedDate,
    { 体检补成: fixedDate, 现在: S.byId('task', 'T1').plan_date });
  ok('★体检也不会再报同一条', (S.healthCheck().issues.find(x => x.k === 'noDateHasMs') || {}).n === undefined);

  /* ③ 里程碑批量留痕超过上限那条路（P128 只堵住了"条数不多"的一半） */
  section('③ 一次勾完十几个里程碑，核对同样不许报对不上');
  world();
  const t2 = addTask({ id: 'T1', code: '01011', title: '已完成任务', status: 'done', progress: 100, actual_date: dayOff(-1) });
  for (let i = 1; i <= 12; i++) {
    addMs({ id: 'M' + i, task: t2.id, deliverable: '交付物' + i, plan_date: dayOff(i % 9 + 1) });
    hist('milestone', 'M' + i, 'T1', [{ k: 'done', from: '1', to: '0' }]);
  }
  S.rebuildIndex();
  const n1 = S.DB.changelog.length;
  await S.fixHealth('doneWithOpenCp'); await tick(40);
  ok('★12 个里程碑一次勾完，全都标成了已交付', S.DB.milestones.filter(m => m.done === '1').length === 12);
  ok('★这批改动在变更记录里有覆盖范围可查', logsSince(n1).some(e => e.scope && e.scope.entity === 'milestone'),
    logsSince(n1).map(e => [e.summary, !!e.scope]));
  const iss3 = S.auditByChangelog();
  ok('★核对不报这 12 条对不上', iss3.length === 0, iss3.slice(0, 3).map(i => [i.entity, i.id, i.field, i.to, i.now]));

  /* ④ 逐条明细要写对：改前改后必须是真的改前改后，核对才比得准 */
  section('④ 逐条明细里的「改前 / 改后」是真的');
  world();
  const t3 = addTask({ id: 'T1', code: '01011', title: '任务一', plan_date: '' });
  addMs({ id: 'M1', task: t3.id, deliverable: '交付物一', plan_date: dayOff(15) });
  S.rebuildIndex();
  const n2 = S.DB.changelog.length;
  await S.fixHealth('noDateHasMs'); await tick(40);
  const det = logsSince(n2).find(e => Array.isArray(e.changes) && e.changes.some(c => c.k === 'plan_date'));
  ok('★逐条明细记下了这一格的改前改后', !!det && det.changes[0].from === '' && det.changes[0].to === dayOff(15),
    det && det.changes);
  ok('★这条记录挂在这条任务上（任务详情的变更历史里查得到）', !!det && (det.refId === 'T1' || det.taskId === 'T1'));

  /* ⑤ 条数多就退回汇总，但必须带覆盖范围；条数少就逐条 */
  section('⑤ 条数多退回汇总（带覆盖范围），条数少逐条记');
  world();
  for (let i = 1; i <= 20; i++) {
    addTask({ id: 'T' + i, code: '0101' + i, title: '任务' + i, work: 'w_已经不在了' });
    hist('task', 'T' + i, 'T' + i, [{ k: 'work', from: '', to: 'w_已经不在了' }]);
  }
  S.rebuildIndex();
  const n3 = S.DB.changelog.length;
  await S.fixHealth('orphanTask'); await tick(40);
  const many = logsSince(n3);
  ok('★20 条一次修完只写一句汇总，不刷屏', many.length === 1, many.map(e => e.summary));
  ok('★这句汇总带着覆盖范围（核对靠它认出这批）', !!(many[0] && many[0].scope && many[0].scope.ids && many[0].scope.ids.length === 20),
    many[0] && many[0].scope);
  // 范围里的字段也要对得上真改的那一格，写错字段等于没写（核对照样把这 20 条全报出来）
  const iss5 = S.auditByChangelog();
  ok('★核对认得出这批，一条都不报', iss5.length === 0, iss5.slice(0, 3).map(i => [i.entity, i.id, i.field, i.to, i.now]));
  world();
  for (let i = 1; i <= 3; i++) addTask({ id: 'T' + i, code: '0101' + i, title: '任务' + i, work: 'w_已经不在了' });
  S.rebuildIndex();
  const n4 = S.DB.changelog.length;
  await S.fixHealth('orphanTask'); await tick(40);
  ok('★3 条就逐条记，每条都带明细', logsSince(n4).length === 3 && logsSince(n4).every(e => Array.isArray(e.changes)),
    logsSince(n4).map(e => [e.refId, e.summary]));

  /* ⑥ 没修到东西就不许留下记录 */
  section('⑥ 没修到东西就不留记录');
  for (const kind of ['dupTask', 'dupWork', 'orphanTask', 'noDateHasMs', 'dupMs']) {
    world();
    addTask({ id: 'T1', code: '01011', title: '任务一' });
    S.rebuildIndex();
    const n5 = S.DB.changelog.length;
    await S.fixHealth(kind); await tick(30);
    ok(`★「${kind}」没修到东西，一条记录都不写`, logsSince(n5).length === 0, logsSince(n5).map(e => e.summary));
  }

  /* ⑦ 静态清点：将来再往 fixHealth 里加分支，不许再出现"改了数据却不记"的那一种 */
  section('⑦ 静态清点：fixHealth 里每个会改数据的分支都要留痕');
  {
    const body = SRC.slice(SRC.indexOf('async function fixHealth(kind)'));
    const end = body.indexOf('\r\n}\r\n');
    const fn = body.slice(0, end > 0 ? end : 4000);
    const MUT = /=\s|deleted_at|softDelete|cascade|recalcProgress|reconcile|completeCheckpoints/;
    const LOG = /pushChangeLog|logHealthFix|logRecordChange|logMilestoneChanges/;
    const lines = fn.split('\r\n');
    const bad = [];
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/if \(kind === '([a-zA-Z]+)'\)/);
      if (!m) continue;
      n++;
      // 从这一行往下取到下一个分支为止，就是这个分支的全部代码
      let j = i + 1;
      while (j < lines.length && !/if \(kind === '/.test(lines[j])) j++;
      const seg = lines.slice(i, j).join('\n');
      if (MUT.test(seg) && !LOG.test(seg)) bad.push(m[1]);
    }
    ok(`★fixHealth 的 ${n} 个分支，凡是会改数据的都带着留痕`, bad.length === 0 && n >= 10, { 没留痕的: bad, 分支数: n });
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
