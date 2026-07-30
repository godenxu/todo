/* P39：本轮五项改动测试——
   1) 权限页账号列表显示每个账号的连接状态 + 最近连接时间（靠 markUserSeen，Repo.persist 里
      真正推成功一次才记一下，不是网页开着的实时心跳）
   2) 定期自动备份的开关/间隔"时不时变回之前的状态"：真根子是 backup-toggle/backup-interval-change
      被塞进了 CHANGE_ONLY_ACTS，但 change 事件分发器一直没接上，这两个动作压根没被调用过；
      顺带把开关/间隔挪进 DB.shareConfig 随共享文件同步（备份目标文件夹的句柄没法跨设备用，留在本机）
   3) 里程碑甘特图（工作台/图表页共用）点击圆点应该跳所属任务，不是所属工作/职责
   4) 任务页进度格子里，有里程碑逾期时也要像工作页"逾期 N"那样露出来
   5) 里程碑逾期 ⇒ 所属任务判定为逾期，且不能因此在"到期分布"这类分桶统计里被重复计数
   用法：node test/test-p39.js */
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
    async createWritable() { return { async write(t) { store.text = t; store.mtime = (store.mtime || 1) + 1; }, async close() {} }; },
  };
}

async function main() {
  await tick(60);
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const bakMs = JSON.parse(JSON.stringify(S.DB.milestones));
  const bakShareConfig = S.DB.shareConfig ? JSON.parse(JSON.stringify(S.DB.shareConfig)) : S.DB.shareConfig;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.DB.milestones = JSON.parse(JSON.stringify(bakMs));
    S.DB.shareConfig = bakShareConfig ? JSON.parse(JSON.stringify(bakShareConfig)) : bakShareConfig;
    S.rebuildIndex();
    S.setFileHandle(null); S.setEverConnected(false);
  };

  section('★①：权限页账号列表——连接状态 + 最近连接时间');
  S.DB.users.push({ name: 'P39从没连过', role: 'staff', salt: 's', hash: 'h', iterations: 1 });
  S.DB.users.push({ name: 'P39刚连过', role: 'staff', salt: 's', hash: 'h', iterations: 1, lastSeenAt: new Date().toISOString() });
  S.DB.users.push({ name: 'P39很久没连', role: 'staff', salt: 's', hash: 'h', iterations: 1, lastSeenAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() });
  const panel = S.accountsPanelHTML();
  ok('表头里有"连接状态"和"最近连接"两列', panel.includes('连接状态') && panel.includes('最近连接'));
  ok('从没连过的账号显示"从没连过"', panel.includes('从没连过'));
  ok('刚连过的账号被判定为在线', S.connectionStatusHTML(S.DB.users.find(u => u.name === 'P39刚连过')).includes('在线'));
  ok('很久没连的账号不算在线', S.connectionStatusHTML(S.DB.users.find(u => u.name === 'P39很久没连')).includes('离线'));

  section('★①：markUserSeen 在真正推成功一次共享文件之后才记');
  S.DB.users.push({ name: 'P39当前用户', role: 'staff', salt: 's', hash: 'h', iterations: 1 });
  S.DB.settings.me = 'P39当前用户';
  ok('还没同步过时没有记录', !S.DB.users.find(u => u.name === 'P39当前用户').lastSeenAt);
  const store = { text: '', mtime: 1 };
  S.setFileHandle(makeFileHandle(store));
  S.setEverConnected(true);
  await S.Repo.persist(S.DB);
  ok('推成功一次之后记下了这个账号的最近连接时间', !!S.DB.users.find(u => u.name === 'P39当前用户').lastSeenAt);
  S.setFileHandle(null);

  section('★②：backup-toggle/backup-interval-change 真的会被 change 事件触发（曾经的死链）');
  S.DB.settings.me = '测试管理员';   // 上一节末尾切到了普通员工，这两个动作需要管理员权限
  S.DB.shareConfig = null;
  ok('默认关闭', S.backupCfg().enabled === false);
  const checkbox = q('#fake-backup-toggle'); checkbox.checked = true; checkbox.dataset.act = 'backup-toggle';
  await S.ACTIONS['backup-toggle']({}, checkbox);
  ok('调用一次 backup-toggle，开关真的被记下来了', S.backupCfg().enabled === true);
  const numInput = q('#fake-backup-interval'); numInput.value = '6';
  await S.ACTIONS['backup-interval-change']({}, numInput);
  ok('间隔也真的被记下来了', S.backupCfg().hours === 6);

  section('★②：开关/间隔存进 DB.shareConfig，随共享文件同步；备份文件夹留在本机');
  ok('开关/间隔在 shareConfig 里', S.DB.shareConfig.autoBackupEnabled === true && S.DB.shareConfig.autoBackupHours === 6);
  ok('shareConfig 在同步 payload 里能看到这两项', S.syncPayload(S.DB).shareConfig.autoBackupEnabled === true);
  ok('改文件名不会把刚设的备份开关冲掉（updateShareConfig 是打补丁，不是整个换新对象）', (() => {
    S.updateShareConfig({ fileName: '随便改个名字.json' });
    return S.DB.shareConfig.autoBackupEnabled === true && S.DB.shareConfig.autoBackupHours === 6;
  })());

  section('★③：里程碑甘特图圆点点击跳所属任务，不是所属工作/职责');
  restore();
  const dutyCode = 'P39D'; await S.Repo.upsert('duty', { code: dutyCode, name: 'P39测试职责' });
  const wid = 'p39_w'; await S.Repo.upsert('work', { id: wid, duty: dutyCode, name: 'P39测试工作', owner: '测试管理员' });
  const taskA = 'p39_ta', taskB = 'p39_tb';
  await S.Repo.upsert('task', { id: taskA, work: wid, title: 'P39任务甲', status: 'doing', plan_date: S.offsetDate(20), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('task', { id: taskB, work: wid, title: 'P39任务乙', status: 'doing', plan_date: S.offsetDate(25), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p39_ms_a', task: taskA, plan_date: S.offsetDate(10), deliverable: 'P39交付物甲', report_level: 'section', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p39_ms_b', task: taskB, plan_date: S.offsetDate(15), deliverable: 'P39交付物乙', report_level: 'section', done: '0' });
  const tree = S.milestoneTreeHTML(S.DB.tasks.filter(t => !t.deleted_at && t.work === wid), new Set(), new Set());
  ok('折叠状态下（工作行聚合展示两条任务的里程碑），甲的圆点带的是甲任务的 id',
    new RegExp(`data-act="task-detail" data-id="${taskA}"[^>]*title="[^"]*P39交付物甲`).test(tree)
    || new RegExp(`title="[^"]*P39交付物甲[^"]*"[\\s\\S]{0,0}`).test(tree)
    || tree.includes(`data-id="${taskA}"`), tree.includes(`data-id="${taskA}"`));
  ok('乙的圆点带的是乙任务的 id（两条任务混在同一条工作级时间轴里，各自的点各认各的任务）',
    tree.includes(`data-id="${taskB}"`));
  // 更精确一点：圆点本身（不是外层的 gantt-row）就带着正确的 data-id，点击分发器会优先认离自己最近的 data-act
  const dotMatches = [...tree.matchAll(/<span class="gantt-pt [a-z]+" data-act="task-detail" data-id="([^"]+)"/g)].map(m => m[1]);
  ok('两个圆点各自的 data-id 分别是甲、乙两条任务（不是工作 id）',
    dotMatches.includes(taskA) && dotMatches.includes(taskB) && !dotMatches.includes(wid), dotMatches);

  section('★④：任务页进度格子——有里程碑逾期时露出"里程碑逾期 N"');
  restore();
  const dutyCode2 = 'P39D2'; await S.Repo.upsert('duty', { code: dutyCode2, name: 'P39测试职责2' });
  const wid2 = 'p39_w2'; await S.Repo.upsert('work', { id: wid2, duty: dutyCode2, name: 'P39测试工作2', owner: '测试管理员' });
  const taskC = 'p39_tc';
  // 任务自己的计划完成时间还没到，但里程碑已经逾期了
  await S.Repo.upsert('task', { id: taskC, work: wid2, title: 'P39任务丙', status: 'doing', plan_date: S.offsetDate(30), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p39_ms_c1', task: taskC, plan_date: S.offsetDate(-5), deliverable: 'P39拖期交付物', report_level: 'section', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p39_ms_c2', task: taskC, plan_date: S.offsetDate(20), deliverable: 'P39未来交付物', report_level: 'section', done: '0' });
  const cellHtml = S.renderCellValue('task', S.byId('task', taskC), S.fieldDef('task', 'progress'), true);
  ok('进度格子里露出了"里程碑逾期 1"', cellHtml.includes('里程碑逾期 1'), cellHtml);

  section('★⑤：里程碑逾期 ⇒ 任务本身判定为逾期，即使任务自己的计划完成时间还没到');
  const taskCRec = S.byId('task', taskC);
  ok('isOverdue(丙) 为真（丙自己的 plan_date 是未来 30 天，全靠里程碑拖期判定）', S.isOverdue(taskCRec));
  ok('hasOverdueMilestone(丙) 也为真', S.hasOverdueMilestone(taskCRec));
  const taskD = 'p39_td';
  await S.Repo.upsert('task', { id: taskD, work: wid2, title: 'P39任务丁（没有逾期里程碑）', status: 'doing', plan_date: S.offsetDate(30), owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p39_ms_d', task: taskD, plan_date: S.offsetDate(20), deliverable: '正常交付物', report_level: 'section', done: '0' });
  ok('丁没有逾期里程碑、自己也没到期 → 不算逾期', !S.isOverdue(S.byId('task', taskD)));
  ok('已完成的任务不会因为里程碑拖期被打成逾期（挂起/完成不计逾期）', (() => {
    const taskE = { ...taskCRec, id: 'p39_te', status: 'done' };
    return !S.isOverdue(taskE);
  })());

  section('★⑤回归：到期分布分桶（dueBuckets）不会因为里程碑逾期而重复计数');
  const openTasks = S.DB.tasks.filter(t => !t.deleted_at && S.isOpen(t));
  const buckets = S.dueBuckets(S.DB.tasks.filter(t => !t.deleted_at));
  const bucketTotal = buckets.reduce((a, b) => a + b.n, 0);
  ok('分桶总数仍然等于未完成任务数（丙这种"计划完成在未来、但里程碑逾期"的任务只算一次）',
    bucketTotal === openTasks.length, [bucketTotal, openTasks.length]);
  ok('丙确实被计进了"已逾期"这一桶', buckets[0].label === '已逾期' && buckets[0].n >= 1);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
