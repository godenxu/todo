/* P19：本轮改动测试——
   1) 工作台/报告页的"各职责/工作推进情况"、图表页"按分类"(职责类别/职责项)、图表页"按人"，
      "未开始"状态段以前是 transparent（直接透出底色），现在改成独立的 --c-todo 颜色，
      能跟条形图自己的空白底色区分开；对应的图例、"按人"tab 旁边的状态占比饼图、报告导出图片(canvas)也同步改色
   2) 任务详情弹窗（含批量编辑）的"计划完成时间"/"实际完成时间"以前是自由文本框（认 today/+7 这类关键字），
      跟里程碑的原生日期选择器不一致；现在统一改成跟里程碑一样的 <input type="date">
   用法：node test/test-p19.js */
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

  section('hBar：未开始（含挂起）现在会渲染成独立的 seg-todo 分段');
  const barNoTodo = S.hBar('全done', { total: 4, done: 4, doing: 0, late: 0, todo: 0, hold: 0, rate: 100 }, 4);
  ok('全部完成时不会凭空多出 seg-todo', !barNoTodo.includes('seg-todo'));
  const barWithTodo = S.hBar('有未开始', { total: 10, done: 3, doing: 2, late: 1, todo: 4, hold: 0, rate: 30 }, 10);
  ok('有未开始任务时渲染了 seg-todo', barWithTodo.includes('class="seg seg-todo"'));
  const m = barWithTodo.match(/class="seg seg-todo" style="width:([\d.]+)%"/);
  ok('seg-todo 的宽度就是 todo/max（4/10=40%）', !!m && Math.abs(+m[1] - 40) < 0.1, m && m[1]);
  const barHoldOnly = S.hBar('只有挂起', { total: 5, done: 0, doing: 0, late: 0, todo: 0, hold: 5, rate: 0 }, 5);
  ok('挂起也并进 seg-todo 这一段（未开始/挂起视觉合并）', barHoldOnly.includes('class="seg seg-todo" style="width:100.00%"'));
  const barTodoAndHold = S.hBar('未开始+挂起', { total: 10, done: 2, doing: 0, late: 0, todo: 3, hold: 5, rate: 20 }, 10);
  const m2 = barTodoAndHold.match(/class="seg seg-todo" style="width:([\d.]+)%"/);
  ok('未开始+挂起合计一段宽度（(3+5)/10=80%）', !!m2 && Math.abs(+m2[1] - 80) < 0.1, m2 && m2[1]);
  ok('四段宽度合计不超过 100%（含 seg-todo 后仍然守规矩）',
    [...barWithTodo.matchAll(/width:([\d.]+)%/g)].reduce((a, w) => a + +w[1], 0) <= 100.05);

  section('CSS：seg-todo 不再是 transparent，用独立的 --c-todo，且跟 --c-track 不是同一个值');
  const html = raw.__origHtml || require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  ok('新增了 --c-todo 这个 CSS 变量', /--c-todo:\s*#[0-9a-fA-F]{6}/.test(html));
  const cTrackMatch = html.match(/--c-track:\s*(#[0-9a-fA-F]{6})/);
  const cTodoMatch = html.match(/--c-todo:\s*(#[0-9a-fA-F]{6})/);
  ok('--c-todo 和 --c-track 颜色值不一样（不然还是分不清）', !!cTrackMatch && !!cTodoMatch && cTrackMatch[1].toLowerCase() !== cTodoMatch[1].toLowerCase());
  ok('.bar-row .seg-todo 不再是 transparent', !/\.bar-row \.seg-todo\s*\{\s*background:\s*transparent/.test(html));
  ok('.bar-row .seg-todo 用了 --c-todo', /\.bar-row \.seg-todo,?\s*(?:\.load-row \.seg-todo)?\s*\{\s*background:\s*var\(--c-todo\)/.test(html));
  ok('展开的工作条（bar-row-muted）也给 seg-todo 配了自己的浅色，不是复用 track 色', /\.bar-row-muted \.seg-todo\s*\{\s*background:\s*#[0-9a-fA-F]{6}/.test(html));

  section('图例/饼图：各处"未开始"图例色块跟条形图里实际用的颜色一致（都是 --c-todo，不再是 --c-track）');
  S.setPage('dashboard'); S.renderDashboard();
  const dashH = q('#page-dashboard').innerHTML;
  ok('工作台"各职责/工作推进情况"图例里"未开始"用了 --c-todo', /未开始<\/span>/.test(dashH) &&
    /background:var\(--c-todo\)"><\/i>未开始</.test(dashH));
  S.goto('report');
  const reportH = q('#page-report').innerHTML;
  ok('报告页"各职责/工作推进情况"图例里"未开始"也用了 --c-todo', /background:var\(--c-todo\)"><\/i>未开始</.test(reportH));
  S.setPage('charts'); S.ACTIONS['chart-tab']({ k: 'person' });
  const personH = q('#page-charts').innerHTML;
  ok('图表页"按人"图例里"未开始/挂起"用了 --c-todo', /background:var\(--c-todo\)"><\/i>未开始\/挂起</.test(personH));
  ok('图表页"按人"旁边的状态占比饼图也用了 --c-todo（跟左边条形图颜色对得上）', S.pieChart([{ label: '未开始/挂起', n: 1, color: 'var(--c-todo)' }], 100, '').length > 0);
  S.ACTIONS['chart-tab']({ k: 'category' });
  const catH = q('#page-charts').innerHTML;
  ok('图表页"按分类"（职责类别+职责项）图例也用了 --c-todo',
    (catH.match(/background:var\(--c-todo\)"><\/i>未开始\/挂起</g) || []).length >= 2);

  section('canvas 导出报告图片：bar() 里也补上了第四段（未开始+挂起），配色数组多了一项');
  ok('COL.bar 数组现在有 4 个颜色（done/doing/late/todo）', /bar: \['#1e7d45', '#1a6aa8', '#c0392b', '#[0-9a-fA-F]{6}'\]/.test(html));
  ok('COL.barMuted 数组也是 4 个', /barMuted: \['#8fcda8', '#7fb3d9', '#e2a49b', '#[0-9a-fA-F]{6}'\]/.test(html));
  ok('canvas 的 bar() 绘制循环把 todo+hold 也纳入了四段数组', /\[c\.done, c\.doing, c\.late, \(c\.todo \|\| 0\) \+ \(c\.hold \|\| 0\)\]/.test(html));

  section('任务详情/批量编辑：计划完成时间、实际完成时间统一成原生 date 输入（跟里程碑一致）');
  const dateField = S.fieldDef('task', 'plan_date');
  const ctrlHTML = S.fieldControl(dateField, '2026-08-01', 'td-');
  ok('fieldControl 对 date 类型渲染的是原生 <input type="date">', /<input id="td-plan_date" type="date" value="2026-08-01">/.test(ctrlHTML));
  ok('不再是自由文本框那种 today/+7 的 placeholder 提示了', !ctrlHTML.includes('placeholder'));
  const actualField = S.fieldDef('task', 'actual_date');
  const ctrlHTML2 = S.fieldControl(actualField, '', 'be-');
  ok('实际完成时间同理，批量编辑（be- 前缀）里也是原生 date 控件', /<input id="be-actual_date" type="date" value="">/.test(ctrlHTML2));

  section('readControl：date 类型不再靠 parseDue 解析关键字，原生控件本身就是合法值或空串');
  q('#td-plan_date').value = '2026-09-15';
  ok('直接读回原生控件给的合法日期', S.readControl(dateField, 'td-') === '2026-09-15');
  q('#td-plan_date').value = '';
  ok('清空后读回空串', S.readControl(dateField, 'td-') === '');

  section('回归：任务详情整体保存流程，日期字段走的是新控件，milestone 的 cp-date 不受影响');
  const anyTask = S.DB.tasks.find(t => !t.deleted_at && !S.hasCheckpoints(t));
  S.openTaskDetail(anyTask.id);
  const detailHTML = q('#modal-body').innerHTML;
  ok('任务详情里 plan_date 渲染的是 type="date"', new RegExp(`<input id="td-plan_date" type="date" value="${anyTask.plan_date || ''}">`).test(detailHTML));
  ok('任务详情里 actual_date 也是 type="date"', /<input id="td-actual_date" type="date"/.test(detailHTML));
  q('#td-plan_date').value = '2026-10-20';
  await S.modalCallback(); await tick();
  ok('保存后任务的 plan_date 确实变成了原生控件给的值', S.byId('task', anyTask.id).plan_date === '2026-10-20');
  const cpHTML = S.cpRowHTML(null);
  ok('里程碑的 cp-date 还是原来那套（type="date"，没有被这次改动动到）', /<input type="date" class="cp-date" value="">/.test(cpHTML));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
