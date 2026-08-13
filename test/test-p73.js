/* P73：用户反馈"导出PDF还是不对，而且很多图表都显示不完整"——继续排查 P72 那次矩阵修复
   之外，报告页里其它图表在打印/导出 PDF 时也被截断的问题。

   根因排查：到期分布/各年度工作数量/待办任务总量趋势/各月计划完成量这几个模块，图表本体
   是没有 viewBox 的定宽 SVG（reportChartWidth 上面的注释早就写明"折线/柱状图是定宽 SVG，
   缩不了"），外面套了层 svgScroll()——一个 overflow-x:auto 的 div，是给"窄屏时与其撑破版面，
   不如自己横向滚动"用的安全阀。屏幕上没问题，人可以滚动看完；但浏览器打印时不会展开或分页
   这种可滚动容器，只按渲染出来的宽度原样截断，滚动条能看到的部分打印出来直接消失——这跟
   P72 那次矩阵表格被截是同一类根因（矩阵是表格列宽固定，这些是 SVG 像素宽度固定），只是
   矩阵能用"不写死列宽、交给浏览器按比例分"这种纯 CSS 手段解决，没有 viewBox 的 SVG 做不到
   （硬把它塞进更窄的框只会裁掉一块，不会等比缩小）。

   真正的病根：这些图表的像素宽度（w / ctx.width / colW，一路往上追都来自 renderReport 里
   `$('#page-report').clientWidth`）是按屏幕上的宽度量出来的，从来没有为打印页面重新量过、
   重新画过——renderReport() 只在用户打开报告页那一刻跑一次。
   修法：用 beforeprint/afterprint 这对事件——Chrome 触发 beforeprint 之前就已经把打印样式表
   应用、按打印页面的实际宽度重排过一遍了，这时候再调一次 renderReport()，
   `$('#page-report').clientWidth` 量到的就是打印页面能用的宽度，所有模块会照着这个真实尺寸
   重新画一遍再插进 DOM，打印引擎抓到的就是已经画对了尺寸的版本；afterprint 时再调一次换回来，
   不然打印对话框关掉之后屏幕上的图表宽度会一直停在打印那个窄尺寸上。只在报告页触发，不影响
   其它页面自己的 Ctrl+P。
   已经用真实 Chromium（Claude Browser）实测验证：把 #page-report 的容器宽度从 1274px 收窄到
   774px 后触发 beforeprint，到期分布这张图的 SVG width 从 1026 正确收窄到 526，各年度工作
   数量/待办总量趋势/各月计划完成量那几张图从 1208 收窄到 708，所有 overflow-x:auto 容器的
   scrollWidth 都变得跟 clientWidth 一致（溢出量为 0，不会再被截断）。
   用法：node test/test-p73.js */
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

function widthOf(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const seg = html.slice(idx, idx + 400);
  const m = seg.match(/<svg width="(\d+)"/);
  return m ? Number(m[1]) : null;
}

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();

  section('★源码里确实挂了 beforeprint/afterprint，且只在报告页触发');
  // P75 起这两个监听器还兼管标题切换（见 test-p75.js），这里只关心"只在报告页触发 + 会重新
  // renderReport()"这两件事本身，不管里面还夹了什么别的逻辑，用宽松一点的正则找函数体
  const beforeprintBlock = (html.match(/window\.addEventListener\('beforeprint', \(\) => \{([\s\S]{0,400}?)\n\}\);/) || [])[1] || '';
  const afterprintBlock = (html.match(/window\.addEventListener\('afterprint', \(\) => \{([\s\S]{0,400}?)\n\}\);/) || [])[1] || '';
  ok('★有 beforeprint 监听，且只在报告页（currentPage !== \'report\' 时提前 return）触发',
    /if \(currentPage !== 'report'\) return;/.test(beforeprintBlock));
  ok('★beforeprint 里确实会重新 renderReport()', /renderReport\(\);/.test(beforeprintBlock));
  ok('★有 afterprint 监听，同样只在报告页触发', /if \(currentPage !== 'report'\) return;/.test(afterprintBlock));
  ok('★afterprint 里也会重新 renderReport()', /renderReport\(\);/.test(afterprintBlock));

  section('★把带图表的模块加进报告编排，验证打印宽度重排真的生效');
  await S.Repo.upsert('duty', { code: 'P73D', name: 'P73打印宽度测试职责' });
  await S.Repo.upsert('work', { id: 'p73_w', duty: 'P73D', code: 'W1', name: 'P73打印宽度测试工作', owner: '甲', year: 2020 });
  await S.Repo.upsert('task', { id: 'p73_t1', work: 'p73_w', title: 'P73打印宽度测试任务1', status: 'todo', owner: '甲', assignees: [], plan_date: S.offsetDate(-5) });
  await S.Repo.upsert('task', { id: 'p73_t2', work: 'p73_w', title: 'P73打印宽度测试任务2', status: 'doing', owner: '乙', assignees: [], plan_date: S.offsetDate(10) });
  S.rebuildIndex();

  S.DB.reportConfig = {
    activeId: 'preset_p73', presets: [{ id: 'preset_p73', name: 'p73test', sections: [
      { id: 'sec_p73', title: 'P73打印宽度测试区', modules: ['taskDueDist', 'worksByYearBars', 'backlogTrend', 'planDueTrend'], inline: [] },
    ] }],
  };

  q('#page-report').clientWidth = 1200;
  S.goto('report');
  const wideHtml = q('#page-report').innerHTML;
  const wideDue = widthOf(wideHtml, 'data-due-fit');
  const wideYear = (wideHtml.match(/<svg width="(\d+)" height="190"/g) || []).map(s => Number(s.match(/width="(\d+)"/)[1]));
  ok('★宽容器（1200px）下，到期分布的 SVG 画出了一个较宽的像素宽度', wideDue !== null && wideDue > 500, wideDue);
  ok('★宽容器下，其它柱状图（年度/趋势/计划完成）也画出了较宽的宽度', wideYear.length > 0 && wideYear.every(w => w > 500), wideYear);

  section('★收窄容器宽度、触发 beforeprint——所有图表应该照新宽度重画，不再是旧的宽版本');
  q('#page-report').clientWidth = 600;
  await raw.window.fire('beforeprint');
  const narrowHtml = q('#page-report').innerHTML;
  const narrowDue = widthOf(narrowHtml, 'data-due-fit');
  const narrowYear = (narrowHtml.match(/<svg width="(\d+)" height="190"/g) || []).map(s => Number(s.match(/width="(\d+)"/)[1]));
  ok('★到期分布的 SVG 宽度确实跟着收窄了（不再是宽容器那个尺寸）', narrowDue !== null && narrowDue < wideDue, { wideDue, narrowDue });
  const wideYearMax = Math.max(...wideYear);
  ok('★其它柱状图也一起收窄了，不是只修了到期分布那一个模块',
    narrowYear.length > 0 && narrowYear.every(w => w < wideYearMax), { wideYear, narrowYear });

  section('★恢复宽容器、触发 afterprint——图表应该照屏幕上真实的宽度换回来，不会停在打印那个窄尺寸');
  q('#page-report').clientWidth = 1200;
  await raw.window.fire('afterprint');
  const restoredHtml = q('#page-report').innerHTML;
  const restoredDue = widthOf(restoredHtml, 'data-due-fit');
  ok('★afterprint 之后宽度换回了跟屏幕容器匹配的尺寸，不会停留在打印时的窄尺寸',
    restoredDue !== null && restoredDue > 500, { narrowDue, restoredDue });

  section('★回归——不在报告页时触发 beforeprint/afterprint 不会瞎动 #page-report');
  S.setPage('tasks');
  q('#page-report').innerHTML = '__不该被动过__';
  await raw.window.fire('beforeprint');
  await raw.window.fire('afterprint');
  ok('★不在报告页时，两个事件都不会重新渲染报告页内容', q('#page-report').innerHTML === '__不该被动过__');
  S.setPage('report');

  S.DB.reportConfig = null;

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
