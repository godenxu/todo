/* P102：第十三轮——"按日志核对/修复"把一个改不动的字段当成"被覆盖的数据"，
   管理员点"改回去"只会越点越多假日志

   处里报上来的原话：同事改的两条记录的进度，一条顺利同步了，另一条没同步但有日志；
   管理员核对日志发现了，点"改回去"之后数据仍旧没改，反而多出一条"我自己改动的日志"，
   再核对还是对不上。

   复现出来的完整链条（scratchpad/repro-progress.js）：

     1) 任务名下只要有里程碑，进度就是【算出来的】：进度 = 已交付里程碑 ÷ 里程碑总数
        （recalcProgress）。界面上这一格也是不给手改的（openEditor 第 10778 行拦了
        双击，任务详情里 lockProgress 也不给控件）。
     2) 同步路径上 reconcileDerivedAfterMerge 每次都会按里程碑把这个数字重算一遍。
        所以不管用什么办法把别的值写进去，下一次保存（保存自己就会触发同步）立刻被盖回来。
     3) 而变更日志是按 id 取并集的，一定传得出去、也一定留得下来。于是就出现了
        "日志传过去了、数据没传过去"这个表象 —— 这是第二条记录"没同步"的真相：
        它不是同步丢了数据，是这个字段根本不由人改。
     4) 最要命的是第四步：核对工具把它列成"对不上"，管理员点"按日志把这处改回去"，
        repairByChangelog 确确实实把值写进了记录、也照规矩写了一条"按日志修复"的变更记录，
        可紧接着的同步又按里程碑重算回去。界面上就是【日志多了一条、数据一点没变】；
        再核对一次，对不上反而多一处 —— 多出来的正是管理员自己刚写的那条修复日志。
        点 N 次攒 N 条假的"已修复"记录，数据永远改不过来。
     5) 还有一层更误导人的：派生重算刻意不盖 stampMeta（见 reconcileDerivedAfterMerge
        的注释），所以 updated_at 不变，核对面板最后一列显示"日志之后没人动过"——
        管理员看到"没人动过、值却不一样"，只会更确信是同步把同事的改动弄丢了。

   这一轮的修法分两层：
     · 认出派生字段（derivedFieldInfo），核对结果里单独成一块、只解释不提供修复，
       按钮上的条数也只算真正能修的那些；
     · 就算将来出现别的"写进去又被改掉"的原因（同步期间被同事抢改、手工改坏的值被类型
       规整纠正），repairByChangelog 写完会回查一遍：没落地的把那条修复记录改写成实话、
       去掉结构化明细（否则它自己又变成下一次核对的一处"对不上"），另记一条告警，
       并且照实报给管理员 —— 不许再报成"已修复 N 处"。

   用法：node test/test-p102.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 400) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
function mkHandle(text) {
  const h = { name: 'shared.json', _text: text, _mtime: 1, _writes: 0,
    async getFile() { const s = h._text; return { lastModified: h._mtime, text: async () => s }; },
    async createWritable() { return { async write(t) { h._p = t; }, async close() { h._writes++; h._text = h._p; h._mtime++; } }; } };
  return h;
}
const fileOf = h => JSON.parse(h._text);
let _h = null;

/* T1：名下 2 个里程碑（1 个已交付）→ 进度是算出来的 50
   T2：名下没有里程碑 → 进度手填
   T3：名下的里程碑全被软删除 → 退回手填（这条专门防"只看有没有里程碑记录、不看删没删"） */
function reset() {
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '规划', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一', owner: '测试管理员', year: 2026 }))];
  S.DB.tasks = []; S.DB.milestones = []; S.DB.changelog = []; S.DB.purged = [];
  [['T1', '有里程碑的任务'], ['T2', '没有里程碑的任务'], ['T3', '里程碑已删的任务']].forEach(([id, title], i) => {
    S.DB.tasks.push(S.stampMeta(S.blank('task', { id, work: 'w1', code: '010126' + (i + 1), title,
      owner: '同事甲', status: 'doing', plan_date: '2026-10-0' + (i + 1), priority: '2', progress: 50 })));
  });
  S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', deliverable: '交付物一', plan_date: '2026-10-05', done: '1', actual_date: '2026-10-05' })));
  S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: 'M2', task: 'T1', deliverable: '交付物二', plan_date: '2026-10-20', done: '0' })));
  S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: 'M3', task: 'T3', deliverable: '已删的交付物', plan_date: '2026-10-09', done: '0', deleted_at: new Date().toISOString() })));
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.DB.settings.me = '测试管理员';
  S.undoStack.length = 0;
  S.setSnackPriorityUntil(0);
  S.setAuditIssues([]);
  S.rebuildIndex();
  _h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'] })));
  S.setFileHandle(_h);
  S.setEverConnected(true);
}
// 手工往日志里塞一条"谁把某个字段从 from 改成了 to"的结构化记录，模拟同事那次改动留下的痕迹
function fakeLog(entity, id, field, from, to, by, at) {
  S.DB.changelog.push({
    id: S.uid('log'), at: at || new Date(Date.now() - 60000).toISOString(), by: by || '同事甲',
    kind: 'edit', entity, refId: id, taskId: entity === 'task' ? id : '',
    summary: '（模拟）改了' + field, changes: [{ k: field, from, to }],
  });
}
async function confirmIfAny() {
  for (let i = 0; i < 3; i++) {
    if (!q('#modal-overlay').classList.contains('show')) break;
    const cb = S.modalCallback;
    if (typeof cb !== 'function') break;
    await cb();
    await tick(10);
  }
  if (q('#modal-overlay').classList.contains('show')) S.closeModal();
}

async function main() {
  await tick(120);

  section('一、认出"派生字段"：任务名下有里程碑时，进度是算出来的、改不动');
  {
    reset();
    const d1 = S.derivedFieldInfo('task', 'progress', S.byId('task', 'T1'));
    ok('★有里程碑的任务，进度被认定为派生字段', !!d1);
    ok('★算出来的值就是里程碑完成比例（1/2 = 50）', d1 && d1.value === 50, d1);
    ok('★带一句能给管理员看的人话解释', d1 && /里程碑/.test(d1.why) && /自动算/.test(d1.why), d1 && d1.why);
    ok('没有里程碑的任务，进度是手填的，不算派生', S.derivedFieldInfo('task', 'progress', S.byId('task', 'T2')) === null);
    ok('★里程碑全被软删除的任务，退回"手填"，不算派生',
      S.derivedFieldInfo('task', 'progress', S.byId('task', 'T3')) === null);
    ok('别的字段一律不算派生（状态/标题/牵头人）',
      ['status', 'title', 'owner'].every(k => S.derivedFieldInfo('task', k, S.byId('task', 'T1')) === null));
    ok('别的实体一律不算派生', S.derivedFieldInfo('work', 'progress', S.byId('work', 'w1')) === null);
    ok('记录不存在时不抛异常', S.derivedFieldInfo('task', 'progress', null) === null);
  }

  section('二、核对结果把两类分开：派生字段只解释，不算"数据被覆盖"');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    fakeLog('task', 'T1', 'progress', 50, 100);     // 派生：改不动
    fakeLog('task', 'T2', 'progress', 50, 90);      // 手填：真的对不上，能修
    fakeLog('task', 'T1', 'status', 'doing', 'done'); // 普通字段：能修
    const issues = S.auditByChangelog();
    const f = (id, k) => issues.find(i => i.id === id && i.field === k);
    ok('三处都被核对出来了', issues.length === 3, issues.map(i => i.id + '.' + i.field));
    ok('★★有里程碑任务的进度被标成派生', f('T1', 'progress') && f('T1', 'progress').derived === true);
    ok('★派生条目带着解释文案，面板要靠它说明白', f('T1', 'progress') && /里程碑/.test(f('T1', 'progress').derivedWhy));
    ok('★没有里程碑任务的进度不是派生，属于真的对不上', f('T2', 'progress') && f('T2', 'progress').derived === false);
    ok('★状态字段不是派生', f('T1', 'status') && f('T1', 'status').derived === false);
    ok('★★repairableIssues 只留下真正能修的那 2 处', S.repairableIssues(issues).length === 2,
      S.repairableIssues(issues).map(i => i.id + '.' + i.field));
  }

  section('三、★★核心：派生字段点"改回去"不再写假日志（用户报的就是这个）');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    fakeLog('task', 'T1', 'progress', 50, 100);
    const nLog0 = S.DB.changelog.length;
    const issues0 = S.auditByChangelog();
    ok('前置：核对出 1 处（日志说 100、现在 50）', issues0.length === 1 && issues0[0].now === 50);

    const r = await S.repairByChangelog(issues0);
    await tick(25);
    ok('★★数据没被乱动（进度仍是按里程碑算出来的 50）', S.byId('task', 'T1').progress === 50, S.byId('task', 'T1').progress);
    ok('★★一条日志都没多写（原来会多一条假的"已修复"）', S.DB.changelog.length === nLog0,
      S.DB.changelog.slice(nLog0).map(e => e.summary));
    ok('★返回值照实说"一处没修、N 处是修不动的"', r.ok === 0 && r.stuck.length === 0 && r.skipped === 1, r);

    // 再核对：对不上的数量必须原地不动，不能越点越多
    const issues1 = S.auditByChangelog();
    ok('★★再核对一次，对不上的还是 1 处（原来会变成 2 处、越点越多）', issues1.length === 1, issues1.length);
    ok('★而且它仍然被标成派生，不会哪次突然混进可修清单', issues1[0].derived === true);
  }

  section('四、★★连点五次也不会攒出一堆假"已修复"记录');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    fakeLog('task', 'T1', 'progress', 50, 100);
    const nLog0 = S.DB.changelog.length;
    S.setPage('logs');
    for (let i = 0; i < 5; i++) {
      S.ACTIONS['logs-audit']();
      await tick(10);
      S.ACTIONS['logs-audit-fix']();
      await confirmIfAny();
      await tick(20);
    }
    ok('★★连点 5 轮"核对 + 改回去"，日志一条都没多', S.DB.changelog.length === nLog0,
      S.DB.changelog.slice(nLog0).map(e => e.summary));
    ok('★★共享文件里也没有假的"按日志修复"记录',
      !(fileOf(_h).changelog || []).some(e => String(e.summary).indexOf('按日志修复') !== -1));
    ok('★对不上的数量始终是 1 处', S.auditByChangelog().length === 1);
    ok('★提示语说的是"没有需要修复的项"，不是"已修复 1 处"',
      q('#snack-msg').textContent.indexOf('已按日志修复') === -1, q('#snack-msg').textContent);

    /* 按钮这一层也要钉住：全是派生字段时，连确认框都不该弹。
       弹了就说明按钮还在拿"全部 issue"去修——修复函数内部那层过滤只是兜底，
       不能指望它替按钮把话说对（管理员看到"将把 1 处改回去"就已经被误导了） */
    S.setAuditIssues(S.auditByChangelog());
    S.closeModal();
    S.ACTIONS['logs-audit-fix']();
    await tick(10);
    ok('★★全是派生字段时不弹确认框（弹了就是又把改不动的算进去了）',
      !q('#modal-overlay').classList.contains('show'));
    await confirmIfAny();
  }

  section('四之二、真问题和派生混在一起时，确认框里的条数只算真问题');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    fakeLog('task', 'T1', 'progress', 50, 100);   // 派生，改不动
    fakeLog('task', 'T2', 'progress', 50, 90);    // 真问题，能修
    fakeLog('task', 'T2', 'status', 'doing', 'done');  // 真问题，能修
    S.setAuditIssues(S.auditByChangelog());
    ok('前置：核对出 3 处，其中 2 处能修', S.auditIssues.length === 3 && S.repairableIssues(S.auditIssues).length === 2);
    S.closeModal();
    S.ACTIONS['logs-audit-fix']();
    await tick(10);
    const body = q('#modal-body').innerHTML;
    ok('★★确认框里写的是 2 处，不是 3 处', /将把 2 处字段/.test(body), (body.match(/将把 \d+ 处字段/) || [])[0]);
    await confirmIfAny();
    await tick(25);
    ok('★两处真问题都修好了', S.byId('task', 'T2').progress === 90 && S.byId('task', 'T2').status === 'done');
    ok('★派生那处没被乱动', S.byId('task', 'T1').progress === 50);
    ok('★★修完只剩派生那 1 处，且仍被标成派生（不会变成"修不掉的顽固问题"）',
      S.auditByChangelog().length === 1 && S.auditByChangelog()[0].derived === true);
  }

  section('五、回归：真正该修的还能修，而且必须真的改到数据里、真的推进共享文件');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    fakeLog('task', 'T2', 'progress', 50, 90);
    fakeLog('task', 'T2', 'title', '没有里程碑的任务', '改过名的任务');
    const issues = S.auditByChangelog();
    ok('前置：2 处都是可修的', issues.length === 2 && S.repairableIssues(issues).length === 2);
    const r = await S.repairByChangelog(issues);
    await tick(25);
    const t2 = S.byId('task', 'T2');
    ok('★进度真的改成了日志里的值', t2.progress === 90, t2.progress);
    ok('★标题真的改成了日志里的值', t2.title === '改过名的任务', t2.title);
    ok('★返回 ok=2、没有没落地的', r.ok === 2 && r.stuck.length === 0, r);
    const t2f = (fileOf(_h).tasks || []).find(x => x.id === 'T2');
    ok('★★改动真的推进了共享文件（只留在本机等于没修）', t2f && t2f.progress === 90 && t2f.title === '改过名的任务',
      t2f && { p: t2f.progress, t: t2f.title });
    ok('★修复动作自己也留痕了（不能出现"数据悄悄变了、查不到是谁改的"）',
      S.DB.changelog.some(e => String(e.summary).indexOf('按日志修复') !== -1));
    ok('★再核对已经对得上了', S.auditByChangelog().length === 0, S.auditByChangelog());
    ok('回归：可以 Ctrl+Z 撤销', S.undoStack.length > 0);
  }

  section('六、★就算将来出现别的"写进去又被改掉"的原因，也不许再报成"已修复"');
  {
    /* 造一个真实存在的情形：日志里那个值是坏类型（手工改过共享文件、或者很老的日志），
       写进记录之后，同步路径上的类型规整（normalizeRecordCopy → normalize）会把它纠正掉。
       这种"写进去又被改回"以前会被报成"已修复 1 处"，而且留下一条明细是坏值的修复记录——
       那条记录自己又会变成下一次核对的一处"对不上"。 */
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    fakeLog('task', 'T2', 'progress', 50, '90');   // 注意是字符串 '90'，不是数字
    const issues = S.auditByChangelog();
    ok('前置：核对出 1 处，且被当成可修的', issues.length === 1 && issues[0].derived === false);
    const nLog0 = S.DB.changelog.length;
    const r = await S.repairByChangelog(issues);
    await tick(25);
    ok('★★照实报"没落地"，不再报成已修复', r.ok === 0 && r.stuck.length === 1, r);
    const added = S.DB.changelog.slice(nLog0);
    const repairEntry = added.find(e => String(e.summary).indexOf('按日志修复') !== -1);
    ok('★那条修复记录被改写成了实话（写着"未生效"）',
      repairEntry && /未生效/.test(repairEntry.summary), repairEntry && repairEntry.summary);
    ok('★★并且去掉了结构化明细——否则它自己又变成下一次核对的新"对不上"',
      repairEntry && !repairEntry.changes, repairEntry && repairEntry.changes);
    ok('★留了一条告警（会同步给全处，不能只有点按钮的人知道）',
      added.some(e => S.logKind(e) === S.ALERT_LOG_KIND && /没有生效/.test(String(e.summary))),
      added.map(e => S.logKind(e) + ':' + e.summary));
    ok('★★再核对时不会因为这条修复记录多出一处对不上', S.auditByChangelog().length === 1,
      S.auditByChangelog().map(i => i.field + '=' + JSON.stringify(i.to)));
  }

  section('七、面板文案：把"算出来的"跟"被覆盖的"讲清楚');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    fakeLog('task', 'T1', 'progress', 50, 100);
    fakeLog('task', 'T2', 'progress', 50, 90);
    S.setAuditIssues(S.auditByChangelog());
    const html = S.auditPanelHTML();
    ok('★修复按钮上的条数只算可修的那 1 处（原来会写 2 处）',
      /改回去/.test(html) && /把这 1 处改回去/.test(html), (html.match(/把这 \d+ 处改回去/) || [])[0]);
    ok('★派生那一块单独出现，并说明"也没法按日志改回去"', /没法按日志改回去/.test(html));
    ok('★说清楚了正确做法是去勾里程碑，而不是改进度数字', /勾成已交付/.test(html));
    ok('★派生行最后一列显示的是原因，不是"日志之后被动过"那套误导文案',
      html.indexOf('为什么对不上') !== -1);

    // 只有派生、没有真问题时，不能让管理员以为数据丢了一片
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    fakeLog('task', 'T1', 'progress', 50, 100);
    S.setAuditIssues(S.auditByChangelog());
    const html2 = S.auditPanelHTML();
    ok('★只有派生字段时，明确说"没有数据被覆盖"', /没有发现/.test(html2) && /算出来的字段/.test(html2));
    ok('★这种情况下不出现修复按钮', html2.indexOf('data-act="logs-audit-fix"') === -1);
  }

  section('七之二、★★"我填的进度被按里程碑重算盖掉了"要当场说一句（问题的另一半）');
  {
    /* 还原处里最可能的真实经过：同事刚给这条任务加了个里程碑、还没同步到我这台机器，
       我这边看到的是一条"没有里程碑的任务"，进度格照样能改。我改完保存，
       同步一合并，里程碑到了，进度立刻被按完成比例重算掉——以前这件事一声不响，
       我的改动只剩一条日志，管理员核对时就会当成"同步把数据弄丢了"。 */
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    // 同事那边给 T2 加了一个里程碑，已经写进共享文件，但还没同步到我这儿
    const f = fileOf(_h);
    f.milestones.push({ id: 'M9', task: 'T2', deliverable: '同事刚加的交付物', plan_date: '2026-11-01',
      done: '0', report_level: '', actual_date: '', created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), updated_by: '同事乙', rev: 1 });
    _h._text = JSON.stringify(f); _h._mtime++;
    ok('前置：我这边 T2 还是"没有里程碑"，进度格可以改',
      !S.hasCheckpoints(S.byId('task', 'T2')) && S.derivedFieldInfo('task', 'progress', S.byId('task', 'T2')) === null);

    // 我按正常编辑路径把进度改成 80（跟 openInlineEdit 的写法一致）
    S.setSnackPriorityUntil(0);
    q('#snack-msg').textContent = '';
    {
      const t = S.byId('task', 'T2');
      const before = JSON.parse(JSON.stringify(t));
      t.progress = 80;
      S.reconcileStatusAndProgress(t, before);
      S.logRecordChange('task', 'T2', before, t, ['progress', 'status', 'actual_date']);
      await S.Repo.upsert('task', t);
      await tick(30);
    }
    ok('同步把同事那个里程碑带过来了', !!S.byId('milestone', 'M9'));
    ok('进度被按里程碑重算成 0（0/1 已交付）——这是对的，进度本来就是算出来的',
      S.byId('task', 'T2').progress === 0, S.byId('task', 'T2').progress);
    const snack = q('#snack-msg').textContent;
    ok('★★当场提示了"你填的 80% 没有保留"（原来一声不响）', /80/.test(snack) && /没有保留/.test(snack), snack);
    ok('★提示里说清楚了原因是里程碑', /里程碑/.test(snack), snack);
    ok('★提示里给了正确做法：去勾里程碑', /已交付/.test(snack), snack);
    ok('★只提示本机、不往日志里写（每台机器都会各自算出同一个结果，写了会重复好几条）',
      !(S.DB.changelog || []).some(e => /没有保留/.test(String(e.summary))));

    // 反向：我这次没碰进度（只改了标题），就不该冤枉我"你填的进度没有保留"
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    const f2 = fileOf(_h);
    f2.milestones.push({ id: 'M8', task: 'T2', deliverable: '同事刚加的', plan_date: '2026-11-01',
      done: '0', report_level: '', actual_date: '', created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), updated_by: '同事乙', rev: 1 });
    _h._text = JSON.stringify(f2); _h._mtime++;
    S.setSnackPriorityUntil(0);
    q('#snack-msg').textContent = '';
    {
      const t = S.byId('task', 'T2');
      const before = JSON.parse(JSON.stringify(t));
      t.title = '只改了标题';
      S.logRecordChange('task', 'T2', before, t, ['title']);
      await S.Repo.upsert('task', t);
      await tick(30);
    }
    ok('★★我只改了标题，进度虽然也被重算了，但不会弹"你填的进度没有保留"（不冤枉人）',
      q('#snack-msg').textContent.indexOf('没有保留') === -1, q('#snack-msg').textContent);
  }

  section('八、回归：核对口径本身没被改坏');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(20);
    ok('没有任何带明细的日志时，核对结果为空', S.auditByChangelog().length === 0);
    fakeLog('task', 'T2', 'progress', 50, 50, '同事甲', '2026-01-01T00:00:00.000Z');   // 日志说的值跟现在一样
    ok('对得上的不列出来', S.auditByChangelog().length === 0);
    fakeLog('task', 'T2', 'progress', 50, 70, '同事甲', '2026-02-01T00:00:00.000Z');
    fakeLog('task', 'T2', 'progress', 70, 80, '同事乙', '2026-06-01T00:00:00.000Z');
    const issues = S.auditByChangelog();
    ok('★同一字段多条日志时，取时间最晚那条当"应该是什么"',
      issues.length === 1 && issues[0].to === 80 && issues[0].by === '同事乙', issues);
    S.softDelete('task', 'T2');
    ok('记录已删除的不参与核对', S.auditByChangelog().length === 0);
    S.undelete('task', 'T2');
    ok('恢复之后又参与核对', S.auditByChangelog().length === 1);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
