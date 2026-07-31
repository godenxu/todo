/* P50：本轮五项——
   ① 删任务不连带删里程碑，留下一堆"点不到却仍算进统计"的脏数据；数据体检也发现不了
   ② 账号与角色的导入 / 导出
   ③ Ctrl+Z 撤销在连着共享文件夹时完全无效
   ④ 任务列表最左边那列多选框默认去掉（批量操作改成按需打开）
   ⑤ 双击进度：没有里程碑的照旧直接改数字，有里程碑的转去任务详情勾里程碑
   用法：node test/test-p50.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const clone = o => JSON.parse(JSON.stringify(o));

function makeStoreHandle(store) {
  return {
    name: 'shared.json',
    async getFile() { return { text: async () => store.text, lastModified: store.mtime || 1 }; },
    async createWritable() {
      return { async write(t) { store.text = t; store.mtime = (store.mtime || 1) + 1; store.writes++; }, async close() {} };
    },
  };
}

async function main() {
  await tick(60);
  const bak = {
    tasks: clone(S.DB.tasks), milestones: clone(S.DB.milestones), works: clone(S.DB.works),
    duties: clone(S.DB.duties), users: clone(S.DB.users), matrix: clone(S.DB.permissionMatrix), me: S.DB.settings.me,
  };
  const restore = () => {
    S.DB.tasks = clone(bak.tasks); S.DB.milestones = clone(bak.milestones); S.DB.works = clone(bak.works);
    S.DB.duties = clone(bak.duties); S.DB.users = clone(bak.users); S.DB.permissionMatrix = clone(bak.matrix);
    S.DB.settings.me = bak.me;
    S.UI.tasks.batchMode = false; S.UI.tasks.sel.clear();
    S.setFileHandle(null); S.setEverConnected(false);
    S.ACTIONS['modal-cancel']();
    S.rebuildIndex();
  };
  const aliveMsOf = id => S.DB.milestones.filter(m => m.task === id && !m.deleted_at).length;

  /* 这一段刻意走界面上真正的那几个动作（ACTIONS），而不是直接调 cascadeXxx 辅助函数——
     否则"某个删除入口忘了调连带删除"这种回归根本测不出来，而那恰恰是本次事故的形态 */
  section('★①：点任务行上的删除按钮时，它名下的里程碑必须跟着删');
  restore();
  S.DB.settings.me = '测试管理员';
  const t1 = S.DB.tasks.find(x => !x.deleted_at && aliveMsOf(x.id) > 0);
  const n1 = aliveMsOf(t1.id);
  ok('先确认这条任务确实带着里程碑', n1 > 0, n1);
  S.ACTIONS['task-del']({ id: t1.id });
  await S.modalCallback(); await tick();
  ok('★任务删掉后，它的里程碑一个都不剩（原来会全部留下来）', aliveMsOf(t1.id) === 0, aliveMsOf(t1.id));
  ok('任务自己也确实是删除状态', !!S.byId('task', t1.id).deleted_at);

  section('★①：点"恢复"时里程碑要一起回来（否则恢复出一个空壳任务）');
  await S.ACTIONS['task-restore']({ id: t1.id }); await tick();
  ok('★里程碑跟着回来了', aliveMsOf(t1.id) === n1, { 期望: n1, 实际: aliveMsOf(t1.id) });
  ok('任务本身也恢复了', !S.byId('task', t1.id).deleted_at);

  section('★①：批量删除也要连带（走的是另一条代码路径，容易漏）');
  restore();
  S.DB.settings.me = '测试管理员';
  const tb = S.DB.tasks.filter(x => !x.deleted_at && aliveMsOf(x.id) > 0).slice(0, 2);
  tb.forEach(x => S.UI.tasks.sel.add(x.id));
  S.ACTIONS['batch-delete']();
  await S.modalCallback(); await tick();
  ok('★批量删掉的任务，名下里程碑也都清了', tb.every(x => aliveMsOf(x.id) === 0),
    tb.map(x => aliveMsOf(x.id)));

  section('★①：彻底删除任务时，里程碑也要连墓碑一起彻底删掉');
  restore();
  S.DB.settings.me = '测试管理员';
  const t2 = S.DB.tasks.find(x => !x.deleted_at && aliveMsOf(x.id) > 0);
  const msIds = S.DB.milestones.filter(m => m.task === t2.id).map(m => m.id);
  S.ACTIONS['task-purge']({ id: t2.id });
  await S.modalCallback(); await tick();
  ok('任务记录整条没了', !S.DB.tasks.some(x => x.id === t2.id));
  ok('★它的里程碑记录也整条没了，不是留在库里当孤儿', !S.DB.milestones.some(m => msIds.includes(m.id)));
  ok('里程碑也留了墓碑（否则会从别人还没同步的设备上飘回来）',
    msIds.every(id => (S.DB.purged || []).some(p => p.entity === 'milestone' && p.id === id)));

  section('★①：数据体检要能发现历史遗留的"任务已删、里程碑还在"');
  restore();
  const t3 = S.DB.tasks.find(x => !x.deleted_at && aliveMsOf(x.id) > 0);
  const n3 = aliveMsOf(t3.id);
  S.softDelete('task', t3.id); S.rebuildIndex();   // 只删任务不删里程碑，模拟老数据
  const issue = S.healthCheck().issues.find(i => i.k === 'msOfDeletedTask');
  ok('★体检发现了这批脏数据（原来的 orphanMs 抓不到，因为软删除的任务 byId 仍查得到）', !!issue, issue);
  ok('数量对得上', issue && issue.n >= n3, { 期望至少: n3, 报告: issue && issue.n });
  ok('带一键修复', !!(issue && issue.fix));
  await S.fixHealth('msOfDeletedTask');
  ok('修完之后这条任务名下没有活着的里程碑了', aliveMsOf(t3.id) === 0);
  ok('这一项不再报了', !S.healthCheck().issues.some(i => i.k === 'msOfDeletedTask'));

  section('★③：撤销必须能顶过共享文件里那一份（这是原来完全失效的根因）');
  restore();
  const store = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeStoreHandle(store)); S.setEverConnected(true);
  await S.Repo.persist(S.DB);
  const t4 = S.DB.tasks.find(x => !x.deleted_at);
  const 原标题 = t4.title;
  S.snapshot();
  await S.Repo.upsert('task', Object.assign(t4, { title: 'P50改坏了的标题' }));
  ok('改动已经推到共享文件里了', JSON.parse(store.text).tasks.some(x => x.id === t4.id && x.title === 'P50改坏了的标题'));
  await S.undoLast();
  ok('★撤销之后内存里恢复成原标题（原来这一步就已经被自己的 persist 冲回去了）',
    S.byId('task', t4.id).title === 原标题, S.byId('task', t4.id).title);
  ok('★而且撤销的结果也推到共享文件里了',
    JSON.parse(store.text).tasks.some(x => x.id === t4.id && x.title === 原标题));
  await S.syncNowAndRender();
  ok('★再同步一轮，撤销的结果稳住了，没有被文件里的旧版本盖回来',
    S.byId('task', t4.id).title === 原标题, S.byId('task', t4.id).title);

  section('★③：撤销"新建"要变成软删除，而不是把记录从数组里抠掉');
  restore();
  const store2 = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeStoreHandle(store2)); S.setEverConnected(true);
  await S.Repo.persist(S.DB);
  S.snapshot();
  await S.Repo.upsert('task', S.blank('task', { id: 'p50_new', title: 'P50新建的任务', status: 'todo' }));
  ok('新建成功', !!S.byId('task', 'p50_new'));
  await S.undoLast();
  const undone = S.byId('task', 'p50_new');
  ok('★撤销后这条不再是有效任务', !!(undone && undone.deleted_at), undone);
  ok('★但记录本身还在（软删除），这样"撤销"才能同步给别人；直接抠掉的话它会从共享文件飘回来',
    !!undone);
  await S.syncNowAndRender();
  ok('同步一轮之后依然是删除状态，没有复活', !!S.byId('task', 'p50_new').deleted_at);

  section('★③：undoRestoreList 的版本号规则');
  const snap = [{ id: 'a', rev: 2, title: '旧' }];
  const cur = [{ id: 'a', rev: 7, title: '新' }];
  const out = S.undoRestoreList('id', snap, cur);
  ok('★内容变了的，版本号取两边较大者+1（才盖得过文件里那条）', out[0].rev === 8, out[0]);
  ok('内容用的是快照里的旧值', out[0].title === '旧');
  const same = [{ id: 'b', rev: 3, title: '一样' }];
  const out2 = S.undoRestoreList('id', same, clone(same));
  ok('★没变过的记录不白白顶版本号（否则每次撤销都要重写整个文件）', out2[0].rev === 3, out2[0]);

  section('★④：任务列表最左边那列多选框默认不出现');
  restore();
  S.setPage('tasks'); S.renderShell(); S.renderPage();   // 工具栏是 renderShell 画的，两个都得调
  ok('默认不是批量模式', S.UI.tasks.batchMode === false);
  ok('★表头没有多选框列', !q('#tasks-head').innerHTML.includes('col-sel'), q('#tasks-head').innerHTML.slice(0, 120));
  ok('★数据行里也没有多选框', !q('#tasks-body').innerHTML.includes('cb-sel'));
  ok('工具栏上有个「批量」按钮可以按需打开', q('#toolbar').innerHTML.includes('data-act="batch-mode-toggle"'));

  section('★④：点「批量」才亮出来，退出时收回并清空已勾选');
  S.ACTIONS['batch-mode-toggle']();
  ok('批量模式打开了', S.UI.tasks.batchMode === true);
  ok('★表头出现多选框列', q('#tasks-head').innerHTML.includes('col-sel'));
  ok('数据行也出现多选框', q('#tasks-body').innerHTML.includes('cb-sel'));
  S.UI.tasks.sel.add(S.DB.tasks.find(x => !x.deleted_at).id);
  S.ACTIONS['batch-mode-toggle']();
  ok('再点一次收回去了', S.UI.tasks.batchMode === false && !q('#tasks-head').innerHTML.includes('col-sel'));
  ok('★退出时把勾选清干净（免得下次进来还留着上次的选择）', S.UI.tasks.sel.size === 0);

  section('★⑤：双击进度——没有里程碑的照旧直接改数字');
  restore();
  const noMs = S.DB.tasks.find(x => !x.deleted_at && !S.hasCheckpoints(x));
  const cellNoMs = S.renderCellValue('task', noMs, S.fieldDef('task', 'progress'), true);
  ok('单元格可双击', cellNoMs.includes('data-dblact="edit"'));
  const fakeTd = { innerHTML: '', appendChild() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 9, bottom: 9 }), contains: () => false };
  S.ACTIONS['modal-cancel']();
  S.openEditor('task', noMs.id, 'progress', fakeTd);
  ok('★走的是原来的内联编辑，没有弹出任务详情', !q('#modal-overlay').classList.contains('show'));
  S.commitActiveEdit();

  section('★⑤：有里程碑的，双击转去任务详情让用户勾里程碑');
  const withMs = S.DB.tasks.find(x => !x.deleted_at && S.hasCheckpoints(x));
  const cellMs = S.renderCellValue('task', withMs, S.fieldDef('task', 'progress'), true);
  ok('★单元格现在也可以双击了（原来干脆不给双击，点了没反应像卡住）', cellMs.includes('data-dblact="edit"'), cellMs);
  ok('悬停提示说明了为什么不能直接改数字', cellMs.includes('自动计算'));
  S.ACTIONS['modal-cancel']();
  S.openEditor('task', withMs.id, 'progress', fakeTd);
  ok('★弹出的是任务详情（里面有里程碑编辑区）', q('#modal-body').innerHTML.includes('cp-list'));
  S.ACTIONS['modal-cancel']();

  section('★②：账号与角色导出');
  restore();
  S.DB.settings.me = '测试管理员';
  const payload = S.accountsExportPayload();
  ok('带了可识别的类型标记（导入时靠它认文件）', payload.kind === S.ACCOUNTS_EXPORT_KIND);
  ok('账号名单在里面', Array.isArray(payload.users) && payload.users.length > 0);
  ok('权限矩阵也一并导出', 'permissionMatrix' in payload);
  ok('记了是谁、什么时候、用哪个版本导的', !!payload.exportedBy && !!payload.exportedAt && !!payload.app);

  section('★②：导入文件的识别与报错');
  ok('不是 JSON → 说清楚原因', (S.parseAccountsFile('这不是json').err || '').includes('JSON'));
  ok('是 JSON 但没有账号 → 说清楚原因', !!S.parseAccountsFile('{"foo":1}').err);
  ok('账号列表是空的 → 拒绝', !!S.parseAccountsFile(JSON.stringify({ kind: S.ACCOUNTS_EXPORT_KIND, users: [] })).err);
  ok('★也认全量备份文件（那里面同样有 users）', !S.parseAccountsFile(JSON.stringify({ users: [{ name: '张三', role: 'staff' }] })).err);
  const good = S.parseAccountsFile(JSON.stringify(payload));
  ok('正常的导出文件能解析出账号', !good.err && good.users.length === payload.users.length);

  section('★②：导入采用合并，不删本机现有账号');
  const beforeNames = S.DB.users.map(u => u.name);
  const file = JSON.stringify({
    kind: S.ACCOUNTS_EXPORT_KIND,
    users: [
      { name: 'P50新同事', role: 'staff', rev: 1, updated_at: '2026-01-01T00:00:00.000Z' },
      { name: '测试管理员', role: 'admin', rev: 99, updated_at: '2099-01-01T00:00:00.000Z', salt: 's', hash: 'h', iterations: 1 },
    ],
    permissionMatrix: { staff: { view_tasks: false }, rev: 99, updated_at: '2099-01-01T00:00:00.000Z' },
  });
  S.importAccounts(file);
  ok('先弹确认框，不是直接就改', q('#modal-overlay').classList.contains('show'));
  await S.modalCallback();
  ok('★文件里独有的账号新增进来了', S.DB.users.some(u => u.name === 'P50新同事'));
  ok('★同名且版本更高的，用文件里那份', S.DB.users.find(u => u.name === '测试管理员').rev === 99);
  ok('★本机原有、文件里没有的账号一个都没少（导入不等于替换）',
    beforeNames.every(n => S.DB.users.some(u => u.name === n)), beforeNames);
  ok('权限矩阵也按版本号合并进来了', S.getPermissionMatrix().staff.view_tasks === false);

  section('★②：导入可以撤销');
  await S.undoLast();
  ok('撤销后那个新增的账号不再有效',
    (() => { const u = S.DB.users.find(x => x.name === 'P50新同事'); return !u || !!u.deleted_at; })());

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
