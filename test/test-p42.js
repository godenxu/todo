/* P42：数据事故修复——"同事只改了一条里程碑的日期，结果任务下多出好几套重复里程碑"

   现场描述：同事在任务详情里改了一条里程碑的计划完成时间，点保存"没有反应"，
   后来管理员打开数据一看，那条任务下多出很多重复的里程碑。

   根因是两个缺陷叠在一起：
   ① 保存里程碑用的是"把原有的整批软删除，再按界面上的行重新建一批新记录"。
      界面上的行没有携带自己对应的记录 id（cpRowHTML 里没有 data-ms-id），所以只能这么干。
      这让保存不是幂等的：同一份内容存两次 = 多一整套重复里程碑。
   ② 弹窗的"确定"按钮既不 await 回调也不上锁（`if (cb) cb();`）。
      而保存要走一次共享文件的读—合并—写，在网络盘上可能好几秒，
      这几秒里弹窗还开着、按钮还能点、界面上没有任何"正在保存"的迹象——
      这正是同事说的"点了没反应"。于是他又点了几下，同一个保存被完整跑了好几遍，
      配合①，每跑一遍就多一整套重复里程碑。

   修复：
   ① 每行带上 data-ms-id，保存改成"按 id 就地更新、界面上没有的才删、真新增的才建"，点几次结果都一样；
   ② 确定按钮执行期间上锁 + 置灰显示"处理中…"；
   ③ 已经躺在共享文件里的重复数据，加一个数据体检项一键清理。
   用法：node test/test-p42.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// 造一批假的里程碑编辑行，冒充 $$('#cp-list [data-cp-row]') 的返回值。
// 真实浏览器里这些行是 cpRowHTML 渲染出来的 DOM，Node 里的 DOM 桩不做选择器匹配，只能这样喂。
function fakeRow({ id = '', plan_date = '', deliverable = '', report_level = 'section', done = false }) {
  const cell = v => ({ value: v, checked: !!v });
  return {
    getAttribute: k => (k === 'data-ms-id' ? id : null),
    querySelector: sel => {
      if (sel === '.cp-date') return cell(plan_date);
      if (sel === '.cp-deliv') return cell(deliverable);
      if (sel === '.cp-report-level') return cell(report_level);
      if (sel === '.cp-chk') return { checked: !!done, value: done ? '1' : '0' };
      return null;
    },
  };
}
// 把这些行接到 document.querySelectorAll 上（只拦 cp-list 那个选择器，其它照旧返回空）
function useRows(rows) {
  raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? rows : []);
}

async function main() {
  await tick(60);
  const bakQSA = raw.document.querySelectorAll;
  const restore = () => { raw.document.querySelectorAll = bakQSA; };

  const dutyCode = 'P42D';
  await S.Repo.upsert('duty', { code: dutyCode, name: 'P42测试职责' });
  const wid = 'p42_w';
  await S.Repo.upsert('work', { id: wid, duty: dutyCode, name: 'P42测试工作', owner: '测试管理员' });
  const tid = 'p42_task';
  await S.Repo.upsert('task', { id: tid, work: wid, title: 'P42任务', status: 'doing',
    plan_date: S.offsetDate(90), owner: '测试管理员', assignees: [] });
  // 三条里程碑，日期递增（避免触发"顺序看起来不太对"的二次确认，那会打断保存流程）
  const msIds = ['p42_m1', 'p42_m2', 'p42_m3'];
  await S.Repo.upsert('milestone', { id: msIds[0], task: tid, plan_date: S.offsetDate(10), deliverable: '交付物甲', report_level: 'section', done: '0' });
  await S.Repo.upsert('milestone', { id: msIds[1], task: tid, plan_date: S.offsetDate(20), deliverable: '交付物乙', report_level: 'section', done: '0' });
  await S.Repo.upsert('milestone', { id: msIds[2], task: tid, plan_date: S.offsetDate(30), deliverable: '交付物丙', report_level: 'section', done: '0' });
  const aliveMs = () => S.DB.milestones.filter(m => m.task === tid && !m.deleted_at);

  section('★渲染：每一行里程碑都要带上自己对应的记录 id（整个修复的地基）');
  const rowHtml = S.cpRowHTML(S.byId('milestone', msIds[0]));
  ok('编辑行带了 data-ms-id', rowHtml.includes(`data-ms-id="${msIds[0]}"`), rowHtml);
  ok('全新空白行的 data-ms-id 是空的（表示"还没有对应记录"）', S.cpRowHTML(null).includes('data-ms-id=""'));

  section('★①：只改一条里程碑的日期并保存——另外两条必须原地不动，不能被删了重建');
  ok('保存前 3 条里程碑', aliveMs().length === 3, aliveMs().length);
  const newDate = S.offsetDate(15);
  S.openTaskDetail(tid);
  q('#td-title').value = 'P42任务';
  q('#td-owner').value = '测试管理员';
  useRows([
    fakeRow({ id: msIds[0], plan_date: newDate, deliverable: '交付物甲' }),   // ← 只动了这条的日期
    fakeRow({ id: msIds[1], plan_date: S.offsetDate(20), deliverable: '交付物乙' }),
    fakeRow({ id: msIds[2], plan_date: S.offsetDate(30), deliverable: '交付物丙' }),
  ]);
  await S.ACTIONS['modal-ok']();
  ok('保存后还是 3 条，没有变成 6 条', aliveMs().length === 3, aliveMs().map(m => m.deliverable));
  ok('改的那条日期确实改了', S.byId('milestone', msIds[0]).plan_date === newDate);
  ok('★这三条还是原来那三条记录（id 没变）——id 一变，多人同步就对不上账了',
    aliveMs().every(m => msIds.includes(m.id)), aliveMs().map(m => m.id));
  ok('没被动过的那两条内容也没变', S.byId('milestone', msIds[1]).deliverable === '交付物乙'
    && S.byId('milestone', msIds[2]).deliverable === '交付物丙');

  section('★①核心：同一份内容连存两次，结果必须一模一样（幂等）');
  const rows = [
    fakeRow({ id: msIds[0], plan_date: newDate, deliverable: '交付物甲' }),
    fakeRow({ id: msIds[1], plan_date: S.offsetDate(20), deliverable: '交付物乙' }),
    fakeRow({ id: msIds[2], plan_date: S.offsetDate(30), deliverable: '交付物丙' }),
  ];
  for (let i = 0; i < 4; i++) {
    S.openTaskDetail(tid);
    q('#td-title').value = 'P42任务';
    useRows(rows);
    await S.ACTIONS['modal-ok']();
  }
  ok('★连存 4 次之后，仍然只有 3 条里程碑（出事故的老代码这里会变成 15 条）',
    aliveMs().length === 3, aliveMs().length);
  ok('id 依旧是最初那三个', aliveMs().every(m => msIds.includes(m.id)));

  section('★★事故复现：同一次打开的弹窗里，保存被连着执行多次（这才是真正炸出重复数据的路径）');
  // 现实中就是这样：弹窗一直开着，保存在等共享文件读写，用户以为没反应就连点了几下。
  // 这里绕开"确定按钮上锁"那道防线，直接把保存回调连调三次——
  // 为的是验证第一道防线（按 id 就地更新）自己就够，不依赖第二道。
  // 老代码在这里会炸：existingCps 是弹窗打开时抓的那一份，第二次执行时它们已经被软删除了，
  // 于是"删掉旧的"变成空操作，"重建一批新的"却照跑不误 —— 每点一次多一整套。
  S.openTaskDetail(tid);
  q('#td-title').value = 'P42任务';
  useRows([
    fakeRow({ id: msIds[0], plan_date: newDate, deliverable: '交付物甲' }),
    fakeRow({ id: msIds[1], plan_date: S.offsetDate(20), deliverable: '交付物乙' }),
    fakeRow({ id: msIds[2], plan_date: S.offsetDate(30), deliverable: '交付物丙' }),
  ]);
  const saveCb = S.modalCallback;
  await saveCb();
  await saveCb();
  await saveCb();
  ok('★同一个弹窗里连存 3 次，依然只有 3 条里程碑（老代码到这里会变成 9 条）',
    aliveMs().length === 3, aliveMs().length);
  ok('★而且还是原来那三条记录，没有被换成新 id',
    aliveMs().every(m => msIds.includes(m.id)), aliveMs().map(m => m.id));
  // 注意要拿"条数 == 去重后的条数"来判，不能只看去重后有几种——
  // 老代码那 9 条正好是 3 组各 3 份，只看种类数是 3，反而看不出问题
  ok('没有产生任何内容重复的里程碑',
    new Set(aliveMs().map(m => m.plan_date + '|' + m.deliverable)).size === aliveMs().length,
    aliveMs().length);

  section('★①：界面上真删掉一行 / 真加一行，仍然要照做');
  S.openTaskDetail(tid);
  q('#td-title').value = 'P42任务';
  useRows([
    fakeRow({ id: msIds[0], plan_date: newDate, deliverable: '交付物甲' }),
    fakeRow({ id: '', plan_date: S.offsetDate(40), deliverable: '新加的交付物丁' }),   // 新行没有 id
  ]);
  await S.ACTIONS['modal-ok']();
  const after = aliveMs();
  ok('界面上剩 2 行，库里就该剩 2 条', after.length === 2, after.map(m => m.deliverable));
  ok('留下的那条还是原来的记录', after.some(m => m.id === msIds[0]));
  ok('新加的那条真的建出来了', after.some(m => m.deliverable === '新加的交付物丁'));
  ok('被删掉的两条是软删除（还能在「已删除」里找回来），不是凭空消失',
    S.DB.milestones.filter(m => [msIds[1], msIds[2]].includes(m.id)).every(m => !!m.deleted_at));

  section('★①：把删掉的行又提交回来，等于撤销删除，不该新建一条重复的');
  S.openTaskDetail(tid);
  q('#td-title').value = 'P42任务';
  useRows([
    fakeRow({ id: msIds[0], plan_date: newDate, deliverable: '交付物甲' }),
    fakeRow({ id: msIds[1], plan_date: S.offsetDate(20), deliverable: '交付物乙' }),   // 复活
  ]);
  await S.ACTIONS['modal-ok']();
  ok('复活的是原来那条记录，没有产生新 id', !S.byId('milestone', msIds[1]).deleted_at);
  ok('总数正确（2 条），没有多出重复的', aliveMs().length === 2, aliveMs().map(m => m.deliverable));

  section('★②：确定按钮执行期间上锁——连点不会把同一个保存跑好几遍');
  restore();
  let runs = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  S.ACTIONS['modal-cancel']();
  raw.__openTestModal = null;
  // 直接用一个慢回调冒充"保存要等共享文件读写好几秒"
  S.openModal('测试', '<p>x</p>', '保存', async () => { runs++; await gate; });
  const p1 = S.ACTIONS['modal-ok']();
  const p2 = S.ACTIONS['modal-ok']();   // 用户觉得没反应，又点了一下
  const p3 = S.ACTIONS['modal-ok']();   // 再点一下
  ok('按钮置灰了', q('#modal-ok-btn').disabled === true);
  ok('按钮文案变成"处理中…"，让人看得出它在干活', q('#modal-ok-btn').textContent === '处理中…',
    q('#modal-ok-btn').textContent);
  release();
  await Promise.all([p1, p2, p3]);
  ok('★三次点击只真正执行了一次', runs === 1, runs);
  ok('执行完按钮恢复可点', q('#modal-ok-btn').disabled === false);
  ok('按钮文案还原', q('#modal-ok-btn').textContent === '保存', q('#modal-ok-btn').textContent);
  S.ACTIONS['modal-cancel']();

  section('★②：回调里又开了新弹窗时，不能把新弹窗的按钮文案覆盖掉');
  S.openModal('外层', '<p>x</p>', '保存', async () => {
    S.openModal('里层确认', '<p>y</p>', '仍然保存', async () => {});
  });
  await S.ACTIONS['modal-ok']();
  ok('按钮显示的是新弹窗自己的文案', q('#modal-ok-btn').textContent === '仍然保存', q('#modal-ok-btn').textContent);
  ok('新弹窗的按钮是可点的', q('#modal-ok-btn').disabled === false);
  S.ACTIONS['modal-cancel']();

  section('★②：回调抛异常也要解锁，不能把弹窗永久卡死');
  S.openModal('会炸的', '<p>x</p>', '确定', async () => { throw new Error('故意炸一下'); });
  let threw = false;
  try { await S.ACTIONS['modal-ok'](); } catch (e) { threw = true; }
  ok('异常照常抛出（不吞错）', threw);
  ok('但按钮解锁了，不会卡在"处理中…"回不来', q('#modal-ok-btn').disabled === false);
  let runs2 = 0;
  S.openModal('再来', '<p>x</p>', '确定', async () => { runs2++; });
  await S.ACTIONS['modal-ok']();
  ok('后续弹窗还能正常用（锁没有泄漏）', runs2 === 1);
  S.ACTIONS['modal-cancel']();

  section('★③：数据体检能识别并清理已经产生的重复里程碑');
  // 造一组"老代码留下的"重复：内容完全一样、只是 id 不同
  const base = { task: tid, plan_date: S.offsetDate(60), deliverable: '重复的交付物', report_level: 'section', done: '0' };
  await S.Repo.upsert('milestone', Object.assign({ id: 'p42_dup_a', created_at: '2026-01-01T00:00:00.000Z' }, base));
  await S.Repo.upsert('milestone', Object.assign({ id: 'p42_dup_b', created_at: '2026-02-01T00:00:00.000Z' }, base));
  await S.Repo.upsert('milestone', Object.assign({ id: 'p42_dup_c', created_at: '2026-03-01T00:00:00.000Z' }, base));
  // 只有日期差一天的，不算重复——判重必须严，宁可漏掉也不能误删别人真填的东西
  await S.Repo.upsert('milestone', Object.assign({}, base, { id: 'p42_notdup', plan_date: S.offsetDate(61) }));
  let hc = S.healthCheck();
  const dupIssue = hc.issues.find(i => i.k === 'dupMs');
  ok('体检报出了重复里程碑', !!dupIssue, hc.issues.map(i => i.k));
  ok('数出来的是 2 个（三条一模一样的里程碑，多余的是 2 条）', dupIssue && dupIssue.n === 2, dupIssue && dupIssue.n);
  ok('这一项带一键修复按钮', !!(dupIssue && dupIssue.fix));
  await S.fixHealth('dupMs');
  ok('最早创建的那条留下来了', !S.byId('milestone', 'p42_dup_a').deleted_at);
  ok('后来那两条被删掉了',
    !!S.byId('milestone', 'p42_dup_b').deleted_at && !!S.byId('milestone', 'p42_dup_c').deleted_at);
  ok('只差一天的那条没被误删（判重必须严）', !S.byId('milestone', 'p42_notdup').deleted_at);
  ok('删的是软删除，「已删除」里还找得回来', S.DB.milestones.some(m => m.id === 'p42_dup_b'));
  hc = S.healthCheck();
  ok('修完这一项就消失了', !hc.issues.some(i => i.k === 'dupMs'));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
