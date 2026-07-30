/* P43：陈旧 html 防线——"浏览器缓存/没关的标签页/旧拷贝"导致有人一直在跑旧代码

   起因：里程碑被存成好几套重复的那次事故修好之后，仍然存在一个大风险——
   修复只对"换了新 html 的人"生效。而这套分发方式（每人自己存一份 html）里，
   "手上那份是旧的"太容易发生了，而且原因不止一种：
     · 浏览器把 file:// 页面缓存住了，双击打开还是老的；
     · 标签页开了好几天没关过，跑的是当初加载的那份代码；
     · 操作系统/网络盘对共享目录的文件缓存；
     · 本机那份拷贝压根没更新。
   这些都不是网页代码能从源头堵住的（没有服务器就没有 Cache-Control 可发）。

   已有的 checkDataVersion 挡不住这一类：它只在「共享数据格式」不兼容变化时才拦，
   而里程碑那个 bug 数据格式一个字段都没改 —— 所以那道门禁当时完全没反应。

   本轮的思路：不去堵"为什么旧"，而是让程序自己认出"我旧了"，并且立刻停止写入。
     ① 本机记住"见过的最高 html 版本"（settings.maxSeenAppVersion，只存本地、只升不降），
        低于它就判定自己是旧版 → 只读不写 + 弹门禁教怎么办；
        记在本机且只升不降，是为了让旧版客户端没有任何办法把这个判断抹掉。
     ② 权限页账号表新增"程序版本"列，管理员能直接看出谁还在用旧版。
     ③ 门禁里提供"强制刷新"（换 URL 绕开缓存）和一个需要二次确认的"我有意用旧版"出口。
   用法：node test/test-p43.js */
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
// 比当前版本更新 / 更旧的版本号（版本号是 v+年月日时分秒，直接比字符串就是比时间）
const NEWER = 'v29991231235959';
const OLDER = 'v20200101000000';

async function main() {
  await tick(60);
  const reset = () => {
    S.DB.settings.maxSeenAppVersion = '';
    S.setStaleAppBlocked(false);
    S.setFileHandle(null);
    q('#login-gate').classList.remove('show');
  };

  section('★①：本机"见过的最高版本"水位——只升不降');
  reset();
  S.noteRemoteAppVersion({ lastWriteApp: S.APP_VERSION });
  ok('见到跟自己一样的版本，不算旧', S.isStaleApp() === false);
  S.noteRemoteAppVersion({ lastWriteApp: NEWER });
  ok('见到更新的版本，水位抬上去了', S.DB.settings.maxSeenAppVersion === NEWER);
  ok('于是判定自己是旧版', S.isStaleApp() === true);
  // 这一条是整个设计的关键：旧版客户端写文件时会把 lastWriteApp 写回成它自己那个旧版本号，
  // 如果水位跟着降下来，它就能把自己解锁 —— 必须降不下来
  S.noteRemoteAppVersion({ lastWriteApp: OLDER });
  ok('★之后再见到旧版本号，水位不会被压下来（否则旧版客户端能把自己解锁）',
    S.DB.settings.maxSeenAppVersion === NEWER, S.DB.settings.maxSeenAppVersion);
  ok('仍然判定为旧版', S.isStaleApp() === true);
  S.noteRemoteAppVersion({ lastWriteApp: '' });
  ok('远端没有版本号信息时不乱动水位', S.DB.settings.maxSeenAppVersion === NEWER);

  section('★①：判定为旧版时弹门禁，并把话说清楚');
  reset();
  S.DB.settings.maxSeenAppVersion = NEWER;
  const passed = S.checkAppVersion({ lastWriteApp: NEWER });
  ok('checkAppVersion 返回 false（调用方据此取消本次写入）', passed === false);
  ok('进入了旧版封锁状态', S.staleAppBlocked === true);
  ok('门禁显示出来了', q('#login-gate').classList.contains('show'));
  const gate = q('#login-body').innerHTML;
  ok('标题直说"打开的是旧版本，已暂停写入"', gate.includes('旧版本') && gate.includes('暂停写入'), gate.slice(0, 120));
  ok('两个版本号都列出来了，便于对照', gate.includes(S.APP_VERSION) && gate.includes(NEWER));
  ok('明确告诉用户还能看数据，只是不写', gate.includes('仍然可以查看'));
  ok('教了 Ctrl+F5 强制刷新', gate.includes('Ctrl'));
  ok('★特别点出"标签页开着不动也会跑旧代码"——这一条最容易被忽略', gate.includes('标签页'));
  ok('也说了实在不行就重新复制一份 html', gate.includes('复制一份'));
  ok('有强制刷新按钮', gate.includes('data-act="force-reload"'));
  ok('有"我有意用旧版"的出口', gate.includes('data-act="ignore-stale-app"'));

  section('★①：被判定为旧版之后，写入必须真的被拦住');
  const store = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeFileHandle(store));
  S.setStaleAppBlocked(true);
  const writesBefore = store.writes;
  await S.syncToFile(S.DB);
  ok('★syncToFile 一个字节都没写', store.writes === writesBefore, { before: writesBefore, after: store.writes });

  section('★①：但"只读拉取"不受影响——不能因为版本旧就连数据都不让看');
  reset();
  S.setStaleAppBlocked(false);
  S.setFileHandle(makeFileHandle(store));
  await S.Repo.persist(S.DB);            // 先铺一份基线进"文件"
  const remote = JSON.parse(store.text);
  remote.lastWriteApp = NEWER;           // 冒充：有人用更新的 html 写过这个文件
  remote.tasks[0].title = '★同事改的标题★';
  remote.tasks[0].rev = (remote.tasks[0].rev || 0) + 1;
  remote.tasks[0].updated_at = new Date(Date.now() + 1000).toISOString();
  store.text = JSON.stringify(remote); store.mtime++;
  const w2 = store.writes;
  const pulled = await S.pullFromFile();
  ok('拉取照常成功', pulled === true);
  ok('同事的改动读进来了（旧版本也应该能看到最新数据）',
    S.byId('task', remote.tasks[0].id).title === '★同事改的标题★');
  ok('拉取过程中没有写文件', store.writes === w2);
  ok('★但顺手把自己标成了旧版，后续写入会被拦', S.staleAppBlocked === true);

  section('★①：连接共享文件夹时就先查版本，不等用户改完东西才说不行');
  reset();
  ok('checkAppVersion 在版本正常时放行', S.checkAppVersion({ lastWriteApp: S.APP_VERSION }) === true);
  ok('放行时不会误弹门禁', S.staleAppBlocked === false);

  section('★③：出口——"我有意用旧版"要二次确认，不能一点就解锁');
  reset();
  S.DB.settings.maxSeenAppVersion = NEWER;
  S.checkAppVersion({ lastWriteApp: NEWER });
  ok('先处在封锁状态', S.staleAppBlocked === true);
  S.ACTIONS['ignore-stale-app']();
  ok('★点第一下不解锁，只是换成一个更严厉的确认按钮', S.staleAppBlocked === true);
  const confirmHtml = q('#stale-app-actions').innerHTML;
  ok('确认界面把后果说明白了', confirmHtml.includes('把大家的数据改坏'), confirmHtml);
  ok('还留了一条"算了，去刷新"的退路', confirmHtml.includes('data-act="force-reload"'));
  S.ACTIONS['ignore-stale-app-confirm']();
  ok('确认之后才真的解锁', S.staleAppBlocked === false);
  ok('水位被压回当前版本，不会一进来又被拦', S.DB.settings.maxSeenAppVersion === S.APP_VERSION);
  ok('门禁关掉了', !q('#login-gate').classList.contains('show'));

  section('★②：权限页账号表——一眼看出谁还在用旧版');
  ok('从没同步过的人显示占位符', S.appVersionCellHTML({ name: 'x' }).includes('—'));
  const sameHtml = S.appVersionCellHTML({ name: 'x', lastAppVersion: S.APP_VERSION });
  ok('版本一致时低调显示，不报警', sameHtml.includes(S.APP_VERSION) && !sameHtml.includes('旧版'));
  const oldHtml = S.appVersionCellHTML({ name: 'x', lastAppVersion: OLDER });
  ok('★别人用旧版时标红并写明"旧版"', oldHtml.includes('旧版') && oldHtml.includes('var(--overdue)'), oldHtml);
  ok('鼠标悬停给出可操作的说明', oldHtml.includes('强制刷新') || oldHtml.includes('重新复制'));
  const newHtml = S.appVersionCellHTML({ name: 'x', lastAppVersion: NEWER });
  ok('别人比自己新时，提示该更新的是自己', newHtml.includes('比你新'), newHtml);

  section('★②：心跳里要带上版本号，而且能跨设备合并过来');
  S.DB.users.push({ name: 'P43同事', role: 'staff', salt: 's', hash: 'h', iterations: 1 });
  S.markUserSeen('P43同事');
  const u = S.DB.users.find(x => x.name === 'P43同事');
  ok('markUserSeen 记下了当前版本号', u.lastAppVersion === S.APP_VERSION, u.lastAppVersion);
  ok('时间也记了', !!u.lastSeenAt);
  // 版本号跟心跳时间是一起写的，合并时必须一起走，不能出现"时间是新的、版本却是旧的"
  const merged = S.mergeUserPresence(
    [{ name: 'A', lastSeenAt: '2026-07-01T00:00:00.000Z', lastAppVersion: OLDER }],
    [{ name: 'A', lastSeenAt: '2026-07-01T00:00:00.000Z', lastAppVersion: OLDER }],
    [{ name: 'A', lastSeenAt: '2026-07-29T00:00:00.000Z', lastAppVersion: NEWER }]
  );
  ok('★采纳更晚那次心跳时，版本号跟着一起换过来',
    merged[0].lastSeenAt === '2026-07-29T00:00:00.000Z' && merged[0].lastAppVersion === NEWER, merged[0]);
  S.DB.users = S.DB.users.filter(x => x.name !== 'P43同事');

  section('★④：页面头部带上禁止缓存的 meta（对通过 HTTP 打开的情况有效）');
  const html = require('fs').readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  ok('有 Cache-Control: no-store', /http-equiv=["']Cache-Control["'][^>]*no-store/i.test(head));
  ok('有 Pragma: no-cache', /http-equiv=["']Pragma["']/i.test(head));
  ok('★注释里老实说明了它对 file:// 基本无效，别让后来人以为这就够了',
    head.includes('file://') && head.includes('版本自检'));

  section('★⑤：登录门禁按"本机手上有没有账号数据"分屏，不再把三种情况堆在一屏');
  reset();
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  raw.window.showDirectoryPicker = () => {};

  // 情况一：本机已经有账号（最常见，包括刷新后授权失效——账号还在本机缓存里）
  S.DB.settings.me = '';
  ok('有账号时走"认身份"这一屏', S.loginGateStage() === 'pick', S.loginGateStage());
  S.renderLoginGate();
  let h = q('#login-body').innerHTML;
  ok('显示姓名输入框', h.includes('id="login-pick"'));
  ok('★不再混进"我是负责搭建系统的管理员"这个跟普通同事无关的入口', !h.includes('管理员'), h);
  ok('没连上时给一条低调的补救提示（名单可能是旧的）', h.includes('data-act="login-connect-share"'));

  // 情况二：新同事第一次打开——本机没有账号，也没连过共享文件夹
  S.DB.users = [];
  S.setFileHandle(null);
  ok('没账号又没连过时，走"先接数据"这一屏', S.loginGateStage() === 'connect', S.loginGateStage());
  S.renderLoginGate();
  h = q('#login-body').innerHTML;
  ok('标题就是"先连接共享数据"', h.includes('先连接共享数据'), h.slice(0, 100));
  ok('★这一屏不再要求先输姓名——本机根本没有账号可对，输了只会得到"找不到这个账号"',
    !h.includes('id="login-pick"'), h);
  ok('只给一个主按钮：选择共享数据文件夹', h.includes('data-act="login-connect-share"') && h.includes('选择共享数据文件夹'));
  ok('说清楚了数据文件就和网页放在一起', h.includes('放在一起'));
  ok('说清楚了每台电脑只需要做这一次', h.includes('只需要做这一次'));
  ok('★老实交代了"浏览器不允许网页自己去读旁边的文件"，而不是假装能自动读',
    h.includes('不允许网页自己去读'), h);
  // P45 之后去掉了"我是管理员"这条手动近路：不管开门的是谁，这一屏都不该出现
  // 任何管理员相关字样——管理员照样点这一个按钮，连的文件夹是空的就会自动落到「情况三」那一屏
  ok('★不再露出任何"我是管理员"的字样', !h.includes('管理员'), h);

  // 情况三：已经连上，但共享文件里确实一个账号都没有 = 真·首次搭建
  S.setFileHandle(makeFileHandle({ text: '', mtime: 1, writes: 0 }));
  ok('连上了却没有任何账号时，才是真·首次搭建', S.loginGateStage() === 'create', S.loginGateStage());
  S.renderLoginGate();
  ok('直接给创建首个管理员账号的表单', q('#login-body').innerHTML.includes('id="login-new-name"'));

  section('★⑤：把"该选哪个文件夹"直接显示出来，省得用户自己找');
  S.setFileHandle(null);
  S.DB.users = [];
  const bakHref = raw.location.href, bakPath = raw.location.pathname;
  raw.location.href = 'file:///Z:/%E7%A7%91%E6%8A%80%E8%A7%84%E5%88%92%E5%A4%84/%E5%B7%A5%E4%BD%9C%E7%AE%A1%E7%90%86.html';
  raw.location.pathname = '/Z:/%E7%A7%91%E6%8A%80%E8%A7%84%E5%88%92%E5%A4%84/%E5%B7%A5%E4%BD%9C%E7%AE%A1%E7%90%86.html';
  ok('Windows 路径解出所在文件夹并换成反斜杠', S.ownFolderPath() === 'Z:\\科技规划处', S.ownFolderPath());
  S.renderLoginGate();
  ok('★这个路径直接显示在"要选的文件夹"那一行', q('#login-body').innerHTML.includes('Z:\\科技规划处'),
    q('#login-body').innerHTML.slice(0, 400));
  raw.location.href = 'file:///mnt/share/todo/index.html';
  raw.location.pathname = '/mnt/share/todo/index.html';
  ok('Linux（统信OS）挂载路径保持正斜杠原样', S.ownFolderPath() === '/mnt/share/todo', S.ownFolderPath());
  raw.location.href = 'http://example.com/a/b.html';
  raw.location.pathname = '/a/b.html';
  ok('不是 file:// 时不显示路径（http 打开时这个提示没意义）', S.ownFolderPath() === '');
  raw.location.href = bakHref; raw.location.pathname = bakPath;

  delete raw.window.showDirectoryPicker;
  S.DB.users = bakUsers; S.DB.settings.me = bakMe;
  S.rebuildIndex();

  reset();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
