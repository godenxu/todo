/* P62（数据体检重做 · 批次1）：救回"数得着、够不到"的黑洞数据。

   事故经过：P60 把"停用工作"改成连带软删除它名下的任务，但任务的 work 字段仍指向那个
   已停用的工作。而 visibleTasks() 当时是从 visibleWorks()（已排除停用工作）推出来的，
   于是这些任务同时满足"自己已删除"和"所属工作已停用"，被第一道过滤拦掉——任务页每一个
   视图都看不到它们，包括唯一的恢复入口「已删除」。数据概况却是直接数 DB.tasks，
   数得出 166 条。结果就是：记录在文件里、数字显示得出来、人却永远够不到，也恢复不了。

   本批修三件事：
   ① visibleTasks() 只按年度过滤，不再按"所属工作是否已停用"过滤
   ② 「已删除」视图取全量任务池（recovery 标记），连年度过滤都绕开——恢复入口不能有任何过滤
   ③ 工作/职责补「已停用」「已删除」视图 + 恢复按钮（恢复工作连带恢复随它一起删掉的任务）
   同时把数据概况的计数改成跟视图同一套判据，杜绝"数字和清单对不上"再次出现。
   用法：node test/test-p62.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  S.DB.settings.me = '测试管理员';
  const reset = () => { S.seedAll(); S.rebuildIndex(); S.UI.works.view = 'active'; S.UI.duties.view = 'active'; S.DB.settings.year = 0; };
  reset();

  /* ================= ①：visibleTasks 不再按所属工作是否停用过滤 ================= */
  section('①：源码层面——visibleTasks 不再从 visibleWorks 推导');
  ok('★visibleTasks 里没有 visibleWorks() 了（那正是把任务藏起来的那一步）',
    !/function visibleTasks\(\)\s*\{[\s\S]{0,400}?visibleWorks\(\)/.test(html));
  ok('★改成只按年度过滤（inYear）', /function visibleTasks\(\)\s*\{[\s\S]{0,400}?DB\.works\.filter\(inYear\)/.test(html));

  section('①：实测——工作被停用后，它名下还活着的任务不再凭空消失');
  reset();
  const w1 = S.DB.works.find(x => !x.deleted_at);
  const aliveIds = S.DB.tasks.filter(t => t.work === w1.id && !t.deleted_at).map(t => t.id);
  ok('前置：这个工作下确实有活着的任务', aliveIds.length > 0, aliveIds.length);
  S.softDelete('work', w1.id); S.rebuildIndex();   // 只停用工作、不动任务（模拟历史遗留数据）
  const stillVisible = S.visibleTasks().filter(t => aliveIds.includes(t.id)).length;
  ok('★所属工作被停用后，这些任务仍然看得见（以前是全部消失）', stillVisible === aliveIds.length,
    { 期望: aliveIds.length, 实际: stillVisible });

  /* ================= ②：「已删除」视图是无条件的恢复入口 ================= */
  section('②：源码层面——deleted 视图带 recovery 标记，taskPoolFor 为它返回全量池');
  ok('★deleted 视图标了 recovery: true', /key: 'deleted'[^}]*recovery: true/.test(html));
  ok('★taskPoolFor 对 recovery 视图返回 DB.tasks（全量，不过滤）',
    /function taskPoolFor\(viewKey\)[\s\S]{0,300}?v\.recovery \? DB\.tasks : visibleTasks\(\)/.test(html));

  section('②：实测——停用工作连带删除的任务，全部出现在「已删除」视图里（黑洞已消除）');
  reset();
  const w2 = S.DB.works.find(x => !x.deleted_at);
  const ts2 = S.DB.tasks.filter(t => t.work === w2.id && !t.deleted_at);
  S.softDelete('work', w2.id);
  ts2.forEach(t => S.cascadeSoftDeleteTask(t.id));
  S.rebuildIndex();
  const counted = S.DB.tasks.filter(t => t.deleted_at).length;
  const reachable = S.taskPoolFor('deleted').filter(S.TASK_VIEW_MAP.deleted.match).length;
  ok('★"数得出来的"和"够得到的"完全一致', counted === reachable, { 数据概况: counted, 恢复入口: reachable });
  ok('这批被连带删除的任务确实都在恢复入口里',
    ts2.every(t => S.taskPoolFor('deleted').some(x => x.id === t.id)));

  section('②：实测——切到别的年度，恢复入口照样看得见（连年度过滤也绕开）');
  S.DB.settings.year = 1999;   // 一个肯定对不上的年度
  const reachableOtherYear = S.taskPoolFor('deleted').filter(S.TASK_VIEW_MAP.deleted.match).length;
  ok('★切到不相干的年度，「已删除」里的任务一条都没少', reachableOtherYear === counted,
    { 期望: counted, 实际: reachableOtherYear });
  ok('对照：日常视图确实会被年度过滤（说明年度过滤本身还在正常工作）',
    S.visibleTasks().length < S.DB.tasks.length);
  S.DB.settings.year = 0;

  /* ================= 数据概况计数与视图口径统一 ================= */
  section('计数口径：数据概况的每个数字都点得进去');
  ok('★源码里改成了走 taskPoolFor + 视图自己的 match',
    /const countTaskView = k => taskPoolFor\(k\)\.filter\(TASK_VIEW_MAP\[k\]\.match\)\.length/.test(html));
  ok('★不再直接数 DB.tasks（那正是数字和清单分叉的来源）',
    !/已删除任务: DB\.tasks\.filter\(t => t\.deleted_at\)\.length/.test(html));

  /* ================= ③：工作/职责的恢复入口 ================= */
  section('③：工作页有「已停用」视图，且能看到被停用的工作');
  reset();
  const w3 = S.DB.works.find(x => !x.deleted_at);
  const n3 = S.DB.tasks.filter(t => t.work === w3.id && !t.deleted_at).length;
  ok('停用之前，已停用视图是空的', S.workPoolFor('stopped').length === 0);
  S.ACTIONS['work-del']({ id: w3.id }); await S.modalCallback(); await tick();
  ok('★停用后，工作出现在「已停用」视图里（以前全站没有任何地方看得到它）',
    S.workPoolFor('stopped').some(x => x.id === w3.id));
  ok('它不再出现在正常视图里', !S.workPoolFor('active').some(x => x.id === w3.id));
  ok('名下任务确实被连带删除了', S.DB.tasks.filter(t => t.work === w3.id && !t.deleted_at).length === 0);

  section('③：恢复工作 = 工作自己回来 + 随它一起被删的任务和里程碑一起回来');
  const msIds3 = S.DB.milestones.filter(m => { const t = S.byId('task', m.task); return t && t.work === w3.id; }).map(m => m.id);
  S.ACTIONS['work-restore']({ id: w3.id }); await S.modalCallback(); await tick();
  ok('★工作恢复了', !S.byId('work', w3.id).deleted_at);
  ok('★随它一起被删的任务全回来了', S.DB.tasks.filter(t => t.work === w3.id && !t.deleted_at).length === n3,
    { 期望: n3, 实际: S.DB.tasks.filter(t => t.work === w3.id && !t.deleted_at).length });
  ok('★这些任务名下的里程碑也回来了', msIds3.every(id => !S.byId('milestone', id).deleted_at));
  ok('恢复后它回到正常视图', S.workPoolFor('active').some(x => x.id === w3.id));

  section('③：恢复只带回"跟这次停用一起被删的"，不误捞之前就单独删掉的任务');
  reset();
  const w4 = S.DB.works.find(x => !x.deleted_at);
  const ts4 = S.DB.tasks.filter(t => t.work === w4.id && !t.deleted_at);
  const early = ts4[0];
  S.cascadeSoftDeleteTask(early.id);            // 先单独删掉一条（早于停用）
  await tick(20);
  S.rebuildIndex();
  S.ACTIONS['work-del']({ id: w4.id }); await S.modalCallback(); await tick();
  S.ACTIONS['work-restore']({ id: w4.id }); await S.modalCallback(); await tick();
  ok('★停用之前就单独删掉的那条，恢复工作时没有被顺带捞回来', !!S.byId('task', early.id).deleted_at);
  ok('其余随停用一起删的都回来了',
    ts4.filter(t => t.id !== early.id).every(t => !S.byId('task', t.id).deleted_at));

  section('③：职责页有「已删除」视图 + 恢复按钮');
  reset();
  const d5 = S.DB.duties.find(x => !x.deleted_at);
  ok('删除之前，已删除视图是空的', S.dutyPoolFor('deleted').length === 0);
  S.ACTIONS['duty-del']({ code: d5.code }); await S.modalCallback(); await tick();
  ok('★删除后出现在「已删除」视图里', S.dutyPoolFor('deleted').some(x => x.code === d5.code));
  S.ACTIONS['duty-restore']({ code: d5.code }); await tick();
  ok('★能恢复回来', !S.byId('duty', d5.code).deleted_at);
  ok('恢复后回到正常视图', S.dutyPoolFor('active').some(x => x.code === d5.code));

  section('③：侧栏渲染不报错，且带上了视图切换入口');
  reset();
  S.goto('works');
  let sb = q('#sidebar').innerHTML;
  ok('工作页侧栏有「已停用」入口', sb.includes('data-act="work-view"') && sb.includes('已停用'));
  S.goto('duties');
  sb = q('#sidebar').innerHTML;
  ok('职责页侧栏有「已删除」入口', sb.includes('data-act="duty-view"') && sb.includes('已删除'));
  S.goto('tasks');
  sb = q('#sidebar').innerHTML;
  ok('任务页侧栏视图列表照常渲染', sb.includes('data-act="task-view"'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
