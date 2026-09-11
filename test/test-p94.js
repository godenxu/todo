/* P94：第七轮排查——合并之后"由别条记录算出来的字段"没人重算
   任务进度是按它名下里程碑的完成比例算出来、然后存在任务记录上的。平时谁改里程碑谁重算，
   数字跟着任务记录一起同步出去，没问题。但合并会打破这个前提：
   甲、乙各给同一条任务加了一个里程碑，合并后这条任务名下有了双方的里程碑（对的），
   可任务上存的进度还是各自机器上按"只有自己那一份"算的旧值——两人都算 1/3=33%，
   合并后实际是 1/4=25%，谁都没错，结果就是错的。
   而且没有任何机制会纠正它：recalcProgress 只在任务详情保存、宽表导入、体检修复、
   启动迁移几处调用，全都不在同步路径上。这个错值还会顺着 computeSPI 污染
   工作台/报告页上给领导看的 SPI。
   用法：node test/test-p94.js */
const { sandbox: S } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));
const P = (tasks, milestones) => ({ duties: [], works: [], milestones: milestones || [], tasks,
  changelog: [], users: [], purged: [] });
const mk = (id, task, done) => ({ id, task, plan_date: '2026-09-10', deliverable: '交付物' + id,
  report_level: 'section', done, rev: 1, updated_at: '2026-09-05T01:00:00.000Z', updated_by: '某人' });

async function main() {
  await tick(60);
  const bakMe = S.DB.settings.me;
  S.DB.settings.me = '合并的这台机器';

  const T = { id: 'T', title: '任务', status: 'doing', progress: 50, assignees: [], work: 'W',
    rev: 5, updated_at: '2026-09-05T01:00:00.000Z', updated_by: '原作者', created_at: '2026-09-01T00:00:00.000Z' };

  section('①：★两个人各加一个里程碑，合并后进度必须按合并结果重算');
  const baseMap = { task: { T: cp(T) }, milestone: { M1: mk('M1', 'T', '1'), M2: mk('M2', 'T', '0') } };
  const 甲 = Object.assign(cp(T), { progress: 33, rev: 6, updated_at: '2026-09-05T02:00:00.000Z', updated_by: '甲' });
  const 乙 = Object.assign(cp(T), { progress: 33, rev: 6, updated_at: '2026-09-05T02:30:00.000Z', updated_by: '乙' });
  const merged = S.mergeSyncPayload(
    P([甲], [mk('M1', 'T', '1'), mk('M2', 'T', '0'), mk('M3', 'T', '0')]),
    P([乙], [mk('M1', 'T', '1'), mk('M2', 'T', '0'), mk('M4', 'T', '0')]), baseMap);
  ok('前置：四条里程碑都收进来了，其中 1 条已完成', merged.milestones.length === 4
    && merged.milestones.filter(m => m.done === '1').length === 1);
  ok('前置：重算之前进度是错的（各自机器算的 33%）', merged.tasks[0].progress === 33, merged.tasks[0].progress);
  const fixed = S.reconcileDerivedAfterMerge(merged);
  ok('★报告修正了 1 条', fixed === 1, fixed);
  ok('★★进度按合并后的里程碑重算成 25%（1/4）', merged.tasks[0].progress === 25, merged.tasks[0].progress);

  section('①：修正时不能顺手改掉别的东西');
  ok('★"最后修改人"保持原样——进度是算出来的，不是谁改的，记成合并的人会污染追责线索',
    merged.tasks[0].updated_by !== '合并的这台机器', merged.tasks[0].updated_by);
  ok('★状态没有被动（进度掉了不等于要把"已完成"打回去，那种判断交给数据体检）',
    merged.tasks[0].status === 'doing', merged.tasks[0].status);
  ok('★标题等其它字段原样保留', merged.tasks[0].title === '任务');

  section('②：★不能就地改"从文件里读出来的那个对象"（否则基线会记成错的，修正永远推不回文件）');
  const remotePayload = P([Object.assign(cp(T), { progress: 99 })], [mk('M1', 'T', '1'), mk('M2', 'T', '0')]);
  const remoteTaskObj = remotePayload.tasks[0];
  // 本机没改过这条 → 合并会直接沿用文件里那个对象
  const merged2 = S.mergeSyncPayload(P([cp(T)], [mk('M1', 'T', '1'), mk('M2', 'T', '0')]),
    remotePayload, { task: { T: cp(T) }, milestone: {} });
  S.reconcileDerivedAfterMerge(merged2);
  ok('★合并结果里的进度被修正了', merged2.tasks[0].progress === 50, merged2.tasks[0].progress);
  ok('★★但文件里读出来的那个对象没被改动（基线才会如实反映"文件里现在是什么"）',
    remoteTaskObj.progress === 99, remoteTaskObj.progress);

  section('③：该动的才动——不能误伤');
  const noMs = S.mergeSyncPayload(P([Object.assign(cp(T), { id: 'T2', progress: 70 })], []),
    P([Object.assign(cp(T), { id: 'T2', progress: 70 })], []), null);
  ok('★名下没有里程碑的任务，进度是手填的，一个字都不能碰', (S.reconcileDerivedAfterMerge(noMs), noMs.tasks[0].progress) === 70,
    noMs.tasks[0].progress);
  const delTask = P([Object.assign(cp(T), { deleted_at: '2026-09-05T00:00:00.000Z', progress: 88 })], [mk('M1', 'T', '1')]);
  S.reconcileDerivedAfterMerge(delTask);
  ok('★已删除的任务不参与重算', delTask.tasks[0].progress === 88, delTask.tasks[0].progress);
  const delMs = P([Object.assign(cp(T), { progress: 50 })],
    [mk('M1', 'T', '1'), Object.assign(mk('M2', 'T', '0'), { deleted_at: '2026-09-05T00:00:00.000Z' })]);
  S.reconcileDerivedAfterMerge(delMs);
  ok('★已删除的里程碑不算进分母（1 条有效、已完成 1 条 → 100%）', delMs.tasks[0].progress === 100, delMs.tasks[0].progress);
  const already = P([Object.assign(cp(T), { progress: 50 })], [mk('M1', 'T', '1'), mk('M2', 'T', '0')]);
  ok('★本来就是对的，不做无谓改动（返回 0，不会因此白写一次文件）', S.reconcileDerivedAfterMerge(already) === 0);

  section('④：幂等——同一份数据反复重算，结果稳定');
  const idem = P([Object.assign(cp(T), { progress: 0 })], [mk('M1', 'T', '1'), mk('M2', 'T', '0'), mk('M3', 'T', '1')]);
  const n1 = S.reconcileDerivedAfterMerge(idem);
  const p1 = idem.tasks[0].progress;
  const n2 = S.reconcileDerivedAfterMerge(idem);
  ok('★第一次修正了', n1 === 1 && p1 === 67, { n1, p1 });
  ok('★第二次没有任何改动（幂等，不会每同步一轮就写一次文件）', n2 === 0 && idem.tasks[0].progress === p1);

  section('⑤：★这个错值会顺着 SPI 污染给领导看的指标');
  const badTask = Object.assign(cp(T), { progress: 33, plan_date: '2026-09-30', created_at: '2026-09-01T00:00:00.000Z' });
  const goodTask = Object.assign(cp(T), { progress: 25, plan_date: '2026-09-30', created_at: '2026-09-01T00:00:00.000Z' });
  const spiBad = S.computeSPI([badTask]), spiGood = S.computeSPI([goodTask]);
  ok('★进度错 8 个百分点，SPI 就跟着错（所以这不只是某一行数字不好看）',
    spiBad !== spiGood, { 用错的进度算: spiBad, 用对的进度算: spiGood });

  section('⑥：★源码接线——两条同步路径都要在合并之后重算，并且修正了就必须写文件');
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('★写回文件那条路径（syncToFile）接上了',
    /const derivedFixed = reconcileDerivedAfterMerge\(merged\);/.test(src));
  ok('★只读拉取那条路径（pullFromFile）也接上了',
    /reconcileDerivedAfterMerge\(merged\);\s*\/\/ 只读拉取/.test(src));
  /* P103 起这个条件上又多了一项 !conflictAlerts（刚写进日志的告警同样必须推出去，
     理由见 noteFieldConflicts 的注释），所以这里不再死扣"紧跟着 hasLocalContribution"，
     只要求 derivedFixed 仍然是这个"必须写文件"判断的一部分 */
  ok('★★重算出了不一样的值就强制写文件——否则修正只留在本机，共享文件里那个错数字会一直错下去',
    /if \(!derivedFixed &&[^)]*!hasLocalContribution\(/.test(src));

  S.DB.settings.me = bakMe;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
