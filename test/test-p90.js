/* P90：第三轮全量排查发现的两个同步问题
   ① 【上一轮改动带出来的回归】三方合并之后按 Ctrl+Z 撤销，会把同事的改动一起吞掉。
      撤销靠 touchedByOthersSince 判断"这条在我拍快照之后有没有被别人动过"，判据是 updated_by；
      而三方合并结果的 updated_by 记的是"版本比较胜出的那一方"——如果恰好是我，这条记录
      看起来就像"只有我动过"，撤销于是整条拨回快照，连里面同事的字段改动一起抹掉。
   ② 从共享文件合并进来的记录不做类型规整。共享 JSON 就摆在网盘上，谁都能用记事本改；
      参与人本该是数组被写成 "张三,李四" 这种，同步进来之后任务页整页渲染不出来、
      按人统计直接抛异常，而且要刷新页面才恢复（只有 boot 会规整）。
   用法：node test/test-p90.js */
const { sandbox: S } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));
const P = tasks => ({ duties: [], works: [], milestones: [], tasks, changelog: [], users: [], purged: [] });

async function main() {
  await tick(60);
  const bakMe = S.DB.settings.me;

  const BASE = { id: 'p90_t', title: '原标题', status: 'todo', priority: '2', assignees: [], progress: 0,
    rev: 5, updated_at: '2026-09-04T01:00:00.000Z', updated_by: '基线', created_at: '2026-09-01T00:00:00.000Z' };
  const baseMap = { task: { p90_t: cp(BASE) } };
  const 甲 = Object.assign(cp(BASE), { title: '甲改的标题', rev: 6, updated_at: '2026-09-04T03:00:00.000Z', updated_by: '甲' });
  const 乙 = Object.assign(cp(BASE), { status: 'done', rev: 6, updated_at: '2026-09-04T02:00:00.000Z', updated_by: '乙' });

  section('①：★三方合并的结果要留下"吸收过谁的改动"的标记');
  const merged = S.mergeSyncPayload(P([cp(甲)]), P([cp(乙)]), baseMap).tasks[0];
  ok('前置：合并结果里确实同时装着两个人的改动', merged.title === '甲改的标题' && merged.status === 'done');
  ok('前置：而"最后修改人"记的是版本比较胜出的一方（甲）', merged.updated_by === '甲', merged.updated_by);
  ok('★留下了 merged_from 标记，写明吸收了谁的改动', merged.merged_from === '乙', merged.merged_from);

  section('①：★撤销必须认这个标记，不能把同事的改动一起回退');
  const ctx = { at: '2026-09-04T02:30:00.000Z', by: '甲' };   // 甲改标题之前拍的快照
  ok('★touchedByOthersSince 判定为"别人动过"，撤销时要跳过', S.touchedByOthersSince(merged, ctx) === true);
  const snap = [Object.assign(cp(BASE), { title: '原标题' })];
  const restored = S.undoRestoreList('id', snap, [cp(merged)], { at: ctx.at, by: ctx.by, skipped: [] });
  ok('★★撤销之后乙的状态还在（这正是回归点）', restored[0].status === 'done', restored[0].status);
  ok('★甲自己的改动也一并保留（整条跳过，宁可少撤一点）', restored[0].title === '甲改的标题', restored[0].title);
  const skipCtx = { at: ctx.at, by: ctx.by, skipped: [] };
  S.undoRestoreList('id', snap, [cp(merged)], skipCtx);
  ok('★如实告诉用户"有几条因为同事动过被跳过了"', skipCtx.skipped.length === 1, skipCtx.skipped);

  section('①：标记不能滥用——不该保护的场景仍要能正常撤销');
  const 只有我改的 = Object.assign(cp(BASE), { title: '我改的', rev: 6, updated_at: '2026-09-04T03:00:00.000Z', updated_by: '甲' });
  ok('★没经过合并的记录，撤销照常生效', S.touchedByOthersSince(只有我改的, ctx) === false);
  const r2 = S.undoRestoreList('id', snap, [cp(只有我改的)], { at: ctx.at, by: ctx.by, skipped: [] });
  ok('★确实回退到了快照那份', r2[0].title === '原标题', r2[0].title);
  const 快照之前合并的 = Object.assign(cp(merged), { updated_at: '2026-09-04T02:00:00.000Z' });
  ok('★合并发生在快照之前的，不影响撤销（那份快照本来就已经包含同事的改动了）',
    S.touchedByOthersSince(快照之前合并的, ctx) === false);
  const 我自己两台设备 = Object.assign(cp(BASE), { title: 'x', rev: 7, updated_at: '2026-09-04T03:00:00.000Z', updated_by: '甲', merged_from: '甲' });
  ok('★标记指向我自己时（同一个人两台机器）不算"别人动过"', S.touchedByOthersSince(我自己两台设备, ctx) === false);

  section('①：★正常编辑一次之后，标记要清掉，否则以后的撤销会白白跳过');
  S.DB.settings.me = '甲';
  const rec = cp(merged);
  ok('前置：标记还在', rec.merged_from === '乙');
  S.stampMeta(rec);
  ok('★stampMeta 清掉了标记', !rec.merged_from, rec.merged_from);
  ok('★于是之后拍的快照能正常撤销', S.touchedByOthersSince(rec, { at: '2026-09-04T04:00:00.000Z', by: '甲' }) === false);

  section('①：标记不会污染别的地方');
  ok('★不进 CSV 表头（导出的列不该多出这个内部字段）', S.csvHeaders('task').indexOf('merged_from') === -1, S.csvHeaders('task'));
  ok('★不参与逐字段合并（它不是业务字段）', S.mergeableKeys('task').indexOf('merged_from') === -1);
  const lines = [];
  S.diffRecord('task', cp(BASE), cp(merged)) && lines.push('x');
  ok('★不会出现在"改了什么"的变更描述里', S.diffRecord('task', cp(BASE), cp(merged)).indexOf('merged_from') === -1);

  section('②：★共享文件里被手工改坏的记录，同步进来不能让页面崩掉');
  const 坏记录 = { id: 'p90_bad', title: '有人用记事本改过的', status: 'todo', work: '',
    assignees: '张三,李四',     // 本该是数组
    progress: '80',             // 本该是数字
    rev: 9, updated_at: '2026-09-04T05:00:00.000Z', updated_by: '手工' };
  const 合并结果 = S.mergeSyncPayload(P([]), P([cp(坏记录)]), null);
  const fixed = S.normalizeMergedRecords(合并结果).tasks[0];
  ok('★参与人被规整成数组', Array.isArray(fixed.assignees), { 类型: typeof fixed.assignees, 值: fixed.assignees });
  ok('★而且切分正确，不是整串当成一个人', JSON.stringify(fixed.assignees) === JSON.stringify(['张三', '李四']), fixed.assignees);
  ok('★进度被规整成数字', typeof fixed.progress === 'number', typeof fixed.progress);

  section('②：★规整之后，原来会崩的那几处都能正常跑');
  S.DB.tasks = [fixed]; S.rebuildIndex();
  let renderErr = null, statErr = null;
  try { S.renderTaskRow(fixed); } catch (e) { renderErr = e.message; }
  try { S.statsByPerson(S.DB.tasks); } catch (e) { statErr = e.message; }
  ok('★任务行渲染不再抛异常（原来整页任务列表都出不来）', renderErr === null, renderErr);
  ok('★按人统计不再抛异常（原来图表页/报告页/工作台都会挂）', statErr === null, statErr);
  ok('★人员名单里不会多出"张三,李四"这种拼在一起的假人名',
    S.allPeople().indexOf('张三,李四') === -1 && S.allPeople().includes('张三'), S.allPeople());

  section('②：规整是幂等的，正常记录不会被改坏');
  const 正常 = { id: 'p90_ok', title: '正常任务', status: 'doing', assignees: ['王五'], progress: 50, work: '' };
  const before = cp(正常);
  const after = S.normalizeMergedRecords(P([正常])).tasks[0];
  ok('★正常记录规整前后一模一样', JSON.stringify(after.assignees) === JSON.stringify(before.assignees)
    && after.progress === before.progress && after.title === before.title, { before, after });
  const twice = S.normalizeMergedRecords(S.normalizeMergedRecords(P([cp(坏记录)]))).tasks[0];
  ok('★规整两遍结果一致（幂等）', JSON.stringify(twice.assignees) === JSON.stringify(['张三', '李四']));

  section('②：★两条同步路径都必须真的调用它——光有函数没接上去等于没修');
  /* 上面那些用例是直接调 normalizeMergedRecords 测它本身。但真正的风险是"函数写了、
     同步路径上却没接"——那种情况下所有单元测试照样全绿，线上却照崩不误。
     syncToFile / pullFromFile 需要真实的文件句柄，沙盒里跑不起来，所以这里退一步查源码：
     两处合并调用都必须被 normalizeMergedRecords 包住。 */
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  const wrapped = (src.match(/normalizeMergedRecords\(mergeSyncPayload\(localPayload, cur\.remote/g) || []).length;
  const total = (src.match(/mergeSyncPayload\(localPayload, cur\.remote/g) || []).length;
  ok('★同步里一共两处合并调用', total === 2, total);
  ok('★★两处都套上了合并后规整（写回文件的那条 syncToFile + 只读拉取的 pullFromFile）',
    wrapped === 2, { 套上的: wrapped, 总数: total });

  section('②：四类业务记录都要覆盖到');
  const payload = { duties: [{ code: 'D1', name: '职责' }], works: [{ id: 'w1', name: '工作', collaborators: '甲,乙', content: '一行文字' }],
    milestones: [{ id: 'm1', task: 't1', deliverable: '交付物' }], tasks: [{ id: 't1', title: '任务', assignees: '丙' }],
    changelog: [], users: [], purged: [] };
  const norm = S.normalizeMergedRecords(payload);
  ok('★工作的参与人被规整成数组', Array.isArray(norm.works[0].collaborators), norm.works[0].collaborators);
  ok('★工作的多行内容被规整成数组', Array.isArray(norm.works[0].content), norm.works[0].content);
  ok('★任务的参与人被规整成数组', Array.isArray(norm.tasks[0].assignees), norm.tasks[0].assignees);
  ok('职责/里程碑也没被漏掉（没有数组字段，至少不能报错）', !!norm.duties[0] && !!norm.milestones[0]);

  S.DB.settings.me = bakMe;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
