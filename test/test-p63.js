/* P63（数据体检重做 · 批次2+3）：
   ② msOfDeletedTask 的清理口径从"彻底删除"改回"软删除"——它的所属任务只是软删除、
      还能从「已删除任务」恢复，而恢复任务要连带带回里程碑；彻底删掉就毁了这条路。
      彻底删除只保留给 orphanMs（所属任务记录真的不存在，界面上永远够不到）。
   ③ 新增「回收站」：把散落在各实体里的软删除记录收拢成一个看得见、数得着的地方，
      按保留期（默认 90 天，随共享文件同步）显式清理，这才是回收空间的正道——
      而不是让数据体检去删用户自己删掉、还能恢复的东西。

   本文件重点验证"安全"这一半：四道闸（已连共享文件夹 / 已备份过 / 二次确认 / 留墓碑）
   任何一道没过都不许动数据；以及保留期之内的记录一条都不能被碰。
   用法：node test/test-p63.js */
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
    S.DB.shareConfig = null;
    S.DB.settings.lastBackupAt = '';
  };
  reset();

  /* ================= ②：msOfDeletedTask 回到软删除 ================= */
  section('②：里程碑的状态跟随所属任务——任务软删除，里程碑也只软删除，不彻底删');
  ok('★PURGE_HEALTH_KINDS 里没有 msOfDeletedTask', !/msOfDeletedTask:\s*\{[^}]*entity:/.test(html));
  ok('★仍然保留 orphanMs（那一类的任务记录真不存在，删了不损失可恢复性）',
    /orphanMs:\s*\{[^}]*entity:\s*'milestone'/.test(html));

  const aliveMsOf = id => S.DB.milestones.filter(m => m.task === id && !m.deleted_at).length;
  const t1 = S.DB.tasks.find(x => !x.deleted_at && aliveMsOf(x.id) > 0);
  const n1 = aliveMsOf(t1.id);
  const ms1 = S.DB.milestones.filter(m => m.task === t1.id && !m.deleted_at).map(m => m.id);
  S.softDelete('task', t1.id); S.rebuildIndex();
  const purgedBefore = (S.DB.purged || []).length;
  await S.fixHealth('msOfDeletedTask');
  ok('修复后这些里程碑不再算进统计', aliveMsOf(t1.id) === 0);
  ok('★记录还在（软删除，不是抹掉）', ms1.every(id => !!S.byId('milestone', id)));
  ok('★没有新增任何墓碑', (S.DB.purged || []).length === purgedBefore);
  S.cascadeRestoreTask(t1.id); S.rebuildIndex();
  ok('★★恢复所属任务后，里程碑全部跟着回来（这正是不能彻底删的原因）', aliveMsOf(t1.id) === n1,
    { 期望: n1, 实际: aliveMsOf(t1.id) });

  /* ================= ③：回收站基础 ================= */
  section('③：保留期默认 90 天，并且随共享配置同步（不是每台电脑各设一个）');
  reset();
  ok('★默认保留期是 90 天', S.recycleKeepDays() === 90, S.recycleKeepDays());
  ok('★DEFAULT_RECYCLE_KEEP_DAYS 常量就是 90', S.DEFAULT_RECYCLE_KEEP_DAYS === 90);
  ok('★存在 shareConfig 里随共享文件同步，不是本机 settings',
    /recycleKeepDays:\s*Number\(c\.recycleKeepDays\)/.test(html));
  /* 这个陷阱真的踩到过：Math.max(1, Number(x)||0) || 默认值 —— 没配过时得到 1，
     而 1 是真值，|| 后面的默认值永远轮不到，保留期会静悄悄变成 1 天（比默认激进得多）。 */
  ok('★没配过时不会退化成 1 天（Math.max 短路那个陷阱）', S.recycleKeepDays() !== 1);

  section('③：回收站能把各实体的软删除记录数出来，并给出占用体积');
  reset();
  const tA = S.DB.tasks.find(x => !x.deleted_at && aliveMsOf(x.id) > 0);   // 挑一条名下有里程碑的，才测得到级联
  S.cascadeSoftDeleteTask(tA.id); S.rebuildIndex();
  let bin = S.recycleTotals();
  ok('★任务那一类数到了这条', bin.rows.find(r => r.entity === 'task').all.length >= 1);
  ok('★里程碑也跟着进了回收站（级联软删除）', bin.rows.find(r => r.entity === 'milestone').all.length >= 1);
  ok('★给出了占用字节数（"清了能省多少"要有个诚实的答案）', bin.bytes > 0);
  ok('刚删的不算"可清理"（还在保留期内）', bin.purgeable === 0, bin.purgeable);

  section('③：★安全底线——保留期之内删的，一条都不许动');
  reset();
  const tOld = S.DB.tasks.find(x => !x.deleted_at);
  S.softDelete('task', tOld.id);
  S.byId('task', tOld.id).deleted_at = daysAgo(200);      // 200 天前删的，早已过期
  const tNew = S.DB.tasks.find(x => !x.deleted_at);
  S.softDelete('task', tNew.id);
  S.byId('task', tNew.id).deleted_at = daysAgo(3);        // 3 天前删的，还在保留期内
  S.rebuildIndex();
  bin = S.recycleTotals();
  ok('★只有 200 天前那条算"可清理"', bin.purgeable === 1, bin.purgeable);
  const purgeableIds = bin.rows.find(r => r.entity === 'task').purgeable.map(r => r.id);
  ok('★可清理清单里是那条旧的', purgeableIds.includes(tOld.id));
  ok('★3 天前删的那条不在可清理清单里（刚删错的永远还在）', !purgeableIds.includes(tNew.id));

  /* ================= ③：四道闸 ================= */
  /* 判"被挡住了"不能只看"数据没变"——弹出确认框但还没点确认时数据同样没变，
     那样一来把闸拆掉测试也照样通过（真踩过这个坑）。所以每次先把弹窗状态清干净，
     调用之后要求：既没有弹出任何确认框、数据也一条没少，两个条件同时成立才算真的被挡下。 */
  section('③：闸①——没连共享文件夹时，连确认框都不该弹出来');
  S.ACTIONS['modal-cancel']();
  const before1 = S.DB.tasks.length;
  S.purgeRecycleBin();
  await tick();
  ok('★压根没弹确认框（是被挡在门口，不是等你确认）', typeof S.modalCallback !== 'function');
  ok('★数据一条没少（本机缓存可能不全，会误判）', S.DB.tasks.length === before1);

  section('③：闸②——连上了但从没备份过，同样连确认框都不该弹');
  const store = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeStoreHandle(store)); S.setEverConnected(true);
  S.DB.settings.lastBackupAt = '';
  S.ACTIONS['modal-cancel']();
  const before2 = S.DB.tasks.length;
  S.purgeRecycleBin();
  await tick();
  ok('★★压根没弹确认框（不可撤销的操作必须先有退路，没备份就不给动手的机会）',
    typeof S.modalCallback !== 'function');
  ok('★数据一条没少', S.DB.tasks.length === before2);

  section('③：闸③——备份过了才弹确认框，且没点确认之前不动数据');
  S.DB.settings.lastBackupAt = daysAgo(1);
  const before3 = S.DB.tasks.length;
  S.purgeRecycleBin();
  await tick();
  ok('★弹出了确认框', typeof S.modalCallback === 'function');
  ok('★确认之前数据一条没少', S.DB.tasks.length === before3);

  section('③：闸④——确认之后才真的删，且留墓碑');
  const tOldId = tOld.id;
  const msOfOld = S.DB.milestones.filter(m => m.task === tOldId).map(m => m.id);
  await S.modalCallback(); await tick();
  ok('★那条 200 天前删的任务，记录整条没了', !S.DB.tasks.some(t => t.id === tOldId));
  ok('★留了墓碑（否则别人还没同步的机器会把它原样推回来）',
    (S.DB.purged || []).some(p => p.entity === 'task' && p.id === tOldId));
  ok('★★保留期内那条一根汗毛都没动', !!S.byId('task', tNew.id) && !!S.byId('task', tNew.id).deleted_at);
  ok('★任务名下的里程碑也连带彻底删了（否则会留下一堆无主里程碑，换一种垃圾而已）',
    !msOfOld.some(id => S.DB.milestones.some(m => m.id === id)));
  ok('确实写进了共享文件', store.writes > 0);

  /* ================= ③：恢复入口 ================= */
  section('③：回收站里能单条恢复，行为跟各自页面上那个 ↩ 完全一致');
  reset();
  const tR = S.DB.tasks.find(x => !x.deleted_at && aliveMsOf(x.id) > 0);
  const nR = aliveMsOf(tR.id);
  S.cascadeSoftDeleteTask(tR.id); S.rebuildIndex();
  ok('前置：它进了回收站', S.recycleTotals().rows.find(r => r.entity === 'task').all.some(x => x.id === tR.id));
  await S.ACTIONS['recycle-restore']({ entity: 'task', id: tR.id }); await tick();
  ok('★恢复后任务活了', !S.byId('task', tR.id).deleted_at);
  ok('★它名下的里程碑也一起回来了（跟任务页 ↩ 同一套 cascadeRestoreTask）', aliveMsOf(tR.id) === nR);

  section('③：数据页把回收站面板渲染出来了');
  reset();
  const tP = S.DB.tasks.find(x => !x.deleted_at);
  S.cascadeSoftDeleteTask(tP.id); S.rebuildIndex();
  S.goto('data');
  const h = q('#page-data').innerHTML;
  ok('★有「回收站」面板', h.includes('回收站'));
  ok('有查看明细入口', h.includes('data-act="recycle-toggle"'));
  ok('有保留期输入框', h.includes('data-act="recycle-keep-change"'));
  ok('有清空按钮', h.includes('data-act="recycle-purge"'));
  ok('★说明文字点明了"体检不会碰这里"这条边界', h.includes('数据体检不会碰这里'));

  section('③：保留期输入框接上了 change 事件（CHANGE_ONLY_ACTS 那个老陷阱）');
  ok('★recycle-keep-change 在 CHANGE_ONLY_ACTS 里',
    /CHANGE_ONLY_ACTS = \[[^\]]*'recycle-keep-change'/.test(html));
  ok('★并且补上了对应的 change 分支（只进名单不接事件 = 改了跟没改一样）',
    /closest\('\[data-act="recycle-keep-change"\]'\)/.test(html));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
