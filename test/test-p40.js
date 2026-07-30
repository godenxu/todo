/* P40：本轮五项改动测试——
   1) 任务详情里，逾期的里程碑要显著标识（不能只靠一处文字变红），带上逾期天数；
      只读视图和可编辑视图（cpRowHTML）都要有；任务自己没到期、纯粹因为里程碑拖期才被判定
      逾期时，也要在"计划完成"那一行说清楚原因
   2) 数据页备份文件夹选中后要显示出来（文件夹自己的名字——完整路径浏览器给不了，说清楚这一点）
   3)（问答题，没有代码改动：刷新页面后确实会提示"点击恢复共享连接"，这是浏览器读写授权
      不跨页面存活的正常行为，不是 bug）
   4) 首次登录不再弹"这台设备还没有任何数据"，直接进"请确认你的身份"；创建首个账号的入口
      收在一行小字链接里，只有真的一个账号都没有时才出现
   5) 同事的改动没有实时同步——加一个"共享文件里最后是谁/什么时候/哪个版本写的"的展示，
      方便直接对比排查是不是对方那台设备没连上/没授权/用的是旧版 html
   用法：node test/test-p40.js */
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
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const bakMs = JSON.parse(JSON.stringify(S.DB.milestones));
  const bakMatrix = S.DB.permissionMatrix ? JSON.parse(JSON.stringify(S.DB.permissionMatrix)) : S.DB.permissionMatrix;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.DB.milestones = JSON.parse(JSON.stringify(bakMs));
    S.DB.permissionMatrix = bakMatrix;
    S.rebuildIndex();
    if (S.loginPending) S.hideLoginGate();
  };

  section('★①：任务详情——逾期里程碑要显著标识（只读视图）');
  const dutyCode = 'P40D'; await S.Repo.upsert('duty', { code: dutyCode, name: 'P40测试职责' });
  const wid = 'p40_w'; await S.Repo.upsert('work', { id: wid, duty: dutyCode, name: 'P40测试工作', owner: '测试管理员' });
  const taskA = 'p40_ta';
  await S.Repo.upsert('task', { id: taskA, work: wid, title: 'P40任务甲', status: 'doing', plan_date: S.offsetDate(30), owner: '别的人', assignees: [] });
  await S.Repo.upsert('milestone', { id: 'p40_ms_a', task: taskA, plan_date: S.offsetDate(-3), deliverable: 'P40拖期交付物', report_level: 'section', done: '0' });
  // 只读视图只有"能看但不能改"的人才会走到——管理员/组长以上默认能改任何任务，测不出只读分支，
  // 这里专门造一个"没有 edit_others_task、但有 view_others_detail"的员工，且不是这条任务的负责人/参与人
  S.DB.users.push({ name: 'P40旁观员工', role: 'staff', salt: 's', hash: 'h', iterations: 1 });
  S.DB.permissionMatrix = { staff: { edit_others_task: false, view_others_detail: true } };
  S.DB.settings.me = 'P40旁观员工';
  S.openTaskDetail(taskA);
  const roHtml = q('#modal-body').innerHTML;
  ok('只读视图里逾期行有专门的高亮 class', roHtml.includes('ms-item-overdue'));
  ok('写清楚了逾期了几天，不是只说"已逾期"三个字', roHtml.includes('已逾期 3 天'), roHtml);
  S.ACTIONS['modal-cancel']();
  S.DB.permissionMatrix = bakMatrix;
  S.DB.settings.me = '测试管理员';

  section('★①：cpRowHTML——可编辑视图里同样要有逾期标识（这是原来完全没有的地方）');
  const overdueMs = S.byId('milestone', 'p40_ms_a');
  const cpHtml = S.cpRowHTML(overdueMs);
  ok('可编辑的检查点行也有逾期高亮 class', cpHtml.includes('cp-row-overdue'));
  ok('带了醒目的"逾期 N 天"徽标', cpHtml.includes('cp-overdue-badge') && cpHtml.includes('逾期 3 天'), cpHtml);
  const normalMs = { task: taskA, plan_date: S.offsetDate(10), deliverable: '正常', done: '0' };
  ok('没逾期的检查点行没有这些标识', !S.cpRowHTML(normalMs).includes('cp-row-overdue'));
  ok('全新空白行（m 为 null）不会报错、也没有逾期标识', !S.cpRowHTML(null).includes('cp-row-overdue'));

  section('★①：任务自己没到期、纯粹因为里程碑拖期才判定逾期时，要在"计划完成"那一行说明原因');
  S.openTaskDetail(taskA);
  const detailHtml = q('#modal-body').innerHTML;
  ok('isOverdue 为真（全靠里程碑判定，任务自己 30 天后才到期）', S.isOverdue(S.byId('task', taskA)));
  ok('详情里出现了"因为下面有里程碑已经逾期"这样的解释', detailHtml.includes('下面有里程碑已经逾期'), detailHtml);
  S.ACTIONS['modal-cancel']();

  const taskB = 'p40_tb';
  await S.Repo.upsert('task', { id: taskB, work: wid, title: 'P40任务乙（本身也逾期）', status: 'doing', plan_date: S.offsetDate(-10), owner: '测试管理员', assignees: [] });
  S.openTaskDetail(taskB);
  const detailHtmlB = q('#modal-body').innerHTML;
  ok('任务自己的日期就已经过了时，不需要额外解释"因为里程碑"这句话（避免信息冗余）',
    !detailHtmlB.includes('下面有里程碑已经逾期'));
  S.ACTIONS['modal-cancel']();

  section('★②：数据页——备份文件夹选中后要显示出来（文件夹自己的名字）');
  restore();
  S.DB.settings.me = '测试管理员';
  S.DB.settings.autoBackupDirName = '我的备份文件夹';
  S.setPage('data'); S.renderData();
  const dataHtml = q('#page-data').innerHTML;
  ok('数据页显示了选中的备份文件夹名字', dataHtml.includes('我的备份文件夹'));
  ok('说明了浏览器给不了完整路径这件事（不能让人误以为这就是全路径）', dataHtml.includes('隐私限制不允许网页读取系统里的完整路径'));
  S.DB.settings.autoBackupDirName = '';

  // 这一段原本断言的是"本机没账号时也直接进请确认你的身份"。P43 之后改了：
  // 本机没有账号数据时先进"先连接共享数据"（详见 test-p43.js）——输姓名对不上任何账号，
  // 先把数据接进来才是唯一该做的事。这里保留的是"那个'没有任何数据'的中间页确实没了"这个断言。
  section('★④：首次登录不再有"这台设备还没有任何数据"那个中间页');
  const allUsersBak = JSON.parse(JSON.stringify(S.DB.users));
  S.DB.users = [];
  S.DB.settings.me = '';
  S.setFileHandle(null);
  raw.window.showDirectoryPicker = () => {};
  S.renderLoginGate();
  const bootHtml = q('#login-body').innerHTML;
  ok('没有"这台设备还没有任何数据"这句话了', !bootHtml.includes('这台设备还没有任何数据'));
  ok('第一屏是"先连接共享数据"，一个主按钮说清楚该干什么',
    bootHtml.includes('先连接共享数据') && bootHtml.includes('data-act="login-connect-share"'), bootHtml.slice(0, 120));
  // P45 之后去掉了"我是管理员"这条近路（详见 test-p45.js）：不管开门的是不是管理员，
  // 这一屏都不该出现任何跟管理员相关的字样——管理员照样点这一个按钮，连的文件夹是空的
  // 就会自动落到创建账号那一屏
  ok('不再有任何"我是管理员"的字样', !bootHtml.includes('管理员'), bootHtml);
  S.setFileHandle({ name: 'x', async getFile() { return { text: async () => '', lastModified: 1 }; } });
  S.renderLoginGate();
  const createHtml = q('#login-body').innerHTML;
  ok('连上一个空的共享文件夹后，自动落到创建账号的表单', createHtml.includes('id="login-new-name"') && createHtml.includes('id="login-new-pin"'));
  ok('创建表单带"返回"按钮', createHtml.includes('data-act="login-back"'));
  S.ACTIONS['login-back']();
  ok('返回后又回到创建账号的表单（本机仍连着一个空共享文件夹，stage 还是 create）',
    q('#login-body').innerHTML.includes('id="login-new-name"'));
  S.setFileHandle(null);
  delete raw.window.showDirectoryPicker;
  S.DB.users = allUsersBak;

  section('★④回归：本机已经有账号时，直接进"请确认你的身份"，也不露"我是管理员"那行小字');
  S.renderLoginGate();
  const pickHtml = q('#login-body').innerHTML;
  ok('走的是认身份这一屏', pickHtml.includes('id="login-pick"'), pickHtml.slice(0, 120));
  ok('不是 bootstrap 状态就没有管理员相关字样', !pickHtml.includes('管理员'));

  section('★⑤：共享文件"最后写入"信息——排查同步问题用');
  restore();
  S.DB.settings.me = '测试管理员';
  ok('还没读到任何远端信息时，面板里不显示这一块（没有就不硬讲）', (() => {
    S.setFileHandle(null);
    S.renderData();
    return !q('#page-data').innerHTML.includes('共享文件里目前那份数据');
  })());
  S.cacheRemoteWriteInfo({ lastWriteBy: 'P40同事', lastWriteAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), lastWriteApp: 'v20260101000000' });
  S.renderData();
  const syncHtml = q('#page-data').innerHTML;
  ok('显示了最后写入的人', syncHtml.includes('P40同事'));
  ok('显示了版本不一致的警告（跟当前 APP_VERSION 不一样）', syncHtml.includes('跟你这份') && syncHtml.includes('v20260101000000'));
  S.cacheRemoteWriteInfo({ lastWriteBy: '测试管理员', lastWriteAt: new Date().toISOString(), lastWriteApp: S.APP_VERSION });
  S.renderData();
  ok('版本一致时不显示警告', !q('#page-data').innerHTML.includes('跟你这份'));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
