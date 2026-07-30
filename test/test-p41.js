/* P41：本轮修复测试——"同事的改动同步不过来 / 最近动态里看不到同事"
   排查结论：合并算法本身是对的（诊断脚本验证过，一次 persist 就能把同事的任务改动、
   changelog、账号全都收进来）。真正的窟窿在"什么时候才会去读那个文件"，一共三个：

   ① 读和写是绑死的：想看看别人改了啥，必须把自己整份数据写回共享文件（syncToFile 是读—合并—写）。
      于是拉取又贵又不敢做勤，_versionBlocked 挡住写入时甚至连读都一起被挡掉。
      → 拆出只读的 pullFromFile()。
   ② 只有两个触发点：自己动手改了东西，或者 5 分钟一轮的定时器。可是
      刷新完页面时 _fileHandle 是 null（授权不跨刷新存活），定时器等于不存在；
      标签页切到后台时浏览器会把 setInterval 狠狠节流，休眠期间干脆不跑。
      两种情况下屏幕上都是旧数据，界面却看不出来。
      → 标签页重新可见 / 窗口重新获得焦点时立刻拉一次；顶栏那条提示升级成醒目样式；补一个手动"立即同步"。
   ③ 弹窗开着 / 单元格编辑中会跳过同步，跳过之后就没有下文了（详情弹窗开一上午 = 一上午没同步）。
      → 记账，等挡的原因消失了补上。

   外加一个实打实的合并 bug：users[].lastSeenAt（最近连接）是不带 rev 的心跳，
   newerRecord 看不出它变过，于是同事的心跳到了本地就被丢掉，还会被自己写回文件时抹掉——
   权限页那一列"最近连接"因此永远只有自己是准的。
   用法：node test/test-p41.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// 一个可以读也可以写的假共享文件，外加一个"被写了几次"的计数器，
// 用来验证"只读拉取真的没写文件"这件事
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

async function main() {
  await tick(60);
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const bakLog = JSON.parse(JSON.stringify(S.DB.changelog));
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.changelog = JSON.parse(JSON.stringify(bakLog));
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.DB.settings.pendingSync = false;
    S.setFileHandle(null); S.setEverConnected(false);
    S.setNeedPermissionRestore(false); S.setOfflineMode(false);
    S.setSyncBlockedPending(false); S.setLastPullAt(0);
    q('#modal-overlay').classList.remove('show');
    q('#login-gate').classList.remove('show');
    S.rebuildIndex();
  };

  section('★合并 bug：同事的「最近连接」心跳不能在合并时被丢掉');
  // lastSeenAt 是 markUserSeen 直接写的，刻意不 stampMeta（不然每次同步都把所有账号 rev 顶高一级，
  // 真正的账号修改会被心跳压过去）。代价是整条记录看起来"没变过"，必须单独按字段合并
  const localUsers = [
    { name: '甲', role: 'staff', rev: 3, updated_at: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-07-01T00:00:00.000Z' },
    { name: '乙', role: 'staff', rev: 2, updated_at: '2026-01-01T00:00:00.000Z' },
  ];
  const remoteUsers = [
    // 同一个 rev、同一个 updated_at——newerRecord 认为"不比本地新"，整条会被保留本地版本
    { name: '甲', role: 'staff', rev: 3, updated_at: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-07-29T09:00:00.000Z' },
    { name: '乙', role: 'staff', rev: 2, updated_at: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-07-29T10:00:00.000Z' },
  ];
  const mergedUsers = S.mergeSyncPayload(
    { duties: [], works: [], milestones: [], tasks: [], changelog: [], users: localUsers, purged: [] },
    { duties: [], works: [], milestones: [], tasks: [], changelog: [], users: remoteUsers, purged: [] }
  ).users;
  const 甲 = mergedUsers.find(u => u.name === '甲');
  const 乙 = mergedUsers.find(u => u.name === '乙');
  ok('对方更晚的心跳会被采纳（本地是 7-01，对方是 7-29）', 甲.lastSeenAt === '2026-07-29T09:00:00.000Z', 甲.lastSeenAt);
  ok('本地压根没有心跳时，对方的也能补上来', 乙.lastSeenAt === '2026-07-29T10:00:00.000Z', 乙.lastSeenAt);
  ok('心跳合并不会顺手改坏这条记录的其它字段', 甲.role === 'staff' && 甲.rev === 3);
  // 反过来：本地比对方新时不能被对方的旧心跳倒退回去，否则两台设备会互相把对方的时间抹旧
  const back = S.mergeUserPresence(
    [{ name: '甲', lastSeenAt: '2026-07-29T12:00:00.000Z' }],
    [{ name: '甲', lastSeenAt: '2026-07-29T12:00:00.000Z' }],
    [{ name: '甲', lastSeenAt: '2026-01-01T00:00:00.000Z' }]
  );
  ok('对方的心跳比本地旧时保持本地的，不会倒退', back[0].lastSeenAt === '2026-07-29T12:00:00.000Z', back[0].lastSeenAt);

  section('★①：pullFromFile —— 只把别人的读进来，不写文件');
  restore();
  const store = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeFileHandle(store));
  S.setEverConnected(true);
  await S.Repo.persist(S.DB);          // 先铺一份基线到"文件"里
  ok('推一次会写文件（作为下面的对照）', store.writes >= 1, store.writes);

  // 模拟同事那台设备改了一条任务、并记了一条动态，写回文件
  const remote = JSON.parse(store.text);
  const victim = remote.tasks.find(t => !t.deleted_at);
  victim.title = '★同事改过的标题★';
  victim.rev = (victim.rev || 0) + 1;
  victim.updated_at = new Date(Date.now() + 1000).toISOString();
  victim.updated_by = '同事小王';
  remote.changelog.push({
    id: 'log_p41_colleague', at: new Date(Date.now() + 1000).toISOString(),
    by: '同事小王', taskId: victim.id, summary: '把标题改成了★同事改过的标题★',
  });
  store.text = JSON.stringify(remote); store.mtime++;

  const writesBefore = store.writes;
  const pulled = await S.pullFromFile();
  ok('拉取返回成功', pulled === true);
  ok('同事改的标题进来了', S.byId('task', victim.id).title === '★同事改过的标题★');
  ok('同事那条动态也进来了', S.DB.changelog.some(e => e.id === 'log_p41_colleague'));
  ok('★关键：拉取全程一次都没写共享文件', store.writes === writesBefore, { before: writesBefore, after: store.writes });
  ok('拉取会刷新"上次同步"时间（顶栏的新鲜度靠它）', !!S.DB.settings.lastSyncAt && !!S.DB.settings.lastPullAt);

  section('★①：没连文件时拉取安全返回，不报错');
  S.setFileHandle(null);
  ok('没有句柄时返回 false', (await S.pullFromFile()) === false);

  section('★②：最近动态里能看到同事的操作');
  S.setFileHandle(makeFileHandle(store));
  S.setPage('dashboard'); S.renderDashboard();
  const dashHtml = q('#page-dashboard').innerHTML;
  ok('最近动态里出现了同事的名字', dashHtml.includes('同事小王'), dashHtml.slice(0, 200));
  ok('最近动态里出现了那条改动摘要', dashHtml.includes('把标题改成了'));

  section('★②：任务被删掉之后，"谁删了它"这条动态不该跟着一起消失');
  const delTask = S.DB.tasks.find(t => !t.deleted_at && t.id !== victim.id);
  S.DB.changelog.push({
    id: 'log_p41_del', at: new Date(Date.now() + 2000).toISOString(),
    by: '同事小李', taskId: delTask.id, summary: '删除了这条任务',
  });
  delTask.deleted_at = new Date().toISOString();
  S.rebuildIndex();
  S.renderDashboard();
  const delHtml = q('#page-dashboard').innerHTML;
  ok('删除动作本身还看得到（以前会被"只看未删除任务"的过滤器连坐掉）', delHtml.includes('同事小李'), delHtml.slice(0, 200));
  ok('标题上标了「已删除」，不会让人以为任务还在', delHtml.includes('已删除'));
  delete delTask.deleted_at;
  S.rebuildIndex();

  section('★③：弹窗/门禁/单元格编辑期间跳过的同步，事后要补上');
  restore();
  S.setFileHandle(makeFileHandle(store));
  ok('平时不算被挡住', S.syncBlocked() === false);
  q('#modal-overlay').classList.add('show');
  ok('弹窗开着算被挡住', S.syncBlocked() === true);
  S.setSyncBlockedPending(false);
  await S.pullOnWake(true);
  ok('被挡住时会记一笔账，而不是当没发生过', S.syncBlockedPending === true);
  q('#modal-overlay').classList.remove('show');
  const writes2 = store.writes;
  await S.syncCatchUp();
  ok('挡的原因消失后补做了同步，账也销了', S.syncBlockedPending === false);
  ok('补做走的是只读拉取，没有额外写文件', store.writes === writes2, { before: writes2, after: store.writes });
  q('#login-gate').classList.add('show');
  ok('登录门禁开着同样算被挡住', S.syncBlocked() === true);
  q('#login-gate').classList.remove('show');

  section('★③：pullOnWake 的防抖——切来切去不会把文件读爆');
  restore();
  S.setFileHandle(makeFileHandle(store));
  S.setLastPullAt(Date.now());
  ok('距上次拉取太近时直接跳过', (await S.pullOnWake(false)) === false);
  ok('force=true 时无视防抖照样拉', (await S.pullOnWake(true)) === true);

  section('★②：顶栏提示——"数据可能不是最新"必须够醒目');
  restore();
  raw.window.showDirectoryPicker = function () {};   // 让 fsaOk 为真
  S.setEverConnected(true);
  S.setNeedPermissionRestore(true);
  S.renderShell();
  const hint = q('#share-connect-hint').innerHTML;
  ok('刷新后授权失效时，说的是"数据可能不是最新"，不只是"没连上"', hint.includes('数据可能不是最新'), hint);
  ok('★这条用了醒目样式（以前是一行不起眼的小字，用户根本不会去点）', hint.includes('urgent'), hint);
  S.setNeedPermissionRestore(false);
  S.setOfflineMode(true);
  S.renderShell();
  ok('离线模式同样点明"数据非最新"并用醒目样式',
    q('#share-connect-hint').innerHTML.includes('数据非最新') && q('#share-connect-hint').innerHTML.includes('urgent'));
  S.setOfflineMode(false);

  section('★②：连上之后顶栏常驻一个"立即同步"，并显示数据新鲜度');
  S.setFileHandle(makeFileHandle(store));
  S.DB.settings.lastSyncAt = new Date().toISOString();
  S.renderShell();
  const okHint = q('#share-connect-hint').innerHTML;
  ok('有"立即同步"按钮', okHint.includes('data-act="sync-now"') && okHint.includes('立即同步'), okHint);
  ok('顺带把"上次同步是多久以前"写在按钮上', okHint.includes('sync-age'), okHint);
  ok('一切正常时不用红底闪烁（不然天天红着，真出事没人当回事）', !okHint.includes('urgent'), okHint);

  section('★②：sync-now 动作本身可用');
  const writes3 = store.writes;
  await S.ACTIONS['sync-now']();
  ok('点一下确实推了一次（读—合并—写整套）', store.writes > writes3, { before: writes3, after: store.writes });
  ok('给了明确反馈', q('#snack-msg').textContent.includes('同步'), q('#snack-msg').textContent);
  S.setFileHandle(null);
  await S.ACTIONS['sync-now']();
  ok('没连上时点它会提示先去连接，而不是默默无事发生',
    q('#snack-msg').textContent.includes('还没连上'), q('#snack-msg').textContent);

  restore();
  delete raw.window.showDirectoryPicker;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
