/* P100：第十一轮排查

   这一轮换了个切法：不再顺着"合并算法本身对不对"往下查（前十轮基本都在那条线上），
   改成把【所有会把数据整批拿掉或整批换掉的动作】列成一张表，每一格问同样四个问题：
     ① 留墓碑了吗（不留 → 记录会从别人机器上原样飘回来，等于没删）
     ② 级联了吗（任务没级联 → 名下里程碑变成永远打不开的孤儿）
     ③ 把"本机对共享文件的记忆"（基线 + 写入链标记）清干净了吗
     ④ 它宣称的"可撤销"，撤销之后真的撤得掉吗

   查出来五处，前两处是同一个病根、也是这一轮最要紧的：

   ① ★ 彻底删除根本撤销不了 ★ 撤销（Ctrl+Z）和合并熔断的"一键回滚"都会把记录塞回本机列表，
      并且【只在本机】把墓碑删掉。可墓碑早就随上一次保存进了共享文件，mergePurged 取的是并集，
      下一轮合并立刻把它捡回来，applyPurged 再把刚恢复的记录原样杀一遍。
      而撤销自己就要落盘，Repo.persist 当场同步一轮——于是记录在【同一次点击里】就没了。
      实测：彻底删掉一条任务后按 Ctrl+Z，界面提示"已撤销"，任务一条都没回来。
      合并熔断那个红色告警上的"回滚"按钮同理：告警里被彻底删掉的那部分，点了等于没点，
      而它恰恰是为"谁误点了批量删除"准备的。
      修法：墓碑不能靠"本机删掉"来撤销，必须留一条能同步出去的作废声明（见 revokePurge）。

   ② ★「清除全部测试任务」是一次没留墓碑、没级联的硬删 ★ 直接 DB.tasks = DB.tasks.filter(...)。
      没墓碑 → 保存那一步自己就会同步一轮，共享文件里还留着这些任务，它们在同一次点击里就回来了，
      界面上的数字纹丝不动；没级联 → 名下里程碑成了孤儿。

   ③ ★ 断开共享连接不清基线和写入链标记 ★ 断开再连另一个共享文件夹，第一次同步就会拿着旧文件的
      lastWriteId 去问新文件的写入链"我那次写还在吗"，当然不在 → 白报一条"你的保存被覆盖了"，
      还会拿另一个文件的基线做回滚，把基线污染成两个文件混起来的东西。首次连接那条分支同病。

   ④ ★ 写入被抢先、重来一轮时，基线没跟着推进 ★ 这一处会真丢同事的改动：
      文件是 v1（乙改了牵头人）。我改了优先级，读到 v1 合并完（我这边牵头人变成乙），
      正要写时发现文件已经被丙改成 v2（丙在 v1 基础上把牵头人改成丙）→ 放弃重来。
      第二轮里基线还停在 v0（牵头人=甲），于是"乙"被算成我的改动、"丙"被算成对方的改动
      → 判成"两个人同时改了同一个字段"，我手里那个我根本没改过的"乙"赢了，
      丙刚写进文件的改动被顶掉，日志里还留下一条假冲突告警。

   ⑤ connectSharedFile 里 rebuildIndex 排在冲突播报之后，报出来的冲突拿的是合并前那份索引。

   用法：node test/test-p100.js */
const { sandbox: S } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });

/* 假共享文件句柄。★ text() 必须返回"getFile 那一刻"的快照 ★
   真实的 File 对象就是这个语义；如果偷懒写成 () => h._text，"读完之后别人抢先写一次"
   这种注入会连第一次读到的内容一起改掉，本该走到重试分支的用例会悄悄走成一次性成功——
   这一轮的 ④ 一开始就是这么被漏过去的。 */
function mkHandle(text) {
  const h = {
    name: 'shared.json', _text: text, _mtime: 1000, _writes: [], _reads: 0,
    stealAfterRead: null, _stealCountdown: 0,
    async getFile() {
      h._reads++;
      const snap = h._text;
      const f = { lastModified: h._mtime, text: async () => snap };
      if (h.stealAfterRead !== null && --h._stealCountdown <= 0) {
        h._text = h.stealAfterRead; h.stealAfterRead = null; h._mtime += 1;
      }
      return f;
    },
    arm(n, t) { h.stealAfterRead = t; h._stealCountdown = n; },
    async createWritable() {
      return {
        async write(t) { h._pending = t; },
        async close() { h._writes.push(h._pending); h._text = h._pending; h._mtime += 1; },
      };
    },
  };
  return h;
}
const fileOf = h => JSON.parse(h._text);

function reset() {
  S.DB.duties = []; S.DB.works = []; S.DB.milestones = []; S.DB.tasks = [];
  S.DB.changelog = []; S.DB.purged = [];
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.undoStack.length = 0;
  S.setFileHandle(null);
  S.setSnackPriorityUntil(0);
  S.clearMergeAlert();
  S.rebuildIndex();
}
const mkTask = (id, extra) => S.stampMeta(S.blank('task', Object.assign({ id, title: id + ' 任务', owner: '测试管理员' }, extra)));
const mkMs = (id, task) => S.stampMeta(S.blank('milestone', { id, task, deliverable: id + ' 交付物', plan_date: '2026-10-01' }));

async function main() {
  await tick(80);
  S.DB.settings.me = '测试管理员';

  /* ================================================================= */
  section('一、墓碑的"作废声明"：同一把钥匙、时间更晚、打 undone 标记');
  {
    reset();
    S.DB.tasks = [mkTask('X1')]; S.rebuildIndex();
    S.recordPurge('task', 'X1');
    const tomb = S.DB.purged.find(p => p.id === 'X1');
    ok('彻底删除留下一块普通墓碑', !!tomb && !S.purgeIsUndone(tomb));

    S.revokePurge('task', 'X1');
    const rev = S.DB.purged.filter(p => p.id === 'X1');
    ok('★撤销之后还是只有一条（换掉，不是并排放两条）', rev.length === 1, rev);
    ok('★钥匙没变（entity+id 一样，合并时才压得住原来那块）', rev[0].entity === 'task' && rev[0].id === 'X1');
    ok('★打上了 undone 标记', S.purgeIsUndone(rev[0]) === true);
    ok('★时间戳比原来那块晚（mergePurged 取最晚的那条，早了就等于没撤）',
      (rev[0].at || '') > (tomb.at || ''), [rev[0].at, tomb.at]);

    // 机器时钟慢的情况：本机的"现在"比对方记的墓碑还早，也必须排到它后面
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    ok('★本机表慢时也压得住（不能只信本机的"现在"）', S.nextPurgeAt(future) > future, [S.nextPurgeAt(future), future]);
    ok('正常情况下就用当前时间，不凭空造未来时间', S.nextPurgeAt('2020-01-01T00:00:00.000Z') <= new Date().toISOString());
  }
  {
    reset();
    const t = mkTask('X2');
    const undone = { entity: 'task', id: 'X2', at: '2026-09-02T00:00:00.000Z', by: '甲', undone: true };
    const tomb = { entity: 'task', id: 'X2', at: '2026-09-01T00:00:00.000Z', by: '甲' };
    ok('★applyPurged：作废声明生效，记录留下来', S.applyPurged('task', 'id', [t], [undone]).length === 1);
    ok('★applyPurged：不看数组顺序，只看谁的时间戳晚（旧墓碑排在后面也压不过它）',
      S.applyPurged('task', 'id', [t], [undone, tomb]).length === 1
      && S.applyPurged('task', 'id', [t], [tomb, undone]).length === 1);
    ok('回归：普通墓碑照样把随机 id 的记录剔掉', S.applyPurged('task', 'id', [t], [tomb]).length === 0);

    const ms = mkMs('XM2', 'X2');
    ok('★所属任务的墓碑被撤销了，名下里程碑就不能跟着被端掉',
      S.dropMilestonesOfPurgedTasks([ms], [undone], []).length === 1);
    ok('回归：所属任务真被彻底删了，里程碑仍然要清掉',
      S.dropMilestonesOfPurgedTasks([ms], [tomb], []).length === 0);

    const m = S.mergePurged([undone], [tomb]);
    ok('★mergePurged：并集里同一把钥匙取时间最晚的那条 → 作废声明胜出',
      m.length === 1 && S.purgeIsUndone(m[0]) === true, m);
    const m2 = S.mergePurged([undone], [{ entity: 'task', id: 'X2', at: '2026-09-03T00:00:00.000Z', by: '乙' }]);
    ok('★反过来也成立：作废之后又有人正经删了一次（时间更晚）→ 重新生效',
      m2.length === 1 && !S.purgeIsUndone(m2[0]), m2);
  }
  {
    /* ★★ 平局必须有确定的答案 ★★（这一条是多设备长跑仿真 sim10 抓出来的，不是想出来的）
       只比时间戳的话，两条 at 一模一样的条目谁赢取决于数组顺序，而每台设备的顺序都是
       【自己的在前、文件里的在后】——于是甲永远留自己那条、乙永远留自己那条，
       两边对同一条记录的死活【永久对不齐】，而且双方都判定"我没有新东西要推"，谁也纠正不了谁。
       仿真里这一幕出现得并不罕见：两台机器都还没看见对方那条，各自按自己的时钟盖了同一个毫秒。 */
    reset();
    const t = mkTask('X9');
    const AT = '2026-09-05T00:00:00.000Z';
    const del = { entity: 'task', id: 'X9', at: AT, by: '甲' };
    const und = { entity: 'task', id: 'X9', at: AT, by: '乙', undone: true };
    const a = S.mergePurged([del], [und]), b = S.mergePurged([und], [del]);
    ok('★★时间戳打平时，两台设备算出来的结果必须一模一样', JSON.stringify(a) === JSON.stringify(b), [a, b]);
    ok('★平局时保留记录（宁可让人再删一次，也不能删错）', S.purgeIsUndone(a[0]) === true, a);
    const c1 = S.mergePurged([{ entity: 'task', id: 'X9', at: AT, by: '甲' }], [{ entity: 'task', id: 'X9', at: AT, by: '乙' }]);
    const c2 = S.mergePurged([{ entity: 'task', id: 'X9', at: AT, by: '乙' }], [{ entity: 'task', id: 'X9', at: AT, by: '甲' }]);
    ok('★连记录人都参与定序，任何平局都算得出同一个答案', JSON.stringify(c1) === JSON.stringify(c2), [c1, c2]);
    ok('★★applyPurged 跟 mergePurged 用的是同一把尺子（两把尺子不一样就会自己跟自己打架）',
      S.applyPurged('task', 'id', [t], [del, und]).length === 1
      && S.applyPurged('task', 'id', [t], [und, del]).length === 1);
    const local = Object.assign(EMPTY(), { purged: [del] });
    const remote = Object.assign(EMPTY(), { purged: [und] });
    ok('★★平局时我这条是输的那一方 → 不能判成"我有新东西要推"（否则两台机器会互相推到天荒地老）',
      S.hasLocalContribution(local, remote, null) === false);
    ok('★★平局时我这条是赢的那一方 → 必须判成"要推"，不然对方永远收不到，两边死活对不齐',
      S.hasLocalContribution(Object.assign(EMPTY(), { purged: [und] }),
        Object.assign(EMPTY(), { purged: [del] }), null) === true);
  }
  {
    // 作废声明必须判定成"我有东西要推"，否则它永远出不了本机，撤销还是假的
    reset();
    const key = { entity: 'task', id: 'X3', by: '甲' };
    const local = Object.assign(EMPTY(), { purged: [Object.assign({ at: '2026-09-02T00:00:00.000Z', undone: true }, key)] });
    const remote = Object.assign(EMPTY(), { purged: [Object.assign({ at: '2026-09-01T00:00:00.000Z' }, key)] });
    ok('★★hasLocalContribution 认得"同一把钥匙但我这条更晚"（原来只看钥匙在不在，作废声明永远推不出去）',
      S.hasLocalContribution(local, remote, null) === true);
    ok('回归：一模一样的墓碑不算"有东西要推"（不然会写个不停）',
      S.hasLocalContribution(Object.assign(EMPTY(), { purged: [Object.assign({ at: '2026-09-01T00:00:00.000Z' }, key)] }),
        remote, null) === false);
  }

  /* ================================================================= */
  section('二、★★端到端：彻底删除一条任务，Ctrl+Z 之后它真的回来了（原来一条都回不来）');
  {
    reset();
    S.DB.tasks = [mkTask('U1')]; S.DB.milestones = [mkMs('UM1', 'U1')]; S.rebuildIndex();
    const h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION })));
    S.setFileHandle(h);
    await S.Repo.persist(S.DB);
    ok('先推上共享文件', fileOf(h).tasks.length === 1 && fileOf(h).milestones.length === 1);

    S.snapshot();
    await S.Repo.bulk(() => { S.cascadeRemoveHardTask('U1'); });
    ok('彻底删除：本机没了、墓碑两块（任务+里程碑）、共享文件里也没了',
      S.DB.tasks.length === 0 && S.DB.purged.length === 2 && fileOf(h).tasks.length === 0,
      [S.DB.tasks.length, S.DB.purged.length, fileOf(h).tasks.length]);
    ok('墓碑确实已经进了共享文件（这正是本机删不掉它的原因）', fileOf(h).purged.length === 2);

    await S.undoLast();
    await tick(20);
    ok('★★撤销之后任务真的回来了（原来这里是 0——同一次点击里就被自己的墓碑清掉了）',
      S.DB.tasks.length === 1 && !!S.byId('task', 'U1'), S.DB.tasks.length);
    ok('★★名下里程碑也回来了', S.DB.milestones.length === 1 && !!S.byId('milestone', 'UM1'));
    ok('★★而且推回了共享文件（不然只有我这台看得见，别人下次合并又会把它删掉）',
      fileOf(h).tasks.length === 1 && fileOf(h).milestones.length === 1,
      [fileOf(h).tasks.length, fileOf(h).milestones.length]);
    ok('★作废声明也跟着进了共享文件', fileOf(h).purged.filter(p => p.undone).length === 2);
    S.setFileHandle(null);
  }

  section('三、撤销之后再删一次，还得删得掉（时间戳要压得住那条作废声明）');
  {
    reset();
    S.DB.tasks = [mkTask('U2')]; S.rebuildIndex();
    const h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION })));
    S.setFileHandle(h);
    await S.Repo.persist(S.DB);
    S.snapshot();
    await S.Repo.bulk(() => { S.cascadeRemoveHardTask('U2'); });
    await S.undoLast();
    await tick(20);
    ok('撤销之后任务在', !!S.byId('task', 'U2'));

    S.snapshot();
    await S.Repo.bulk(() => { S.cascadeRemoveHardTask('U2'); });
    await tick(20);
    const tomb = S.DB.purged.filter(p => p.entity === 'task' && p.id === 'U2');
    ok('★再删一次：墓碑重新变成"有效"的那种', tomb.length === 1 && !S.purgeIsUndone(tomb[0]), tomb);
    ok('★★而且这次删得掉——本机和共享文件里都没有了',
      !S.byId('task', 'U2') && fileOf(h).tasks.length === 0, [S.DB.tasks.length, fileOf(h).tasks.length]);
    S.setFileHandle(null);
  }
  {
    /* 上面那一遍是在同一台机器上连着做的，时间天然递增，压不出真正的问题。
       真正会翻车的是这个形态：墓碑是【表快的那台机器】记的，时间戳落在本机的未来。
       recordPurge 如果直接用本机的"现在"，重新删一次写出来的时间戳反而更早，
       合并时会被那条作废声明压住——用户点了删除，第二天它又回来了。 */
    reset();
    S.DB.tasks = [mkTask('U5')]; S.rebuildIndex();
    const future = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    S.DB.purged = [{ entity: 'task', id: 'U5', at: future, by: '表快的同事' }];
    S.revokePurge('task', 'U5');
    const undoneAt = S.DB.purged.find(p => p.id === 'U5').at;
    ok('★作废声明排在那块"未来时间"的墓碑之后', undoneAt > future, [undoneAt, future]);
    S.recordPurge('task', 'U5');
    const again = S.DB.purged.find(p => p.id === 'U5');
    ok('★★本机表慢时，重新删一次的时间戳仍然压得住那条作废声明（否则删了等于没删）',
      !S.purgeIsUndone(again) && (again.at || '') > undoneAt, [again.at, undoneAt]);
    ok('★合并算一遍：这条确实被删掉了',
      S.applyPurged('task', 'id', S.DB.tasks, S.mergePurged(S.DB.purged, [])).length === 0);
  }

  section('四、撤销只撤自己那一次，不许顺手复活同事彻底删掉的东西');
  {
    reset();
    S.DB.tasks = [mkTask('U3'), mkTask('U4')]; S.rebuildIndex();
    S.snapshot();
    await S.Repo.bulk(() => { S.cascadeRemoveHardTask('U3'); });
    // 同事那台机器在这段窗口里彻底删了 U4，墓碑随同步进来
    S.DB.purged.push({ entity: 'task', id: 'U4', at: new Date().toISOString(), by: '同事乙' });
    S.DB.tasks = S.DB.tasks.filter(t => t.id !== 'U4'); S.rebuildIndex();

    await S.undoLast();
    await tick(10);
    const mine = S.DB.purged.find(p => p.id === 'U3');
    const his = S.DB.purged.find(p => p.id === 'U4');
    ok('★我自己那块墓碑被作废了', !!mine && S.purgeIsUndone(mine) === true);
    ok('★★同事那块墓碑原样不动（撤销越界去复活别人删掉的东西，比撤不掉严重得多）',
      !!his && !S.purgeIsUndone(his), his);
    /* 撤销是「整份拨回快照」，U4 在快照里，所以它会先回到本机列表——这没关系，
       同事那块墓碑还好好地在，下一次合并就会把它重新清掉。这里直接按合并算法验一遍。 */
    const alive = S.applyPurged('task', 'id', S.DB.tasks, S.DB.purged).map(t => t.id);
    ok('★★合并一算：我撤销的 U3 活下来，同事彻底删掉的 U4 照样没了',
      alive.indexOf('U3') !== -1 && alive.indexOf('U4') === -1, alive);
  }

  section('五、★合并熔断的"一键回滚"，被彻底删掉的那部分也要能回来');
  {
    reset();
    const t1 = mkTask('R1'), t2 = mkTask('R2');
    S.DB.tasks = [t1, t2]; S.rebuildIndex();
    const before = S.syncPayload(S.DB);
    S.armMergeDamageAlert(cp(before), { total: 2, tasks: 2, milestones: 0, works: 0, duties: 0, users: 0 });
    // 模拟"这次合并把它们彻底删了"：记录消失 + 墓碑进来
    S.DB.tasks = [];
    S.DB.purged = [{ entity: 'task', id: 'R1', at: new Date().toISOString(), by: '乙' },
      { entity: 'task', id: 'R2', at: new Date().toISOString(), by: '乙' }];
    S.rebuildIndex();
    ok('回滚之前：两条都没了', S.DB.tasks.length === 0);

    await S.restoreMergeDamage();
    await tick(10);
    ok('★记录塞回来了', S.DB.tasks.length === 2);
    ok('★★两块墓碑都被作废了（不作废的话，下一轮合并会把刚回滚的记录再清一遍，'
      + '用户看到的就是"点了回滚过一会儿又没了"）',
      S.DB.purged.filter(p => S.purgeIsUndone(p)).length === 2, S.DB.purged);
    ok('★★拿合并算法验一遍：这两条确实活得下来',
      S.applyPurged('task', 'id', S.DB.tasks, S.DB.purged).length === 2);
  }

  /* ================================================================= */
  section('六、★「清除全部测试任务」必须走正规的彻底删除（留墓碑 + 级联里程碑）');
  {
    reset();
    S.DB.tasks = [mkTask('C1', { custom: '测试' }), mkTask('C2')];
    S.DB.milestones = [mkMs('CM1', 'C1')];
    S.rebuildIndex();
    const h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION })));
    S.setFileHandle(h);
    await S.Repo.persist(S.DB);
    ok('先推上去：文件里两条任务、一个里程碑',
      fileOf(h).tasks.length === 2 && fileOf(h).milestones.length === 1);

    S.ACTIONS['clear-test']();
    await S.modalCallback();
    await tick(20);
    ok('★★测试任务真的没了（原来它在同一次点击里就从共享文件飘回来了，界面数字纹丝不动）',
      !S.byId('task', 'C1'), S.DB.tasks.map(t => t.id));
    ok('没有误伤别的任务', !!S.byId('task', 'C2'));
    ok('★留了墓碑：任务一块 + 里程碑一块（不留的话别人机器上还有，下次合并原样飘回来）',
      S.DB.purged.filter(p => p.id === 'C1' && !S.purgeIsUndone(p)).length === 1
      && S.DB.purged.filter(p => p.id === 'CM1' && !S.purgeIsUndone(p)).length === 1, S.DB.purged);
    ok('★级联清掉了名下里程碑，没留下打不开的孤儿',
      S.DB.milestones.filter(m => m.task === 'C1').length === 0);
    ok('★共享文件里也干净了', fileOf(h).tasks.length === 1 && fileOf(h).milestones.length === 0);

    // 再同步一轮：确认它不会飘回来（这一步才是"墓碑到底有没有用"的真考题）
    h._text = JSON.stringify(Object.assign(EMPTY(), {
      schemaVersion: S.DATA_SCHEMA_VERSION,
      tasks: [cp(S.DB.purged) && mkTask('C1', { custom: '测试' })], milestones: [mkMs('CM1', 'C1')],
    }));
    await S.Repo.persist(S.DB);
    ok('★★同事那台机器还留着它、又推了一次，也不会复活', !S.byId('task', 'C1'));
    S.setFileHandle(null);
  }

  /* ================================================================= */
  section('七、断开共享连接 = "我对这个共享文件的全部记忆"作废');
  {
    reset();
    S.DB.tasks = [mkTask('D1')]; S.rebuildIndex();
    const h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION })));
    S.setFileHandle(h); S.setEverConnected(true);
    await S.Repo.persist(S.DB);
    ok('写完之后基线和写入链标记都在', !!S.DB.syncBase && !!S.DB.settings.lastWriteId);

    await S.disconnectSharedFile();
    await tick(10);
    ok('★基线清了', S.DB.syncBase === null);
    ok('★★写入链标记也清了（只清基线的话，下次连别的文件夹一定误报"你的保存被覆盖了"）',
      !S.DB.settings.lastWriteId && !S.DB.settings.lastWriteIdAt && !S.lastWriteId && !S.preWriteBase);

    // 连上另一个共享文件夹：那个文件的写入链里当然没有我在旧文件里的标记
    const other = Object.assign(EMPTY(), {
      schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w_x', writeIds: ['w_a', 'w_b', 'w_x'],
      lastWriteBy: '乙', lastWriteAt: new Date().toISOString(),
    });
    ok('★★换个共享文件夹之后不再误报"被覆盖"', S.detectClobberedWrite(other, S.DB) === false);
  }

  /* ================================================================= */
  section('八、★★写入被抢先、重来一轮时，基线要推进到"刚才读到的那一份"');
  {
    reset();
    const base = S.blank('task', { id: 'W1', title: 'W 任务', owner: '甲', status: 'todo', priority: '2' });
    base.rev = 5; base.created_at = '2026-09-01T00:00:00.000Z';
    base.updated_at = '2026-09-01T00:00:00.000Z'; base.updated_by = '甲';
    S.DB.tasks = [cp(base)]; S.rebuildIndex();

    const h = mkHandle(JSON.stringify(Object.assign(EMPTY(), {
      schemaVersion: S.DATA_SCHEMA_VERSION, tasks: [cp(base)], writeId: 'w0', writeIds: ['w0'] })));
    S.setFileHandle(h);
    await S.Repo.persist(S.DB);      // 基线对齐到 v0
    S.setSnackPriorityUntil(0);

    // 乙 在 v0 上改牵头人 → v1；丙 在 v1 上改牵头人 → v2（rev 只加到 7，时间戳是几天前）
    const v1 = Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w1', writeIds: ['w0', 'w1'],
      tasks: [Object.assign(cp(base), { owner: '乙', rev: 6, updated_at: '2026-09-02T00:00:00.000Z', updated_by: '乙' })] });
    const v2 = Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w2', writeIds: ['w0', 'w1', 'w2'],
      tasks: [Object.assign(cp(base), { owner: '丙', rev: 7, updated_at: '2026-09-03T00:00:00.000Z', updated_by: '丙' })] });

    // 我只改优先级，一个字都没碰牵头人
    const mine = S.byId('task', 'W1');
    mine.priority = '1'; S.stampMeta(mine);

    h._text = JSON.stringify(v1);
    h._reads = 0; h._writes.length = 0;
    h.arm(1, JSON.stringify(v2));    // 我读到 v1 之后、写之前，丙把文件写成了 v2
    const logBefore = (S.DB.changelog || []).length;
    const res = await S.syncToFile(S.DB);
    const t = S.byId('task', 'W1');

    ok('确认真的走了"放弃这一轮、重来"这条路（读了 5 次以上）', h._reads >= 5, h._reads);
    ok('写成功了', res === 'written', res);
    ok('★★丙的改动没被顶掉（原来这里会变成"乙"——一个我根本没改过、只是上一轮读进来的值）',
      t.owner === '丙', t.owner);
    ok('★我自己那次改动照样推得出去', t.priority === '1' && fileOf(h).tasks[0].priority === '1');
    ok('★共享文件里也是丙的值', fileOf(h).tasks[0].owner === '丙');
    const fakeConf = (S.DB.changelog || []).slice(logBefore)
      .filter(e => JSON.stringify(e).indexOf('同一个字段') !== -1);
    ok('★★没有留下假的"两个人同时改了同一个字段"告警（我压根没碰过牵头人）',
      fakeConf.length === 0, fakeConf.map(e => (e.text || '').slice(0, 60)));
    S.setFileHandle(null);
  }

  section('九、回归：这一轮的基线推进不能把"没改动就别写"那个优化废掉');
  {
    reset();
    const t = mkTask('N1');
    S.DB.tasks = [t]; S.rebuildIndex();
    const h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION })));
    S.setFileHandle(h);
    await S.Repo.persist(S.DB);
    const writes = h._writes.length;
    // 同事改了这条任务、推上去了；我这边什么都没干
    const theirs = Object.assign(cp(t), { title: '同事改过的标题', rev: (t.rev || 0) + 5, updated_at: new Date().toISOString(), updated_by: '乙' });
    // 账号名单要沿用文件里那一份：心跳（lastSeenAt）本身也算「我有东西要推」，
    // 把 users 清空等于人为制造一条待推内容，那就测不到这里真正想测的东西了
    // 写入链要接在我那次写后面，不能另起一条：另起一条等于告诉本机「你上次那次写被人盖了」，
    // 那会触发基线回滚，本机立刻就有东西要推了，测的就不是这里想测的东西
    h._text = JSON.stringify(Object.assign(fileOf(h), {
      tasks: [theirs], writeId: 'wz', writeIds: (fileOf(h).writeIds || []).concat('wz') }));
    const res = await S.syncToFile(S.DB);
    ok('★我没有任何要推的东西 → 只读不写（十个人开着页面才不会互相写个不停）',
      res === 'nochange' && h._writes.length === writes, [res, h._writes.length - writes]);
    ok('对方的改动照样收进来了', S.byId('task', 'N1').title === '同事改过的标题');
    S.setFileHandle(null);
  }

  /* ================================================================= */
  section('十、源码接线自检（改坏任何一处，这一节就红）');
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
    const sliceFn = (name, len) => {
      const i = src.indexOf(name);
      return i === -1 ? '' : src.slice(i, i + len);
    };

    ok('★「清除全部测试任务」走 cascadeRemoveHardTask，不再直接 filter 掉',
      /ids\.forEach\(id => cascadeRemoveHardTask\(id\)\)/.test(sliceFn("'clear-test'", 1600)));
    ok('★★源码里再也没有"直接把任务从数组里 filter 掉"这种硬删',
      !/DB\.tasks = DB\.tasks\.filter\(t => t\.custom/.test(src));

    const disc = sliceFn('async function disconnectSharedFile', 1500);
    ok('★断开共享连接会清掉基线和写入链标记', /clearSyncBaseline\(DB\);/.test(disc));

    const conn = sliceFn('async function connectSharedFile', 7000);
    ok('★首次连接（整份采用共享文件）同样清写入链标记',
      /if \(firstEverConnect\) \{[\s\S]{0,600}?clearSyncBaseline\(DB\);/.test(conn));
    const iIdx = conn.indexOf('rebuildIndex();'), iConf = conn.indexOf('noteFieldConflicts();');
    ok('★connectSharedFile 里索引重建排在冲突播报之前（跟另外两条同步路径一致）',
      iIdx > 0 && iConf > 0 && iIdx < iConf, [iIdx, iConf]);

    const sync = sliceFn('async function syncToFileInner', 6000);
    const iNo = sync.indexOf("return 'nochange';");
    const iAdv = sync.indexOf('db.syncBase = buildSyncBase(cur.remote);', iNo);
    const iFresh = sync.indexOf('const fresh = await readSharedFile();');
    ok('★★基线推进那句在 nochange 判断【之后】、写前确认【之前】'
      + '（提前了会把"没改动就别写"的优化废掉，晚了就挡不住重试那一轮的假冲突）',
      iNo > 0 && iAdv > iNo && iFresh > iAdv, [iNo, iAdv, iFresh]);

    ok('★撤销把自己那批墓碑改成"作废声明"，不是本机悄悄抠掉',
      /minePurged\.forEach\(p => revokePurge\(p\.entity, p\.id\)\);/.test(src));
    ok('★合并熔断回滚也撤墓碑', /revokePurgesFor\(p\);/.test(sliceFn('async function restoreMergeDamage', 1600)));
    ok('★recordPurge 的时间戳压得住同一把钥匙上已有的条目',
      /const at = nextPurgeAt\(latestPurgeAt\(entity, id\)\);/.test(sliceFn('function recordPurge', 700)));

    /* 自检的自检：上面几条大多是"源码里有没有这句"，很容易在函数被改名/挪走之后
       变成永远为真的空断言。所以顺手确认这些名字确实还都在。 */
    ['function purgeIsUndone', 'function revokePurge', 'function revokePurgesFor',
      'function nextPurgeAt', 'function latestPurgeAt'].forEach(n => {
      ok('存在：' + n, src.indexOf(n) !== -1);
    });
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
