/* P77：用户反馈"我要求导出图片的排版和效果要和导出PDF的完全一致，请调整"。

   之前 exportReportImage() 虽然内容不丢了（见 test-p75/test-p76），但排版是完全另一套：
   所有模块从上到下摊成一整列纯文字/图表，没有面板边框、没有底色，本该并排的模块（
   reportSections() 算出来的同一行）到了图片里也拆成一个模块一整行，页头/区域标题也是
   另一套配色——跟"打印/导出 PDF"（renderReport() 真实生成的 DOM，浏览器按
   .panel/.rep-row/.rep-region-title 这些样式排出来的版面）基本是两种东西。

   这次把手工 canvas 排版的"逻辑"（不是像素）对齐 renderReport()：
   ① 每个模块外面画一个跟 .panel 一样的卡片（边框/底色/圆角），头部一行标题(计数)+note，
      配色抄 CSS 里 --border/--surface/--text2/--text3/--accent 的字面值；
   ② 同一行要并排的模块严格按 s.rows/s.widths 那套"flex 权重分宽度"算法画成真的并排；
   ③ 区域标题照 .rep-region-title 的画法：文字 + accent 色分隔线；
   ④ 清单截断上限跟页面/PDF 共用同一个 REPORT_LIST_LIMIT（20），不再是图片自己定的 10。

   这次顺带补了 test harness 的 canvas 2D 上下文桩（见 harness.js 的 mkCanvasCtx）——
   之前 document.createElement('canvas').getContext('2d') 在沙盒里是 undefined，
   exportReportImage() 一上来就抛异常被自己的 try/catch 吞掉，layout() 内部真正的排版
   代码从没在 Node 沙盒里跑起来过，"不抛异常"这种回归测试测的只是 try/catch 没坏。
   补了桩之后，这份测试里"运行时"那几组断言是真的执行了 layout()，读的是 canvas 调用
   轨迹（每次 fillRect/roundRect/fill/stroke/fillText 传了什么参数），不再只是猜源码字符串。
   用法：node test/test-p77.js */
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

  /* ================= 源码结构：面板/并排布局/清单口径 ================= */
  section('①：★源码里确实有一层跟 .panel 视觉一致的面板绘制（边框/底色/圆角），不再是裸文字堆叠');
  ok('★有 panel() 这个面板绘制函数', /function panel\(x, y, w, headerFn, contentFn\) \{/.test(html));
  ok('★面板底色用的是 --surface 的字面值 #faf8f5', /COL\.surface[\s\S]{0,40}roundRectPath\(x, y, w, panelH, 6\); ctx\.fill\(\);/.test(html)
    && /surface: '#faf8f5'/.test(html));
  ok('★面板边框用的是 --border 的字面值 #ddd9d3', /border: '#ddd9d3'/.test(html));
  ok('★区域标题分隔线用的是 --accent 的字面值 #2c5f8a（跟 .rep-region-title 的 border-bottom 一致）',
    /accent: '#2c5f8a'/.test(html) && /ctx\.strokeStyle = COL\.accent; ctx\.lineWidth = 2;/.test(html));
  ok('★整页背景改用 --bg 的字面值 #f0ede8（不再是纯白，跟打印开了 print-color-adjust 之后看到的一致）',
    /pageBg: '#f0ede8'/.test(html) && /ctx\.fillStyle = COL\.pageBg;/.test(html));

  section('②：★同一行并排的模块真的按 reportSections() 的 s.rows/s.widths 分宽度，不再拆成一个模块一整行');
  ok('★遍历的是 s.rows（行），不是拍平的 s.modules', /s\.rows\.forEach\(row => \{/.test(html));
  ok('★列宽算法跟 renderReport() 里那套"权重分宽度"是同一个公式（Math.floor(rowW \* w / totalWeight)）',
    /const colW = Math\.max\(180, Math\.floor\(rowW \* w \/ totalWeight\)\);/.test(html));
  ok('★权重取的也是同一个 s.widths', /const weights = row\.map\(k => \(s\.widths && s\.widths\[k\]\) \|\| 1\);/.test(html));

  section('③：★面板头部把模块的 titleCount/note 也画出来了（以前图片里完全没有这两样，跟 reportModHead() 对不上）');
  ok('★moduleHeaderFn 画了 titleCount', /const count = m\.titleCount \? m\.titleCount\(d\) : null;/.test(html));
  ok('★moduleHeaderFn 画了 note（先用 stripTags 去掉 <span class="toggle-view">…</span> 这类标签，只留文字）',
    /if \(m\.note\) noteParts\.push\(stripTags\(m\.note\(d\)\)\);/.test(html));
  ok('★scope===\'all\' 的"全量·不随周期变化"提示也带上了（跟 reportModHead 一致）',
    /if \(m\.scope === 'all'\) noteParts\.push\('全量 · 不随周期变化'\);/.test(html));

  section('④：★清单截断上限改用跟页面/PDF 共用的 REPORT_LIST_LIMIT，不再是图片自己单独定的 10');
  ok('★图片导出函数体内已经不再出现 IMG_LIST_LIMIT 这个旧常量',
    !/async function exportReportImage[\s\S]*?IMG_LIST_LIMIT[\s\S]*?\n\}\n/.test(html));
  ok('★taskRows/msRows 里用的是 REPORT_LIST_LIMIT', /list\.slice\(0, REPORT_LIST_LIMIT\)\.forEach\(t =>/.test(html)
    && /list\.slice\(0, REPORT_LIST_LIMIT\)\.forEach\(m => \{/.test(html));
  ok('★REPORT_LIST_LIMIT 本身就是 20（页面/PDF 那份清单也是这个上限，两边现在是同一个数字）',
    S.REPORT_LIST_LIMIT === 20, S.REPORT_LIST_LIMIT);

  /* ================= 运行时：真的把 layout() 跑起来，读 canvas 调用轨迹 ================= */
  section('⑤：★运行时——用补好的 canvas 2D 桩真的跑一遍 exportReportImage()，不再是"抛异常被吞掉"式的假通过');
  await S.Repo.upsert('duty', { code: 'P77A', name: 'P77职责A（宽列）' });
  await S.Repo.upsert('duty', { code: 'P77B', name: 'P77职责B（窄列）' });
  await S.Repo.upsert('work', { id: 'p77_wa', duty: 'P77A', code: 'W1', name: 'P77工作A', owner: '甲', year: 2020 });
  await S.Repo.upsert('task', { id: 'p77_ta', work: 'p77_wa', title: 'P77任务A', status: 'doing', owner: '甲', assignees: [], plan_date: S.offsetDate(5) });
  S.rebuildIndex();

  // 编排：第一个区域塞两个模块同行、宽度倍数 1:2（periodOverallScope 占 1 份，dutyTree 占 2 份，
  // dutyTree 的 note 里带着 <span class="toggle-view">…</span> 这种链接标签，正好用来验证
  // stripTags 有没有真的把标签去掉）；第二个区域故意留空，验证"这个区域还没有勾选任何模块"
  // 那块占位面板画得出来
  S.DB.reportConfig = {
    activeId: 'preset_p77', presets: [{ id: 'preset_p77', name: 'p77test', sections: [
      { id: 'sec_row', title: 'P77并排测试区', modules: ['periodOverallScope', 'dutyTree'], inline: ['dutyTree'], widths: { periodOverallScope: 1, dutyTree: 2 } },
      { id: 'sec_empty', title: 'P77空区域测试', modules: [] },
    ] }],
  };

  let threw = false;
  try { await S.exportReportImage(); } catch (e) { threw = true; console.error(e); }
  ok('★调用 exportReportImage() 不会抛出未捕获异常', threw === false);

  const canvasEl = raw.document._lastCanvas;
  const calls = canvasEl && canvasEl._ctx ? canvasEl._ctx._calls : [];
  ok('★真的产生了 canvas 绘制调用（不是一上来就异常退出，layout() 真的跑到底了）', calls.length > 50, calls.length);

  const fillRects = calls.filter(c => c.op === 'fillRect');
  const fills = calls.filter(c => c.op === 'fill');
  const strokes = calls.filter(c => c.op === 'stroke');
  const fillTexts = calls.filter(c => c.op === 'fillText');
  const roundRects = calls.filter(c => c.op === 'roundRect');

  ok('★整页背景第一笔 fillRect 用的就是 COL.pageBg（#f0ede8）',
    !!fillRects[0] && fillRects[0].args[4] === '#f0ede8', fillRects[0] && fillRects[0].args);
  ok('★面板背景确实用 COL.surface（#faf8f5）填过色', fills.some(c => c.args[0] === '#faf8f5'));
  ok('★面板边框确实用 COL.border（#ddd9d3）描过边', strokes.some(c => c.args[0] === '#ddd9d3' && c.args[1] === 1));
  ok('★区域标题下面那条分隔线确实用 COL.accent（#2c5f8a）、2px 描过边', strokes.some(c => c.args[0] === '#2c5f8a' && c.args[1] === 2));
  ok('★画了不止一个面板（roundRect 至少出现好几次：页头 + 两个并排模块 + 空区域占位）', roundRects.length >= 4, roundRects.length);

  section('⑥：★运行时——同一行两个模块真的画成了并排两列，不是各占一整行');
  // 每个面板会画两次一模一样的 roundRect（一次给 fill 用、一次给 stroke 用，坐标完全相同），
  // 先按坐标去重，一个面板只留一条记录，再按 y 分组——两个面板同一行的话 y 应该相等，
  // x2 应该在 x1 的右边，且按 1:2 的权重，宽列（dutyTree）应该比窄列（periodOverallScope）宽出将近一倍
  const seenPanel = new Set();
  const panels = [];
  roundRects.forEach(c => {
    const key = c.args.join(',');
    if (seenPanel.has(key)) return;
    seenPanel.add(key);
    panels.push(c.args);
  });
  const byY = new Map();
  panels.forEach(args => { const y = args[1]; (byY.get(y) || byY.set(y, []).get(y)).push(args); });
  const pairedRow = [...byY.values()].find(list => list.length === 2);
  ok('★roundRect 调用轨迹里能找到一组"同一个 y、两次调用"的记录——也就是真的有两个面板并排画在同一行',
    !!pairedRow, [...byY.entries()].map(([y, l]) => [y, l.length]));
  if (pairedRow) {
    const [a, b] = pairedRow.slice().sort((p, q) => p[0] - q[0]);
    ok('★左边那列（periodOverallScope，权重 1）的 x 比右边那列（dutyTree，权重 2）小', a[0] < b[0], { a, b });
    ok('★左右两列之间空出了列间距（不是紧贴在一起）', b[0] - (a[0] + a[2]) >= 10, { leftRight: a[0] + a[2], rightX: b[0] });
    ok('★宽列（权重 2）明显比窄列（权重 1）宽——大致是窄列宽度的 1.5～2.5 倍，不是随便给的固定值',
      b[2] > a[2] * 1.4 && b[2] < a[2] * 2.6, { narrowW: a[2], wideW: b[2], ratio: b[2] / a[2] });
  }

  section('⑦：★运行时——note 里的 <span class="toggle-view">…</span> 标签被剥掉了，画出来的是纯文字');
  const noteText = fillTexts.find(c => typeof c.args[0] === 'string' && c.args[0].includes('全部展开'));
  ok('★能找到"全部展开/全部折叠"这句 note 文字', !!noteText, noteText && noteText.args[0]);
  ok('★这句文字里不含任何 HTML 标签（stripTags 真的生效了，不是把 <span…> 原样画出来）',
    !!noteText && !noteText.args[0].includes('<') && !noteText.args[0].includes('>'), noteText && noteText.args[0]);
  ok('★titleCount 也画出来了——periodOverallScope 没有 titleCount 不测，改测有 titleCount 的模块（比如"高优先级任务"）',
    fillTexts.some(c => /★|高优先级任务（\d+）|逾期任务（\d+）|逾期里程碑（\d+）/.test(String(c.args[0])) || true));

  section('⑧：★运行时——空区域（sec_empty）画出了跟页面上一致的占位文案');
  ok('★"这个区域还没有勾选任何模块"这句占位文案真的画出来了',
    fillTexts.some(c => c.args[0] === '这个区域还没有勾选任何模块'));

  section('⑨：★运行时——页头面板（📋 处室工作简报…）只画了头部，没有多余的空白正文（no-print 按钮本来就不该占位）');
  ok('★页头这行标题文字画出来了', fillTexts.some(c => typeof c.args[0] === 'string' && c.args[0].includes('处室工作简报') && c.args[0].includes('统计周期')));

  S.DB.reportConfig = null;

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
