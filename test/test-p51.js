/* P51：本轮两项改动测试——
   ①撤销收紧：加 10 分钟有效期；并且不再回退/删除同事在这段窗口里动过的记录
   ②新增日志页（数据页与权限页之间，仅管理员）：登录 + 变更，按时间倒序，可分类、可分页
   用法：node test/test-p51.js */
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
  S.DB.settings.me = '测试管理员';
  if (!S.DB.users.some(u => u.name === '测试管理员')) {
    S.DB.users.push({ name: '测试管理员', role: 'admin', salt: '', hash: '', iterations: 0 });
  }

  /* ======================================================================
     ① 撤销收紧
     ====================================================================== */
  section('①-1 快照结构：带上时刻和操作人（后面判过期、判归属全靠这两个）');
  S.undoStack.length = 0;
  S.snapshot();
  const snap = S.undoStack[S.undoStack.length - 1];
  ok('快照不再是一个裸 JSON 字符串，而是带元信息的对象', typeof snap === 'object' && typeof snap.data === 'string');
  ok('记了快照时刻', !!snap.at && !isNaN(Date.parse(snap.at)));
  ok('记了操作人，并且取值方式跟 stampMeta 一致', snap.by === '测试管理员');
  ok('有效期常量是 10 分钟', S.UNDO_MAX_AGE_MS === 10 * 60 * 1000);

  section('①-2 touchedByOthersSince：只有"晚于快照 且 不是我改的"才算别人动过');
  const ctx = { at: '2026-07-30T10:00:00.000Z', by: '我' };
  ok('同事在快照之后改的 → 算', S.touchedByOthersSince({ updated_at: '2026-07-30T10:05:00.000Z', updated_by: '同事' }, ctx));
  ok('我自己在快照之后又存了一次 → 不算（那也是我的操作）',
    !S.touchedByOthersSince({ updated_at: '2026-07-30T10:05:00.000Z', updated_by: '我' }, ctx));
  ok('同事改的，但发生在快照之前 → 不算（那份内容本来就在我的快照里）',
    !S.touchedByOthersSince({ updated_at: '2026-07-30T09:55:00.000Z', updated_by: '同事' }, ctx));
  ok('空记录不会炸', !S.touchedByOthersSince(null, ctx));

  section('①-3 undoRestoreList：同事动过的那条整条保留，我的那条照常回退');
  const c = { at: '2026-07-30T10:00:00.000Z', by: '我', skipped: [] };
  const snapList = [
    { id: 'x1', title: '旧标题1', rev: 3, updated_at: '2026-07-30T09:00:00.000Z', updated_by: '我' },
    { id: 'x2', title: '旧标题2', rev: 3, updated_at: '2026-07-30T09:00:00.000Z', updated_by: '我' },
  ];
  const curList = [
    // 这条只有我动过 → 应该被回退成 snapList 里的内容
    { id: 'x1', title: '新标题1', rev: 4, updated_at: '2026-07-30T10:01:00.000Z', updated_by: '我' },
    // 这条同事随后也改了 → 整条保留他的版本
    { id: 'x2', title: '同事改的标题', rev: 5, updated_at: '2026-07-30T10:02:00.000Z', updated_by: '同事' },
  ];
  const restored = S.undoRestoreList('id', snapList, curList, c);
  const r1 = restored.find(r => r.id === 'x1'), r2 = restored.find(r => r.id === 'x2');
  ok('★我自己改的那条被回退了', r1.title === '旧标题1');
  ok('★而且版本号顶到了两边较大者+1（否则一同步就被文件里那份盖回来）', r1.rev === 5, r1.rev);
  ok('★★同事改过的那条纹丝不动，他的改动没有被吞掉', r2.title === '同事改的标题' && r2.rev === 5);
  ok('跳过的事实被记下来了，不是默默吞掉', c.skipped.length === 1 && c.skipped[0] === '同事');

  section('①-4 undoRestoreList：新增记录只删我建的，同事新建的绝不碰');
  const c2 = { at: '2026-07-30T10:00:00.000Z', by: '我', skipped: [] };
  const out2 = S.undoRestoreList('id', [], [
    { id: 'mine', rev: 1, updated_at: '2026-07-30T10:01:00.000Z', updated_by: '我' },
    { id: 'theirs', rev: 1, updated_at: '2026-07-30T10:01:00.000Z', updated_by: '同事' },
  ], c2);
  ok('★我这次操作新建的 → 撤销把它软删除掉', !!out2.find(r => r.id === 'mine').deleted_at);
  ok('★★同事新建、刚同步进来的 → 一个字都不动（删了就是事故）', !out2.find(r => r.id === 'theirs').deleted_at);
  ok('同样计入跳过项', c2.skipped.length === 1);

  section('①-5 有效期：超过 10 分钟的快照直接作废，且整栈清空');
  S.undoStack.length = 0;
  S.DB.tasks[0].title = '被改过的标题-p51';
  S.snapshot();
  S.snapshot();
  // 手工把两个快照的时刻往前推 20 分钟，模拟"改完晾了二十分钟才想起来撤销"
  S.undoStack.forEach(s => { s.at = iso(Date.now() - 20 * 60 * 1000); });
  const titleBefore = S.DB.tasks[0].title;
  await S.undoLast();
  ok('★过期快照不执行回退，数据保持现状', S.DB.tasks[0].title === titleBefore);
  ok('提示里说清楚了为什么不给撤销', q('#snack-msg').textContent.includes('分钟') && q('#snack-msg').textContent.includes('撤销'),
    q('#snack-msg').textContent);
  ok('★整个撤销栈一起作废（更早的只会更过期，留着也是白点）', S.undoStack.length === 0);
  ok('顶栏那个撤销按钮跟着收起来了，不给一个点了必然失败的按钮', q('#undo-btn').classList.contains('hidden'));

  section('①-6 端到端：同事改了同一条任务，我的撤销不会把他的改动一起抹掉');
  S.undoStack.length = 0;
  const t = S.DB.tasks[0];
  t.title = '原始标题-p51'; t.owner = '原始牵头人'; t.updated_by = '我'; t.rev = 1;
  t.updated_at = iso(Date.now() - 60 * 1000);
  S.DB.settings.me = '我';
  S.snapshot();
  // 我改标题
  t.title = '我改的标题'; S.stampMeta(t);
  // 同事在这之后改了同一条的牵头人（模拟同步合并进来的结果）
  t.owner = '同事改的牵头人'; t.rev += 1; t.updated_at = iso(Date.now() + 1000); t.updated_by = '李同事';
  await S.undoLast();
  const after = S.DB.tasks.find(x => x.id === t.id);
  ok('★★同事改的牵头人还在（撤销没有越界去动别人的改动）', after.owner === '同事改的牵头人', after.owner);
  ok('作为代价，我自己那处改动这次也没撤掉——这是刻意的保守取舍', after.title === '我改的标题');
  ok('并且明确告诉了用户哪些没回退、是因为谁',
    q('#snack-msg').textContent.includes('李同事') && q('#snack-msg').textContent.includes('保留'),
    q('#snack-msg').textContent);

  section('①-7 端到端：没人跟我抢的时候，撤销照旧完整生效');
  S.undoStack.length = 0;
  const t2 = S.DB.tasks[1];
  t2.title = '干净的原始标题'; t2.updated_by = '我'; t2.rev = 1; t2.updated_at = iso(Date.now() - 60 * 1000);
  S.snapshot();
  t2.title = '改坏了'; S.stampMeta(t2);
  await S.undoLast();
  ok('★没有第三方介入时，撤销完整回退', S.DB.tasks.find(x => x.id === t2.id).title === '干净的原始标题');
  // 干净撤销走的是 hideSnack()：它只摘掉 show 这个 class，不清空里面的文字，
  // 所以这里查的是"提示条有没有露出来"，不是查文字内容（上一段留下的文案还在 DOM 里）
  ok('这种情况下不弹任何提示条（没有需要额外交代的事）', !q('#snackbar').classList.contains('show'));

  section('①-8 变更日志/墓碑不再被整体拨回，同事那部分要留着');
  S.undoStack.length = 0;
  S.DB.changelog = [{ id: 'old1', at: iso(Date.now() - 5000), by: '我', taskId: 't1', summary: '早就有的' }];
  S.DB.purged = [{ entity: 'task', id: 'p-old', at: iso(Date.now() - 5000), by: '我' }];
  S.snapshot();
  // 我这次操作留下的动态 + 同事同步进来的动态/墓碑
  S.DB.changelog.push({ id: 'mine1', at: iso(Date.now()), by: '我', taskId: 't1', summary: '我这次改的' });
  S.DB.changelog.push({ id: 'theirs1', at: iso(Date.now()), by: '王同事', taskId: 't2', summary: '同事改的' });
  S.DB.purged.push({ entity: 'task', id: 'p-theirs', at: iso(Date.now()), by: '王同事' });
  await S.undoLast();
  const logIds = S.DB.changelog.map(e => e.id);
  ok('快照里原有的动态还在', logIds.includes('old1'));
  ok('★我这次操作留下的动态被撤掉了', !logIds.includes('mine1'));
  ok('★★同事的动态没有被一起抹掉（以前是整个数组拨回快照，他那条会凭空消失）', logIds.includes('theirs1'));
  ok('★★同事的墓碑也保住了（否则他彻底删掉的记录会复活）',
    S.DB.purged.some(p => p.id === 'p-theirs'));

  S.DB.settings.me = '测试管理员';

  /* ======================================================================
     ② 日志页
     ====================================================================== */
  section('②-1 页面注册：夹在数据页和权限页之间，且是管理员专属');
  const keys = S.PAGES.map(p => p.key);
  ok('有 logs 这一页', keys.includes('logs'));
  ok('★位置就在数据页和权限页中间', keys.indexOf('logs') === keys.indexOf('data') + 1 && keys.indexOf('permissions') === keys.indexOf('logs') + 1, keys);
  // P54 之后不再是硬编码 adminOnly，改成 view_logs 权限矩阵项（默认仍然只有管理员能看，
  // 效果不变，区别是现在管理员可以主动放开给别的角色）
  ok('跟数据页/权限页一样走 view_logs 权限矩阵项，默认仍只对管理员开放',
    S.PAGES.find(p => p.key === 'logs').viewPermission === 'view_logs'
    && S.PERMISSIONS.some(p => p.key === 'view_logs')
    && S.DEFAULT_PERMISSION_MATRIX.staff.view_logs === false);
  ok('页面容器存在', html.includes('id="page-logs"'));

  section('②-2 登录事件：写进 changelog，带 kind=login，且不污染工作台最近动态');
  S.DB.changelog = [];
  S.pushLoginLog('张三', '输入 PIN 登录');
  const le = S.DB.changelog[0];
  ok('记下来了', S.DB.changelog.length === 1);
  ok('类型是 login', S.logKind(le) === 'login');
  ok('记的是登录的人', le.by === '张三');
  ok('★taskId 是空的——工作台「最近动态」按 taskId 过滤，登录记录因此不会混进那个面板', !le.taskId);
  ok('老数据没有 kind 字段时按"变更"算，不会被当成未知类型丢掉', S.logKind({ id: 'x' }) === 'edit');

  section('②-3 三条登录路径都埋了点');
  ok('输入 PIN 登录', html.includes(`pushLoginLog(d.name, '输入 PIN 登录')`));
  ok('首次设置 PIN 并登录', html.includes(`pushLoginLog(d.name, '首次设置 PIN 并登录'`) || html.includes('首次设置 PIN 并登录'));
  ok('创建账号并登录', html.includes('创建账号并登录'));

  section('②-4 时间分类边界 logRangeBounds（纯函数，now 从外面传所以可测）');
  const noon = new Date(2026, 6, 30, 12, 0, 0).getTime();   // 2026-07-30 周四 中午
  const todayMidnight = new Date(2026, 6, 30, 0, 0, 0).toISOString();
  const ydayMidnight = new Date(2026, 6, 29, 0, 0, 0).toISOString();
  ok('今天：从今天零点起，没有上界', JSON.stringify(S.logRangeBounds('today', noon)) === JSON.stringify({ from: todayMidnight, to: null }));
  ok('★昨天是一整段闭区间（昨天零点→今天零点），不是"最近两天"',
    JSON.stringify(S.logRangeBounds('yesterday', noon)) === JSON.stringify({ from: ydayMidnight, to: todayMidnight }));
  ok('本周从周一算起（7/30 是周四 → 回退到 7/27）',
    S.logRangeBounds('week', noon).from === new Date(2026, 6, 27, 0, 0, 0).toISOString());
  ok('本月从 1 号算起', S.logRangeBounds('month', noon).from === new Date(2026, 6, 1, 0, 0, 0).toISOString());
  ok('全部：两头都不设限', JSON.stringify(S.logRangeBounds('all', noon)) === JSON.stringify({ from: null, to: null }));

  section('②-5 筛选 filterLogs：时间段 / 类型 / 人员，并且按时间从近到远');
  const list = [
    { id: 'a', at: new Date(2026, 6, 30, 9, 0, 0).toISOString(), by: '张三', kind: 'login', summary: '登录' },
    { id: 'b', at: new Date(2026, 6, 30, 11, 0, 0).toISOString(), by: '李四', taskId: 't1', summary: '改了标题' },
    { id: 'c', at: new Date(2026, 6, 29, 15, 0, 0).toISOString(), by: '张三', taskId: 't1', summary: '昨天改的' },
    { id: 'd', at: new Date(2026, 6, 20, 15, 0, 0).toISOString(), by: '张三', taskId: 't1', summary: '这个月早些时候' },
  ];
  ok('★按时间从近到远（近的在最前）', S.filterLogs(list, { range: 'all', now: noon }).map(e => e.id).join(',') === 'b,a,c,d');
  ok('今天只有 a、b', S.filterLogs(list, { range: 'today', now: noon }).map(e => e.id).sort().join(',') === 'a,b');
  ok('昨天只有 c（不含今天的）', S.filterLogs(list, { range: 'yesterday', now: noon }).map(e => e.id).join(',') === 'c');
  ok('本月四条都在', S.filterLogs(list, { range: 'month', now: noon }).length === 4);
  ok('按类型筛登录', S.filterLogs(list, { range: 'all', kind: 'login', now: noon }).map(e => e.id).join(',') === 'a');
  ok('按类型筛变更（老数据没 kind 也算变更）',
    S.filterLogs(list, { range: 'all', kind: 'edit', now: noon }).map(e => e.id).join(',') === 'b,c,d');
  ok('按人员筛', S.filterLogs(list, { range: 'all', who: '张三', now: noon }).map(e => e.id).join(',') === 'a,c,d');
  ok('条件可以叠加', S.filterLogs(list, { range: 'today', who: '张三', now: noon }).map(e => e.id).join(',') === 'a');

  section('②-6 页面渲染：表格、分类按钮、人员下拉');
  S.DB.changelog = [];
  const realTask = S.DB.tasks[0];
  S.DB.changelog.push({ id: 'g1', at: new Date().toISOString(), by: '张三', kind: 'login', taskId: '', summary: '输入 PIN 登录' });
  S.DB.changelog.push({ id: 'g2', at: new Date().toISOString(), by: '李四', taskId: realTask.id, summary: '状态：进行中→已完成' });
  S.UI.logs.range = 'today'; S.UI.logs.kind = 'all'; S.UI.logs.who = ''; S.UI.logs.page = 1;
  S.goto('logs');
  const lh = q('#page-logs').innerHTML;
  ok('管理员能进日志页', S.currentPage === 'logs');
  ok('登录记录显示出来了', lh.includes('输入 PIN 登录') && lh.includes('张三'));
  ok('变更记录显示出来了，并且带上了任务标题', lh.includes('状态：进行中→已完成') && lh.includes(realTask.title));
  ok('★变更那一行可以点，直接跳到对应任务', lh.includes(`data-act="focus-task" data-id="${realTask.id}"`));
  ok('登录那一行没有跳转（没有可跳的对象）', !lh.includes('data-id=""'));
  ok('五个时间分类按钮都在', S.LOG_RANGES.every(r => lh.includes(`data-range="${r.key}"`)));
  ok('分类按钮上带条数，不用点进去就知道哪段有动静', /data-range="today"[^>]*>今天 2</.test(lh), lh.match(/data-range="today"[^>]*>[^<]*/));
  ok('三个类型按钮都在', S.LOG_KINDS.every(k => lh.includes(`data-kind="${k.key}"`)));
  ok('人员下拉里有出现过的人', lh.includes('>张三<') && lh.includes('>李四<'));
  ok('说明里讲清楚了这是同步的、能看到全处同事的操作', lh.includes('同步') && lh.includes('同事'));
  ok('也讲清楚了只保留最近 N 条、不是长期审计档案', lh.includes(String(S.CHANGELOG_LIMIT)) && lh.includes('审计'));

  section('②-7 分页');
  S.DB.changelog = Array.from({ length: 120 }, (_, i) => ({
    id: 'p' + i, at: new Date(Date.now() - i * 1000).toISOString(), by: '张三', kind: 'login', taskId: '', summary: '第' + i + '次登录',
  }));
  S.UI.logs.page = 1; S.renderLogs();
  ok('每页 50 条', S.LOG_PAGE_SIZE === 50);
  const cnt = h => (h.match(/次登录/g) || []).length;
  ok('第一页只渲染 50 行', cnt(q('#page-logs').innerHTML) === 50);
  ok('页码显示 1/3', q('#page-logs').innerHTML.includes('第 1 / 3 页'));
  ok('第一页时"上一页"是禁用的', /data-act="logs-page" data-step="-1" disabled/.test(q('#page-logs').innerHTML));
  S.ACTIONS['logs-page']({ step: '1' });
  ok('翻到第 2 页', S.UI.logs.page === 2 && q('#page-logs').innerHTML.includes('第 2 / 3 页'));
  S.ACTIONS['logs-page']({ step: '1' });
  S.ACTIONS['logs-page']({ step: '1' });
  ok('★翻过头会被夹回最后一页，不会翻出一片空白', S.UI.logs.page === 3);
  ok('最后一页时"下一页"是禁用的', /data-act="logs-page" data-step="1" disabled/.test(q('#page-logs').innerHTML));

  section('②-8 换筛选条件时页码要归位（否则会停在新结果集里根本不存在的页上）');
  S.UI.logs.page = 3;
  S.ACTIONS['logs-range']({ range: 'yesterday' });
  ok('★换时间段，页码回到第 1 页', S.UI.logs.page === 1 && S.UI.logs.range === 'yesterday');
  S.UI.logs.page = 2; S.UI.logs.range = 'all'; S.renderLogs();
  S.ACTIONS['logs-kind']({ kind: 'login' });
  ok('换类型，页码同样回到第 1 页', S.UI.logs.page === 1 && S.UI.logs.kind === 'login');
  S.UI.logs.page = 2; S.renderLogs();
  S.ACTIONS['logs-who']({}, { value: '张三' });
  ok('换人员，页码同样回到第 1 页', S.UI.logs.page === 1 && S.UI.logs.who === '张三');
  ok('★人员下拉走 change 而不是 click 分发（点开下拉那一下不该被当成"选好了"）',
    // 断言只盯"logs-who 在不在这张名单里"，不再整串比对——P55 又往名单里加了报告编排的
    // 勾选框和下拉框，整串比对会因为跟本条毫无关系的新增而失败
    html.includes(`'logs-who'`) && /CHANGE_ONLY_ACTS = \[[^\]]*'logs-who'/.test(html));

  section('②-9 非管理员进不去');
  S.DB.users.push({ name: 'P51员工', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = 'P51员工';
  S.renderShell();
  ok('导航栏里根本没有日志入口', !q('#nav').innerHTML.includes('data-page="logs"'));
  S.goto('logs');
  ok('★直接改地址栏也会被弹回工作台', S.currentPage === 'dashboard', S.currentPage);

  S.DB.settings.me = bakMe;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
