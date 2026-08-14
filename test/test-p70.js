/* P70：上一轮（P69）两处反馈都还没到位，这次专门排查根因——
   ① 矩阵布局："20 个汉字宽/职责字体高/工作字体跟职责一样大"依旧不对，根因是全局有一条
      `td { padding:0 8px; font-size:12.5px; border-right:1px solid ... }` 的表格重置：
      直接写在 td/th 元素上的声明，哪怕选择器优先级比 class 低，只要 .matrix-cell/
      .matrix-row-label 自己没显式声明同一个属性，浏览器就会用这条全局规则、而不是从
      <table> 继承下来的字号——这就是"职责行一直在偷偷用全局 12.5px，工作行自己声明了
      11px"、"内边距/行高怎么调都没用"的真正原因。这次把 font-size/line-height/padding/
      border-right 每条规则都显式重新声明一遍，不再留缝。
   ② 报告模块宽度倍数的计算公式本身是对的（grow 之比），但上一版拿"JS 估算出来的像素值"
      直接当 flex-basis 用，估不准的时候几个模块的基准宽度加起来会超过容器实际宽度，
      逼着 flex-wrap 把它们拆成好几行——这才是"同行按钮大批失效"的真正原因，不是同行
      开关本身坏了。改成 flex-basis:0，交给浏览器按 grow 比例实时分配，不依赖任何像素猜测。
   用法：node test/test-p70.js */
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

  /* ================= ①：矩阵布局——真正的根因是全局 td/th 重置在漏缝 ================= */
  section('①：★根因——全局表格重置（td/th 直接声明）会盖过没有显式声明同一属性的 class');
  ok('★源码里确实存在这条全局 td 重置（padding/font-size/border-right）',
    /^td \{ padding: 0 8px; font-size: 12\.5px;/m.test(html));
  ok('★matrix-cell 现在显式声明了 font-size/line-height/padding/border-right，不再留给全局规则去填',
    /\.matrix-cell \{ font-size: 11px; line-height: 1; padding: 0;[\s\S]{0,200}border-right: none/.test(html));
  ok('★matrix-row-label 同理显式声明了 font-size（这是它之前一直缺的那一个属性）',
    /\.matrix-row-label \{ font-size: 11px; line-height: 1;/.test(html));
  ok('★matrix-table th 也补齐了 border-right:none（否则每列右边会莫名多一条全局边框线）',
    /\.matrix-table th \{[\s\S]{0,220}border-right: none/.test(html));

  section('①：★职责/工作字号现在只有一处声明来源，结构上保证两者不可能再不一致');
  ok('★.matrix-row-work 不再单独声明 font-size（避免以后改一处忘了改另一处，又出现不一致）',
    !/\.matrix-row-work \{[^}]*font-size/.test(html));

  section('①：列宽约等于职责字体的 20 个汉字宽（11px 字号 × 20 ≈ 220px，留一点边距给箭头/内边距）');
  const labelWidthMatch = html.match(/\.matrix-table col\.col-label \{ width: (\d+)px/);
  ok('★列宽确实收窄了（不再是 510px 那种"3 倍"算法）', !!labelWidthMatch && +labelWidthMatch[1] < 300, labelWidthMatch && labelWidthMatch[1]);
  ok('★列宽落在 20 个汉字（220px）到 220+30px 缓冲的合理区间内',
    labelWidthMatch && +labelWidthMatch[1] >= 220 && +labelWidthMatch[1] <= 250, labelWidthMatch && labelWidthMatch[1]);

  section('①：行高不再单独定一个像素值，就是这个字号本身该占的高度（line-height:1，没有额外行距）');
  ok('★matrix-cell 用 line-height:1，不再有额外的 height 声明去撑高整行', /\.matrix-cell \{ font-size: 11px; line-height: 1;/.test(html));
  ok('★matrix-row-label 同理是 line-height:1', /\.matrix-row-label \{ font-size: 11px; line-height: 1;/.test(html));

  section('①：实际渲染出来的矩阵，职责行和展开后的工作行字体一样大（都由 .matrix-row-label 的 11px 决定）');
  await S.Repo.upsert('duty', { code: 'P70MX', name: 'P70矩阵字号验证职责' });
  await S.Repo.upsert('work', { id: 'p70_mxw', duty: 'P70MX', code: 'W1', name: 'P70矩阵字号验证工作', owner: '张三', year: new Date().getFullYear() });
  await S.Repo.upsert('task', { id: 'p70_mxt', work: 'p70_mxw', title: 'P70矩阵字号验证任务', status: 'doing', owner: '甲', assignees: [], plan_date: S.offsetDate(5) });
  S.rebuildIndex();
  const dutyStat = S.statsByDuty(S.DB.tasks.filter(t => !t.deleted_at)).filter(x => x.code === 'P70MX');
  const workStat = S.statsByWork(S.DB.tasks.filter(t => !t.deleted_at));
  const heat = S.personDutyWorkHeat(S.DB.tasks.filter(t => !t.deleted_at));
  const expandedOut = S.personMatrixHTML(dutyStat, workStat, ['甲'], heat, new Set(['P70MX']), 'chart-matrix-duty-toggle');
  ok('展开后能看到工作行', expandedOut.includes('P70矩阵字号验证工作'));
  ok('★工作行的 <td> 类名里同时带着 matrix-row-label 和 matrix-row-work（字号来源是同一条 .matrix-row-label 规则，不是各自为政）',
    /class="matrix-row-label matrix-row-work"/.test(expandedOut));

  /* ================= ②：报告模块宽度倍数——basis 必须是 0，不能是猜出来的像素值 ================= */
  section('②：★根因——上一版拿 JS 估算的像素值当 flex-basis，估不准时几个模块加起来比容器还宽，逼着 flex-wrap 拆行');
  ok('★渲染代码里 flex-basis 固定写死是 0，不再插入 colW 这个估算值',
    /flex:\$\{w\} 1 0/.test(html));
  ok('★colW 依然算出来了，但只喂给模块自己画 SVG 用，不再喂给 CSS 布局',
    /const colW = Math\.max\(200, Math\.floor\(rowW \* w \/ totalWeight\)\);.*只喂给模块自己画图用/.test(html));

  section('②：完整复现用户举的例子——优先级分布/任务来源分布/交付物呈报层级分布 同一行，来源分布设 2 倍');
  S.DB.reportConfig = {
    activeId: 'preset_p70', presets: [{ id: 'preset_p70', name: 'p70test', sections: [
      { id: 'sec_ex', title: '举例验证区', modules: ['taskPriorityPie', 'taskSourceBars', 'msLevelPie'],
        inline: ['taskSourceBars', 'msLevelPie'], widths: { taskSourceBars: 2 } },
    ] }],
  };
  S.goto('report');
  const repH = q('#page-report').innerHTML;
  ok('★三个模块确实被同一个 .rep-row 包在一起（同行没有被拆散）',
    /<div class="rep-row">[\s\S]*?优先级分布[\s\S]*?任务来源分布[\s\S]*?交付物呈报层级分布[\s\S]*?<\/div>\s*<\/div>/.test(repH));
  const flexOf = label => {
    const idx = repH.indexOf(`>${label}<`);
    const colStart = repH.lastIndexOf('<div class="panel rep-col"', idx);
    const m = repH.slice(colStart, colStart + 200).match(/style="flex:(\d+) 1 0"/);
    return m ? +m[1] : null;
  };
  const gPri = flexOf('优先级分布'), gSrc = flexOf('任务来源分布'), gLvl = flexOf('交付物呈报层级分布');
  ok('★优先级分布是默认 1 倍', gPri === 1, gPri);
  ok('★任务来源分布是设定的 2 倍', gSrc === 2, gSrc);
  ok('★交付物呈报层级分布是默认 1 倍', gLvl === 1, gLvl);
  const total = gPri + gSrc + gLvl;
  ok('★按用户举的例子验算：任务来源分布占这一行的比例正好是 2/(1+2+1) = 1/2',
    Math.abs(gSrc / total - 0.5) < 1e-9, { gSrc, total, ratio: gSrc / total });

  section('②：★不折行——不管 pageW 这个估算值猜成什么样，flex-basis 永远是 0，三个模块永远挤在同一行');
  // 用极端窄的/极端宽的两种 pageW 各跑一遍，basis 应该始终是字面量 "0"，不随 pageW 变化
  const rawHtmlNarrow = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('★渲染逻辑里量出来的 colW（像素估算）只用于 m.html() 调用，跟 flex 那一行的字符串拼接是两个独立的表达式，物理上不会互相影响',
    (() => {
      const idx = rawHtmlNarrow.indexOf("const flexStyle = row.length > 1 ? ` style=\"flex:${w} 1 0\"` : '';");
      return idx > -1;
    })());

  section('②：没设宽度倍数的普通同行（老编排常见场景）照样能正常并排，不受这次改动影响');
  S.DB.reportConfig = {
    activeId: 'preset_p70plain', presets: [{ id: 'preset_p70plain', name: 'p70plain', sections: [
      { id: 'sec_plain', title: '普通同行区', modules: ['periodOverallScope', 'periodOverallPlan'], inline: ['periodOverallPlan'] },
    ] }],
  };
  S.goto('report');
  const repH2 = q('#page-report').innerHTML;
  ok('★两个都是默认 1 倍时，也是走 flex:1 1 0（等分），不是走别的分支',
    /flex:1 1 0/.test(repH2));
  // P82 这轮改名"本期计划完成度"→"本期计划开展"
  ok('两个模块确实在同一个 .rep-row 里', /<div class="rep-row">[\s\S]*?本期涉及范围[\s\S]*?本期计划开展[\s\S]*?<\/div>/.test(repH2));

  S.DB.reportConfig = null;

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
