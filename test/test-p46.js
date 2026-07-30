/* P46：本轮两项修订——
   1) 日期输入框改成"只认连续数字"的文本框，不再依赖原生 <input type="date"> 的分段顺序。
      原生日期控件敲数字时按年/月/日哪个顺序分段，是浏览器按当前系统/浏览器地区设置自己决定的，
      网页设了 <html lang="zh-CN"> 也不保证生效——同一份 html 在不同人电脑上，敲同样的数字
      "202707"可能被分出完全不一样的结果。现在改成前 4 位定死是年、接下来 2 位是月、
      最后 2 位是日，敲多少位就分多少段，跟系统/浏览器设置完全无关。
   2) 改进度要能联动状态：进度过半了状态不能还停在"未开始"，进度到 100% 该自动算完成，
      进度掉回去了也不该还挂着"已完成"；已挂起的任务是主动暂停，两个方向都不碰。
      数据体检里新增一项，把历史遗留的这类矛盾数据一次性挑出来、一键按同一套规则修复。
   用法：node test/test-p46.js */
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
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const bakMs = JSON.parse(JSON.stringify(S.DB.milestones));
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.DB.milestones = JSON.parse(JSON.stringify(bakMs));
    S.DB.settings.me = bakMe;
    S.rebuildIndex();
  };

  section('★①：连续数字按 4/2/2 分段——这是整个修复的核心诉求');
  ok('敲到第 4 位，先只是年份', S.digitsToDateStr('2027') === '2027');
  ok('★敲第 5、6 位（"202707"）自动分出年+月，不多等、不错位',
    S.digitsToDateStr('202707') === '2027-07', S.digitsToDateStr('202707'));
  ok('敲满 8 位，年/月/日三段都分出来', S.digitsToDateStr('20270715') === '2027-07-15');
  ok('超过 8 位的多余数字被丢弃，不会越敲越长', S.digitsToDateStr('202707159999') === '2027-07-15');
  ok('dateStrToDigits 把已有的"-"等分隔符都去掉，只留数字', S.dateStrToDigits('2027-07-15') === '20270715');
  ok('也认直接带"-"敲的输入（先去分隔符再重新分段，结果一样）',
    S.digitsToDateStr(S.dateStrToDigits('2027-07-15')) === '2027-07-15');

  section('★①：完整性 + 真实日期校验——不能存一个"看着像日期但其实不存在"的东西');
  ok('2月30号不是真实存在的日子，判定无效', S.isValidDateStr('2027-02-30') === false);
  ok('平年2月29号也不存在', S.isValidDateStr('2027-02-29') === false);
  ok('闰年2月29号是合法的', S.isValidDateStr('2028-02-29') === true);
  ok('正常日期合法', S.isValidDateStr('2027-07-15') === true);
  ok('位数不对（没敲完）判定无效', S.isValidDateStr('2027-07') === false);
  ok('月份 13 不合法', S.isValidDateStr('2027-13-01') === false);

  section('★①：normalizeMaskedDateValue——读值时的双保险，不完全依赖 blur 一定先触发');
  ok('敲完整、真实存在的日期，原样通过', S.normalizeMaskedDateValue('20270715') === '2027-07-15');
  ok('★没敲完（只有年+月）时不能留一个半成品，读出来是空的', S.normalizeMaskedDateValue('202707') === '');
  ok('敲出来的不是真实日期，也读成空', S.normalizeMaskedDateValue('20270230') === '');
  ok('本来就是空的，还是空', S.normalizeMaskedDateValue('') === '');
  ok('已经是标准格式的直接认', S.normalizeMaskedDateValue('2027-07-15') === '2027-07-15');

  section('★①：实时输入格式化 + 失焦校验（模拟 document 级委托监听实际会做的事）');
  const fakeInput = { value: '2' };
  S.maskDateInputLive(fakeInput); ok('敲第1位', fakeInput.value === '2');
  fakeInput.value += '0'; S.maskDateInputLive(fakeInput);
  fakeInput.value += '2'; S.maskDateInputLive(fakeInput);
  fakeInput.value += '7'; S.maskDateInputLive(fakeInput); ok('敲满4位还是纯年份', fakeInput.value === '2027');
  fakeInput.value += '0'; S.maskDateInputLive(fakeInput);
  fakeInput.value += '7'; S.maskDateInputLive(fakeInput);
  ok('★敲到第6位，实时显示已经自动分出了"2027-07"', fakeInput.value === '2027-07', fakeInput.value);
  fakeInput.value += '1'; S.maskDateInputLive(fakeInput);
  fakeInput.value += '5'; S.maskDateInputLive(fakeInput);
  ok('敲满8位，完整显示"2027-07-15"', fakeInput.value === '2027-07-15');
  const half = { value: '202707' };
  S.normalizeMaskedDateOnBlur(half);
  ok('只敲了年+月就离开框，blur 时清空（不留半成品）', half.value === '');
  const bad = { value: '20270230' };
  S.normalizeMaskedDateOnBlur(bad);
  ok('敲出一个不存在的日子，blur 时也清空', bad.value === '');
  const full = { value: '20270715' };
  S.normalizeMaskedDateOnBlur(full);
  ok('敲完整且合法，blur 时补上"-"变成标准格式', full.value === '2027-07-15');

  section('★①：任务详情/批量编辑的日期框——不再是原生 type=date，而是数字文本框');
  const planField = S.fieldDef('task', 'plan_date');
  const ctrlHtml = S.fieldControl(planField, '2027-07-15', 'td-');
  ok('不再是 type="date"', !ctrlHtml.includes('type="date"'));
  ok('换成了带 date-mask 标记的数字文本框', ctrlHtml.includes('date-mask') && ctrlHtml.includes('inputmode="numeric"'), ctrlHtml);
  ok('占位符提示格式，帮用户知道该怎么敲', ctrlHtml.includes('YYYY-MM-DD'));
  q('#td-plan_date').value = '20271225';
  ok('readControl 把敲的数字规整成标准日期', S.readControl(planField, 'td-') === '2027-12-25');
  q('#td-plan_date').value = '202712';   // 只敲了年月就直接读（没走 blur）
  ok('★readControl 自己也会校验，没敲完整的不会被存下来', S.readControl(planField, 'td-') === '');

  section('★①：里程碑检查点行的日期框同理');
  const cpHtml = S.cpRowHTML(null);
  ok('cp-date 也不再是原生 type="date"', !cpHtml.includes('type="date"'));
  ok('同样是数字文本框', cpHtml.includes('cp-date') && cpHtml.includes('date-mask'), cpHtml);

  section('★②：reconcileStatusAndProgress——进度过半了，状态不能还停在未开始');
  restore();
  let t = { status: 'todo', progress: 0, actual_date: '' };
  let before = Object.assign({}, t);
  t.progress = 55;
  S.reconcileStatusAndProgress(t, before);
  ok('★进度推进了，状态自动从"未开始"变成"进行中"', t.status === 'doing', t.status);

  section('★②：进度到 100%，自动算完成，并补上实际完成时间');
  t = { status: 'doing', progress: 60, actual_date: '' };
  before = Object.assign({}, t);
  t.progress = 100;
  S.reconcileStatusAndProgress(t, before);
  ok('状态自动变成已完成', t.status === 'done');
  ok('顺手补上了实际完成时间', !!t.actual_date);

  section('★②：进度从100%掉下来了，不该还挂着已完成');
  t = { status: 'done', progress: 100, actual_date: '2026-01-01' };
  before = Object.assign({}, t);
  t.progress = 60;
  S.reconcileStatusAndProgress(t, before);
  ok('★状态从已完成退回进行中', t.status === 'doing', t.status);
  ok('实际完成时间被清掉（不再是真的完成了）', t.actual_date === '');

  section('★②：进度为0时，不强行把"进行中"打回"未开始"（不做没把握的反向猜测）');
  t = { status: 'doing', progress: 30, actual_date: '' };
  before = Object.assign({}, t);
  t.progress = 0;
  S.reconcileStatusAndProgress(t, before);
  ok('进度归零，状态维持"进行中"不变', t.status === 'doing', t.status);

  section('★②：已挂起是主动选择的暂停状态，两个方向都不碰');
  t = { status: 'hold', progress: 0, actual_date: '' };
  before = Object.assign({}, t);
  t.progress = 80;
  S.reconcileStatusAndProgress(t, before);
  ok('进度再怎么变，挂起状态也不会被自动改掉', t.status === 'hold');

  section('★②：用户自己也显式改了状态下拉框——尊重这个显式选择，不跟自动规则打架');
  t = { status: 'todo', progress: 10, actual_date: '' };
  before = Object.assign({}, t);
  t.status = 'done';   // 用户自己在表单里选了"已完成"，进度还没顺手改
  S.reconcileStatusAndProgress(t, before);
  ok('尊重用户选的"已完成"，不会因为进度只有10%就打回进行中', t.status === 'done', t.status);
  ok('★但没有检查点时，进度顺带补到100%，跟状态摆正', t.progress === 100, t.progress);
  t = { status: 'done', progress: 100, actual_date: '2026-01-01' };
  before = Object.assign({}, t);
  t.status = 'doing';   // 用户自己把状态从已完成改回进行中
  S.reconcileStatusAndProgress(t, before);
  ok('用户显式改回进行中，实际完成时间清掉', t.actual_date === '');
  ok('进度这里不强行清零，交给用户自己去调', t.progress === 100);

  section('★②：任务详情弹窗保存时，进度和状态要统一对账');
  restore();
  const dutyCode = 'P46D'; await S.Repo.upsert('duty', { code: dutyCode, name: 'P46测试职责' });
  const wid = 'p46_w'; await S.Repo.upsert('work', { id: wid, duty: dutyCode, name: 'P46测试工作', owner: '测试管理员' });
  const tid = 'p46_task';
  await S.Repo.upsert('task', { id: tid, work: wid, title: 'P46任务', status: 'todo', progress: 0, plan_date: S.offsetDate(30), owner: '测试管理员', assignees: [] });
  S.openTaskDetail(tid);
  q('#td-title').value = 'P46任务';
  q('#td-owner').value = '测试管理员';
  q('#td-status').value = 'todo';   // 没碰状态下拉框，维持原状——DOM 桩不会像真浏览器那样自动回显 selected 选项
  q('#td-progress').value = '70';
  raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? [] : []);
  await S.ACTIONS['modal-ok']();
  ok('★任务详情里只改了进度，保存后状态自动跳出"未开始"', S.byId('task', tid).status === 'doing', S.byId('task', tid));

  section('★②：数据体检能识别出历史遗留的"进度/状态对不上"数据，并一键修复');
  restore();
  const dutyCode2 = 'P46D2'; await S.Repo.upsert('duty', { code: dutyCode2, name: 'P46测试职责2' });
  const wid2 = 'p46_w2'; await S.Repo.upsert('work', { id: wid2, duty: dutyCode2, name: 'P46测试工作2', owner: '测试管理员' });
  // 历史遗留的矛盾数据：直接写库，绕开所有联动逻辑，模拟"以前改进度不会联动状态"年代留下的老数据
  S.DB.tasks.push({ id: 'p46_bad1', work: wid2, title: 'P46矛盾任务一（进度过半却未开始）', status: 'todo', progress: 60, owner: '测试管理员', assignees: [], plan_date: S.offsetDate(10) });
  S.DB.tasks.push({ id: 'p46_bad2', work: wid2, title: 'P46矛盾任务二（标了完成进度却没到100）', status: 'done', progress: 40, owner: '测试管理员', assignees: [], plan_date: S.offsetDate(10) });
  S.DB.tasks.push({ id: 'p46_hold', work: wid2, title: 'P46挂起任务（不该被算进去）', status: 'hold', progress: 0, owner: '测试管理员', assignees: [], plan_date: S.offsetDate(10) });
  S.rebuildIndex();
  let hc = S.healthCheck();
  const issue = hc.issues.find(i => i.k === 'progressMismatch');
  ok('体检报出了这项问题', !!issue, hc.issues.map(i => i.k));
  // 种子数据本身可能也含有随机生成出来的矛盾任务，不强求总数恰好是 2——
  // 只要求"我们特意造的这两条"确实被点出来了，这个断言不受种子数据具体内容影响
  ok('两条矛盾任务都在体检结果里', issue && issue.n >= 2
    && S.healthCheck().progressMismatch.some(t => t.id === 'p46_bad1')
    && S.healthCheck().progressMismatch.some(t => t.id === 'p46_bad2'), issue);
  ok('挂起的那条不在里面（不该被算进去）', !S.healthCheck().progressMismatch.some(t => t.id === 'p46_hold'));
  ok('带了一键修复', !!(issue && issue.fix));
  await S.fixHealth('progressMismatch');
  ok('矛盾任务一：状态自动纠正为进行中', S.byId('task', 'p46_bad1').status === 'doing', S.byId('task', 'p46_bad1'));
  ok('矛盾任务二：状态从已完成退回进行中', S.byId('task', 'p46_bad2').status === 'doing', S.byId('task', 'p46_bad2'));
  ok('矛盾任务二的实际完成时间也清掉了', S.byId('task', 'p46_bad2').actual_date === '');
  ok('挂起的任务没被动过', S.byId('task', 'p46_hold').status === 'hold' && S.byId('task', 'p46_hold').progress === 0);
  hc = S.healthCheck();
  ok('修完之后，我们特意造的这两条都不再出现在问题列表里',
    !hc.progressMismatch.some(t => t.id === 'p46_bad1' || t.id === 'p46_bad2'));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
