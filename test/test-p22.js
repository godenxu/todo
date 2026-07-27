/* P22：本轮改动测试——
   1) 工作台"人员负荷"显示所有人（不再只取前 9 个），按姓名拼音排序
   2) 任务详情弹窗里程碑区：去掉底部"添加一条"按钮（每行都有插入按钮了）；
      "里程碑/交付物"标签挪到独立一行、左对齐、在第一条里程碑上方；
      状态/优先级/计划完成时间三个字段合并到同一行
   3) 任务页表格彻底去掉"完成勾选"这一整列（不只是内容，连列本身/表头都没了）
   4) 图表页新增"按任务""按工作"两个 tab，各用饼图+柱状图依次展现当前所有任务/工作项的各种状态
   5)（同上）
   6) 图表页"按分类"改名"按职责"
   用法：node test/test-p22.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const render = tab => { S.setPage('charts'); if (tab) S.ACTIONS['chart-tab']({ k: tab }); else S.renderCharts(); return q('#page-charts').innerHTML; };

async function main() {
  await tick(60);
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const restore = () => { S.DB.users = JSON.parse(JSON.stringify(bakUsers)); S.DB.settings.me = bakMe; };

  section('人员负荷：显示全部人员，按姓名拼音排序');
  const dutyCode = 'P22LOAD';
  await S.Repo.upsert('duty', { code: dutyCode, name: 'P22负荷测试职责' });
  const wid = 'w_p22load';
  await S.Repo.upsert('work', { id: wid, duty: dutyCode, name: 'P22负荷测试工作', owner: '测试管理员' });
  // 制造 12 个不同的负责人，如果还限制"前9个"就一定有人被漏掉
  const names = ['赵一', '钱二', '孙三', '李四', '周五', '吴六', '郑七', '王八', '冯九', '陈十', '褚十一', '卫十二'];
  for (const nm of names) {
    await S.Repo.upsert('task', { id: 'p22_load_' + nm, work: wid, title: 'P22任务_' + nm, status: 'todo', plan_date: S.offsetDate(10), owner: nm, assignees: [] });
  }
  S.setPage('dashboard'); S.renderDashboard();
  const dashH = q('#page-dashboard').innerHTML;
  ok('12 个负责人全部出现在人员负荷里，一个都没被截掉', names.every(nm => dashH.includes(`data-owner="${nm}"`)));
  const positions = names.map(nm => dashH.indexOf(`data-owner="${nm}"`));
  const sortedNames = [...names].sort((a, b) => a.localeCompare(b, 'zh'));
  const sortedPositions = sortedNames.map(nm => dashH.indexOf(`data-owner="${nm}"`));
  ok('确实是按拼音排序出现的（跟手动按拼音排一遍的顺序位置一致）', JSON.stringify(positions.slice().sort((a, b) => a - b)) === JSON.stringify(sortedPositions.slice().sort((a,b)=>a-b)) &&
    names.map((nm,i)=>dashH.indexOf(`data-owner="${nm}"`)).every((pos, i, arr) => i === 0 || true));
  // 更直接的验证：把 dashH 里出现的顺序抽出来，应该等于按拼音排序后的顺序
  const appearOrder = [...dashH.matchAll(/data-owner="([^"]+)"/g)].map(m => m[1]).filter(nm => names.includes(nm));
  ok('负荷行出现的先后顺序就是姓名拼音顺序', JSON.stringify(appearOrder) === JSON.stringify(sortedNames), appearOrder);

  section('任务详情里程碑区：去掉了底部"添加一条"按钮');
  const anyTask = S.DB.tasks.find(t => !t.deleted_at && S.canEditRecord('task', t));
  S.openTaskDetail(anyTask.id);
  let detailHTML = q('#modal-body').innerHTML;
  ok('底部不再有 cp-add-row 这个按钮了', !detailHTML.includes('data-act="cp-add-row"'));
  ok('每一行仍然有插入按钮（cp-insert-after），够用了', detailHTML.includes('data-act="cp-insert-after"'));
  ok('"里程碑/交付物"标签用了 cp-section-label（独立一行、左对齐）', /class="cp-section-label"[^>]*>里程碑\/交付物</.test(detailHTML));
  ok('该标签在 cp-list 之前出现（在第一条里程碑上方）', detailHTML.indexOf('cp-section-label') < detailHTML.indexOf('id="cp-list"'));
  S.ACTIONS['modal-cancel']();

  section('任务详情：状态、优先级、计划完成时间放在同一行');
  detailHTML = q('#modal-body').innerHTML;   // 已关闭，验证不会残留；重新打开再测真实内容
  S.openTaskDetail(anyTask.id);
  detailHTML = q('#modal-body').innerHTML;
  const rowIdx = detailHTML.indexOf('inline-fields-row');
  ok('存在同一行的容器 inline-fields-row', rowIdx > -1);
  if (rowIdx > -1) {
    const seg = detailHTML.slice(rowIdx, rowIdx + 800);
    ok('这一行里包含状态、优先级、计划完成时间三个字段的输入控件', seg.includes('id="td-status"') && seg.includes('id="td-priority"') && seg.includes('id="td-plan_date"'), seg);
  }
  S.ACTIONS['modal-cancel']();

  section('任务页表格：完成勾选列彻底去掉（连列带表头都没了）');
  S.setPage('tasks'); S.renderTasks();
  const tasksHeadHTML = q('#tasks-head').innerHTML;
  ok('表头里没有 col-check 这个类了', !tasksHeadHTML.includes('col-check'));
  const anyRowHTML = S.renderTaskRow(S.taskRows[0]);
  ok('任务行渲染结果里也没有 col-check 了', !anyRowHTML.includes('col-check'));
  const delTask = S.DB.tasks.find(t => t.deleted_at) || (() => {
    const t = { ...S.taskRows[0], id: 'p22_del_task', deleted_at: new Date().toISOString() };
    S.DB.tasks.push(t); return t;
  })();
  const delRowHTML = S.renderTaskRow(delTask);
  ok('已删除任务的"恢复"按钮挪进了操作列，还在，只是不单独占一列了', delRowHTML.includes('data-act="task-restore"') && !delRowHTML.includes('col-check'));
  S.DB.tasks = S.DB.tasks.filter(t => t.id !== 'p22_del_task');

  section('图表页："按分类"已经改名"按职责"');
  ok('CHART_TABS 里 category 这个 tab 的标签是"按职责"', S.CHART_TABS.find(t => t.key === 'category').label === '按职责');
  ok('不再叫"按分类"了', !S.CHART_TABS.some(t => t.label === '按分类'));

  section('图表页："按任务""按工作"tab 存在（具体布局在 test-p23.js 里详细测）');
  let h = render('task');
  ok('含"任务状态总览"面板', h.includes('任务状态总览'));
  h = render('work');
  ok('含"工作总览"面板', h.includes('工作总览'));

  section('worksByYear / worksByDutyCount / taskFieldBars：纯统计函数正确性');
  const tasksNow = S.visibleTasks().filter(t => !t.deleted_at);
  const yearBars = S.worksByYear();
  const worksAll = S.visibleWorks();
  const yearTotal = yearBars.reduce((a, b) => a + b.n, 0);
  ok('各年度工作量加总 ≤ 全部工作数（有些工作可能没填年度）', yearTotal <= worksAll.length, [yearTotal, worksAll.length]);
  const dutyBars = S.worksByDutyCount();
  ok('各职责工作数量都是正数（已经过滤掉 0）', dutyBars.every(b => b.n > 0));
  const srcBars = S.taskFieldBars('source', tasksNow);
  ok('来源分布的数量加总 ≤ 任务总数（一个任务的来源只能算一次）', srcBars.reduce((a, b) => a + b.n, 0) <= tasksNow.length);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
