/* P69：三项反馈——
   ① 人员工作矩阵布局没生效的根因排查：table-layout 默认是 auto，per-cell 的 width 只是
      建议，浏览器按内容自动摊算列宽，之前"放大3倍/缩到4字宽/行高对齐"全都没真正生效。
      改成 table-layout:fixed + <colgroup> 声明列宽，这是 fixed 布局下唯一可靠的做法。
   ② 人员工作矩阵纳入报告页"人员"分类，跟图表页那份用同一套 personMatrixHTML/
      personDutyWorkHeat，报告页自己一份独立的展开状态
   ③ 报告编排：每个模块除了"同行"，还能单独选 1/2/3 倍宽度，同一行内按倍数累加分割
   用法：node test/test-p69.js */
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

  /* ================= ①：矩阵布局根因修复 ================= */
  section('①：★根因——没有 table-layout:fixed 时，浏览器按内容自动摊算列宽，per-cell width 形同虚设');
  ok('★matrix-table 有 table-layout: fixed', /\.matrix-table \{[^}]*table-layout: fixed/.test(html));
  // P70 把列宽从 510px 收窄成 230px（约 20 个汉字），细节见 test-p70.js
  ok('★列宽通过 <colgroup> 的 col.col-label / col.col-person 控制，不再依赖每个单元格自己声明',
    /\.matrix-table col\.col-label \{ width: \d+px/.test(html) && /\.matrix-table col\.col-person \{ width: 46px/.test(html));
  ok('personMatrixHTML 的输出真的带上了 colgroup（不是只改了 CSS，标签也得配合）',
    /const colgroup = `<colgroup>/.test(html));

  section('①：实际渲染验证——列数对得上、行高变矮了');
  await S.Repo.upsert('duty', { code: 'P69MX', name: 'P69矩阵布局职责' });
  await S.Repo.upsert('work', { id: 'p69_mxw', duty: 'P69MX', code: 'W1', name: 'P69矩阵布局工作', owner: '张三', year: new Date().getFullYear() });
  await S.Repo.upsert('task', { id: 'p69_mxt', work: 'p69_mxw', title: 'P69矩阵布局任务', status: 'doing', owner: '甲', assignees: ['乙'], plan_date: S.offsetDate(5) });
  S.rebuildIndex();
  S.goto('charts');
  S.ACTIONS['chart-tab']({ k: 'matrix' });
  const matrixPageHtml = q('#page-charts').innerHTML;
  const colgroupMatch = matrixPageHtml.match(/<colgroup>(.*?)<\/colgroup>/s);
  ok('★页面里真的渲染出了 colgroup', !!colgroupMatch);
  if (colgroupMatch) {
    const cols = colgroupMatch[1].match(/<col[^>]*>/g) || [];
    ok('★colgroup 列数 = 1（标签列）+ 人数（跟表头 <th> 数量对得上）',
      cols.length === S.allPeople().length + 1, { colCount: cols.length, people: S.allPeople().length });
    ok('第一列是 col-label（职责/工作名称那一列）', cols[0].includes('col-label'));
    ok('后面都是 col-person（46px、4 个汉字宽那一列）', cols.slice(1).every(c => c.includes('col-person')));
  }
  // 行高/字号的精确值（改成"就是文字本身的高度"，不再单独定 15px）见 test-p70.js

  /* ================= ②：矩阵纳入报告"人员"分类 ================= */
  section('②：REPORT_MODULES 里新增了 personMatrix，归到"人员"分类');
  ok('★REPORT_MODULE_MAP 里有 personMatrix', !!S.REPORT_MODULE_MAP.personMatrix);
  ok('★分类是 people（人员）', S.REPORT_MODULE_MAP.personMatrix.group === 'people');
  ok('标成全量（矩阵是结构性归属关系，没有天然的按周期切法）', S.REPORT_MODULE_MAP.personMatrix.scope === 'all');

  section('②：报告页渲染出来的矩阵内容，跟图表页那份是同一套统计口径');
  const d = S.buildReportData('week', 0);
  const reportMatrixHtml = S.REPORT_MODULE_MAP.personMatrix.html(d);
  ok('★正文里有矩阵表格', reportMatrixHtml.includes('matrix-table'));
  ok('★正文里有 colgroup（复用同一个 personMatrixHTML，不是另起一套简化版）', reportMatrixHtml.includes('<colgroup>'));

  section('②：报告页矩阵有自己独立的展开状态，跟图表页那份互不影响');
  S.ACTIONS['chart-matrix-expand-all']();
  ok('图表页矩阵：全部展开了', S.chartMatrixDutyExpanded.has('P69MX'));
  ok('★报告页矩阵：完全没被图表页那次操作影响，还是空的', S.reportMatrixDutyExpanded.size === 0);
  await S.ACTIONS['report-matrix-duty-toggle']({ code: 'P69MX' });
  ok('★报告页矩阵展开集合改了', S.reportMatrixDutyExpanded.has('P69MX'));
  await S.ACTIONS['report-matrix-collapse-all']();
  ok('全部折叠后报告页矩阵清空了', S.reportMatrixDutyExpanded.size === 0);

  section('②：报告页矩阵的格子点击也走同一套 matrix-cell-filter 下钻');
  const expandedHtml = (() => { S.reportMatrixDutyExpanded.add('P69MX'); return S.REPORT_MODULE_MAP.personMatrix.html(d); })();
  ok('★展开后能看到"甲"在这项职责下的可点击格子', /data-act="matrix-cell-filter" data-duty="P69MX" data-person="甲"/.test(expandedHtml));
  S.reportMatrixDutyExpanded.clear();

  /* ================= ③：报告模块宽度倍数 ================= */
  section('③：reportSections() 会把 s.widths 里合法的 2/3 倍宽度带出来，非法值当默认 1 倍处理');
  S.DB.reportConfig = {
    activeId: 'preset_p69', presets: [{ id: 'preset_p69', name: 'p69test', sections: [
      { id: 'sec_w', title: '宽度测试区', modules: ['periodScope', 'periodPlan', 'periodStatus'], inline: ['periodPlan', 'periodStatus'],
        widths: { periodPlan: 2, periodStatus: 3, periodScope: 99 } },
    ] }],
  };
  const secs = S.reportSections();
  ok('★periodPlan 是 2 倍', secs[0].widths.periodPlan === 2);
  ok('★periodStatus 是 3 倍', secs[0].widths.periodStatus === 3);
  ok('★periodScope 的非法值（99）被当默认 1 倍，压根不会出现在 widths 里', !('periodScope' in secs[0].widths));

  section('③：渲染时按倍数分配 flex-grow——basis 固定是 0，不再用 JS 猜的像素基准（那正是折行 bug 的根源，见 test-p70）');
  S.goto('report');
  const repH = q('#page-report').innerHTML;
  // 面板正文里不带 data-mod（那是配置编辑器才有的属性），只能按面板标题文字定位——
  // 从标题文字往前找最近的 rep-col 起始位置，读它的内联 style
  const flexOf = label => {
    const idx = repH.indexOf(`>${label}<`);
    const colStart = repH.lastIndexOf('<div class="panel rep-col"', idx);
    const styleMatch = repH.slice(colStart, colStart + 200).match(/style="flex:(\d+) 1 0"/);
    return styleMatch ? { grow: +styleMatch[1] } : null;
  };
  // periodScope/periodPlan/periodStatus 全都并在一行了（第一个模块自己占一行，但 inline 设了 periodPlan/periodStatus，
  // 而 periodScope 是第一个、不可能跟别的同行——所以实际是 periodScope 独占一行，periodPlan+periodStatus 并排一行）
  const flexPlan = flexOf('本期工作计划量'), flexStatus = flexOf('本期完成进度（含 SPI）');
  ok('★periodPlan（2倍）拿到的 flex-grow 是 2', flexPlan && flexPlan.grow === 2, flexPlan);
  ok('★periodStatus（3倍）拿到的 flex-grow 是 3', flexStatus && flexStatus.grow === 3, flexStatus);

  section('③：没设过宽度的老编排照样渲染，行为跟以前完全一样（都是默认 1 倍）');
  S.DB.reportConfig = {
    activeId: 'preset_p69old', presets: [{ id: 'preset_p69old', name: 'p69old', sections: [
      { id: 'sec_old', title: '老编排区', modules: ['periodScope', 'periodPlan'], inline: ['periodPlan'] },
    ] }],
  };
  const secsOld = S.reportSections();
  ok('★老数据没有 widths 字段，reportSections 照样给出空对象，不报错', JSON.stringify(secsOld[0].widths) === '{}');
  S.goto('report');
  ok('页面正常渲染出两个模块', q('#page-report').innerHTML.includes('本期涉及范围') && q('#page-report').innerHTML.includes('本期工作计划量'));

  section('③：★UI——配置面板里每个已选模块都带宽度下拉框，选项是 1/2/3 倍宽度');
  S.DB.reportConfig = { activeId: 'preset_p69', presets: [{ id: 'preset_p69', name: 'p69test', sections: [
    { id: 'sec_w', title: '宽度测试区', modules: ['periodScope', 'periodPlan'], inline: [], widths: { periodPlan: 2 } },
  ] }] };
  S.setReportConfigOpen(true);
  S.goto('report');
  const cfgH = q('#page-report').innerHTML;
  ok('★periodScope（默认1倍）的下拉框选中的是"1 倍宽度"',
    new RegExp(`data-act="report-mod-width"[^>]*data-mod="periodScope"[\\s\\S]{0,150}<option value="1" selected>`).test(cfgH));
  ok('★periodPlan（设了2倍）的下拉框选中的是"2 倍宽度"',
    new RegExp(`data-act="report-mod-width"[^>]*data-mod="periodPlan"[\\s\\S]{0,150}<option value="2" selected>`).test(cfgH));

  section('③：选择宽度的 ACTIONS——选 2/3 倍会存，选回 1 倍会删掉这条设置（不留占位）');
  await S.ACTIONS['report-mod-width']({ sec: 'sec_w', mod: 'periodScope' }, { value: '3' });
  await tick();
  ok('★periodScope 被设成 3 倍了', S.reportSections()[0].widths.periodScope === 3);
  await S.ACTIONS['report-mod-width']({ sec: 'sec_w', mod: 'periodScope' }, { value: '1' });
  await tick();
  ok('★选回 1 倍后，widths 里就不再有这一条了（不是存了个 1）',
    !('periodScope' in S.reportSections()[0].widths));

  section('③：移除模块时顺手清掉它的宽度设置，不留孤儿数据');
  await S.ACTIONS['report-mod-width']({ sec: 'sec_w', mod: 'periodPlan' }, { value: '2' });
  await tick();
  ok('前置：periodPlan 现在是 2 倍', S.reportSections()[0].widths.periodPlan === 2);
  await S.ACTIONS['report-mod-remove']({ sec: 'sec_w', mod: 'periodPlan' });
  await tick();
  const rawSec = S.reportPresets()[0].sections.find(x => x.id === 'sec_w');
  ok('★底层数据里 widths.periodPlan 也被清掉了', !rawSec.widths || !('periodPlan' in rawSec.widths));

  S.DB.reportConfig = null;
  S.setReportConfigOpen(false);

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
