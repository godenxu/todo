/* P3 工作台测试。
   P80 起工作台整体改版：从"处室实时快照"改成"个人为主、按周期回看进展"，这份测试跟着重写，
   覆盖新结构：顶部统一周期条、"我的"区（全量层 2 个面板 + 周期层 3 个面板）、
   "处室概览"区（统计卡片 + 职责推进 + 人员负荷 + 最近动态，同样随周期变），
   以及处室/部门领导、管理员切换查看他人视角的权限门禁。
   用法：node test/test-p3.js */
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
// P80 第四版起"本期已完成/进行中/逾期/下期计划"四个模块改成任务/里程碑混排的一条条列表，
// 牵头/参与不再是"牵头完成"这种大标题小节，而是每一行自己的 .lvl 标签——找某个关键词
// 最近的一条 <div class="li"...>，取它自己的 .lvl 内容，就是这一条标的是"牵头"还是"参与"
const roleNearestBefore = (html, marker) => {
  // 每一条 li 里，marker 文字先出现在 title="..." 属性里（在 .lvl 标签之前），
  // 再出现在 <span class="t"> 正文里（在 .lvl 标签之后）——找第二次命中才是内容那次
  const firstIdx = html.indexOf(marker);
  if (firstIdx === -1) return null;
  const idx = html.indexOf(marker, firstIdx + 1);
  if (idx === -1) return null;
  const liStart = html.lastIndexOf('<div class="li"', idx);
  if (liStart === -1) return null;
  const seg = html.slice(liStart, idx);
  const m = seg.match(/class="lvl">([^<]*)</);
  return m ? m[1] : null;
};

async function main() {
  await tick(60);
  S.DB.settings.me = '测试管理员';
  S.setDashPeriod('week'); S.setDashOffset(0); S.setDashViewAsPerson('');

  section('工作台渲染：基本结构');
  let h = dashHTML();
  ok('渲染出内容', h.length > 2000, h.length);
  // P80 第三版起版式机制换成跟报告页一样的"同行/宽度倍数"（rep-row/rep-col），
  // 不再是工作台专属的 dash-grid 两栏
  ok('用报告页那套 rep-row/rep-col 排版机制', h.includes('rep-col'));
  ok('顶部有统一的周期条', h.includes('统计周期：') && h.includes('data-act="dash-period"') && h.includes('data-act="dash-period-nav"'));
  ok('"我的"区跟"处室概览"区都用 rep-region-title 分隔，标题清楚区分开', h.includes('我负责的工作与任务') && h.includes('处室概览'));
  const panels = (h.match(/panel-h/g) || []).length;
  // P80 第二版起工作台改成配置驱动：周期条(1) + 管理员能看到的"工作台编排"面板头(1，
  // 哪怕收起着也会渲染这一行) + 我的区默认 7 个模块 + 处室概览默认 5 个模块（P81 后期改版
  // dashOverviewCards 拆成 periodOverallScope/periodOverallStatus/periodOverallPlan 三个
  // 独立模块，处室概览从 4 个模块变成 6 个；P82 这轮 dashPeopleLoad 下线（跟 personBars 重复），
  // 6 个变成 5 个）= 1+1+7+5 = 14
  ok('十四个 panel-h（周期条 1 + 编排面板 1 + 我的 7 + 处室概览 5）', panels === 14, panels);
  ['我负责的工作与任务', '本期已完成', '我的里程碑时间线', '本期进行中', '本期逾期', '计划',
    '各职责/工作推进情况', '最近动态'].forEach(t => ok('含面板：' + t, h.includes(t)));
  ok('旧的"需要关注"分段面板已下线', !h.includes('需要关注') && !h.includes('data-act="dash-focus"'));
  ok('旧面板专用的 tl-row/tl-dot/tl-date 死代码没有卷土重来', !h.includes('tl-row') && !h.includes('tl-dot') && !h.includes('tl-date'));

  // ★ dashboardSections() 的 rows 是按 modules 数组的原始顺序切的（跟 reportSections() 一字
  // 不差），默认编排里"我的统计卡片"排最前、"我负责的工作与任务"排中间、"我的里程碑时间线"
  // 排最后——如果排序逻辑退化成"先画完两栏内容、独占一行的模块最后统一处理"，统计卡片就会被
  // 错误地排到里程碑时间线后面去，这里直接按下标顺序断言
  const idxCards = h.indexOf('我的统计卡片'), idxOpenTasks = h.indexOf('我负责的工作与任务');
  const idxTimeline = h.indexOf('我的里程碑时间线'), idxOverview = h.indexOf('处室概览');
  ok('★行序保持了模块在编排里的原始先后顺序（统计卡片→两栏内容→里程碑时间线→处室概览）',
    idxCards !== -1 && idxCards < idxOpenTasks && idxOpenTasks < idxTimeline && idxTimeline < idxOverview,
    { idxCards, idxOpenTasks, idxTimeline, idxOverview });

  section('统计卡片：处室概览 + "我的"区都用多卡片分组展示，随周期变化');
  const cardCount = (h.match(/class="card( clickable)?"/g) || []).length;
  // 我的·整体4张（牵头工作/在办任务/逾期任务/逾期里程碑）+ 我的·本期5张（完成任务/完成里程碑/进行中任务/进行中里程碑/SPI）
  // + 处室概览·本期涉及4张（涉及职责/工作/任务/里程碑）+ 处室概览·本期状态分布5张（已完成/进行中/逾期/未开始/SPI，
  // P81 后期改版去掉了"未指派"这张卡）+ 处室概览·本期计划开展3张（需推进任务/计划完成任务/计划完成里程碑）
  ok('二十一张统计卡片', cardCount === 21, cardCount);
  ['涉及职责', '涉及工作', '涉及任务', '涉及里程碑', '已完成', '进行中', '逾期', '未开始', 'SPI',
    '牵头工作', '在办任务', '逾期任务', '逾期里程碑', '完成任务', '完成里程碑', '进行中任务', '进行中里程碑',
    '需推进任务', '计划完成任务', '计划完成里程碑']
    .forEach(k => ok('含卡片：' + k, h.includes(`<div class="k">${k}</div>`)));
  ok('★"未指派"卡片已经去掉了（P81 后期改版）', !h.includes('<div class="k">未指派</div>'));
  ok('★"涉及职责"是分数格式（本期涉及数/处室职责总数），不是裸数字',
    /<div class="k">涉及职责<\/div><div class="v ">\d+<span class="frac-den">\/\d+<\/span><\/div>/.test(h));

  section('本期逾期/下期计划模块标题右侧不再堆多余提示文字（用户反馈"看着乱"）');
  const overdueHead = h.slice(h.indexOf('本期逾期'), h.indexOf('本期逾期') + 400);
  ok('★"本期逾期"标题右侧不再有"口径固定看现在"这句', !overdueHead.includes('口径固定看'));
  ok('★"本期逾期"标题右侧不再有"全量 · 不随周期变化"这句', !overdueHead.includes('全量 · 不随周期变化'));
  const nextPlanHead = h.slice(h.indexOf('下期计划'), h.indexOf('下期计划') + 400);
  ok('★"下期计划"标题右侧不再有"含正在推进中的"这句', !nextPlanHead.includes('含正在推进中的'));

  section('我的统计卡片：可点击下钻到任务页/工作页（用户反馈"卡片设置合不合理"顺带要求可点击）');
  ok('★"牵头工作"卡片可点，按牵头人筛到工作页', h.includes('data-act="report-filter-works" data-field="owner"'));
  ok('★"在办任务"/"进行中任务"卡片可点，按"相关"(牵头∪参与)筛到任务页-在办视图',
    (h.match(/data-act="dash-drill-tasks" data-view="open"/g) || []).length === 2);
  ok('★"逾期任务"卡片可点，筛到任务页-逾期视图', h.includes('data-act="dash-drill-tasks" data-view="overdue"'));
  ok('★"完成任务"卡片可点，筛到任务页-已完成视图', h.includes('data-act="dash-drill-tasks" data-view="done"'));
  const cardBlock = k => { const i = h.indexOf(`<div class="k">${k}</div>`); return h.slice(h.lastIndexOf('<div class="card', i), i); };
  ['逾期里程碑', '完成里程碑', '进行中里程碑', 'SPI'].forEach(k =>
    ok(`★"${k}"卡片不可点（没有对应的列表页承接这个数字）`, !cardBlock(k).includes('clickable') && !cardBlock(k).includes('data-act')));
  ['牵头工作', '在办任务', '逾期任务', '完成任务', '进行中任务'].forEach(k =>
    ok(`★"${k}"卡片是 clickable 样式`, cardBlock(k).includes('clickable')));

  section('下钻动作：点了"牵头工作"/"在办任务"卡片，真的能筛到正确的人和正确的任务');
  S.DB.settings.me = '测试管理员';
  await S.Repo.upsert('work', { id: 'p3_drill_w', duty: 'P3D', name: 'P3下钻测试工作', owner: '测试管理员' });
  await S.Repo.upsert('duty', { code: 'P3D', name: 'P3下钻职责' });
  await S.Repo.upsert('task', { id: 'p3_drill_open', work: 'p3_drill_w', title: 'P3下钻在办任务', status: 'doing', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('task', { id: 'p3_drill_overdue', work: 'p3_drill_w', title: 'P3下钻逾期任务', status: 'todo', owner: '别人丙', assignees: ['测试管理员'], plan_date: S.offsetDate(-3) });
  S.ACTIONS['report-filter-works']({ field: 'owner', val: '测试管理员' });
  ok('★点"牵头工作"跳到工作页并按 owner 筛中了这个人', S.currentPage === 'works' && S.UI.works.filters.owner === '测试管理员');
  let worksFiltered = S.query('work', { pool: S.visibleWorks(), filters: S.UI.works.filters });
  ok('★筛出来的工作里有这条', worksFiltered.some(w => w.id === 'p3_drill_w'));
  S.UI.works.filters = {};
  S.ACTIONS['dash-drill-tasks']({ view: 'open', person: '测试管理员' });
  ok('★点"在办任务"跳到任务页、视图=open、按相关人筛中了这个人',
    S.currentPage === 'tasks' && S.UI.tasks.view === 'open' && S.UI.tasks.filters._person === '测试管理员');
  let tasksFiltered = S.query('task', { pool: S.taskPoolFor('open').filter(S.TASK_VIEW_MAP.open.match), filters: S.UI.tasks.filters });
  ok('★牵头的在办任务在筛选结果里', tasksFiltered.some(t => t.id === 'p3_drill_open'));
  S.ACTIONS['dash-drill-tasks']({ view: 'overdue', person: '测试管理员' });
  ok('★点"逾期任务"跳到任务页、视图=overdue、按相关人筛中了这个人（参与也算，不是只筛牵头人）',
    S.currentPage === 'tasks' && S.UI.tasks.view === 'overdue' && S.UI.tasks.filters._person === '测试管理员');
  tasksFiltered = S.query('task', { pool: S.taskPoolFor('overdue').filter(S.TASK_VIEW_MAP.overdue.match), filters: S.UI.tasks.filters });
  ok('★只是参与（不是牵头）的逾期任务也在筛选结果里', tasksFiltered.some(t => t.id === 'p3_drill_overdue'));
  S.UI.tasks.filters = {}; S.UI.tasks.view = 'all';

  section('周期切换：换粒度/翻期会重新渲染，统计周期文案跟着变');
  const weekLabel = (h.match(/统计周期：([^（]+)（/) || [])[1];
  S.ACTIONS['dash-period']({ period: 'month' });
  h = q('#page-dashboard').innerHTML;
  ok('切到"按月"后 dashPeriod 变了', S.dashPeriod === 'month');
  const monthLabel = (h.match(/统计周期：([^（]+)（/) || [])[1];
  ok('统计周期文案也跟着变了（本周 → 本月）', weekLabel !== monthLabel, { weekLabel, monthLabel });
  S.ACTIONS['dash-period-nav']({ step: '-1' });
  ok('往前翻一期后 dashOffset 变成 -1', S.dashOffset === -1);
  h = q('#page-dashboard').innerHTML;
  ok('翻期后出现"回到本期"按钮', h.includes('回到本期'));
  S.ACTIONS['dash-period-nav']({ step: '0' });
  ok('点"回到本期"后 dashOffset 归零', S.dashOffset === 0);
  S.ACTIONS['dash-period']({ period: 'week' });
  ok('换粒度会把偏移归零（从"按月"切回"按周"不会停在上个粒度翻过的偏移上）', S.dashOffset === 0);

  section('"我的"区：全量层（我负责的工作与任务）不受周期影响，始终显示全部在办');
  await S.Repo.upsert('duty', { code: 'P3D', name: 'P3职责' });
  await S.Repo.upsert('work', { id: 'p3_w', duty: 'P3D', name: 'P3工作', owner: '测试管理员' });
  // 计划日期在很远的未来（超出"本周"范围），全量层照样要看得到
  await S.Repo.upsert('task', { id: 'p3_far', work: 'p3_w', title: 'P3远期任务', status: 'todo', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(200) });
  h = dashHTML();
  ok('全量层能看到计划日期远在本周之外的任务（不受周期筛选）', h.includes('P3远期任务'));

  section('"我的"区：周期层（本期已完成/本期进行中/下期计划）确实随周期变化');
  await S.Repo.upsert('task', { id: 'p3_done_thisweek', work: 'p3_w', title: 'P3本周完成任务', status: 'done', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(-1), actual_date: S.todayStr() });
  await S.Repo.upsert('task', { id: 'p3_due_thisweek', work: 'p3_w', title: 'P3本周到期未完成', status: 'todo', owner: '测试管理员', assignees: [], plan_date: S.todayStr() });
  h = dashHTML();
  ok('本期已完成里能看到本周完成的任务', h.includes('P3本周完成任务'));
  ok('本期进行中里能看到本周到期但没完成的任务', h.includes('P3本周到期未完成'));

  section('"我的"区：本期进行中不能只看"计划完成日恰好落在本期区间内"，欠账拖进本期的也要算（用户反馈）');
  const cardCountBefore = Number((h.slice(h.indexOf('我的统计卡片'), h.indexOf('我负责的工作与任务'))
    .match(/<div class="k">进行中任务<\/div>\s*<div class="v[^"]*">(\d+)</) || [])[1]);
  await S.Repo.upsert('task', {
    id: 'p3_overdue_carried', work: 'p3_w', title: 'P3欠账拖进本期的任务', status: 'todo',
    owner: '测试管理员', assignees: [], plan_date: S.offsetDate(-30),
  });
  await S.Repo.upsert('task', { id: 'p3_ms_carried_task', work: 'p3_w', title: 'P3欠账里程碑所在任务', status: 'doing', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p3_ms_carried', task: 'p3_ms_carried_task', plan_date: S.offsetDate(-30), deliverable: 'P3欠账交付物', done: '0' });
  h = dashHTML();
  const doingSectionHtml2 = (h.match(/本期进行中[\s\S]*?(?=<div class="panel[^"]*"[^>]*><div class="panel-h">)/) || [''])[0];
  ok('★计划完成日在本期开始之前、但至今还没做完的任务，也该出现在"本期进行中"里',
    doingSectionHtml2.includes('P3欠账拖进本期的任务'));
  ok('★同理，欠账未交付的里程碑（所在任务）也该出现', doingSectionHtml2.includes('P3欠账交付物'));
  const cardCountAfter = Number((h.slice(h.indexOf('我的统计卡片'), h.indexOf('我负责的工作与任务'))
    .match(/<div class="k">进行中任务<\/div>\s*<div class="v[^"]*">(\d+)</) || [])[1]);
  // p3_overdue_carried 自己有 plan_date，会让卡片计数 +1；p3_ms_carried_task 本身没填 plan_date，
  // 不计入任务计数（它是靠身上那条欠账里程碑才出现在列表里的，卡片数的是任务不是里程碑）
  ok('★"进行中任务"卡片计数精确加了 1（新增的欠账任务被算进去，不再被下限挡在外面）',
    cardCountAfter === cardCountBefore + 1, { cardCountBefore, cardCountAfter });

  section('"我的"区：本期已完成/本期进行中 任务与里程碑混排成一条条列表，按牵头/参与分组');
  await S.Repo.upsert('task', { id: 'p3_role_lead', work: 'p3_w', title: 'P3角色牵头完成任务', status: 'done', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(-1), actual_date: S.todayStr() });
  await S.Repo.upsert('task', { id: 'p3_role_join', work: 'p3_w', title: 'P3角色参与完成任务', status: 'done', owner: '别人R', assignees: ['测试管理员'], plan_date: S.offsetDate(-1), actual_date: S.todayStr() });
  await S.Repo.upsert('task', { id: 'p3_role_lead_mt', work: 'p3_w', title: 'P3角色牵头里程碑任务', status: 'doing', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p3_role_lead_ms', task: 'p3_role_lead_mt', plan_date: S.offsetDate(-1), deliverable: 'P3角色牵头交付物', done: '1', actual_date: S.todayStr() });
  await S.Repo.upsert('task', { id: 'p3_role_join_mt', work: 'p3_w', title: 'P3角色参与里程碑任务', status: 'doing', owner: '别人R2', assignees: ['测试管理员'] });
  await S.Repo.upsert('milestone', { id: 'p3_role_join_ms', task: 'p3_role_join_mt', plan_date: S.offsetDate(-1), deliverable: 'P3角色参与交付物', done: '1', actual_date: S.todayStr() });
  h = dashHTML();
  // "本期已完成"面板自己的一段 HTML：从"本期已完成"这行文字开始，到下一个 panel-h 出现为止
  const doneSectionHtml = (h.match(/本期已完成[\s\S]*?(?=<div class="panel[^"]*"[^>]*><div class="panel-h">)/) || [''])[0];
  const leadTaskIdx = doneSectionHtml.indexOf('P3角色牵头完成任务');
  const joinTaskIdx = doneSectionHtml.indexOf('P3角色参与完成任务');
  const leadMsIdx = doneSectionHtml.indexOf('P3角色牵头交付物');
  const joinMsIdx = doneSectionHtml.indexOf('P3角色参与交付物');
  ok('都能在"本期已完成"面板里找到', leadTaskIdx !== -1 && joinTaskIdx !== -1 && leadMsIdx !== -1 && joinMsIdx !== -1);
  // 先分组（牵头一块、参与一块）再按日期，牵头组两条（任务+里程碑）都该排在参与组两条前面
  ok('★牵头组排在参与组前面', Math.max(leadTaskIdx, leadMsIdx) < Math.min(joinTaskIdx, joinMsIdx));
  ok('★牵头完成的任务标的是"牵头"', roleNearestBefore(doneSectionHtml, 'P3角色牵头完成任务') === '牵头');
  ok('★参与完成的任务标的是"参与"', roleNearestBefore(doneSectionHtml, 'P3角色参与完成任务') === '参与');
  ok('★牵头交付的里程碑标的是"牵头"', roleNearestBefore(doneSectionHtml, 'P3角色牵头交付物') === '牵头');
  ok('★参与交付的里程碑标的是"参与"', roleNearestBefore(doneSectionHtml, 'P3角色参与交付物') === '参与');
  ok('里程碑那一条显示了交付物本身（不是只显示所属任务标题）', doneSectionHtml.includes('P3角色牵头交付物') && doneSectionHtml.includes('P3角色参与交付物'));
  ok('★点击整条走 cp-editor 直接弹任务详情，不是 focus-task 跳转任务页',
    doneSectionHtml.includes('data-act="cp-editor"') && !doneSectionHtml.includes('data-act="focus-task"'));
  ok('任务/里程碑各自有类型图标区分', doneSectionHtml.includes('📌') && doneSectionHtml.includes('◆'));

  section('"我的"区：同一条任务自己也完成、名下又有里程碑同期交付时，合并成一行，不重复出现');
  await S.Repo.upsert('task', { id: 'p3_dup_task', work: 'p3_w', title: 'P3重复合并测试任务', status: 'done', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(-1), actual_date: S.todayStr() });
  await S.Repo.upsert('milestone', { id: 'p3_dup_ms1', task: 'p3_dup_task', plan_date: S.offsetDate(-2), deliverable: 'P3重复测试交付物甲', done: '1', actual_date: S.todayStr() });
  await S.Repo.upsert('milestone', { id: 'p3_dup_ms2', task: 'p3_dup_task', plan_date: S.offsetDate(-1), deliverable: 'P3重复测试交付物乙', done: '1', actual_date: S.todayStr() });
  h = dashHTML();
  const dupSectionHtml = (h.match(/本期已完成[\s\S]*?(?=<div class="panel[^"]*"[^>]*><div class="panel-h">)/) || [''])[0];
  const dupTaskOccurrences = (dupSectionHtml.match(/data-id="p3_dup_task"/g) || []).length;
  ok('★同一条任务只出现一次 data-id（没有拆成任务一行、里程碑再各占一行）', dupTaskOccurrences === 1, dupTaskOccurrences);
  ok('这一行里任务标题和两个里程碑交付物都看得到', dupSectionHtml.includes('P3重复合并测试任务')
    && dupSectionHtml.includes('P3重复测试交付物甲') && dupSectionHtml.includes('P3重复测试交付物乙'));
  ok('两个交付物用顿号连在一起，不是各占一行', /P3重复测试交付物甲、P3重复测试交付物乙/.test(dupSectionHtml));

  section('"我的"区：任务本身不符合条件、只有它名下的里程碑符合时，也要能看到这条任务（用里程碑日期）');
  await S.Repo.upsert('task', { id: 'p3_msonly_task', work: 'p3_w', title: 'P3仅里程碑测试任务', status: 'doing', owner: '测试管理员', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p3_msonly_ms', task: 'p3_msonly_task', plan_date: S.offsetDate(-1), deliverable: 'P3仅里程碑测试交付物', done: '1', actual_date: S.todayStr() });
  h = dashHTML();
  const msOnlySectionHtml = (h.match(/本期已完成[\s\S]*?(?=<div class="panel[^"]*"[^>]*><div class="panel-h">)/) || [''])[0];
  ok('任务本身没完成（status 还是 doing），但名下交付的里程碑照样让这条任务出现在"本期已完成"里',
    msOnlySectionHtml.includes('P3仅里程碑测试任务') && msOnlySectionHtml.includes('P3仅里程碑测试交付物'));

  section('"我的"区：本期逾期——固定看"现在"，不随周期翻，也按牵头/参与拆分');
  await S.Repo.upsert('task', { id: 'p3_role_overdue', work: 'p3_w', title: 'P3角色逾期任务', status: 'todo', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(-5) });
  h = dashHTML();
  const overdueSectionHtml = (h.match(/本期逾期[\s\S]*?(?=<div class="panel[^"]*"[^>]*><div class="panel-h">)/) || [''])[0];
  ok('逾期任务出现在"本期逾期"面板里，标的是"牵头"', overdueSectionHtml.includes('P3角色逾期任务')
    && roleNearestBefore(overdueSectionHtml, 'P3角色逾期任务') === '牵头');
  S.ACTIONS['dash-period']({ period: 'month' });
  const hMonth = q('#page-dashboard').innerHTML;
  const overdueSectionMonth = (hMonth.match(/本期逾期[\s\S]*?(?=<div class="panel[^"]*"[^>]*><div class="panel-h">)/) || [''])[0];
  ok('切到"按月"之后，逾期任务照样在——这个面板的口径固定看"现在"，不随周期翻', overdueSectionMonth.includes('P3角色逾期任务'));
  S.ACTIONS['dash-period']({ period: 'week' });

  section('"我的"区：顶部统计卡片——SPI 用本期口径，跟"处室概览"的 SPI 是各自独立算的两个数');
  h = dashHTML();
  const mySpiCard = (h.match(/整体（不随周期）[\s\S]*?本期（[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/) || [''])[0];
  ok('"我的"卡片区块能取到（用于后续断言不为空）', mySpiCard.length > 0);
  ok('"我的"卡片里有 SPI 卡片', mySpiCard.includes('<div class="k">SPI</div>'));

  // "我的里程碑时间线"是全量层（不受周期筛选），会跟"下期计划"同时出现同样的关键词，
  // 所以下面这几条断言都得只看"下期计划"这一个面板自己的一段 HTML，不能看整页——
  // "下期计划"模块（dashMyNextPlan）在默认编排里排在"我的里程碑时间线"（独占整行）前面，
  // 用同一招：往后找到下一个 panel 起始为止
  const nextPlanScope = html2 => (html2.match(/▸ 下期计划[\s\S]*?(?=<div class="panel[^"]*"[^>]*><div class="panel-h">)/) || [''])[0];

  section('"我的"区：下期计划 P82 收紧口径——不再靠"状态是进行中"兜底，必须完成节点真落在下一期');
  await S.Repo.upsert('task', { id: 'p3_doing_far', work: 'p3_w', title: 'P3正在推进的远期任务', status: 'doing', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(200) });
  h = dashHTML();
  ok('★计划日期远在下一期之外的"进行中"任务，不再靠状态兜底拉进下期计划（这是这轮收紧的地方）',
    !nextPlanScope(h).includes('P3正在推进的远期任务'));

  const { start: nextWeekStart } = S.periodRange('week', 1);
  await S.Repo.upsert('task', { id: 'p3_next_plain', work: 'p3_w', title: 'P3无里程碑的下期任务', status: 'todo', owner: '测试管理员', assignees: [], plan_date: nextWeekStart });
  h = dashHTML();
  ok('没有里程碑的任务，看它自己的计划完成时间——落在下一期就该出现', nextPlanScope(h).includes('P3无里程碑的下期任务'));

  section('"我的"区：下期计划——有里程碑的任务看"最近一个未完成里程碑"的日期，不是任务自己的计划完成时间');
  await S.Repo.upsert('task', { id: 'p3_ms_task', work: 'p3_w', title: 'P3里程碑任务', status: 'todo', owner: '测试管理员', assignees: [], plan_date: S.offsetDate(200) });
  await S.Repo.upsert('milestone', { id: 'p3_ms_done1', task: 'p3_ms_task', plan_date: S.offsetDate(-10), deliverable: 'P3已完成里程碑', done: '1' });
  await S.Repo.upsert('milestone', { id: 'p3_ms_active', task: 'p3_ms_task', plan_date: nextWeekStart, deliverable: 'P3正在推进的里程碑', done: '0' });
  await S.Repo.upsert('milestone', { id: 'p3_ms_future', task: 'p3_ms_task', plan_date: S.offsetDate(190), deliverable: 'P3更靠后的里程碑', done: '0' });
  ok('nextMilestoneMap 只把"排在最前面的未完成"标记成这条任务的"最近一个"', (() => {
    const m = S.nextMilestoneMap().get('p3_ms_task');
    return !!m && m.id === 'p3_ms_active';
  })());
  h = dashHTML();
  const nextPlanHtml = nextPlanScope(h);
  // 任务自己的计划完成时间是 offsetDate(200)，远在下一期之外——如果还是看任务自己的日期，
  // 这条任务根本不会出现在下期计划里；能看到，说明确实是"最近一个未完成里程碑"的日期
  // （nextWeekStart，落在下一期）在起作用
  ok('下期计划的列表里能看到这条任务（靠里程碑日期落进下一期，不是任务自己那个远期日期）', nextPlanHtml.includes('P3里程碑任务'));
  ok('下期计划的列表里能看到正在推进的那个里程碑的交付物', nextPlanHtml.includes('P3正在推进的里程碑'));
  ok('排在它后面、还没轮到的里程碑不会因为"是同一条任务的里程碑"被一起拉进下期计划', !nextPlanHtml.includes('P3更靠后的里程碑'));

  section('处室/部门领导、管理员切换查看他人视角');
  ok('管理员默认就有 view_others_dashboard', S.hasPermission('view_others_dashboard'));
  h = dashHTML();
  ok('有权限的人能看到"查看"下拉', h.includes('data-act="dash-view-as"'));
  await S.Repo.upsert('duty', { code: 'P3D2', name: 'P3职责2' });
  await S.Repo.upsert('work', { id: 'p3_w2', duty: 'P3D2', name: 'P3工作2', owner: '李四P3' });
  await S.Repo.upsert('task', { id: 'p3_li4_task', work: 'p3_w2', title: 'P3李四的任务', status: 'todo', owner: '李四P3', assignees: [], plan_date: S.offsetDate(3) });
  S.ACTIONS['dash-view-as']({}, { value: '李四P3' });
  h = q('#page-dashboard').innerHTML;
  // P80 第二版起模块化，标题不再随查看的人动态改写成"XX 的工作台"（区域标题是 admin
  // 编排的固定文案），"查看"下拉框自己选中哪个人就是可见的身份指示——直接断言下拉框
  // 选中值和实际内容变了，而不是断言一个已经不存在的动态标题字符串
  ok('"查看"下拉选中了李四P3', /<option value="李四P3" selected>/.test(h));
  ok('能看到李四的任务，而不是测试管理员自己的', h.includes('P3李四的任务'));
  S.ACTIONS['dash-view-as']({}, { value: '' });
  h = q('#page-dashboard').innerHTML;
  ok('切回本人后 dashViewAsPerson 归空', S.dashViewAsPerson === '');
  ok('切回本人后看不到李四的任务了', !h.includes('P3李四的任务'));

  section('普通员工没有 view_others_dashboard，看不到"查看"下拉，也切不了');
  S.DB.users.push({ name: '测试员工-P3', role: 'staff', salt: '', hash: '', iterations: 0 });
  const bakMe = S.DB.settings.me;
  S.DB.settings.me = '测试员工-P3';
  h = dashHTML();
  ok('员工看不到"查看"下拉', !h.includes('data-act="dash-view-as"'));
  S.ACTIONS['dash-view-as']({}, { value: '李四P3' });
  ok('直接调用 action 也不会生效（权限门禁在处理函数里也查了一遍）', S.dashViewAsPerson === '');
  S.DB.settings.me = bakMe;

  section('各职责/工作推进情况：堆叠条渲染，比例合法');
  h = dashHTML();
  ok('堆叠条渲染', h.includes('bar-row clickable'));
  ok('可下钻到职责', h.includes('data-act="duty-drill"'));
  const bars = [...h.matchAll(/<span class="track">([\s\S]*?)<\/span>\s*<span class="num">/g)];
  const widthsOk = bars.every(b => {
    const ws = [...b[1].matchAll(/width:([\d.]+)%/g)].map(m => +m[1]);
    return ws.reduce((a, c) => a + c, 0) <= 100.05;
  });
  ok('堆叠段宽合计 ≤ 100%', widthsOk, bars.length);
  ok('图例含四种状态', h.includes('未开始') && h.includes('已完成') && h.includes('进行中') && h.includes('逾期'));

  section('filter-person：按人筛选跳任务页这个通用 action（原来在"人员负荷"模块，现在 personBars 也用它）');
  // 工作台"人员负荷"模块（dashPeopleLoad）P82 这轮下线了（跟 personBars 内容重复，见
  // REPORT_MODULES 里 dashPeopleLoad 那段注释）——渲染层面的断言（load-row/负荷条宽度/
  // 参与人是否出现在这份专属列表里）不再适用；filter-person 这个 action 是通用的，
  // 继续直接验证 action 本身还工作正常
  await S.Repo.upsert('task', {
    id: 'p3_load_union', code: 'P3L01', title: 'P3人员负荷口径验证', status: 'doing',
    owner: 'P3负荷牵头甲', assignees: ['P3负荷参与乙'], plan_date: S.offsetDate(3),
  });
  S.ACTIONS['filter-person']({ person: 'P3负荷牵头甲' });
  ok('筛选跳到任务页', S.currentPage === 'tasks' && S.UI.tasks.filters._person === 'P3负荷牵头甲');
  let filtered = S.query('task', { pool: S.visibleTasks().filter(t => !t.deleted_at), filters: S.UI.tasks.filters });
  ok('按牵头人筛能筛到这条任务', filtered.some(t => t.id === 'p3_load_union'));
  S.ACTIONS['filter-person']({ person: 'P3负荷参与乙' });
  filtered = S.query('task', { pool: S.visibleTasks().filter(t => !t.deleted_at), filters: S.UI.tasks.filters });
  ok('按参与人筛也能筛到同一条任务', filtered.some(t => t.id === 'p3_load_union'));
  S.UI.tasks.filters = {};

  section('最近动态：不随周期变化');
  h = dashHTML();
  // P80 第二版起复用报告页的 recentActivity 模块——正文自己只画 <div class="feed">，
  // 外层 <div class="panel-b"> 是 dashboardPanelHTML 通用包的，不再是同一个 class 属性
  ok('动态列表渲染', h.includes('class="feed"'));
  ok('显示修改人', h.includes('class="who"'));
  ok('显示相对时间', /class="when">[^<]+</.test(h));
  const feedAtWeek = h.match(/class="panel-b feed">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/);
  S.ACTIONS['dash-period']({ period: 'year' });
  const hYear = q('#page-dashboard').innerHTML;
  const whoListWeek = [...h.matchAll(/class="who">([^<]*)</g)].map(m => m[1]);
  const whoListYear = [...hYear.matchAll(/class="who">([^<]*)</g)].map(m => m[1]);
  ok('换了统计周期，最近动态列表内容不变（不是按周期口径筛的）', JSON.stringify(whoListWeek) === JSON.stringify(whoListYear));
  S.ACTIONS['dash-period']({ period: 'week' });

  section('未设置使用者时的引导文案');
  S.DB.settings.me = '';
  h = dashHTML();
  ok('未设使用者时"我的"区给出引导', h.includes('尚未设置本机使用者'));
  S.DB.settings.me = '测试管理员';

  section('工作台编排（P80 第二版）：区域/模块的增删改排序，跟报告页那套是同一份写法');
  ok('★config_dashboard 权限项存在，在"操作"组，且是独立于 config_report 的一个点',
    S.PERMISSIONS.some(p => p.key === 'config_dashboard' && p.group === '操作') && S.PERMISSIONS.some(p => p.key === 'config_report'));
  ok('★四个角色默认全部关闭（等于只有管理员能改）',
    ['staff', 'comanager', 'director', 'gm'].every(r => S.DEFAULT_PERMISSION_MATRIX[r].config_dashboard === false));
  ok('管理员有这个权限', S.hasPermission('config_dashboard'));
  ok('默认两段：我的 / 处室概览', raw.dashboardSections().map(s => s.title).join('|') === '我的|处室概览');

  S.ACTIONS['dash-sec-add']();
  q('#prompt-input').value = 'P3新区域';
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★添加区域生效了', raw.dashboardSections().length === 3 && raw.dashboardSections()[2].title === 'P3新区域');
  ok('新区域默认不含任何模块', raw.dashboardSections()[2].modules.length === 0);
  ok('配置真的写进了 DB.dashboardConfig（会随共享文件同步给全处）', !!S.DB.dashboardConfig && S.DB.dashboardConfig.rev >= 1);
  ok('记了是谁改的', S.DB.dashboardConfig.updated_by === '测试管理员');

  const newSecId = raw.dashboardSections()[2].id;
  await S.ACTIONS['dash-mod-add']({ sec: newSecId, mod: 'doneTasks' });
  await tick(20);
  ok('★添加模块生效，默认 1 倍宽度、独占一行、按整体口径', raw.dashboardSections()[2].modules.includes('doneTasks')
    && raw.dashboardSections()[2].rows.length === 1 && raw.dashboardSections()[2].rows[0].join(',') === 'doneTasks'
    && raw.dashboardSections()[2].personScope.doneTasks === 'all');

  // 加第二个模块再设"同行"，验证跟报告页一样的排版机制：宽度倍数 + 同行 + 上下移动
  await S.ACTIONS['dash-mod-add']({ sec: newSecId, mod: 'highPriority' });
  await tick(20);
  ok('第二个模块默认自己另起一行', raw.dashboardSections()[2].rows.length === 2);
  await S.ACTIONS['dash-mod-inline']({ sec: newSecId, mod: 'highPriority' });
  await tick(20);
  ok('★"同行"生效，两个模块并到同一行', raw.dashboardSections()[2].rows.length === 1
    && raw.dashboardSections()[2].rows[0].join(',') === 'doneTasks,highPriority');
  await S.ACTIONS['dash-mod-width']({ sec: newSecId, mod: 'highPriority' }, { value: '2' });
  await tick(20);
  ok('★宽度倍数生效', raw.dashboardSections()[2].widths.highPriority === 2);
  await S.ACTIONS['dash-mod-move']({ sec: newSecId, mod: 'highPriority', step: '-1' });
  await tick(20);
  ok('★上下移动生效（highPriority 挪到第一个，同行标记跟着清掉，因为第一个模块没有"上一个"可跟）',
    raw.dashboardSections()[2].modules[0] === 'highPriority' && raw.dashboardSections()[2].rows.length === 2);

  // doneTasks 是"要么整体要么按人都说得通"的 either 模块，切按人应该真的能切过去
  ok('doneTasks 的 personAware 是 either（这条断言不成立的话下面这条切换测试就没意义）', S.REPORT_MODULE_MAP['doneTasks'].personAware === 'either');
  await S.ACTIONS['dash-mod-scope']({ sec: newSecId, mod: 'doneTasks' }, { value: 'self' });
  await tick(20);
  ok('★either 模块的"按人/按整体"切换真的生效', raw.dashboardSections()[2].personScope.doneTasks === 'self');

  // onlyAll 模块（比如 recentActivity）哪怕硬塞一个 personScope:'self' 进配置，渲染时也要被拗回 'all'
  await S.saveDashboardConfig(cfg => {
    const sec = S.dashboardPresetIn(cfg).sections.find(s => s.id === newSecId);
    sec.modules.push('recentActivity');
    sec.personScope = { ...(sec.personScope || {}), recentActivity: 'self' };
  });
  await tick(20);
  ok('★onlyAll 模块不受配置里脏值摆布，运行时强制按整体', S.dashNormalizePersonScope('recentActivity', 'self') === 'all');

  await S.ACTIONS['dash-mod-remove']({ sec: newSecId, mod: 'doneTasks' });
  await S.ACTIONS['dash-mod-remove']({ sec: newSecId, mod: 'highPriority' });
  await S.ACTIONS['dash-mod-remove']({ sec: newSecId, mod: 'recentActivity' });
  await tick(20);
  ok('移除模块也生效', raw.dashboardSections()[2].modules.length === 0);

  await S.ACTIONS['dash-sec-move']({ id: newSecId, step: '-1' });
  await tick(20);
  ok('★上移生效（从第 3 位挪到第 2 位）', raw.dashboardSections()[1].id === newSecId);

  S.ACTIONS['dash-sec-rename']({ id: newSecId });
  q('#prompt-input').value = 'P3改过名的区域';
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('改名生效', raw.dashboardSections()[1].title === 'P3改过名的区域');

  S.ACTIONS['dash-sec-del']({ id: newSecId });
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★删除区域生效，回到两段', raw.dashboardSections().length === 2);
  ok('删区域不动任何业务数据', S.DB.tasks.some(t => t.id === 'p3_far'));

  section('工作台编排：存档');
  S.ACTIONS['dash-preset-new']();
  q('#prompt-input').value = 'P3精简版';
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★多了一套存档', S.dashboardPresets().length === 2);
  ok('切换到了新存档', S.activeDashboardPreset().name === 'P3精简版');
  const defDashId = S.dashboardPresets().find(p => p.name === S.DASHBOARD_DEFAULT_PRESET_NAME || p.name === '默认编排').id;
  await S.ACTIONS['dash-preset-switch']({}, { value: defDashId });
  await tick(20);
  ok('切回默认存档', S.activeDashboardPreset().id === defDashId);
  ok('页面跟着切回默认编排', raw.dashboardSections()[0].title === '我的');

  S.ACTIONS['dash-preset-del']();
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★删除存档生效，剩下的那套自动成为当前存档', S.dashboardPresets().length === 1 && S.activeDashboardPreset().name === 'P3精简版');
  S.setSnackPriorityUntil(0); q('#snack-msg').textContent = '';
  S.ACTIONS['dash-preset-del']();
  ok('★最后一套不让删', q('#snack-msg').textContent.includes('至少要留一套') && S.dashboardPresets().length === 1);

  section('工作台编排：恢复默认编排');
  await S.ACTIONS['dash-mod-add']({ sec: raw.dashboardSections()[0].id, mod: 'doneTasks' });
  await tick(20);
  ok('先故意改乱一点', raw.dashboardSections()[0].modules.includes('doneTasks'));
  S.ACTIONS['dash-config-reset']();
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★恢复默认后回到"我的/处室概览"两段', raw.dashboardSections().map(s => s.title).join('|') === '我的|处室概览');
  ok('第一段的模块也还原了', raw.dashboardSections()[0].modules.join(',')
    === 'dashMyCards,dashMyOpenTasks,dashMyDoneSplit,dashMyDoingSplit,dashMyOverdueSplit,dashMyNextPlan,dashMyMsTimeline');

  section('工作台编排：权限门禁 —— 没有 config_dashboard 的人改不了，但工作台本身照样看得见');
  S.DB.users.push({ name: 'P3处室领导', role: 'director', salt: '', hash: '', iterations: 0 });
  const bakMeCfg = S.DB.settings.me;
  S.DB.settings.me = 'P3处室领导';
  S.DB.permissionMatrix = null;
  ok('处室领导默认没有这个权限', !S.hasPermission('config_dashboard'));
  h = dashHTML();
  ok('★没权限的人看不到"工作台编排"面板', !h.includes('data-act="dash-sec-add"'));
  ok('但工作台本身照样看得见（只是改不了编排）', h.includes('我负责的工作与任务'));
  const secsBefore = raw.dashboardSections().length;
  const dashCfgBefore = S.DB.dashboardConfig;
  S.ACTIONS['dash-sec-add']();
  // 权限门禁在 requirePermission 那一步就拦下了，根本没走到 promptModal，
  // 用配置对象引用没变（不是"deep equal"，是"根本没被 saveDashboardConfig 碰过"）来判定
  ok('★没权限时直接调用 action 也加不了区域', raw.dashboardSections().length === secsBefore && S.DB.dashboardConfig === dashCfgBefore);
  S.DB.settings.me = bakMeCfg;
  S.DB.permissionMatrix = null;

  section('边界：空数据不炸');
  const bak = { d: S.DB.duties, w: S.DB.works, m: S.DB.milestones, t: S.DB.tasks };
  S.DB.duties = []; S.DB.works = []; S.DB.milestones = []; S.DB.tasks = [];
  let crashed = false;
  try { h = dashHTML(); } catch (e) { crashed = true; console.log('    异常：' + e.message); }
  ok('全空时工作台不报错', !crashed);
  S.DB.duties = bak.d; S.DB.works = bak.w; S.DB.milestones = bak.m; S.DB.tasks = bak.t;

  section('回归：P1/P2 未被破坏');
  S.setPage('tasks'); S.renderTasks();
  ok('任务页仍正常', S.taskRows.length > 0, S.taskRows.length);
  ok('两级树仍工作', /data-act="tree-pick"/.test(S.renderTaskTree(S.taskRows)));
  S.ACTIONS['sel-all']();
  ok('批量选择仍工作', S.UI.tasks.sel.size === S.taskRows.length);
  S.ACTIONS['sel-clear']();
  ok('CSV 表头仍完整', S.csvHeaders('task').includes('code'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
