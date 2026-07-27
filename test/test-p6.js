/* P6 共享文件同步（多人协作）测试。用法：node test/test-p6.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// 模拟 FileSystemFileHandle：getFile().text()/lastModified，createWritable().write()/close()
function makeFakeHandle(initialContent, initialMtime) {
  let content = initialContent, mtime = initialMtime;
  const writes = [];
  return {
    name: 'shared.json',
    async getFile() { return { lastModified: mtime, text: async () => content }; },
    async createWritable() {
      return { async write(text) { writes.push(text); content = text; mtime += 1; }, async close() {} };
    },
    _writes: writes,
    _content: () => content,
    _mtime: () => mtime,
    _bump: (text, newMtime) => { content = text; mtime = newMtime; },
  };
}

async function main() {
  await tick(60);

  section('纯合并函数：mergeEntityList');
  const base = { id: 't1', rev: 3, updated_at: '2026-01-01T00:00:00.000Z', title: '本地版本' };
  ok('remote 版本号更高则替换', S.mergeEntityList('task', [base],
    [{ ...base, rev: 4, updated_at: '2026-01-02T00:00:00.000Z', title: '对方版本' }])[0].title === '对方版本');
  ok('remote 版本号更低则保留本地', S.mergeEntityList('task', [base],
    [{ ...base, rev: 2, title: '旧版本' }])[0].title === '本地版本');
  ok('版本号相同时比更新时间，对方更晚则换成对方的', S.mergeEntityList('task', [base],
    [{ ...base, rev: 3, updated_at: '2026-01-02T00:00:00.000Z', title: '同版本号但更晚' }])[0].title === '同版本号但更晚');
  ok('版本号和时间都相同则保留本地（不折腾）', S.mergeEntityList('task', [base], [{ ...base }])[0].title === '本地版本');
  ok('remote 独有的记录会被收进来（新增）', S.mergeEntityList('task', [base],
    [{ id: 't2', rev: 1, updated_at: '2026-01-01T00:00:00.000Z', title: '对方新增' }])
    .some(r => r.id === 't2' && r.title === '对方新增'));
  ok('本地独有的记录不会因为合并而消失', S.mergeEntityList('task', [base], []).some(r => r.id === 't1'));

  section('纯合并函数：mergeChangelog');
  const localLog = [{ id: 'l1', at: '2026-01-01T00:00:00.000Z' }, { id: 'l2', at: '2026-01-03T00:00:00.000Z' }];
  const remoteLog = [{ id: 'l2', at: '2026-01-03T00:00:00.000Z' }, { id: 'l3', at: '2026-01-02T00:00:00.000Z' }];
  const mergedLog = S.mergeChangelog(localLog, remoteLog);
  ok('按 id 去重（l2 不重复）', mergedLog.filter(e => e.id === 'l2').length === 1);
  ok('双方独有的都保留（l1/l3）', mergedLog.some(e => e.id === 'l1') && mergedLog.some(e => e.id === 'l3'));
  ok('按时间重新排序', mergedLog.map(e => e.id).join(',') === 'l1,l3,l2');
  const bigLocal = Array.from({ length: 320 }, (_, i) => ({ id: 'a' + i, at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` }));
  ok('超过 300 条会被裁掉旧的，只留最近 300 条', S.mergeChangelog(bigLocal, []).length === 300);

  section('纯合并函数：syncPayload 不包含 settings');
  const payload = S.syncPayload(S.DB);
  ok('只有业务字段，没有 settings', Object.keys(payload).sort().join(',') === 'changelog,duties,milestones,permissionMatrix,shareConfig,tasks,users,works');
  ok('settings（使用者/列宽等）确实被排除在外', !('settings' in payload));

  section('syncToFile：文件没被别人动过 → 直接写当前状态，不做合并');
  const untouched = makeFakeHandle(JSON.stringify(S.syncPayload(S.DB)), 5000);
  S.setFileHandle(untouched);
  S.setLastSyncedMtime(5000);
  const beforeTaskCount = S.DB.tasks.length;
  await S.syncToFile(S.DB);
  ok('写入了一次', untouched._writes.length === 1);
  ok('写入内容不含 settings', !JSON.parse(untouched._writes[0]).settings);
  ok('本地任务数没有因为这次快路径同步而变化', S.DB.tasks.length === beforeTaskCount);
  ok('_lastSyncedMtime 跟着文件新的 mtime 走', S.lastSyncedMtime === untouched._mtime());

  section('syncToFile：文件被别人动过 → 先读出来合并，再写回，且刷新本地内存');
  const t0 = S.DB.tasks.find(t => !t.deleted_at);
  const remotePayload = S.syncPayload(S.DB);
  // 模拟"对方"新增了一条任务，且把 t0 的标题改了（rev 更高）
  const otherNewTask = { id: 'other_new_task', code: '', work: t0.work, title: '对方新建的任务', owner: '', assignees: [],
    status: 'todo', priority: '2', plan_date: '', progress: 0, actual_date: '', source: '', custom: '',
    rev: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '对方' };
  const changedT0 = { ...t0, title: '被对方改过的标题', rev: (t0.rev || 1) + 5, updated_at: '2099-01-01T00:00:00.000Z' };
  remotePayload.tasks = [...remotePayload.tasks.filter(t => t.id !== t0.id), changedT0, otherNewTask];
  const changedHandle = makeFakeHandle(JSON.stringify(remotePayload), 9999);
  S.setFileHandle(changedHandle);
  S.setLastSyncedMtime(1);   // 跟文件当前 mtime(9999) 不一致，走合并分支
  await S.syncToFile(S.DB);
  ok('写入了一次', changedHandle._writes.length === 1);
  ok('对方版本号更高的记录，本地内存里也换成了对方的标题', S.byId('task', t0.id).title === '被对方改过的标题');
  ok('对方新增的记录，本地内存里也出现了', !!S.byId('task', 'other_new_task'));
  ok('写回文件的内容里同样包含对方新增的记录', JSON.parse(changedHandle._writes[0]).tasks.some(t => t.id === 'other_new_task'));
  ok('索引已经跟着重建（byId 立刻查得到新记录）', S.byId('task', 'other_new_task').title === '对方新建的任务');
  S.setFileHandle(null);

  section('Repo.persist：只有连了共享文件才会触碰它');
  const noopHandle = makeFakeHandle(JSON.stringify(S.syncPayload(S.DB)), 1);
  S.setFileHandle(null);
  await S.Repo.persist(S.DB);
  ok('未连接时 persist 不会调用共享文件的写入', noopHandle._writes.length === 0);
  S.setFileHandle(noopHandle);
  S.setLastSyncedMtime(noopHandle._mtime());
  await S.Repo.persist(S.DB);
  ok('已连接时 persist 会顺带同步一次共享文件', noopHandle._writes.length === 1);
  S.setFileHandle(null);

  section('浏览器不支持文件系统访问时优雅降级');
  await S.connectSharedFile();
  ok('没有 showOpenFilePicker 时给出提示而不是崩溃', q('#snack-msg').textContent.includes('不支持'), q('#snack-msg').textContent);
  ok('没连上就是没连上，不会把 fileHandle 设成什么奇怪的东西', !S.fileHandle);

  section('没有 indexedDB 时重连接也优雅降级（不崩溃）');
  const reconnected = await S.tryReconnectSharedFile();
  ok('返回 false 而不是抛异常', reconnected === false);

  section('disconnectSharedFile：清掉连接状态');
  S.setFileHandle(makeFakeHandle('{}', 1));
  S.DB.settings.sharedFileName = '之前连接的文件.json';
  await S.disconnectSharedFile();
  ok('fileHandle 清空', !S.fileHandle);
  ok('settings.sharedFileName 清空', S.DB.settings.sharedFileName === '');

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
