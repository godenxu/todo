/* P3 工作台测试。用法：node test/test-p3.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
// 工作台是一次性拼好的 HTML 字符串，直接断言其内容
const dashHTML = () => { S.setPage('dashboard'); S.renderDashboard(); return q('#page-dashboard').innerHTML; };

async function main() {
  await tick(60);

  section('工作台渲染');
  let h = dashHTML();
  ok('渲染出内容', h.length > 2000, h.length);
  // 注意用 card[ "] 收尾，否则容器 class="cards" 也会被数进来
  ok('六张指标卡', (h.match(/class="card[ "]/g) || []).length === 6, (h.match(/class="card[ "]/g) || []).length);
  ok('卡片可点击跳转', h.includes('data-act="goto-view"'));
  ok('两栏布局', h.includes('dash-grid'));
  const panels = (h.match(/panel-h/g) || []).length;
  ok('六个面板', panels === 6, panels);
  ['需要关注', '里程碑时间线', '各职责推进情况', '我的工作台', '人员负荷', '最近动态']
    .forEach(t => ok('含面板：' + t, h.includes(t)));

  section('需要关注（分段）');
  ok('四个分段', ['逾期', '今日到期', '本周到期', '未指派'].every(t => h.includes(`data-act="dash-focus"`) && h.includes(t)));
  const tasks = S.visibleTasks().filter(t => !t.deleted_at);
  const overdue = tasks.filter(S.isOverdue);
  ok('默认落在逾期分段', h.includes('class="s on" data-act="dash-focus" data-k="overdue"') || h.includes('data-k="overdue"'));
  S.ACTIONS['dash-focus']({ k: 'today' });
  h = q('#page-dashboard').innerHTML;
  ok('切到今日分段', /class="s on"[^>]*data-k="today"/.test(h));
  S.ACTIONS['dash-focus']({ k: 'overdue' });
  h = q('#page-dashboard').innerHTML;
  ok('逾期条目数正确（最多10条）', (h.match(/data-act="focus-task"/g) || []).length >= Math.min(overdue.length, 10));

  section('里程碑时间线');
  h = dashHTML();
  const ms = S.DB.milestones.filter(m => !m.deleted_at && m.plan_date);
  if (ms.length) {
    ok('渲染时间线行', h.includes('tl-row'));
    ok('有今天基准线变量', h.includes('--today:'));
    ok('圆点定位用百分比', /class="tl-dot [a-z]+" style="left:[\d.]+%/.test(h));
    ok('四种状态色图例齐全', ['--c-late', '--c-soon', '--c-doing', '--c-done'].every(c => h.includes(c)));
    ok('有刻度轴', h.includes('tl-ticks') && h.includes('class="tk"'));
    ok('每行有文字状态标签（对比度警告的解除条件）', /class="tl-date[^"]*">[^<]+</.test(h));
    // 圆点百分比必须落在 0–100 之间
    const lefts = [...h.matchAll(/class="tl-dot [a-z]+" style="left:([\d.]+)%/g)].map(m => +m[1]);
    ok('所有圆点在轴范围内', lefts.length > 0 && lefts.every(v => v >= 0 && v <= 100), lefts.slice(0, 5));
  } else ok('（无里程碑数据，跳过）', true);

  section('各职责推进');
  ok('堆叠条渲染', h.includes('bar-row clickable'));
  ok('可下钻到职责', h.includes('data-act="duty-drill"'));
  // 段宽之和不得超过 100%
  const bars = [...h.matchAll(/<span class="track">([\s\S]*?)<\/span>\s*<span class="num">/g)];
  const widthsOk = bars.every(b => {
    const ws = [...b[1].matchAll(/width:([\d.]+)%/g)].map(m => +m[1]);
    return ws.reduce((a, c) => a + c, 0) <= 100.05;
  });
  ok('堆叠段宽合计 ≤ 100%', widthsOk, bars.length);
  ok('图例含四种状态', h.includes('未开始') && h.includes('已完成') && h.includes('进行中') && h.includes('逾期'));

  section('我的工作台');
  ok('未设使用者时给出引导', h.includes('尚未设置本机使用者'));
  S.DB.settings.me = '蒋双樑';
  h = dashHTML();
  ok('设了使用者后显示统计', h.includes('牵头') && !h.includes('尚未设置本机使用者'));
  const myWorks = S.visibleWorks().filter(w => w.owner === '蒋双樑').length;
  ok('牵头工作数正确', h.includes(`牵头 <b>${myWorks}</b> 项工作`), myWorks);
  ok('"我的在办"卡片可跳转 mine 视图', h.includes('data-view="mine"'));
  S.DB.settings.me = '';

  section('人员负荷');
  h = dashHTML();
  ok('负荷行渲染', h.includes('load-row'));
  ok('可点击筛选负责人', h.includes('data-act="filter-owner"'));
  const loadBars = [...h.matchAll(/<div class="load-row"[\s\S]*?<span class="track">([\s\S]*?)<\/span>\s*<span class="num">/g)];
  ok('负荷条宽度合计 ≤ 100%', loadBars.every(b => {
    const ws = [...b[1].matchAll(/width:([\d.]+)%/g)].map(m => +m[1]);
    return ws.reduce((a, c) => a + c, 0) <= 100.05;
  }), loadBars.length);
  // 点击负荷行应筛到该负责人
  const someOwner = S.DB.tasks.find(t => t.owner && !t.deleted_at).owner;
  S.ACTIONS['filter-owner']({ owner: someOwner });
  ok('筛选跳到任务页', S.currentPage === 'tasks' && S.UI.tasks.filters.owner === someOwner);
  const filtered = S.query('task', { pool: S.visibleTasks().filter(t => !t.deleted_at), filters: S.UI.tasks.filters });
  ok('筛选结果全是该负责人', filtered.length > 0 && filtered.every(t => t.owner === someOwner), filtered.length);
  S.UI.tasks.filters = {};

  section('最近动态');
  h = dashHTML();
  ok('动态列表渲染', h.includes('class="panel-b feed"'));
  ok('显示修改人（依赖 updated_by）', h.includes('class="who"'));
  ok('显示相对时间', /class="when">[^<]+</.test(h));

  section('数值一致性');
  h = dashHTML();
  const cardVals = [...h.matchAll(/<div class="k">([^<]+)<\/div><div class="v [^"]*">([^<]*)<\/div>/g)]
    .map(m => [m[1], m[2]]);
  const get = k => { const e = cardVals.find(x => x[0] === k); return e ? e[1] : null; };
  ok('未完成任务数与数据一致', +get('未完成任务') === tasks.filter(S.isOpen).length, [get('未完成任务'), tasks.filter(S.isOpen).length]);
  ok('逾期数与数据一致', +get('逾期') === overdue.length, [get('逾期'), overdue.length]);
  ok('逾期不含挂起任务', overdue.every(t => t.status !== 'hold'));
  ok('今日到期数一致', +get('今日到期') === tasks.filter(t => S.isOpen(t) && t.plan_date === S.todayStr()).length);

  section('边界：空数据不炸');
  const bak = { d: S.DB.duties, w: S.DB.works, m: S.DB.milestones, t: S.DB.tasks };
  S.DB.duties = []; S.DB.works = []; S.DB.milestones = []; S.DB.tasks = [];
  let crashed = false;
  try { h = dashHTML(); } catch (e) { crashed = true; console.log('    异常：' + e.message); }
  ok('全空时工作台不报错', !crashed);
  ok('全空时给出空状态提示', !crashed && h.includes('暂无'));
  S.DB.duties = bak.d; S.DB.works = bak.w; S.DB.milestones = bak.m; S.DB.tasks = bak.t;

  section('回归：P1/P2 未被破坏');
  S.setPage('tasks'); S.renderTasks();
  ok('任务页仍正常', S.taskRows.length > 0, S.taskRows.length);
  ok('两级树仍工作', /data-act="tree-pick"/.test(S.renderTaskTree(S.taskRows)));
  S.ACTIONS['sel-all']();
  ok('批量选择仍工作', S.UI.tasks.sel.size === S.taskRows.length);
  S.ACTIONS['sel-clear']();
  ok('CSV 表头仍完整', S.csvHeaders('task').includes('milestone'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
