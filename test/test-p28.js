/* P28：本轮改动测试——
   1) 工作台任务/里程碑维度分组框改成跟报告页"本期总览"一样的白底面板，卡片更窄
   2) 修复"连上了但刷新页面后显示离线"：那其实是读写授权失效，点一下就能恢复，不该当成离线
   （原来这一批还包含"按工号自动识别身份"的内容，那套方案已经废弃——身份认证改回姓名+PIN，
    见后续批次，相关断言已经移除/替换）
   用法：node test/test-p28.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// 假的文件夹句柄
function makeDir(name) {
  return {
    name,
    kind: 'directory',
    _perm: 'granted',
    async requestPermission() { return 'granted'; },
    async queryPermission() { return this._perm || 'granted'; },
    async getFileHandle(fileName) {
      return {
        name: fileName,
        async getFile() { return { text: async () => '', lastModified: 1 }; },
        async createWritable() { return { async write() {}, async close() {} }; },
      };
    },
  };
}

async function main() {
  await tick(60);
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const bakShareConfig = S.DB.shareConfig;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.shareConfig = bakShareConfig;
    S.setFileHandle(null); S.setOfflineMode(false); S.setNeedPermissionRestore(false);
    delete raw.window.showDirectoryPicker; delete raw.indexedDB;
    if (S.loginPending) S.hideLoginGate();
  };

  section('工作台统计分组框：外观跟报告页"本期总览"一致（白底面板，不再刷彩色底）');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const css = src.slice(src.indexOf('.stat-groups'), src.indexOf('.panel {'));
  ok('分组框用了跟面板一样的 surface 底色', /\.stat-group \{[^}]*background: var\(--surface\)/.test(css), css.slice(0, 300));
  ok('不再有任务维度的蓝色专属底色', !css.includes('.stat-group-task {'));
  ok('不再有里程碑维度的紫色专属底色', !css.includes('.stat-group-ms {'));
  const minmax = (css.match(/minmax\((\d+)px/) || [])[1];
  ok('卡片最小宽度收窄到 100px 以内', Number(minmax) < 100, minmax);

  section('共享文件夹默认值：处里实际的文件名');
  ok('默认文件名是"科技规划处工作管理.json"', S.DEFAULT_SHARE_FILE_NAME === '科技规划处工作管理.json', S.DEFAULT_SHARE_FILE_NAME);
  S.DB.shareConfig = null;
  ok('管理员没配置时，effectiveShareCfg 退回内置默认值', S.effectiveShareCfg().fileName === S.DEFAULT_SHARE_FILE_NAME);
  S.DB.shareConfig = { fileName: '别的名字.json' };
  ok('管理员配置过就用管理员的', S.effectiveShareCfg().fileName === '别的名字.json');
  S.DB.shareConfig = null;

  section('★ 刷新页面后授权失效：算"待恢复"，不算离线');
  // 真实浏览器里，文件系统访问的读写授权默认不跨页面存活，重开页面时 queryPermission 通常返回 'prompt'。
  // 以前这会被一路当成"连不上→离线模式"，这正是"明明连着、刷新一下就显示离线"的原因。
  const savedHandle = makeDir('科技规划处共享文件夹');
  savedHandle._perm = 'prompt';   // 模拟刷新页面之后的状态
  raw.indexedDB = { open() {
    const req = {};
    const db = { createObjectStore() {}, transaction: () => ({
      objectStore: () => ({ get() { const r = {}; setTimeout(() => { r.result = savedHandle; r.onsuccess && r.onsuccess(); }, 0); return r; }, put() {}, delete() {} }),
      set oncomplete(fn) { setTimeout(() => fn && fn(), 0); },
    }) };
    setTimeout(() => { req.result = db; req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess && req.onsuccess(); }, 0);
    return req;
  } };
  S.setFileHandle(null); S.setOfflineMode(false); S.setNeedPermissionRestore(false);
  const okReconnect = await S.tryReconnectSharedFile();
  ok('接不回来（授权确实失效了）', okReconnect === false);
  ok('但标记成了"等着重新授权"，而不是离线', S.needPermissionRestore === true);
  ok('没有误设成离线模式', S.offlineMode === false);
  raw.window.showDirectoryPicker = () => {};
  S.renderShell();
  const hint = q('#share-connect-hint').innerHTML;
  // 文案在 P41 里改过：这条提示的真正含义不只是"没连上"，而是"你现在看到的整屏数据都可能是旧的"，
  // 所以改成直说"数据可能不是最新"，并升级成醒目样式（详见 test-p41.js）
  ok('顶栏说的是"数据可能不是最新·点击恢复同步"，不是"离线模式"',
    hint.includes('数据可能不是最新') && hint.includes('点击恢复同步') && !hint.includes('离线模式'), hint);
  ok('点它触发的是恢复授权，不是重新选文件夹', hint.includes('data-act="restore-share-permission"'));

  section('点"恢复共享连接"：重新授权后直接接回来，不用再选一遍文件夹');
  savedHandle._perm = 'granted';   // 模拟用户在浏览器弹窗里点了"允许"
  await S.ACTIONS['restore-share-permission']();
  ok('接回来了', !!S.fileHandle);
  ok('"待恢复"标记清掉了', S.needPermissionRestore === false);
  S.renderShell();
  ok('顶栏那个提示按钮消失了', !q('#share-connect-hint').innerHTML.includes('恢复共享连接'));

  section('真离线（句柄都没有）仍然照旧显示离线模式');
  S.setFileHandle(null); S.setNeedPermissionRestore(false); S.setOfflineMode(true);
  S.renderShell();
  ok('这种情况下才显示"离线模式"', q('#share-connect-hint').innerHTML.includes('离线模式'));

  section('★ 授权待恢复时，挂上"点页面任何地方就自动恢复"的一次性监听');
  // requestPermission 必须在用户手势里调用（平台规则），所以退而求其次：
  // 用户第一次点页面上任何地方时顺势把授权要回来，多数情况下不用去找顶栏那个按钮
  const listeners = [];
  const bakAdd = raw.document.addEventListener, bakRemove = raw.document.removeEventListener;
  raw.document.addEventListener = (type, fn, cap) => { if (type === 'click') listeners.push(fn); };
  raw.document.removeEventListener = (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  S.setNeedPermissionRestore(false);
  S.armPermissionAutoRestore();
  ok('不需要恢复时不挂监听（不留垃圾）', listeners.length === 0);
  S.setNeedPermissionRestore(true);
  S.setFileHandle(null);
  S.armPermissionAutoRestore();
  ok('需要恢复时挂上了一次性点击监听', listeners.length === 1);
  savedHandle._perm = 'granted';
  await listeners[0]();          // 模拟用户在页面上点了一下
  await tick(20);
  ok('这一下点击就把连接恢复了', !!S.fileHandle);
  ok('监听已经自己摘掉了（一次性，不会反复弹授权框）', listeners.length === 0);
  raw.document.addEventListener = bakAdd; raw.document.removeEventListener = bakRemove;

  section('★ 点右上角用户名：已登录时给身份信息卡，不会莫名其妙弹回门禁');
  S.DB.users = [{ name: '王五', role: 'staff', salt: 's', hash: 'h', iterations: 1 }];
  S.DB.settings.me = '王五';
  S.ACTIONS['switch-identity']();
  ok('没有弹出身份门禁', !q('#login-gate').classList.contains('show'));
  const card = q('#modal-body').innerHTML;
  ok('信息卡里有姓名', card.includes('王五'));
  ok('提供了"切换身份"的出口', typeof S.modalCallback === 'function');
  S.ACTIONS['modal-cancel']();
  // 完全没有身份时（比如全新设备）才回到门禁
  S.DB.settings.me = '';
  S.ACTIONS['switch-identity']();
  ok('确实没身份时才回到门禁', q('#login-gate').classList.contains('show'));
  S.hideLoginGate();

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
