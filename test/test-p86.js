/* P86：多人同时填写时"同事改的状态过一阵又变回去"——同步合并机制的根因修复
   事故复盘：合并粒度是【整条记录】，谁的 rev 大听谁的、rev 平局比 updated_at。于是
   （1）开着旧页面的人只改了任务的某一个字段，保存时会把他手里那份【过期的其它字段】一起写回去；
   （2）两台机器都从同一个 rev 出发各自 +1，必然平局，胜负落到各自电脑的本地时钟上，谁的表快谁赢。
   修法：引入本机基线（DB.syncBase，上次跟文件对完账时文件里那份），改成逐字段的三方合并。
   用法：node test/test-p86.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// 把一批任务包成一份同步载荷
const P = tasks => ({ duties: [], works: [], milestones: [], tasks, changelog: [], users: [], purged: [] });
const cp = o => JSON.parse(JSON.stringify(o));

async function main() {
  await tick(60);

  const BASE = { id: 'p86_t', title: '原标题', status: 'todo', priority: '2', assignees: [], progress: 0,
    plan_date: '2026-09-30', rev: 5, updated_at: '2026-08-25T01:00:00.000Z', updated_by: '基线', created_at: '2026-08-01T00:00:00.000Z' };
  const baseMap = { task: { p86_t: cp(BASE) } };

  section('①：★核心事故场景——旧页面只改了优先级，不该把同事刚改的状态顶回去');
  const 乙 = Object.assign(cp(BASE), { status: 'done', rev: 6, updated_at: '2026-08-25T02:00:00.000Z', updated_by: '乙' });
  const 甲 = Object.assign(cp(BASE), { priority: '1', rev: 6, updated_at: '2026-08-25T02:30:00.000Z', updated_by: '甲' });
  const m1 = S.mergeSyncPayload(P([甲]), P([乙]), baseMap).tasks[0];
  ok('★乙改的状态保住了（这正是出事故的那个字段）', m1.status === 'done', m1.status);
  ok('★甲改的优先级也生效了——两个人的改动都在，没有互相覆盖', m1.priority === '1', m1.priority);
  ok('★合并结果的版本号高于两边原件（保证它在所有机器上都压得住）', m1.rev > 6, m1.rev);
  ok('创建时间取最早的那个，不会被合并弄丢', m1.created_at === BASE.created_at, m1.created_at);

  section('②：★时钟不同步——机器时钟快的人，不该因此顶掉别人没被碰过的字段');
  const 甲快 = Object.assign(cp(BASE), { priority: '3', rev: 6, updated_at: '2026-08-25T02:10:00.000Z', updated_by: '甲(表快10分钟)' });
  const 乙准 = Object.assign(cp(BASE), { status: 'done', rev: 6, updated_at: '2026-08-25T02:00:00.000Z', updated_by: '乙' });
  const m2 = S.mergeSyncPayload(P([甲快]), P([乙准]), baseMap).tasks[0];
  ok('★状态仍然是乙改的值', m2.status === 'done', m2.status);
  ok('★甲的优先级也在', m2.priority === '3', m2.priority);

  section('③：真冲突（两人都改了同一个字段）——只能定胜负，但必须留痕');
  S.setMergeFieldConflicts([]);
  const 甲冲突 = Object.assign(cp(BASE), { status: 'doing', rev: 6, updated_at: '2026-08-25T02:30:00.000Z', updated_by: '甲' });
  const 乙冲突 = Object.assign(cp(BASE), { status: 'done', rev: 6, updated_at: '2026-08-25T02:00:00.000Z', updated_by: '乙' });
  const m3 = S.mergeSyncPayload(P([甲冲突]), P([乙冲突]), baseMap).tasks[0];
  ok('按 newerRecord 定出了胜负（不是随机、不是两边都丢）', m3.status === 'doing' || m3.status === 'done', m3.status);
  const conflicts = S.mergeFieldConflicts;
  ok('★真冲突被记下来了', conflicts.length === 1, conflicts.length);
  ok('★记录里写清楚了是哪条、哪个字段、两边各是什么、最后采用了谁的',
    conflicts[0] && conflicts[0].entity === 'task' && conflicts[0].id === 'p86_t' && conflicts[0].field === 'status'
    && conflicts[0].mine === 'doing' && conflicts[0].theirs === 'done' && !!conflicts[0].taken, conflicts[0]);

  section('③：★冲突会写进变更日志——之前那次事故最要命的就是覆盖得无声无息');
  const logBefore = S.DB.changelog.length;
  S.setMergeFieldConflicts([{ entity: 'task', id: 'p86_t', field: 'status', mine: 'doing', theirs: 'done', taken: 'mine', byMine: '甲', byTheirs: '乙' }]);
  S.noteFieldConflicts();
  ok('★日志里多了一条', S.DB.changelog.length === logBefore + 1);
  const lastLog = S.DB.changelog[S.DB.changelog.length - 1];
  ok('★是告警类型（日志页会醒目显示）', lastLog.kind === 'alert', lastLog.kind);
  ok('★写清楚了字段名和双方的值', lastLog.summary.includes('状态') && lastLog.summary.includes('同一个字段'), lastLog.summary);
  ok('★调用后冲突列表会清空，不会下一轮重复报', S.mergeFieldConflicts.length === 0);

  section('④：没有基线时必须原样退回老规则（首次升级、清过浏览器缓存、备份还原之后）');
  const m4 = S.mergeSyncPayload(P([甲]), P([乙]), null).tasks[0];
  ok('★不报错，按原来的"整条比新旧"走', m4.status === 'todo' && m4.priority === '1', { s: m4.status, p: m4.priority });
  const m4b = S.mergeSyncPayload(P([甲]), P([乙]), { task: {} }).tasks[0];
  ok('★基线里没有这条记录时同样退回老规则', m4b.status === 'todo');

  section('⑤：一方没改动时，原样采用另一方——不生成新对象、不无谓地抬高版本号');
  const 甲没动 = cp(BASE);
  const m5 = S.mergeSyncPayload(P([甲没动]), P([乙]), baseMap).tasks[0];
  ok('★完全采纳文件里那份', m5.status === 'done' && m5.rev === 6, { s: m5.status, rev: m5.rev });
  const 乙没动 = cp(BASE);
  const m5b = S.mergeSyncPayload(P([甲]), P([乙没动]), baseMap).tasks[0];
  ok('★对方没动时保留我的那份，版本号也不动', m5b.priority === '1' && m5b.rev === 6, { p: m5b.priority, rev: m5b.rev });

  section('⑥：删除 / 新增 / 数组字段');
  const 甲改标题 = Object.assign(cp(BASE), { title: '甲改的标题', rev: 6, updated_at: '2026-08-25T02:30:00.000Z', updated_by: '甲' });
  const 乙删除 = Object.assign(cp(BASE), { deleted_at: '2026-08-25T02:00:00.000Z', rev: 6, updated_at: '2026-08-25T02:00:00.000Z', updated_by: '乙' });
  const m6 = S.mergeSyncPayload(P([甲改标题]), P([乙删除]), baseMap).tasks[0];
  ok('★对方删除仍然生效（删除是记录级的意思表示，不能被别人改个字段就抵消）', !!m6.deleted_at);
  ok('★同时保留了标题改动——万一恢复回来，改动不会白做', m6.title === '甲改的标题', m6.title);
  const 新任务 = Object.assign(cp(BASE), { id: 'p86_new', title: '对方新建的' });
  const m6b = S.mergeSyncPayload(P([cp(BASE)]), P([cp(BASE), 新任务]), baseMap).tasks;
  ok('★对方新建的记录照常收进来', m6b.some(t => t.id === 'p86_new'), m6b.map(t => t.id));
  const 甲加参与人 = Object.assign(cp(BASE), { assignees: ['张三'], rev: 6, updated_at: '2026-08-25T02:30:00.000Z' });
  const 乙加参与人 = Object.assign(cp(BASE), { assignees: ['李四'], rev: 6, updated_at: '2026-08-25T02:00:00.000Z' });
  const m6c = S.mergeSyncPayload(P([甲加参与人]), P([乙加参与人]), baseMap).tasks[0];
  ok('数组字段同样按"整个字段"定胜负，不会拼成半截数据', JSON.stringify(m6c.assignees) === JSON.stringify(['张三']), m6c.assignees);

  section('⑦：★两台机器来回同步必须收敛（不能你推我、我推你没完没了）');
  // 甲、乙各自从同一基线出发改了不同字段；甲先写文件，乙再拉、再写，最后两边应当完全一致
  let 文件 = P([cp(乙)]);                                    // 乙已经把状态改成 done 写进文件
  const 甲本地 = P([cp(甲)]);                                 // 甲手里：状态还是旧的，但改了优先级
  const 甲合并 = S.mergeSyncPayload(甲本地, 文件, baseMap);     // 甲保存 → 读文件、合并、写回
  文件 = P([cp(甲合并.tasks[0])]);
  const 甲基线 = S.buildSyncBase(甲合并);
  // 乙这时候还停在自己刚写完那一刻的状态：本地是他自己那份，基线也是他自己那份
  const 乙基线 = { task: { p86_t: cp(乙) } };
  const 乙合并 = S.mergeSyncPayload(P([cp(乙)]), 文件, 乙基线);
  ok('★乙拉下来之后，甲的优先级和乙自己的状态都在', 乙合并.tasks[0].priority === '1' && 乙合并.tasks[0].status === 'done',
    { p: 乙合并.tasks[0].priority, s: 乙合并.tasks[0].status });
  ok('★乙这一轮没有产生新的冲突记录（同一个字段没有被两个人改过）', S.mergeFieldConflicts.length === 0);
  // 再来一轮：两边都不改任何东西，结果必须稳定下来
  const 甲第二轮 = S.mergeSyncPayload(P([cp(甲合并.tasks[0])]), P([cp(乙合并.tasks[0])]), 甲基线);
  ok('★再同步一轮内容不再变化（收敛）', 甲第二轮.tasks[0].status === 'done' && 甲第二轮.tasks[0].priority === '1');
  ok('★版本号也不再往上爬（不会每同步一次就自己顶一级）', 甲第二轮.tasks[0].rev === Math.max(甲合并.tasks[0].rev, 乙合并.tasks[0].rev),
    { got: 甲第二轮.tasks[0].rev, a: 甲合并.tasks[0].rev, b: 乙合并.tasks[0].rev });

  section('⑧：hasLocalContribution——版本号平局但内容不同时，不能判成"我没东西要推"');
  const 平局本地 = Object.assign(cp(BASE), { priority: '1', rev: 6, updated_at: '2026-08-25T02:00:00.000Z' });
  const 平局远端 = Object.assign(cp(BASE), { status: 'done', rev: 6, updated_at: '2026-08-25T02:30:00.000Z' });
  ok('★老逻辑（不带基线）在这种平局下会漏判', S.hasLocalContribution(P([平局本地]), P([平局远端])) === false);
  ok('★带上基线之后判得出来"我改过优先级，必须写出去"',
    S.hasLocalContribution(P([平局本地]), P([平局远端]), baseMap) === true);
  ok('本机确实没改过任何东西时，仍然判定为"不用写"（省掉无谓的网盘写入）',
    S.hasLocalContribution(P([cp(BASE)]), P([平局远端]), baseMap) === false);

  section('⑨：buildSyncBase / 基线本身');
  const built = S.buildSyncBase(P([cp(BASE)]));
  ok('★四类业务记录都建了基线槽位', ['duty', 'work', 'milestone', 'task'].every(k => built[k] && typeof built[k] === 'object'), Object.keys(built));
  ok('★按主键存', !!built.task.p86_t);
  ok('★存的是深拷贝，不会被后续改动带着变', (() => {
    const b = S.buildSyncBase(P([cp(BASE)]));
    const src = P([cp(BASE)]);
    b.task.p86_t.status = '被改过';
    return src.tasks[0].status === 'todo';
  })());
  ok('★基线不会被写进共享文件（syncPayload 里没有这个字段）',
    Object.keys(S.syncPayload(S.DB)).indexOf('syncBase') === -1, Object.keys(S.syncPayload(S.DB)));

  section('⑩：mergeableKeys——只合并真实字段，主键/虚拟字段/元数据都不参与');
  const keys = S.mergeableKeys('task');
  ok('★包含会被人改的业务字段', keys.includes('status') && keys.includes('priority') && keys.includes('title'));
  ok('★包含软删除标记', keys.includes('deleted_at'));
  ok('★不含主键 id', !keys.includes('id'));
  ok('★不含虚拟字段（checkpoints 是从里程碑算出来的，不存也不该合并）', !keys.includes('checkpoints') && !keys.includes('_duty'));
  ok('★不含 rev/updated_at 这些元数据（它们有自己的处理方式）',
    !keys.includes('rev') && !keys.includes('updated_at') && !keys.includes('updated_by'));

  section('⑪：sameFieldValue——空值的几种形态要当成一样，否则会误判成"改过"');
  ok('null 和 undefined 和空串视为相同', S.sameFieldValue(null, undefined) && S.sameFieldValue(undefined, '') && S.sameFieldValue(null, ''));
  ok('数组按内容比', S.sameFieldValue(['a', 'b'], ['a', 'b']) && !S.sameFieldValue(['a'], ['b']));
  ok('真的不同就是不同', !S.sameFieldValue('todo', 'done'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
