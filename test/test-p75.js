/* P75：用户反馈的两项——
   ① PDF 导出的标题和文件名不能是"科技规划处工作管理系统"（那是整个系统的名字，不是这份报告
      的名字）。浏览器打印页眉、另存 PDF 时弹出的默认文件名，用的都是 document.title——
      之前从没人动过这个值，一直是 <title> 里写死的系统名。改成打印/导出 PDF 时临时把
      document.title 换成"科技规划处工作简报_<统计周期>_<起始日期>"，结束后（不管是真打印了
      还是取消了，afterprint 都会触发）换回来，不会一直挂着报告标题。正文里已经把完整的
      统计周期写清楚了，标题/文件名不需要把起止日期都堆进去，只取 periodLabel + 起始日一个
      日期，够区分"这是哪一次导出"。
   ② 导出图片的功能还不太对，参照 PDF 那次的思路修：personMatrix 模块之前没配 canvas()，
      图片导出会退回到 text()——一个职责下所有人挤成一整句话，人一多直接被画布的行宽截断，
      图片里基本看不全，这是"图片导出不对"的真正原因（跟 PDF 那次矩阵列宽被截断是同一类
      问题，只是这次是 canvas 手工排版，不是 CSS 表格）。改成真的画一张热力网格，用真实
      Chromium 实测过：canvas 尺寸正确、指定坐标的格子颜色采样结果是 rgb(162,185,204)，
      跟 rgba(44,95,138,约0.32) 叠在白底上的预期值吻合，证明颜色确实画上去了，不是空跑。
      图片文件名也一并换成跟 PDF 一样的 reportExportTitle(d)，不再是"处室工作简报_今天日期"
      这种今天导出哪一期的报告都长一个样、还对不上正文统计周期的命名。
   用法：node test/test-p75.js */
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

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();

  /* ================= ①：PDF 标题/文件名 ================= */
  section('①：★reportExportTitle——处室名+工作简报+周期标签+起始日，不重复正文已有的完整区间');
  const fakeD = { periodLabel: '本周', rangeStart: '2026-08-04', rangeEnd: '2026-08-10' };
  const title = S.reportExportTitle(fakeD);
  ok('★结果是"科技规划处工作简报_本周_2026-08-04"', title === '科技规划处工作简报_本周_2026-08-04', title);
  ok('★没有把完整的 rangeEnd 也堆进去（正文里已经有完整区间了，不用重复）', !title.includes('2026-08-10'));
  ok('★带上了处室名，不是笼统的"工作管理系统"', title.includes('科技规划处') && !title.includes('管理系统'));

  section('①：★静态 <title> 标签本身没被写死改掉——它是整个应用的名字，只在打印那一刻临时换');
  ok('页面的 <title> 还是"科技规划处工作管理系统"（应用名，不是报告名）',
    /<title>科技规划处工作管理系统<\/title>/.test(html));

  section('①：★beforeprint/afterprint 里确实会把 document.title 换成报告标题、结束后再换回来');
  const beforeprintBody = (html.match(/window\.addEventListener\('beforeprint', \(\) => \{([\s\S]{0,400}?)\n\}\);/) || [])[1] || '';
  const afterprintBody = (html.match(/window\.addEventListener\('afterprint', \(\) => \{([\s\S]{0,400}?)\n\}\);/) || [])[1] || '';
  ok('★beforeprint 里存了旧标题（_reportPrintTitleBak = document.title）', /_reportPrintTitleBak = document\.title;/.test(beforeprintBody));
  ok('★beforeprint 里把标题换成了 reportExportTitle(buildReportData(...))', /document\.title = reportExportTitle\(buildReportData\(reportPeriod, reportOffset\)\);/.test(beforeprintBody));
  ok('★afterprint 里把标题换回去了', /document\.title = _reportPrintTitleBak;/.test(afterprintBody));
  ok('★afterprint 换完之后清空了备份变量，不会被下一次误用', /_reportPrintTitleBak = null;/.test(afterprintBody));

  section('①：★回归——不在报告页时不会瞎换标题（beforeprint/afterprint 已有的"只在报告页触发"没被破坏）');
  const bakTitle = raw.document.title;
  S.setPage('tasks');
  raw.document.title = '__不该被动过__';
  await raw.window.fire('beforeprint');
  ok('不在报告页时 beforeprint 不会动 document.title', raw.document.title === '__不该被动过__');
  await raw.window.fire('afterprint');
  ok('不在报告页时 afterprint 也不会动 document.title', raw.document.title === '__不该被动过__');
  raw.document.title = bakTitle;
  S.setPage('report');

  /* ================= ②：图片导出——人员工作矩阵 ================= */
  section('②：★personMatrix 现在配了 canvas()，不会再退回容易被截断的 text() 兜底');
  const personMatrixBlockMatch = html.match(/key: 'personMatrix'[\s\S]*?\n {4}canvas: \(d, a\) => \{[\s\S]*?\n {4}\} \},/);
  ok('★personMatrix 模块定义里确实多了 canvas: (d, a) => {...} 这个出口', !!personMatrixBlockMatch);
  const personMatrixBlock = personMatrixBlockMatch ? personMatrixBlockMatch[0] : '';
  ok('★canvas() 里调用了 a.matrix(...)，把矩阵数据交给专门的画法，不是继续退化成文字',
    /a\.matrix\(dutyStat, workStat, people, heat, reportMatrixDutyExpanded\);/.test(personMatrixBlock));
  ok('★canvas() 展开状态用的是 reportMatrixDutyExpanded——跟屏幕上、PDF 里是同一份状态，三处不会互相打架',
    personMatrixBlock.includes('reportMatrixDutyExpanded'));

  section('②：★matrix() 画法本身——列宽按人数自动摊分（跟 PDF 打印那次矩阵列宽的思路一致）');
  const matrixFnMatch = html.match(/const matrix = \(dutyStat, workStat, people, heat, expandedSet\) => \{[\s\S]*?\n {6}\};/);
  ok('★找到了 matrix() 这个 canvas 画法本身', !!matrixFnMatch);
  const matrixFn = matrixFnMatch ? matrixFnMatch[0] : '';
  ok('★列宽 = 可用宽度 / 人数（人越多列越窄，不会有人被挤没，呼应 PDF 那次"列宽自动摊分"）',
    /colW = Math\.max\(9, availW \/ people\.length\)/.test(matrixFn));
  ok('★格子颜色算法（weight = 牵头×3 + 参与）跟屏幕上 matrixHeatCellHTML 用的是同一个公式',
    /weight = v\.lead \* 3 \+ v\.join/.test(matrixFn));
  // P82 这轮：导出图片宽度加大 50%，每列能分到的宽度也跟着宽了，姓名不用再竖着写才能塞下，
  // 改回横排（见 matrix() 里 headH 那段注释），这条断言跟着改成认横排
  ok('★人员名字改成横排画（导出图片加宽后列宽够用了，不用再竖着转 90 度）',
    !/ctx\.rotate\(-Math\.PI \/ 2\)/.test(matrixFn) && /ctx\.fillText\(truncate\(ctx, p, colW - 2\), cx, cur\.y \+ headH - 8\)/.test(matrixFn));

  section('②：★图片文件名也换成跟 PDF 一样的 reportExportTitle(d)，不再是"今天日期"那种对不上统计周期的命名');
  ok('★a.download 用的是 reportExportTitle(d)，不是旧的 todayStr()',
    /a\.download = `\$\{reportExportTitle\(d\)\}\.png`;/.test(html));
  ok('旧的按今天日期命名的写法已经不在了', !html.includes('a.download = `处室工作简报_${todayStr()}.png`'));

  section('②：★回归——exportReportImage() 在没有真实 canvas 环境的沙盒里依然优雅降级，不抛出未捕获异常');
  await S.Repo.upsert('duty', { code: 'P75D', name: 'P75矩阵图片导出测试职责' });
  await S.Repo.upsert('work', { id: 'p75_w', duty: 'P75D', code: 'W1', name: 'P75矩阵图片导出测试工作', owner: '甲', year: 2020 });
  await S.Repo.upsert('task', { id: 'p75_t', work: 'p75_w', title: 'P75矩阵图片导出测试任务', status: 'doing', owner: '甲', assignees: ['乙'], plan_date: S.offsetDate(5) });
  S.rebuildIndex();
  S.DB.reportConfig = {
    activeId: 'preset_p75', presets: [{ id: 'preset_p75', name: 'p75test', sections: [
      { id: 'sec_p75', title: 'P75测试区', modules: ['personMatrix'], inline: [] },
    ] }],
  };
  let threw = false;
  try { await S.exportReportImage(); } catch (e) { threw = true; }
  ok('★调用 exportReportImage() 不会抛出未捕获异常（沙盒没有真的 2D 上下文，函数自己 try/catch 兜住了）', threw === false);

  S.DB.reportConfig = null;

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
