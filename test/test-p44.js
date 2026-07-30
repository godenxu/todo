/* P44：本轮两项修订——
   1) 自动同步（5 分钟定时器）跟手动点"立即同步"必须是同一份代码、同一个效果：
      读—合并—写之后立刻重绘当前页面。以前定时器是自己另抄一遍"Repo.persist+renderShell+renderPage"，
      现在统一收进 syncNowAndRender()，定时器/pullOnWake/手动按钮都调它，杜绝以后两处代码走着走着长出差异。
      顺带加一把"同步互斥闸"（withSyncGate）：定时器、切回标签页、手动按钮这三条都会去碰共享文件的路径，
      同一时刻只准一条在跑，避免网络盘上并发读写这种没有行为保证的操作。
   2) 登录门禁"先连接共享数据"那一屏去掉了"我是负责搭建系统的管理员"这条近路——
      它会出现在【每一个】第一次打开这份 html 的人面前，不管是不是管理员，纯属噪音。
      去掉之后不影响真正的管理员搭建流程：连的文件夹如果确实是空的，
      loginGateStage() 会自动判成 'create'，直接给创建账号的表单。
   用法：node test/test-p44.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

function makeFileHandle(store) {
  return {
    name: 'shared.json',
    async getFile() { return { text: async () => store.text, lastModified: store.mtime || 1 }; },
    async createWritable() {
      return {
        async write(t) { store.text = t; store.mtime = (store.mtime || 1) + 1; store.writes++; },
        async close() {},
      };
    },
  };
}

async function main() {
  await tick(60);
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.setFileHandle(null); S.setEverConnected(false);
    S.setSyncBusy(false);
    S.rebuildIndex();
  };

  section('★①：定时器、pullOnWake、手动按钮三条路径必须共用同一个"同步并重绘"实现');
  restore();
  const store = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeFileHandle(store));
  S.setEverConnected(true);
  await S.Repo.persist(S.DB);   // 铺基线

  // 同事那台设备改了一条任务的标题，写回共享文件
  const remote = JSON.parse(store.text);
  const victim = remote.tasks.find(t => !t.deleted_at);
  remote.tasks.find(t => t.id === victim.id).title = '★P44同事改的标题★';
  const rt = remote.tasks.find(t => t.id === victim.id);
  rt.rev = (rt.rev || 0) + 1;
  rt.updated_at = new Date(Date.now() + 1000).toISOString();
  store.text = JSON.stringify(remote); store.mtime++;

  // 手动"立即同步"按钮
  await S.ACTIONS['sync-now']();
  ok('手动按钮：DB 里的标题更新了', S.byId('task', victim.id).title === '★P44同事改的标题★');

  // 复原场景，改用"定时器那条路径"（syncNowAndRender 本身），验证效果完全一致
  restore();
  S.setFileHandle(makeFileHandle(store));
  S.setEverConnected(true);
  store.text = ''; store.mtime = 1; store.writes = 0;
  await S.Repo.persist(S.DB);
  const remote2 = JSON.parse(store.text);
  const victim2 = remote2.tasks.find(t => !t.deleted_at);
  remote2.tasks.find(t => t.id === victim2.id).title = '★P44定时器场景改的标题★';
  const rt2 = remote2.tasks.find(t => t.id === victim2.id);
  rt2.rev = (rt2.rev || 0) + 1;
  rt2.updated_at = new Date(Date.now() + 1000).toISOString();
  store.text = JSON.stringify(remote2); store.mtime++;

  S.setPage('tasks'); S.renderPage();
  await S.syncNowAndRender();   // 这就是定时器回调实际会调用的那一个函数
  const html = q('#tasks-body').innerHTML;
  ok('★定时器路径同样立刻反映到当前页面（不是刷新整个浏览器页面，是重绘 DOM）',
    html.includes('★P44定时器场景改的标题★'), html.slice(0, 200));
  ok('DB 里的标题也确实更新了', S.byId('task', victim2.id).title === '★P44定时器场景改的标题★');

  section('★①：同步互斥闸——同一时刻只准一条路径在碰共享文件');
  restore();
  S.setFileHandle(makeFileHandle(store));
  ok('平时闸是开着的', S.syncBusy === false);
  let innerRan = false;
  const p1 = S.withSyncGate(async () => { innerRan = true; await tick(30); return 'first'; });
  ok('闸一旦被占用，标志位立刻置上（同步检查，不等 await 完）', S.syncBusy === true);
  const second = await S.withSyncGate(async () => { throw new Error('不该跑到这里'); });
  ok('★闸被占用时，第二个请求直接放弃（返回 false），不排队等待、也不会跟第一个并发执行',
    second === false);
  const first = await p1;
  ok('第一个请求正常执行完并拿到自己的返回值', innerRan === true && first === 'first');
  ok('执行完之后闸自动松开', S.syncBusy === false);
  const third = await S.withSyncGate(async () => 'ok');
  ok('闸松开后，新的请求可以正常进来', third === 'ok');

  section('★①：手动点"立即同步"时如果闸正被占用，要有明确提示，不能悄悄什么都不做');
  restore();
  S.setFileHandle(makeFileHandle(store));
  S.setSyncBusy(true);
  await S.ACTIONS['sync-now']();
  ok('提示"正在同步中"，而不是假装点了没反应', q('#snack-msg').textContent.includes('正在同步中'), q('#snack-msg').textContent);
  S.setSyncBusy(false);

  section('★②：登录门禁"先连接共享数据"那一屏不再有"我是管理员"的近路');
  restore();
  raw.window.showDirectoryPicker = () => {};
  S.DB.users = [];
  S.setFileHandle(null);
  S.renderLoginGate();
  const connectHtml = q('#login-body').innerHTML;
  ok('这一屏不再出现任何"管理员"字样', !connectHtml.includes('管理员'), connectHtml);
  ok('★login-toggle-admin 这个 action 已经彻底移除（不是隐藏，是真的没有了）',
    !S.ACTIONS['login-toggle-admin'], typeof S.ACTIONS['login-toggle-admin']);
  ok('主按钮还在，普通同事和管理员走的是同一条路', connectHtml.includes('data-act="login-connect-share"'));

  section('★②：去掉近路之后，管理员搭建系统的路径不受影响——连空文件夹会自动到创建账号那一屏');
  S.setFileHandle(makeFileHandle({ text: '', mtime: 1, writes: 0 }));
  ok('loginGateStage 判成 create（无需任何手动近路）', S.loginGateStage() === 'create');
  S.renderLoginGate();
  const createHtml = q('#login-body').innerHTML;
  ok('直接给出创建首个管理员账号的表单', createHtml.includes('id="login-new-name"'));
  ok('表单本身依然说明这是第一个（管理员）账号', createHtml.includes('管理员'));
  S.setFileHandle(null);

  delete raw.window.showDirectoryPicker;
  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
