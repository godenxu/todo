/* P64（数据体检重做 · 批次4）：体检重构
   · 体检本身永远只读——healthCheck() 跑一百遍也不该改动任何一个字节
   · 结果分三级：🔴 需要修复（引用断裂/状态不一致）｜🟡 建议查看｜⚪ 仅供了解
   · 每一项都标注"这个修复能不能 Ctrl+Z 撤销"
   · 所有批量修复先干跑预览（将要处理哪些记录、多少条、能否撤销），确认了才动手
   · 彻底删除类统一四道闸：已连共享文件夹 + 已备份过 + 预览 + 二次确认
   · ★最关键的边界：体检不碰回收站里的任何东西——那是用户自己删的，
     体检去动它就成了"体检误删有效数据"，正是本轮要杜绝的事
   用法：node test/test-p64.js */
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
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
const snapshotOf = () => JSON.stringify({ t: S.DB.tasks, m: S.DB.milestones, w: S.DB.works, d: S.DB.duties, p: S.DB.purged });

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
  S.DB.settings.me = '测试管理员';
  const reset = () => {
    S.seedAll(); S.rebuildIndex();
    S.setFileHandle(null); S.setEverConnected(false);
    S.DB.shareConfig = null; S.DB.settings.lastBackupAt = '';
  };
  reset();

  /* ================= 铁律1：体检只读 ================= */
  section('铁律1：体检本身永远只读，跑多少遍都不改一个字节');
  reset();
  // 先造一堆各类问题，让体检有活干
  const tBad = S.DB.tasks.find(x => !x.deleted_at);
  tBad.work = 'w_根本不存在'; S.stampMeta(tBad);
  S.rebuildIndex();
  const before = snapshotOf();
  S.healthCheck(); S.healthCheck(); S.healthCheck();
  ok('★连跑三遍 healthCheck()，数据一个字节都没变', snapshotOf() === before);
  ok('★干跑预览也不改数据', (() => { S.fixHealthPreview('orphanTask'); return snapshotOf() === before; })());

  /* ================= 分级 ================= */
  section('分级：每一项都有 level 和 undoable，且按 🔴→🟡→⚪ 排序');
  const hc = S.healthCheck();
  ok('★每一项都带 level', hc.issues.every(i => ['error', 'warn', 'info'].includes(i.level)));
  ok('★每一项都带 undoable（布尔）', hc.issues.every(i => typeof i.undoable === 'boolean'));
  ok('★带了三级计数', hc.counts && typeof hc.counts.error === 'number');
  const order = { error: 0, warn: 1, info: 2 };
  const seq = hc.issues.map(i => order[i.level]);
  ok('★结果按严重程度排序，🔴 在最前面', seq.every((v, idx) => idx === 0 || v >= seq[idx - 1]), seq);

  section('分级：引用断裂算 🔴，重复/日期矛盾算 🟡，纯提示算 ⚪');
  ok('orphanTask（指向不存在的工作）是 error', S.healthMeta('orphanTask').level === 'error');
  ok('orphanMs（指向不存在的任务）是 error', S.healthMeta('orphanMs').level === 'error');
  ok('dupTask（重复任务）是 warn', S.healthMeta('dupTask').level === 'warn');
  ok('progressMismatch（进度状态对不上）是 warn', S.healthMeta('progressMismatch').level === 'warn');
  ok('noWork（未归属）是 info', S.healthMeta('noWork').level === 'info');
  ok('noDate（缺计划完成时间）是 info', S.healthMeta('noDate').level === 'info');

  section('分级：彻底删除类一律标成不可撤销');
  ok('★orphanMs 走彻底删除，undoable = false', S.healthMeta('orphanMs').undoable === false);
  ok('软删除/改字段类都可撤销', S.healthMeta('orphanTask').undoable === true && S.healthMeta('dupTask').undoable === true);
  const purgeIssue = S.healthCheck().issues.find(i => i.purgeFix);
  if (purgeIssue) ok('★带 purgeFix 的项一定被标成不可撤销', purgeIssue.undoable === false);
  else ok('（本轮数据里没有 purgeFix 项，跳过）', true);

  /* ================= 干跑预览 ================= */
  section('干跑预览：说清楚将要做什么、动多少条、能不能撤销、具体是哪些记录');
  const p = S.fixHealthPreview('orphanTask');
  ok('★预览拿得到', !!p);
  ok('★写明了条数', p.n > 0);
  ok('★写明了"将要做什么"（人话，不是字段名）', p.what && p.what.includes('未归属'));
  ok('★写明了能不能撤销', typeof p.undoable === 'boolean');
  ok('★列出了具体记录', Array.isArray(p.items) && p.items.length > 0);
  ok('没有问题的项返回 null（不会凭空弹一个空预览）', S.fixHealthPreview('根本不存在的项') === null);

  section('干跑预览：明细条数封顶，不会把几百条全铺进确认框');
  ok('★有上限常量', typeof S.HEALTH_PREVIEW_LIMIT === 'number' && S.HEALTH_PREVIEW_LIMIT > 0);
  ok('★预览条数不超过上限', p.items.length <= S.HEALTH_PREVIEW_LIMIT);

  section('干跑预览：点"修复"先弹确认框，确认之前一条都不动');
  reset();
  const tBad2 = S.DB.tasks.find(x => !x.deleted_at);
  tBad2.work = 'w_根本不存在'; S.stampMeta(tBad2); S.rebuildIndex();
  const before2 = snapshotOf();
  S.ACTIONS['health-fix']({ k: 'orphanTask' });
  await tick();
  ok('★弹出了确认框', typeof S.modalCallback === 'function');
  ok('★★确认之前数据一个字节都没动', snapshotOf() === before2);
  await S.modalCallback(); await tick();
  ok('★确认之后才真的修好了', S.byId('task', tBad2.id).work === '');

  /* ================= 彻底删除的四道闸 ================= */
  section('彻底删除：闸①没连共享文件夹时不动手');
  reset();
  // 造一个真正的无主里程碑：所属任务记录整条不存在
  const msOrphan = S.stampMeta(S.blank('milestone', { task: 't_根本不存在', plan_date: '2026-01-01', deliverable: 'P64孤儿交付物', done: '0' }));
  S.DB.milestones.push(msOrphan); S.rebuildIndex();
  ok('前置：体检发现了这个无主里程碑', S.healthCheck().issues.some(i => i.k === 'orphanMs'));
  const beforeP1 = S.DB.milestones.length;
  S.purgeHealth('orphanMs'); await tick();
  ok('★没连共享文件夹时一条没少', S.DB.milestones.length === beforeP1);

  section('彻底删除：闸②连上了但从没备份过，仍然不动手');
  const store = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeStoreHandle(store)); S.setEverConnected(true);
  S.DB.settings.lastBackupAt = '';
  S.purgeHealth('orphanMs'); await tick();
  ok('★没备份过时一条没少（不可撤销的操作必须先有退路）', S.DB.milestones.length === beforeP1);

  section('彻底删除：闸③④备份过了才弹预览确认，确认后才删并留墓碑');
  S.DB.settings.lastBackupAt = daysAgo(1);
  S.purgeHealth('orphanMs'); await tick();
  ok('★弹出了确认框', typeof S.modalCallback === 'function');
  ok('★确认之前一条没少', S.DB.milestones.length === beforeP1);
  await S.modalCallback(); await tick();
  ok('★确认后记录整条没了', !S.DB.milestones.some(m => m.id === msOrphan.id));
  ok('★留了墓碑', (S.DB.purged || []).some(x => x.entity === 'milestone' && x.id === msOrphan.id));

  /* ================= ★最关键的边界：体检不碰回收站 ================= */
  section('★★核心边界：体检对回收站里的东西一概不动');
  reset();
  // 往回收站里塞几条"很久以前删掉的"记录——正是最容易被误当成垃圾清掉的那种
  const tRecycled = S.DB.tasks.find(x => !x.deleted_at);
  S.cascadeSoftDeleteTask(tRecycled.id);
  S.byId('task', tRecycled.id).deleted_at = daysAgo(365);
  S.DB.milestones.filter(m => m.task === tRecycled.id).forEach(m => { m.deleted_at = daysAgo(365); });
  S.rebuildIndex();
  const recycledSnapshot = JSON.stringify({
    t: S.byId('task', tRecycled.id),
    m: S.DB.milestones.filter(m => m.task === tRecycled.id),
  });
  // 把所有体检修复挨个跑一遍
  const allKinds = ['orphanTask', 'taskOfDeletedWork', 'msOfDeletedTask', 'dupTask', 'dupWork',
    'dupMs', 'msLateThanTask', 'noDateHasMs', 'progressMismatch'];
  for (const k of allKinds) { await S.fixHealth(k); }
  S.rebuildIndex();
  ok('★★把所有体检修复挨个跑一遍之后，回收站里那条一年前删的任务纹丝不动',
    JSON.stringify({ t: S.byId('task', tRecycled.id), m: S.DB.milestones.filter(m => m.task === tRecycled.id) }) === recycledSnapshot);
  ok('★★它仍然躺在回收站里、随时能恢复（没有被彻底删掉）', !!S.byId('task', tRecycled.id));
  ok('★★也没有给它留墓碑（墓碑意味着被彻底删了）',
    !(S.DB.purged || []).some(x => x.entity === 'task' && x.id === tRecycled.id));
  S.cascadeRestoreTask(tRecycled.id); S.rebuildIndex();
  ok('★★而且它确实还能恢复回来', !S.byId('task', tRecycled.id).deleted_at);

  /* ================= 面板渲染 ================= */
  section('面板：三级分组、计数、以及"体检不碰回收站"这条边界要写在明面上');
  reset();
  const tBad3 = S.DB.tasks.find(x => !x.deleted_at);
  tBad3.work = 'w_根本不存在'; S.stampMeta(tBad3); S.rebuildIndex();
  S.goto('data');
  const h = q('#page-data').innerHTML;
  ok('★有三级分组标题', h.includes('需要修复') && h.includes('建议查看') && h.includes('仅供了解'));
  ok('★面板头有分级计数', h.includes('🔴') || h.includes('🟡') || h.includes('⚪'));
  ok('★说明里写明了"体检不碰回收站"这条边界', h.includes('不碰回收站'));
  ok('★说明里写明了体检不会自己动数据', h.includes('永远不会自己动数据'));
  ok('不可撤销的按钮带 ⚠ 标记', !h.includes('purgeFix') || h.includes('⚠'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
