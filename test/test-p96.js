/* P96：第八轮排查——墓碑（彻底删除）在多设备下的两个漏洞

   两条都是拿演示数据做多设备长跑仿真时冒出来的，手工构造的小样本压根碰不到。

   ① 彻底删掉的记录会被"表快的那台机器"复活
      墓碑原来对所有实体都开了一道"墓碑之后重建的同编号记录不误杀"的口子，判据是时间戳。
      处里的机器时钟并不同步（这是已知事实，checkClockSkew 就是为它写的）：甲 10:00 彻底删了
      一条任务，乙那台表快 7 分钟、手里还留着旧副本 —— 时间戳看上去比墓碑还晚，
      这条"已经彻底删掉"的记录就堂而皇之活了回来。换成比 created_at 也堵不住：
      乙【新建】的记录同样带着快掉的 7 分钟。只要判据沾时间戳，时钟差就能让彻底删除失效。
      最终按主键性质分两种：随机 id（工作/任务/里程碑）根本不可能重建出同 id，一律剔除；
      人填的编号（职责 code、账号姓名）确实会重建，保留豁免并按 created_at 判。

   ② 别人手里那些"还没同步过来的"里程碑，在任务被彻底删除时留不下墓碑
      cascadeRemoveHardTask 只给【本机看得到的】里程碑留墓碑。甲刚给任务 T 加了个里程碑 M
      还没推上去，乙就把 T 彻底删了——乙机器上没有 M，不会给它留墓碑，合并之后 T 没了、
      M 活着，成了永远打不开也恢复不了的无主里程碑。这正是"共享 JSON 越来越大、
      里面一堆对不上任务的里程碑"的来路之一。
   用法：node test/test-p96.js */
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
const mkTask = (id, over) => Object.assign({
  id, work: 'W', code: '', title: '任务' + id, owner: '甲', assignees: [], status: 'doing',
  priority: '2', plan_date: '2026-09-20', progress: 0, actual_date: '', source: '', custom: '',
  rev: 3, created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-06T10:00:00.000Z', updated_by: '甲',
}, over || {});
const mkMs = (id, task, over) => Object.assign({
  id, task, plan_date: '2026-09-15', deliverable: '交付物' + id, report_level: 'section',
  done: '0', actual_date: '', rev: 1, created_at: '2026-09-02T00:00:00.000Z',
  updated_at: '2026-09-06T10:00:00.000Z', updated_by: '甲',
}, over || {});

async function main() {
  await tick(60);

  section('一、墓碑判据：随机 id 一律剔除；人填的编号才留"重建豁免"，并按创建时间判');
  {
    const 墓碑 = [{ entity: 'task', id: 'T1', at: '2026-09-06T10:00:00.000Z', by: '甲' }];

    // ★ 事故形态：旧副本在墓碑之后被改了一下（表快的机器），原来会把它复活
    const 旧副本 = mkTask('T1', { created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-06T10:05:00.000Z' });
    ok('★★墓碑之后被改过的旧副本，不再复活（原来会）',
      S.applyPurged('task', 'id', [旧副本], 墓碑).length === 0);

    // 正常：墓碑之后重新建的同编号记录必须保住（职责的主键是人填的编号，真会重建）
    const 重建的 = { code: 'D9', category: '四、其它工作', name: '重新建的职责',
      rev: 1, created_at: '2026-09-06T10:30:00.000Z', updated_at: '2026-09-06T10:30:00.000Z', updated_by: '乙' };
    ok('★墓碑之后重新建的同编号职责照样保住',
      S.applyPurged('duty', 'code', [重建的], [{ entity: 'duty', id: 'D9', at: '2026-09-06T10:00:00.000Z' }]).length === 1);
    ok('★墓碑之前建的同编号职责该删就删',
      S.applyPurged('duty', 'code', [Object.assign({}, 重建的, { created_at: '2026-09-05T00:00:00.000Z' })],
        [{ entity: 'duty', id: 'D9', at: '2026-09-06T10:00:00.000Z' }]).length === 0);

    // ★ 随机 id 的实体一律剔除：同一个 id 不可能再被生成出来，"墓碑之后重建的同 id 记录"不存在
    ok('★★墓碑之后"新建"的同 id 任务也一律剔除——判据只要沾时间戳，时钟差就能让彻底删除失效',
      S.applyPurged('task', 'id',
        [mkTask('T1', { created_at: '2026-09-06T10:07:00.000Z', updated_at: '2026-09-06T10:07:00.000Z' })],
        墓碑).length === 0);
    ok('★工作、里程碑同理（主键都是随机 id）',
      S.applyPurged('work', 'id', [{ id: 'W1', code: '0101', created_at: '2026-09-06T10:09:00.000Z' }],
        [{ entity: 'work', id: 'W1', at: '2026-09-06T10:00:00.000Z' }]).length === 0
      && S.applyPurged('milestone', 'id', [mkMs('M1', 'T9', { created_at: '2026-09-06T10:09:00.000Z' })],
        [{ entity: 'milestone', id: 'M1', at: '2026-09-06T10:00:00.000Z' }]).length === 0);

    // 账号的主键是姓名，也是人填的：人走了删掉、又回来了重新建一个同名账号，这是真会发生的
    ok('★账号（主键是姓名）保留重建豁免',
      S.applyPurged('user', 'name', [{ name: '韩梅', role: 'staff', created_at: '2026-09-06T10:30:00.000Z' }],
        [{ entity: 'user', id: '韩梅', at: '2026-09-06T10:00:00.000Z' }]).length === 1);
    ok('★墓碑之前建的同名账号该删就删',
      S.applyPurged('user', 'name', [{ name: '韩梅', role: 'staff', created_at: '2026-09-01T00:00:00.000Z' }],
        [{ entity: 'user', id: '韩梅', at: '2026-09-06T10:00:00.000Z' }]).length === 0);

    ok('没有墓碑时原样返回', S.applyPurged('task', 'id', [mkTask('T2')], []).length === 1);
    ok('墓碑管的是别的实体时不误伤',
      S.applyPurged('task', 'id', [mkTask('T1')], [{ entity: 'milestone', id: 'T1', at: '2026-09-09T00:00:00.000Z' }]).length === 1);
  }

  section('二、★整机场景：甲把任务彻底删了，乙那台表快的机器改了一下旧副本');
  {
    const 甲 = Object.assign(EMPTY(), {
      tasks: [], milestones: [],
      purged: [{ entity: 'task', id: 'T1', at: '2026-09-06T10:00:00.000Z', by: '甲' }],
    });
    const 乙 = Object.assign(EMPTY(), {
      // 乙的表快 7 分钟，它这次编辑的时间戳看上去比墓碑还晚
      tasks: [mkTask('T1', { status: 'done', rev: 4, updated_at: '2026-09-06T10:07:00.000Z', updated_by: '乙' })],
      milestones: [mkMs('M1', 'T1')],
    });
    const merged = S.mergeSyncPayload(甲, 乙, null);
    ok('★★被彻底删掉的任务没有复活', merged.tasks.length === 0, merged.tasks.map(t => t.id));
    ok('★★它名下的里程碑也一并清掉了，没留下无主垃圾', merged.milestones.length === 0, merged.milestones.map(m => m.id));
    ok('墓碑本身还在（还没同步的设备下次也会照着清）', merged.purged.length === 1);
  }

  section('三、★任务彻底删除时，别人刚建、还没同步过来的里程碑也要清掉');
  {
    // 乙的机器上只看得到 M1，所以只给 T1 和 M1 留了墓碑；M2 是甲刚建的，乙根本不知道
    const 乙 = Object.assign(EMPTY(), {
      tasks: [], milestones: [],
      purged: [
        { entity: 'task', id: 'T1', at: '2026-09-06T11:00:00.000Z', by: '乙' },
        { entity: 'milestone', id: 'M1', at: '2026-09-06T11:00:00.000Z', by: '乙' },
      ],
    });
    const 甲 = Object.assign(EMPTY(), {
      tasks: [mkTask('T1')],
      milestones: [mkMs('M1', 'T1'), mkMs('M2', 'T1', { created_at: '2026-09-06T11:30:00.000Z', updated_at: '2026-09-06T11:30:00.000Z' })],
    });
    const merged = S.mergeSyncPayload(甲, 乙, null);
    ok('任务被清掉了', merged.tasks.length === 0);
    ok('有墓碑的那个里程碑被清掉了', !merged.milestones.some(m => m.id === 'M1'));
    ok('★★没有墓碑、但所属任务已被彻底删除的里程碑也被清掉了（原来会留下来变成无主垃圾）',
      !merged.milestones.some(m => m.id === 'M2'), merged.milestones.map(m => m.id));
    ok('★合并结果里一个无主里程碑都没有',
      merged.milestones.every(m => merged.tasks.some(t => t.id === m.task)));
  }

  section('四、不能误伤');
  {
    const tasks = [mkTask('T1'), mkTask('T2')];
    const ms = [mkMs('M1', 'T1'), mkMs('M2', 'T2')];
    ok('★没有任务墓碑时，里程碑一个都不动',
      S.dropMilestonesOfPurgedTasks(cp(ms), [], tasks).length === 2);
    ok('★墓碑管的是别的任务时，不相干的里程碑不动',
      S.dropMilestonesOfPurgedTasks(cp(ms), [{ entity: 'task', id: 'T9', at: 'x' }], tasks).length === 2);
    ok('★墓碑管的是里程碑自己（不是任务）时，这一步不插手（那一步交给 applyPurged）',
      S.dropMilestonesOfPurgedTasks(cp(ms), [{ entity: 'milestone', id: 'M1', at: 'x' }], tasks).length === 2);
    ok('★★任务有墓碑、但它从"重建豁免"里活下来了 → 它的里程碑绝不能端掉，否则就是新的丢数据',
      S.dropMilestonesOfPurgedTasks(cp(ms), [{ entity: 'task', id: 'T1', at: 'x' }], tasks).length === 2);
    ok('★任务有墓碑、并且确实已经不在名单里 → 它的里程碑才清',
      S.dropMilestonesOfPurgedTasks(cp(ms), [{ entity: 'task', id: 'T1', at: 'x' }], [mkTask('T2')])
        .map(m => m.id).join(',') === 'M2');
    ok('软删除（还在回收站里、能恢复）的任务，里程碑一个都不许动——那跟彻底删除是两回事',
      S.dropMilestonesOfPurgedTasks(cp(ms), [], [Object.assign(mkTask('T1'), { deleted_at: 'x' }), mkTask('T2')]).length === 2);
  }

  section('四·补、★软删除也有同一个洞：任务进了回收站，别人刚建的里程碑还活着★');
  /* 删任务是级联的，但"名下的里程碑"指的是【删的那台机器当时看得到的那些】。
     甲刚加了个里程碑还没推上去，乙就把任务删进回收站——合并之后任务在回收站里躺着，
     那个里程碑却活着：界面上永远打不开（里程碑只能从任务详情进），却照样算进里程碑总数、
     甘特图和交付统计。数据体检的 msOfDeletedTask 能收拾，但要人想起来去点。
     在合并之后顺手补齐级联，跟重算进度是同一类事（都是"由别条记录决定的状态"）。 */
  {
    const p = {
      tasks: [Object.assign(mkTask('T1'), { deleted_at: '2026-09-06T12:00:00.000Z' }), mkTask('T2')],
      milestones: [mkMs('M1', 'T1'), mkMs('M2', 'T2'), Object.assign(mkMs('M3', 'T1'), { deleted_at: '2026-09-05T00:00:00.000Z' })],
    };
    const 原对象 = p.milestones[0];
    const n = S.reconcileDerivedAfterMerge(p);
    const get = id => p.milestones.find(m => m.id === id);
    ok('★★已删除任务名下还活着的里程碑，被补上了删除标记', !!get('M1').deleted_at);
    ok('★用的是任务自己的删除时间——任务恢复时它们才会原样跟着回来',
      get('M1').deleted_at === '2026-09-06T12:00:00.000Z', get('M1').deleted_at);
    ok('★没删的任务下的里程碑一个都不许动', !get('M2').deleted_at);
    ok('★本来就已删除的里程碑保留它自己的删除时间，不被改写',
      get('M3').deleted_at === '2026-09-05T00:00:00.000Z');
    ok('★报告了修正条数（调用方据此强制写文件，否则修好的只留在本机）', n >= 1, n);
    ok('★★不就地改"文件里读出来的那个对象"——就地改会让基线记成"文件里本来就是这样"，修正永远推不回去',
      !原对象.deleted_at);
    ok('★幂等：再跑一次不会有任何改动', S.reconcileDerivedAfterMerge(p) === 0);
  }
  {
    // 反向：任务被恢复了（deleted_at 空），就不该级联
    const p = { tasks: [mkTask('T1')], milestones: [mkMs('M1', 'T1')] };
    S.reconcileDerivedAfterMerge(p);
    ok('★任务没被删（或刚被恢复）时，里程碑一个都不动', !p.milestones[0].deleted_at);
  }

  section('五、源码接线');
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
    ok('★随机 id 的实体不再享受"重建豁免"', /const rebuildable = pk !== 'id';[\s\S]{0,200}if \(!rebuildable\) return false;/.test(src));
    ok('★人填编号的实体按创建时间判', /return \(r\.created_at \|\| r\.updated_at \|\| ''\) > \(e\.at \|\| ''\);/.test(src));
    // P100：墓碑可以被撤销，applyPurged 必须认这条声明
    ok('★被撤销的墓碑不再拦住记录', /if \(purgeIsUndone\(e\)\) return true;/.test(src));
    ok('★合并里程碑时接上了"所属任务被彻底删除"这一道', /milestones: dropMilestonesOfPurgedTasks\(/.test(src));
    ok('★任务名单先算出来再传给它（不能凭空猜哪些任务还在）',
      /const mergedTasks = applyPurged\('task'[\s\S]{0,600}?purged, mergedTasks\)/.test(src));
    ok('★软删除的级联补齐挂在合并后的派生字段修正里',
      /function reconcileDerivedAfterMerge[\s\S]{0,1800}?const delAt = new Map\(\);[\s\S]{0,600}?msList\[i\] = Object\.assign\(\{\}, m, \{ deleted_at: at \}\);/.test(src));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
