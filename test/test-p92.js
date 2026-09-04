/* P92：第五轮排查——启动时的数据迁移会在多台机器上各自生成随机 id
   迁移（migrateWorkIds / migrateMilestonesToTasks）是在每台机器自己的启动流程里跑的，
   而且跑在第一次拉共享文件【之前】。原来它们用 uid() 生成随机 id：几台还留着老缓存的机器
   各自迁移一遍，同一条老数据就会变成好几条 id 不同、内容一模一样的记录——合并按 id 认记录，
   认不出它们是同一条，于是一条任务下冒出好几套重复里程碑、同一项工作出现好几条。
   （数据体检里 dupMs 那一项要清理的，正是这种现象。）
   修法：迁移生成的 id 改成"按来源算出来的"，几台机器算出来的一模一样，合并时自然就是同一条。
   另外 migrateTaskCodes 补编号时不盖戳，改动推不出去，一并补上。
   说明：这几个迁移在当前生产数据上已经不会触发（老字段都清干净了），这批修的是
   "还留着很老 localStorage 缓存的机器重新连上来"这个场景，属于防御性修复。
   用法：node test/test-p92.js */
const { sandbox: S } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

// 把 DB 换成一份"老数据"，跑一遍迁移，返回迁移后的结果（模拟一台机器的启动流程）
function migrateOnMachine(legacy) {
  S.DB.duties = cp(legacy.duties || []);
  S.DB.works = cp(legacy.works || []);
  S.DB.tasks = cp(legacy.tasks || []);
  S.DB.milestones = cp(legacy.milestones || []);
  S.rebuildIndex();
  S.migrateWorkIds();
  S.rebuildIndex();
  S.migrateTaskCodes();
  S.migrateMilestonesToTasks();
  S.rebuildIndex();
  return { works: cp(S.DB.works), tasks: cp(S.DB.tasks), milestones: cp(S.DB.milestones) };
}

async function main() {
  await tick(60);
  const bakMe = S.DB.settings.me;
  S.DB.settings.me = '测试管理员';

  section('①：★里程碑迁移——两台机器各自迁移，必须得到同一个 id（否则合并后重复）');
  const legacyMs = {
    duties: [{ code: 'L1', name: '老职责' }],
    works: [{ id: 'w_old', code: '0101', duty: 'L1', name: '老工作', year: 2026 }],
    // 老数据的表达方式：任务上挂着 deliverable 文本，没有独立的里程碑记录
    tasks: [{ id: 't_old1', work: 'w_old', code: '01012601', title: '老任务一', status: 'done',
      plan_date: '2026-06-30', actual_date: '2026-06-28', deliverable: '老交付物一', assignees: [],
      created_at: '2026-01-01T00:00:00.000Z' }],
    milestones: [],
  };
  const 机器甲 = migrateOnMachine(legacyMs);
  const 机器乙 = migrateOnMachine(legacyMs);
  ok('两台都迁出了里程碑', 机器甲.milestones.length === 1 && 机器乙.milestones.length === 1,
    { 甲: 机器甲.milestones.length, 乙: 机器乙.milestones.length });
  ok('★★两台机器算出来的 id 完全相同', 机器甲.milestones[0].id === 机器乙.milestones[0].id,
    { 甲: 机器甲.milestones[0].id, 乙: 机器乙.milestones[0].id });
  ok('★id 是按所属任务算出来的，不是随机串', 机器甲.milestones[0].id === 'm_mig_t_old1', 机器甲.milestones[0].id);
  ok('迁移出来的内容正确（交付物/完成状态跟着老任务走）',
    机器甲.milestones[0].deliverable === '老交付物一' && 机器甲.milestones[0].done === '1');

  section('①：★合并之后不能变成两条重复里程碑（这才是真正要防的后果）');
  const P = m => ({ duties: [], works: [], milestones: m, tasks: [], changelog: [], users: [], purged: [] });
  const 合并 = S.mergeSyncPayload(P(机器甲.milestones), P(机器乙.milestones), null);
  ok('★★合并后只有一条里程碑，不是两条', 合并.milestones.length === 1, 合并.milestones.map(m => m.id));

  section('①：老里程碑记录那条分支同样要确定');
  const legacyMs2 = {
    duties: [{ code: 'L1', name: '老职责' }],
    works: [{ id: 'w_old', code: '0101', duty: 'L1', name: '老工作', year: 2026 }],
    tasks: [{ id: 't_old2', work: 'w_old', code: '01012602', title: '老任务二', status: 'todo',
      milestone: 'oldms1', assignees: [], created_at: '2026-01-01T00:00:00.000Z' }],
    milestones: [{ id: 'oldms1', name: '老的工作级里程碑', plan_date: '2026-09-30', status: 'todo' }],
  };
  const a2 = migrateOnMachine(legacyMs2), b2 = migrateOnMachine(legacyMs2);
  ok('★两台机器 id 一致', a2.milestones[0] && a2.milestones[0].id === (b2.milestones[0] || {}).id,
    { 甲: (a2.milestones[0] || {}).id, 乙: (b2.milestones[0] || {}).id });
  ok('合并后仍然只有一条', S.mergeSyncPayload(P(a2.milestones), P(b2.milestones), null).milestones.length === 1);

  section('②：★工作 id 迁移——按编号算，两台机器结果一致');
  const legacyWork = {
    duties: [{ code: 'L1', name: '老职责' }],
    works: [{ code: '0102', duty: 'L1', name: '没有 id 的老工作', year: 2026 }],   // 老数据：工作没有 id
    tasks: [{ id: 't_w', work: '0102', title: '指向工作编号的老任务', assignees: [], created_at: '2026-01-01T00:00:00.000Z' }],
    milestones: [],
  };
  const w甲 = migrateOnMachine(legacyWork), w乙 = migrateOnMachine(legacyWork);
  ok('★★两台机器给这项工作算出同一个 id', w甲.works[0].id === w乙.works[0].id, { 甲: w甲.works[0].id, 乙: w乙.works[0].id });
  ok('★id 由工作编号推出来，不是随机串', w甲.works[0].id === 'w_0102', w甲.works[0].id);
  ok('任务的所属工作被正确重指到新 id', w甲.tasks[0].work === 'w_0102', w甲.tasks[0].work);
  const PW = w => ({ duties: [], works: w, milestones: [], tasks: [], changelog: [], users: [], purged: [] });
  ok('★★合并后只有一项工作，不是两项', S.mergeSyncPayload(PW(w甲.works), PW(w乙.works), null).works.length === 1);

  section('③：★补任务编号要盖戳，否则这次补号推不到共享文件');
  const legacyCode = {
    duties: [{ code: 'L1', name: '老职责' }],
    works: [{ id: 'w_c', code: '0103', duty: 'L1', name: '工作', year: new Date().getFullYear() }],
    tasks: [{ id: 't_nocode', work: 'w_c', title: '没有编号的老任务', assignees: [],
      rev: 3, updated_at: '2026-01-01T00:00:00.000Z', updated_by: '老数据', created_at: '2026-01-01T00:00:00.000Z' }],
    milestones: [],
  };
  const c1 = migrateOnMachine(legacyCode);
  const migrated = c1.tasks[0];
  ok('编号补上了', !!migrated.code, migrated.code);
  ok('★版本号涨了（不涨的话合并判不出"我这边多了个编号"）', migrated.rev > 3, { 原来: 3, 现在: migrated.rev });
  ok('★修改时间也更新了', migrated.updated_at > '2026-01-01T00:00:00.000Z', migrated.updated_at);
  const PT = t => ({ duties: [], works: [], milestones: [], tasks: t, changelog: [], users: [], purged: [] });
  const 文件里没编号 = [Object.assign(cp(legacyCode.tasks[0]))];
  ok('★★跟"文件里那条还没有编号"的版本合并，编号能保住',
    S.mergeSyncPayload(PT(c1.tasks), PT(文件里没编号), null).tasks[0].code === migrated.code);

  section('③：两台机器各自补编号，补出来的必须一致（确定性）');
  const c2 = migrateOnMachine(legacyCode);
  ok('★编号一致，不会两台机器补出不同的号', c1.tasks[0].code === c2.tasks[0].code,
    { 甲: c1.tasks[0].code, 乙: c2.tasks[0].code });

  section('④：迁移的幂等性——已经迁过的数据再跑一遍不能重复生成');
  const once = migrateOnMachine(legacyMs);
  S.DB.works = cp(once.works); S.DB.tasks = cp(once.tasks); S.DB.milestones = cp(once.milestones);
  S.rebuildIndex();
  S.migrateMilestonesToTasks();
  S.migrateWorkIds();
  S.migrateTaskCodes();
  S.rebuildIndex();
  ok('★再跑一遍里程碑没有变多', S.DB.milestones.length === 1, S.DB.milestones.length);
  ok('★老字段已经清干净（这是幂等的前提）',
    !('deliverable' in S.DB.tasks[0]) && !('milestone' in S.DB.tasks[0]));

  section('⑤：当前生产数据不该再触发这些迁移（确认这批修的是历史遗留场景）');
  const fs = require('fs');
  const path = require('path');
  const prodPath = path.join(__dirname, '..', '科技规划处工作管理.json');
  if (fs.existsSync(prodPath)) {
    const prod = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
    ok('生产数据里没有缺 id 的工作', (prod.works || []).filter(w => !w.id).length === 0);
    ok('生产数据里没有缺编号的任务', (prod.tasks || []).filter(t => !t.code && t.work).length === 0);
    ok('生产数据里没有残留的老里程碑字段',
      (prod.tasks || []).filter(t => 'milestone' in t || 'deliverable' in t).length === 0);
  } else {
    ok('（本地没有生产数据文件，跳过这一节）', true);
  }

  S.DB.settings.me = bakMe;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
