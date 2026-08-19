/* P84：工作台"导出季度考核目标"——把这个人牵头/参与的工作转换成考核指标草稿
   （指标名称/指标详细描述/当前目标/年度目标），弹窗里放文本框 + 一键复制按钮。
   方案要点（用户已确认）：
   1) 指标粒度按"工作"分组，不是按任务
   2) "当前目标"跟随工作台当前选中的周期（周/月/季/年），"年度目标"跟随 DB.settings.year
      （没设就用当前自然年），不是写死季度
   用法：node test/test-p84.js */
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
  const bakMe = S.DB.settings.me, bakYear = S.DB.settings.year;
  const bakViewAs = S.dashViewAsPerson;
  const restore = () => {
    S.DB.settings.me = bakMe;
    S.DB.settings.year = bakYear;
    S.setDashViewAsPerson(bakViewAs);
    S.closeModal();
  };

  section('①：buildAssessmentGoalsText——按工作分组，四字段齐全');
  await S.Repo.upsert('duty', { code: 'P84D', name: 'P84职责' });
  await S.Repo.upsert('work', { id: 'p84_w', duty: 'P84D', code: 'W1', name: 'P84工作', owner: '', collaborators: [], content: ['做A事', '做B事'] });
  await S.Repo.upsert('task', {
    id: 'p84_t1', work: 'p84_w', title: 'P84任务甲', status: 'doing', owner: 'P84张', assignees: [],
    plan_date: S.todayStr(),
  });
  await S.Repo.upsert('milestone', { id: 'p84_ms1', task: 'p84_t1', plan_date: S.todayStr(), deliverable: 'P84交付物A', done: '0' });
  await S.Repo.upsert('task', {
    id: 'p84_t2', work: 'p84_w', title: 'P84任务乙', status: 'todo', owner: 'P84李', assignees: ['P84张'],
    plan_date: S.todayStr(),
  });
  S.rebuildIndex();
  S.setDashPeriod('week'); S.setDashOffset(0);
  const text1 = S.buildAssessmentGoalsText('P84张', 'week', 0);
  ok('★带上职责标题，中文数字编号', text1.includes('一、P84职责'), text1);
  ok('★指标名称带角色标注——这个人在这项工作下既牵头又参与', text1.includes('P84工作（牵头+参与）'));
  ok('★指标名称字段', text1.includes('指标名称：P84工作'));
  ok('★指标详细描述带上工作的"主要工作内容"，按显示惯例编号（N、内容）', text1.includes('1、做A事') && text1.includes('2、做B事'));
  ok('★指标详细描述带上这个人牵头/参与的具体任务', text1.includes('牵头：P84任务甲') && text1.includes('参与：P84任务乙'));
  ok('★"当前目标"字段标签跟着周期走——这里是"本周目标"', text1.includes('本周目标：'));
  ok('★本周目标：有里程碑的任务显示交付物文字', text1.includes('P84任务甲：P84交付物A'));
  ok('★本周目标：没挂里程碑的任务退回"完成XX任务"', text1.includes('完成P84任务乙'));
  ok('★年度目标字段存在', text1.includes('年度目标：'));

  section('②：★逾期任务算进"当前目标"（不能因为不在周期窗口内就消失），但不算进"年度目标"（如果逾期是去年的账）');
  const lastYear = new Date().getFullYear() - 1;
  await S.Repo.upsert('task', {
    id: 'p84_t3', work: 'p84_w', title: 'P84任务丙', status: 'todo', owner: 'P84张', assignees: [],
    plan_date: `${lastYear}-01-15`,
  });
  S.rebuildIndex();
  const text2 = S.buildAssessmentGoalsText('P84张', 'week', 0);
  ok('★去年就该完成、至今没完成的任务，本周目标里能看到（欠账不能凭空消失）', text2.includes('完成P84任务丙'));
  // 年度目标窗口默认是"当前自然年"，去年的逾期账不落在这个窗口里，所以不该出现在年度目标那一行
  const yearLine = text2.split('\n').find(l => l.includes('年度目标：'));
  ok('★年度目标那一行没有把去年的逾期账也算进来', yearLine && !yearLine.includes('P84任务丙'), yearLine);
  await S.Repo.upsert('task', { id: 'p84_t3', deleted_at: new Date().toISOString() });
  S.rebuildIndex();

  section('③：没有任何工作的人 / 空 person');
  ok('★没有牵头或参与任何工作，给出说明文字而不是空文本', S.buildAssessmentGoalsText('P84没人认识的人', 'week', 0).includes('目前没有牵头或参与任何工作，无法生成考核目标'));
  ok('★person 是空字符串，直接返回空字符串', S.buildAssessmentGoalsText('', 'week', 0) === '');

  section('④：★年度目标口径跟着 DB.settings.year 走，不是写死"今年"');
  S.DB.settings.year = lastYear;
  await S.Repo.upsert('task', {
    id: 'p84_t4', work: 'p84_w', title: 'P84任务丁', status: 'todo', owner: 'P84张', assignees: [],
    plan_date: `${lastYear}-06-15`,
  });
  S.rebuildIndex();
  const text4 = S.buildAssessmentGoalsText('P84张', 'week', 0);
  const yearLine4 = text4.split('\n').find(l => l.includes('年度目标：'));
  ok('★把 DB.settings.year 切到去年后，落在去年的任务出现在年度目标里', yearLine4 && yearLine4.includes('完成P84任务丁'), yearLine4);
  S.DB.settings.year = bakYear;
  await S.Repo.upsert('task', { id: 'p84_t4', deleted_at: new Date().toISOString() });
  S.rebuildIndex();

  section('⑤：★ACTIONS[dash-export-goals]——没设使用者时给提示，不弹窗');
  S.closeModal();
  S.DB.settings.me = '';
  S.setDashViewAsPerson('');
  S.setSnackPriorityUntil(0);
  S.ACTIONS['dash-export-goals']();
  ok('★提示"请先设置本机使用者"', q('#snack-msg').textContent.includes('请先设置本机使用者'));
  ok('★没有弹窗', !q('#modal-overlay').classList.contains('show'));

  section('⑤：★设了使用者——弹窗标题带人名和周期，正文有文本框，"确定"按钮变成"一键复制"');
  S.DB.settings.me = 'P84张';
  S.setDashPeriod('month'); S.setDashOffset(0);
  S.ACTIONS['dash-export-goals']();
  ok('★弹窗标题带人名', q('#modal-title').textContent.includes('P84张'));
  ok('★弹窗标题带当前周期标签（本月）', q('#modal-title').textContent.includes('本月'));
  ok('★弹窗加宽了', q('#modal-box').classList.contains('wide'));
  const modalBody = q('#modal-body').innerHTML;
  ok('★正文里有只读文本框，id 是 goals-ta', modalBody.includes('id="goals-ta"') && modalBody.includes('readonly'));
  ok('★文本框内容是生成好的考核目标文本', modalBody.includes('P84工作（牵头+参与）') && modalBody.includes('本月目标：'));
  ok('★"确定"按钮文案换成了"一键复制"', q('#modal-ok-btn').textContent === '📋 一键复制');

  section('⑥：★copyAssessmentGoalsText——复制成功/降级/彻底失败三种路径');
  q('#goals-ta').value = 'P84测试复制内容';
  let capturedText = null;
  raw.navigator.clipboard.writeText = async t => { capturedText = t; };
  await S.copyAssessmentGoalsText();
  ok('★优先走 navigator.clipboard.writeText，且传的是文本框里的内容', capturedText === 'P84测试复制内容');
  ok('★成功后按钮文案变成"已复制 ✓"', q('#modal-ok-btn').textContent === '已复制 ✓');

  raw.navigator.clipboard.writeText = async () => { throw new Error('非安全上下文，没这个权限'); };
  raw.document.execCommand = () => true;
  await S.copyAssessmentGoalsText();
  ok('★clipboard API 失败时退回 execCommand(\'copy\')，一样算成功', q('#modal-ok-btn').textContent === '已复制 ✓');

  raw.document.execCommand = () => false;
  await S.copyAssessmentGoalsText();
  ok('★两种方式都失败，老实告诉用户自己复制，不装作成功', q('#modal-ok-btn').textContent === '复制失败，请手动 Ctrl+C');

  raw.navigator.clipboard.writeText = async () => {};
  raw.document.execCommand = () => true;

  restore();
  await S.Repo.upsert('task', { id: 'p84_t1', deleted_at: new Date().toISOString() });
  await S.Repo.upsert('task', { id: 'p84_t2', deleted_at: new Date().toISOString() });
  await S.Repo.upsert('work', { id: 'p84_w', deleted_at: new Date().toISOString() });
  await S.Repo.upsert('duty', { code: 'P84D', deleted_at: new Date().toISOString() });
  S.rebuildIndex();

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
