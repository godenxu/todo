/* P61：图表页"按工作"tab 的"各年度工作数量"看图表时柱状图跨出面板——
   它跟"各职责工作数量"并排在同一个 .rep-row 里，实际只有半页宽，但 barChart() 传的是整页宽的
   w（跟"到期分布"当初的问题一模一样），改成跟到期分布同一套：data-year-fit 标记容器 +
   renderCharts() 里插入 DOM 后用 fitFlexBarChart() 按真实列宽重画。
   用法：node test/test-p61.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, q } = require('./harness.js');

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

  section('源码层面：各年度工作数量的柱状图外层带 data-year-fit 标记');
  ok('★workYear 面板的 barChart 输出外层包了 data-year-fit',
    /data-year-fit>\$\{barChart\(yearBars, w\)\}/.test(html));

  section('源码层面：renderCharts() 接了按真实列宽重画的逻辑');
  ok('★renderCharts() 里确实调用了 fitFlexBarChart(yearEl, worksByYear())',
    /chartTab === 'work' && !chartTableView\.workYear[\s\S]{0,200}fitFlexBarChart\(yearEl, worksByYear\(\)\)/.test(html));

  section('实测：图表页"按工作"tab，看图表状态下柱状图容器带 data-year-fit');
  S.goto('charts');
  S.ACTIONS['chart-tab']({ k: 'work' });
  let chH = q('#page-charts').innerHTML;
  ok('★"按工作"tab 默认看图表时，柱状图外层出现了 data-year-fit', chH.includes('data-year-fit'));
  ok('容器里确实是个 svg（不是数据表）', /data-year-fit><svg/.test(chH));

  section('实测：切到看数据表后，data-year-fit 不再出现（那条分支只在看图表时生效）');
  S.ACTIONS['chart-view']({ id: 'workYear' });
  chH = q('#page-charts').innerHTML;
  ok('看数据表状态下没有 data-year-fit 容器了', !chH.includes('data-year-fit'));
  ok('换成了 dataTable', chH.includes('<table class="dtable">'));
  S.ACTIONS['chart-view']({ id: 'workYear' }); // 切回去，不影响后面的用例

  section('实测：renderCharts() 调用不报错（沙盒没有真实布局引擎，fitFlexBarChart 会因为量不出真实宽度而安全早退，见函数本身注释）');
  ok('切到"按工作"tab 渲染全程没有抛异常', true);

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
