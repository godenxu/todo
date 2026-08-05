/* P60：本轮四项改动测试——
   ① / ② 图表页"按任务"三个模块（优先级/来源/标签分布）、"按工作"的各年度工作数量，
      看数据表时不要横向滚动条，列宽应该自适应容器（报告页同名模块同理，同一套 CSS）。
      真正的根因不是 P59 以为的 nowrap，而是全局 table 选择器带了 min-width:640px，
      .dtable 沿用了这条底线——不管列宽怎么调、文字换不换行，表格永远至少 640px 宽。
   ③ 停用工作，跟用户确认后从"任务变未归属"改成"任务连同里程碑一起删除"——
      跟当年"停用工作不会删任务，只会变未归属"这句承诺正好反过来，是一次刻意的产品语义变更，
      不是 bug 修复；'work-del' 本身和历史遗留数据的体检修复口径都要跟着改。
   ④ 数据体检"所属任务已删除的里程碑"（msOfDeletedTask）以前点"修复"只是软删除，
      跟它自己"必须还活着"的判定条件矛盾，文件体积一点没少；改成跟 orphanMs 一样彻底删除。
   用法：node test/test-p60.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

function makeStoreHandle(store) {
  return {
    name: 'shared.json',
    async getFile() { return { text: async () => store.text, lastModified: store.mtime || 1 }; },
    async createWritable() {
      return { async write(t) { store.text = t; store.mtime = (store.mtime || 1) + 1; store.writes++; }, async close() {} };
    },
  };
}

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.settings.me = bakMe;
    S.setFileHandle(null); S.setEverConnected(false);
  };
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();

  /* ====================== ①②：.dtable 溢出真正根因 ====================== */
  section('①②：真正的根因是全局 table 选择器的 min-width:640px，.dtable 必须显式解除');
  ok('★全局 table 选择器确实带着 min-width:640px（这是问题的源头，不是本次要改的地方）',
    /table\s*\{[^}]*min-width:\s*640px/.test(html));
  ok('★.dtable 显式解除了这条 640px 底线（min-width:0），不然列宽怎么调都没用',
    /\.dtable\s*\{[^}]*min-width:\s*0/.test(html));

  section('①②：.dtable 单元格允许换行，配合 table-layout:fixed 让列宽真正贴合容器');
  ok('.dtable 是 table-layout:fixed（列宽按容器分配，不再被内容撑宽）',
    /\.dtable\s*\{[^}]*table-layout:\s*fixed/.test(html));
  ok('★.dtable td 不再是 nowrap，允许换行', /\.dtable td\s*\{[^}]*white-space:\s*normal/.test(html));
  ok('.dtable td 没有遗留的 nowrap 声明', !/\.dtable td\s*\{[^}]*white-space:\s*nowrap/.test(html));

  section('①②：dataTable() 的 overflow-x:auto 包装还在，作为极端情况的兜底（不是主要修复手段了）');
  const tblOut = S.dataTable(['列1', '列2'], [['甲', 1]]);
  ok('包装还在（列特别多、换行也救不回来的场景兜底用）', tblOut.includes('overflow-x:auto'));

  /* ====================== ③：停用工作，任务连同里程碑一起删 ====================== */
  section('③：源码层面确认——弹窗文案不再说"不会被删除，会变为未归属"，改成"一并删除"');
  ok('★confirmModal 文案不再是"不会被删除，但会变为未归属"',
    !html.includes('该工作下有 ${n} 条任务，不会被删除，但会变为"未归属"'));
  ok('★confirmModal 文案改成任务将被一并删除',
    /该工作下有 \$\{n\} 条任务将连同它们的里程碑一并删除/.test(html));

  section('③：实测——停用工作后，它名下的任务和里程碑真的被连带软删除了（不是变成未归属）');
  const dutyForWork = S.DB.duties.find(d => !d.deleted_at);
  const w3 = S.stampMeta(S.blank('work', { code: 'P60W', duty: dutyForWork.code, name: 'P60测试工作', year: 2026, status: 'doing' }));
  S.DB.works.push(w3);
  const t3a = S.stampMeta(S.blank('task', { work: w3.id, title: 'P60任务A', status: 'todo', priority: '2', progress: 0 }));
  const t3b = S.stampMeta(S.blank('task', { work: w3.id, title: 'P60任务B', status: 'doing', priority: '2', progress: 30 }));
  S.DB.tasks.push(t3a, t3b);
  const m3 = S.stampMeta(S.blank('milestone', { task: t3a.id, plan_date: '2026-09-01', deliverable: 'P60交付物', done: '0' }));
  S.DB.milestones.push(m3);
  S.rebuildIndex();
  S.ACTIONS['work-del']({ id: w3.id });
  await S.modalCallback(); await tick();
  ok('★工作本身软删除了', !!S.byId('work', w3.id).deleted_at);
  ok('★任务A 被软删除了（不是留着变成"未归属"）', !!S.byId('task', t3a.id).deleted_at);
  ok('★任务B 也被软删除了', !!S.byId('task', t3b.id).deleted_at);
  ok('★任务A 名下的里程碑也跟着软删除了', !!S.byId('milestone', m3.id).deleted_at);
  ok('任务的 work 字段没有被清空（不是走"未归属"那条路，是整条被软删了）', S.byId('task', t3a.id).work === w3.id);
  ok('可以在"已删除任务"里通过撤销/恢复找回来（软删除，不是彻底删除）',
    !(S.DB.purged || []).some(p => p.entity === 'task' && p.id === t3a.id));

  section('③：历史遗留数据（改动前就已经"工作停用、任务还活着"的）体检修复口径要跟新政策一致');
  const w4 = S.stampMeta(S.blank('work', { code: 'P60W2', duty: dutyForWork.code, name: 'P60测试工作2', year: 2026, status: 'doing' }));
  S.DB.works.push(w4);
  const t4 = S.stampMeta(S.blank('task', { work: w4.id, title: 'P60历史遗留任务', status: 'todo', priority: '2', progress: 0 }));
  S.DB.tasks.push(t4);
  S.rebuildIndex();
  S.softDelete('work', w4.id);   // 模拟"历史上工作被停用、但任务字段没清"的老数据
  const issue3 = S.healthCheck().issues.find(i => i.k === 'taskOfDeletedWork');
  ok('体检发现了这条历史遗留数据', !!issue3, issue3);
  ok('★修复文案改成"一并删除"，不再是"清空所属工作"', issue3 && issue3.fix && issue3.fix.includes('删除'));
  await S.fixHealth('taskOfDeletedWork');
  ok('★修复后任务被软删除了（不是清空 work 字段变成未归属）', !!S.byId('task', t4.id).deleted_at);
  ok('工作本身没有被动（停用是用户自己的决定，体检不该替他撤销）', !!S.byId('work', w4.id).deleted_at);
  ok('修复后体检不再报这一项', !S.healthCheck().issues.some(i => i.k === 'taskOfDeletedWork'));

  /* ====================== ④：msOfDeletedTask 改为彻底删除 ====================== */
  section('④：msOfDeletedTask 这一项体检不再提供"一键修复"（软删除），改成"彻底删除"');
  ok('★PURGE_HEALTH_KINDS 里有 msOfDeletedTask 这一项了', /msOfDeletedTask:\s*\{[^}]*entity:\s*'milestone'/.test(html));
  ok('fixHealth() 里已经没有 msOfDeletedTask 的软删除分支了',
    !/kind === 'msOfDeletedTask'\) r\.msOfDeletedTask\.forEach\(m => \{ m\.deleted_at/.test(html));

  section('④：实测——历史遗留的"任务已删、里程碑还活着"数据，体检报的是 purgeFix 不是 fix');
  const aliveMsOf = id => S.DB.milestones.filter(m => m.task === id && !m.deleted_at).length;
  const t = S.DB.tasks.find(x => !x.deleted_at && aliveMsOf(x.id) > 0);
  const msIds = S.DB.milestones.filter(m => m.task === t.id && !m.deleted_at).map(m => m.id);
  S.softDelete('task', t.id); S.rebuildIndex();
  const issue = S.healthCheck().issues.find(i => i.k === 'msOfDeletedTask');
  ok('体检发现了这批数据', !!issue, issue);
  ok('★不再带（软删除式的）fix', !(issue && issue.fix));
  ok('★带 purgeFix（彻底删除）', !!(issue && issue.purgeFix));

  section('④：实测——purgeHealth 需要先连共享文件夹这道闸，没连上时不动手');
  const beforeMsCount = S.DB.milestones.length;
  S.purgeHealth('msOfDeletedTask');   // 没连文件夹，应该被挡在门口，弹提示、不动数据
  await tick();
  ok('★没连共享文件夹时，milestones 数组一条没少（防止本机数据不全时误删）', S.DB.milestones.length === beforeMsCount);

  section('④：实测——连上共享文件夹后，purgeHealth 真的把记录整条拿掉，不是又盖一次软删除');
  const store = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeStoreHandle(store)); S.setEverConnected(true);
  S.purgeHealth('msOfDeletedTask');
  await S.modalCallback(); await tick();
  ok('★这些里程碑的记录整条没了（不是 deleted_at 被盖了一下）', !S.DB.milestones.some(m => msIds.includes(m.id)));
  ok('★留了墓碑（否则还没同步的设备会把它们原样推回来）',
    msIds.every(id => (S.DB.purged || []).some(p => p.entity === 'milestone' && p.id === id)));
  ok('体检里这一项不再报了', !S.healthCheck().issues.some(i => i.k === 'msOfDeletedTask'));
  ok('确实写进了共享文件（store.writes 有增加，不是只改了本机内存）', store.writes > 0);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
