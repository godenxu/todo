/* P20：本轮改动测试——
   1) 工作台"人员负荷"统计里区分"未开始"：以前 todo/doing 混在一个"在办"桶里，现在拆成两段，
      todo 用新的 --c-todo 颜色单独渲染，legend/tooltip 同步更新
   2) 共享文件夹手动连接时，先把"该连去哪个文件夹"讲清楚：sharePathHintText() 算出当前登录者自己的路径，
      confirmConnectWithHint() 在真弹系统选择框之前先弹一个小提示框（没配置模板/没填工号时不弹，直接连）；
      登录后自动触发的那次不额外加确认框，只用一条 snack 把路径带一句
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

  section('sharePathHintText：当前登录者自己该连去哪个文件夹');
  S.DB.shareConfig = null;
  ok('管理员还没配置模板时返回空字符串', S.sharePathHintText() === '');
  S.DB.shareConfig = { pathTemplate: 'X{工号}Y{工号}Z', fileName: 'a.json' };
  S.DB.settings.me = '测试管理员';
  const admin = S.DB.users.find(u => u.name === '测试管理员');
  const bakJobNo = admin.jobNo;
  admin.jobNo = '';
  ok('模板配好了但当前用户没填工号，还是返回空字符串', S.sharePathHintText() === '');
  admin.jobNo = '20260088';
  ok('模板和工号都齐了，能算出这个人自己的路径', S.sharePathHintText() === 'X20260088Y20260088Z');
  admin.jobNo = bakJobNo;

  section('confirmConnectWithHint：没有可显示的路径时直接执行，不弹提示框');
  S.DB.shareConfig = null;
  let called = false;
  S.confirmConnectWithHint(() => { called = true; });
  ok('没配置模板时不弹框，直接调用了传进去的回调', called === true);
  ok('没弹出确认框（modalCallback 还是空的）', !S.modalCallback);

  section('confirmConnectWithHint：有路径可显示时，先弹提示框讲清楚路径，确认后才执行');
  S.DB.shareConfig = { pathTemplate: 'X{工号}Y{工号}Z', fileName: 'a.json' };
  admin.jobNo = '20260099';
  let called2 = false;
  S.confirmConnectWithHint(() => { called2 = true; });
  ok('弹出了提示框', typeof S.modalCallback === 'function');
  ok('还没确认之前，回调没有被执行', called2 === false);
  ok('提示框内容里包含算出来的具体路径', q('#modal-body').innerHTML.includes('X20260099Y20260099Z'));
  await S.modalCallback();
  ok('点了"继续连接"之后，回调才真正执行', called2 === true);
  admin.jobNo = bakJobNo;

  section('回归：connect-shared / connect-my-shared-folder 现在都经过这道"讲清楚路径"的提示');
  S.DB.shareConfig = { pathTemplate: 'X{工号}Y{工号}Z', fileName: 'a.json' };
  admin.jobNo = '20260077';
  S.DB.settings.me = '测试管理员';
  S.ACTIONS['connect-shared']();
  ok('管理员点"连接共享文件夹"，先弹出了路径提示框（不是直接弹系统选择框）', typeof S.modalCallback === 'function');
  ok('提示框里的路径是管理员自己的', q('#modal-body').innerHTML.includes('X20260077Y20260077Z'));
  admin.jobNo = bakJobNo;

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
