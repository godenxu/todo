/* P74：用户反馈"大部分可以了，但人员工作矩阵还不对"——继续排查。

   P72 那次已经把矩阵打印时"列宽固定+横向滚动导致右侧列被截断"的问题修了（改成总宽度锁定
   100%、列宽自动摊分，见 test-p72.js），亲自用真实 Chromium 验证过收窄容器后列确实不再丢——
   但这只解决了"列会不会消失"，没解决另一个完全不同的问题：矩阵格子的热力颜色是靠
   `style="background:rgba(...)"` 画出来的（见 matrixHeatCellHTML），数字本身不带任何深浅
   信息，颜色才是这个模块唯一的信息载体。Chrome 打印/导出 PDF 默认不打印背景色（用户得自己
   去打印对话框里勾"背景图形"，几乎没人知道要勾这个），这是浏览器级别的默认行为——列宽的坑
   修完之后，矩阵打印出来变成一整片没有颜色的空白格子，只剩数字，等于看不出热力分布，这才是
   "还不对"的真正原因。柱状图/饼图用的是 SVG 的 fill 画色块，不受这条默认行为影响，这解释了
   为什么"大部分图表都正常了"，偏偏矩阵这种整格全靠 CSS background 画色的模块显得特别不对。

   修法：打印时用 print-color-adjust（标准属性）+ -webkit-print-color-adjust（Chrome 早期
   前缀，双写保险）强制打印背景色，作用范围给到 `*`（不止矩阵，职责/工作推进条、人员负荷条
   这些同样靠 background 画色段的模块原理上是同一个坑，一并解决，不用等下次又有人反馈别的
   模块"颜色不对"）。
   用法：node test/test-p74.js */
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

  section('★源码里矩阵热力格子确实是靠内联 background 画色，不是靠 SVG');
  ok('★matrixHeatCellHTML 用 style="background:rgba(...)" 画热力颜色',
    /style="background:rgba\(44,95,138,\$\{alpha\}\)"/.test(html));

  section('★@media print 里确实有 print-color-adjust: exact 这条强制打印背景色的规则');
  const printBlockMatch = html.match(/@media print \{[\s\S]*?\n\}/);
  ok('★找到了 @media print 这个块', !!printBlockMatch);
  const printBlock = printBlockMatch ? printBlockMatch[0] : '';
  ok('★标准属性 print-color-adjust: exact 有写，且带 !important（覆盖浏览器默认的"不打印背景"行为）',
    /print-color-adjust:\s*exact\s*!important/.test(printBlock));
  ok('★Chrome 早期的前缀写法 -webkit-print-color-adjust: exact 也双写了（老版本内核兼容）',
    /-webkit-print-color-adjust:\s*exact\s*!important/.test(printBlock));
  ok('★作用范围是 * （全局），不是只给矩阵——推进条/负荷条这些同样靠 background 画色的模块一并覆盖',
    /\*\s*\{\s*-webkit-print-color-adjust:\s*exact\s*!important;\s*print-color-adjust:\s*exact\s*!important;\s*\}/.test(printBlock));

  section('★这条规则确实在 @media print 里，不会污染屏幕上的正常显示（屏幕上颜色本来就一直有效，不需要这条）');
  const outsidePrint = html.slice(0, html.indexOf('@media print'));
  ok('★print-color-adjust 这条规则只出现在 @media print 内部，屏幕样式表里没有多出这一条',
    !outsidePrint.includes('print-color-adjust'));

  section('★回归——P72 那次修的"列宽超出被截断"的三条规则还在，没有被这次改动覆盖掉');
  ok('★.matrix-wrap 打印时还是 overflow-x: visible', /\.matrix-wrap \{ overflow-x: visible; \}/.test(printBlock));
  ok('★.matrix-table 打印时还是 width: 100%', /\.matrix-table \{ width: 100%; font-size: 9px; \}/.test(printBlock));
  ok('★人员列打印时还是 width: auto（自动摊分）', /\.matrix-table col\.col-person \{ width: auto; \}/.test(printBlock));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
