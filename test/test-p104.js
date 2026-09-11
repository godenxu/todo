/* P104：「从备份恢复」这条最后的退路本身是坏的

   管理员的原话："真有问题我会用备份的 json 直接替换回去"。这条退路必须是真的，
   所以这一轮专门把它验了一遍（scratchpad/probe13d.js），五个探针全部发现问题：

   ① ★★ 连着共享文件夹时，「从备份恢复」几乎必然无效（探针29）
      点完"确认恢复"，提示条说"已从备份恢复"，而本机和共享文件里的数据一个字都没变。
      原因：还原最后会 clearSyncBaseline 清掉同步基线，于是紧接着那次保存的合并退回
      "整条比较、谁版本号高听谁的"——现状这段时间一直在被编辑，每条记录 rev 都比备份里高，
      所以还原结果当场被现状原样顶回去。管理员以为自己回滚了，其实什么都没发生。
   ② ★ settings 被整份覆盖（探针26）→ "我是谁"变成导出这份备份的人。
      组长拿管理员导出的备份一恢复就变成管理员，而备份文件就放在共享/备份文件夹里，
      这是一条实打实的提权路径。
   ③ 备份里的旧写入链标记被带回来（探针27）→ 下一轮同步白报一次"你的保存被覆盖了"。
      （这一条跟紧邻的那段注释自相矛盾：注释明说"写入链标记同样要清"。）
   ④ 备份之后被"彻底删除"的记录救不回来：墓碑被换成备份里那份老的，
      但别的机器上还留着新墓碑，合并时捡回来，把刚还原的记录再杀一遍。
   ⑤ 还原这么大的动作一条日志都不留，事后谁也说不清那天数据为什么整批变了。

   另外有一件做不到、必须讲清楚而不是假装能做到的事：备份之后【新建】的记录不会消失
   （合并规则是"我有你没有的就收进来"，它们还在同事缓存里）。所以还原的语义是
   "把备份里有的那些记录的字段改回去"，不是"把整个系统倒回那一刻"——对话框里现在写明了。

   用法：node test/test-p104.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 400) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

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

function reset() {
  // 先把身份设好，再造记录——否则 stampMeta 记下的 updated_by 是脚手架默认的那个人，
  // 后面断言"最后是谁改的没被还原改掉"就对不上了
  S.DB.settings.me = '管理员甲';
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    content: ['内容一', '内容二'], owner: '张三', collaborators: ['李四'], year: 2026, status: 'doing' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261', title: '任务一',
    owner: '张三', assignees: ['李四'], status: 'doing', priority: '1', plan_date: '2026-10-01',
    progress: 50, source: '处里自定', custom: '备注' }))];
  /* 两个里程碑、一个已交付 → 按里程碑算出来的进度正好是 50，跟任务上存的 progress 一致。
     刻意保持一致：进度是派生字段（见 P102），同步时会按里程碑重算，
     数据本身自相矛盾的话，断言"进度被还原成 50"会被这条正当规则干扰，测不出要测的东西 */
  S.DB.milestones = [
    S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', deliverable: '交付物一',
      plan_date: '2026-06-30', done: '1', actual_date: '2026-06-20' })),
    S.stampMeta(S.blank('milestone', { id: 'M2', task: 'T1', deliverable: '交付物二',
      plan_date: '2026-12-31', done: '0', actual_date: '' })),
  ];
  S.DB.changelog = [];
  S.DB.purged = [];
  S.DB.users = [
    { name: '管理员甲', role: 'admin', salt: 's1', hash: 'h1', iterations: 1000,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员甲', rev: 3 },
    { name: '组长乙', role: 'lead', salt: 's2', hash: 'h2', iterations: 1000,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员甲', rev: 2 },
  ];
  S.DB.permissionMatrix = { bulk_ops: ['admin', 'lead'], rev: 7,
    updated_at: '2026-02-01T00:00:00.000Z', updated_by: '管理员甲' };
  S.DB.reportConfig = { sections: [{ k: '报告编排甲' }], rev: 4,
    updated_at: '2026-02-01T00:00:00.000Z', updated_by: '管理员甲' };
  S.DB.dashboardConfig = { sections: [{ k: '工作台编排甲' }], rev: 5,
    updated_at: '2026-02-01T00:00:00.000Z', updated_by: '管理员甲' };
  S.clearSyncBaseline(S.DB);
  S.DB.settings.me = '管理员甲';
  S.DB.settings.year = 2026;
  S.DB.settings.pendingSync = false;
  S.undoStack.length = 0;
  S.setSnackPriorityUntil(0);
  q('#snack-msg').textContent = '';
  S.rebuildIndex();
  _h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'] })));
  S.setFileHandle(_h);
  S.setEverConnected(true);
}
// 备份文件就是 exportJSON 写出去的东西——整份 DB
const makeBackup = () => JSON.stringify(S.DB, null, 1);
async function confirmRestore(opts) {
  await tick(20);
  if (opts && opts.layout) { const b = q('#bk-layout'); if (b) b.checked = true; }
  for (let i = 0; i < 4; i++) {
    if (!q('#modal-overlay').classList.contains('show')) break;
    const cb = S.modalCallback; if (typeof cb !== 'function') break;
    await cb(); await tick(25);
  }
  if (q('#modal-overlay').classList.contains('show')) S.closeModal();
  await tick(35);
}
const fileTask = id => ((fileOf(_h).tasks || []).find(x => x.id === id) || null);

async function main() {
  await tick(150);

  section('一、★★核心：连着共享文件夹时，还原必须真的生效并推给全处');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const backup = makeBackup();
    // 数据被改坏，而且已经同步进共享文件（现状 rev 比备份里高）
    const t = S.byId('task', 'T1');
    t.title = '被改坏的标题'; t.owner = '被改坏的牵头人'; t.progress = 0;
    S.stampMeta(t); S.stampMeta(t); S.stampMeta(t);   // 现状版本号明显高于备份
    await S.Repo.persist(S.DB); await tick(30);
    ok('前置：坏数据已经进了共享文件', fileTask('T1').title === '被改坏的标题');
    ok('前置：现状的版本号确实比备份里那一版高',
      S.byId('task', 'T1').rev > JSON.parse(backup).tasks[0].rev);

    S.importBackup(backup);
    await confirmRestore();
    ok('★★本机数据真的被还原了（原来一个字都不会变）', S.byId('task', 'T1').title === '任务一',
      S.byId('task', 'T1').title);
    ok('★★还原结果真的推进了共享文件（只留在本机等于没还原）', fileTask('T1').title === '任务一',
      fileTask('T1') && fileTask('T1').title);
    ok('★其它字段也一并还原', S.byId('task', 'T1').owner === '张三' && S.byId('task', 'T1').progress === 50,
      { owner: S.byId('task', 'T1').owner, progress: S.byId('task', 'T1').progress });
    ok('★还原后的版本号压得住现状（这是能推出去的前提）',
      S.byId('task', 'T1').rev > 3, S.byId('task', 'T1').rev);
    /* 刻意不盖 stampMeta：updated_by / updated_at 保持备份里那一份。
       光比 updated_by 抓不住"顺手盖了 stampMeta"这种改法（还原的人恰好就是备份里那个人时
       两者一样），所以比 updated_at —— stampMeta 会把它改成"现在" */
    const bkTask = JSON.parse(backup).tasks.find(x => x.id === 'T1');
    ok('★刻意不盖 stampMeta：“最后是谁改的”仍然是备份里那一份',
      S.byId('task', 'T1').updated_by === bkTask.updated_by, S.byId('task', 'T1').updated_by);
    ok('★★“最后什么时候改的”也没被改成现在（否则全处几百条记录的这条线索被一次还原抹平）',
      S.byId('task', 'T1').updated_at === bkTask.updated_at,
      { 备份里: bkTask.updated_at, 还原后: S.byId('task', 'T1').updated_at });
    ok('回归：可以 Ctrl+Z 撤销', S.undoStack.length > 0);
  }

  section('一之三、★★同事改的版本号比我本机高时，还原也要压得住（只比本机不够）');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const backup = makeBackup();
    // 同事把这条任务改了好几轮，版本号冲得很高，而且已经进了共享文件；我这台还没拉过
    const f = fileOf(_h);
    const ft = f.tasks.find(x => x.id === 'T1');
    ft.title = '同事改过很多轮的标题'; ft.rev = (ft.rev || 1) + 50;
    ft.updated_at = new Date(Date.now() + 60000).toISOString(); ft.updated_by = '同事乙';
    _h._text = JSON.stringify(f); _h._mtime++;
    ok('前置：文件里那条的版本号远高于本机', ft.rev > S.byId('task', 'T1').rev + 40);
    S.importBackup(backup);
    await confirmRestore();
    ok('★★还原照样赢了（顶版本号时必须把共享文件里那条也算进去）',
      S.byId('task', 'T1').title === '任务一', S.byId('task', 'T1').title);
    ok('★共享文件里也变成备份里那个了', fileTask('T1').title === '任务一', fileTask('T1').title);
  }

  section('一之二、★再同步几轮，还原结果不会被现状又顶回去');
  {
    await S.Repo.persist(S.DB); await tick(30);
    await S.pullFromFile(); await tick(30);
    await S.Repo.persist(S.DB); await tick(30);
    ok('★★连跑三轮同步，标题还是备份里那个', S.byId('task', 'T1').title === '任务一',
      S.byId('task', 'T1').title);
    ok('★共享文件里也还是备份里那个', fileTask('T1').title === '任务一');
  }

  section('二、★★还原不许改变"我是谁"（这是一条提权路径）');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const backup = makeBackup();          // 这份是"管理员甲"导出的
    S.DB.settings.me = '组长乙';           // 换成组长在操作
    await S.Repo.persist(S.DB); await tick(25);
    ok('前置：当前身份是组长乙、角色 lead', S.myRole() === 'lead');
    S.importBackup(backup);
    await confirmRestore();
    ok('★★恢复之后"我是谁"没变', S.DB.settings.me === '组长乙', S.DB.settings.me);
    ok('★★角色也没被顶成 admin（备份文件放在共享文件夹里，拿到就能提权）',
      S.myRole() === 'lead', S.myRole());
    ok('回归：业务数据照样还原了', S.byId('task', 'T1').title === '任务一');
  }

  section('三、★备份里的旧写入链标记不许被带回来（否则白报一次"你的保存被覆盖了"）');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    S.DB.settings.lastWriteId = 'w-备份里那个旧标记';
    S.DB.settings.lastWriteIdAt = new Date().toISOString();
    const backup = makeBackup();
    S.DB.settings.lastWriteId = ''; S.DB.settings.lastWriteIdAt = '';
    await S.Repo.persist(S.DB); await tick(25);
    S.importBackup(backup);
    await confirmRestore();
    ok('★★备份里那个旧标记没被塞回来', S.DB.settings.lastWriteId !== 'w-备份里那个旧标记',
      S.DB.settings.lastWriteId);
    ok('★没有白报"你的保存被覆盖了"',
      !(S.DB.changelog || []).some(e => /保存被.*覆盖/.test(String(e.summary))),
      (S.DB.changelog || []).map(e => String(e.summary).slice(0, 40)));
    ok('★year 这类真正属于数据的设置照样跟着备份走', S.DB.settings.year === 2026);
  }

  section('四、★★备份之后被"彻底删除"的记录，还原要能救回来');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const backup = makeBackup();
    // 有人误点了彻底删除，并且已经同步进共享文件（墓碑也进去了）
    S.cascadeRemoveHardTask('T1');
    await S.Repo.persist(S.DB); await tick(30);
    ok('前置：任务真的被彻底删了，墓碑也进了共享文件',
      !S.byId('task', 'T1') && (fileOf(_h).purged || []).some(p => p.id === 'T1'));

    S.importBackup(backup);
    await confirmRestore();
    ok('★★任务被救回来了', !!S.byId('task', 'T1'), S.DB.tasks.map(t => t.id));
    ok('★★名下的里程碑也回来了', !!(S.byId('milestone', 'M1') && !S.byId('milestone', 'M1').deleted_at));
    ok('★★共享文件里也回来了（不然同事那边还是没有）', !!fileTask('T1'));
    ok('★墓碑被标成"已撤销"，而不是被删掉（删掉的话别人机器上那块还会飘回来）',
      (S.DB.purged || []).some(p => p.id === 'T1' && p.undone),
      (S.DB.purged || []).filter(p => p.id === 'T1'));
    // 最关键的一步：再同步几轮，确认它不会被墓碑在下一轮又杀掉
    await S.Repo.persist(S.DB); await tick(30);
    await S.pullFromFile(); await tick(30);
    await S.Repo.persist(S.DB); await tick(30);
    ok('★★★连跑三轮同步，救回来的记录还活着（这是以前救不回来的根本原因）',
      !!S.byId('task', 'T1') && !!fileTask('T1'));
    ok('★提示条里告诉了管理员"撤回了几条彻底删除"',
      /撤回了 \d+ 条彻底删除/.test(q('#snack-msg').textContent), q('#snack-msg').textContent);
  }

  section('五、★还原这么大的动作必须留痕，并且同步给全处');
  {
    const alert = (S.DB.changelog || []).find(e => /用一份备份覆盖了全处数据/.test(String(e.summary)));
    ok('★★日志里有这条记录', !!alert, (S.DB.changelog || []).map(e => String(e.summary).slice(0, 40)));
    ok('★是告警级别（所有人都会看到，想瞒也瞒不住）', alert && S.logKind(alert) === S.ALERT_LOG_KIND);
    ok('★写明了是谁做的', alert && /管理员甲/.test(alert.summary), alert && alert.summary);
    ok('★写明了条数', alert && /任务 1 条/.test(alert.summary), alert && alert.summary);
    ok('★★这条日志真的推进了共享文件',
      (fileOf(_h).changelog || []).some(e => /用一份备份覆盖了全处数据/.test(String(e.summary))));
  }

  section('六、★变更日志取并集：备份之后发生了什么不能被回滚一起删掉');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const backup = makeBackup();
    /* 备份之后产生了一条关键的带明细的变更记录（排查事故正要看它）。
       ★ 刻意【不】先保存：这条只存在于本机、还没推上去 ★
       先保存的话，共享文件里也有一份，合并时会按 id 并集捡回来，
       于是"整份替换日志"这种写法反而测不出问题——那是在测合并规则，不是测还原本身。 */
    const t = S.byId('task', 'T1');
    const b = JSON.parse(JSON.stringify(t));
    t.progress = 88;
    S.logRecordChange('task', 'T1', b, t, ['progress']);
    const keyId = S.DB.changelog[S.DB.changelog.length - 1].id;
    ok('前置：这条日志只在本机，共享文件里还没有',
      !(fileOf(_h).changelog || []).some(e => e.id === keyId));
    S.importBackup(backup);
    await confirmRestore();
    ok('★★备份之后那条只在本机的变更记录还在（原来整份被备份里的日志替换掉，证据当场消失）',
      (S.DB.changelog || []).some(e => e.id === keyId),
      (S.DB.changelog || []).map(e => String(e.summary).slice(0, 30)));
    ok('★而且它跟着这次还原一起推进了共享文件',
      (fileOf(_h).changelog || []).some(e => e.id === keyId));
  }

  section('七、★备份之后新建的记录不会消失——这是明确的契约，不是 bug');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const backup = makeBackup();
    // 同事在备份之后新建了一条任务，已经进了共享文件
    const f = fileOf(_h);
    f.tasks.push({ id: 'T9', work: 'w1', code: '0101299', title: '备份之后新建的任务', owner: '同事乙',
      assignees: [], status: 'todo', priority: '2', plan_date: '2026-12-01', progress: 0, actual_date: '',
      source: '', custom: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      updated_by: '同事乙', rev: 1 });
    _h._text = JSON.stringify(f); _h._mtime++;
    await S.pullFromFile(); await tick(30);
    ok('前置：本机收到了同事新建的那条', !!S.byId('task', 'T9'));
    S.importBackup(backup);
    await confirmRestore();
    await S.Repo.persist(S.DB); await tick(30);
    ok('★★同事备份之后新建的记录没被回滚掉（他这几天的工作不该白干）', !!S.byId('task', 'T9'));
    ok('★而备份里有的那条确实被改回去了', S.byId('task', 'T1').title === '任务一');
  }

  section('八、★编排只在勾了"一并还原编排"时才还原');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const backup = makeBackup();
    S.DB.reportConfig = { sections: [{ k: '被改坏的编排' }], rev: 99,
      updated_at: new Date().toISOString(), updated_by: '某人' };
    await S.Repo.persist(S.DB); await tick(25);
    S.importBackup(backup);
    await confirmRestore();   // 不勾
    ok('★不勾就不动编排', JSON.stringify((S.DB.reportConfig || {}).sections).indexOf('被改坏的编排') !== -1,
      (S.DB.reportConfig || {}).sections);

    S.importBackup(backup);
    await confirmRestore({ layout: true });   // 勾上
    ok('★★勾上之后编排被还原', JSON.stringify((S.DB.reportConfig || {}).sections).indexOf('报告编排甲') !== -1,
      (S.DB.reportConfig || {}).sections);
    ok('★★而且推进了共享文件（编排是整份生效的，要压得住文件里那份）',
      JSON.stringify(((fileOf(_h).reportConfig || {}).sections)).indexOf('报告编排甲') !== -1,
      (fileOf(_h).reportConfig || {}).sections);
  }

  section('九、★账号与权限有意不在还原范围内，而且要在对话框里说清楚');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const backup = makeBackup();
    /* 改角色来验"账号没被还原"。不用"把账号从数组里删掉"那种写法——
       账号删除走的是打 deleted_at，从数组里抠掉不算删，合并时会从共享文件里原样收回来，
       那样测出来的是合并规则，不是还原范围 */
    S.DB.users.find(u => u.name === '组长乙').role = 'staff';
    S.DB.users.find(u => u.name === '组长乙').rev = 9;
    S.DB.permissionMatrix = { bulk_ops: ['admin'], rev: 9,
      updated_at: new Date().toISOString(), updated_by: '某人' };
    await S.Repo.persist(S.DB); await tick(25);
    S.importBackup(backup);
    await tick(20);
    const body = q('#modal-body').innerHTML;
    ok('★对话框写明了账号与权限不在还原范围内', /账号与权限不在还原范围内/.test(body));
    ok('★对话框指了正确的去处（专门的账号导入）', /专门导入/.test(body) || /账号与角色/.test(body));
    ok('★对话框写明了"备份之后新建的记录不会消失"', /不会消失/.test(body));
    ok('★对话框写明了会同步给全处', /同步给全处/.test(body));
    ok('★对话框写明了彻底删除的记录会一并恢复', /彻底删除/.test(body));
    await confirmRestore();
    ok('★账号确实没被还原（这是有意的：角色受越权校验保护）',
      (S.DB.users.find(u => u.name === '组长乙') || {}).role === 'staff',
      (S.DB.users.find(u => u.name === '组长乙') || {}).role);
    ok('★权限矩阵也没被还原', (S.DB.permissionMatrix || {}).rev === 9);
  }

  section('十、★没连共享文件夹（离线）时，还原照样要生效');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const backup = makeBackup();
    S.byId('task', 'T1').title = '被改坏的标题';
    S.stampMeta(S.byId('task', 'T1'));
    await S.Repo.persist(S.DB); await tick(25);
    S.setFileHandle(null);   // 断开共享文件夹
    S.importBackup(backup);
    await confirmRestore();
    ok('★离线时还原照样生效、不抛异常', S.byId('task', 'T1').title === '任务一',
      S.byId('task', 'T1').title);
    S.setFileHandle(_h);
  }

  section('十一、回归：坏文件照样被拦住');
  {
    reset();
    S.setSnackPriorityUntil(0);
    S.importBackup('这不是 json');
    ok('不是 JSON 的文件被拦住', /合法的 JSON/.test(q('#snack-msg').textContent), q('#snack-msg').textContent);
    S.setSnackPriorityUntil(0);
    S.importBackup('{"foo":1}');
    ok('不是本系统备份的 JSON 也被拦住', /不是本系统导出的备份/.test(q('#snack-msg').textContent),
      q('#snack-msg').textContent);
    ok('被拦住时数据一点没动', S.byId('task', 'T1').title === '任务一' && S.DB.tasks.length === 1);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
