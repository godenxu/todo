/* P55：本轮四项改动测试——
   ① 左下角恢复著作权信息（著作权 + 版本号都要，只去掉中间的存储方式那一行）
   ② 合并熔断误报修复：只统计"新鲜"的删除，旧缓存追平不再触发红色告警
   ③ 无主里程碑改为可彻底删除（连墓碑一起留），不再只是软删除留在文件里占体积
   ④ 报告页粒度按钮（按周/按月/按季/按年）与翻期按钮包进同一个容器，紧挨着
   ⑤ 报告页改成「区域 + 模块」可配置编排，带存档、权限、向后兼容
   用法：node test/test-p55.js */
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

async function main() {
  await tick(60);
  // 跟 harness 读同一份文件：验证"改之前会失败"时要把 index.html 换成回退版跑一遍，
  // 源码字符串类的断言必须跟着看回退版，否则它们会假过
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const bakMatrix = S.DB.permissionMatrix ? JSON.parse(JSON.stringify(S.DB.permissionMatrix)) : null;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.permissionMatrix = bakMatrix;
    S.DB.reportConfig = null;
    S.setFileHandle(null);
  };

  /* ====================== ① 左下角著作权 ====================== */
  section('①：左下角著作权信息和版本号都在，中间那行"存储：xxx"没了');
  S.DB.settings.me = '测试管理员';
  S.goto('tasks');
  const sb = q('#sidebar').innerHTML;
  ok('★著作权信息回来了', sb.includes('科技规划处') && sb.includes('徐捷'));
  ok('★版本号也在', sb.includes(S.APP_VERSION));
  ok('存储方式那一行仍然是去掉的（实现细节，对使用者没意义）', !sb.includes('存储：'));
  ok('两者在同一个 .sb-copyright 块里，不是各写各的', /class="sb-copyright"[^>]*>[\s\S]{0,200}徐捷[\s\S]{0,200}v\d/.test(sb));

  /* ====================== ② 合并熔断只看新鲜删除 ====================== */
  section('②：mergeDamageSince —— 基准线取"上次对账时间"和"24 小时前"里更晚的那个');
  const now = Date.parse('2026-08-04T12:00:00.000Z');
  const bakSyncAt = S.DB.settings.lastSyncAt;
  S.DB.settings.lastSyncAt = '2026-08-04T11:55:00.000Z';   // 5 分钟前刚同步过
  ok('天天在用的人：窗口就是上次同步那一刻（几分钟）', S.mergeDamageSince(S.DB, now) === '2026-08-04T11:55:00.000Z');
  S.DB.settings.lastSyncAt = '2026-05-01T00:00:00.000Z';   // 三个月没开过
  ok('★久违重连的人：基准线被 24 小时封顶，不会把三个月的历史删除全算进来',
    S.mergeDamageSince(S.DB, now) === new Date(now - S.MERGE_DAMAGE_MAX_WINDOW_MS).toISOString(),
    S.mergeDamageSince(S.DB, now));
  S.DB.settings.lastSyncAt = '';
  ok('从来没同步过（没有 lastSyncAt）：同样退到 24 小时窗口，不是无限往回追',
    S.mergeDamageSince(S.DB, now) === new Date(now - S.MERGE_DAMAGE_MAX_WINDOW_MS).toISOString());
  ok('窗口常量就是 24 小时', S.MERGE_DAMAGE_MAX_WINDOW_MS === 24 * 60 * 60 * 1000);

  section('②：真实场景复现 —— 旧缓存追平大批历史删除，不该再报"这批改动删除了 XXX 条"');
  // 本机缓存停在几个月前：这 30 条任务在它眼里都还活着
  const staleLocalTasks = Array.from({ length: 30 }, (_, i) => ({ id: 'p55_old_' + i, title: '老任务' + i, rev: 1, updated_at: '2026-04-01T00:00:00.000Z' }));
  // 共享文件里它们早就被正常删掉了（删除时间散落在过去几个月）
  const remoteDeleted = staleLocalTasks.map((t, i) => Object.assign({}, t, {
    rev: 2, deleted_at: `2026-0${(i % 3) + 4}-1${i % 9}T08:00:00.000Z`, updated_at: `2026-0${(i % 3) + 4}-1${i % 9}T08:00:00.000Z`,
  }));
  const localPayload = { tasks: staleLocalTasks, milestones: [], works: [], duties: [], users: [], purged: [] };
  const mergedPayload = { tasks: remoteDeleted, milestones: [], works: [], duties: [], users: [], purged: [] };
  const since = new Date(now - S.MERGE_DAMAGE_MAX_WINDOW_MS).toISOString();
  const catchUp = S.mergeDamageReport(localPayload, mergedPayload, since);
  ok('★追平历史删除算出来是 0 条"破坏"（改之前这里是 30，正好越过 15 条的熔断线）', catchUp.total === 0, catchUp);
  ok('低于熔断线，不会弹告警', catchUp.total <= S.MERGE_DAMAGE_LIMIT);

  section('②：真事故仍然抓得住 —— 刚刚发生的批量删除照样报');
  const freshDeleted = staleLocalTasks.map(t => Object.assign({}, t, {
    rev: 2, deleted_at: '2026-08-04T11:58:00.000Z', updated_at: '2026-08-04T11:58:00.000Z',
  }));
  const accident = S.mergeDamageReport(localPayload, { tasks: freshDeleted, milestones: [], works: [], duties: [], users: [], purged: [] }, since);
  ok('★两分钟前一次性删掉的 30 条，全部算进破坏统计', accident.total === 30, accident);
  ok('确实超过熔断线，会触发留底 + 告警', accident.total > S.MERGE_DAMAGE_LIMIT);

  section('②：整条记录消失（被彻底删除）按墓碑时间判新鲜度');
  const purgedOld = { tasks: [], milestones: [], works: [], duties: [], users: [],
    purged: staleLocalTasks.map(t => ({ entity: 'task', id: t.id, at: '2026-05-01T00:00:00.000Z' })) };
  ok('几个月前彻底删掉的，不算这次同步的破坏', S.mergeDamageReport(localPayload, purgedOld, since).total === 0);
  const purgedNew = { tasks: [], milestones: [], works: [], duties: [], users: [],
    purged: staleLocalTasks.map(t => ({ entity: 'task', id: t.id, at: '2026-08-04T11:58:00.000Z' })) };
  ok('刚刚彻底删掉的，照样算', S.mergeDamageReport(localPayload, purgedNew, since).total === 30);
  const noTomb = { tasks: [], milestones: [], works: [], duties: [], users: [], purged: [] };
  ok('★查不到墓碑的凭空消失，宁可报出来也不静悄悄放过', S.mergeDamageReport(localPayload, noTomb, since).total === 30);
  S.DB.settings.lastSyncAt = bakSyncAt;

  /* ====================== ③ 残留里程碑要删干净 ====================== */
  section('③：无主里程碑 —— 已软删除的那些也要算进来（它们才是撑大 JSON 的主力）');
  S.DB.duties = []; S.DB.works = []; S.DB.tasks = []; S.DB.milestones = []; S.DB.purged = [];
  S.rebuildIndex();
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: 'a', name: 'P55职责' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'p55_w', duty: '01', code: 'W1', name: 'P55工作', owner: '测试管理员' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'p55_t', work: 'p55_w', title: 'P55活着的任务', status: 'doing', owner: '测试管理员' }))];
  S.DB.milestones = [
    S.stampMeta(S.blank('milestone', { id: 'p55_ms_ok', task: 'p55_t', plan_date: '2026-09-01', deliverable: '正常里程碑', done: '0' })),
    S.stampMeta(S.blank('milestone', { id: 'p55_ms_orphan', task: 't_根本不存在', plan_date: '2026-09-02', deliverable: '无主里程碑', done: '0' })),
    // 历史遗留：早就被体检软删除过，但记录还原样躺在共享文件里
    S.stampMeta(S.blank('milestone', { id: 'p55_ms_orphan_del', task: 't_根本不存在', plan_date: '2026-09-03', deliverable: '早就软删过的无主里程碑', done: '0', deleted_at: '2026-01-01T00:00:00.000Z' })),
  ];
  S.rebuildIndex();
  let hc = S.healthCheck();
  const orphanIssue = hc.issues.find(i => i.k === 'orphanMs');
  ok('体检检出无主里程碑', !!orphanIssue);
  ok('★已软删除的那条也算进来了（共 2 个，不是 1 个）', orphanIssue && orphanIssue.n === 2, orphanIssue && orphanIssue.n);
  ok('挂在活着的任务下的那条不受牵连', !hc.orphanMs.some(m => m.id === 'p55_ms_ok'));
  ok('★给的是"彻底删除"而不是"软删除"（软删除对这一类没有任何意义）',
    orphanIssue && !orphanIssue.fix && /彻底删除/.test(orphanIssue.purgeFix || ''), orphanIssue);
  ok('明细里标出了哪些是已删除的，方便动手前核对',
    (orphanIssue.items || []).some(it => it.label.includes('已删除')));

  section('③：没连共享文件夹时拒绝彻底清理（本机数据可能不全，会误判）');
  S.setFileHandle(null);
  S.setSnackPriorityUntil(0); q('#snack-msg').textContent = '';
  await S.purgeHealth('orphanMs');
  ok('★被挡下并说明原因', q('#snack-msg').textContent.includes('请先连接共享文件夹'), q('#snack-msg').textContent);
  ok('一条都没被删', S.DB.milestones.length === 3);

  section('③：连上之后彻底删除 —— 记录真的没了，而且留下墓碑');
  S.setFileHandle({ name: 'p55-share.json' });
  // P64 起，不可撤销的清理还要求"至少备份过一次"（见 purgeHealth 里那道闸）——
  // 这里先造一个"备份过"的状态，否则会被第二道闸挡在门口
  S.DB.settings.lastBackupAt = new Date(Date.now() - 86400000).toISOString();
  await S.purgeHealth('orphanMs');
  ok('先弹确认框，不会点一下就直接删', q('#modal-body').innerHTML.includes('彻底删除'));
  ok('确认框里写清楚了不可撤销', q('#modal-body').innerHTML.includes('不可撤销'));
  S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★两条无主里程碑都从 DB 里真的消失了（不是盖个 deleted_at）',
    !S.byId('milestone', 'p55_ms_orphan') && !S.byId('milestone', 'p55_ms_orphan_del'));
  ok('正常里程碑毫发无损', !!S.byId('milestone', 'p55_ms_ok') && !S.byId('milestone', 'p55_ms_ok').deleted_at);
  ok('★两条都留了墓碑（没有墓碑的话，还没同步的机器会把它们原样推回来）',
    ['p55_ms_orphan', 'p55_ms_orphan_del'].every(id => (S.DB.purged || []).some(p => p.entity === 'milestone' && p.id === id)));
  ok('体检里这一项消失了', !S.healthCheck().issues.some(i => i.k === 'orphanMs'));
  ok('changelog 里留了痕迹，别人也看得到清理过什么',
    (S.DB.changelog || []).some(e => (e.summary || '').includes('彻底删除') && (e.summary || '').includes('无主里程碑')));

  section('③：墓碑上限提高，一次批量清理不会把自己产生的墓碑挤掉');
  ok('★PURGED_LIMIT 至少能容下一次上千条的批量清理', S.PURGED_LIMIT >= 3000, S.PURGED_LIMIT);
  S.DB.purged = [];
  for (let i = 0; i < 1200; i++) S.recordPurge('milestone', 'bulk_' + i);
  ok('连续记 1200 个墓碑，一个都没被挤掉', S.DB.purged.length === 1200);
  ok('最早那个还在（改之前 500 上限时它早被挤没了）', S.DB.purged.some(p => p.id === 'bulk_0'));
  S.DB.purged = [];
  S.setFileHandle(null);

  section('③：彻底清理的权限门槛比一般体检修复高（跟"清空全部数据"看齐）');
  ok('health-purge 走 system_admin，不是 bulk_ops',
    /'health-purge':[^\n]*requirePermission\('system_admin'\)/.test(html));
  // P64 起 health-fix 展开成多行了（加了干跑预览），不能再用 [^\n]* 限定在同一行
  ok('一般体检修复仍然是 bulk_ops', /'health-fix':[\s\S]{0,200}?requirePermission\('bulk_ops'\)/.test(html));

  /* ====================== ④ 报告页按钮位置 ====================== */
  section('④：粒度按钮和翻期按钮包在同一个容器里，不会被 space-between 拉到标题两边');
  S.DB.duties = []; S.DB.works = []; S.DB.tasks = []; S.DB.milestones = [];
  S.rebuildIndex();
  S.seedAll();
  S.rebuildIndex();
  S.setReportPeriod('week'); S.setReportOffset(0);
  S.goto('report');
  const repH = q('#page-report').innerHTML;
  const iPeriod = repH.indexOf('data-act="report-period"');
  const iNav = repH.indexOf('data-act="report-period-nav"');
  ok('粒度按钮在翻期按钮左边', iPeriod > -1 && iNav > -1 && iPeriod < iNav);
  // 关键是它们之间不能再夹着 </div> 之类的结构——两组按钮必须在同一个 flex 容器里
  const between = repH.slice(iPeriod, iNav);
  ok('★两组按钮之间没有跨出容器（中间不含 </div>）', !between.includes('</div>'), between.slice(0, 160));
  ok('四个粒度按钮文字是按周/按月/按季/按年',
    S.REPORT_PERIODS.map(p => p.label).join(',') === '按周,按月,按季,按年');
  S.ACTIONS['report-period-nav']({ step: '-1' });
  ok('往前翻一期后出现"回到本期"', q('#page-report').innerHTML.includes('回到本期') && S.reportOffset === -1);
  S.ACTIONS['report-period-nav']({ step: '0' });
  ok('点"回到本期"后归零', S.reportOffset === 0);

  /* ====================== ⑤ 报告页区域+模块可配置 ====================== */
  section('⑤：模块注册表 —— 每个模块三个出口（页面/文本/图片）一个都不能少');
  ok('模块数量够用（至少 10 个）', S.REPORT_MODULES.length >= 10, S.REPORT_MODULES.length);
  /* P57 之后 canvas 出口改成可选的：模块从 12 个涨到 28 个，里面一多半是饼图/折线/甘特，
     用 exportReportImage 那几个 canvas 原语根本画不出来，硬写只会让三个出口越走越偏。
     缺省行为改成"把 text() 的行画进图片"——图形没了但数字一条不少，而且天然跟纯文本一致。
     所以这里改成：html/text 两个出口必须都有（它们才是内容的来源），canvas 有就得是函数。 */
  ok('★每个模块都提供了 html 和 text 两个出口',
    S.REPORT_MODULES.every(m => typeof m.html === 'function' && typeof m.text === 'function'),
    S.REPORT_MODULES.filter(m => !(m.html && m.text)).map(m => m.key));
  ok('写了 canvas 的模块，canvas 必须是函数（没写的走 text 兜底）',
    S.REPORT_MODULES.every(m => m.canvas === undefined || typeof m.canvas === 'function'));
  ok('每个模块都有 key/label/desc', S.REPORT_MODULES.every(m => m.key && m.label && m.desc));
  ok('key 不重复', new Set(S.REPORT_MODULES.map(m => m.key)).size === S.REPORT_MODULES.length);
  ok('用户点名要的那几块都在',
    ['periodScope', 'periodPlan', 'periodStatus', 'highPriority', 'overdueTasks', 'overdueMs', 'soonTasks', 'soonMs', 'personBars']
      .every(k => !!S.REPORT_MODULE_MAP[k]));

  section('⑤：默认编排就是汇报要念的四段（老数据 reportConfig 为 null 时自动回落到它）');
  S.DB.reportConfig = null;
  const defSecs = S.reportSections();
  ok('★没有任何配置时也拿得到四段（向后兼容，老共享文件不用改一个字）', defSecs.length === 4, defSecs.length);
  ok('四段标题就是用户要的那四段',
    defSecs.map(s => s.title).join('|') === '一、本期处室工作目标|二、本期处室工作进展|三、本期需要关注的工作|四、人员工作情况',
    defSecs.map(s => s.title));
  ok('第一段是"涉及多少 + 计划完成多少"', defSecs[0].modules.join(',') === 'periodScope,periodPlan');
  ok('第二段含整体进度（SPI 在这里）', defSecs[1].modules.includes('periodStatus'));
  ok('第三段把高优先级/逾期/即将到期都放齐了',
    ['highPriority', 'overdueTasks', 'overdueMs', 'soonTasks', 'soonMs'].every(k => defSecs[2].modules.includes(k)));
  // "人员工作情况"模块已经被功能更完整的 personBars（各人任务量与完成率，含牵头/参与比例）取代
  ok('第四段是人员工作情况（现在用 personBars 呈现）', defSecs[3].modules.join(',') === 'personBars');
  ok('没配置时默认存档也拿得到（不会崩）', S.reportPresets().length === 1 && S.activeReportPreset().name === '默认编排');

  section('⑤：当期口径 —— 上期欠下来还没完成的任务要带进本期，不能凭空消失');
  S.DB.duties = []; S.DB.works = []; S.DB.tasks = []; S.DB.milestones = [];
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: 'a', name: 'P55职责' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'p55_w2', duty: '01', code: 'W1', name: 'P55工作', owner: '甲', year: new Date().getFullYear() }))];
  const inRangeDate = S.todayStr();
  const longAgo = S.offsetDate(-400);
  S.DB.tasks = [
    S.stampMeta(S.blank('task', { id: 'p55_a', work: 'p55_w2', title: '本期计划完成', status: 'doing', priority: '1', plan_date: inRangeDate, owner: '甲', assignees: [] })),
    S.stampMeta(S.blank('task', { id: 'p55_b', work: 'p55_w2', title: '上期欠下来的', status: 'todo', priority: '2', plan_date: longAgo, owner: '乙', assignees: [] })),
    S.stampMeta(S.blank('task', { id: 'p55_c', work: 'p55_w2', title: '很久以后才到期', status: 'todo', priority: '3', plan_date: S.offsetDate(400), owner: '丙', assignees: [] })),
  ];
  S.rebuildIndex();
  S.setReportPeriod('week'); S.setReportOffset(0);
  const dd = S.buildReportData('week', 0);
  ok('本期计划完成的算进当期', dd.periodTasks.some(t => t.id === 'p55_a'));
  ok('★上期欠下来还没完成的也算进当期（只按计划日筛的话它会凭空消失）', dd.periodTasks.some(t => t.id === 'p55_b'));
  ok('很久以后才到期的不算进当期', !dd.periodTasks.some(t => t.id === 'p55_c'));
  ok('"计划完成"只数计划日真的落在本期的', dd.planTasks.length === 1 && dd.planTasks[0].id === 'p55_a');
  ok('涉及职责/工作从当期任务往上追溯', dd.dutyCodes.has('01') && dd.workIds.has('p55_w2'));
  ok('四类状态互斥、加起来正好等于当期任务数',
    dd.statusStat.done + dd.statusStat.doing + dd.statusStat.todo + dd.statusStat.late === dd.periodTasks.length);
  ok('逾期那条被算成逾期，没有重复计进未开始', dd.statusStat.late === 1);
  ok('高优先级模块只挑优先级为"高"且没完成的', dd.highPriTasks.length === 1 && dd.highPriTasks[0].id === 'p55_a');
  ok('人员统计按牵头∪参与铺开', dd.peopleStat.some(p => p.nm === '甲') && dd.peopleStat.some(p => p.nm === '乙'));

  section('⑤：页面渲染 —— 区域标题 + 各模块面板');
  S.DB.settings.me = '测试管理员';
  S.renderReport();
  const rh = q('#page-report').innerHTML;
  ok('四个区域标题都渲染出来了',
    ['一、本期处室工作目标', '二、本期处室工作进展', '三、本期需要关注的工作', '四、人员工作情况'].every(t => rh.includes(t)));
  ok('区域用了 .rep-region-title 这个样式', rh.includes('rep-region-title'));
  ok('模块以面板形式挂在区域下面', rh.includes('本期涉及范围') && rh.includes('本期完成进度'));
  ok('高优先级那条任务的标题直接看得到', rh.includes('本期计划完成'));
  ok('管理员能看到「报告编排」配置面板入口', rh.includes('data-act="report-config-toggle"'));

  section('⑤：三个出口说的是同一件事（页面 / 纯文本 / 导出图片都跟着编排走）');
  const txt = S.buildReportText();
  ok('★纯文本里也是同样四段、同样顺序',
    ['一、本期处室工作目标', '二、本期处室工作进展', '三、本期需要关注的工作', '四、人员工作情况'].every(t => txt.includes(t))
    && txt.indexOf('一、本期处室工作目标') < txt.indexOf('四、人员工作情况'));
  // "人员工作情况"这个模块 key 已经被 personBars 取代，文本里带的模块名跟着变了
  ok('文本里带上了模块名', txt.includes('【本期涉及范围】') && txt.includes('【各人任务量与完成率】'));
  await S.exportReportImage();
  ok('导出图片这条路径不抛异常（沙盒里没有真 canvas，优雅降级出提示）', !!q('#snack-msg').textContent);
  // P57：canvas 出口可选之后，这一行变成"有 canvas 用 canvas，没有就退回 text"，但仍然是由编排驱动的。
  // P77 起模块内容的取用逻辑被抽成 moduleContentFn（供并排布局的 panel() 复用），不再直接写在
  // reportSections().forEach 的循环体里，但 reportSections() 驱动 + canvas-或-text 兜底这两件事没变
  ok('图片导出的排版也由编排驱动，不是另写一套写死的顺序',
    /reportSections\(\)\.forEach\(s => \{[\s\S]{0,1200}moduleContentFn\(m\)/.test(html)
    && /if \(m\.canvas\) m\.canvas\(d, api\);[\s\S]{0,120}else m\.text\(/.test(html));

  section('⑤：配置面板 —— 区域增删改名移位');
  S.setReportConfigOpen(true);
  S.renderReport();
  const cfgH = q('#page-report').innerHTML;
  ok('面板展开后列出了每个区域', cfgH.includes('data-act="report-sec-rename"') && cfgH.includes('data-act="report-sec-del"'));
  /* P57：模块涨到 28 个之后，配置面板从"平铺一大片勾选框"改成
     「已选模块列表（可排序/设同行/移除）+ 按分类分组的添加器」，
     所以断言从"每个模块都有一个勾选框"改成"每个模块要么已选、要么在添加器里出现" */
  ok('每个模块要么在已选列表里、要么在分类添加器里，一个都不会漏掉',
    S.REPORT_MODULES.every(m => cfgH.includes(`data-mod="${m.key}"`)));
  ok('已经在编排里的模块出现在"已选"那一段（带移除按钮）',
    /data-act="report-mod-remove"[^>]*data-mod="periodScope"/.test(cfgH));
  // P66：一个模块只该出现一次，personBars 已经用在第四段了，不会再冒出来当候选——
  // 换一个默认编排里哪个区域都没用到的模块（doneTasks）来验证"没选的模块出现在添加器里"
  ok('没选的模块出现在添加器里（带＋号）',
    /data-act="report-mod-add"[^>]*data-mod="doneTasks"/.test(cfgH));
  ok('添加器按分类分组，分类标题都在', S.REPORT_GROUPS.every(g => cfgH.includes(g.label)));
  ok('第一个区域的"上移"是禁用状态', /data-act="report-sec-move"[^>]*data-step="-1"[^>]*opacity:\.3/.test(cfgH));

  S.ACTIONS['report-sec-add']();
  q('#prompt-input').value = 'P55新区域';
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★添加区域生效了', S.reportSections().length === 5 && S.reportSections()[4].title === 'P55新区域');
  ok('新区域默认不含任何模块', S.reportSections()[4].modules.length === 0);
  ok('配置真的写进了 DB.reportConfig（会随共享文件同步给全处）', !!S.DB.reportConfig && S.DB.reportConfig.rev >= 1);
  ok('记了是谁改的', S.DB.reportConfig.updated_by === '测试管理员');

  const newSecId = S.reportSections()[4].id;
  // P57：勾选框换成了"＋添加 / 移除"两个明确的动作
  await S.ACTIONS['report-mod-add']({ sec: newSecId, mod: 'doneTasks' });
  await tick(20);
  ok('★添加模块生效', S.reportSections()[4].modules.includes('doneTasks'));
  await S.ACTIONS['report-mod-remove']({ sec: newSecId, mod: 'doneTasks' });
  await tick(20);
  ok('移除模块也生效', !S.reportSections()[4].modules.includes('doneTasks'));

  await S.ACTIONS['report-sec-move']({ id: newSecId, step: '-1' });
  await tick(20);
  ok('★上移生效（从第 5 位挪到第 4 位）', S.reportSections()[3].id === newSecId);

  S.ACTIONS['report-sec-rename']({ id: newSecId });
  q('#prompt-input').value = 'P55改过名的区域';
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('改名生效', S.reportSections()[3].title === 'P55改过名的区域');

  S.ACTIONS['report-sec-del']({ id: newSecId });
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★删除区域生效，回到四段', S.reportSections().length === 4);
  ok('删区域不动任何业务数据', S.DB.tasks.length === 3 && S.DB.works.length === 1);

  section('⑤：存档 —— 可以存多套编排随时切换');
  S.ACTIONS['report-preset-new']();
  q('#prompt-input').value = '季度总结版';
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★多了一套存档', S.reportPresets().length === 2);
  ok('切换到了新存档', S.activeReportPreset().name === '季度总结版');
  ok('新存档是以当前这套为蓝本复制出来的', S.reportSections().length === 4);
  const defId = S.reportPresets().find(p => p.name === '默认编排').id;
  const newPresetSecIds = S.reportSections().map(s => s.id);
  const defSecIds = S.reportPresets().find(p => p.id === defId).sections.map(s => s.id);
  ok('★两套存档的区域 id 不共用（否则改一边会动到另一边）',
    newPresetSecIds.every(id => !defSecIds.includes(id)), { newPresetSecIds, defSecIds });

  // 在新存档里删掉一段，验证不会串到默认存档去
  await S.ACTIONS['report-sec-move']({ id: newPresetSecIds[0], step: '1' });
  await tick(20);
  ok('改新存档不影响默认存档', S.reportPresets().find(p => p.id === defId).sections[0].title === '一、本期处室工作目标');

  await S.ACTIONS['report-preset-switch']({}, { value: defId });
  await tick(20);
  ok('切回默认存档', S.activeReportPreset().id === defId);
  ok('页面跟着切回默认编排', S.reportSections()[0].title === '一、本期处室工作目标');

  S.ACTIONS['report-preset-rename']();
  q('#prompt-input').value = '周例会版';
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('存档重命名生效', S.activeReportPreset().name === '周例会版');

  S.ACTIONS['report-preset-del']();
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★删除存档生效，剩下的那套自动成为当前存档', S.reportPresets().length === 1 && S.activeReportPreset().name === '季度总结版');
  S.setSnackPriorityUntil(0); q('#snack-msg').textContent = '';
  S.ACTIONS['report-preset-del']();
  ok('★最后一套不让删（删光了报告页就没东西可显示了）',
    q('#snack-msg').textContent.includes('至少要留一套') && S.reportPresets().length === 1,
    { snack: q('#snack-msg').textContent, n: S.reportPresets().length });

  section('⑤：恢复默认编排');
  await S.ACTIONS['report-mod-add']({ sec: S.reportSections()[0].id, mod: 'personBars' });
  await tick(20);
  ok('先故意改乱一点', S.reportSections()[0].modules.includes('personBars'));
  S.ACTIONS['report-config-reset']();
  await S.ACTIONS['modal-ok']();
  await tick(20);
  ok('★恢复默认后回到那四段', S.reportSections().map(s => s.title).join('|')
    === '一、本期处室工作目标|二、本期处室工作进展|三、本期需要关注的工作|四、人员工作情况');
  ok('第一段的模块也还原了', S.reportSections()[0].modules.join(',') === 'periodScope,periodPlan');

  section('⑤：认不出来的模块 key 直接跳过，不让整页报告渲染不出来');
  await S.saveReportConfig(cfg => { S.reportPresetIn(cfg).sections[0].modules.push('未来版本才有的模块'); });
  ok('★脏 key 被滤掉，其它模块照常', !S.reportSections()[0].modules.includes('未来版本才有的模块')
    && S.reportSections()[0].modules.includes('periodScope'));
  S.renderReport();
  ok('页面照样渲染得出来', q('#page-report').innerHTML.includes('一、本期处室工作目标'));

  section('⑤：config_report 权限 —— 默认只有管理员能改编排');
  ok('权限项存在且在"操作"组', S.PERMISSIONS.some(p => p.key === 'config_report' && p.group === '操作'));
  ok('★四个角色默认全部关闭（等于只有管理员能改）',
    ['staff', 'comanager', 'director', 'gm'].every(r => S.DEFAULT_PERMISSION_MATRIX[r].config_report === false));
  ok('权限矩阵表格里有这一项的勾选框',
    S.permissionMatrixPanelHTML().includes('data-key="config_report"'));
  ok('管理员有这个权限（hasPermission 对管理员恒真）', S.hasPermission('config_report'));

  S.DB.users.push({ name: 'P55处室领导', role: 'director', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = 'P55处室领导';
  S.DB.permissionMatrix = null;
  ok('处室领导默认没有这个权限', !S.hasPermission('config_report'));
  S.renderReport();
  ok('★没权限的人看不到「报告编排」面板', !q('#page-report').innerHTML.includes('data-act="report-sec-add"'));
  ok('但报告本身照样看得见（只是改不了编排）', q('#page-report').innerHTML.includes('一、本期处室工作目标'));
  const secsBefore = S.reportSections().length;
  S.setSnackPriorityUntil(0); q('#snack-msg').textContent = '';
  S.ACTIONS['report-sec-add']();
  ok('★直接调动作也会被权限拦下（面板藏起来不算门禁，动作自己得把关）',
    // 连输入框都不该弹出来——弹了再拦是"看着能用其实白填"，体验和门禁都不对
    q('#snack-msg').textContent.includes('为了防止误操作')
    && !q('#modal-body').innerHTML.includes('prompt-input')
    && S.reportSections().length === secsBefore,
    { snack: q('#snack-msg').textContent, modal: q('#modal-body').innerHTML.slice(0, 60), before: secsBefore });
  S.DB.permissionMatrix = { director: { config_report: true } };
  ok('管理员在矩阵里放开之后，处室领导就能改了', S.hasPermission('config_report'));
  S.DB.permissionMatrix = null;
  S.DB.settings.me = '测试管理员';

  section('⑤：编排随共享文件同步（跟权限矩阵同一套"整体对象比版本"规则）');
  ok('syncPayload 里带上了 reportConfig', 'reportConfig' in S.syncPayload(S.DB));
  const mergedCfg = S.mergeSyncPayload(
    { reportConfig: { presets: [{ id: 'a', name: '本机的', sections: [] }], activeId: 'a', rev: 1, updated_at: '2026-01-01T00:00:00.000Z' } },
    { reportConfig: { presets: [{ id: 'b', name: '对方更新的', sections: [] }], activeId: 'b', rev: 2, updated_at: '2026-01-02T00:00:00.000Z' } }
  );
  ok('版本号更高的那份被采用', mergedCfg.reportConfig.presets[0].name === '对方更新的');
  const mergedCfg2 = S.mergeSyncPayload(
    { reportConfig: { presets: [], activeId: 'a', rev: 5, updated_at: '2026-03-01T00:00:00.000Z' } },
    { reportConfig: null }
  );
  ok('对方没有配置时保留本机那份（不会被 null 冲掉）', !!mergedCfg2.reportConfig && mergedCfg2.reportConfig.rev === 5);
  ok('★老共享文件里根本没有这个字段时也不会炸', S.mergeSyncPayload({ reportConfig: null }, {}).reportConfig === null);
  ok('本机改了编排、文件里还没有 → 判定为"有东西要推"',
    S.hasLocalContribution({ reportConfig: { rev: 1, updated_at: '2026-01-01T00:00:00.000Z' } }, {}) === true);

  section('⑤：编排改动刻意不进撤销栈（它是配置不是数据，Ctrl+Z 半路拨回去只会让人更懵）');
  ok('saveReportConfig 里没有调 snapshot',
    /async function saveReportConfig[\s\S]{0,700}?\n\}/.test(html)
    && !/async function saveReportConfig[\s\S]{0,700}?snapshot\(\)/.test(html));
  ok('取而代之的是明确的"恢复默认编排"按钮', html.includes(`'report-config-reset'`));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
