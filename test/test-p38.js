/* P38：本轮修复测试——"改动只存在本机、悄悄没同步给别人"这个大坑
   起因：同事设完 PIN、改了一天数据，自己看着都正常，管理员那边什么都看不到。
   根因：浏览器的文件读写授权不跨页面存活，每次刷新/重开页面 _fileHandle 都是 null，
        而 Repo.persist 以前是 `if (_fileHandle) syncToFile()`，没句柄就静默 return true——
        从打开页面到点中"恢复共享连接"之间的每一次保存，都只落在 localStorage，一个字都不提示。
   修复：没能真写进共享文件的保存，一律记 settings.pendingSync（只存本机），顶栏红着闪，
        恢复连接时整批补推；同时修掉"自动恢复授权会把正在填的登录表单清空"的副作用。
   用法：node test/test-p38.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// 一个可以写、也能读回内容的假共享文件句柄
function makeFileHandle(store) {
  return {
    name: 'shared.json',
    async getFile() { return { text: async () => store.text, lastModified: store.mtime || 1 }; },
    async createWritable() {
      return { async write(t) { store.text = t; store.mtime = (store.mtime || 1) + 1; }, async close() {} };
    },
  };
}

async function main() {
  await tick(60);
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.settings.pendingSync = false;
    S.setFileHandle(null); S.setEverConnected(false); S.setNeedPermissionRestore(false); S.setOfflineMode(false);
    if (S.loginPending) S.hideLoginGate();
  };

  section('★ 核心：连过共享文件夹、但这会儿没连上时保存 —— 必须留下"未同步"标记，不能静默');
  restore();
  S.setEverConnected(true);       // 这台设备连过
  S.setFileHandle(null);          // 但刷新页面后授权失效了，句柄是空的（真实世界最常见的状态）
  S.DB.settings.pendingSync = false;
  q('#snack-msg').textContent = '';
  await S.Repo.persist(S.DB);
  ok('保存被记为"有改动未同步"', S.DB.settings.pendingSync === true);
  ok('而且当场就告诉用户了，不是闷声不响', q('#snack-msg').textContent.includes('还没同步给大家'), q('#snack-msg').textContent);

  section('★ 顶栏：未同步时给一个最高优先级、会闪的红色提示');
  raw.window.showDirectoryPicker = () => {};
  S.renderShell();
  const hint = q('#share-connect-hint').innerHTML;
  ok('顶栏提示的是"有改动未同步"，不是那句容易被忽略的"点击恢复共享连接"',
    hint.includes('有改动未同步') && !hint.includes('点击恢复共享连接'), hint);
  ok('用了 urgent 样式（加粗+闪烁），不是普通小提示', hint.includes('share-connect-btn urgent'));
  ok('点它走的是恢复连接那条路', hint.includes('data-act="restore-share-permission"'));

  section('★ 真连上之后保存：标记必须被清掉，不能一直红着');
  const store = { text: '', mtime: 1 };
  S.setFileHandle(makeFileHandle(store));
  await S.Repo.persist(S.DB);
  ok('"未同步"标记清掉了', !S.DB.settings.pendingSync);
  ok('内容真的写进共享文件了', store.text.includes('"duties"'), store.text.slice(0, 60));
  S.renderShell();
  ok('顶栏那条红色提示也消失了', !q('#share-connect-hint').innerHTML.includes('有改动未同步'));

  section('★ 回归：从没连过共享文件夹（纯本机用）时保存，不该乱报警');
  restore();
  S.setEverConnected(false);
  S.setFileHandle(null);
  q('#snack-msg').textContent = '';
  await S.Repo.persist(S.DB);
  ok('不标记未同步（本来就没打算同步）', !S.DB.settings.pendingSync);
  ok('也不弹那条提示', !q('#snack-msg').textContent.includes('还没同步给大家'));

  section('★ 主动断开连接：是用户自己的决定，不算"该同步没同步"');
  restore();
  S.setEverConnected(true);
  S.DB.settings.pendingSync = true;
  raw.indexedDB = undefined;
  await S.disconnectSharedFile();
  ok('断开后不再红着提示', !S.DB.settings.pendingSync);
  ok('everConnected 也复位了，之后本机保存不会误报', S.everConnected === false);

  section('★ 同步状态在"当前身份"卡片里看得到（方便同事自查）');
  restore();
  S.DB.users = [{ name: '查同步的人', role: 'staff', salt: 's', hash: 'h', iterations: 1 }];
  S.DB.settings.me = '查同步的人';
  S.setEverConnected(true);
  S.DB.settings.pendingSync = true;
  S.setFileHandle(null);
  S.ACTIONS['switch-identity']();
  const card = q('#modal-body').innerHTML;
  ok('卡片里明确写了"有改动还没同步给大家"', card.includes('有改动还没同步给大家'));
  ok('还带了"上次同步"时间这一行，便于判断卡在什么时候', card.includes('上次同步'));
  S.ACTIONS['modal-cancel']();

  section('★ 修副作用：自动恢复授权时，不能把用户正在填的登录表单清掉');
  // 这个恢复动作多半是被"用户第一次点页面"触发的，而那一下点击往往就发生在登录门禁里。
  // 以前它会无条件 renderPage()/ensureIdentity()，把刚输了一半的姓名/PIN 整个抹掉退回第一步
  restore();
  S.DB.users = [{ name: '正在登录的人', role: 'staff' }];
  S.DB.settings.me = '';
  S.showLoginGate();                       // 门禁开着，用户正在填表
  S.renderLoginSetPin('正在登录的人');
  q('#login-new-pin').value = '半截PIN';
  raw.indexedDB = undefined;               // 让 idbGetHandle 失败，走不到重连，但足够验证"没有重画门禁"
  const before = q('#login-body').innerHTML;
  await S.doRestoreSharePermission();
  ok('门禁内容没有被重画回"请确认你的身份"', q('#login-body').innerHTML === before
    || q('#login-body').innerHTML.includes('设置你的 PIN'), q('#login-body').innerHTML.slice(0, 60));
  S.hideLoginGate();

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
