/* P88：多人协同同步的"整机模拟"回归——在 P86/P87 之后再做一轮全面排查
   前两批修的是已经出事的那条路径（旧页面顶回同事的改动）。这一批把共享文件同步当成一个
   分布式系统来测：模拟多台设备各自读—合并—写同一个文件，断言几条硬性质：
     · 不丢改动：两个人改不同字段，两边都要在
     · 会收敛：任意顺序同步若干轮之后，所有设备内容必须完全一致
     · 不空转：什么都没改的设备不许写文件（网盘上每一次写都是一次抢锁）
     · 不复活：删掉的东西不许因为别人手里还有旧副本又飘回来
     · 版本号不无限膨胀：同步再多轮，rev 也不能一直往上爬
   用法：node test/test-p88.js */
const { sandbox: S } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

/* ---------- 一台设备 + 一个共享文件的最小模型 ---------- */
function emptyPayload() {
  return { duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [], purged: [],
    permissionMatrix: null, shareConfig: null, reportConfig: null };
}
function mkFile(payload) { return { payload: cp(payload || emptyPayload()) }; }
function mkDevice(name, file, clockSkewMin) {
  return { name, db: cp(file.payload), base: S.buildSyncBase(file.payload), skew: (clockSkewMin || 0) * 60000 };
}
// 在这台设备上改一条记录的某几个字段——完全照 stampMeta 的规则来，时间戳用这台机器自己的"时钟"
function devEdit(dev, listKey, pk, id, patch) {
  const rec = (dev.db[listKey] || []).find(r => r[pk] === id);
  if (!rec) throw new Error(dev.name + ' 找不到记录 ' + id);
  Object.assign(rec, patch);
  rec.rev = (rec.rev || 0) + 1;
  rec.updated_at = new Date(Date.now() + dev.skew).toISOString();
  rec.updated_by = dev.name;
  return rec;
}
function devAdd(dev, listKey, rec) {
  dev.db[listKey].push(Object.assign({ rev: 1, updated_at: new Date(Date.now() + dev.skew).toISOString(),
    updated_by: dev.name, created_at: new Date(Date.now() + dev.skew).toISOString() }, rec));
}
// 读—合并—写，跟 syncToFile 的顺序完全一致（含"没东西要推就不写"那一步）
function devSync(dev, file) {
  const localBefore = cp(dev.db);
  const merged = S.mergeSyncPayload(dev.db, file.payload, dev.base);
  dev.db = merged;
  if (!S.hasLocalContribution(localBefore, file.payload, dev.base)) {
    dev.base = S.buildSyncBase(file.payload);
    return false;   // 没写
  }
  file.payload = cp(merged);
  dev.base = S.buildSyncBase(merged);
  return true;      // 写了
}
// 只读拉取，跟 pullFromFile 一致（基线对齐到"文件当前内容"，不是合并结果）
function devPull(dev, file) {
  const merged = S.mergeSyncPayload(dev.db, file.payload, dev.base);
  dev.db = merged;
  dev.base = S.buildSyncBase(file.payload);
}
const findTask = (payload, id) => (payload.tasks || []).find(t => t.id === id);
// 把若干设备反复同步到不再有人写为止，返回轮数（收敛性靠它验证）
function settle(devs, file, maxRounds) {
  for (let round = 1; round <= (maxRounds || 12); round++) {
    let wrote = false;
    devs.forEach(d => { if (devSync(d, file)) wrote = true; });
    if (!wrote) return round;
  }
  return -1;   // 没停下来
}
function allSame(devs, file, id) {
  const sig = d => JSON.stringify(findTask(d.db, id));
  const first = sig(devs[0]);
  return devs.every(d => sig(d) === first) && JSON.stringify(findTask(file.payload, id)) === first;
}

async function main() {
  await tick(60);

  const seedTask = { id: 'x1', title: '基础任务', status: 'todo', priority: '2', assignees: [], progress: 0,
    plan_date: '2026-12-01', source: '', custom: '', work: 'w1', code: '01012601',
    rev: 1, updated_at: '2026-09-01T00:00:00.000Z', updated_by: '初始', created_at: '2026-09-01T00:00:00.000Z' };
  const seed = Object.assign(emptyPayload(), { tasks: [seedTask] });

  section('①：★三台设备各改同一条任务的不同字段——一个都不能丢');
  let file = mkFile(seed);
  let a = mkDevice('甲', file), b = mkDevice('乙', file), c = mkDevice('丙', file);
  devEdit(a, 'tasks', 'id', 'x1', { status: 'done' });
  devEdit(b, 'tasks', 'id', 'x1', { priority: '1' });
  devEdit(c, 'tasks', 'id', 'x1', { plan_date: '2026-10-01' });
  const rounds = settle([a, b, c], file);
  const fin = findTask(file.payload, 'x1');
  ok('★甲改的状态在', fin.status === 'done', fin.status);
  ok('★乙改的优先级在', fin.priority === '1', fin.priority);
  ok('★丙改的计划完成时间在', fin.plan_date === '2026-10-01', fin.plan_date);
  ok('★同步在有限轮内收敛了（不会你推我我推你没完）', rounds > 0, rounds);
  ok('★三台设备和文件内容完全一致', allSame([a, b, c], file, 'x1'));

  section('②：★没有任何改动的设备，绝不写文件（网盘上每一次写都在跟别人抢）');
  file = mkFile(seed);
  const reader = mkDevice('只看不改的人', file);
  ok('★第一次同步就不写', devSync(reader, file) === false);
  ok('★连续同步十次仍然一次都不写', [...Array(10)].every(() => devSync(reader, file) === false));
  const writer = mkDevice('会改的人', file);
  devEdit(writer, 'tasks', 'id', 'x1', { status: 'doing' });
  ok('有改动的人正常写', devSync(writer, file) === true);
  ok('★别人写完之后，只看不改的人拉一次也仍然不需要写', (devPull(reader, file), devSync(reader, file)) === false);
  ok('★而且他确实拿到了别人的改动', findTask(reader.db, 'x1').status === 'doing');

  section('③：★长期离线的设备回来——它的改动要落地，别人的也不能被它冲掉');
  file = mkFile(seed);
  const online = mkDevice('在线的人', file);
  const offline = mkDevice('离线很久的人', file);       // 基线停在很早以前
  devEdit(online, 'tasks', 'id', 'x1', { status: 'done' });
  devSync(online, file);
  devEdit(online, 'tasks', 'id', 'x1', { plan_date: '2026-11-11' });
  devSync(online, file);
  devEdit(offline, 'tasks', 'id', 'x1', { priority: '1' });   // 他手里还是最初那份
  devSync(offline, file);
  const t3 = findTask(file.payload, 'x1');
  ok('★离线的人改的优先级落地了', t3.priority === '1', t3.priority);
  ok('★在线的人先后两次改动都还在（状态）', t3.status === 'done', t3.status);
  ok('★在线的人先后两次改动都还在（计划完成时间）', t3.plan_date === '2026-11-11', t3.plan_date);

  section('④：★机器时钟严重偏差——不该影响"各改各字段"的结果');
  file = mkFile(seed);
  const fast = mkDevice('表快30分钟', file, 30);
  const slow = mkDevice('表慢30分钟', file, -30);
  devEdit(slow, 'tasks', 'id', 'x1', { status: 'done' });     // 真实时间更早
  devSync(slow, file);
  devEdit(fast, 'tasks', 'id', 'x1', { priority: '1' });      // 真实时间更晚，但时间戳更早/更晚都不该影响
  devSync(fast, file);
  const t4 = findTask(file.payload, 'x1');
  ok('★两边各自的字段都在', t4.status === 'done' && t4.priority === '1', { s: t4.status, p: t4.priority });
  settle([fast, slow], file);
  ok('★最终一致', allSame([fast, slow], file, 'x1'));

  section('⑤：★同一字段真冲突——允许只有一个赢，但不允许长期分歧');
  file = mkFile(seed);
  a = mkDevice('甲', file); b = mkDevice('乙', file);
  devEdit(a, 'tasks', 'id', 'x1', { status: 'doing' });
  devEdit(b, 'tasks', 'id', 'x1', { status: 'done' });
  devSync(a, file); devSync(b, file);
  const r5 = settle([a, b], file);
  ok('★收敛了', r5 > 0, r5);
  ok('★两台设备和文件对同一个字段的看法完全一致（不会一台显示进行中、另一台显示已完成）',
    allSame([a, b], file, 'x1'), { a: findTask(a.db, 'x1').status, b: findTask(b.db, 'x1').status });
  ok('赢的那个值是两人中的一个，不会凭空变成第三个值',
    ['doing', 'done'].includes(findTask(file.payload, 'x1').status));

  section('⑥：★版本号不能无限膨胀（每同步一轮就抬一级的话，几天下来数字会很离谱）');
  file = mkFile(seed);
  a = mkDevice('甲', file); b = mkDevice('乙', file);
  devEdit(a, 'tasks', 'id', 'x1', { status: 'done' });
  devEdit(b, 'tasks', 'id', 'x1', { priority: '1' });
  settle([a, b], file);
  const revAfterMerge = findTask(file.payload, 'x1').rev;
  for (let i = 0; i < 20; i++) { devSync(a, file); devSync(b, file); devPull(a, file); devPull(b, file); }
  ok('★又空转 20 轮，版本号一动不动', findTask(file.payload, 'x1').rev === revAfterMerge,
    { 合并后: revAfterMerge, 空转20轮后: findTask(file.payload, 'x1').rev });

  section('⑦：★软删除不能被"别人手里的旧副本"复活');
  file = mkFile(seed);
  a = mkDevice('删的人', file); b = mkDevice('手里还留着旧副本的人', file);
  devEdit(a, 'tasks', 'id', 'x1', { deleted_at: '2026-09-02T00:00:00.000Z' });
  devSync(a, file);
  devSync(b, file);                       // b 什么都没改，只是同步
  ok('★删除同步到了 b', !!findTask(b.db, 'x1').deleted_at);
  devEdit(b, 'tasks', 'id', 'x1', { priority: '1' });   // b 又去改了一下（旧页面场景）
  devSync(b, file);
  ok('★b 改了别的字段，也不会把删除状态抹掉', !!findTask(file.payload, 'x1').deleted_at);

  section('⑧：★彻底删除（墓碑）——不能从别人的旧副本飘回来');
  file = mkFile(seed);
  a = mkDevice('彻底删的人', file); b = mkDevice('还没同步的人', file);
  a.db.tasks = a.db.tasks.filter(t => t.id !== 'x1');
  a.db.purged = [{ entity: 'task', id: 'x1', at: '2026-09-03T00:00:00.000Z', by: '甲' }];
  devSync(a, file);
  ok('★文件里这条没了', !findTask(file.payload, 'x1'));
  devSync(b, file);   // b 手里还有这条（没改过）
  ok('★b 同步之后也跟着没了，不会又推回文件里', !findTask(b.db, 'x1') && !findTask(file.payload, 'x1'));

  section('⑨：★里程碑：两个人各给同一条任务加一条不同的里程碑，两条都要在');
  file = mkFile(seed);
  a = mkDevice('甲', file); b = mkDevice('乙', file);
  devAdd(a, 'milestones', { id: 'ms_a', task: 'x1', plan_date: '2026-10-01', deliverable: '甲的交付物', report_level: 'section', done: '0' });
  devAdd(b, 'milestones', { id: 'ms_b', task: 'x1', plan_date: '2026-10-15', deliverable: '乙的交付物', report_level: 'section', done: '0' });
  settle([a, b], file);
  const msIds = (file.payload.milestones || []).map(m => m.id).sort();
  ok('★两条里程碑都在', JSON.stringify(msIds) === JSON.stringify(['ms_a', 'ms_b']), msIds);
  ok('★两台设备看到的一样', JSON.stringify((a.db.milestones || []).map(m => m.id).sort()) === JSON.stringify(msIds)
    && JSON.stringify((b.db.milestones || []).map(m => m.id).sort()) === JSON.stringify(msIds));

  section('⑩：★变更日志：两台设备各自记的都要留下来（排查问题全靠它）');
  file = mkFile(seed);
  a = mkDevice('甲', file); b = mkDevice('乙', file);
  a.db.changelog.push({ id: 'log_a', at: '2026-09-02T01:00:00.000Z', by: '甲', kind: 'edit', entity: 'task', refId: 'x1', summary: '甲改了状态' });
  b.db.changelog.push({ id: 'log_b', at: '2026-09-02T02:00:00.000Z', by: '乙', kind: 'edit', entity: 'task', refId: 'x1', summary: '乙改了优先级' });
  devEdit(a, 'tasks', 'id', 'x1', { status: 'done' });
  devEdit(b, 'tasks', 'id', 'x1', { priority: '1' });
  settle([a, b], file);
  const logIds = (file.payload.changelog || []).map(e => e.id).sort();
  ok('★两条日志都在', logIds.includes('log_a') && logIds.includes('log_b'), logIds);

  section('⑪：★新建记录：两个人同时各建一条新任务，两条都要活下来');
  file = mkFile(seed);
  a = mkDevice('甲', file); b = mkDevice('乙', file);
  devAdd(a, 'tasks', { id: 'new_a', title: '甲新建的', status: 'todo', work: 'w1', code: '01012602', assignees: [] });
  devAdd(b, 'tasks', { id: 'new_b', title: '乙新建的', status: 'todo', work: 'w1', code: '01012602', assignees: [] });
  settle([a, b], file);
  ok('★两条新任务都在', !!findTask(file.payload, 'new_a') && !!findTask(file.payload, 'new_b'));
  ok('★但它们的编号撞了——这正是多人同时新建时必然发生的情况',
    findTask(file.payload, 'new_a').code === findTask(file.payload, 'new_b').code);

  section('⑪：★撞号必须能被数据体检发现并修好（原来只查工作编号，任务编号没人管）');
  S.DB.tasks.length = 0; S.DB.works.length = 0; S.DB.duties.length = 0;
  await S.Repo.upsert('duty', { code: 'P88D', name: 'P88职责' });
  await S.Repo.upsert('work', { id: 'p88_w', duty: 'P88D', code: '8801', name: 'P88工作', owner: '甲', year: new Date().getFullYear() });
  await S.Repo.upsert('task', { id: 'p88_t1', work: 'p88_w', title: '甲建的', code: '88012601', status: 'todo', owner: '甲', assignees: [], created_at: '2026-09-01T00:00:00.000Z' });
  await S.Repo.upsert('task', { id: 'p88_t2', work: 'p88_w', title: '乙建的', code: '88012601', status: 'todo', owner: '乙', assignees: [], created_at: '2026-09-02T00:00:00.000Z' });
  S.rebuildIndex();
  const health = S.healthCheck();
  const codeIssue = (health.issues || []).find(i => i.k === 'dupTaskCode');
  ok('★体检查出了任务编号撞车', !!codeIssue && codeIssue.n === 1, codeIssue && codeIssue.n);
  ok('★定成 error 级（会让宽表导入认领到错误的任务，不能只当提醒）',
    codeIssue && codeIssue.level === 'error', codeIssue && codeIssue.level);
  ok('★修复说明写的是"重新编号"而不是"删掉"——两条都是真任务，一条都不能删',
    (S.fixHealthPreview('dupTaskCode') || {}).what.includes('重新生成编号'));
  await S.fixHealth('dupTaskCode');
  const t1 = S.byId('task', 'p88_t1'), t2 = S.byId('task', 'p88_t2');
  ok('★修完两条任务都还在', !!t1 && !!t2 && !t1.deleted_at && !t2.deleted_at);
  ok('★编号不再相同', t1.code !== t2.code, { t1: t1.code, t2: t2.code });
  ok('★先建的那条保留原编号，后建的才重新编', t1.code === '88012601', t1.code);
  ok('★重新编的号是按规则生成的（8 位、以工作编号+年度开头）',
    /^8801\d{4}$/.test(t2.code), t2.code);
  ok('★体检再跑一遍已经干净了', !(S.healthCheck().issues || []).some(i => i.k === 'dupTaskCode'));
  ok('★重新编号这件事也写进了日志（能查到是体检改的）',
    S.DB.changelog.some(e => (e.summary || '').includes('重新编号')));

  section('⑫：★共享文件被写坏/写空时，本机数据不能跟着一起没了');
  file = mkFile(seed);
  a = mkDevice('甲', file);
  devEdit(a, 'tasks', 'id', 'x1', { status: 'done' });
  devSync(a, file);
  const broken = mkFile(emptyPayload());          // 文件被别的程序清空了
  const before12 = cp(a.db.tasks);
  devSync(a, broken);
  ok('★本机那条任务还在', !!findTask(a.db, 'x1'));
  ok('★而且会把它重新写回文件里（自愈）', !!findTask(broken.payload, 'x1'));
  ok('★内容没被改坏', findTask(a.db, 'x1').status === 'done', findTask(a.db, 'x1').status);
  ok('本机记录条数没少', a.db.tasks.length === before12.length);

  section('⑬：★变更日志写满之后，不能变成"我推给你、你再推给我"的无限写入');
  // 日志有条数上限，合并时会丢掉最旧的。如果"我有你没有的日志"这个判断不排除
  // 已经被对方淘汰掉的老条目，两台设备会互相推同一批老日志，永远停不下来——
  // 网盘上就表现为文件被反复重写。这一条守的就是它。
  file = mkFile(seed);
  const bigLog = [];
  for (let i = 0; i < S.CHANGELOG_LIMIT + 50; i++) {
    bigLog.push({ id: 'L' + i, at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
      by: '甲', kind: 'edit', entity: 'task', refId: 'x1', summary: '第 ' + i + ' 条' });
  }
  file.payload.changelog = bigLog.slice(-S.CHANGELOG_LIMIT);      // 文件里是最新的那 800 条
  a = mkDevice('手里还留着老日志的人', file);
  a.db.changelog = bigLog.slice();                                 // 这台设备手里连最老的 50 条也还在
  devSync(a, file);                                                // 第一次可能会写（正常）
  let writes = 0;
  for (let i = 0; i < 8; i++) { if (devSync(a, file)) writes++; }
  ok('★后续同步不再反复写文件（老日志不会被当成"我有新东西"来回推）', writes === 0, writes);
  ok('日志条数守住了上限', file.payload.changelog.length <= S.CHANGELOG_LIMIT, file.payload.changelog.length);

  section('⑭：账号合并没有被这次改动影响（心跳取最晚、角色仍走授权检查）');
  file = mkFile(seed);
  file.payload.users = [{ name: '张三', role: 'staff', lastSeenAt: '2026-09-01T00:00:00.000Z', rev: 1, updated_at: '2026-09-01T00:00:00.000Z' }];
  a = mkDevice('甲', file); b = mkDevice('乙', file);
  a.db.users[0].lastSeenAt = '2026-09-03T00:00:00.000Z';   // 心跳刻意不走 stampMeta，rev 不变
  devSync(a, file);
  devSync(b, file);
  ok('★"最近连接"取两边更晚的那个（心跳不参与逐字段合并，走自己那套）',
    file.payload.users[0].lastSeenAt === '2026-09-03T00:00:00.000Z', file.payload.users[0].lastSeenAt);
  ok('★角色没有被心跳带着乱改', file.payload.users[0].role === 'staff');

  section('⑮：彻底删除 vs 同时有人在编辑');
  /* ★ 这一条在 P96 里改掉了，下面的断言跟着翻了个方向 ★
     原来的规则是"墓碑只剔掉最后修改时间早于墓碑时间的记录"，于是别人在彻底删除之后又改过的
     记录会重新出现。当时把它当成已知取舍留着，理由是"改了会让彻底删除更具破坏性"，
     并在这里留了一句"如果这条挂了，说明有人改了 applyPurged 的口径，请确认是有意为之"。

     后来拿演示数据做多设备长跑仿真，这条取舍的代价比当初估计的大得多：处里的机器时钟不同步，
     表快几分钟的那台上随便一次编辑（甚至一次新建）就能让墓碑失效，"彻底删掉的东西又回来了"
     是随机发生的，而不是"只有真的同时在编辑才会"。所以按主键性质分开处理：
     随机 id（工作/任务/里程碑）不可能重建出同 id，一律剔除；人填的编号（职责 code、账号姓名）
     确实会重建，保留豁免并改用 created_at 判。详见 index.html 里 applyPurged 的注释和 P96。 */
  file = mkFile(seed);
  a = mkDevice('彻底删的人', file); b = mkDevice('同时在编辑的人', file);
  a.db.tasks = a.db.tasks.filter(t => t.id !== 'x1');
  a.db.purged = [{ entity: 'task', id: 'x1', at: '2026-09-03T00:00:00.000Z', by: '甲' }];
  devSync(a, file);
  devEdit(b, 'tasks', 'id', 'x1', { status: 'done' });          // 时间戳是"现在"，晚于墓碑
  devSync(b, file);
  ok('★★墓碑之后还被编辑过的任务，不再复活了（P96 改的；原来会）',
    !findTask(file.payload, 'x1'), findTask(file.payload, 'x1'));
  // 反过来：没人碰过的，墓碑一定剔得掉（这条是硬要求，⑧已经测过，这里再从另一个角度确认）
  file = mkFile(seed);
  a = mkDevice('甲', file); b = mkDevice('乙', file);
  a.db.tasks = a.db.tasks.filter(t => t.id !== 'x1');
  a.db.purged = [{ entity: 'task', id: 'x1', at: new Date(Date.now() + 60000).toISOString(), by: '甲' }];
  devSync(a, file); devSync(b, file);
  ok('★没人碰过的记录，彻底删除一定生效', !findTask(file.payload, 'x1') && !findTask(b.db, 'x1'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
