/* P67：三项反馈——
   ① "交付物呈报层级分布"（报告页 msLevelPie 模块）改成全量口径，标出"全量 · 不随周期变化"
   ② "当期交付物层级统计"（deliveredMsLevelPie）看数据表时，除了汇总数量还要带上具体交付物清单
   ③ 图表页新增"人员工作矩阵"tab：职责→工作树状展开（复用"各职责/工作推进情况"那套折叠），
      列是人员，格子是"牵头×3 + 参与×1"的加权热力，数字是牵头+参与的任务总数，点格子能下钻
   用法：node test/test-p67.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();

  /* ================= ①：交付物呈报层级分布改全量 ================= */
  section('①：msLevelPie 模块改成 scope: all，报告页会标"全量·不随周期变化"');
  ok('★REPORT_MODULE_MAP.msLevelPie.scope === \'all\'', S.REPORT_MODULE_MAP.msLevelPie.scope === 'all');
  const headOut = S.reportModHead(S.REPORT_MODULE_MAP.msLevelPie, '');
  ok('★面板头里出现了"全量 · 不随周期变化"', headOut.includes('全量 · 不随周期变化'));

  section('①：口径确实变成了全量——一条早就完成、不在当期口径里的任务，它的里程碑层级也统计到了');
  await S.Repo.upsert('duty', { code: 'P67L', name: 'P67层级职责' });
  await S.Repo.upsert('work', { id: 'p67_lw', duty: 'P67L', code: 'W1', name: 'P67层级工作', owner: '张三', year: new Date().getFullYear() });
  await S.Repo.upsert('task', { id: 'p67_old_task', work: 'p67_lw', title: 'P67很久以前完成的任务', status: 'done',
    plan_date: S.offsetDate(-500), actual_date: S.offsetDate(-500), owner: '甲', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p67_old_ms', task: 'p67_old_task', deliverable: 'P67老交付物',
    plan_date: S.offsetDate(-500), actual_date: S.offsetDate(-500), done: '1', report_level: 'bank' });
  S.rebuildIndex();
  const dd = S.buildReportData('week', 0);
  ok('前置：这条任务确实不在当期口径里', !dd.periodTasks.some(t => t.id === 'p67_old_task'));
  const msLevelHtml = S.REPORT_MODULE_MAP.msLevelPie.html(dd);
  ok('★但饼图数据里已经统计到了它（行领导那一档 ≥ 1）', S.msReportLevelStats(dd.tasks).find(s => s.label === '行领导').n >= 1);
  ok('模块正文渲染不报错', msLevelHtml.includes('<svg') || msLevelHtml.includes('empty'));

  /* ================= ②：交付物层级统计模块的数据表带清单（P68 已把这块整个并进了「本期已交付
     里程碑」，不再用数据表切换、也不再是独立模块——完整覆盖见 test-p68.js） ================= */
  section('②：deliveredMsLevelPie 这个独立模块 key 已经不存在了（P68 并入 deliveredMs）');
  ok('★REPORT_MODULE_MAP 里没有 deliveredMsLevelPie 了', !S.REPORT_MODULE_MAP.deliveredMsLevelPie);

  /* ================= ③：图表页人员工作矩阵 ================= */
  section('③：CHART_TABS 里新增了"人员工作矩阵"');
  ok('★CHART_TABS 里有 matrix 这个 tab', S.CHART_TABS.some(t => t.key === 'matrix' && t.label === '人员工作矩阵'));

  section('③：personDutyWorkHeat —— 牵头权重是参与的 3 倍，职责行是名下所有工作的汇总');
  await S.Repo.upsert('duty', { code: 'P67M', name: 'P67矩阵职责' });
  await S.Repo.upsert('work', { id: 'p67_mw1', duty: 'P67M', code: 'W1', name: 'P67矩阵工作一', owner: '张三', year: new Date().getFullYear() });
  await S.Repo.upsert('work', { id: 'p67_mw2', duty: 'P67M', code: 'W2', name: 'P67矩阵工作二', owner: '张三', year: new Date().getFullYear() });
  await S.Repo.upsert('task', { id: 'p67_mt1', work: 'p67_mw1', title: 'P67矩阵任务1', status: 'doing', owner: '甲', assignees: [], plan_date: S.offsetDate(5) });
  await S.Repo.upsert('task', { id: 'p67_mt2', work: 'p67_mw1', title: 'P67矩阵任务2', status: 'doing', owner: '甲', assignees: ['丙'], plan_date: S.offsetDate(5) });
  await S.Repo.upsert('task', { id: 'p67_mt3', work: 'p67_mw1', title: 'P67矩阵任务3', status: 'doing', owner: '丙', assignees: ['甲'], plan_date: S.offsetDate(5) });
  await S.Repo.upsert('task', { id: 'p67_mt4', work: 'p67_mw2', title: 'P67矩阵任务4', status: 'doing', owner: '乙', assignees: [], plan_date: S.offsetDate(5) });
  S.rebuildIndex();
  const heat = S.personDutyWorkHeat(fixtureTasksWithId());
  const w1甲 = heat.workMap.get('p67_mw1').get('甲');
  ok('★工作一里"甲"：牵头 2、参与 1', w1甲.lead === 2 && w1甲.join === 1, w1甲);
  const w1丙 = heat.workMap.get('p67_mw1').get('丙');
  ok('工作一里"丙"：牵头 1、参与 1', w1丙.lead === 1 && w1丙.join === 1, w1丙);
  const w2乙 = heat.workMap.get('p67_mw2').get('乙');
  ok('工作二里"乙"：牵头 1、参与 0', w2乙.lead === 1 && w2乙.join === 0, w2乙);
  const duty甲 = heat.dutyMap.get('P67M').get('甲');
  ok('★职责行是名下所有工作的汇总——"甲"在职责层面还是牵头 2、参与 1（只出现在工作一）',
    duty甲.lead === 2 && duty甲.join === 1, duty甲);
  const duty乙 = heat.dutyMap.get('P67M').get('乙');
  ok('"乙"只在工作二出现，职责层面汇总后还是牵头 1、参与 0', duty乙.lead === 1 && duty乙.join === 0, duty乙);
  ok('★maxWeight 是全矩阵里最大的加权值（甲：2*3+1=7，全场最高）', heat.maxWeight === 7, heat.maxWeight);

  section('③：matrixHeatCellHTML —— 没有关系的格子留空、不可点；有关系的格子带数字和下钻属性');
  const emptyCell = S.matrixHeatCellHTML(heat.workMap.get('p67_mw1'), '丁', heat.maxWeight, ' data-work="p67_mw1" data-person="丁"');
  ok('★没有任何关系的人，格子是空的（matrix-cell-empty，不带 data-act）', emptyCell.includes('matrix-cell-empty') && !emptyCell.includes('data-act'));
  const filledCell = S.matrixHeatCellHTML(heat.workMap.get('p67_mw1'), '甲', heat.maxWeight, ' data-work="p67_mw1" data-person="甲"');
  ok('★有数据的格子显示数字 3（牵头2+参与1）', filledCell.includes('>3<'));
  ok('★带着可点击的 class 和 data-act', filledCell.includes('matrix-cell clickable') && filledCell.includes('data-act="matrix-cell-filter"'));
  ok('颜色深浅是全场最高（alpha 应该是 0.9，0.16+1*0.74）', filledCell.includes('rgba(44,95,138,0.90)'));

  section('③：personMatrixHTML —— 职责行默认折叠，展开后才看得到工作行');
  const collapsedHtml = S.personMatrixHTML(
    S.statsByDuty(fixtureTasksWithId()).filter(x => x.code === 'P67M'),
    S.statsByWork(fixtureTasksWithId()),
    ['甲', '乙', '丙'], heat, new Set(), 'chart-matrix-duty-toggle');
  ok('折叠状态下看不到"工作一/工作二"这两行的名字', !collapsedHtml.includes('P67矩阵工作一') && !collapsedHtml.includes('P67矩阵工作二'));
  const expandedHtml = S.personMatrixHTML(
    S.statsByDuty(fixtureTasksWithId()).filter(x => x.code === 'P67M'),
    S.statsByWork(fixtureTasksWithId()),
    ['甲', '乙', '丙'], heat, new Set(['P67M']), 'chart-matrix-duty-toggle');
  ok('★展开后能看到两行工作', expandedHtml.includes('P67矩阵工作一') && expandedHtml.includes('P67矩阵工作二'));

  section('③：展开/折叠 ACTIONS 真的会改状态');
  S.ACTIONS['chart-matrix-collapse-all']();
  ok('全部折叠后展开集合是空的', S.chartMatrixDutyExpanded.size === 0);
  S.ACTIONS['chart-matrix-duty-toggle']({ code: 'P67M' });
  ok('★点一次 toggle，P67M 进了展开集合', S.chartMatrixDutyExpanded.has('P67M'));
  S.ACTIONS['chart-matrix-duty-toggle']({ code: 'P67M' });
  ok('再点一次收回去', !S.chartMatrixDutyExpanded.has('P67M'));
  S.ACTIONS['chart-matrix-expand-all']();
  ok('★全部展开后，有任务的职责都进了展开集合（包含 P67M）', S.chartMatrixDutyExpanded.has('P67M'));

  section('③：matrix-cell-filter ACTIONS —— 职责级和工作级筛选条件不一样，且真的跳到了任务页');
  S.UI.tasks.filters = {}; S.UI.tasks.view = 'all';
  await S.ACTIONS['matrix-cell-filter']({ work: 'p67_mw1', person: '甲' });
  ok('★工作级点击：筛选带 work + _person', S.UI.tasks.filters.work === 'p67_mw1' && S.UI.tasks.filters._person === '甲');
  ok('落到了任务页', S.currentPage === 'tasks');
  S.UI.tasks.filters = {};
  await S.ACTIONS['matrix-cell-filter']({ duty: 'P67M', person: '乙' });
  ok('★职责级点击（没有 work）：筛选带 _duty + _person', S.UI.tasks.filters._duty === 'P67M' && S.UI.tasks.filters._person === '乙');

  section('③：★端到端——真的切到"人员工作矩阵"tab，页面上能看到矩阵表格和可点击的格子');
  S.goto('charts');
  S.ACTIONS['chart-tab']({ k: 'matrix' });
  const matrixPageHtml = q('#page-charts').innerHTML;
  ok('★页面上出现了矩阵表格', matrixPageHtml.includes('matrix-table'));
  ok('列头里有"甲"这个人', /<th>甲<\/th>/.test(matrixPageHtml));
  ok('★"甲"在 P67M 职责这一行有一个可点击的、带正确 data-duty/data-person 的格子',
    new RegExp('data-act="matrix-cell-filter" data-duty="P67M" data-person="甲"').test(matrixPageHtml));
  ok('状态栏文案带上了"人员工作矩阵"', q('#status-left').textContent.includes('人员工作矩阵'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
// personMatrixHTML 需要的 dutyStat/workStat 来自 statsByDuty/statsByWork，这两个函数是从 DB.tasks
// 里现读的——上面 personDutyWorkHeat 那组断言故意传的是不落库的裸对象（图快，不用挂 id/code），
// 这里另建一批真的落进 DB 的同名任务，专给 statsByDuty/statsByWork 用，两组数据字段一致，互不干扰
function fixtureTasksWithId() {
  return S.DB.tasks.filter(t => !t.deleted_at && (t.work === 'p67_mw1' || t.work === 'p67_mw2'));
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
