/* P49：删除传不出去——"动态里看得到这个动作，但东西还在"

   现场：同事在任务详情里删掉一条里程碑，别人工作台的「最近动态」看得到这个删除动作，
   但打开那个任务的详情，里程碑还好端端地在那儿；而同事自己的机器上确实是删掉的。

   根因：softDelete 只写 deleted_at，不调 stampMeta，版本号(rev)和修改时间都不变。
   而合并规则是"版本号高的赢，版本号一样再比修改时间"——对别的设备来说，这条被删掉的记录
   "看起来跟我手上那条一模一样新"，于是合并时保留本地那份（没删的），删除被直接丢弃。
   「最近动态」是另一套机制（按 id 取并集的新纪录），一定传得过去——所以才出现
   "说明传过去了、事实没传过去"这种非常难查的组合。

   为什么以前没暴露：单条删除（任务/工作/职责的 × 按钮）走 Repo.upsert，而 upsert 自己会
   stampMeta，等于顺手补上了。只有走 Repo.bulk 的三条路径没人补：
     · 任务详情里删里程碑   · 批量删除任务   · 宽表导入替换某任务的里程碑

   修复：
   ① stampMeta 放进 softDelete / undelete 本身，所有调用点一次性都对；
   ② newerRecord 加一条平局规则：版本号和修改时间完全相同、只有"删没删"不同时，采纳已删除那份。
      这是为了把【已经卡住的历史数据】自动对齐——只修①的话，那些"甲删了、乙还看得见"的记录
      版本号依然是平的，会一直卡着。
   用法：node test/test-p49.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const clone = o => JSON.parse(JSON.stringify(o));

async function main() {
  await tick(60);
  const bak = {
    tasks: clone(S.DB.tasks), milestones: clone(S.DB.milestones),
    works: clone(S.DB.works), duties: clone(S.DB.duties), me: S.DB.settings.me,
  };
  const restore = () => {
    S.DB.tasks = clone(bak.tasks); S.DB.milestones = clone(bak.milestones);
    S.DB.works = clone(bak.works); S.DB.duties = clone(bak.duties);
    S.DB.settings.me = bak.me;
    S.setFileHandle(null);
    S.rebuildIndex();
  };

  section('★①：softDelete 必须顶高版本号，否则这次删除对别人来说"看起来没发生过"');
  restore();
  const m = S.DB.milestones.find(x => !x.deleted_at);
  const revBefore = m.rev || 0;
  S.softDelete('milestone', m.id);
  ok('deleted_at 设上了', !!m.deleted_at);
  ok('★版本号跟着顶高了（这才是删除能传出去的前提）', (m.rev || 0) > revBefore, { before: revBefore, after: m.rev });
  ok('修改时间也刷新了', !!m.updated_at);

  section('★①：undelete（恢复）同理——恢复也要能传给别人');
  const revAfterDel = m.rev;
  S.undelete('milestone', m.id);
  ok('deleted_at 清掉了', !m.deleted_at);
  ok('★版本号继续顶高，恢复能盖过之前那次删除', (m.rev || 0) > revAfterDel, { before: revAfterDel, after: m.rev });

  section('★①：端到端复现——甲删里程碑，乙合并之后必须也看不到它了');
  restore();
  const m2 = S.DB.milestones.find(x => !x.deleted_at);
  const 乙本地 = clone(S.syncPayload(S.DB));      // 乙手上是删除之前那份
  S.softDelete('milestone', m2.id);              // 甲删掉
  const 甲推上去的 = clone(S.syncPayload(S.DB));
  const 乙合并后 = S.mergeSyncPayload(乙本地, 甲推上去的);
  const 乙看到的 = 乙合并后.milestones.find(x => x.id === m2.id);
  ok('★乙合并之后，这条里程碑确实是已删除状态（这就是原来失败的那一步）',
    !!(乙看到的 && 乙看到的.deleted_at), 乙看到的);

  section('★①：反过来也要成立——乙的删除推给甲，甲也得认');
  restore();
  const m3 = S.DB.milestones.find(x => !x.deleted_at);
  const 甲本地 = clone(S.syncPayload(S.DB));
  S.softDelete('milestone', m3.id);
  const 乙推上去的 = clone(S.syncPayload(S.DB));
  const 甲合并后 = S.mergeSyncPayload(乙推上去的, 甲本地);   // 注意：本地是乙、远端是甲的旧数据
  const 甲看到的 = 甲合并后.milestones.find(x => x.id === m3.id);
  ok('已经删掉的一方合并回旧数据时，不会被"复活"', !!(甲看到的 && 甲看到的.deleted_at), 甲看到的);

  section('★①：任务详情里删里程碑（真实路径，走 Repo.bulk，就是出事的那条）');
  restore();
  const dutyCode = 'P49D'; await S.Repo.upsert('duty', { code: dutyCode, name: 'P49测试职责' });
  const wid = 'p49_w'; await S.Repo.upsert('work', { id: wid, duty: dutyCode, code: '01', year: 2027, name: 'P49测试工作', owner: '测试管理员' });
  const tid = 'p49_task';
  await S.Repo.upsert('task', { id: tid, work: wid, title: 'P49任务', status: 'doing', plan_date: S.offsetDate(30), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p49_ms1', task: tid, plan_date: S.offsetDate(10), deliverable: 'P49交付物一', report_level: 'section', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p49_ms2', task: tid, plan_date: S.offsetDate(20), deliverable: 'P49交付物二', report_level: 'section', done: '0' });
  const ms2RevBefore = S.byId('milestone', 'p49_ms2').rev;
  const 删之前 = clone(S.syncPayload(S.DB));

  // 打开任务详情，界面上只留第一条（等于把第二条删掉），保存
  S.openTaskDetail(tid);
  q('#td-title').value = 'P49任务';
  q('#td-owner').value = '测试管理员';
  q('#td-status').value = 'doing';
  raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? [{
    getAttribute: k => (k === 'data-ms-id' ? 'p49_ms1' : null),
    querySelector: s => {
      if (s === '.cp-date') return { value: S.offsetDate(10) };
      if (s === '.cp-deliv') return { value: 'P49交付物一' };
      if (s === '.cp-report-level') return { value: 'section' };
      if (s === '.cp-chk') return { checked: false };
      return null;
    },
  }] : []);
  await S.ACTIONS['modal-ok']();
  const ms2 = S.byId('milestone', 'p49_ms2');
  ok('本机上第二条确实被软删除了', !!ms2.deleted_at);
  ok('★版本号也顶高了（原来这里不会，删除因此传不出去）', (ms2.rev || 0) > ms2RevBefore, { before: ms2RevBefore, after: ms2.rev });
  const 同事合并后 = S.mergeSyncPayload(删之前, clone(S.syncPayload(S.DB)));
  ok('★同事那边合并之后也看不到第二条了（本次事故的直接验证）',
    !!(同事合并后.milestones.find(x => x.id === 'p49_ms2') || {}).deleted_at);
  ok('没被删的第一条不受影响，还在', !(同事合并后.milestones.find(x => x.id === 'p49_ms1') || {}).deleted_at);

  section('★①：批量删除任务（同样走 Repo.bulk，同样中过招）');
  restore();
  const bt = S.DB.tasks.filter(t => !t.deleted_at).slice(0, 2);
  const 批量删之前 = clone(S.syncPayload(S.DB));
  await S.Repo.bulk(() => { bt.forEach(t => S.softDelete('task', t.id)); });
  const 批量合并后 = S.mergeSyncPayload(批量删之前, clone(S.syncPayload(S.DB)));
  ok('★批量删掉的任务，同事那边合并后也都是已删除',
    bt.every(t => !!(批量合并后.tasks.find(x => x.id === t.id) || {}).deleted_at));

  section('★②：平局规则——修复之前就已经卡住的那些记录，下次同步要能自动对齐');
  const 平局删除 = { id: 'x', rev: 3, updated_at: '2026-01-01T00:00:00.000Z', deleted_at: '2026-01-02T00:00:00.000Z' };
  const 平局未删 = { id: 'x', rev: 3, updated_at: '2026-01-01T00:00:00.000Z' };
  ok('★版本号和修改时间完全一样、只有删没删不同时，已删除的那份算更新',
    S.newerRecord(平局删除, 平局未删) === true);
  ok('反方向也一致（未删的不会被判定成更新，删除不会被复活）',
    S.newerRecord(平局未删, 平局删除) === false);
  const 卡住的 = S.mergeByPk('id', [平局未删], [平局删除]);
  ok('★合并结果采纳已删除那份——历史遗留的"删了却传不出去"由此自动愈合',
    !!卡住的[0].deleted_at, 卡住的[0]);

  section('★②：平局规则只在真平局时生效，不能盖过正常的版本号比较');
  ok('对方版本号更高、且是未删除 → 照常听对方的（恢复能盖过删除）',
    S.newerRecord({ id: 'x', rev: 5, updated_at: '2026-01-03T00:00:00.000Z' },
                  { id: 'x', rev: 3, updated_at: '2026-01-01T00:00:00.000Z', deleted_at: '2026-01-02T00:00:00.000Z' }) === true);
  ok('本机版本号更高、且是未删除 → 保留本机（不会被旧的删除拽回去）',
    S.newerRecord({ id: 'x', rev: 3, updated_at: '2026-01-01T00:00:00.000Z', deleted_at: '2026-01-02T00:00:00.000Z' },
                  { id: 'x', rev: 5, updated_at: '2026-01-03T00:00:00.000Z' }) === false);
  ok('版本号一样但修改时间不同时，仍然按修改时间判，轮不到平局规则',
    S.newerRecord({ id: 'x', rev: 3, updated_at: '2026-02-01T00:00:00.000Z' },
                  { id: 'x', rev: 3, updated_at: '2026-01-01T00:00:00.000Z', deleted_at: '2026-01-02T00:00:00.000Z' }) === true);
  ok('两边都没删、完全相同 → 谁也不比谁新', S.newerRecord(平局未删, clone(平局未删)) === false);
  ok('两边都删了、完全相同 → 谁也不比谁新', S.newerRecord(平局删除, clone(平局删除)) === false);

  section('★②：权限矩阵/共享配置没有 deleted_at，走不到平局规则，行为不变');
  ok('两个完全一样的矩阵，谁也不比谁新',
    S.newerRecord({ rev: 2, updated_at: '2026-01-01T00:00:00.000Z' }, { rev: 2, updated_at: '2026-01-01T00:00:00.000Z' }) === false);
  ok('版本号更高的矩阵照常赢',
    S.newerRecord({ rev: 3, updated_at: '2026-01-01T00:00:00.000Z' }, { rev: 2, updated_at: '2026-01-01T00:00:00.000Z' }) === true);

  section('★②：删除必须被"有没有东西要推"认成一次真实改动，否则又不写文件了');
  restore();
  const m4 = S.DB.milestones.find(x => !x.deleted_at);
  const 推之前 = clone(S.syncPayload(S.DB));
  S.softDelete('milestone', m4.id);
  ok('★删除会被判定成"本机有东西要推"（不然 P48 那个不写优化会把删除也吞掉）',
    S.hasLocalContribution(S.syncPayload(S.DB), 推之前) === true);

  section('★②：恢复也要能推出去');
  S.undelete('milestone', m4.id);
  ok('恢复同样算一次真实改动', S.hasLocalContribution(S.syncPayload(S.DB), 推之前) === true);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
