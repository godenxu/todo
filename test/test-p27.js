/* P27：本轮改动测试——"彻底删除"留墓碑，防止记录被别的设备复活
   背景：软删除是设 deleted_at + rev++，删除动作本身就是一次"更新"，合并时靠 rev 压得住对方手上的旧版本；
   但彻底删除是把记录从数组里抠掉，而合并规则"我有你没有的记录就收进来"是双向的，
   于是这条记录会从任何一台还没同步的设备上原样飘回来，等于永远删不干净。
   解法：DB.purged 记一条 { entity, id, at, by } 墓碑，跟着同步走，合并时按墓碑把记录筛掉。
   用法：node test/test-p27.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// 跟 test-p26 里同一套假共享文件句柄
function makeFakeFileHandle(initialText) {
  const h = {
    name: 'shared.json', _text: initialText, _mtime: 1000, _writes: [],
    async getFile() { return { lastModified: h._mtime, text: async () => h._text }; },
    async createWritable() {
      return {
        async write(t) { h._pending = t; },
        async close() { h._writes.push(h._pending); h._text = h._pending; h._mtime += 1; },
      };
    },
  };
  return h;
}
const mkTask = (id, extra) => Object.assign({
  id, work: '', code: '', title: '任务' + id, owner: '甲', assignees: [], status: 'todo', priority: '2',
  plan_date: '', progress: 0, actual_date: '', source: '', custom: '',
  rev: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '甲',
}, extra || {});
const payload = extra => Object.assign({
  duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [], permissionMatrix: null, shareConfig: null, purged: [],
}, extra || {});

async function main() {
  await tick(60);
  const bak = JSON.parse(JSON.stringify({ tasks: S.DB.tasks, duties: S.DB.duties, works: S.DB.works, users: S.DB.users, purged: S.DB.purged }));
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.tasks = JSON.parse(JSON.stringify(bak.tasks));
    S.DB.duties = JSON.parse(JSON.stringify(bak.duties));
    S.DB.works = JSON.parse(JSON.stringify(bak.works));
    S.DB.users = JSON.parse(JSON.stringify(bak.users));
    S.DB.purged = JSON.parse(JSON.stringify(bak.purged || []));
    S.DB.settings.me = bakMe;
    S.rebuildIndex(); S.setFileHandle(null); S.setLastSyncedMtime(0);
  };

  section('数据格式版本已经跟着 +1（同步进文件的结构变了，旧版本 html 不能再写这个文件）');
  ok('DATA_SCHEMA_VERSION >= 2', S.DATA_SCHEMA_VERSION >= 2, S.DATA_SCHEMA_VERSION);
  ok('syncPayload 里带上了 purged', 'purged' in S.syncPayload(S.DB));

  section('recordPurge：彻底删除时留下墓碑');
  S.DB.purged = [];
  S.DB.settings.me = '测试管理员';
  await S.Repo.upsert('task', mkTask('p27_a'));
  ok('记录先建起来了', !!S.byId('task', 'p27_a'));
  await S.Repo.removeHard('task', 'p27_a');
  ok('记录从数组里没了', !S.byId('task', 'p27_a'));
  ok('留下了一条墓碑', S.DB.purged.some(p => p.entity === 'task' && p.id === 'p27_a'));
  const tomb = S.DB.purged.find(p => p.id === 'p27_a');
  ok('墓碑记了时间', !!tomb.at);
  ok('墓碑记了是谁删的', tomb.by === '测试管理员');
  await S.Repo.upsert('task', mkTask('p27_a'));
  await S.Repo.removeHard('task', 'p27_a');
  ok('同一条重复删只留一条墓碑，不会越堆越多', S.DB.purged.filter(p => p.id === 'p27_a').length === 1);

  section('bulk 里的同步版 removeHard 也留墓碑（批量彻底删除走的是这一条路径）');
  S.DB.purged = [];
  await S.Repo.upsert('task', mkTask('p27_b1'));
  await S.Repo.upsert('task', mkTask('p27_b2'));
  await S.Repo.bulk(() => { S.removeHard('task', 'p27_b1'); S.removeHard('task', 'p27_b2'); });
  ok('两条都留了墓碑', S.DB.purged.filter(p => ['p27_b1', 'p27_b2'].includes(p.id)).length === 2);

  section('★ 核心场景：A 彻底删了，B 还没同步、内存里仍有这条 → 合并后不该复活');
  const deadTask = mkTask('p27_zombie');
  const localA = payload({   // A：已经删掉了，留着墓碑
    tasks: [],
    purged: [{ entity: 'task', id: 'p27_zombie', at: '2026-06-01T00:00:00.000Z', by: '甲' }],
  });
  const remoteB = payload({ tasks: [deadTask], purged: [] });   // B：还留着这条记录
  const merged1 = S.mergeSyncPayload(localA, remoteB);
  ok('B 推上来的那条没有复活', !merged1.tasks.some(t => t.id === 'p27_zombie'), merged1.tasks.map(t => t.id));
  ok('墓碑保留在合并结果里（继续拦住其它还没同步的设备）', merged1.purged.some(p => p.id === 'p27_zombie'));

  section('★ 反方向也要成立：B 手上有记录、A 的墓碑在远端 → 一样不复活');
  const localB = payload({ tasks: [deadTask], purged: [] });
  const remoteA = payload({ tasks: [], purged: [{ entity: 'task', id: 'p27_zombie', at: '2026-06-01T00:00:00.000Z', by: '甲' }] });
  const merged2 = S.mergeSyncPayload(localB, remoteA);
  ok('本机手上那条也被墓碑筛掉了', !merged2.tasks.some(t => t.id === 'p27_zombie'));
  ok('墓碑被收了进来', merged2.purged.some(p => p.id === 'p27_zombie'));

  section('重建保护：墓碑之后又新建了同编号的记录，不能被误杀');
  // 职责/工作的主键是人手填的编号，删掉之后完全可能再建一个一模一样编号的，
  // 所以只有"墓碑时间晚于这条记录最后一次改动"才算数
  const rebuilt = payload({
    duties: [{ code: 'D9', name: '重建的职责', rev: 1, created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z' }],
    purged: [{ entity: 'duty', id: 'D9', at: '2026-06-01T00:00:00.000Z', by: '甲' }],
  });
  const merged3 = S.mergeSyncPayload(rebuilt, payload());
  ok('墓碑之后重建的记录活下来了', merged3.duties.some(d => d.code === 'D9'), merged3.duties);
  const stale = payload({
    duties: [{ code: 'D9', name: '删之前的老职责', rev: 1, created_at: '2026-05-01T00:00:00.000Z', updated_at: '2026-05-01T00:00:00.000Z' }],
    purged: [{ entity: 'duty', id: 'D9', at: '2026-06-01T00:00:00.000Z', by: '甲' }],
  });
  ok('墓碑之前的那份旧记录照样被筛掉', !S.mergeSyncPayload(stale, payload()).duties.some(d => d.code === 'D9'));

  section('mergePurged：两边墓碑取并集、同一条取最新、有条数上限');
  const mp = S.mergePurged(
    [{ entity: 'task', id: 'x', at: '2026-01-01T00:00:00.000Z', by: '甲' }],
    [{ entity: 'task', id: 'x', at: '2026-02-01T00:00:00.000Z', by: '乙' },
     { entity: 'task', id: 'y', at: '2026-01-05T00:00:00.000Z', by: '丙' }]
  );
  ok('同一条只留一份', mp.filter(p => p.id === 'x').length === 1);
  ok('留的是时间更晚的那一份', mp.find(p => p.id === 'x').by === '乙');
  ok('对方独有的墓碑收进来了', mp.some(p => p.id === 'y'));
  ok('entity 不同、id 相同的两条互不干扰', S.mergePurged(
    [{ entity: 'task', id: 'same', at: '2026-01-01T00:00:00.000Z' }],
    [{ entity: 'duty', id: 'same', at: '2026-01-01T00:00:00.000Z' }]).length === 2);
  const many = Array.from({ length: S.PURGED_LIMIT + 50 }, (_, i) => ({
    entity: 'task', id: 'm' + i, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
  const capped = S.mergePurged(many, []);
  ok('超过上限会裁掉最老的那些', capped.length === S.PURGED_LIMIT, capped.length);
  ok('留下的是最近的（最老那条已经不在了）', !capped.some(p => p.id === 'm0') && capped.some(p => p.id === 'm' + (many.length - 1)));
  ok('脏数据（缺 entity/id）直接忽略，不会污染墓碑表', S.mergePurged([{ at: '2026-01-01' }, null], []).length === 0);

  section('账号：软删除本来就有墓碑保护，不受影响；但硬删也能被墓碑挡住');
  const softDeletedUser = { name: '离职的人', role: 'staff', salt: '', hash: '', iterations: 0,
    deleted_at: '2026-06-01T00:00:00.000Z', rev: 2, updated_at: '2026-06-01T00:00:00.000Z' };
  const oldCopy = { name: '离职的人', role: 'staff', salt: '', hash: '', iterations: 0, rev: 1, updated_at: '2026-05-01T00:00:00.000Z' };
  const mUser = S.mergeSyncPayload(payload({ users: [softDeletedUser] }), payload({ users: [oldCopy] }));
  ok('软删除的账号不会被别人手上的旧版本顶回来（rev 更高，本来就压得住）',
    mUser.users.find(u => u.name === '离职的人').deleted_at === '2026-06-01T00:00:00.000Z');
  const mUser2 = S.mergeSyncPayload(
    payload({ users: [], purged: [{ entity: 'user', id: '离职的人', at: '2026-06-01T00:00:00.000Z', by: '甲' }] }),
    payload({ users: [oldCopy] }));
  ok('万一以后改成硬删账号，墓碑也拦得住', !mUser2.users.some(u => u.name === '离职的人'));

  section('撤销：Ctrl+Z 撤销"彻底删除"时，墓碑也要一起回退（否则撤销是假的）');
  restore();
  S.DB.purged = [];
  await S.Repo.upsert('task', mkTask('p27_undo'));
  S.snapshot();
  await S.Repo.removeHard('task', 'p27_undo');
  ok('删掉了，且有墓碑', !S.byId('task', 'p27_undo') && S.DB.purged.some(p => p.id === 'p27_undo'));
  await S.undoLast();
  ok('撤销后记录回来了', !!S.byId('task', 'p27_undo'));
  ok('墓碑也一起撤掉了（不然下次合并又会把它筛掉，撤销白撤）', !S.DB.purged.some(p => p.id === 'p27_undo'));
  // 端到端确认一次：撤销之后再跟共享文件合并一轮，记录必须还在
  const h = makeFakeFileHandle(JSON.stringify(S.filePayload(payload(), S.DB, 'w0')));
  S.setFileHandle(h);
  S.setLastSyncedMtime(0);
  await S.syncToFile(S.DB);
  ok('撤销之后再同步一轮，记录确实还在（撤销是真的）', !!S.byId('task', 'p27_undo'));
  S.setFileHandle(null);

  section('端到端：本机彻底删除后同步，共享文件里那条也没了，而且不会被下一轮合并带回来');
  S.DB.purged = [];
  await S.Repo.upsert('task', mkTask('p27_e2e'));
  // 共享文件里现在还留着这条（模拟别人手上的旧状态）
  const h2 = makeFakeFileHandle(JSON.stringify(S.filePayload(payload({ tasks: [mkTask('p27_e2e')] }), S.DB, 'w0')));
  S.setFileHandle(h2);
  S.setLastSyncedMtime(0);
  await S.Repo.removeHard('task', 'p27_e2e');   // 内部会 persist → syncToFile
  const written = JSON.parse(h2._writes[h2._writes.length - 1]);
  ok('写回共享文件的内容里，这条任务没了', !written.tasks.some(t => t.id === 'p27_e2e'), written.tasks.map(t => t.id));
  ok('共享文件里带上了墓碑', (written.purged || []).some(p => p.id === 'p27_e2e'));
  ok('本机内存里也没了', !S.byId('task', 'p27_e2e'));
  // 再来一台还没同步的设备把这条推上来：合并之后依然不该复活
  h2._text = JSON.stringify(S.filePayload(payload({ tasks: [mkTask('p27_e2e')], purged: written.purged }), S.DB, 'w_other'));
  h2._mtime += 5;
  await S.syncToFile(S.DB);
  ok('别人推上来也没能复活', !S.byId('task', 'p27_e2e'));
  const written2 = JSON.parse(h2._writes[h2._writes.length - 1]);
  ok('写回去的内容里也依然没有它', !written2.tasks.some(t => t.id === 'p27_e2e'));
  S.setFileHandle(null);

  section('回归：普通软删除的行为没被这次改动影响');
  restore();
  const anyTask = S.DB.tasks.find(t => !t.deleted_at);
  S.softDelete('task', anyTask.id);
  ok('软删除只是打标记，记录还在数组里', !!S.byId('task', anyTask.id) && !!S.byId('task', anyTask.id).deleted_at);
  ok('软删除不会往墓碑表里写东西', !S.DB.purged.some(p => p.id === anyTask.id));
  S.undelete('task', anyTask.id);
  ok('恢复也正常', !S.byId('task', anyTask.id).deleted_at);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
