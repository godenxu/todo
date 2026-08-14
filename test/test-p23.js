/* P23：本轮改动测试——
   1) 工作台"人员负荷"长条同样修复了 0 值分段导致左侧留白的问题
   2) 任务详情弹窗对齐修复：里程碑标签真正靠左（之前 CSS 特异性不够没生效）；
      状态/优先级/计划完成时间三项等宽平分同一行，计划完成时间不再局促
   3) 图表页 tab 顺序：按职责挪到了按工作右边
   4) 图表页"按任务"重新设计：状态总览只留饼图+平均进度(SPI)同一行；
      新增计划完成时间分布、里程碑完成情况分布；优先级/来源/标签合并到同一行
   5) 图表页"按工作"重新设计：新增工作总览(饼图+SPI)；原样接入"各职责/工作推进情况"；
      各年度工作量/各职责工作数量合并到同一行
   用法：node test/test-p23.js */
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
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');

  // 工作台"人员负荷"模块（dashPeopleLoad）P82 这轮下线了（跟 personBars 内容重复，见
  // REPORT_MODULES 里 dashPeopleLoad 那段注释），这里验证的"0 值分段不渲染"是那份专属渲染
  // 自己的展示细节（同样的 0 值分段不渲染逻辑已经在 hBar() 里验证过，见 test-p15.js），
  // 模块本身都没了，这个小节不再适用

  section('任务详情弹窗对齐修复：里程碑标签的 CSS 选择器特异性够了，真的左对齐');
  ok('CSS 用的是 .detail-grid .cp-section-label（两个类，能盖过 .detail-grid label 的 text-align:right）',
    /\.detail-grid \.cp-section-label\s*\{[^}]*text-align:\s*left/.test(html));
  ok('不再是只有单类 .cp-section-label 这种盖不过基础规则的写法',
    !/(?<!\.detail-grid )\.cp-section-label\s*\{\s*display:\s*block;\s*text-align:\s*left;\s*\}/.test(html));

  section('任务详情弹窗对齐修复：状态/优先级/计划完成时间三项改成等宽 flex:1，不再是固定 96px');
  ok('.inline-field 用了 flex:1（三项平分整行）', /\.inline-field\s*\{[^}]*flex:\s*1/.test(html));
  ok('不再是写死的 96px 宽度', !/\.inline-field > div\s*\{\s*width:\s*96px/.test(html));
  ok('.inline-field > div 改成了 flex:1（计划完成时间的日期控件能拿到足够宽度）', /\.inline-field > div\s*\{[^}]*flex:\s*1/.test(html));

  const anyTask = S.DB.tasks.find(t => !t.deleted_at && S.canEditRecord('task', t));
  S.openTaskDetail(anyTask.id);
  const detailHTML = q('#modal-body').innerHTML;
  ok('里程碑/交付物标签确实用了 cp-section-label 类', /class="cp-section-label"[^>]*>里程碑\/交付物</.test(detailHTML));
  const rowIdx2 = detailHTML.indexOf('inline-fields-row');
  const seg2 = detailHTML.slice(rowIdx2, rowIdx2 + 800);
  ok('状态/优先级/计划完成时间三个控件都在同一个 inline-fields-row 里', seg2.includes('id="td-status"') && seg2.includes('id="td-priority"') && seg2.includes('id="td-plan_date"'));
  S.ACTIONS['modal-cancel']();

  section('图表页 tab 顺序：按职责在按工作右边');
  const tabKeys = S.CHART_TABS.map(t => t.key);
  const workIdx = tabKeys.indexOf('work'), categoryIdx = tabKeys.indexOf('category');
  ok('work 排在 category 前面（category 紧跟其后）', workIdx > -1 && categoryIdx === workIdx + 1, tabKeys);

  section('图表页"按任务"：状态总览只剩饼图，没有横条了，同一行右边有 SPI（比值，不是百分比）');
  const dutyCode2 = 'P23TASK';
  await S.Repo.upsert('duty', { code: dutyCode2, name: 'P23任务测试职责' });
  const wid2 = 'w_p23task';
  await S.Repo.upsert('work', { id: wid2, duty: dutyCode2, name: 'P23任务测试工作', owner: '测试管理员' });
  await S.Repo.upsert('task', { id: 'p23_t1', work: wid2, title: 'P23任务一', status: 'done', plan_date: S.offsetDate(-2), actual_date: S.todayStr(), progress: 100, priority: '1', source: 'P23来源甲', custom: 'P23标签甲', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('task', { id: 'p23_t2', work: wid2, title: 'P23任务二', status: 'doing', plan_date: S.offsetDate(20), progress: 40, priority: '2', source: 'P23来源乙', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p23_ms1', task: 'p23_t2', plan_date: S.offsetDate(5), deliverable: 'P23里程碑甲', report_level: 'section', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p23_ms2', task: 'p23_t2', plan_date: S.offsetDate(-10), deliverable: 'P23里程碑乙（逾期未完成）', report_level: 'section', done: '0' });
  let h = render('task');
  ok('"任务状态总览"面板里没有 bar-row（不再有横条）', !/任务状态总览[\s\S]{0,600}bar-row/.test(h));
  ok('"任务状态总览"面板里有饼图（svg）', /任务状态总览[\s\S]{0,600}<svg/.test(h));
  ok('同一行里出现了"SPI"这个统计卡片', /任务状态总览[\s\S]{0,2000}>SPI</.test(h));
  const tasksNow = S.visibleTasks().filter(t => !t.deleted_at);
  const expectedSPI = S.computeSPI(tasksNow);
  ok('SPI 是围绕 1 的比值（两位小数），不是百分比数字', expectedSPI !== null && h.includes(`>${expectedSPI.toFixed(2)}<`), expectedSPI);
  ok('SPI 数值本身不含 % 符号', !new RegExp(`>${expectedSPI.toFixed(2)}%<`).test(h));

  section('computeSPI：纯函数正确性');
  // created_at 存的是真实 ISO 时间戳（UTC），代码里会先用 localDay() 换算回本地日期再比。
  // 所以假数据不能写成"本地日期 + Z 后缀"那种四不像——那在 UTC 负偏移的机器上会差一天。
  // 这里老老实实构造 N 天前本地正午的那个真实时刻
  const isoDaysAgo = n => new Date(new Date().setHours(12, 0, 0, 0) - n * 86400000).toISOString();
  ok('全部任务都刚好卡在计划进度上时 SPI 接近 1', (() => {
    const t1 = { created_at: isoDaysAgo(10), plan_date: S.offsetDate(10), progress: 50 };
    // 创建到计划完成共 20 天，今天正好过了 10 天 => 计划进度 50%，跟实际进度一样 => SPI = 1
    return Math.abs(S.computeSPI([t1]) - 1) < 0.01;
  })());
  ok('实际进度超过计划进度时 SPI > 1（超前）', (() => {
    const t1 = { created_at: isoDaysAgo(10), plan_date: S.offsetDate(10), progress: 90 };
    return S.computeSPI([t1]) > 1;
  })());
  ok('实际进度落后计划进度时 SPI < 1（落后）', (() => {
    const t1 = { created_at: isoDaysAgo(10), plan_date: S.offsetDate(10), progress: 10 };
    return S.computeSPI([t1]) < 1;
  })());
  ok('没有计划完成时间的任务不参与计算（全部没有时返回 null）', S.computeSPI([{ created_at: S.todayStr(), plan_date: '', progress: 50 }]) === null);
  ok('已经过了计划完成时间的任务，计划进度按 100% 算', (() => {
    const t1 = { created_at: S.offsetDate(-30), plan_date: S.offsetDate(-1), progress: 100 };
    return Math.abs(S.computeSPI([t1]) - 1) < 0.01;
  })());

  section('图表页"按任务"：新增计划完成时间分布');
  ok('含"计划完成时间分布"面板', h.includes('计划完成时间分布'));

  /* P58 之后这三块又从"一个面板挤三栏"拆回了三个各自独立的面板（用户明确要求：这三个
     本来就是不同维度的分布，塞在一起除了省一点面板标题，看不出别的好处；拆开之后每个
     都能单独在报告页里挑选，还能用"同行"功能自己决定要不要并排）。
     在图表页上仍然并排展示（用 .rep-row 包起来），只是不再共用一个面板标题。 */
  section('图表页"按任务"：优先级/来源/标签拆成三个独立面板，并排放在同一行');
  ok('★三个各自独立的面板标题（不再合并成一个）', h.includes('▤ 优先级分布') && h.includes('▤ 任务来源分布') && h.includes('▤ 任务标签分布'));
  ok('三个面板用 .rep-row 包在同一行里', /class="rep-row"[\s\S]{0,200}▤ 优先级分布[\s\S]{0,2000}▤ 任务来源分布[\s\S]{0,2000}▤ 任务标签分布/.test(h));
  ok('来源"P23来源甲"和"P23来源乙"都出现了', h.includes('P23来源甲') && h.includes('P23来源乙'));
  ok('来源/标签用的是横向列表（bar-row/nm/track/num），不是独立的 barChart svg', h.includes('class="bar-row"'));

  section('图表页"按工作"：新增"工作总览"（饼图+同一行的 SPI）');
  h = render('work');
  ok('含"工作总览"面板，不再叫"工作状态分布"', h.includes('工作总览') && !h.includes('▤ 工作状态分布'));
  ok('"工作总览"里有饼图', /工作总览[\s\S]{0,600}<svg/.test(h));
  ok('"工作总览"同一行里也有"SPI"', /工作总览[\s\S]{0,2000}>SPI</.test(h));
  ok('"按工作"里的 SPI 统计口径也是全部任务（跟"按任务"页一致），数字应该相同',
    h.includes(`>${expectedSPI.toFixed(2)}<`), expectedSPI);

  // P58 之后同理拆成两个独立面板，并排放在同一行（理由跟"按任务"那三个一样）
  section('图表页"按工作"：各年度工作数量、各职责工作数量拆成两个独立面板，同一行并排');
  ok('★两个独立的面板标题', h.includes('▤ 各年度工作数量') && h.includes('▤ 各职责工作数量'));
  ok('不再合并成一个标题', !h.includes('各年度工作数量 / 各职责工作数量'));
  ok('不再叫"各年度工作量"', !h.includes('各年度工作量'));
  ok('两个面板用 .rep-row 包在同一行里', /class="rep-row"[\s\S]{0,200}▤ 各年度工作数量[\s\S]{0,2000}▤ 各职责工作数量/.test(h));

  section('图表页"按工作"：原样接入了"各职责/工作推进情况"');
  ok('含"各职责/工作推进情况"面板标题', h.includes('各职责/工作推进情况'));
  ok('有独立的展开/折叠全部入口（chart-duty-expand-all/collapse-all）',
    h.includes('data-act="chart-duty-expand-all"') && h.includes('data-act="chart-duty-collapse-all"'));
  ok('默认是折叠状态（没有 report-work-row 这种展开后才有的明细行）', !h.includes('report-work-row'));
  S.ACTIONS['chart-duty-expand-all']();
  h = q('#page-charts').innerHTML;
  ok('点了"全部展开"之后能看到工作明细行了', h.includes('report-work-row'));
  ok('展开状态里包含刚才新建的职责', S.chartDutyExpanded.has(dutyCode2));
  S.ACTIONS['chart-duty-collapse-all']();
  h = q('#page-charts').innerHTML;
  ok('点了"全部折叠"后明细行又没有了，且展开状态清空', !h.includes('report-work-row') && S.chartDutyExpanded.size === 0);
  ok('各职责工作数量也用了横向列表', h.includes('class="bar-row"'));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
