/* P53：本轮四项——
   ①任务列表操作列只留删除（详情☰、复制⧉两个按钮去掉）
   ②复制任务功能整体移除；排查"复制一条任务后所有任务和工作都变成多条"的事故，
     修掉真正能造成批量重复的那条路径，并给已经产生的重复数据一个能查能清的出口
   ③工作页/职责页的改动进日志；删除有自己独立的一条记录，
     不再只是把别的记录标成「（已删除）」
   ④换版本后本机还留着旧缓存 —— 打戳识别 + 提示 + "以共享文件为准"的重置出口
   用法：node test/test-p53.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const iso = ms => new Date(ms).toISOString();

async function main() {
  await tick(60);
  S.seedAll();
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const bakMe = S.DB.settings.me;
  if (!S.DB.users.some(u => u.name === '测试管理员')) {
    S.DB.users.push({ name: '测试管理员', role: 'admin', salt: '', hash: '', iterations: 0 });
  }
  S.DB.settings.me = '测试管理员';

  /* ====================== ① 操作列 ====================== */
  section('①：任务列表最右边那列只剩删除按钮');
  const t0 = S.DB.tasks.find(t => !t.deleted_at);
  const rowHTML = S.renderTaskRow(t0);
  ok('删除按钮还在', rowHTML.includes('data-act="task-del"'));
  /* 这里查的是"操作列里还有几个按钮"，不是"整行里还有没有 task-detail"——
     任务编号那一格本身就带 task-detail（点编号打开详情是保留的功能），
     按整行搜会把它一起搜到，测了个假的 */
  ok('操作列里只剩一个按钮', (rowHTML.match(/class="action-btn/g) || []).length === 1,
    (rowHTML.match(/class="action-btn[^"]*"/g) || []));
  ok('★详情按钮（☰）去掉了', !rowHTML.includes('action-btn ms'));
  ok('★复制按钮（⧉）去掉了', !rowHTML.includes('action-btn copy'));
  // 详情按钮撤掉不等于没法看详情——点任务编号那一格照样能打开
  const codeCell = S.renderCellValue('task', t0, S.fieldDef('task', 'code'), true);
  ok('★任务编号那一格仍然点得开详情（所以详情按钮才是多余的）',
    codeCell.includes('data-act="task-detail"'), codeCell);
  ok('已删除视图里的恢复/彻底删除按钮不受影响', (() => {
    const d = Object.assign({}, t0, { deleted_at: iso(Date.now()) });
    const h = S.renderTaskRow(d);
    return h.includes('task-restore') && h.includes('task-purge');
  })());

  section('②：复制任务功能整体移除');
  ok('★ACTIONS 里没有 task-dup 这个动作了', !S.ACTIONS['task-dup']);
  ok('页面上也没有任何地方还能触发它', !html.includes('data-act="task-dup"'));
  ok('实现代码整段删掉了，不是留着不用', !html.includes("'task-dup':"));

  /* ====================== ② 批量重复 ====================== */
  section('②：宽表导入重复导致的批量复制 —— 这才是"所有任务都变多条"的真正来源');
  S.DB.works = [S.stampMeta(S.blank('work', { code: '0101', duty: '01', name: 'P53测试工作', year: 2026, status: 'doing' }))];
  S.DB.tasks = []; S.DB.milestones = [];
  S.rebuildIndex();
  // 线下整理的表里「任务项编号」经常是空的——新任务本来就还没编号
  const wideCSV = [
    S.wideImportHeaders().join(','),
    ['P53测试工作', '', '编制年度规划初稿', '张三', ''].concat(new Array(18).fill('')).join(','),
    ['P53测试工作', '', '组织专家评审', '李四', ''].concat(new Array(18).fill('')).join(','),
  ].join('\r\n');

  await S.applyWideImport('merge', wideCSV);
  const after1 = S.DB.tasks.filter(t => !t.deleted_at).length;
  ok('第一次导入建了 2 条任务', after1 === 2, after1);
  await S.applyWideImport('merge', wideCSV);
  const after2 = S.DB.tasks.filter(t => !t.deleted_at).length;
  ok('★★同一份表再导一次，任务数不变（以前编号为空就一律新建，导一次翻一倍）', after2 === 2, after2);
  await S.applyWideImport('merge', wideCSV);
  ok('★导第三次也还是 2 条', S.DB.tasks.filter(t => !t.deleted_at).length === 2);

  section('②：已经产生的重复数据 —— 体检查得出来、一键清得掉');
  S.DB.tasks = []; S.DB.works = []; S.rebuildIndex();
  const w1 = S.stampMeta(S.blank('work', { code: '0101', duty: '01', name: '正本', year: 2026, status: 'doing' }));
  w1.created_at = iso(Date.now() - 100000);
  const w2 = S.stampMeta(S.blank('work', { code: '0101', duty: '01', name: '重复导入的副本', year: 2026, status: 'doing' }));
  w2.created_at = iso(Date.now());
  const w3 = S.stampMeta(S.blank('work', { code: '0101', duty: '01', name: '另一个年度，不算重复', year: 2027, status: 'doing' }));
  S.DB.works = [w1, w2, w3];
  const mk = (title, ago) => {
    const t = S.stampMeta(S.blank('task', { work: w1.id, title, status: 'todo', priority: '2', progress: 0 }));
    t.created_at = iso(Date.now() - ago);
    return t;
  };
  S.DB.tasks = [mk('编制初稿', 100000), mk('编制初稿', 0), mk('组织评审', 100000)];
  S.rebuildIndex();

  let hc = S.healthCheck();
  const dupT = hc.issues.find(i => i.k === 'dupTask');
  const dupW = hc.issues.find(i => i.k === 'dupWork');
  ok('★查出了 1 条重复任务（同一项工作下同名）', dupT && dupT.n === 1, dupT);
  ok('★查出了 1 项重复工作（同年度同编号）', dupW && dupW.n === 1, dupW);
  ok('不同年度的同编号工作不算重复（年度复制出来的是正常数据）', hc.dupWorkIds.length === 1);
  ok('保留的是最早创建的那条，清掉后建的那条',
    hc.dupTaskIds.length === 1 && S.byId('task', hc.dupTaskIds[0]).created_at === S.DB.tasks[1].created_at);

  await S.fixHealth('dupTask');
  ok('★一键清理后，重复任务被删掉了', S.DB.tasks.filter(t => !t.deleted_at && t.title === '编制初稿').length === 1);
  ok('★是软删除，不是抹掉——万一判断错了还能在「已删除」视图里找回来',
    S.DB.tasks.filter(t => t.deleted_at).length === 1);
  ok('清理这件事也记进了日志',
    S.DB.changelog.some(e => (e.summary || '').includes('重复任务')));
  await S.fixHealth('dupWork');
  ok('★重复工作也清掉了', S.DB.works.filter(w => !w.deleted_at && w.code === '0101' && w.year === 2026).length === 1);
  ok('清完之后体检不再报这两项', (() => {
    const h = S.healthCheck();
    return !h.issues.some(i => i.k === 'dupTask') && !h.issues.some(i => i.k === 'dupWork');
  })());

  /* ====================== ③ 日志 ====================== */
  section('③：工作页 / 职责页的改动现在也进日志了');
  S.seedAll();
  S.DB.settings.me = '测试管理员';
  S.DB.changelog = [];
  const w = S.DB.works.find(x => !x.deleted_at);
  await S.finishSpCommitSingle('work', w.id, 'owner', '新牵头人P53');
  const wLog = S.DB.changelog.find(e => S.logEntity(e) === 'work');
  ok('★改工作的牵头人有日志了（以前工作/职责的任何改动都不记）', !!wLog, S.DB.changelog);
  ok('记的是改了什么', (wLog && wLog.summary || '').includes('新牵头人P53'), wLog && wLog.summary);
  ok('挂的是工作这条记录', wLog && S.logRefId(wLog) === w.id);
  ok('★taskId 留空——否则工作台「最近动态」会拿工作 id 去查任务，查不到就渲染成"任务已不存在"',
    wLog && !wLog.taskId);

  S.DB.changelog = [];
  const dt = S.DB.duties.find(x => !x.deleted_at);
  await S.finishSpCommitSingle('duty', dt.code, 'category', 'P53新分类');
  ok('★改职责也有日志了', S.DB.changelog.some(e => S.logEntity(e) === 'duty'));

  section('③：删除现在有自己独立的一条日志');
  S.DB.changelog = [];
  const delTask = S.DB.tasks.find(t => !t.deleted_at);
  const delTitle = delTask.title;
  S.ACTIONS['task-del']({ id: delTask.id });
  await S.modalCallback();
  const delLog = S.DB.changelog.find(e => (e.summary || '').includes('删除了任务'));
  ok('★★删任务留下了一条独立记录（以前完全不记，只能靠别的记录后面被标「已删除」猜）',
    !!delLog, S.DB.changelog);
  ok('记录里写明了删的是哪一条', (delLog && delLog.summary || '').includes(delTitle));
  ok('记录里有是谁删的', delLog && delLog.by === '测试管理员');

  S.DB.changelog = [];
  const delWork = S.DB.works.find(x => !x.deleted_at);
  S.ACTIONS['work-del']({ id: delWork.id });
  await S.modalCallback();
  ok('★停用工作也有独立记录', S.DB.changelog.some(e => (e.summary || '').includes('停用了工作')));

  S.DB.changelog = [];
  const delDuty = S.DB.duties.find(x => !x.deleted_at);
  S.ACTIONS['duty-del']({ code: delDuty.code });
  await S.modalCallback();
  ok('★删除职责也有独立记录', S.DB.changelog.some(e => (e.summary || '').includes('删除了职责')));

  section('③：日志页能正确显示工作/职责的记录');
  S.seedAll();
  S.DB.settings.me = '测试管理员';
  const lw = S.DB.works.find(x => !x.deleted_at);
  S.DB.changelog = [
    { id: 'g1', at: iso(Date.now()), by: '张三', kind: 'edit', entity: 'work', refId: lw.id, taskId: '', summary: '牵头人：空→张三' },
    { id: 'g2', at: iso(Date.now()), by: '李四', kind: 'edit', entity: 'duty', refId: S.DB.duties[0].code, taskId: '', summary: '名称：甲→乙' },
  ];
  S.UI.logs.range = 'today'; S.UI.logs.kind = 'all'; S.UI.logs.who = ''; S.UI.logs.page = 1;
  S.goto('logs');
  const lh = q('#page-logs').innerHTML;
  ok('工作那条显示出来了，并且标了"工作"', lh.includes('牵头人：空→张三') && lh.includes('>工作<'));
  ok('职责那条也在，并且标了"职责"', lh.includes('名称：甲→乙') && lh.includes('>职责<'));
  ok('★工作/职责的记录点得动，跳到对应页面', lh.includes('data-act="focus-record"'));
  S.ACTIONS['focus-record']({ entity: 'work', id: lw.id });
  ok('点了之后确实跳到工作页并把它搜出来', S.currentPage === 'works' && S.UI.works.search === lw.code);

  section('③：老日志（没有 entity 字段）仍然按任务处理，不能读成未知类型');
  ok('logEntity 缺省是 task', S.logEntity({ id: 'x', taskId: 'abc' }) === 'task');
  ok('logRefId 能从老的 taskId 里取到', S.logRefId({ id: 'x', taskId: 'abc' }) === 'abc');

  /* ====================== ④ 旧缓存 ====================== */
  section('④：换版本之后本机还留着旧缓存');
  ok('★每次保存都会在缓存上盖当前版本号的戳', html.includes('db.settings.localAppVersion = APP_VERSION'));
  ok('开机时读出来跟当前版本比对', html.includes('_localCacheStale = _localCacheAppVersion !== APP_VERSION'));

  S.setLocalCacheStale(false);
  ok('版本对得上时，数据页不出提示', S.localCachePanelHTML() === '');
  S.setLocalCacheStale(true, 'v20260101000000');
  const panel = S.localCachePanelHTML();
  ok('★版本对不上就给出醒目提示', panel.includes('本机缓存不是当前这一版写的'));
  ok('提示里写明了旧缓存是哪一版写的', panel.includes('v20260101000000'));
  ok('讲清楚了危害：旧记录会被当成新内容重新推上共享文件', panel.includes('重新推上共享文件'));
  ok('★给了"以共享文件为准"的出口', panel.includes('data-act="reset-local-cache"'));
  ok('也给了"我确认没问题"的出口，不逼着人重置', panel.includes('data-act="dismiss-cache-warn"'));

  section('④：重置的安全边界');
  S.setFileHandle(null);
  S.ACTIONS['reset-local-cache']();
  ok('★没连共享文件夹时拒绝重置（不然本机数据会被清空且拿不回来）',
    q('#snack-msg').textContent.includes('拦下'), q('#snack-msg').textContent);
  ok('数据一条没少', S.DB.tasks.length > 0);
  S.setLocalCacheStale(true, 'v20260101000000');
  S.ACTIONS['dismiss-cache-warn']();
  ok('点"我确认没问题"之后提示消失', !S.localCacheStale && S.localCachePanelHTML() === '');
  ok('非管理员看不到那两个按钮，只提示去找管理员', (() => {
    S.DB.users.push({ name: 'P53员工', role: 'staff', salt: '', hash: '', iterations: 0 });
    S.DB.settings.me = 'P53员工';
    S.setLocalCacheStale(true, 'v20260101000000');
    const h = S.localCachePanelHTML();
    S.DB.settings.me = '测试管理员';
    return !h.includes('reset-local-cache') && h.includes('联系管理员');
  })());

  S.setLocalCacheStale(false);
  S.DB.settings.me = bakMe;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
