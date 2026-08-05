/* P57：本轮三项改动测试——
   ① 报告模块注册表扩充：图表页/工作台的展示模块全都能选，按分类归组，标出"当期/全量"口径
   ② 模块可以并排放同一行（section.inline），向前向后兼容，窄屏靠 CSS 自动折行
   ③ 「最近连接」心跳：人激活页面就更新，但不给共享文件加额外读写
   用法：node test/test-p57.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, raw, q } = require('./harness.js');

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
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.reportConfig = null;
    S.DB.permissionMatrix = null;
    S.setFileHandle(null);
    S.setLastPresenceAt(0);
  };
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();

  /* ====================== ① 模块注册表扩充 ====================== */
  section('①：模块数量大幅扩充，图表页/工作台的展示模块都进来了');
  ok('★模块数明显多于改版前的 12 个', S.REPORT_MODULES.length >= 25, S.REPORT_MODULES.length);
  // P58 之后 taskFieldDist / workYearDuty 各自拆成了更细的模块（见下面 ①-② 专门的测试），
  // 这里的清单换成拆分后的 key，其余不变
  const need = {
    personBars: '图表页-按人', dutyCategoryBars: '图表页-按职责(类别)', dutyItemBars: '图表页-按职责(职责项)',
    taskStatusPie: '图表页-按任务(状态总览)', taskDueDist: '图表页-到期分布',
    taskPriorityPie: '图表页-优先级分布', taskSourceBars: '图表页-来源分布', taskTagBars: '图表页-标签分布',
    workOverview: '图表页-按工作(总览)', worksByYearBars: '图表页-按工作(年度)', worksByDutyBars: '图表页-按工作(职责)',
    msCompletionPie: '图表页-里程碑完成情况', msLevelPie: '图表页-呈报层级', msGantt: '图表页-里程碑甘特图',
    backlogTrend: '图表页-待办总量趋势', planDueTrend: '图表页-各月计划完成',
    dashCards: '工作台-统计卡片', myDesk: '工作台-我的工作台', recentActivity: '工作台-最近动态',
  };
  Object.entries(need).forEach(([k, from]) => ok(`★${from} → 模块 ${k}`, !!S.REPORT_MODULE_MAP[k]));

  section('①：每个模块都归了类，分类本身也定义齐全');
  ok('REPORT_GROUPS 有分类定义', Array.isArray(S.REPORT_GROUPS) && S.REPORT_GROUPS.length >= 6, S.REPORT_GROUPS.length);
  ok('每个分类都有 key/label', S.REPORT_GROUPS.every(g => g.key && g.label));
  const groupKeys = new Set(S.REPORT_GROUPS.map(g => g.key));
  ok('★每个模块的 group 都是已定义的分类，没有落单的',
    S.REPORT_MODULES.every(m => groupKeys.has(m.group)),
    S.REPORT_MODULES.filter(m => !groupKeys.has(m.group)).map(m => m.key));
  ok('每个分类底下都真的有模块（没有空分类）',
    S.REPORT_GROUPS.every(g => S.REPORT_MODULES.some(m => m.group === g.key)),
    S.REPORT_GROUPS.filter(g => !S.REPORT_MODULES.some(m => m.group === g.key)).map(g => g.key));

  section('①：口径标记 scope —— 认周期的标 period，天生跨期的标 all');
  ok('每个模块都标了 scope，且只有 period/all 两种',
    S.REPORT_MODULES.every(m => m.scope === 'period' || m.scope === 'all'),
    S.REPORT_MODULES.filter(m => !['period', 'all'].includes(m.scope)).map(m => [m.key, m.scope]));
  ok('★趋势/甘特/最近动态这类天生跨期的，标的是 all（翻期对它们没意义，界面要讲清楚）',
    ['backlogTrend', 'planDueTrend', 'msGantt', 'recentActivity', 'dashCards', 'myDesk']
      .every(k => S.REPORT_MODULE_MAP[k].scope === 'all'));
  ok('★当期口径那几个标的是 period',
    ['periodScope', 'periodStatus', 'personBars', 'taskStatusPie', 'msCompletionPie']
      .every(k => S.REPORT_MODULE_MAP[k].scope === 'period'));

  section('①：所有模块的 html/text 都跑得通，不会因为某个模块炸掉整页报告');
  const d = S.buildReportData('week', 0);
  const broken = [];
  S.REPORT_MODULES.forEach(m => {
    try { const h = m.html(d, { width: 900 }); if (typeof h !== 'string') broken.push(m.key + ':html非字符串'); }
    catch (e) { broken.push(m.key + ':html ' + e.message); }
    try { const out = []; m.text(d, x => out.push(x)); }
    catch (e) { broken.push(m.key + ':text ' + e.message); }
  });
  ok('★28 个模块逐个渲染，没有一个抛异常', broken.length === 0, broken);
  ok('每个模块都有 desc（选择器上的悬浮说明要用）', S.REPORT_MODULES.every(m => !!m.desc));

  section('①：搬过来的模块用的是当期口径，不是图表页那种"全部任务"');
  // 造一条落在很久以前的已完成任务：当期口径应该看不到它，全量口径能看到
  await S.Repo.upsert('duty', { code: 'P57', name: 'P57职责', category: CATEGORY_FALLBACK() });
  await S.Repo.upsert('work', { id: 'p57_w', duty: 'P57', code: 'W1', name: 'P57工作', owner: '张三', year: new Date().getFullYear() });
  await S.Repo.upsert('task', { id: 'p57_old', work: 'p57_w', title: 'P57很久以前就完成的任务', status: 'done',
    plan_date: S.offsetDate(-500), actual_date: S.offsetDate(-500), owner: 'P57老同志', assignees: [] });
  S.rebuildIndex();
  const d2 = S.buildReportData('week', 0);
  ok('这条老任务确实不在当期口径里', !d2.periodTasks.some(t => t.id === 'p57_old'));
  ok('但它在全量口径里', d2.tasks.some(t => t.id === 'p57_old'));
  const personHtml = S.REPORT_MODULE_MAP.personBars.html(d2, { width: 900 });
  ok('★"各人任务量"用的是当期口径——老任务的负责人不出现', !personHtml.includes('P57老同志'));
  const dashHtml = S.REPORT_MODULE_MAP.dashCards.html(d2, { width: 900 });
  ok('★标了 all 的"整体统计卡片"明说自己不随周期变化', dashHtml.includes('不随周期'));

  section('①：canvas 出口是可选的，没写的自动退回用 text 画（图片导出不会漏内容）');
  ok('确实有一批模块没写 canvas（否则这条兜底就是白写的）',
    S.REPORT_MODULES.some(m => !m.canvas));
  ok('★导出图片的代码里有 "有 canvas 用 canvas、没有就用 text" 这条兜底',
    /if \(m\.canvas\) m\.canvas\(d, api\);[\s\S]{0,160}else m\.text\(/.test(html));
  S.DB.reportConfig = null;
  await S.saveReportConfig(cfg => {
    const s = S.reportPresetIn(cfg).sections[0];
    s.modules = ['backlogTrend', 'msGantt'];   // 两个都没有 canvas
  });
  await tick();
  q('#snack-msg').textContent = '';
  await S.exportReportImage();
  ok('全是"没写 canvas"的模块时，导出图片也不抛异常', true);

  /* ====================== ② 同行排列 ====================== */
  section('②：section.inline 决定谁跟上一个同行，rows 由它推导出来');
  S.DB.reportConfig = null;
  const secId = S.reportSections()[0].id;
  await S.saveReportConfig(cfg => {
    const s = S.reportPresetIn(cfg).sections.find(x => x.id === secId);
    s.modules = ['periodScope', 'periodPlan', 'periodStatus'];
    s.inline = [];
  });
  await tick();
  ok('没设同行时，每个模块各占一行',
    JSON.stringify(S.reportSections()[0].rows) === JSON.stringify([['periodScope'], ['periodPlan'], ['periodStatus']]),
    S.reportSections()[0].rows);
  await S.ACTIONS['report-mod-inline']({ sec: secId, mod: 'periodPlan' });
  await tick();
  ok('★把第二个设成同行后，前两个并成一行',
    JSON.stringify(S.reportSections()[0].rows) === JSON.stringify([['periodScope', 'periodPlan'], ['periodStatus']]),
    S.reportSections()[0].rows);
  await S.ACTIONS['report-mod-inline']({ sec: secId, mod: 'periodStatus' });
  await tick();
  ok('★再把第三个也设成同行，三个并成一行',
    JSON.stringify(S.reportSections()[0].rows) === JSON.stringify([['periodScope', 'periodPlan', 'periodStatus']]));
  await S.ACTIONS['report-mod-inline']({ sec: secId, mod: 'periodPlan' });
  await tick();
  ok('再点一次取消同行（是个开关）',
    JSON.stringify(S.reportSections()[0].rows) === JSON.stringify([['periodScope'], ['periodPlan', 'periodStatus']]),
    S.reportSections()[0].rows);

  section('②：第一个模块永远不能"跟上一个同行"——它没有上一个');
  await S.saveReportConfig(cfg => {
    const s = S.reportPresetIn(cfg).sections.find(x => x.id === secId);
    s.modules = ['periodScope', 'periodPlan'];
    s.inline = ['periodScope'];   // 故意写一条不合法的：第一个模块被标了同行
  });
  await tick();
  ok('★存档里就算写着第一个模块同行，渲染时也不会让它跟别人挤（第一行只有它）',
    S.reportSections()[0].rows[0].length === 1 && S.reportSections()[0].rows[0][0] === 'periodScope',
    S.reportSections()[0].rows);
  // 上面那条是"存档里已经有脏数据时渲染要顶得住"；这里换成干净的起点，验证动作本身不会写出这种脏数据
  await S.saveReportConfig(cfg => {
    const s = S.reportPresetIn(cfg).sections.find(x => x.id === secId);
    s.modules = ['periodScope', 'periodPlan'];
    s.inline = [];
  });
  await tick();
  await S.ACTIONS['report-mod-inline']({ sec: secId, mod: 'periodScope' });
  await tick();
  ok('动作层面也拦着：对第一个模块点"同行"不会写进 inline',
    !S.reportSections()[0].inline.includes('periodScope'), S.reportSections()[0].inline);

  section('②：模块排序 —— 上移下移，挪到第一位时同行标记自动清掉');
  await S.saveReportConfig(cfg => {
    const s = S.reportPresetIn(cfg).sections.find(x => x.id === secId);
    s.modules = ['periodScope', 'periodPlan'];
    s.inline = ['periodPlan'];
  });
  await tick();
  ok('前置条件：两个模块并排一行', S.reportSections()[0].rows.length === 1);
  await S.ACTIONS['report-mod-move']({ sec: secId, mod: 'periodPlan', step: '-1' });
  await tick();
  ok('★把带同行标记的模块挪到第一位后，标记被清掉（否则界面禁用、数据里却还留着）',
    !S.reportSections()[0].inline.includes('periodPlan'), S.reportSections()[0].inline);
  ok('顺序确实换了', S.reportSections()[0].modules.join(',') === 'periodPlan,periodScope');
  ok('于是又变回各占一行', S.reportSections()[0].rows.length === 2);

  section('②：移除模块时顺手清掉它的同行标记，不留脏数据');
  await S.saveReportConfig(cfg => {
    const s = S.reportPresetIn(cfg).sections.find(x => x.id === secId);
    s.modules = ['periodScope', 'periodPlan'];
    s.inline = ['periodPlan'];
  });
  await tick();
  await S.ACTIONS['report-mod-remove']({ sec: secId, mod: 'periodPlan' });
  await tick();
  const rawSec = S.reportPresets()[0].sections.find(x => x.id === secId);
  ok('★modules 和 inline 里都没有它了', !rawSec.modules.includes('periodPlan') && !(rawSec.inline || []).includes('periodPlan'),
    { modules: rawSec.modules, inline: rawSec.inline });

  section('②：向前/向后兼容 —— 老数据没有 inline，老版本也不认识 inline');
  ok('★老数据（section 里只有 modules、没有 inline）照样能渲染，全部纵向',
    (() => {
      S.DB.reportConfig = { presets: [{ id: 'old', name: '老编排', sections: [{ id: 's1', title: '老区域', modules: ['periodScope', 'periodPlan'] }] }], activeId: 'old', rev: 1 };
      const secs = S.reportSections();
      return secs[0].rows.length === 2 && secs[0].inline.length === 0;
    })());
  ok('★modules 仍然是扁平数组（老版本 html 唯一认得的字段，不能改成二维）',
    Array.isArray(S.reportPresets()[0].sections[0].modules)
    && S.reportPresets()[0].sections[0].modules.every(k => typeof k === 'string'));
  S.DB.reportConfig = null;

  section('②：页面渲染 —— 并排的用 .rep-row 包起来，单独的不包');
  S.DB.settings.me = '测试管理员';
  await S.saveReportConfig(cfg => {
    const s = S.reportPresetIn(cfg).sections[0];
    s.modules = ['periodScope', 'periodPlan', 'periodStatus'];
    s.inline = ['periodPlan'];
  });
  await tick();
  S.goto('report');
  const rh = q('#page-report').innerHTML;
  ok('★出现了 .rep-row 并排容器', rh.includes('class="rep-row"'));
  ok('并排的模块带 rep-col（flex 子项）', rh.includes('panel rep-col'));
  ok('三个模块都渲染出来了',
    rh.includes('当期涉及范围') && rh.includes('当期工作计划量') && rh.includes('当期完成进度'));
  ok('★窄屏自适应靠 CSS 而不是 JS：rep-row 是 flex-wrap，子项有 flex-basis',
    /\.rep-row \{[^}]*flex-wrap: wrap/.test(html) && /\.rep-row > \.rep-col \{[^}]*flex: 1 1 \d+px/.test(html));
  ok('flex 子项设了 min-width:0，否则里面一张定宽 SVG 就能把整行撑破',
    /\.rep-row > \.rep-col \{[^}]*min-width: 0/.test(html));

  section('②：配置面板重做 —— 已选列表（可排序/同行/移除）+ 按分类的添加器');
  S.setReportConfigOpen(true);
  S.renderReport();
  const cfgH = q('#page-report').innerHTML;
  ok('已选模块带移除按钮', /data-act="report-mod-remove"[^>]*data-mod="periodScope"/.test(cfgH));
  ok('已选模块带上移/下移', /data-act="report-mod-move"[^>]*data-mod="periodScope"/.test(cfgH));
  ok('已选模块带"同行"开关', /data-act="report-mod-inline"[^>]*data-mod="periodPlan"/.test(cfgH));
  ok('★设了同行的那个，开关是高亮(on)状态',
    /data-act="report-mod-inline" data-sec="[^"]*" data-mod="periodPlan"/.test(cfgH)
    && /class="toggle-view on" data-act="report-mod-inline"[^>]*data-mod="periodPlan"/.test(cfgH));
  ok('第一个模块的"同行"是禁用的',
    /data-act="report-mod-inline"[^>]*data-mod="periodScope"[^>]*[\s\S]{0,120}opacity:\.3/.test(cfgH));
  ok('★添加器按分类分组，每个分类标题都在', S.REPORT_GROUPS.every(g => cfgH.includes(g.label)));
  ok('没选的模块出现在添加器里', /data-act="report-mod-add"[^>]*data-mod="personBars"/.test(cfgH));
  // 必须限定到"这个区域"的添加器：别的区域没选 periodScope，它们的添加器里当然还offer它
  ok('已选的模块不会又出现在同一个区域的添加器里（避免重复添加）',
    !cfgH.includes(`data-act="report-mod-add" data-sec="${secId}" data-mod="periodScope"`),
    cfgH.includes(`data-act="report-mod-add" data-sec="${secId}" data-mod="personBars"`));

  section('②：改编排仍然要 config_report 权限');
  S.DB.users.push({ name: 'P57员工', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = 'P57员工';
  S.DB.permissionMatrix = null;
  const before = S.reportSections()[0].modules.length;
  S.setSnackPriorityUntil(0); q('#snack-msg').textContent = '';
  S.ACTIONS['report-mod-add']({ sec: secId, mod: 'personBars' });
  await tick();
  ok('★没权限的人加不了模块，而且给了明确提示',
    q('#snack-msg').textContent.includes('为了防止误操作') && S.reportSections()[0].modules.length === before);
  S.setSnackPriorityUntil(0); q('#snack-msg').textContent = '';
  S.ACTIONS['report-mod-inline']({ sec: secId, mod: 'periodStatus' });
  await tick();
  ok('设同行同样被拦下', q('#snack-msg').textContent.includes('为了防止误操作'));
  S.DB.settings.me = '测试管理员';
  S.DB.permissionMatrix = null;

  /* ====================== ③ 最近连接心跳 ====================== */
  section('③：touchPresence —— 没登录 / 没连共享文件时不做事');
  S.DB.reportConfig = null;
  S.setLastPresenceAt(0);
  S.setFileHandle(null);
  S.DB.settings.me = '测试管理员';
  ok('★没连共享文件夹时不打心跳（记了也传不出去）', S.touchPresence() === false);
  S.setFileHandle({ name: 'p57.json' });
  const bakMe2 = S.DB.settings.me;
  S.DB.settings.me = '';
  ok('★没登录时不打心跳（没有"谁"可记）', S.touchPresence() === false);
  S.DB.settings.me = bakMe2;

  section('③：激活页面就更新最近连接时间，30 分钟内不重复打');
  const u = () => S.DB.users.find(x => x.name === '测试管理员' && !x.deleted_at);
  u().lastSeenAt = '';
  S.setLastPresenceAt(0);
  ok('★第一次激活：心跳打上了', S.touchPresence() === true && !!u().lastSeenAt);
  const firstAt = u().lastSeenAt;
  ok('顺带记下了当前 html 版本（排查谁在用旧版靠它）', u().lastAppVersion === S.APP_VERSION);
  ok('★紧接着再激活一次：被节流挡掉，不重复打', S.touchPresence() === false);
  ok('时间戳没被改动', u().lastSeenAt === firstAt);
  ok('节流窗口是 30 分钟', S.PRESENCE_MIN_GAP_MS === 30 * 60 * 1000);
  S.setLastPresenceAt(Date.now() - S.PRESENCE_MIN_GAP_MS - 1000);
  ok('★过了 30 分钟再激活：又能打了', S.touchPresence() === true);

  section('③：markUserSeen 会顺手重置节流计时，避免刚写完文件又多打一次');
  S.setLastPresenceAt(0);
  S.markUserSeen('测试管理员');
  ok('★写文件那条路径打完心跳后，紧接着的激活会被节流挡掉', S.touchPresence() === false);

  section('③：hasLocalContribution 认得心跳 —— 这是"只看不改的人也能推上去"的关键');
  const mkUsers = seen => [{ name: '甲', role: 'staff', rev: 1, updated_at: '2026-01-01T00:00:00.000Z', lastSeenAt: seen }];
  const empty = { duties: [], works: [], milestones: [], tasks: [], changelog: [], purged: [] };
  ok('★本机心跳比文件里新 → 判定"有东西要推"（改之前这里恒为 false，心跳永远推不上去）',
    S.hasLocalContribution(
      Object.assign({}, empty, { users: mkUsers('2026-08-04T10:00:00.000Z') }),
      Object.assign({}, empty, { users: mkUsers('2026-08-04T09:00:00.000Z') })) === true);
  ok('★心跳跟文件里一样新 → 不再重复写（不会写起来没完）',
    S.hasLocalContribution(
      Object.assign({}, empty, { users: mkUsers('2026-08-04T10:00:00.000Z') }),
      Object.assign({}, empty, { users: mkUsers('2026-08-04T10:00:00.000Z') })) === false);
  ok('文件里比本机新 → 也不用写',
    S.hasLocalContribution(
      Object.assign({}, empty, { users: mkUsers('2026-08-04T09:00:00.000Z') }),
      Object.assign({}, empty, { users: mkUsers('2026-08-04T10:00:00.000Z') })) === false);
  ok('文件里压根没这个人 → 要推上去',
    S.hasLocalContribution(
      Object.assign({}, empty, { users: mkUsers('2026-08-04T09:00:00.000Z') }),
      Object.assign({}, empty, { users: [] })) === true);

  section('③：心跳仍然不带 rev（不能因为心跳把真正的账号修改压过去）');
  const before2 = clone(u());
  S.setLastPresenceAt(0);
  S.touchPresence();
  ok('★rev 没被顶高', u().rev === before2.rev, { before: before2.rev, after: u().rev });
  ok('updated_at 也没动（这两个一动，合并时就会盖过别人真正改的角色/PIN）',
    u().updated_at === before2.updated_at);
  ok('mergeUserPresence 仍然按"取心跳更晚的那个"单独合并',
    S.mergeUserPresence(
      [{ name: '甲', lastSeenAt: '2026-01-01T00:00:00.000Z' }],
      [{ name: '甲', lastSeenAt: '2026-01-01T00:00:00.000Z' }],
      [{ name: '甲', lastSeenAt: '2026-06-01T00:00:00.000Z', lastAppVersion: 'v9' }]
    )[0].lastSeenAt === '2026-06-01T00:00:00.000Z');

  section('③：不额外读写文件 —— 激活路径上只盖内存时间戳，写入搭定时同步的顺风车');
  ok('★touchPresence 里没有任何写文件的调用（不 persist、不 syncToFile）',
    /function touchPresence\(\)[\s\S]{0,600}?\n\}/.test(html)
    && !/function touchPresence\(\)[\s\S]{0,600}?(Repo\.persist|syncToFile)/.test(html));
  ok('激活事件（visibilitychange / focus）上确实挂了 touchPresence',
    /visibilitychange[\s\S]{0,120}touchPresence\(\)/.test(html) && /window\.addEventListener\('focus'[\s\S]{0,80}touchPresence\(\)/.test(html));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
// seedAll 造的职责用的是内置分类，这里给新建职责取一个合法分类值
function CATEGORY_FALLBACK() { return (S.CATEGORIES && S.CATEGORIES[0] && S.CATEGORIES[0].v) || 'a'; }
const clone = o => JSON.parse(JSON.stringify(o));
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
