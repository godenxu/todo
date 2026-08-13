/* P56：本轮三项改动测试——
   ① 日志页新增文本搜索框：跟"全部/登录"等类型按钮同一行，最右侧
   ② 报告导出图片右侧文字被裁切的修复：进度条右边"12/34 · 88%"预留了画布空间
   ③ 报告页两个"处室工作简报"面板合并成一个，"报告编排"挪到它上面，去掉多余提示文字
   用法：node test/test-p56.js */
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
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const bakChangelog = JSON.parse(JSON.stringify(S.DB.changelog || []));
  const bakLogsUI = JSON.parse(JSON.stringify(S.UI.logs));
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.changelog = bakChangelog;
    Object.assign(S.UI.logs, bakLogsUI);
  };
  S.DB.settings.me = '测试管理员';

  /* ====================== ① 日志文本搜索框 ====================== */
  section('①：UI.logs 默认状态里有 text 字段，默认空');
  ok('默认是空字符串（不是 undefined，否则 esc() 会拼出 "undefined"）', S.UI.logs.text === '' || bakLogsUI.text === '');

  section('①：filterLogs 支持按文本搜索——匹配摘要或操作人姓名，不区分大小写');
  const sample = [
    { id: 'p56_a', at: '2026-08-01T01:00:00.000Z', by: '张三', kind: 'edit', summary: '任务：修改了 Gartner 服务账号相关内容' },
    { id: 'p56_b', at: '2026-08-01T02:00:00.000Z', by: '李四', kind: 'edit', summary: '工作：更新了 IDC 基础设施专项规划' },
    { id: 'p56_c', at: '2026-08-01T03:00:00.000Z', by: 'ABC测试', kind: 'login', summary: '登录了系统' },
  ];
  const byText = t => S.filterLogs(sample, { text: t });
  ok('★按摘要内容中的关键词能搜到', byText('Gartner').length === 1 && byText('Gartner')[0].id === 'p56_a');
  ok('★按操作人姓名也能搜到', byText('李四').length === 1 && byText('李四')[0].id === 'p56_b');
  ok('不区分大小写', byText('abc').length === 1 && byText('abc')[0].id === 'p56_c');
  ok('搜不到的关键词返回空', byText('这个词肯定搜不到任何东西xyz').length === 0);
  ok('空字符串等于不筛选（全部返回）', byText('').length === 3);
  ok('搜索能跟类型筛选叠加使用', S.filterLogs(sample, { text: '了', kind: 'login' }).length === 1
    && S.filterLogs(sample, { text: '了', kind: 'login' })[0].id === 'p56_c');
  ok('搜索能跟人员筛选叠加使用', S.filterLogs(sample, { text: '任务', who: '张三' }).length === 1);
  ok('两个条件都不满足时返回空（不是"任一满足"）', S.filterLogs(sample, { text: '任务', who: '李四' }).length === 0);

  section('①：页面渲染——搜索框在类型按钮同一行，位置在最右侧');
  S.DB.changelog = sample.map(e => Object.assign({ taskId: '' }, e));
  Object.assign(S.UI.logs, { range: 'all', kind: 'all', who: '', text: '', page: 1 });
  S.goto('logs');
  let logsHtml = q('#page-logs').innerHTML;
  ok('能正常进入日志页', S.currentPage === 'logs');
  ok('★搜索框存在', logsHtml.includes('id="logs-text"'));
  const filtersRow = logsHtml.slice(logsHtml.indexOf('class="log-filters"'), logsHtml.indexOf('class="log-filters"') + 900);
  ok('★搜索框跟类型按钮（kindBtns）在同一个 .log-filters 行里', filtersRow.includes('data-act="logs-kind"') && filtersRow.includes('id="logs-text"'));
  ok('★搜索框是这一行里最后一个控件（最右侧），排在人员下拉和条数提示之后',
    filtersRow.indexOf('id="logs-who"') < filtersRow.indexOf('id="logs-text"')
    && filtersRow.indexOf('共') < filtersRow.indexOf('id="logs-text"'));
  ok('占位符提示的是搜索日志内容', logsHtml.includes('placeholder="搜索日志内容…"'));

  section('①：搜索关键词生效后，表格只显示匹配的行，类型/时间段按钮上的计数也跟着变');
  Object.assign(S.UI.logs, { text: 'Gartner' });
  S.renderLogs();
  logsHtml = q('#page-logs').innerHTML;
  ok('★表格里只剩匹配的那一行', logsHtml.includes('Gartner') && !logsHtml.includes('IDC 基础设施'));
  ok('搜索框里回显了当前关键词', logsHtml.includes('value="Gartner"'));
  // 带条数的是时间段按钮（今天/昨天/本周/本月/全部），不是类型按钮——类型按钮本来就不带数字
  ok('★"全部"时间段按钮上的计数也跟着搜索结果变成 1（不是全部 3 条）', /data-act="logs-range" data-range="all">全部 1</.test(logsHtml), logsHtml.match(/data-act="logs-range"[^<]*>[^<]*/g));
  Object.assign(S.UI.logs, { text: '' });
  S.renderLogs();

  /* ====================== ② 报告导出图片右侧文字裁切 ====================== */
  section('②：bar() 给右边的百分比文字留出了画布空间，不再顶格画到边界外');
  // 这段只能做源码结构校验：沙盒里 document.createElement('canvas') 拿到的是通用 DOM 桩，
  // 没有真的 getContext('2d')，exportReportImage() 会在最开始就优雅降级退出，
  // layout()/bar() 内部逻辑根本执行不到，没法在这里用真实 canvas 量像素——
  // 真实的边界验证在浏览器里用 measureText 做过，这里锁的是"算法本身有没有留出空间"。
  // P77 起 bar() 改成按 cur.x0/cur.w（当前列的起点/宽度）取值，不再是写死的页面级 PAD/W——
  // 并排布局落地之后，一个模块可能只占半页宽，留白算法得对"任意列宽"成立，不能只对整页宽成立。
  const NUM_W_DEF = html.match(/const NUM_W = (\d+);/);
  ok('★定义了给右侧文字留白的常量 NUM_W', !!NUM_W_DEF, NUM_W_DEF);
  const barWLine = html.match(/const barX = cur\.x0 \+ 200, barW = ([^,]+), barH = 13;/);
  ok('★barW 的算式里减去了 NUM_W（不再是顶格到列边界的 cur.w - 200）',
    !!barWLine && /NUM_W/.test(barWLine[1]), barWLine && barWLine[1]);
  ok('右侧文字本身也做了截断（truncate 到 NUM_W 宽度以内），双保险防止极端长文字仍然溢出',
    /truncate\(ctx, `\$\{c\.done\}\/\$\{c\.total\} · \$\{c\.rate\}%`, NUM_W\)/.test(html));
  if (NUM_W_DEF && barWLine) {
    // 用跟源码一致的算式反推一下：barX + barW + 8（文字起点）+ NUM_W（文字最大宽度）应该正好落在
    // cur.x0 + cur.w（这一列的右边界）——换两组不同的 x0/w（模拟整页宽 vs 并排时的半页宽）
    // 都验一遍，证明这套留白算法不是只对某个特定宽度凑巧成立
    const NUM_W = Number(NUM_W_DEF[1]);
    [{ x0: 24, w: 812 }, { x0: 460, w: 376 }].forEach(({ x0, w }) => {
      const barX = x0 + 200;
      const barW = eval(barWLine[1].replace(/NUM_W/g, NUM_W).replace(/cur\.w/g, w));
      ok(`★按当前常量实算（列宽 ${w}）：文字最右端刚好落在这一列的右边界，不会超出去`,
        barX + barW + 8 + NUM_W === x0 + w, { barX, barW, textEnd: barX + barW + 8 + NUM_W, colRight: x0 + w });
    });
  }

  /* ====================== ③ 报告页面板合并 ====================== */
  section('③：两个"处室工作简报"面板合并成一个，多余的提示文字都去掉了');
  S.goto('report');
  let repH = q('#page-report').innerHTML;
  const titleOccurrences = (repH.match(/处室工作简报/g) || []).length;
  ok('★"处室工作简报"这几个字在整页里只出现一次（以前是两块面板各一次）', titleOccurrences === 1, titleOccurrences);
  ok('标题和统计周期文字合并到了同一行', /📋 处室工作简报　·　统计周期：/.test(repH));
  ok('★"内容跟着当前数据实时变化…"这段说明文字被去掉了', !repH.includes('内容跟着当前数据实时变化'));
  ok('★导出按钮后面不再跟着一段重复的"统计周期：xxx"文字（这句已经并进标题了）',
    (repH.match(/统计周期：/g) || []).length === 1);
  ok('打印和导出图片按钮还在', repH.includes('data-act="report-print"') && repH.includes('data-act="report-image"'));
  ok('周期按钮（按周/按月/按季/按年）还在', repH.includes('data-act="report-period"'));
  ok('翻期按钮还在', repH.includes('data-act="report-period-nav"'));

  section('③：合并后的面板本身不是 no-print（打印时标题还要露出来），交互控件单独标了 no-print');
  const mergedPanelIdx = repH.indexOf('📋 处室工作简报　·　统计周期');
  const beforeTitle = repH.slice(Math.max(0, mergedPanelIdx - 120), mergedPanelIdx);
  ok('★包着标题的这个 panel 不带 no-print（否则打印/导出图片时标题会一起消失）',
    /<div class="panel"><div class="panel-h">\s*$/.test(beforeTitle.replace(/\s+$/, '') + '\n')
    || beforeTitle.includes('<div class="panel"><div class="panel-h">'), beforeTitle);
  ok('周期/翻期按钮包在 no-print 里（纸上/图片里没必要留一排点不动的按钮）',
    /<span class="no-print"[^>]*><span class="seg-ctrl">[\s\S]{0,40}data-act="report-period"/.test(repH));
  ok('打印/导出按钮所在的 panel-b 也标了 no-print', /<div class="panel-b no-print">\s*<button[^>]*data-act="report-print"/.test(repH));

  section('③："报告编排"区域挪到了"处室工作简报"上面');
  const idxConfig = repH.indexOf('报告编排');
  const idxReport = repH.indexOf('处室工作简报');
  ok('管理员能看到报告编排入口', idxConfig > -1);
  ok('★报告编排排在处室工作简报前面', idxConfig > -1 && idxReport > -1 && idxConfig < idxReport,
    { idxConfig, idxReport });

  section('③：非管理员看不到报告编排面板，但合并后的简报面板正常，顺序问题无从谈起');
  S.DB.users.push({ name: 'P56员工', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = 'P56员工';
  S.DB.permissionMatrix = null;
  S.renderReport();
  const staffHtml = q('#page-report').innerHTML;
  ok('普通员工看不到"报告编排"面板', !staffHtml.includes('报告编排'));
  ok('但简报本身仍然是合并后的单一面板', (staffHtml.match(/处室工作简报/g) || []).length === 1);
  S.DB.permissionMatrix = null;
  S.DB.settings.me = '测试管理员';

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
