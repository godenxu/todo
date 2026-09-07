/* ============================================================================
   演示数据自检
   ----------------------------------------------------------------------------
   把 gen-demo-data.js 生成的那份 JSON 当成"共享文件里读到的内容"灌进一个干净的沙盒，
   完整走一遍程序自己的入口（校验 → 合并 → 规范化 → 建索引），然后把每一页、
   报告页的每个周期、图表页的每个分页都渲染一遍，任何一处抛异常就算不合格。

   为什么要有这一步：数据是脚本造的，光看统计数字对不出"页面能不能打开"。
   真让同事拿去用之前，得先确认它至少不会让哪一页白屏。

   用法：node tools/verify-demo-data.js [json路径]
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const { sandbox: S } = require(path.join(__dirname, '..', 'test', 'harness.js'));

const FILE = process.argv[2] || path.join(__dirname, '..', 'demo', '科技规划处工作管理.json');
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
// 渲染一段东西，只要不抛异常、并且真的产出了内容就算过
function render(name, fn) {
  try {
    const out = fn();
    const len = typeof out === 'string' ? out.length : 1;
    ok(`${name}（产出 ${typeof out === 'string' ? len + ' 字符' : '正常返回'}）`, len > 0);
  } catch (e) {
    ok(name, false, e && e.message);
  }
}

async function main() {
  await tick();
  const DB = S.DB;
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));

  section('一、文件本身');
  ok('是程序认得的共享数据（isValidShareData）', S.isValidShareData(raw));
  ok(`格式版本号 ${S.payloadSchemaVersion(raw)} 不高于本版 html 的 ${S.DATA_SCHEMA_VERSION}`,
    S.payloadSchemaVersion(raw) <= S.DATA_SCHEMA_VERSION);
  ok('带着"谁写的/用哪版 html 写的"这些自述信息', !!raw.lastWriteBy && !!raw.lastWriteApp && !!raw.lastWriteAt);
  ok('同步载荷该有的字段一个不缺',
    ['duties', 'works', 'milestones', 'tasks', 'changelog', 'users', 'purged'].every(k => Array.isArray(raw[k]))
    && 'permissionMatrix' in raw && 'reportConfig' in raw && 'dashboardConfig' in raw && 'shareConfig' in raw);
  ok('不含只该留在本机的字段（settings / syncBase）', !('settings' in raw) && !('syncBase' in raw));

  section('二、按程序自己的入口装载（校验→合并→规范化→建索引）');
  const empty = { duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
    permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null, purged: [] };
  let merged;
  try {
    merged = S.normalizeMergedRecords(S.mergeSyncPayload(empty, raw, null));
    ok('合并 + 规范化没有抛异常', true);
  } catch (e) { ok('合并 + 规范化没有抛异常', false, e && e.message); return finish(); }
  Object.assign(DB, merged);
  DB.settings.me = '徐捷';
  DB.settings.year = new Date().getFullYear();
  S.rebuildIndex();
  ok(`装载后：职责 ${DB.duties.length}、工作 ${DB.works.length}、任务 ${DB.tasks.length}、里程碑 ${DB.milestones.length}`,
    DB.duties.length > 0 && DB.works.length > 0 && DB.tasks.length > 0 && DB.milestones.length > 0);
  ok('合并没有报字段冲突（干净装载本来就不该有冲突）', (S.mergeFieldConflicts || []).length === 0, S.mergeFieldConflicts);
  ok('没有触发角色提升告警（提权都有对应的账号变更记录当凭证）', (S.integrityAlerts || []).length === 0, S.integrityAlerts);

  section('三、引用完整性');
  const dutyCodes = new Set(DB.duties.map(d => d.code));
  const workIds = new Set(DB.works.map(w => w.id));
  const taskIds = new Set(DB.tasks.map(t => t.id));
  ok('每项工作的所属职责都存在', DB.works.every(w => dutyCodes.has(w.duty)),
    DB.works.filter(w => !dutyCodes.has(w.duty)).map(w => w.code));
  ok('每条任务的所属工作都存在', DB.tasks.every(t => !t.work || workIds.has(t.work)),
    DB.tasks.filter(t => t.work && !workIds.has(t.work)).map(t => t.code));
  ok('每个里程碑的所属任务都存在', DB.milestones.every(m => taskIds.has(m.task)));
  ok('任务编号在同一项工作下没有重复（刻意留的那一条除外）',
    (() => {
      const seen = new Map();
      DB.tasks.filter(t => !t.deleted_at && t.code).forEach(t => seen.set(t.code, (seen.get(t.code) || 0) + 1));
      return [...seen.values()].filter(n => n > 1).length === 1;
    })());

  section('四、功能覆盖：这份数据够不够把每个模块撑起来');
  const today = S.todayStr();
  const aliveT = DB.tasks.filter(t => !t.deleted_at);
  const aliveM = DB.milestones.filter(m => !m.deleted_at);
  const has = (label, n, min) => ok(`${label}：${n} 条（至少要 ${min}）`, n >= min, n);
  has('未开始的任务', aliveT.filter(t => t.status === 'todo').length, 5);
  has('进行中的任务', aliveT.filter(t => t.status === 'doing').length, 20);
  has('已完成的任务', aliveT.filter(t => t.status === 'done').length, 20);
  has('已挂起的任务', aliveT.filter(t => t.status === 'hold').length, 3);
  has('高优先级任务', aliveT.filter(t => t.priority === '1').length, 10);
  has('逾期未完成任务', aliveT.filter(t => t.plan_date && t.plan_date < today && t.status !== 'done').length, 5);
  has('今日到期任务', aliveT.filter(t => t.plan_date === today).length, 1);
  has('无计划日期任务', aliveT.filter(t => !t.plan_date).length, 3);
  has('无牵头人任务（批量指派用）', aliveT.filter(t => !t.owner).length, 3);
  has('有参与人的任务', aliveT.filter(t => (t.assignees || []).length).length, 20);
  has('回收站里的任务', DB.tasks.filter(t => t.deleted_at).length, 2);
  has('已交付里程碑', aliveM.filter(m => m.done === '1').length, 20);
  has('逾期未交付里程碑', aliveM.filter(m => m.done !== '1' && m.plan_date && m.plan_date < today).length, 5);
  has('下期（未来 7—40 天）有节点的里程碑',
    aliveM.filter(m => m.done !== '1' && m.plan_date > today && m.plan_date <= S.offsetDate(40)).length, 10);
  S.REPORT_LEVELS.forEach(l => has(`呈报层级「${l.label}」的里程碑`, aliveM.filter(m => m.report_level === l.v).length, 10));
  // ★ 按程序自己算出来的"本期/下期"区间来验，不是按天数偏移拍脑袋 ★
  const wk = S.periodRange('week', 0), wkN = S.periodRange('week', 1);
  const mo = S.periodRange('month', 0), moN = S.periodRange('month', 1);
  const inRange = (d, r) => !!d && d >= r.start && d <= r.end;
  has('本周已交付里程碑（周报"本期已交付"模块）', aliveM.filter(m => m.done === '1' && inRange(m.actual_date, wk)).length, 5);
  // 月初跑脚本时"本月"才刚开始，天然没多少历史，门槛相应放低
  has('本月已交付里程碑（月报"本期已交付"模块）', aliveM.filter(m => m.done === '1' && inRange(m.actual_date, mo)).length, 2);
  has('下周计划节点（周报"下期计划"模块）', aliveM.filter(m => m.done !== '1' && inRange(m.plan_date, wkN)).length, 5);
  has('下月计划节点（月报"下期计划"模块）', aliveM.filter(m => m.done !== '1' && inRange(m.plan_date, moN)).length, 5);
  has('本周完成的任务', aliveT.filter(t => t.status === 'done' && inRange(t.actual_date, wk)).length, 3);
  has('本月完成的任务', aliveT.filter(t => t.status === 'done' && inRange(t.actual_date, mo)).length, 2);
  // 三个呈报层级都得有近期交付，"本期已交付里程碑"模块的层级筛选才有得筛
  const last30 = { start: S.offsetDate(-30), end: today };
  S.REPORT_LEVELS.forEach(l => has(`近 30 天已交付里程碑里，呈报层级「${l.label}」的`,
    aliveM.filter(m => m.done === '1' && inRange(m.actual_date, last30) && m.report_level === l.v).length, 2));
  S.CATEGORIES.forEach(c => has(`职责分类「${c.label}」下的工作`,
    DB.works.filter(w => !w.deleted_at && (S.byId('duty', w.duty) || {}).category === c.v).length, 1));
  S.ROLES.forEach(r => has(`角色「${r.label}」的账号`, DB.users.filter(u => !u.deleted_at && u.role === r.v).length, 1));
  has('待首次登录设 PIN 的账号', DB.users.filter(u => !u.deleted_at && !u.hash).length, 1);
  has('已设 PIN 的账号', DB.users.filter(u => !u.deleted_at && u.hash).length, 10);
  has('上一年度的工作（年度筛选/年度复制用）',
    DB.works.filter(w => !w.deleted_at && w.year === new Date().getFullYear() - 1).length, 3);
  ['edit', 'login', 'admin', 'alert'].forEach(k =>
    has(`「${k}」类日志`, DB.changelog.filter(e => S.logKind(e) === k).length, 1));
  has('带字段明细的日志（按日志核对用）', DB.changelog.filter(e => Array.isArray(e.changes) && e.changes.length).length, 20);
  has('彻底删除留下的墓碑', (DB.purged || []).length, 1);
  ok('权限矩阵是改过的（能验证它确实随文件同步）',
    !!DB.permissionMatrix && DB.permissionMatrix.director && DB.permissionMatrix.director.view_logs === true);
  ok('报告页编排存了两套预设', (DB.reportConfig.presets || []).length === 2);
  ok('工作台编排存了两套预设', (DB.dashboardConfig.presets || []).length === 2);

  section('五、PIN 能不能真的验过');
  const u = DB.users.find(x => x.name === '徐捷');
  ok('管理员账号 徐捷 的 PIN「123456」验证通过', await S.verifyPin('123456', u));
  ok('错的 PIN 验不过', !(await S.verifyPin('000000', u)));

  section('六、每一页都渲染一遍（抛异常就算不合格）');
  S.PAGES.forEach(p => {
    const key = typeof p === 'string' ? p : p.key;
    render(`页面「${key}」`, () => { S.setPage(key); S.renderPage(); return true; });
  });
  render('导航壳', () => { S.renderShell(); return true; });

  section('七、报告页：每个周期都出一遍');
  S.REPORT_PERIODS.forEach(p => {
    const key = typeof p === 'string' ? p : p.key;
    render(`报告周期「${key}」·本期`, () => { S.setReportPeriod(key); S.setReportOffset(0); S.renderReport(); return true; });
    render(`报告周期「${key}」·上一期`, () => { S.setReportOffset(-1); S.renderReport(); return true; });
    render(`报告周期「${key}」·纯文本简报`, () => S.buildReportText());
  });
  S.setReportPeriod('week'); S.setReportOffset(0);
  render('报告导出图片（整段排版逻辑）', () => { S.exportReportImage(); return true; });

  section('八、图表页：每个分页都出一遍');
  S.CHART_TABS.forEach(t => {
    const key = typeof t === 'string' ? t : t.key;
    render(`图表分页「${key}」`, () => { S.raw = null; return renderChartTab(key); });
  });
  function renderChartTab(key) {
    // chartTab 是模块内的变量，没有 setter；改用它自己的动作入口切换
    if (S.ACTIONS['chart-tab']) S.ACTIONS['chart-tab']({ tab: key });
    S.renderCharts();
    return true;
  }

  section('九、工作台：按人 / 按周期都看一遍');
  ['week', 'month', 'quarter', 'year'].forEach(p => {
    render(`工作台周期「${p}」`, () => { S.setDashPeriod(p); S.setDashOffset(0); S.renderDashboard(); return true; });
  });
  ['凌象政', '周雨桐', '徐捷'].forEach(who => {
    render(`工作台切到「${who}」的视角`, () => { S.setDashViewAsPerson(who); S.renderDashboard(); return true; });
  });
  S.setDashViewAsPerson('');

  section('十、数据体检 / 按日志核对：结果符合预期');
  const hc = S.healthCheck();
  const kinds = (hc.issues || []).map(i => i.k);
  ['dupTask', 'dupTaskCode', 'msLateThanTask', 'progressMismatch', 'noDateHasMs'].forEach(k =>
    ok(`体检能查出刻意留的「${k}」样本`, kinds.includes(k), kinds));
  ok('体检没有查出计划外的严重问题（除刻意留的以外没有 error 级）',
    (hc.issues || []).filter(i => i.level === 'error' && !['dupTask', 'dupTaskCode'].includes(i.k)).length === 0,
    (hc.issues || []).filter(i => i.level === 'error').map(i => i.k));
  const audit = S.auditByChangelog();
  ok(`按日志核对能查出 ${audit.length} 处不一致（预期 4 处：2 条任务 × 状态/进度）`, audit.length === 4, audit.length);

  finish();
}

function finish() {
  console.log('\n' + '='.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('自检异常：', e); process.exit(1); });
