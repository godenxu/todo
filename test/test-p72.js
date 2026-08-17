/* P72：用户反馈的三项——
   ① 定时备份到点了老提示"文件夹授权没了，要重新确认"：根因是共享文件那条句柄已经有一套
      "刷新页面后授权失效，用户随便点一下页面就静默要回来"的机制（armPermissionAutoRestore），
      但备份文件夹的句柄是完全独立存的一份（idbGetBackupDir，不是 idbGetHandle），从来没配
      同样的自愈机制——它唯一的恢复路径是管理员想起来去点"立即备份一次"。开机时加一次主动摸底
      （checkBackupPermOnBoot），失效就挂上跟共享文件那条同样思路的一次性点击监听
      （armBackupPermAutoRestore），定时器自动触发时发现失效也一样挂上，管理员根本不用特意
      去点哪个按钮，正常用着用着点一下页面就把授权续上了。
   ② 报告页"本期已交付里程碑"模块：饼图/清单按"行领导→部门领导→处室领导"排列（级别越高越靠前），
      且饼图扇区/图例可以点选按呈报层级筛下面的清单（再点一次取消），就地筛不跳页。
   ③ 报告页打印/导出 PDF 时人员工作矩阵右侧列被截掉：根因是矩阵在屏幕上是"固定列宽 + 横向
      滚动"（.matrix-wrap: overflow-x:auto），打印时浏览器不会展开或分页这种可滚动容器，只会
      照渲染出来的宽度原样截断——人一多，矩阵表格总宽度早就超过打印页面宽度，超出部分直接消失。
      打印时改成"总宽度锁定 100%、人员列宽自动摊分"，永远不会超出这一页。
   用法：node test/test-p72.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, q, raw } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

function makeBackupDir(perm) {
  const written = [];
  return {
    name: 'P72备份目标',
    kind: 'directory',
    _perm: perm,
    async requestPermission() { return this._perm; },
    async queryPermission() { return this._perm; },
    async getFileHandle(fileName) {
      written.push(fileName);
      return { async createWritable() { return { async write() {}, async close() {} }; } };
    },
    _written: written,
  };
}

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();

  /* ================= ①：定时备份授权自动恢复 ================= */
  section('①：checkBackupPermOnBoot——没配备份文件夹时什么都不做');
  raw.idbGetBackupDir = async () => null;
  S.setBackupPermLapsed(false);
  await S.checkBackupPermOnBoot();
  ok('没有备份文件夹，不会莫名其妙挂上"授权失效"标记', S.backupPermLapsed === false);

  section('①：★checkBackupPermOnBoot——开机时授权已经失效（刷新页面后常见的 prompt 状态）');
  const dir1 = makeBackupDir('prompt');
  raw.idbGetBackupDir = async () => dir1;
  await S.checkBackupPermOnBoot();
  ok('★检测到失效，标记挂上了', S.backupPermLapsed === true);

  section('①：★armBackupPermAutoRestore——挂上一次性点击监听，点一下就静默把授权要回来');
  const listeners = [];
  const bakAdd = raw.document.addEventListener, bakRemove = raw.document.removeEventListener;
  raw.document.addEventListener = (type, fn) => { if (type === 'click') listeners.push(fn); };
  raw.document.removeEventListener = (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };

  S.setBackupPermLapsed(false);
  S.armBackupPermAutoRestore();
  ok('不需要恢复时不挂监听（不留垃圾监听器）', listeners.length === 0);

  S.setBackupPermLapsed(true);
  S.armBackupPermAutoRestore();
  ok('★需要恢复时挂上了一次性点击监听', listeners.length === 1);

  // 让 DB 里从没备份过，backupDue() 恒真，验证"要回授权后顺手把拖欠的这一次补上"
  S.DB.shareConfig = { autoBackupEnabled: true, autoBackupHours: S.BACKUP_MIN_HOURS };
  S.DB.settings.autoBackupAt = '';
  dir1._perm = 'granted';   // 模拟用户点了一下页面，浏览器原生授权框（如果弹了的话）被点了"允许"
  await listeners[0]();
  await tick(20);
  ok('★点击后授权标记清掉了', S.backupPermLapsed === false);
  ok('监听是一次性的，用完自己摘掉了（不会反复弹授权框骚扰管理员）', listeners.length === 0);
  ok('★顺手把拖欠的这一次备份也补上了（不用干等下一轮定时器）', dir1._written.length === 1, dir1._written);
  ok('DB 里的"上次自动备份"时间也更新了', !!S.DB.settings.autoBackupAt);

  raw.document.addEventListener = bakAdd; raw.document.removeEventListener = bakRemove;

  section('①：runBackup 自动路径（定时器触发，没有用户手势）——授权失效时跳过并自己挂上监听');
  const listeners2 = [];
  raw.document.addEventListener = (type, fn) => { if (type === 'click') listeners2.push(fn); };
  raw.document.removeEventListener = (type, fn) => { const i = listeners2.indexOf(fn); if (i >= 0) listeners2.splice(i, 1); };
  const dir2 = makeBackupDir('prompt');
  raw.idbGetBackupDir = async () => dir2;
  S.setBackupPermLapsed(false);
  const autoResult = await S.runBackup(false);
  ok('自动路径授权失效时返回 false（这一轮确实跳过了）', autoResult === false);
  ok('★没有用户手势，不会直接调 requestPermission 硬弹授权框', dir2._written.length === 0);
  ok('★自动挂上了点击监听，不用管理员特意去点"立即备份一次"', listeners2.length === 1 && S.backupPermLapsed === true);
  raw.document.addEventListener = bakAdd; raw.document.removeEventListener = bakRemove;

  section('①：回归——manual=true（点"立即备份一次"）时还是走原来那条路，直接当场要授权');
  const dir3 = makeBackupDir('prompt');
  raw.idbGetBackupDir = async () => dir3;
  dir3.requestPermission = async function () { this._perm = 'granted'; return 'granted'; };
  const manualResult = await S.runBackup(true);
  ok('手动点"立即备份一次"，有用户手势，当场要回授权并备份成功', manualResult === true);
  ok('确实写了一份备份文件', dir3._written.length === 1);

  section('①：回归——授权本来就是好的，不会平白挂上失效标记');
  const dir4 = makeBackupDir('granted');
  raw.idbGetBackupDir = async () => dir4;
  S.setBackupPermLapsed(true);   // 故意先设成 true，验证走完 runBackup 之后会被正确清掉
  await S.runBackup(false);
  ok('授权是好的，跑完自动备份后标记被清掉了，不会一直挂着等点击', S.backupPermLapsed === false);

  raw.idbGetBackupDir = async () => null;   // 还原，别影响后面的用例

  /* ================= ②：本期已交付里程碑——按层级排序 + 点选筛选 ================= */
  section('②：★DELIVERED_MS_LEVEL_ORDER——行领导→部门领导→处室领导，级别越高越靠前');
  ok('★顺序确实是 bank, department, section', S.DELIVERED_MS_LEVEL_ORDER.join(',') === 'bank,department,section');
  ok('★没传 order 时 msReportLevelStatsOf 还是 REPORT_LEVELS 原始顺序（不影响其它调用方）',
    S.msReportLevelStatsOf([]).map(s => s.v).join(',') === S.REPORT_LEVELS.map(l => l.v).join(','));
  const reordered = S.msReportLevelStatsOf([], S.DELIVERED_MS_LEVEL_ORDER);
  ok('★传了 order 就按 order 排', reordered.map(s => s.v).join(',') === 'bank,department,section');
  const original = S.msReportLevelStatsOf([]);
  ok('★颜色始终跟着"这个层级本来的位置"走，不随显示顺序变——同一层级不管在哪张图颜色都一样',
    reordered.find(s => s.v === 'bank').color === original.find(s => s.v === 'bank').color
    && reordered.find(s => s.v === 'section').color === original.find(s => s.v === 'section').color);

  section('②：★渲染验证——清单/图例真的按行领导→部门领导→处室领导排');
  await S.Repo.upsert('duty', { code: 'P72D', name: 'P72交付层级测试职责' });
  await S.Repo.upsert('work', { id: 'p72_w', duty: 'P72D', code: 'W1', name: 'P72交付层级测试工作', owner: '甲', year: new Date().getFullYear() });
  await S.Repo.upsert('task', { id: 'p72_t', work: 'p72_w', title: 'P72交付层级测试任务', status: 'doing', owner: '甲', assignees: [], plan_date: S.offsetDate(5) });
  await S.Repo.upsert('milestone', { id: 'p72_ms_section', task: 'p72_t', plan_date: S.todayStr(), deliverable: 'P72处室交付物', report_level: 'section', done: '1', actual_date: S.todayStr() });
  await S.Repo.upsert('milestone', { id: 'p72_ms_department', task: 'p72_t', plan_date: S.todayStr(), deliverable: 'P72部门交付物', report_level: 'department', done: '1', actual_date: S.todayStr() });
  await S.Repo.upsert('milestone', { id: 'p72_ms_bank', task: 'p72_t', plan_date: S.todayStr(), deliverable: 'P72行领导交付物', report_level: 'bank', done: '1', actual_date: S.todayStr() });
  S.rebuildIndex();
  S.setReportPeriod('week'); S.setReportOffset(0);
  let d = S.buildReportData('week', 0);
  ok('三条交付都落进了本期已交付清单', d.deliveredInRange.length >= 3);
  S.setReportDeliveredMsLevelFilter('');
  let modHtml = S.REPORT_MODULE_MAP.deliveredMs.html(d);
  const idxBank = modHtml.indexOf('行领导'), idxDept = modHtml.indexOf('部门领导'), idxSection = modHtml.indexOf('处室领导');
  ok('★"行领导"排在"部门领导"前面', idxBank > -1 && idxDept > -1 && idxBank < idxDept, { idxBank, idxDept });
  ok('★"部门领导"排在"处室领导"前面', idxDept > -1 && idxSection > -1 && idxDept < idxSection, { idxDept, idxSection });

  section('②：★饼图扇区/图例都带了可点选筛选的 data-act');
  ok('★饼图扇区带 data-act="report-delivered-ms-level-filter"', /pie-slice-clickable[^"]*"\s*data-act="report-delivered-ms-level-filter" data-level="bank"/.test(modHtml));
  ok('★图例也带同样的 data-act（点图例一样能筛）', /data-act="report-delivered-ms-level-filter" data-level="department"/.test(modHtml));

  section('②：★点选筛选——就地筛清单，不跳页；再点一次取消');
  await S.ACTIONS['report-delivered-ms-level-filter']({ level: 'bank' });
  ok('★点了"行领导"，筛选状态记下了', S.reportDeliveredMsLevelFilter === 'bank');
  modHtml = S.REPORT_MODULE_MAP.deliveredMs.html(d);
  ok('★清单里只剩行领导那条交付物了', modHtml.includes('P72行领导交付物') && !modHtml.includes('P72部门交付物') && !modHtml.includes('P72处室交付物'));
  ok('★正文提示"已按「行领导」筛选"，并给了清除筛选的出口', modHtml.includes('已按「行领导」筛选') && modHtml.includes('清除筛选'));
  ok('★被选中的那个扇区/图例带上了 active 标记（一眼看出选的是哪个）', /class="clickable active"[^>]*data-level="bank"/.test(modHtml));
  ok('★标题旁边的数字（titleCount）不受筛选影响，还是三条全算（筛选只影响正文清单）',
    S.REPORT_MODULE_MAP.deliveredMs.titleCount(d) === d.deliveredInRange.length);

  await S.ACTIONS['report-delivered-ms-level-filter']({ level: 'bank' });
  ok('★再点一次同一个层级，筛选取消了', S.reportDeliveredMsLevelFilter === '');
  modHtml = S.REPORT_MODULE_MAP.deliveredMs.html(d);
  ok('取消筛选后三条交付物都回来了', modHtml.includes('P72行领导交付物') && modHtml.includes('P72部门交付物') && modHtml.includes('P72处室交付物'));

  section('②：★图片导出（canvas 出口）要跟屏幕上看到的一致——筛选过就导出筛选后的那部分');
  await S.ACTIONS['report-delivered-ms-level-filter']({ level: 'department' });
  let capturedList = null, capturedPieData = null;
  // P83 这轮 deliveredMs 的 canvas() 补上了饼图（见 REPORT_MODULES 里 deliveredMs 那段注释：
  // 之前 html() 明明是"饼图+清单"两段，canvas() 只画了清单，图片里饼图消失了），mockApi 也
  // 得跟着补上 pie，不然这个假 api 连 canvas() 都跑不完就先抛异常了
  const mockApi = { msRows: (list) => { capturedList = list; }, pie: (data) => { capturedPieData = data; } };
  S.REPORT_MODULE_MAP.deliveredMs.canvas(d, mockApi);
  ok('★canvas 出口只拿到了筛选后的部门领导那一条', capturedList.length === 1 && capturedList[0].report_level === 'department');
  ok('★饼图喂的是全量分布（不跟着筛选走）——三个层级都在，不只是筛出来的那一份',
    capturedPieData.reduce((sum, s) => sum + s.n, 0) === d.deliveredInRange.length);

  section('②：文本导出不跟着屏幕上的筛选走——正式简报要完整记录，不该漏掉');
  const textLines = [];
  S.REPORT_MODULE_MAP.deliveredMs.text(d, t => textLines.push(t));
  ok('★文本里三条交付物都在，没有因为屏幕上筛了"部门领导"就漏掉别的',
    textLines.some(t => t.includes('P72行领导交付物')) && textLines.some(t => t.includes('P72部门交付物')) && textLines.some(t => t.includes('P72处室交付物')));

  S.setReportDeliveredMsLevelFilter('');

  /* ================= ③：打印/导出 PDF 时人员工作矩阵列被截掉 ================= */
  section('③：★打印专属 CSS——矩阵改成总宽度锁定 100%、人员列宽自动摊分，不再横向溢出');
  const printBlockMatch = html.match(/@media print \{[\s\S]*?\n\}/);
  ok('★确实找到了 @media print 这个块', !!printBlockMatch);
  const printBlock = printBlockMatch ? printBlockMatch[0] : '';
  ok('★打印时 .matrix-wrap 从 auto 滚动改成 visible（不再是个会被截断的滚动容器）',
    /\.matrix-wrap\s*\{\s*overflow-x:\s*visible;\s*\}/.test(printBlock));
  ok('★打印时 .matrix-table 宽度锁定 100%（永远不会比这一页更宽）', /\.matrix-table\s*\{\s*width:\s*100%/.test(printBlock));
  ok('★打印时人员列改成 width:auto，交给 table-layout:fixed 在剩余空间里平分（人越多列越窄，但都在）',
    /col\.col-person\s*\{\s*width:\s*auto;\s*\}/.test(printBlock));

  section('③：回归——屏幕上（非打印）的矩阵列宽/滚动行为完全没变');
  const nonPrintRule = html.match(/\.matrix-wrap \{ overflow-x: auto; \}/);
  ok('★屏幕上 .matrix-wrap 还是 overflow-x:auto（P70 定下来的交互行为没被这次改动动到）', !!nonPrintRule);
  const nonPrintPersonCol = html.match(/\.matrix-table col\.col-person \{ width: 46px; \}/);
  ok('★屏幕上人员列宽还是固定 46px，只有打印时才改成自动摊分', !!nonPrintPersonCol);

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
