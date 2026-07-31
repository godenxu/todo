/* P48：不再"没改动也照写整个共享文件"

   背景：处里的共享文件夹是公司自研的挂载盘（有个客户端小程序，关掉盘就没了，本地没有副本），
   服务器上只有一份文件。这种环境下每一次写入都要穿过网盘驱动、刷掉它的缓存、跟别人抢同一个文件。
   而在此之前，只要 Repo.persist 被调用就一定重写整个文件——包括 5 分钟一轮的定时同步。
   也就是说十个人开着页面什么都不干，共享文件也会每 5 分钟被完整重写十次，
   这些写入里绝大多数一个字节的新内容都没有，纯粹是我们自己制造出来的负担。

   本轮改动：
   ① syncToFile 读—合并之后加一道判断（hasLocalContribution）：本机有没有"文件里还没有的东西"？
      没有就直接返回，不写。读和合并照旧——对方的新内容该进来还是进来，界面该刷新还是刷新。
   ② 「最近连接」心跳（markUserSeen）从 Repo.persist 挪进 syncToFile 的写入分支里，
      只在真的要写文件时搭顺风车，绝不为它单独写一次。
      放在原来的位置会让每次 persist 都改到 users，于是"有没有新东西"永远判定为有，①就白做了。
      代价：这一列的含义从"最近一次打开着页面"变成"最近一次真正保存过改动"。
   用法：node test/test-p48.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

function makeFileHandle(store) {
  return {
    name: 'shared.json',
    async getFile() { return { text: async () => store.text, lastModified: store.mtime || 1 }; },
    async createWritable() {
      return {
        async write(t) { store.text = t; store.mtime = (store.mtime || 1) + 1; store.writes++; },
        async close() {},
      };
    },
  };
}
// 造一份"文件里已有的内容"：拿当前 DB 的同步载荷原样当文件内容，此时本机跟文件完全一致
function seedFileFromDB(store) {
  store.text = JSON.stringify(Object.assign(S.syncPayload(S.DB), {
    schemaVersion: S.DATA_SCHEMA_VERSION, lastWriteBy: '别人', lastWriteApp: S.APP_VERSION,
    lastWriteAt: new Date().toISOString(), writeId: 'seed',
  }));
  store.mtime = (store.mtime || 1) + 1;
  store.writes = 0;
}

async function main() {
  await tick(60);
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakLog = JSON.parse(JSON.stringify(S.DB.changelog));
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.changelog = JSON.parse(JSON.stringify(bakLog));
    S.DB.settings.me = bakMe;
    S.DB.settings.pendingSync = false;
    S.setFileHandle(null); S.setDirHandle(null); S.setEverConnected(false);
    S.rebuildIndex();
  };

  section('★①：hasLocalContribution —— 判断"本机有没有文件里还没有的东西"');
  const empty = { duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [], purged: [] };
  const rec = (id, rev, at) => ({ id, rev, updated_at: at });
  ok('两边完全一样 → 没有要推的',
    S.hasLocalContribution(
      Object.assign({}, empty, { tasks: [rec('t1', 2, '2026-01-01T00:00:00.000Z')] }),
      Object.assign({}, empty, { tasks: [rec('t1', 2, '2026-01-01T00:00:00.000Z')] })) === false);
  ok('★本机有一条文件里没有的记录 → 要推',
    S.hasLocalContribution(
      Object.assign({}, empty, { tasks: [rec('t1', 1, '2026-01-01T00:00:00.000Z'), rec('t2', 1, '2026-01-01T00:00:00.000Z')] }),
      Object.assign({}, empty, { tasks: [rec('t1', 1, '2026-01-01T00:00:00.000Z')] })) === true);
  ok('★本机某条版本号更高 → 要推',
    S.hasLocalContribution(
      Object.assign({}, empty, { tasks: [rec('t1', 5, '2026-01-01T00:00:00.000Z')] }),
      Object.assign({}, empty, { tasks: [rec('t1', 2, '2026-01-01T00:00:00.000Z')] })) === true);
  ok('★纯粹是对方比我新（我这边全是旧的）→ 不用推',
    S.hasLocalContribution(
      Object.assign({}, empty, { tasks: [rec('t1', 2, '2026-01-01T00:00:00.000Z')] }),
      Object.assign({}, empty, { tasks: [rec('t1', 9, '2026-01-01T00:00:00.000Z'), rec('t9', 1, '2026-01-01T00:00:00.000Z')] })) === false);
  ok('职责/工作/里程碑/账号各自的主键也认得出来',
    S.hasLocalContribution(Object.assign({}, empty, { duties: [{ code: 'D1', rev: 1 }] }), empty) === true
    && S.hasLocalContribution(Object.assign({}, empty, { users: [{ name: '张三', rev: 1 }] }), empty) === true);

  section('★①：权限矩阵 / 共享文件夹配置是整体比版本，跟合并规则保持一致');
  ok('本机矩阵版本更高 → 要推',
    S.hasLocalContribution(
      Object.assign({}, empty, { permissionMatrix: { rev: 3, updated_at: '2026-01-02T00:00:00.000Z' } }),
      Object.assign({}, empty, { permissionMatrix: { rev: 1, updated_at: '2026-01-01T00:00:00.000Z' } })) === true);
  ok('本机矩阵更旧 → 不用推',
    S.hasLocalContribution(
      Object.assign({}, empty, { permissionMatrix: { rev: 1, updated_at: '2026-01-01T00:00:00.000Z' } }),
      Object.assign({}, empty, { permissionMatrix: { rev: 3, updated_at: '2026-01-02T00:00:00.000Z' } })) === false);
  ok('shareConfig 同理',
    S.hasLocalContribution(
      Object.assign({}, empty, { shareConfig: { rev: 2, updated_at: '2026-01-02T00:00:00.000Z' } }),
      Object.assign({}, empty, { shareConfig: { rev: 1, updated_at: '2026-01-01T00:00:00.000Z' } })) === true);

  section('★①：changelog / purged 是封顶的，不能因为"我还留着对方已经淘汰的老条目"就一直判定要推');
  // 对方最旧的一条是 2026-06-01；我这边多出来的那条比它还老，说明是对方已经淘汰掉的历史，不该算"新东西"
  ok('★我多出来的是比对方最旧那条还老的条目 → 不算新东西（否则会推上去、被淘汰、再推，永远停不下来）',
    S.hasLocalContribution(
      Object.assign({}, empty, { changelog: [{ id: 'old', at: '2026-01-01T00:00:00.000Z' }, { id: 'keep', at: '2026-07-01T00:00:00.000Z' }] }),
      Object.assign({}, empty, { changelog: [{ id: 'keep', at: '2026-07-01T00:00:00.000Z' }, { id: 'x', at: '2026-06-01T00:00:00.000Z' }] })) === false);
  ok('我多出来的是比对方最旧那条更新的条目 → 确实是新东西，要推',
    S.hasLocalContribution(
      Object.assign({}, empty, { changelog: [{ id: 'fresh', at: '2026-08-01T00:00:00.000Z' }] }),
      Object.assign({}, empty, { changelog: [{ id: 'x', at: '2026-06-01T00:00:00.000Z' }] })) === true);
  ok('purged 墓碑同样按这个规则',
    S.hasLocalContribution(
      Object.assign({}, empty, { purged: [{ entity: 'task', id: 'gone', at: '2026-08-01T00:00:00.000Z' }] }),
      Object.assign({}, empty, { purged: [{ entity: 'task', id: 'other', at: '2026-06-01T00:00:00.000Z' }] })) === true);

  section('★①：端到端——本机什么都没改时，定时同步不写文件');
  restore();
  const store = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeFileHandle(store));
  S.setEverConnected(true);
  await S.Repo.persist(S.DB);          // 先把本机数据推上去，此后两边一致
  seedFileFromDB(store);               // 文件内容 = 本机内容，写入计数归零
  await S.syncNowAndRender();          // 这就是 5 分钟定时器实际调用的那个函数
  ok('★第一轮定时同步：一次都没写', store.writes === 0, store.writes);
  await S.syncNowAndRender();
  await S.syncNowAndRender();
  ok('★连着跑三轮，还是一次都没写（以前这里是每轮一次整文件重写）', store.writes === 0, store.writes);

  section('★①：端到端——本机真的改了东西，照常立刻写出去');
  const t = S.DB.tasks.find(x => !x.deleted_at);
  await S.Repo.upsert('task', Object.assign({}, t, { title: 'P48改过的标题' }));
  ok('★有真实改动时确实写了', store.writes >= 1, store.writes);
  ok('写出去的内容里带着这次改动', JSON.parse(store.text).tasks.some(x => x.title === 'P48改过的标题'));

  section('★①：改完之后再空跑定时同步，又回到"不写"');
  const afterEditWrites = store.writes;
  await S.syncNowAndRender();
  await S.syncNowAndRender();
  ok('★改动推上去之后，后续空转不再产生写入', store.writes === afterEditWrites, { before: afterEditWrites, after: store.writes });

  section('★①：只改本机私有设置（不进共享文件的那些）也不该触发写入');
  const beforeSettingsWrites = store.writes;
  S.DB.settings.autoBackupDirName = 'P48备份文件夹';   // settings 不在 syncPayload 里
  await S.Repo.persist(S.DB);
  ok('★本机私有设置不进共享文件，改了也不用写', store.writes === beforeSettingsWrites, { before: beforeSettingsWrites, after: store.writes });

  section('★②：「最近连接」心跳只在真写文件时搭车，不为它单独写一次');
  restore();
  const store2 = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeFileHandle(store2));
  S.setEverConnected(true);
  S.DB.settings.me = '测试管理员';
  await S.Repo.persist(S.DB);
  // 注意顺序：必须先把心跳压成旧值，再拿这份 DB 去铺文件内容。
  // 反过来的话文件里留着的是刚才那个新值，合并时 mergeUserPresence 会取较晚的那个，
  // 把本机这个旧值又顶回去——那就不是"心跳被 markUserSeen 刷新了"，而是"合并把对方的值取回来了"，
  // 两件事完全不同，会让这条断言测了个假东西
  const meUser = S.DB.users.find(u => u.name === '测试管理员');
  meUser.lastSeenAt = '2020-01-01T00:00:00.000Z';
  seedFileFromDB(store2);
  await S.syncNowAndRender();
  ok('★空转同步时不写文件，心跳也不动（不能为了记心跳白写一次）',
    store2.writes === 0 && S.DB.users.find(u => u.name === '测试管理员').lastSeenAt === '2020-01-01T00:00:00.000Z',
    { writes: store2.writes, lastSeenAt: S.DB.users.find(u => u.name === '测试管理员').lastSeenAt });
  const t2 = S.DB.tasks.find(x => !x.deleted_at);
  await S.Repo.upsert('task', Object.assign({}, t2, { title: 'P48心跳测试' }));
  ok('★有真实改动、真的写文件时，心跳跟着更新了',
    S.DB.users.find(u => u.name === '测试管理员').lastSeenAt !== '2020-01-01T00:00:00.000Z',
    S.DB.users.find(u => u.name === '测试管理员').lastSeenAt);
  ok('写出去的文件里也带着这次心跳',
    (JSON.parse(store2.text).users.find(u => u.name === '测试管理员') || {}).lastSeenAt !== '2020-01-01T00:00:00.000Z');

  section('★②：pendingSync（积压未同步标记）在"没东西可推"时也要正确清掉');
  restore();
  const store3 = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeFileHandle(store3));
  S.setEverConnected(true);
  await S.Repo.persist(S.DB);
  seedFileFromDB(store3);
  S.DB.settings.pendingSync = true;   // 假装之前有过一次没推上去
  await S.Repo.persist(S.DB);
  ok('★没东西可推 = 也没什么积压了，标记要清掉，不能一直红着', S.DB.settings.pendingSync === false);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
