/* P20：本轮改动测试——
   1) 工作台"人员负荷"统计里区分"未开始"：以前 todo/doing 混在一个"在办"桶里，现在拆成两段，
      todo 用新的 --c-todo 颜色单独渲染，legend/tooltip 同步更新
   2) 共享文件夹手动连接时，先弹一个小提示框讲清楚要选处里共享的那个文件夹（工号/路径模板那套已经
      废弃——身份认证改回姓名+PIN，见后续批次），确认后才真的弹系统选择框
   用法：node test/test-p20.js */
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
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const bakShareConfig = S.DB.shareConfig;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.shareConfig = bakShareConfig;
    S.setFileHandle(null);
  };

  section('工作台人员负荷：未开始单独统计，不再跟"进行中"混在一起');
  const dutyCode = 'P20LOAD';
  await S.Repo.upsert('duty', { code: dutyCode, name: 'P20负荷测试职责' });
  const wid = 'w_p20load';
  await S.Repo.upsert('work', { id: wid, duty: dutyCode, name: 'P20负荷测试工作', owner: '测试管理员' });
  const owner = 'P20负荷测试人';
  await S.Repo.upsert('task', { id: 'p20_load_todo', work: wid, title: 'P20未开始任务', status: 'todo', plan_date: S.offsetDate(10), owner, assignees: [] });
  await S.Repo.upsert('task', { id: 'p20_load_doing', work: wid, title: 'P20进行中任务', status: 'doing', plan_date: S.offsetDate(10), owner, assignees: [] });
  await S.Repo.upsert('task', { id: 'p20_load_late', work: wid, title: 'P20逾期任务', status: 'todo', plan_date: S.offsetDate(-3), owner, assignees: [] });
  await S.Repo.upsert('task', { id: 'p20_load_done', work: wid, title: 'P20已完成任务', status: 'done', plan_date: S.offsetDate(-1), actual_date: S.todayStr(), owner, assignees: [] });
  S.setPage('dashboard'); S.renderDashboard();
  const dashH = q('#page-dashboard').innerHTML;
  ok('人员负荷这一行渲染了 seg-todo（未开始单独一段）',
    new RegExp(`data-person="${owner}"[\\s\\S]{0,400}class="seg seg-todo"`).test(dashH));
  ok('tooltip 里明确写了"未开始"这个词（不再是笼统的"在办"）',
    new RegExp(`title="${owner}：已完成 \\d+，进行中 \\d+，逾期 \\d+，未开始 \\d+"`).test(dashH));
  ok('人员负荷面板的图例也加了"未开始"这一项', dashH.includes('background:var(--c-todo)') && /<i style="background:var\(--c-todo\)"><\/i>未开始</.test(dashH));
  ok('"进行中"图例文案不再叫"在办"（含义已经拆分清楚，避免误解）', !/<i style="background:var\(--c-doing\)"><\/i>在办</.test(dashH));

  section('confirmConnectWithHint：先弹提示框讲清楚要选哪个文件夹，确认后才执行');
  S.DB.settings.me = '测试管理员';
  S.DB.shareConfig = { fileName: 'a.json' };
  let called2 = false;
  S.confirmConnectWithHint(() => { called2 = true; });
  ok('弹出了提示框', typeof S.modalCallback === 'function');
  ok('还没确认之前，回调没有被执行', called2 === false);
  ok('提示框内容里带了同步用的文件名', q('#modal-body').innerHTML.includes('a.json'));
  await S.modalCallback();
  ok('点了"继续连接"之后，回调才真正执行', called2 === true);

  section('回归：connect-shared 也经过这道"讲清楚该选哪个文件夹"的提示');
  S.DB.settings.me = '测试管理员';
  S.ACTIONS['connect-shared']();
  ok('管理员点"连接共享文件夹"，先弹出了提示框（不是直接弹系统选择框）', typeof S.modalCallback === 'function');

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
